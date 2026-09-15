"""Measure whole-process sampling throughput and compare deterministic action tapes."""
import argparse
import gc
import hashlib
import json
from pathlib import Path
import tempfile

import torch
from .process_rollout import ProcessSimulationPool
from .sampling_benchmark import rollout_kwargs


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--workers',type=int,default=256)
    p.add_argument('--games',type=int,default=256)
    p.add_argument('--steps',type=int,default=128)
    p.add_argument('--processes',type=int,nargs='+',default=[1,4,8])
    args=p.parse_args();torch.set_num_threads(1)
    if min(args.games,args.workers) < 1 or args.steps < 0 or any(not 1 <= n <= args.workers for n in args.processes):
        p.error('Positive games/workers, nonnegative steps and 1 <= processes <= workers required')
    saved=torch.load(args.checkpoint,map_location='cpu',weights_only=False)
    config=saved['config'];kwargs=rollout_kwargs(saved)
    del saved;gc.collect()
    options=dict(config['options'],maxSteps=args.steps) if args.steps else config['options']
    report=dict(rows=[],games=args.games,workers=args.workers,steps=args.steps)
    baseline=None;args.output.parent.mkdir(parents=True,exist_ok=True)
    for processes in args.processes:
        pool=ProcessSimulationPool(args.workers,processes,args.checkpoint)
        try:
            with tempfile.TemporaryDirectory() as directory:
                tracks,games,metrics=pool.collect(None,[],range(850000,850000+args.games),options,'cuda',**kwargs,
                    replay_dir=directory,progress=lambda row:print(json.dumps(dict(processes=processes,**row)),flush=True))
                tapes={p.name:hashlib.sha256(json.dumps(json.loads(p.read_text())['actions'],sort_keys=True).encode()).hexdigest()
                       for p in Path(directory).glob('game-*.json')}
                assert len(tapes)==args.games
                if baseline is None:baseline=tapes
                row=dict(processes=processes,**metrics,replay_actions_equal=tapes==baseline,tapes=tapes,
                         trajectories=len(tracks),complete_games=sum(g['terminated'] for g in games))
                report['rows'].append(row);args.output.write_text(json.dumps(report,indent=2)+'\n')
                print(json.dumps({k:v for k,v in row.items() if k != 'tapes'}),flush=True)
                if tapes!=baseline:raise RuntimeError('Parallel sampler changed action tapes')
        finally:pool.close()


if __name__=='__main__':main()
