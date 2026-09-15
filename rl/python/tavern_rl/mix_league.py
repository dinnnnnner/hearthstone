"""Create a new resume checkpoint; never mutate a running trainer's checkpoint."""
import argparse
import json
from pathlib import Path
import torch
from .bridge import Simulator
from .league import mix_checkpoint, members, sampling_weights
from .train import load_checkpoint, atomic_checkpoint


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--resume',type=Path,required=True)
    p.add_argument('--opponents',type=Path,nargs='+',required=True)
    p.add_argument('--output',type=Path,required=True,help='New directory containing latest.pt and league.json')
    p.add_argument('--external-fraction',type=float,default=.4)
    p.add_argument('--max-per-lineage',type=int,help='Retain this many newest external snapshots per training lineage')
    args=p.parse_args();torch.set_num_threads(1)
    if args.output.exists(): raise FileExistsError('Choose a new output directory')
    with Simulator() as simulator:meta=simulator.meta
    saved,model=load_checkpoint(args.resume,meta)
    mixed=mix_checkpoint(saved,args.opponents,meta,args.external_fraction,args.max_per_lineage)
    args.output.mkdir(parents=True,exist_ok=False)
    atomic_checkpoint(args.output/'latest.pt',mixed)
    report=dict(episodes=mixed['episodes'],sourceHash=meta['sourceHash'],
        members=members(mixed['league']),probabilities=sampling_weights(mixed['league'],args.external_fraction).tolist(),
        imports=mixed['league_imports'])
    (args.output/'league.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report),flush=True)


if __name__=='__main__':main()
