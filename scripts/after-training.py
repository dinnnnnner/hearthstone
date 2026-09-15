"""Publish a specific completed training job, then resume the population once."""
import argparse
import datetime as dt
import fcntl
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location('tavern_ops', Path(__file__).with_name('tavern-ops.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


def ready(state, expected_pid, deadline):
    if state['pid'] != expected_pid or state['deadline_utc'] != deadline:
        raise RuntimeError('Training job changed; refusing to publish or resume another job')
    if state['stage'] == 'running': return False
    if state['stage'] != 'time_limit' or any(m['pid'] is not None for m in state['members']):
        raise RuntimeError('Expected the scheduled stop; training failed or was interrupted')
    return True


def save(path, value):
    pending = path.with_suffix('.next')
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    os.replace(pending, path)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--job', type=Path, required=True)
    p.add_argument('--expected-pid', type=int, required=True)
    p.add_argument('--deadline-utc', required=True)
    p.add_argument('--hours', type=float, required=True)
    p.add_argument('--control-path', required=True)
    args = p.parse_args()
    if not math.isfinite(args.hours) or args.hours <= 0: p.error('hours must be positive')
    deadline = dt.datetime.fromisoformat(args.deadline_utc)
    if deadline.tzinfo is None: p.error('deadline needs timezone')
    args.job.mkdir(parents=True, exist_ok=True)
    with (args.job/'pipeline.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (args.job/'status.json').exists(): raise RuntimeError('Job already started; inspect its receipt before retrying')
        ops.CONTROL = args.control_path
        original_ssh = ops.ssh_args
        def batch_ssh(host):
            command = original_ssh(host)
            return command[:-1]+['-o','BatchMode=yes','-o','ConnectTimeout=15',
                                 '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',command[-1]]
        ops.ssh_args = batch_ssh
        status = dict(pid=os.getpid(), expectedPid=args.expected_pid, originalDeadlineUtc=args.deadline_utc,
                      resumeHours=args.hours, includeSearch=True)
        def stage(name, **fields):
            status.update(stage=name, utc=dt.datetime.now(dt.timezone.utc).isoformat(), **fields)
            save(args.job/'status.json', status)
        try:
            stage('waiting_for_training')
            failures = 0
            while True:
                try:
                    state = ops.state(); failures = 0
                except subprocess.CalledProcessError:
                    failures += 1
                    if failures >= 10: raise
                    stage('waiting_for_connection', consecutiveFailures=failures)
                    time.sleep(30); continue
                if ready(state, args.expected_pid, args.deadline_utc): break
                stage('waiting_for_training', trainingStage=state['stage'])
                if dt.datetime.now(dt.timezone.utc) > deadline+dt.timedelta(minutes=10):
                    raise RuntimeError('Scheduled training stop did not complete within 10 minutes')
                time.sleep(30)
            save(args.job/'completed-training.json', state)
            # Finish current player games before exporting and cutting services over.
            stage('waiting_for_idle_rooms')
            while True:
                ready(ops.state(), args.expected_pid, args.deadline_utc)
                health = json.loads(ops.ssh(ops.PUBLIC, 'curl -fsS http://127.0.0.1:8787/health', capture=True))
                if health['ok'] and health['rooms'] == 0: break
                stage('waiting_for_idle_rooms', rooms=health['rooms'])
                time.sleep(30)
            tag = args.job.name
            work = ops.render(tag, args.hours, workers=64, games=64, sequence_batch_size=32,
                              fused_adam=True, sampling_processes=8, mps=True, training_graphs=True)
            stage('publishing', work=str(work))
            ops.publish(work, tag, include_search=True, wait_for_idle=True)
            save(args.job/'publication.json', json.loads((work/'model-verification.json').read_text()))
            # Never extend training after a partial publication or another operator's restart.
            if not ready(ops.state(), args.expected_pid, args.deadline_utc):
                raise RuntimeError('Training resumed during publication')
            stage('resuming')
            ops.train(work, tag, args.hours)
            receipt = json.loads((work/'resume.json').read_text())
            save(args.job/'resume.json', receipt)
            remote = '/root/tavern-ops/'+tag
            ops.copy_to(ops.TRAINING, [ops.REPO/'scripts/watch-training.py'], remote)
            code = f'''import json,os,subprocess
from pathlib import Path
job=Path({remote!r});receipt=json.loads((job/'resume.json').read_text())
command=['/root/miniconda3/bin/python','-u',str(job/'watch-training.py'),'--population',{ops.ROOT!r},'--job',str(job/'resume.json'),'--output',str(job/'health'),'--interval','300']
with (job/'watch.log').open('w') as log:
 p=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
receipt['watchPid']=p.pid;(job/'resume.json').write_text(json.dumps(receipt,indent=2)+'\\n');print(json.dumps(receipt))
'''
            receipt = json.loads(ops.remote_python(ops.TRAINING, code))
            save(args.job/'resume.json', receipt)
            stage('complete', resumedPid=receipt['pid'], watchPid=receipt['watchPid'], deadlineUtc=receipt['deadlineUtc'])
        except BaseException as error:
            stage('failed', error=repr(error))
            raise


if __name__ == '__main__': main()
