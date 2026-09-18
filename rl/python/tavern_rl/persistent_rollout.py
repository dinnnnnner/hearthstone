"""Resident sampler processes with synchronous, immutable policy versions.

The learner submits one task per stable shard and waits for every result before
updating. Game snapshots stay in the owning process. A worker failure aborts the
whole iteration: partial trajectories must never become a training batch.
"""
import argparse
import gc
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

import torch

from .process_rollout import interrupted, prepare_descriptor_limit, write_json
from .rollout import SimulationPool


class ResidentProcesses:
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory(prefix='tavern-samplers-')
        self.workers = {}

    def submit(self, index, workers, job, start, end):
        if self.directory is None:
            raise RuntimeError('Resident sampler pool is closed')
        if index not in self.workers:
            log_path = Path(self.directory.name) / f'{index}.log'
            with log_path.open('w') as log:
                process = subprocess.Popen(
                    [sys.executable, '-u', '-m', 'tavern_rl.persistent_rollout', '--workers', str(workers)],
                    stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                    text=True, start_new_session=True)
            self.workers[index] = (workers, process, log_path)
        count, process, _ = self.workers[index]
        if count != workers:
            raise ValueError('Resident shard width changed; create a new pool')
        if process.poll() is not None:
            raise RuntimeError(f'Resident sampler {index} died: {self.log_tail(index)}')
        process.stdin.write(json.dumps(dict(job=str(job),index=index,start=start,end=end))+'\n')
        process.stdin.flush()
        return process

    def log_tail(self, index):
        return self.workers[index][2].read_text()[-3000:]

    def close(self):
        # Include Node descendants in shutdown, even when Python already died.
        for _, process, _ in self.workers.values():
            if process.stdin is not None:
                try:process.stdin.close()
                except (BrokenPipeError,OSError):pass
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
        deadline = time.monotonic()+5
        for _, process, _ in self.workers.values():
            try:process.wait(timeout=max(.01,deadline-time.monotonic()))
            except subprocess.TimeoutExpired:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait()
        self.workers.clear()
        if self.directory is not None:self.directory.cleanup()
        self.directory = None


class ResidentSampler:
    def __init__(self, workers):
        self.pool = SimulationPool(workers)
        self.model = None
        self.opponents = []
        self.league_identity = None
        self.stream_identity = None
        self.inference_client=None

    def close(self):
        try:self.pool.close()
        finally:
            if self.inference_client is not None:self.inference_client.close();self.inference_client=None

    def run(self, task):
        from .train import load_checkpoint, frozen_models
        directory = Path(task['job']).parent
        job = json.loads(Path(task['job']).read_text())
        kwargs = dict(job['kwargs'])
        prepare_descriptor_limit(max(len(self.pool.simulators),(kwargs.get('counterfactual') or {}).get('workers',0)))
        reset = job.get('reset_stream',True) or not kwargs.get('streaming')
        identity = (tuple(job['seeds']),task['start'],task['end'],str(job['device']))
        if not reset and self.stream_identity != identity:
            raise ValueError('Resident streaming task identity changed')
        self.stream_identity = identity
        if reset:self.pool.streaming_state = None
        load_started = time.monotonic()
        inference=job.get('inference')
        if inference is not None:
            from .inference_client import RemotePolicy
            from .inference_transport import InferenceClient
            if self.inference_client is None:self.inference_client=InferenceClient(inference['address'])
            specs=inference['specifications']
            self.model=RemotePolicy(self.inference_client,inference,self.pool.meta,specs['-1'],-1)
            self.opponents=[RemotePolicy(self.inference_client,inference,self.pool.meta,specs[str(i)],i) for i in range(len(specs)-1)]
            policy_iteration=inference['policy_iteration']
        else:
            # mmap avoids reading optimizer tensors which inference never touches.
            saved, self.model = load_checkpoint(job['checkpoint'],self.pool.meta,job['device'],
                                                model=self.model,mmap=True)
            league_identity = [(entry['generation'],entry.get('source_model_sha256'),
                                entry.get('model_spec',saved['model_spec'])) for entry in saved['league']]
            if reset:
                # League membership is frozen for the lifetime of each streaming batch.
                self.opponents.clear()
                self.opponents = frozen_models(saved['league'],saved['model_spec'],job['device'])
                self.league_identity = league_identity
            elif self.league_identity != league_identity:
                raise ValueError('League changed during an active streaming batch')
            policy_iteration = saved.get('iteration')
            del saved
        self.model.eval()  # Also invalidate cached string embeddings after weight load.
        load_seconds = time.monotonic()-load_started
        kwargs['seat_offset'] = kwargs.get('seat_offset',0)+task['start']
        if kwargs.get('schedule') is not None:
            kwargs['schedule'] = kwargs['schedule'][task['start']:task['end']]
        # Explicit resume is for tests/imports. Normal resident tasks retain state.
        resume = directory/f"{task['index']}.resume.pt"
        if reset and kwargs.get('streaming') and resume.exists():
            kwargs['resume_state'] = torch.load(resume,map_location='cpu',weights_only=False)
        state = getattr(self.pool,'streaming_state',None)
        if not reset and state is not None:
            kwargs['resume_state'] = state
        path = directory/f"{task['index']}.progress.json"
        latest = {}
        def progress(row):
            if 'environment_actions' in row or row.get('stage')=='counterfactual':
                latest.update(row);write_json(path,latest)
        tracks,games,performance = self.pool.collect(self.model,self.opponents,
            job['seeds'][task['start']:task['end']],job['options'],'cpu' if inference is not None else job['device'],progress=progress,**kwargs)
        performance.update(policy_load_seconds=load_seconds,policy_iteration=policy_iteration,worker_pid=os.getpid())
        if inference is not None:
            performance['feature_pack_seconds']=sum(m.pack_seconds for m in [self.model,*self.opponents])
        state = getattr(self.pool,'streaming_state',None)
        summary = None if state is None else dict(done=state['done'],active_count=len(state['active']))
        result = dict(tracks=tracks,games=games,performance=performance,streaming_state=summary)
        for name in ('planning_examples','card_evaluations','stage_evaluations','branch_labels',
                     'branch_reports','card_value_labels','card_value_reports'):
            result[name] = getattr(self.pool,name)
        # Result existence is the completion signal; never expose a partial zip.
        destination = directory/f"{task['index']}.pt"
        temporary = destination.with_suffix('.next')
        torch.save(result,temporary)
        write_json(path,dict(performance,completed_games=len(games)))
        temporary.replace(destination)
        del result,tracks,games
        gc.collect()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers',type=int,required=True)
    args=parser.parse_args()
    torch.set_num_threads(1)
    signal.signal(signal.SIGTERM,interrupted)
    sampler=ResidentSampler(args.workers)
    try:
        for line in sys.stdin:
            sampler.run(json.loads(line))
    finally:sampler.close()


if __name__=='__main__':main()
