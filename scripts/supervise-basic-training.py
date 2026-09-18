"""Resume the three basic-feedback learners with job-bound resource/progress checks.

No publications or notifications. A stop preserves completed checkpoints. Any
restart is explicit; invalid checkpoints and simulator errors are never retried.
"""
import argparse
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read(path):
    return json.loads(Path(path).read_text())


def atomic(path, value):
    path=Path(path);temporary=path.with_suffix('.next')
    temporary.write_text(json.dumps(value,indent=2)+'\n');temporary.replace(path)


def append(path, value):
    path=Path(path)
    if path.exists() and path.stat().st_size>16*2**20:
        path.replace(path.with_suffix(path.suffix+'.previous'))
    with path.open('a') as stream:stream.write(json.dumps(value)+'\n')


def tail(path, size=32768):
    try:
        with Path(path).open('rb') as f:
            f.seek(max(0,Path(path).stat().st_size-size));return f.read().decode(errors='replace')
    except FileNotFoundError:return ''


def process(pid):
    try:
        root=Path('/proc')/str(pid);fields=(root/'stat').read_text().rsplit(') ',1)[1].split()
        if fields[0]=='Z':return None
        return dict(pid=pid,birth=fields[19],argv=(root/'cmdline').read_bytes().decode().split('\0')[:-1])
    except (OSError,ValueError):return None


def same_process(pid,birth):
    p=process(pid);return p is not None and p['birth']==birth


def descendants(roots):
    rows=[x.split() for x in subprocess.check_output(['ps','-eo','pid=,ppid='],text=True).splitlines()]
    owned=set(roots)
    while True:
        more=owned|{int(pid) for pid,parent in rows if int(parent) in owned}
        if more==owned:break
        owned=more
    return {pid:p['birth'] for pid in owned if (p:=process(pid)) is not None}


def resources(root, previous=None):
    cg=Path('/sys/fs/cgroup');now=time.time()
    pairs=lambda name:dict(line.split() for line in (cg/name).read_text().splitlines())
    cpu=pairs('cpu.stat');quota,period=(cg/'cpu.max').read_text().split()
    cores=float(quota)/float(period) if quota!='max' else len(os.sched_getaffinity(0))
    memory=int((cg/'memory.current').read_text());limit=(cg/'memory.max').read_text().strip()
    row=dict(utc=utc(),timestamp=now,cpu_usage_usec=int(cpu['usage_usec']),cpu_quota_cores=cores,
             cpu_throttled_usec=int(cpu.get('throttled_usec',0)),ram_gib=memory/2**30,
             oom_kill=int(pairs('memory.events').get('oom_kill',0)),
             disk_free_gib=shutil.disk_usage(root).free/2**30,
             shm_free_gib=shutil.disk_usage('/dev/shm').free/2**30)
    if limit!='max':row.update(memory_fraction=memory/int(limit),ram_limit_gib=int(limit)/2**30)
    if previous:
        elapsed=max(now-previous['timestamp'],.001)
        row['cpu_cores']=(row['cpu_usage_usec']-previous['cpu_usage_usec'])/1e6/elapsed
        row['cpu_percent']=100*row['cpu_cores']/cores
    try:
        result=subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
                               '--format=csv,noheader,nounits'],capture_output=True,text=True,check=True,timeout=8)
        values=result.stdout.splitlines()[0].split(',')
        row.update(gpu_percent=int(values[0]),vram_used_mib=int(values[1]),vram_total_mib=int(values[2]),
                   gpu_temperature_c=int(values[3]),gpu_power_w=float(values[4]))
    except (OSError,ValueError,subprocess.SubprocessError) as error:row['gpu_error']=str(error)
    return row


