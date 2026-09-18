"""Parallel on-policy rollout processes with disjoint seeds and a fixed checkpoint."""
import argparse
from contextlib import contextmanager, ExitStack
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


@contextmanager
def rollout_storage(checkpoint):
    """Keep the immutable checkpoint on disk; optionally exchange trajectories in RAM."""
    scratch = os.environ.get('TAVERN_ROLLOUT_SCRATCH')
    with ExitStack() as stack:
        directory = Path(stack.enter_context(tempfile.TemporaryDirectory(
            prefix='.rollout-', dir=scratch or checkpoint.parent)))
        pinned = Path(stack.enter_context(tempfile.TemporaryDirectory(
            prefix='.policy-', dir=checkpoint.parent))) if scratch else directory
        snapshot = pinned/'checkpoint.pt'
        os.link(checkpoint, snapshot)
        yield directory, snapshot


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
    def __init__(self, workers, processes, checkpoint, persistent=False, inference=None):
        shards([0],workers,processes)
        self.worker_count,self.processes,self.checkpoint=workers,processes,Path(checkpoint)
        if inference is not None and not persistent:raise ValueError("Central inference requires resident samplers")
        self.inference_options=inference;self.inference=None
        self.resident = None
        if persistent:
            from .persistent_rollout import ResidentProcesses
            self.resident = ResidentProcesses()
        self.simulators=[Simulator()]
        self.meta=self.simulators[0].meta

    def close(self):
        if self.resident is not None:self.resident.close()
        if self.inference is not None:self.inference.close();self.inference=None
        for simulator in self.simulators: simulator.close()

    def collect(self,current,opponents,seeds,options,device,**kwargs):
        seeds=list(seeds)
        self.planning_examples=[]
        self.card_evaluations=[]
        self.stage_evaluations=[]
        self.branch_labels=[];self.branch_reports=[]
        self.card_value_labels=[];self.card_value_reports=[]
        if kwargs.get('streaming') and not getattr(self,'streaming_state',None):self.stream_completed_seeds=set()
        if kwargs.get('replay_dir'):
            kwargs['replay_dir']=str(kwargs['replay_dir'])
        if kwargs.get('error_dir'):
            kwargs['error_dir']=str(kwargs['error_dir'])
        progress=kwargs.pop('progress',None)
        if hasattr(kwargs.get('opponent_weights'),'tolist'):kwargs['opponent_weights']=kwargs['opponent_weights'].tolist()
        if not self.checkpoint.is_file():raise FileNotFoundError(self.checkpoint)
        started=time.monotonic();active=[];tracks=[];games=[];metrics=[];results={};succeeded=False
        temporary=rollout_storage(self.checkpoint)
        directory,snapshot=temporary.__enter__()
        previous=signal.signal(signal.SIGTERM,interrupted)
        try:
            # The snapshot stays on the checkpoint filesystem even with RAM scratch.
            job=dict(checkpoint=str(snapshot),seeds=seeds,options=options,device=str(device),kwargs=kwargs,
                     reset_stream=not bool(getattr(self,'streaming_state',None)))
            if self.inference_options is not None:
                if any(kwargs.get(key) for key in ('direct_planning','planning_states','stage_feedback')):
                    raise ValueError('Central inference currently supports recurrent rollout and branch teaching')
                if self.inference is None:
                    from .inference_client import SharedInference
                    self.inference=SharedInference(**self.inference_options,clients=self.processes+1)
                job['inference']=self.inference.load(snapshot,job['reset_stream'],device)
            (directory/'job.json').write_text(json.dumps(job))
            if self.resident is None and kwargs.get('streaming') and getattr(self,'streaming_state',None):
                for index,state in self.streaming_state.items():torch.save(state,directory/f'{index}.resume.pt')
            for index,(start,end,workers) in enumerate(shards(seeds,self.worker_count,self.processes)):
                command=[sys.executable,'-u','-m','tavern_rl.process_rollout','--job',str(directory/'job.json'),
                         '--index',str(index),'--start',str(start),'--end',str(end),'--workers',str(workers)]
                if self.resident is not None:
                    process=self.resident.submit(index,workers,directory/'job.json',start,end)
                else:
                    with (directory/f'{index}.log').open('w') as log:
                        process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                active.append(process)
            pending=set(range(len(active)));last=started
            while pending:
                if self.inference is not None and self.inference.process.poll() is not None:
                    raise RuntimeError('Inference service exited: '+(Path(self.inference.directory.name)/'service.log').read_text()[-3000:])
                for index in list(pending):
                    code=active[index].poll()
                    if self.resident is not None:
                        if code is not None:
                            raise RuntimeError(f'Resident sampler {index} exited {code}: '+self.resident.log_tail(index))
                        if not (directory/f'{index}.pt').exists():continue
                    elif code is None:continue
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
                                  total_games=len(seeds),environment_actions=actions,seconds=round(elapsed,1),actions_per_second=actions/elapsed,
                                  branch_actions=sum(r.get('branch_actions',0) for r in rows),branch_completed=sum(r.get('branch_completed',0) for r in rows)))
                    last=time.monotonic()
                if pending:time.sleep(.1)
            # Completion timing must not change recurrent PPO's shuffled input order.
            for index in sorted(results):
                result=results[index]
                tracks.extend(result['tracks']);games.extend(result['games']);metrics.append(result['performance'])
                self.planning_examples.extend(result.get('planning_examples',[]))
                self.card_evaluations.extend(result.get('card_evaluations',[]))
                self.stage_evaluations.extend(result.get('stage_evaluations',[]))
                self.branch_labels.extend(result.get('branch_labels',[]))
                self.branch_reports.extend(result.get('branch_reports',[]))
                self.card_value_labels.extend(result.get('card_value_labels',[]))
                self.card_value_reports.extend(result.get('card_value_reports',[]))
            self.card_evaluations.sort(key=lambda r:r['priority']);del self.card_evaluations[256:]
            self.planning_examples.sort(key=lambda r:r['priority'])
            del self.planning_examples[kwargs.get('planning_states',0):]
            stream_states={index:result['streaming_state'] for index,result in results.items()} if kwargs.get('streaming') else None
            results.clear()
            if not kwargs.get('streaming') and (len(games)!=len(seeds) or sorted(g['seed'] for g in games)!=sorted(seeds)):
                raise RuntimeError('Parallel sampler lost or duplicated games')
            elapsed=time.monotonic()-started
            actions=sum(m['environment_actions'] for m in metrics)
            batches=sum(m['inference_batches'] for m in metrics)
            performance=dict(seconds=elapsed,environment_actions=actions,actions_per_second=actions/elapsed,
                inference_batches=batches,mean_inference_batch=sum(m['mean_inference_batch']*m['inference_batches'] for m in metrics)/max(1,batches),
                sampling_processes=len(active),sampling_workers=self.worker_count,persistent_samplers=self.resident is not None,
                parallel_inference_seconds_sum=sum(m['inference_seconds'] for m in metrics),
                parallel_simulator_wait_seconds_sum=sum(m['simulator_wait_seconds'] for m in metrics),
                sampling_graphs=all(m.get('sampling_graphs',False) for m in metrics),
                sampling_graph_capture_seconds=sum(m.get('sampling_graph_capture_seconds',0.) for m in metrics),
                first_place_bonus=kwargs.get('first_place_bonus',0.))
            if self.resident is not None:
                versions={m.get('policy_iteration') for m in metrics}
                if len(versions)!=1:raise RuntimeError('Samplers used different policy versions')
                performance.update(sampler_policy_iteration=versions.pop(),
                    sampler_pids=[m['worker_pid'] for m in metrics],
                    parallel_policy_load_seconds_sum=sum(m.get('policy_load_seconds',0.) for m in metrics))
            from collections import Counter
            if kwargs.get('streaming'):
                self.streaming_state=stream_states
                completed={g['seed'] for g in games}
                if len(completed)!=len(games) or completed-set(seeds) or completed & self.stream_completed_seeds:
                    raise RuntimeError('Streaming sampler duplicated or replaced a game')
                self.stream_completed_seeds.update(completed)
                performance.update(streaming_done=all(state['done'] for state in self.streaming_state.values()),
                    streaming_active_games=sum(state.get('active_count',len(state.get('active',[]))) for state in self.streaming_state.values()),
                    streaming_tracks=len(tracks),tier_tempo_checks=[row for m in metrics for row in m.get('tier_tempo_checks',[])])
                if performance['streaming_done'] and self.stream_completed_seeds!=set(seeds):raise RuntimeError('Streaming sampler lost games')
            if kwargs.get('counterfactual'):
                combined=Counter()
                for metric in metrics:combined.update(metric.get('counterfactual',{}))
                performance['counterfactual']=dict(combined)
            if kwargs.get('card_value'):
                combined=Counter()
                for metric in metrics:combined.update(metric.get('card_value',{}))
                performance['card_value']=dict(combined)
            if kwargs.get('stage_feedback'):
                performance['stage_feedback']=dict(milestones=len(self.stage_evaluations),**kwargs['stage_feedback'])
            if kwargs.get('basic_feedback'):
                keys=('states','seconds','trajectories','positive_steps','negative_steps','feedback_sum','terminal_correction_sum')
                performance['basic_feedback']={key:sum(m['basic_feedback'][key] for m in metrics) for key in keys}
                performance['basic_feedback']['coefficient']=kwargs['basic_feedback']['coefficient']
            for key in ('action_counts', 'learner_action_counts'):
                combined = Counter()
                for metric in metrics: combined.update(metric.get(key, {}))
                performance[key] = dict(combined)
            if kwargs.get('direct_planning'):
                combined=Counter();selected=Counter();routes=[];peak=0
                for metric in metrics:
                    search=metric['direct_planning'];selected.update(search.get('selected',{}));routes.extend(search.get('routes',[]))
                    peak=max(peak,search.get('max_live_branches',0))
                    for key in ('calls','decisions','fallbacks','seconds','chance_nodes','deterministic_steps','evaluations','completed_routes','cutoff_routes','purchase_comparisons'):
                        combined[key]+=search.get(key,0)
                performance['direct_planning']=dict(combined,selected=dict(selected),routes=routes[:24],max_live_branches=peak,
                    trials=kwargs['direct_planning']['trials'],chance_policy='first-random-transition-v1',candidate_policy='all-sales-zero-gold-v2')
            if self.inference is not None:
                stats=self.inference.metrics()
                performance.update(central_inference=stats,parallel_feature_pack_seconds_sum=sum(m.get('feature_pack_seconds',0.) for m in metrics),
                    sampling_graphs=bool(stats['sampling_graph_replays']),
                    sampling_graph_capture_seconds=stats['sampling_graph_capture_seconds'])
            succeeded=True
            return tracks,games,performance
        finally:
            if self.resident is not None:
                if not succeeded:
                    self.resident.close()
                    if self.inference is not None:self.inference.close();self.inference=None
                active=[]
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
            temporary.__exit__(None,None,None)
            signal.signal(signal.SIGTERM,previous)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--job',type=Path,required=True)
    for name in ['index','start','end','workers']:p.add_argument('--'+name,type=int,required=True)
    args=p.parse_args();job=json.loads(args.job.read_text());torch.set_num_threads(1)
    from .train import load_checkpoint,frozen_models
    signal.signal(signal.SIGTERM,interrupted)
    prepare_descriptor_limit(max(args.workers,(job['kwargs'].get('counterfactual') or {}).get('workers',0)))
    pool=SimulationPool(args.workers)
    try:
        saved,model=load_checkpoint(job['checkpoint'],pool.meta,job['device'])
        opponents=frozen_models(saved['league'],model.specification(),job['device'])
        del saved;gc.collect()
        kwargs=job['kwargs'];kwargs['seat_offset']=kwargs.get('seat_offset',0)+args.start
        resume=args.job.parent/f'{args.index}.resume.pt'
        if kwargs.get('streaming') and resume.exists():kwargs['resume_state']=torch.load(resume,map_location='cpu',weights_only=False)
        if kwargs.get('schedule') is not None:kwargs['schedule']=kwargs['schedule'][args.start:args.end]
        path=args.job.parent/f'{args.index}.progress.json'
        latest={}
        def progress(row):
            if 'environment_actions' in row or row.get('stage')=='counterfactual':
                latest.update(row);write_json(path,latest)
        tracks,games,performance=pool.collect(model,opponents,job['seeds'][args.start:args.end],job['options'],job['device'],progress=progress,**kwargs)
        torch.save(dict(tracks=tracks,games=games,performance=performance,planning_examples=pool.planning_examples,
                        card_evaluations=pool.card_evaluations,stage_evaluations=pool.stage_evaluations,
                        branch_labels=pool.branch_labels,branch_reports=pool.branch_reports,
                        card_value_labels=pool.card_value_labels,card_value_reports=pool.card_value_reports,
                        streaming_state=getattr(pool,'streaming_state',None)),args.job.parent/f'{args.index}.pt')
        write_json(path,dict(performance,completed_games=len(games)))
    finally:pool.close()


if __name__=='__main__':main()
