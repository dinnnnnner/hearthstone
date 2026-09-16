"""Capture only residual towers during one frozen-policy rollout.

The entity encoder, action sampling, game schedule and PPO stay eager. Graphs
are released before collect returns, so parameter updates cannot reuse them.
Set TAVERN_SAMPLING_GRAPHS=0 to use the original sampler.
"""
from contextlib import contextmanager
from functools import wraps
import os
import time

import torch


class TowerGraph:
    def __init__(self, tower, batch):
        self.tower = tower
        self.eager = tower.forward
        self.batch = batch
        self.graph = None
        self.input = self.output = None
        self.capture_seconds = 0.
        self.replays = 0

    def __call__(self, x):
        if self.tower.training or torch.is_grad_enabled() or not x.is_cuda:
            return self.eager(x)
        if x.ndim != 2 or len(x) > self.batch or torch.is_autocast_enabled():
            return self.eager(x)
        if self.graph is None:
            started = time.monotonic()
            self.input = x.new_zeros((self.batch, x.shape[1]))
            stream = torch.cuda.Stream(device=x.device)
            stream.wait_stream(torch.cuda.current_stream(x.device))
            with torch.cuda.stream(stream):
                for _ in range(3):
                    self.eager(self.input)
            torch.cuda.current_stream(x.device).wait_stream(stream)
            self.graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(self.graph, stream=stream):
                self.output = self.eager(self.input)
            self.capture_seconds += time.monotonic() - started
        if x.device != self.input.device or x.dtype != self.input.dtype or x.shape[1] != self.input.shape[1]:
            return self.eager(x)
        self.input[:len(x)].copy_(x)
        self.graph.replay()
        self.replays += 1
        # Each row is independent: Linear, LayerNorm and SiLU never mix rows.
        # Clone prevents a later replay from overwriting a caller's result.
        return self.output[:len(x)].clone()

    def close(self):
        if self.graph is not None:
            self.graph.reset()
        self.graph = self.input = self.output = None


@contextmanager
def tower_graphs(models, batch):
    from .deep_model import ResidualTower
    installed = []
    try:
        seen = set()
        for model in models:
            for tower in model.modules():
                if not isinstance(tower, ResidualTower) or id(tower) in seen:
                    continue
                seen.add(id(tower))
                # Restore the original instance dictionary, including custom forwards.
                original = tower.__dict__.get('forward')
                had_forward = 'forward' in tower.__dict__
                graph = TowerGraph(tower, batch)
                installed.append((tower, graph, had_forward, original))
                tower.forward = graph
        yield [entry[1] for entry in installed]
    finally:
        for tower, graph, had_forward, original in reversed(installed):
            if had_forward:
                tower.forward = original
            else:
                del tower.forward
            graph.close()


def accelerate_sampling(collect):
    @wraps(collect)
    def wrapped(self, current, opponents, seeds, options, device, *args, **kwargs):
        enabled = os.environ.get('TAVERN_SAMPLING_GRAPHS', '1') == '1'
        if not enabled or torch.device(device).type != 'cuda':
            return collect(self, current, opponents, seeds, options, device, *args, **kwargs)
        started = time.monotonic()
        batch=max(len(self.simulators),kwargs.get('counterfactual',{}).get('workers',0) if kwargs.get('counterfactual') else 0,
                  32 if kwargs.get('direct_planning') else 0)
        with tower_graphs([current, *opponents], batch) as graphs:
            tracks, games, performance = collect(self, current, opponents, seeds, options, device, *args, **kwargs)
            performance.update(sampling_graphs=True,
                sampling_graph_count=sum(g.graph is not None for g in graphs),
                sampling_graph_replays=sum(g.replays for g in graphs),
                sampling_graph_capture_seconds=sum(g.capture_seconds for g in graphs))
        # Include capture, setup and release in the reported sampling rate.
        performance['seconds'] = time.monotonic() - started
        performance['actions_per_second'] = performance['environment_actions'] / max(performance['seconds'], 1e-9)
        return tracks, games, performance
    return wrapped
