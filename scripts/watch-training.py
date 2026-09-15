"""Read-only, job-bound training health checks; no automatic restarts or publications."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def utc(timestamp):
    return dt.datetime.fromtimestamp(timestamp,dt.timezone.utc).isoformat()


def read_json(path):
    return json.loads(path.read_text())


def tail(path, limit=32768):
    with path.open('rb') as stream:
        stream.seek(max(0,path.stat().st_size-limit))
        return stream.read().decode(errors='replace')


def process(pid):
    if not pid:return None
    try:
        root=Path('/proc')/str(pid)
        fields=(root/'stat').read_text().rsplit(')',1)[1].split()
        if fields[0] == 'Z':return None
        return dict(pid=pid,start_ticks=int(fields[19]),
                    cpu_seconds=(int(fields[11])+int(fields[12]))/os.sysconf('SC_CLK_TCK'),
                    argv=(root/'cmdline').read_bytes().decode(errors='replace').strip('\0').split('\0'))
    except (FileNotFoundError,ProcessLookupError):return None


def correct_member_process(proc, member):
    if not proc:return False
    args=proc['argv'];stage=member['stage']
    expected='tavern_rl.train' if stage=='training' else 'tavern_rl.mix_league'
    if expected not in args or '--output' not in args:return False
    index=args.index('--output')+1
    if index>=len(args):return False
    destination=Path(member['root'])/('training' if stage=='training' else 'exchange')
    return Path(args[index]).resolve()==destination.resolve()


def inspect_member(member, now):
    root=Path(member['root']);stage=member['stage'];proc=process(member['pid'])
    manifest=read_json(root/'training/manifest.json')
    log=root/f'{stage}-{member["round"]:04d}.log'
    paths=[root/'training/latest.pt',root/'training/metrics.jsonl']
    if log.exists():paths.append(log)
    progress=[]
    for path in (root/'training').glob('.rollout-*/*.progress.json'):
        try:progress.append(read_json(path));paths.append(path)
        except (FileNotFoundError,json.JSONDecodeError):pass
    mtimes=[]
    for path in paths:
        try:mtimes.append(path.stat().st_mtime)
        except FileNotFoundError:pass
    text=tail(log) if log.exists() else ''
    return dict(index=member['index'],stage=stage,pid=member['pid'],
                process_valid=correct_member_process(proc,member),
                start_ticks=proc['start_ticks'] if proc else None,
                cpu_seconds=proc['cpu_seconds'] if proc else None,
                episodes=manifest['episodes'],iteration=manifest['iteration'],
                activity_age_seconds=round(now-max(mtimes),1) if mtimes else None,
                sampler_reports=len(progress),
                sampled_actions=sum(r.get('environment_actions',0) for r in progress),
                completed_sampling_games=sum(r.get('completed_games',0) for r in progress),
                log_error=any(marker in text for marker in [
                    'Traceback (most recent call last)', 'CUDA out of memory', 'torch.OutOfMemoryError']))


def assess(row, previous, now, deadline):
    issues=[]
    if row['stage']=='running':
        if not row['coordinator_valid']:issues.append('Coordinator process is missing or has a different identity')
        if now>deadline+30:issues.append('Training is still running after its deadline')
        old={m['index']:m for m in (previous or {}).get('members',[])}
        for member in row['members']:
            if member['stage']=='frozen':continue
            label=f'Member {member["index"]}'
            if not member['process_valid']:issues.append(label+' process is missing or has a different identity')
            if member['log_error']:issues.append(label+' current log contains an exception')
            before=old.get(member['index']);age=member['activity_age_seconds']
            if before and member['episodes']<before['episodes']:issues.append(label+' checkpoint episode count decreased')
            same=before and member['pid']==before['pid'] and member['start_ticks']==before['start_ticks']
            if same and member['cpu_seconds'] is not None and before['cpu_seconds'] is not None:
                idle=member['cpu_seconds']-before['cpu_seconds']<.1
                if age is not None and (age>1800 or age>900 and idle):
                    issues.append(label+' has no recent progress; inspect sampling/PPO activity')
    elif row['stage']=='time_limit':
        if now<deadline-30:issues.append('Training stopped before the expected deadline')
        if any(m['pid'] for m in row['members']):issues.append('Stopped status still lists active member PIDs')
    else:issues.append('Training state: '+row['stage'])
    if row.get('memory_fraction',0)>.9:issues.append('Container memory exceeds 90% of its limit')
    if row.get('disk_free_gib',100)<2:issues.append('Training disk has less than 2 GiB free')
    old_oom=(previous or {}).get('oom_kill',row.get('oom_kill',0))
    if row.get('oom_kill',0)>old_oom:issues.append('New cgroup OOM kill detected')
    if row.get('gpu_error'):issues.append('GPU query failed: '+row['gpu_error'])
    return issues


def snapshot(root, job, previous, now):
    state=read_json(root/'status.json');proc=process(state.get('pid'))
    expected=state.get('pid')==job['pid'] and state.get('deadline_utc')==job['deadlineUtc']
    row=dict(utc=utc(now),stage=state['stage'],coordinator_valid=bool(expected and proc and
             any(a.endswith('/population_resume.py') for a in proc['argv'])),
             members=[inspect_member(m,now) for m in state['members']])
    if not expected:
        row['stage']='different_job'
    cgroup=Path('/sys/fs/cgroup')
    memory=int((cgroup/'memory.current').read_text());limit=(cgroup/'memory.max').read_text().strip()
    row['memory_gib']=memory/2**30
    if limit!='max':row['memory_fraction']=memory/int(limit)
    row['oom_kill']=int(dict(line.split() for line in (cgroup/'memory.events').read_text().splitlines()).get('oom_kill',0))
    row['cpu_usage_usec']=int(dict(line.split() for line in (cgroup/'cpu.stat').read_text().splitlines())['usage_usec'])
    quota,period=(cgroup/'cpu.max').read_text().split()
    cores=float(quota)/float(period) if quota!='max' else len(os.sched_getaffinity(0))
    row['cpu_quota_cores']=cores
    if previous and 'cpu_usage_usec' in previous:
        seconds=now-dt.datetime.fromisoformat(previous['utc']).timestamp()
        row['cpu_percent_since_previous_check']=(row['cpu_usage_usec']-previous['cpu_usage_usec'])/1e6/max(seconds,.001)/cores*100
    row['disk_free_gib']=shutil.disk_usage(root).free/2**30
    try:
        result=subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu,memory.used,power.draw',
                               '--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=10,check=True)
        row['gpu']=result.stdout.strip()
    except (OSError,subprocess.SubprocessError) as error:row['gpu_error']=str(error)
    row['issues']=assess(row,previous,now,job['deadline_timestamp'])
    row['healthy']=not row['issues']
    return row


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--population',type=Path,required=True)
    p.add_argument('--job',type=Path,required=True,help='Exact resume.json for this training job')
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--interval',type=int,default=300)
    args=p.parse_args()
    if args.interval<1:p.error('Interval must be positive')
    job=read_json(args.job)
    job['deadline_timestamp']=dt.datetime.fromisoformat(job['deadlineUtc']).timestamp()
    deadline=job['deadline_timestamp'];args.output.mkdir(parents=True,exist_ok=True)
    with (args.output/'watch.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        (args.output/'watch.pid').write_text(str(os.getpid())+'\n')
        previous=None
        while True:
            started=time.time()
            try:
                row=snapshot(args.population,job,previous,started)
                if row['stage']=='running' and any('process is missing' in issue for issue in row['issues']):
                    # The coordinator normally replaces a completed child within one second.
                    time.sleep(2)
                    row=snapshot(args.population,job,previous,time.time())
            except Exception as error:
                row=dict(utc=utc(started),healthy=False,stage='check_failed',issues=[repr(error)])
            done=row['stage'] in ('time_limit','interrupted','failed','different_job') or started>=deadline+120
            next_check=min(started+args.interval,deadline+20 if started<deadline+20 else deadline+120)
            row.update(watch_pid=os.getpid(),job_pid=job['pid'],interval_seconds=args.interval,
                       next_check_utc=None if done else utc(next_check),watch_complete=done)
            temporary=args.output/'latest.next';temporary.write_text(json.dumps(row,indent=2)+'\n')
            temporary.replace(args.output/'latest.json')
            with (args.output/'checks.jsonl').open('a') as log:log.write(json.dumps(row)+'\n')
            if row['issues']:
                with (args.output/'alerts.jsonl').open('a') as log:log.write(json.dumps(row)+'\n')
            print(json.dumps(row),flush=True)
            if done:break
            if row['stage']!='check_failed':previous=row
            while time.time()<next_check:time.sleep(max(.01,min(60,next_check-time.time())))


if __name__=='__main__':main()