def assess(sample, previous, members):
    """Return warning and stop reasons, independently of whether a log is chatty."""
    warnings=[];fatal=[]
    if sample.get('memory_fraction',0)>.88:warnings.append('memory_above_88_percent')
    if sample.get('memory_fraction',0)>.94:fatal.append('memory_above_94_percent')
    if sample['disk_free_gib']<2:warnings.append('disk_below_2_gib')
    if sample['disk_free_gib']<1:fatal.append('disk_below_1_gib')
    if sample['shm_free_gib']<2:fatal.append('scratch_below_2_gib')
    if previous and sample['oom_kill']>previous['oom_kill']:fatal.append('new_oom_kill')
    if 'gpu_error' in sample:warnings.append('gpu_query_failed')
    if sample.get('vram_used_mib',0)>sample.get('vram_total_mib',1)*.94:warnings.append('vram_above_94_percent')
    for member in members:
        if member.get('finished'):continue
        label=str(member['depth'])
        if not member['process_valid']:fatal.append(label+':process_identity_lost')
        if member.get('error'):fatal.append(label+':'+member['error'])
        if member['progress_age_seconds']>900:fatal.append(label+':no_sampling_or_checkpoint_progress_900s')
        elif member['progress_age_seconds']>300:warnings.append(label+':progress_older_than_300s')
    return warnings,fatal


