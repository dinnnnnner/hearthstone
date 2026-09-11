"""Bounded full-policy latency measurements on real simulator observations.

This is a throughput microbenchmark, not a playing-strength evaluation. Run
without a competing job for comparable results; report contention when present.
"""
import argparse
import gc
import json
from pathlib import Path
import time
import numpy as np
import torch
from .bridge import Simulator
from .deep_model import validate_depth
from .features import prepare_entities
from .model import make_model
from .train import trainer_hash
from .rollout import SimulationPool


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--depths', nargs='+', type=int, default=[64, 256])
    parser.add_argument('--devices', nargs='+', choices=['cpu', 'cuda'], default=['cpu', 'cuda'])
    parser.add_argument('--batches', nargs='+', type=int, default=[1, 8, 32])
    parser.add_argument('--repeats', type=int, default=10)
    parser.add_argument('--threads', type=int, default=1)
    parser.add_argument('--seed', type=int, default=900001)
    parser.add_argument('--output', type=Path, default=Path('rl/runs/profile.json'))
    parser.add_argument('--rollout-workers', nargs='+', type=int, default=[])
    parser.add_argument('--rollout-steps', type=int, default=128,
                        help='Short truncated games for sampling throughput only; never used for PPO')
    parser.add_argument('--rollout-only', action='store_true')
    args = parser.parse_args()
    if min(*args.batches, *args.rollout_workers, args.rollout_steps, args.repeats, args.threads) < 1: parser.error('Sizes must be positive')
    if args.rollout_only and not args.rollout_workers: parser.error('--rollout-only requires --rollout-workers')
    for depth in args.depths: validate_depth(depth)
    if 'cuda' in args.devices and not torch.cuda.is_available(): parser.error('CUDA unavailable; use --devices cpu')
    torch.set_num_threads(args.threads)
    with Simulator() as simulator:
        state = simulator.reset(args.seed)
        observations = []
        rng = np.random.default_rng(args.seed)
        for step in range(97):
            if step % 32 == 0:
                mask = np.zeros(simulator.meta['actionCount'], dtype=np.bool_)
                mask[state['legalActions']] = True
                observations.append((prepare_entities(state['entities']), mask))
            if step < 96:
                state = simulator.step(int(rng.choice(state['legalActions'])))
                if state['terminated'] or state['truncated']:
                    state = simulator.reset(args.seed + step + 1)
        meta = simulator.meta
    report = dict(sourceHash=meta['sourceHash'], trainerHash=trainer_hash(), torch=torch.__version__,
                  threads=args.threads, seed=args.seed, repeats=args.repeats,
                  note='Full policy on four fixed early-game observations; warm cache; excludes simulator/PPO time. Not games/sec.',
                  cuda_device=torch.cuda.get_device_name() if torch.cuda.is_available() else None, rows=[])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for depth in args.depths:
        for device in args.devices:
            torch.manual_seed(17)
            model = make_model(dict(architecture='entity-gru-resnet', entity_schema=meta['entitySchema'],
                actions=meta['actions'], hidden=128, heads=4, layers=2, policy_depth=depth, value_depth=depth)).to(device).eval()
            for batch in ([] if args.rollout_only else args.batches):
                obs = [observations[i % len(observations)][0] for i in range(batch)]
                masks = torch.as_tensor(np.stack([observations[i % len(observations)][1] for i in range(batch)]), device=device)
                memory = model.initial_memory(batch, device)
                previous = torch.full((batch,), meta['actionCount'], dtype=torch.long, device=device)
                for with_value in (True, False):
                    with torch.inference_mode():
                        for _ in range(2): model.act(obs, masks, memory, previous, with_value=with_value)
                        if device == 'cuda':
                            torch.cuda.synchronize(); torch.cuda.reset_peak_memory_stats()
                        measurement_started_unix = time.time()
                        timings = []
                        for _ in range(args.repeats):
                            started = time.perf_counter()
                            dist, values, updated = model.act(obs, masks, memory, previous, with_value=with_value)
                            # Include the host transfer required by local simulator sampling.
                            dist.probs.cpu(); updated.cpu()
                            if values is not None: values.cpu()
                            if device == 'cuda': torch.cuda.synchronize()
                            timings.append(time.perf_counter() - started)
                        measurement_finished_unix = time.time()
                        if not torch.isfinite(dist.probs).all() or not torch.isfinite(updated).all():
                            raise RuntimeError('Nonfinite inference')
                    row = dict(depth=depth, device=device, batch=batch, with_value=with_value,
                        measurement_started_unix=measurement_started_unix, measurement_finished_unix=measurement_finished_unix,
                        parameters=sum(p.numel() for p in model.parameters()),
                        mean_ms=1000 * float(np.mean(timings)), p95_ms=1000 * float(np.quantile(timings, .95)),
                        decisions_per_second=batch / float(np.mean(timings)),
                        cuda_peak_allocated_mib=torch.cuda.max_memory_allocated() / 2**20 if device == 'cuda' else None)
                    report['rows'].append(row)
                    args.output.write_text(json.dumps(report, indent=2))
                    print(json.dumps(row), flush=True)
            if not args.rollout_only: del dist, values, updated, masks, memory, previous
            if args.rollout_workers:
                opponents = []
                for index in range(3):
                    torch.manual_seed(100 + index)
                    opponent = make_model(model.specification()).to(device).eval()
                    opponent.requires_grad_(False)
                    opponents.append(opponent)
                for workers in args.rollout_workers:
                    pool = SimulationPool(workers)
                    try:
                        # Fixed controllers and seed prefix. Truncations are
                        # deliberate benchmark limits, never training samples.
                        schedule = [[-1] * 4 + [0, 1, 2, 0] for _ in range(workers)]
                        measurement_started_unix = time.time()
                        _, games, perf = pool.collect(model, opponents, range(args.seed, args.seed + workers),
                            dict(maxSteps=args.rollout_steps, maxActionsPerTurn=64, recordFrames=False),
                            device, schedule=schedule)
                        row = dict(depth=depth, device=device, workers=workers, **perf,
                            measurement_started_unix=measurement_started_unix, measurement_finished_unix=time.time(),
                            truncated_games=sum(g['truncated'] for g in games),
                            note='Bounded early-game sampling with three distinct frozen policies; excludes PPO')
                        report.setdefault('rollout_rows', []).append(row)
                        args.output.write_text(json.dumps(report, indent=2))
                        print(json.dumps(row), flush=True)
                    finally: pool.close()
                del opponents, opponent
            del model
            gc.collect()
            if device == 'cuda': torch.cuda.empty_cache()


if __name__ == '__main__': main()
