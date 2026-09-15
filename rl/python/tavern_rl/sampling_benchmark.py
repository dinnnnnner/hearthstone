"""Compare eager and CUDA-graph sampling using one immutable loaded checkpoint.

Run on an idle GPU for throughput conclusions. Each case uses the same seeds,
seat schedule and history weights. This command never updates checkpoints.
"""
import argparse
import gc
import hashlib
import inspect
import json
import os
from pathlib import Path
import tempfile

import torch

from .bridge import Simulator
from .rollout import SimulationPool
from .sampling_graphs import accelerate_sampling
from .train import load_checkpoint, frozen_models, league_weights


def rollout_kwargs(saved):
    config = saved['config']
    probabilities = (league_weights(saved['league'], config.get('external_opponent_fraction', .4))
                     if len(inspect.signature(league_weights).parameters) > 1
                     else league_weights(saved['league']))
    kwargs = dict(learner_seats=config['learner_seats'], opponent_weights=probabilities)
    parameters = inspect.signature(SimulationPool.collect).parameters
    for key, default in [('hero_pool', None), ('packed_host_transfer', False), ('first_place_bonus', 0.)]:
        if key in parameters:
            kwargs[key] = config.get(key, default)
    return kwargs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--workers', type=int, default=16)
    parser.add_argument('--worker-cases', type=int, nargs='+', help='Compare simulator counts using the same loaded weights and seeds')
    parser.add_argument('--games', type=int, default=16)
    parser.add_argument('--steps', type=int, default=256, help='0 uses full training game limit')
    parser.add_argument('--cases', nargs='+', choices=['eager', 'graph'], default=['eager', 'graph', 'eager'])
    args = parser.parse_args()
    if args.workers < 1 or args.games < 1 or args.steps < 0:
        parser.error('Positive workers/games and nonnegative steps required')
    workers_to_test = args.worker_cases or [args.workers]
    if any(workers < 1 for workers in workers_to_test):
        parser.error('Worker counts must be positive')
    torch.set_num_threads(1)
    with Simulator() as simulator:
        meta = simulator.meta
    # An open descriptor remains pinned to the same inode if training replaces latest.pt.
    with args.checkpoint.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
        source.seek(0)
        saved, model = load_checkpoint(source, meta, 'cuda')
    opponents = frozen_models(saved['league'], model.specification(), 'cuda')
    kwargs = rollout_kwargs(saved)
    config = dict(saved['config'])
    del saved
    gc.collect()
    options = dict(config['options'], recordFrames=False)
    if args.steps:
        options['maxSteps'] = args.steps
    report = dict(checkpoint_sha256=digest, depth=model.specification()['policy_depth'],
                  workers=args.workers, worker_cases=workers_to_test, games=args.games, steps=args.steps,
                  note='Sampling only, includes graph capture/release, no optimizer updates.', rows=[])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    pool = SimulationPool(workers_to_test[0])
    # Also works with an unpatched local rollout, without stacking decorators.
    if not hasattr(SimulationPool.collect, '__wrapped__'):
        pool.collect = accelerate_sampling(SimulationPool.collect).__get__(pool)
    baseline = None
    try:
        for workers, mode in [(workers, mode) for workers in workers_to_test for mode in args.cases]:
            if len(pool.simulators) != workers:
                pool.close()
                pool = SimulationPool(workers)
                if not hasattr(SimulationPool.collect, '__wrapped__'):
                    pool.collect = accelerate_sampling(SimulationPool.collect).__get__(pool)
            os.environ['TAVERN_SAMPLING_GRAPHS'] = '0' if mode == 'eager' else '1'
            pool.collect(model, opponents, range(810000, 810000 + args.games),
                         dict(options, maxSteps=4), 'cuda', **kwargs)
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            with tempfile.TemporaryDirectory(prefix='sampling-benchmark-') as directory:
                tracks, games, perf = pool.collect(model, opponents, range(820000, 820000 + args.games),
                    options, 'cuda', **kwargs, replay_dir=directory,
                    progress=lambda row: print(json.dumps(dict(mode=mode, workers=workers, **row)), flush=True))
                tapes = {p.name: hashlib.sha256(json.dumps(json.loads(p.read_text())['actions'], sort_keys=True).encode()).hexdigest()
                         for p in Path(directory).glob('game-*.json')}
                assert len(tapes) == args.games
                if baseline is None:
                    baseline = tapes
                row = dict(mode=mode, workers=workers, **perf, tapes=tapes, replay_actions_equal=tapes == baseline,
                           cuda_peak_mib=torch.cuda.max_memory_allocated() / 2**20,
                           complete_games=sum(g['terminated'] for g in games),
                           truncated_games=sum(g['truncated'] for g in games), trajectories=len(tracks))
                report['rows'].append(row)
                args.output.write_text(json.dumps(report, indent=2) + '\n')
                print(json.dumps({k: v for k, v in row.items() if k != 'tapes'}), flush=True)
                del tracks, games
                if tapes != baseline:
                    raise RuntimeError('Action replay differs; inspect results before deployment')
    finally:
        pool.close()


if __name__ == '__main__':
    main()
