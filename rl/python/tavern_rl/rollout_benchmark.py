"""Compare host transfers and simulator counts on fixed, deliberately truncated games.

Benchmark games never reach PPO or modify checkpoints. Run on an otherwise idle
GPU for comparable timings; the caller manages any competing training processes.
"""
import argparse
import gc
import hashlib
import json
from pathlib import Path
import tempfile
import time

import torch

from .bridge import Simulator
from .rollout import SimulationPool
from .train import load_checkpoint, frozen_models, league_weights, trainer_hash


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resumes', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--games', type=int, default=8)
    parser.add_argument('--steps', type=int, default=96)
    parser.add_argument('--cases', nargs='+', choices=['3-separate','3-packed','6-separate','6-packed','8-separate','8-packed'],
                        default=['3-separate','3-packed','6-packed','8-packed','8-separate','3-separate'])
    args = parser.parse_args()
    if args.games < 8 or args.steps < 1: parser.error('At least 8 games and positive steps required')
    torch.set_num_threads(1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with Simulator() as sim: meta = sim.meta
    report = dict(source_hash=meta['sourceHash'], trainer_hash=trainer_hash(), games=args.games,
                  steps=args.steps, note='Fixed early-game seeds, saved weights and own-history opponents. Truncated benchmark games are never training data. Excludes PPO.', rows=[])
    for checkpoint in args.resumes:
        saved, model = load_checkpoint(checkpoint, meta, 'cuda')
        opponents = frozen_models(saved['league'], model.specification(), 'cuda')
        probabilities = league_weights(saved['league'])
        config = saved['config']; depth = saved['model_spec']['policy_depth']
        del saved
        options = dict(config['options'], maxSteps=args.steps, recordFrames=False)
        baseline_tapes = None
        for index, case in enumerate(args.cases):
            worker_count, transfer = case.split('-')
            workers, packed = int(worker_count), transfer == 'packed'
            pool = SimulationPool(workers)
            try:
                # Warm the actual policy and observation encoders on different seeds.
                pool.collect(model, opponents, range(810000, 810000+workers), dict(options, maxSteps=4),
                             'cuda', opponent_weights=probabilities, hero_pool=config.get('hero_pool'), packed_host_transfer=packed)
                torch.cuda.synchronize(); torch.cuda.reset_peak_memory_stats()
                with tempfile.TemporaryDirectory(prefix='tavern-rollout-benchmark-') as directory:
                    started = time.time()
                    tracks, games, performance = pool.collect(model, opponents, range(820000, 820000+args.games), options,
                        'cuda', learner_seats=config['learner_seats'], opponent_weights=probabilities,
                        first_place_bonus=config.get('first_place_bonus', 0.), hero_pool=config.get('hero_pool'),
                        packed_host_transfer=packed, replay_dir=directory)
                    tapes = {p.name: hashlib.sha256(json.dumps(json.loads(p.read_text())['actions']).encode()).hexdigest()
                             for p in Path(directory).glob('game-*.json')}
                if index == 0: baseline_tapes = tapes
                row = dict(depth=depth, workers=workers, packed=packed, run=index, started_unix=started,
                    **performance, cuda_peak_allocated_mib=torch.cuda.max_memory_allocated()/2**20,
                    truncated_games=sum(g['truncated'] for g in games), replay_actions_equal_to_baseline=tapes==baseline_tapes)
                report['rows'].append(row)
                args.output.write_text(json.dumps(report, indent=2)+'\n')
                print(json.dumps(row), flush=True)
                del tracks, games
            finally: pool.close()
        del opponents, model
        gc.collect(); torch.cuda.empty_cache()


if __name__ == '__main__': main()