def inspect(member, child):
    output=Path(member['output']);proc=process(child.pid)
    args=proc['argv'] if proc else []
    valid=bool(proc and proc['birth']==member['birth'] and 'tavern_rl.train' in args and '--output' in args
               and args[args.index('--output')+1]==str(output))
    row={k:member[k] for k in ('depth','pid','birth','output','log','scratch','started_timestamp')}
    row.update(process_valid=valid,exit_code=child.poll(),finished=child.returncode==0)
    paths=[output/'latest.pt']
    paths.extend(Path(member['scratch']).glob('.rollout-*/*.progress.json'))
    latest=max([member['started_timestamp']]+[p.stat().st_mtime for p in paths if p.exists()])
    row['progress_age_seconds']=time.time()-latest
    try:
        manifest=read(output/'manifest.json')
        row.update(iteration=manifest['iteration'],episodes=manifest['episodes'])
        if manifest['iteration']<member.get('last_iteration',0) or manifest['episodes']<member.get('last_episodes',0):
            row['error']='checkpoint_progress_regressed'
        member.update(last_iteration=manifest['iteration'],last_episodes=manifest['episodes'])
    except (OSError,ValueError,KeyError):pass
    lines=tail(output/'metrics.jsonl').splitlines()
    if lines:
        try:
            metrics=json.loads(lines[-1]);row['metrics']=metrics
            for key in ('policy_loss','value_loss','entropy','gradient_norm'):
                if key in metrics and not math.isfinite(metrics[key]):row['error']='nonfinite_'+key
        except ValueError:pass
    log=tail(member['log'])
    if any(s in log for s in ('Traceback (most recent call last)','CUDA out of memory','torch.OutOfMemoryError')):
        row['error']='training_exception'
    if child.returncode not in (None,0):row['error']='trainer_exit_'+str(child.returncode)
    return row


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job',type=Path,required=True)
    args=parser.parse_args();job=read(args.job)
    base=args.job.resolve().parent;runtime=Path(job['runtime']);root=Path(job['root'])
    with (root/'.supervisor.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if (base/'status.json').exists():raise RuntimeError('Use a new job directory for each explicit resume')
        env=dict(os.environ);env.update(read(runtime/'environment.json'))
        for key in list(env):
            if key.startswith('TAVERN_') and key!='TAVERN_SAMPLING_GRAPHS':env.pop(key)
        # Validate all members before launching any process.
        for depth in job['depths']:
            output=root/f'depth-{depth}';manifest=read(output/'manifest.json')
            if not (output/'latest.pt').is_file() or not manifest['config'].get('basic_feedback'):
                raise RuntimeError('Expected an existing basic-feedback checkpoint')
        stopped=False
        def stop(signum,frame):
            nonlocal stopped
            stopped=True
        signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
        children=[];members=[];logs=[];previous=None
        state=dict(stage='starting',started=utc(),pid=os.getpid(),job=str(args.job.resolve()),
                   profile=job['profile'],iterations_per_launch=job.get('iterations',1000000000))
        try:
            for depth in job['depths']:
                output=root/f'depth-{depth}';scratch=Path(job['scratch'])/str(depth);scratch.mkdir(parents=True,exist_ok=True)
                profile=job['profile'];command=[job['python'],'-u','-m','tavern_rl.train',
                    '--resume',str(output/'latest.pt'),'--output',str(output),'--basic-feedback',
                    '--device','cuda','--rollout-device','cuda','--iterations',str(job.get('iterations',1000000000)),
                    '--resume-games-per-iteration',str(profile['games']),'--workers',str(profile['workers']),
                    '--sampling-processes',str(profile['processes']),'--persistent-samplers',
                    '--resume-sequence-batch-size',str(profile['sequence_batch']),
                    '--threads','1','--training-graphs','--fused-adam','--packed-host-transfer']
                path=base/f'depth-{depth}.log';log=path.open('w');logs.append(log)
                child=subprocess.Popen(command,cwd=runtime,env=dict(env,TAVERN_ROLLOUT_SCRATCH=str(scratch)),
                                       stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                children.append(child);identity=process(child.pid)
                members.append(dict(depth=depth,pid=child.pid,birth=identity['birth'],output=str(output),
                                    scratch=str(scratch),log=str(path),started_timestamp=time.time(),command=command))
            state.update(stage='running',launch_members=members);atomic(base/'status.json',state)
            start=time.monotonic();last_health=0
            while True:
                sample=resources(root,previous);rows=[inspect(m,p) for m,p in zip(members,children)]
                warnings,fatal=assess(sample,previous,rows)
                if job.get('max_seconds') and time.monotonic()-start>job['max_seconds']:fatal.append('job_time_limit')
                state.update(updated=utc(),resources=sample,members=rows,warnings=warnings,healthy=not warnings and not fatal)
                append(base/'resources.jsonl',sample)
                if time.monotonic()-last_health>=60 or fatal:
                    check=dict(utc=utc(),healthy=state['healthy'],warnings=warnings,fatal=fatal,members=rows,resources=sample)
                    atomic(base/'health.json',check);append(base/'checks.jsonl',check)
                    if warnings or fatal:append(base/'alerts.jsonl',check)
                    last_health=time.monotonic()
                if fatal:state.update(reason='health_stop',failures=fatal);break
                if all(p.poll()==0 for p in children):state['reason']='iterations_completed';break
                if stopped:state['reason']='requested_stop';break
                atomic(base/'status.json',state);previous=sample
                end=time.monotonic()+10
                while time.monotonic()<end and not stopped:time.sleep(.2)
        except BaseException as error:
            state.update(reason='supervisor_exception',error=repr(error));raise
        finally:
            state['stage']='stopping';atomic(base/'status.json',state)
            owned=descendants([p.pid for p in children])
            for child in children:
                if child.poll() is None:child.send_signal(signal.SIGTERM)
            deadline=time.monotonic()+40
            while any(p.poll() is None for p in children) and time.monotonic()<deadline:time.sleep(.5)
            for pid,birth in owned.items():
                if same_process(pid,birth):
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass
            for child in children:child.wait()
            for log in logs:log.close()
            # These unique scratch roots belong to this job and contain no model checkpoints.
            for member in members:
                if not any(same_process(pid,birth) for pid,birth in owned.items()):
                    shutil.rmtree(member['scratch'],ignore_errors=True)
            state.update(stage='stopped',finished=utc(),exit_codes=[p.returncode for p in children])
            atomic(base/'status.json',state)
            atomic(base/'health.json',dict(utc=utc(),stage='stopped',reason=state.get('reason'),
                   healthy=state.get('reason') in ('iterations_completed','requested_stop'),failures=state.get('failures',[])))


if __name__=='__main__':main()
