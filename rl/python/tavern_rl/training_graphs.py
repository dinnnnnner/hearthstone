"""Autograd CUDA graphs for residual towers during a single PPO update."""
from contextlib import contextmanager
import gc
import time
import torch


class TrainingTowerGraph:
    def __init__(self, tower):
        self.tower, self.eager = tower, tower.forward
        self.graphed = self.signature = None
        self.replays = 0
        self.capture_seconds = 0.

    def __call__(self, x):
        if not self.tower.training or not torch.is_grad_enabled() or not x.is_cuda or not x.requires_grad or torch.is_autocast_enabled():
            return self.eager(x)
        signature = (x.shape, x.dtype, x.device)
        if self.graphed is None:
            started = time.monotonic()
            sample = torch.zeros_like(x, requires_grad=True)
            self.tower.forward = self.eager
            try:
                torch.cuda.make_graphed_callables(self.tower, (sample,))
                self.graphed = self.tower.forward
            finally:
                self.tower.forward = self
            self.signature = signature
            self.capture_seconds = time.monotonic() - started
        if signature != self.signature:
            return self.eager(x)
        self.replays += 1
        return self.graphed(x)


@contextmanager
def training_tower_graphs(model):
    from .deep_model import ResidualTower
    installed = []
    try:
        for tower in model.modules():
            if not isinstance(tower, ResidualTower):
                continue
            original = tower.__dict__.get('forward')
            graph = TrainingTowerGraph(tower)
            installed.append((tower, graph, 'forward' in tower.__dict__, original))
            tower.forward = graph
        yield [entry[1] for entry in installed]
    finally:
        for tower, graph, had_forward, original in reversed(installed):
            if had_forward:
                tower.forward = original
            else:
                del tower.forward
            graph.graphed = None
        gc.collect()
