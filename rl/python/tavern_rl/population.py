"""Asynchronous independent PPO learners exchanging frozen neural opponents."""
from __future__ import annotations
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from .placement_rewards import validate_bonus


def deadline_seconds(value):
    parsed = datetime.datetime.fromisoformat(value)
    if parsed.tzinfo is None: raise ValueError('Deadline must include a timezone')
    return parsed.timestamp()


def latest_checkpoint(member):
    latest = member['root']/'training/latest.pt'
    return latest if latest.is_file() else member['root']/'initial.pt'


def stop_processes(processes):
    # Each child owns a new process group, including its simulator children.
    for process in processes:
        try: os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError: pass
    for process in processes:
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try: os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--resumes',type=Path,nargs='+',required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--deadline-utc',required=True,help='Absolute stop time including timezone')
    p.add_argument('--workers',type=int,default=4,help='Simulator workers per learner')
    p.add_argument('--iterations-per-exchange',type=int,default=2)
    p.add_argument('--games-per-iteration',type=int,default=16)
    p.add_argument('--max-per-lineage',type=int,default=2)
    p.add_argument('--external-fraction',type=float,default=.4)
    p.add_argument('--first-place-bonus',type=validate_bonus,help='Override the saved first-place bonus for every learner')
    p.add_argument('--device',choices=['cpu','cuda'],default='cuda')
    args=p.parse_args()
    seconds=deadline_seconds(args.deadline_utc)-time.time()
    if seconds <= 0: raise ValueError('Deadline has passed')
    deadline=time.monotonic()+seconds
    if len(args.resumes)<2 or len({p.resolve() for p in args.resumes}) != len(args.resumes):
        raise ValueError('At least two distinct learner checkpoints required')
    if min(args.workers,args.iterations_per_exchange,args.games_per_iteration,args.max_per_lineage)<1:
        raise ValueError('Positive training sizes required')
    if not 0<args.external_fraction<1: raise ValueError('External fraction must be between zero and one')
    if any(not path.is_file() for path in args.resumes): raise FileNotFoundError('Missing learner checkpoint')
    root=args.output.resolve(); root.mkdir(parents=True,exist_ok=False)
    lock=(root/'.population.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    state=dict(stage='preparing',pid=os.getpid(),opponent_mode='mixed_self_play',deadline_utc=args.deadline_utc,workers_per_learner=args.workers,
        iterations_per_exchange=args.iterations_per_exchange,games_per_iteration=args.games_per_iteration,
        first_place_bonus=args.first_place_bonus,reward_mode='placement_only',external_fraction=args.external_fraction,max_per_lineage=args.max_per_lineage,members=[])
    members=[];active={}

    def status():
        state['members']=[dict(index=i,root=str(m['root']),source=str(args.resumes[i].resolve()),
            round=m['round'],stage=m['stage'],pid=active[i].pid if i in active else None,
            checkpoint=str(latest_checkpoint(m))) for i,m in enumerate(members)]
        temp=root/'status.json.next';temp.write_text(json.dumps(state,indent=2)+'\n')
        os.replace(temp,root/'status.json')
        print(json.dumps(state),flush=True)

    def launch(i, stage):
        member=members[i]; target=member['root'];member['stage']=stage
        if stage=='mixing':
            member['round']+=1
            # Only the previous completed segment used these generated files.
            exchange=target/'exchange'
            if exchange.exists():
                (exchange/'latest.pt').unlink();(exchange/'league.json').unlink();exchange.rmdir()
            command=['mix_league','--resume',latest_checkpoint(member),'--opponents',
                *[latest_checkpoint(other) for j,other in enumerate(members) if j!=i],
                '--output',exchange,'--external-fraction',args.external_fraction,'--max-per-lineage',args.max_per_lineage]
        else:
            # Preserve a compact audit before the next exchange replaces it.
            shutil.copyfile(target/'exchange/league.json',target/f'exchange-{member["round"]:04d}.json')
            command=['train','--resume',target/'exchange/latest.pt','--output',target/'training',
                '--iterations',args.iterations_per_exchange,'--resume-games-per-iteration',args.games_per_iteration,
                '--workers',args.workers,'--device',args.device,'--rollout-device',args.device]
        if stage=='training' and args.first_place_bonus is not None:
            command += ['--first-place-bonus',args.first_place_bonus]
        with (target/f'{stage}-{member["round"]:04d}.log').open('a') as log:
            active[i]=subprocess.Popen([sys.executable,'-m','tavern_rl.'+command[0],*map(str,command[1:])],
                stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        status()

    def interrupted(signum,frame): raise KeyboardInterrupt(f'Signal {signum}')
    previous=signal.signal(signal.SIGTERM,interrupted)
    try:
        for i,source in enumerate(args.resumes):
            target=root/f'member-{i}';target.mkdir()
            # One source descriptor keeps a coherent checkpoint if its producer
            # atomically publishes a newer version during the copy.
            with source.open('rb') as src,(target/'initial.pt').open('wb') as dst:
                shutil.copyfileobj(src,dst,8*1024*1024)
            members.append(dict(root=target,round=0,stage='ready'))
        state['stage']='running';status()
        while time.monotonic()<deadline:
            for i,member in enumerate(members):
                if time.monotonic()>=deadline: break
                if i not in active: launch(i,'mixing');continue
                process=active[i];code=process.poll()
                if code is None: continue
                if code:
                    raise RuntimeError(f'Member {i} {member["stage"]} exited {code}; inspect its log')
                active.pop(i)
                launch(i,'training' if member['stage']=='mixing' else 'mixing')
            time.sleep(min(1,max(0,deadline-time.monotonic())))
        state['stage']='time_limit'
    except BaseException as error:
        state.update(stage='interrupted' if isinstance(error,KeyboardInterrupt) else 'failed',error=repr(error))
        raise
    finally:
        stop_processes(list(active.values()))
        active.clear()
        for member in members: member['stage']='stopped'
        status();lock.close();signal.signal(signal.SIGTERM,previous)


if __name__=='__main__': main()
