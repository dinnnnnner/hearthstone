from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from pathlib import Path
import json
import time
import numpy as np
import torch
from .bridge import Simulator
from .placement_rewards import validate_bonus, reward_with_first_place_bonus
from .sampling_graphs import accelerate_sampling
from .features import prepare_entities
from .hero_pool import options_for_seed


def sample_masked_cdf(probabilities, masks, uniforms):
    """Inverse-CDF sampling with the legal mask enforced at the selected index.

    CUDA's parallel FP32 scan can introduce a one-ULP increase across a run of
    zero probabilities. Binary search can then land on an illegal action. Pick
    the first *legal* crossing instead, retaining the per-seat random streams.
    """
    cdf = probabilities.cumsum(-1)
    cdf = cdf / cdf[:, -1:]
    indices = torch.arange(cdf.shape[-1], device=cdf.device)
    crossing = masks & (cdf > uniforms[:, None])
    selected = torch.where(crossing, indices, cdf.shape[-1]).amin(-1)
    # A rounded tail can miss the crossing at the largest representable draw.
    last_legal = torch.where(masks, indices, -1).amax(-1)
    return torch.minimum(selected, last_legal)


def inference_to_host(actions, logs=None, values=None, memory=None, packed=True):
    """One device-to-host synchronization for the action and its recurrent PPO record."""
    if not packed:
        return tuple(t.cpu().numpy() if t is not None else None for t in (actions, logs, values, memory))
    # Current action ids fit exactly in FP32 (4,316 actions). Higher-dimensional
    # action spaces can use separate transfers instead. No network precision changes.
    tensors = [t for t in (actions, logs, values, memory) if t is not None]
    dtype = torch.float64 if any(t.dtype == torch.float64 for t in tensors) else torch.float32
    host = torch.cat([t.reshape(len(actions), -1).to(dtype) for t in tensors], dim=1).cpu().numpy()
    offset = 0; result = []
    for tensor in (actions, logs, values, memory):
        if tensor is None:
            result.append(None)
        else:
            width = tensor.numel() // len(actions)
            host_dtype = {torch.int64: np.int64, torch.float32: np.float32, torch.float64: np.float64, torch.float16: np.float16}[tensor.dtype]
            result.append(host[:, offset:offset+width].reshape(tuple(tensor.shape)).astype(host_dtype))
            offset += width
    return tuple(result)


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

    @accelerate_sampling
    def collect(self, current, opponents, seeds, options, device, learner_seats=4, collect=True, replay_dir=None, error_dir=None, opponent_weights=None, schedule=None, progress=None, seat_offset=0, hero_pool=None, packed_host_transfer=False, first_place_bonus=0.):
        """Batched model inference, parallel local simulators, per-seat on-policy records."""
        first_place_bonus = validate_bonus(first_place_bonus)
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
            game_options = options_for_seed(options, hero_pool, seed)
            state = self.simulators[worker].reset(seed, game_options)
            if hero_pool is not None and progress:
                progress(dict(stage="game_start", seed=seed, heroes=game_options["heroes"]))
            choices = np.random.default_rng(seed ^ 0x7a11ce)
            # The learning policy's first seat rotates independently of hero strength.
            seats = [(seat_offset + game_index + offset) % 8 for offset in range(learner_seats)]
            controllers = [-1 if i in seats or not opponents else int(choices.choice(len(opponents), p=opponent_weights)) for i in range(8)]
            if schedule is not None:
                controllers = list(schedule[game_index])
                if len(controllers) != 8 or -1 not in controllers or any(c not in models for c in controllers):
                    raise ValueError("Invalid fixed seat schedule")
            active[worker] = {"state": state, "seed": seed, "heroes": game_options.get("heroes"), "controllers": controllers, "tracks": [[] for _ in range(8)],
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
                    updated = None
                    if model.recurrent:
                        memories = torch.as_tensor(np.stack([active[w]['memory'][s] for w,s,_,_ in group]), device=device)
                        previous = torch.tensor([active[w]['previous'][s] for w,s,_,_ in group], device=device)
                        distribution, values, updated = model.act([g[2] for g in group], masks, memories, previous, with_value=need_value)
                    else:
                        obs = torch.as_tensor(np.stack([g[2] for g in group]), device=device)
                        distribution, values = model.distribution(obs, masks)
                    # Separate action random stream per seat/game: changing the candidate
                    # cannot consume opponents' draws, and worker count cannot change sampling.
                    uniforms = torch.tensor([active[w]['action_rng'][s].random() for w,s,_,_ in group], device=device, dtype=distribution.probs.dtype)
                    uniforms = uniforms.clamp_max(torch.nextafter(torch.ones((),device=device),torch.zeros((),device=device)))
                    actions = sample_masked_cdf(distribution.probs, masks, uniforms)
                    logs = distribution.log_prob(actions) if need_value else None
                    values = values if need_value else None
                    actions, logs, values, updated = inference_to_host(actions, logs, values, updated, packed_host_transfer and self.meta['actionCount'] <= 2**24)
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
                                terminal = reward_with_first_place_bonus(state["info"]["rewards"][seat], ranks[seat], first_place_bonus)
                                tracks.append((records, terminal))
                # Truncated games are excluded, rather than assigning fictitious final ranks.
                summaries.append({"seed": game["seed"], "heroes": game["heroes"], "controllers": game["controllers"], "terminated": state["terminated"],
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
                progress({'stage':'collect','completed_games':len(summaries),'total_games':len(seeds),'environment_actions':action_count,'seconds':round(now-start_time,1),
                          'actions_per_second':action_count/max(now-start_time,1e-9), 'mean_inference_batch':inference_decisions/max(inference_batches,1),
                          'inference_seconds':inference_seconds, 'simulator_wait_seconds':simulator_wait_seconds})
                last_progress = now
        elapsed = time.monotonic() - start_time
        return tracks, summaries, {"seconds": elapsed, "environment_actions": action_count, "actions_per_second": action_count / max(elapsed, 1e-9),
            "first_place_bonus": first_place_bonus,
            "inference_seconds": inference_seconds, "simulator_wait_seconds": simulator_wait_seconds,

            "inference_batches": inference_batches, "mean_inference_batch": inference_decisions / max(inference_batches, 1)}
