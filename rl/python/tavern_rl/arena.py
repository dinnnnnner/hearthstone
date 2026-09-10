"""Immutable neural opponent suites and paired, held-out model comparisons."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import numpy as np
import torch
from .rollout import SimulationPool
from .train import load_checkpoint


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''): value.update(block)
    return value.hexdigest()


def suite_id(suite):
    return hashlib.sha256(json.dumps({k:v for k,v in suite.items() if k != 'id'},sort_keys=True,separators=(',',':')).encode()).hexdigest()


def held_out(saved, seeds):
    start = saved['config']['seed'] & 0xffffffff
    if any(((seed-start) & 0xffffffff) < saved['episodes'] for seed in seeds):
        raise ValueError('Suite seeds overlap checkpoint training games')


def create_suite(directory, checkpoints, meta, games=256, seed=1000000, max_actions=64, max_steps=30000, split='validation'):
    if games < 1 or games > 100000 or not checkpoints or max_actions < 1 or max_steps < 1:
        raise ValueError('Invalid suite size/options')
    seeds = [(seed+i) & 0xffffffff for i in range(games)]
    for path in checkpoints:
        saved,_ = load_checkpoint(path,meta,allow_legacy=True)
        held_out(saved,seeds)
    directory = Path(directory)
    directory.mkdir(parents=True,exist_ok=False)  # Never silently replace an existing benchmark.
    opponents = []
    for path in checkpoints:
        sha = digest(path); name = sha+'.pt'
        target = directory/name
        if not target.exists(): shutil.copyfile(path,target)
        if digest(target) != sha: raise RuntimeError('Opponent changed while copying')
        opponents.append(dict(file=name,sha256=sha))
    schedule = []
    for i,game_seed in enumerate(seeds):
        rng = np.random.default_rng(game_seed ^ 0x7a11ce)
        schedule.append([-1 if seat == i%8 else int(rng.integers(len(opponents))) for seat in range(8)])
    suite = dict(schema='tavern-fixed-arena-v1',sourceHash=meta['sourceHash'],split=split,seeds=seeds,
                 opponents=opponents,schedule=schedule,options=dict(maxActionsPerTurn=max_actions,maxSteps=max_steps,recordFrames=False))
    suite['id'] = suite_id(suite)
    (directory/'suite.json').write_text(json.dumps(suite,indent=2))
    return suite


def read_suite(directory,meta):
    directory = Path(directory); suite = json.loads((directory/'suite.json').read_text())
    if suite['schema'] != 'tavern-fixed-arena-v1' or suite['id'] != suite_id(suite): raise ValueError('Suite manifest changed')
    if suite['sourceHash'] != meta['sourceHash']: raise ValueError('Suite simulator version differs')
    for opponent in suite['opponents']:
        if Path(opponent['file']).name != opponent['file']: raise ValueError('Invalid opponent filename')
        if digest(directory/opponent['file']) != opponent['sha256']: raise ValueError('Frozen opponent checksum differs')
    return suite


def comparison(candidate, reference, seed=7193, min_games=256):
    candidate,reference = np.asarray(candidate),np.asarray(reference)
    if candidate.shape != reference.shape or candidate.ndim != 1 or not len(candidate): raise ValueError('Unpaired results')
    delta = candidate-reference
    rng = np.random.default_rng(seed)
    # Bootstrap paired games, not individual players from the same lobby.
    estimates = np.concatenate([delta[rng.integers(len(delta),size=(100,len(delta)))].mean(1) for _ in range(50)])
    low,high = np.quantile(estimates,[.025,.975]).tolist()
    return dict(mean_placement_delta=float(delta.mean()),paired_95_percent_interval=[low,high],games=len(delta),
                lower_is_better=True,minimum_gate_games=min_games,
                gate_passed=bool(len(delta)>=min_games and high < 0),
                scope='Gate tests this fixed suite only; repeated validation is not an independent final test')


def summarize(matches):
    ranks=[]; heroes={}; tribes={}
    for game in matches:
        if not game['terminated'] or game['truncated']: raise RuntimeError('Incomplete evaluation game')
        seat = game['controllers'].index(-1); rank=game['placements'][seat]; ranks.append(rank)
        if game.get('heroes'): heroes.setdefault(game['heroes'][seat],[]).append(rank)
        for tribe in game.get('tribes',[]): tribes.setdefault(tribe,[]).append(rank)
    groups=lambda values: {k:dict(games=len(v),mean_placement=float(np.mean(v))) for k,v in values.items()}
    return dict(ranks=ranks,mean_placement=float(np.mean(ranks)),top_four_rate=float(np.mean(np.array(ranks)<=4)),
                first_rate=float(np.mean(np.array(ranks)==1)),by_hero=groups(heroes),by_tribe=groups(tribes))


def evaluate_suite(directory,checkpoint,pool,device='cpu',reference=None,progress=None):
    suite=read_suite(directory,pool.meta)
    opponents=[]
    for entry in suite['opponents']:
        saved,model=load_checkpoint(Path(directory)/entry['file'],pool.meta,device,allow_legacy=True)
        held_out(saved,suite['seeds']);opponents.append(model)
    report=dict(schema='tavern-paired-arena-v1',suite_id=suite['id'],split=suite['split'],sourceHash=pool.meta['sourceHash'],games=len(suite['seeds']))
    for name,path in [('candidate',checkpoint),('reference',reference)]:
        if path is None: continue
        saved,model=load_checkpoint(path,pool.meta,device,allow_legacy=True)
        held_out(saved,suite['seeds'])
        _,matches,performance=pool.collect(model,opponents,suite['seeds'],suite['options'],device,learner_seats=1,
                                          collect=False,schedule=suite['schedule'],progress=progress)
        report[name]=dict(checkpoint_sha256=digest(path),iteration=saved['iteration'],**summarize(matches),performance=performance,matches=matches)
    if reference is not None: report['comparison']=comparison(report['candidate']['ranks'],report['reference']['ranks'])
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    create=sub.add_parser('create');create.add_argument('suite',type=Path)
    create.add_argument('--opponents',nargs='+',required=True,type=Path)
    create.add_argument('--games',type=int,default=256);create.add_argument('--seed',type=int,default=1000000)
    create.add_argument('--max-actions',type=int,default=64);create.add_argument('--max-steps',type=int,default=30000)
    create.add_argument('--split',choices=['validation','final'],default='validation')
    evaluate=sub.add_parser('evaluate');evaluate.add_argument('suite',type=Path);evaluate.add_argument('checkpoint',type=Path)
    evaluate.add_argument('--reference',type=Path);evaluate.add_argument('--workers',type=int,default=4)
    evaluate.add_argument('--device',choices=['cpu','cuda'],default='cpu');evaluate.add_argument('--output',required=True,type=Path)
    args=parser.parse_args();torch.set_num_threads(1)
    workers=getattr(args,'workers',1)
    if workers<1: raise ValueError('Positive worker count required')
    pool=SimulationPool(workers)
    try:
        if args.command=='create':
            suite=create_suite(args.suite,args.opponents,pool.meta,args.games,args.seed,args.max_actions,args.max_steps,args.split)
            print(json.dumps(dict(suite=str(args.suite),id=suite['id'],games=len(suite['seeds']))))
        else:
            if args.output.exists(): raise ValueError('Evaluation output exists; choose a new path')
            report=evaluate_suite(args.suite,args.checkpoint,pool,args.device,args.reference,lambda row:print(json.dumps(row),flush=True))
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(report,indent=2))
            print(json.dumps({k:({a:b for a,b in v.items() if a not in ['matches','ranks','by_hero','by_tribe']} if k in ['candidate','reference'] else v) for k,v in report.items()},indent=2))
    finally: pool.close()


if __name__=='__main__':main()
