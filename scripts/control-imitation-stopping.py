"""Apply validation stopping to existing workers without reloading their weights."""
import argparse
import datetime
import json
from pathlib import Path
import os
import signal
import time
from tavern_rl.imitation_stopping import stopping_status
from tavern_rl.imitate_repeated import atomic_json


def valid_worker(member):
    proc=Path('/proc')/str(member['pid'])
    try:
        ticks=proc.joinpath('stat').read_text().split(') ',1)[1].split()[19]
        args=proc.joinpath('cmdline').read_bytes().split(b'\0')
    except FileNotFoundError:return False
    return ticks==member['startTicks'] and b'tavern_rl.imitate_fresh' in args and member['output'].encode() in args


def inspect_member(member):
    root=Path(member['output']);progress={}
    if (root/'progress.json').exists():progress=json.loads((root/'progress.json').read_text())
    result=dict(depth=member['depth'],pid=member['pid'],alive=valid_worker(member),stage=progress.get('stage'))
    if (root/'baseline.json').exists():
        baseline=json.loads((root/'baseline.json').read_text()).get('before')
        file=root/'metrics.jsonl';rows=[]
        if file.exists():
            # A concurrent append can expose the last incomplete line.
            for line in file.read_text().splitlines(keepends=True):
                if line.endswith('\n'):rows.append(json.loads(line))
        if baseline:
            assert [row['epoch'] for row in rows]==list(range(1,len(rows)+1))
            result['rule']=stopping_status(baseline['all']['negative_log_likelihood'],
                [row['validation']['all']['negative_log_likelihood'] for row in rows])
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--job',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    job=json.loads(args.job.read_text());args.output.mkdir(exist_ok=False)
    signaled={}
    while True:
        rows=[]
        for member in job['members']:
            result=inspect_member(member);key=str(member['depth'])
            if result['alive'] and result.get('rule',{}).get('stop') and key not in signaled:
                request=dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),**result)
                signaled[key]=request
                atomic_json(args.output/'stop-requests.json',signaled)
                # Check again immediately before signalling a PID that may have exited.
                if valid_worker(member):
                    try:os.kill(member['pid'],signal.SIGTERM)
                    except ProcessLookupError:pass
            result['stopRequested']=key in signaled;rows.append(result)
        report=dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),members=rows,
                    complete=not any(row['alive'] for row in rows),intervalSeconds=10,
                    rule=dict(patience=3,minDelta=.01,minEpochs=5),stopRequests=signaled)
        atomic_json(args.output/'latest.json',report)
        if report['complete']:break
        time.sleep(10)


if __name__=='__main__':main()
