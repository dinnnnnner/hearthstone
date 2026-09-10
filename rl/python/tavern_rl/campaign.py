"""Run a bounded background self-play experiment with immutable periodic evaluations."""
import argparse
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import torch
from .arena import create_suite, digest, comparison
from .bridge import Simulator


def write_json(path, value):
    temporary=path.with_suffix(path.suffix+'.next')
    temporary.write_text(json.dumps(value,indent=2))
    os.replace(temporary,path)


def run_stage(command, log, seconds):
    """Only terminate this stage's process group; completed checkpoints remain intact."""
    if seconds <= 0: raise TimeoutError('Campaign time limit reached')
    with log.open('a') as stream:
        process=subprocess.Popen(command,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            code=process.wait(timeout=seconds)
        except BaseException:
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL);process.wait()
            raise
    if code:raise RuntimeError(f'Stage exited {code}; inspect {log}')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--resume',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--anchors',nargs='+',type=Path,required=True)
    p.add_argument('--games',type=int,default=1024)
    p.add_argument('--hours',type=float,default=4)
    p.add_argument('--games-per-iteration',type=int,default=16)
    p.add_argument('--evaluate-every-games',type=int,default=128)
    p.add_argument('--workers',type=int,default=8)
    p.add_argument('--device',choices=['cpu','cuda'],default='cuda')
    p.add_argument('--rollout-device',choices=['cpu','cuda'],default='cuda')
    p.add_argument('--learning-rate',type=float,default=1e-4)
    args=p.parse_args()
    if not math.isfinite(args.hours) or args.hours<=0:raise ValueError('Positive finite time limit required')
    if min(args.games,args.games_per_iteration,args.evaluate_every_games,args.workers)<1:raise ValueError('Invalid batch sizes')
    if args.games%args.games_per_iteration or args.evaluate_every_games%args.games_per_iteration:raise ValueError('Game counts must be multiples of the rollout batch')
    if not 0<args.learning_rate<1:raise ValueError('Invalid learning rate')
    torch.set_num_threads(1)
    root=args.output.resolve();root.mkdir(parents=True,exist_ok=False)
    lock=(root/'.campaign.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    started=time.monotonic();deadline=started+args.hours*3600
    initial=root/'initial.pt';shutil.copyfile(args.resume,initial)
    saved=torch.load(initial,map_location='cpu',weights_only=False)
    start_episodes=saved['episodes'];goal=start_episodes+args.games
    config={k:str(v) if isinstance(v,Path) else [str(x) for x in v] if isinstance(v,list) else v for k,v in vars(args).items()}
    config.update(initial_sha256=digest(initial),initial_episodes=start_episodes,target_episodes=goal,
                  started_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
    write_json(root/'campaign.json',config)
    state=dict(stage='preparing',completed_episodes=start_episodes,target_episodes=goal,training_complete=False)
    def status(stage,**extra):
        state.update(stage=stage,elapsed_seconds=round(time.monotonic()-started,1),**extra)
        write_json(root/'status.json',state);print(json.dumps(state),flush=True)
    def invoke(module,arguments,log):
        run_stage([sys.executable,'-m','tavern_rl.'+module,*map(str,arguments)],root/log,deadline-time.monotonic())
    def evaluate(suite,checkpoint,output,log,reference=None):
        arguments=[suite,checkpoint,'--workers',args.workers,'--device',args.rollout_device,'--output',output]
        if reference is not None:arguments+=['--reference',reference]
        invoke('arena',['evaluate',*arguments],log)
    try:
        with Simulator() as simulator:
            options=saved['config']['options']
            for name,games,seed,split in [('monitor-suite',32,1000000,'validation'),('final-suite',256,2000000,'final')]:
                create_suite(root/name,[initial,*args.anchors],simulator.meta,games=games,seed=seed,
                             max_actions=options['maxActionsPerTurn'],max_steps=options['maxSteps'],split=split)
        (root/'checkpoints').mkdir();current=initial;episodes=start_episodes;chunk=0
        while episodes<goal:
            chunk+=1;batch=min(args.evaluate_every_games,goal-episodes)
            status('training',completed_episodes=episodes,chunk=chunk,log=str(root/f'train-{chunk:03d}.log'))
            invoke('train',['--resume',current,'--output',root/'training','--iterations',batch//args.games_per_iteration,
                           '--workers',args.workers,'--device',args.device,'--rollout-device',args.rollout_device,
                           '--resume-games-per-iteration',args.games_per_iteration,'--resume-learning-rate',args.learning_rate],f'train-{chunk:03d}.log')
            current=root/'training/latest.pt'
            manifest=json.loads((root/'training/manifest.json').read_text());episodes=manifest['episodes']
            snapshot=root/'checkpoints'/f'episodes-{episodes:07d}.pt';shutil.copyfile(current,snapshot)
            status('evaluating',completed_episodes=episodes,training_complete=episodes>=goal)
            baseline=root/'monitor-baseline.json'
            if not baseline.exists():evaluate(root/'monitor-suite',initial,baseline,'monitor-baseline.log')
            report=root/f'monitor-{episodes:07d}.json'
            evaluate(root/'monitor-suite',snapshot,report,f'monitor-{episodes:07d}.log')
            result=json.loads(report.read_text());ref=json.loads(baseline.read_text())
            result['reference']=ref['candidate'];result['comparison']=comparison(result['candidate']['ranks'],ref['candidate']['ranks'])
            write_json(report,result)
            status('evaluated',mean_placement=result['candidate']['mean_placement'],comparison=result['comparison'])
        status('final_evaluation',training_complete=True)
        evaluate(root/'final-suite',current,root/'final-evaluation.json','final-evaluation.log',initial)
        status('completed',completed_episodes=episodes,training_complete=True)
    except (TimeoutError,subprocess.TimeoutExpired):
        manifest=root/'training/manifest.json'
        if manifest.exists():state['completed_episodes']=json.loads(manifest.read_text())['episodes']
        status('time_limit',training_complete=state['completed_episodes']>=goal)
    except BaseException as error:
        status('failed',error=str(error));raise
    finally:lock.close()


if __name__=='__main__':main()
