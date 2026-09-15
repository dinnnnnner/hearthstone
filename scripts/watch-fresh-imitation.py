"""Check fresh imitation workers every five minutes; never restart or publish them."""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import time


def inspect(job):
    now=datetime.datetime.now(datetime.timezone.utc);rows=[];issues=[];alive=0
    for member in job['members']:
        proc=Path('/proc')/str(member['pid']);valid=False
        try:
            ticks=proc.joinpath('stat').read_text().split(') ',1)[1].split()[19]
            args=proc.joinpath('cmdline').read_bytes().split(b'\0')
            valid=ticks==member['startTicks'] and b'tavern_rl.imitate_fresh' in args and member['output'].encode() in args
        except FileNotFoundError:pass
        alive+=valid;root=Path(member['output']);progress={}
        if (root/'progress.json').exists():progress=json.loads((root/'progress.json').read_text())
        complete=progress.get('stage')=='complete'
        if not valid and (not complete or not progress.get('updates')):issues.append(f"{member['depth']}: worker exited without a trained result")
        files=[p for p in (root/'progress.json',root/'latest.pt',root/'metrics.jsonl') if p.exists()]
        age=time.time()-max((p.stat().st_mtime for p in files),default=datetime.datetime.fromisoformat(job['startedUtc']).timestamp())
        if valid and age>1200:issues.append(f"{member['depth']}: no progress for {age:.0f} seconds")
        rows.append(dict(depth=member['depth'],pid=member['pid'],processValid=valid,stage=progress.get('stage','starting'),
                         updates=progress.get('updates',0),epoch=progress.get('epoch',0),bestEpoch=progress.get('bestEpoch'),
                         bestValidationNll=progress.get('bestValidationNll'),activityAgeSeconds=round(age,1)))
    gpu=subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu,memory.used','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=15)
    return dict(utc=now.isoformat(),members=rows,issues=issues,healthy=not issues,complete=alive==0,
                gpu=gpu.stdout.strip(),intervalSeconds=300,nextCheckUtc=(now+datetime.timedelta(seconds=300)).isoformat())


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--job',type=Path,required=True);args=parser.parse_args()
    output=args.job.parent/'health';output.mkdir(exist_ok=True)
    while True:
        record=inspect(json.loads(args.job.read_text()))
        pending=output/'latest.json.next';pending.write_text(json.dumps(record,indent=2)+'\n');pending.replace(output/'latest.json')
        with (output/'checks.jsonl').open('a') as log:log.write(json.dumps(record)+'\n')
        print(json.dumps(record),flush=True)
        if record['complete']:break
        time.sleep(300)


if __name__=='__main__':main()
