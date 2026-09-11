from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from pathlib import Path
import json
import time
import numpy as np
import torch
from .bridge import Simulator
from .features import prepare_entities

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

    def collect(self, current, opponents, seeds, options, device, learner_seats=4, collect=True, replay_dir=None, error_dir=None, opponent_weights=None, schedule=None, progress=None, seat_offset=0):
        """Batched model inference, parallel local simulators, per-seat on-policy records."""
        seeds = list(seeds)
        if not seeds or not 1 <= learner_seats <= 8:
            raise ValueError("Need games and 1..8 learning seats")
        active, summaries, tracks = {}, [], []
        cursor = 0; start_time = time.monotonic(); action_count = 0; last_progress = start_time
        inference_seconds = 0.; simulator_wait_seconds = 0.; inference_batches = 0; inference_decisions = 0
        if schedule is not None and len(schedule) != len(seeds): raise ValueError("Schedule length differs from seeds")
        models = {-1: current, **{i: model for i, model in enumerate(opponents)}}
        for model in models.values(): model.eval()

        def assign(worker, seed, game_index):
            nonlocal cursor
            state = self.simulators[worker].reset(seed, options)
            choices = np.random.default_rng(seed ^ 0x7a11ce)
            # The learning policy's first seat rotates independently of hero strength.
            seats = [(seat_offset + game_index + offset) % 8 for offset in range(learner_seats)]
            controllers = [-1 if i in seats or not opponents else int(choices.choice(len(opponents), p=opponent_weights)) for i in range(8)]
            if schedule is not None:
                controllers = list(schedule[game_index])
                if len(controllers) != 8 or -1 not in controllers or any(c not in models for c in controllers):
                    raise ValueError("Invalid fixed seat schedule")
            active[worker] = {"state": state, "seed": seed, "controllers": controllers, "tracks": [[] for _ in range(8)],
                "memory": [np.zeros(models[c].hidden, dtype=np.float32) if getattr(models[c], 'recurrent', False) else None for c in controllers],
                "previous": [self.meta['actionCount']] * 8,
                "action_rng": [np.random.default_rng(np.random.SeedSequence([seed, seat, 0xa6710])) for seat in range(8)]}

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
                controller = models[game["controllers"][seat]]
                obs = prepare_entities(state['entities']) if controller.observation_kind == 'entities' else np.asarray(state["observation"], dtype=np.float32)
                groups[game["controllers"][seat]].append((worker, seat, obs, mask))
            futures = {}
            inference_started = time.monotonic()
            with torch.inference_mode():
                for controller in sorted(groups):
                    group = groups[controller]
                    model = models[controller]
                    need_value = collect and controller == -1
                    inference_batches += 1; inference_decisions += len(group)
                    masks = torch.as_tensor(np.stack([g[3] for g in group]), device=device)
                    if model.recurrent:
                        memories = torch.as_tensor(np.stack([active[w]['memory'][s] for w,s,_,_ in group]), device=device)
                        previous = torch.tensor([active[w]['previous'][s] for w,s,_,_ in group], device=device)
                        distribution, values, updated = model.act([g[2] for g in group], masks, memories, previous, with_value=need_value)
                        updated = updated.cpu().numpy()
                    else:
                        obs = torch.as_tensor(np.stack([g[2] for g in group]), device=device)
                        distribution, values = model.distribution(obs, masks)
                    # Separate action random stream per seat/game: changing the candidate
                    # cannot consume opponents' draws, and worker count cannot change sampling.
                    cdf = distribution.probs.cumsum(-1)
                    cdf = cdf / cdf[:, -1:]
                    uniforms = torch.tensor([active[w]['action_rng'][s].random() for w,s,_,_ in group], device=device, dtype=cdf.dtype)
                    uniforms = uniforms.clamp_max(torch.nextafter(torch.ones((),device=device),torch.zeros((),device=device)))
                    actions = torch.searchsorted(cdf.contiguous(), uniforms[:,None], right=True).squeeze(-1)
                    logs = distribution.log_prob(actions).cpu().numpy() if need_value else None
                    values = values.cpu().numpy() if need_value else None
                    actions = actions.cpu().numpy()
                    for i, (worker, seat, observation, mask) in enumerate(group):
                        action = int(actions[i]); game = active[worker]
                        if collect and controller == -1:
                            record = (observation, mask, action, float(logs[i]), float(values[i]))
                            if model.recurrent: record += (game['memory'][seat].copy(), game['previous'][seat])
                            game["tracks"][seat].append(record)
                        if model.recurrent: game['memory'][seat] = updated[i].copy()
                        game['previous'][seat] = action
                        # Start this simulator immediately. Its CPU work can
                        # overlap inference for the next historical policy.
                        futures[worker] = self.executor.submit(self.simulators[worker].step, action)
            inference_seconds += time.monotonic() - inference_started
            simulator_started = time.monotonic()
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
            simulator_wait_seconds += time.monotonic() - simulator_started
            now = time.monotonic()
            if progress and now - last_progress >= 30:
                progress({'stage':'collect','completed_games':len(summaries),'total_games':len(seeds),'environment_actions':action_count,'seconds':round(now-start_time,1)})
                last_progress = now
        elapsed = time.monotonic() - start_time
        return tracks, summaries, {"seconds": elapsed, "environment_actions": action_count, "actions_per_second": action_count / max(elapsed, 1e-9),
            "inference_seconds": inference_seconds, "simulator_wait_seconds": simulator_wait_seconds,
            "inference_batches": inference_batches, "mean_inference_batch": inference_decisions / max(inference_batches, 1)}
