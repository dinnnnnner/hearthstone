"""Parallel on-policy rollout processes with disjoint seeds and a fixed checkpoint."""
import argparse
import gc
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import tempfile
import time

import torch

from .bridge import Simulator
from .rollout import SimulationPool


def interrupted(signum, frame):
    raise KeyboardInterrupt(f'Signal {signum}')


def write_json(path, value):
    temporary = path.with_suffix('.next')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def shards(seeds, workers, processes):
    if not seeds or not 1 <= processes <= workers:
        raise ValueError('Need seeds and 1 <= processes <= workers')
    count = min(processes,len(seeds))
    return [(i*len(seeds)//count,(i+1)*len(seeds)//count,
             workers//count+int(i<workers%count)) for i in range(count)]


def prepare_descriptor_limit(workers):
    soft,hard=resource.getrlimit(resource.RLIMIT_NOFILE)
    needed=workers*8+256
    if hard != resource.RLIM_INFINITY and needed > hard:
        raise ValueError(f'{workers} simulator workers need at least {needed} file descriptors')
    if soft != resource.RLIM_INFINITY and soft < needed:
        resource.setrlimit(resource.RLIMIT_NOFILE,(needed,hard))


class ProcessSimulationPool:
    def __init__(self, workers, processes, checkpoint):
        shards([0],workers,processes)
        self.worker_count,self.processes,self.checkpoint=workers,processes,Path(checkpoint)
        self.simulators=[Simulator()]
        self.meta=self.simulators[0].meta

    def close(self):
        for simulator in self.simulators: simulator.close()

    def collect(self,current,opponents,seeds,options,device,**kwargs):
        seeds=list(seeds)
        if kwargs.get('replay_dir'):
            kwargs['replay_dir']=str(kwargs['replay_dir'])
        if kwargs.get('error_dir'):
            kwargs['error_dir']=str(kwargs['error_dir'])
        progress=kwargs.pop('progress',None)
        if hasattr(kwargs.get('opponent_weights'),'tolist'):kwargs['opponent_weights']=kwargs['opponent_weights'].tolist()
        if not self.checkpoint.is_file():raise FileNotFoundError(self.checkpoint)
        started=time.monotonic();active=[];tracks=[];games=[];metrics=[];results={}
        temporary=tempfile.TemporaryDirectory(prefix='.rollout-',dir=self.checkpoint.parent)
        previous=signal.signal(signal.SIGTERM,interrupted)
        try:
            directory=Path(temporary.name)
            # Pin the immutable inode even if a future caller replaces latest.pt.
            snapshot=directory/'checkpoint.pt';os.link(self.checkpoint,snapshot)
            job=dict(checkpoint=str(snapshot),seeds=seeds,options=options,device=str(device),kwargs=kwargs)
            (directory/'job.json').write_text(json.dumps(job))
            for index,(start,end,workers) in enumerate(shards(seeds,self.worker_count,self.processes)):
                command=[sys.executable,'-u','-m','tavern_rl.process_rollout','--job',str(directory/'job.json'),
                         '--index',str(index),'--start',str(start),'--end',str(end),'--workers',str(workers)]
                with (directory/f'{index}.log').open('w') as log:
                    process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                active.append(process)
            pending=set(range(len(active)));last=started
            while pending:
                for index in list(pending):
                    code=active[index].poll()
                    if code is None:continue
                    if code:
                        raise RuntimeError(f'Rollout process {index} exited {code}: '+(directory/f'{index}.log').read_text()[-3000:])
                    result=torch.load(directory/f'{index}.pt',map_location='cpu',weights_only=False)
                    results[index]=result
                    (directory/f'{index}.pt').unlink();pending.remove(index)
                if progress and time.monotonic()-last>=30:
                    rows=[json.loads(p.read_text()) for p in directory.glob('*.progress.json')]
                    actions=sum(r.get('environment_actions',0) for r in rows)
                    elapsed=time.monotonic()-started
                    progress(dict(stage='collect',sampling_processes=len(active),completed_games=sum(r.get('completed_games',0) for r in rows),
                                  total_games=len(seeds),environment_actions=actions,seconds=round(elapsed,1),actions_per_second=actions/elapsed))
                    last=time.monotonic()
                if pending:time.sleep(.1)
            # Completion timing must not change recurrent PPO's shuffled input order.
            for index in sorted(results):
                result=results[index]
                tracks.extend(result['tracks']);games.extend(result['games']);metrics.append(result['performance'])
            results.clear()
            if len(games)!=len(seeds) or sorted(g['seed'] for g in games)!=sorted(seeds):
                raise RuntimeError('Parallel sampler lost or duplicated games')
            elapsed=time.monotonic()-started
            actions=sum(m['environment_actions'] for m in metrics)
            batches=sum(m['inference_batches'] for m in metrics)
            performance=dict(seconds=elapsed,environment_actions=actions,actions_per_second=actions/elapsed,
                inference_batches=batches,mean_inference_batch=sum(m['mean_inference_batch']*m['inference_batches'] for m in metrics)/max(1,batches),
                sampling_processes=len(active),sampling_workers=self.worker_count,
                parallel_inference_seconds_sum=sum(m['inference_seconds'] for m in metrics),
                parallel_simulator_wait_seconds_sum=sum(m['simulator_wait_seconds'] for m in metrics),
                sampling_graphs=all(m.get('sampling_graphs',False) for m in metrics),
                sampling_graph_capture_seconds=sum(m.get('sampling_graph_capture_seconds',0.) for m in metrics),
                first_place_bonus=kwargs.get('first_place_bonus',0.))
            from collections import Counter
            for key in ('action_counts', 'learner_action_counts'):
                combined = Counter()
                for metric in metrics: combined.update(metric.get(key, {}))
                performance[key] = dict(combined)
            return tracks,games,performance
        finally:
            for process in active:
                if process.poll() is None:
                    try:os.killpg(process.pid,signal.SIGTERM)
                    except ProcessLookupError:pass
            deadline=time.monotonic()+5
            for process in active:
                try:process.wait(timeout=max(.01,deadline-time.monotonic()))
                except subprocess.TimeoutExpired:
                    try:os.killpg(process.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                    process.wait()
            temporary.cleanup()
            signal.signal(signal.SIGTERM,previous)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--job',type=Path,required=True)
    for name in ['index','start','end','workers']:p.add_argument('--'+name,type=int,required=True)
    args=p.parse_args();job=json.loads(args.job.read_text());torch.set_num_threads(1)
    from .train import load_checkpoint,frozen_models
    signal.signal(signal.SIGTERM,interrupted)
    prepare_descriptor_limit(args.workers)
    pool=SimulationPool(args.workers)
    try:
        saved,model=load_checkpoint(job['checkpoint'],pool.meta,job['device'])
        opponents=frozen_models(saved['league'],model.specification(),job['device'])
        del saved;gc.collect()
        kwargs=job['kwargs'];kwargs['seat_offset']=kwargs.get('seat_offset',0)+args.start
        if kwargs.get('schedule') is not None:kwargs['schedule']=kwargs['schedule'][args.start:args.end]
        path=args.job.parent/f'{args.index}.progress.json'
        def progress(row):
            if 'environment_actions' in row:write_json(path,row)
        tracks,games,performance=pool.collect(model,opponents,job['seeds'][args.start:args.end],job['options'],job['device'],progress=progress,**kwargs)
        torch.save(dict(tracks=tracks,games=games,performance=performance),args.job.parent/f'{args.index}.pt')
        write_json(path,dict(performance,completed_games=len(games)))
    finally:pool.close()


if __name__=='__main__':main()
