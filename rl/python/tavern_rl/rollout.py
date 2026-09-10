from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from pathlib import Path
import json
import time
import numpy as np
import torch
from .bridge import Simulator

class SimulationPool:
    def __init__(self, workers, bundle=None):
        self.simulators = []
        self.executor = ThreadPoolExecutor(max_workers=workers)
        try:
            for _ in range(workers):
                self.simulators.append(Simulator(bundle))
        except BaseException:
            self.close(); raise
        self.meta = self.simulators[0].meta
        if any(s.meta != self.meta for s in self.simulators):
            self.close(); raise RuntimeError("Workers use different simulator versions")

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)
        for simulator in self.simulators:
            simulator.close()

    def collect(self, current, opponents, seeds, options, device, learner_seats=4, collect=True, replay_dir=None, error_dir=None):
        """Batched model inference, parallel local simulators, per-seat on-policy records."""
        seeds = list(seeds)
        if not seeds or not 1 <= learner_seats <= 8:
            raise ValueError("Need games and 1..8 learning seats")
        active, summaries, tracks = {}, [], []
        cursor = 0; start_time = time.monotonic(); action_count = 0
        models = {-1: current, **{i: model for i, model in enumerate(opponents)}}
        for model in models.values(): model.eval()

        def assign(worker, seed, game_index):
            nonlocal cursor
            state = self.simulators[worker].reset(seed, options)
            choices = np.random.default_rng(seed ^ 0x7a11ce)
            # The learning policy's first seat rotates independently of hero strength.
            seats = [(game_index + offset) % 8 for offset in range(learner_seats)]
            controllers = [-1 if i in seats or not opponents else int(choices.integers(len(opponents))) for i in range(8)]
            active[worker] = {"state": state, "seed": seed, "controllers": controllers, "tracks": [[] for _ in range(8)]}

        for worker in range(min(len(self.simulators), len(seeds))):
            assign(worker, seeds[cursor], cursor); cursor += 1
        while active:
            groups = defaultdict(list)
            for worker, game in active.items():
                state = game["state"]; seat = state["actor"]
                if seat is None:
                    raise RuntimeError("Unexpected terminal state before action")
                mask = np.zeros(self.meta["actionCount"], dtype=np.bool_)
                mask[state["legalActions"]] = True
                obs = np.asarray(state["observation"], dtype=np.float32)
                groups[game["controllers"][seat]].append((worker, seat, obs, mask))
            requests = []
            with torch.inference_mode():
                for controller in sorted(groups):
                    group = groups[controller]
                    obs = torch.as_tensor(np.stack([g[2] for g in group]), device=device)
                    masks = torch.as_tensor(np.stack([g[3] for g in group]), device=device)
                    distribution, values = models[controller].distribution(obs, masks)
                    actions = distribution.sample()
                    probabilities = distribution.log_prob(actions)
                    for i, (worker, seat, observation, mask) in enumerate(group):
                        action = int(actions[i].item())
                        if collect and controller == -1:
                            active[worker]["tracks"][seat].append((observation, mask, action, float(probabilities[i].item()), float(values[i].item())))
                        requests.append((worker, action))
            futures = {worker: self.executor.submit(self.simulators[worker].step, action) for worker, action in requests}
            for worker in sorted(futures):
                try:
                    state = futures[worker].result()
                except BaseException:
                    if error_dir or replay_dir:
                        path = Path(error_dir or replay_dir); path.mkdir(parents=True, exist_ok=True)
                        try:
                            (path / f'error-seed-{active[worker]["seed"]}.json').write_text(json.dumps(self.simulators[worker].call("snapshot")))
                        except Exception:
                            pass
                    raise
                action_count += 1
                game = active[worker]; game["state"] = state
                if not (state["terminated"] or state["truncated"]):
                    continue
                if state["terminated"]:
                    ranks = state["info"]["placements"]
                    if sorted(ranks) != list(range(1, 9)):
                        raise RuntimeError(f"Invalid terminal rankings: {ranks}")
                    if collect:
                        for seat, records in enumerate(game["tracks"]):
                            if game["controllers"][seat] == -1 and records:
                                tracks.append((records, state["info"]["rewards"][seat]))
                # Truncated games are excluded, rather than assigning fictitious final ranks.
                summaries.append({"seed": game["seed"], "controllers": game["controllers"], "terminated": state["terminated"],
                                  "truncated": state["truncated"], **state["info"]})
                if replay_dir or state["truncated"] and error_dir:
                    path = Path(replay_dir or error_dir); path.mkdir(parents=True, exist_ok=True)
                    (path / f'game-{game["seed"]}.json').write_text(json.dumps(self.simulators[worker].call("replay")))
                del active[worker]
                if cursor < len(seeds):
                    assign(worker, seeds[cursor], cursor); cursor += 1
        elapsed = time.monotonic() - start_time
        return tracks, summaries, {"seconds": elapsed, "environment_actions": action_count, "actions_per_second": action_count / max(elapsed, 1e-9)}
