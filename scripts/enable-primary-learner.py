"""Let the existing population coordinator train selected members only."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil


def patch_source(source):
    if "p.add_argument('--active-members'" in source:
        return source
    replacements = [
        ("    args=p.parse_args()", "    p.add_argument('--active-members',type=int,nargs='+',help='Member indices to update; other checkpoints remain frozen opponents')\n    args=p.parse_args()\n    selected=set(range(len(args.resumes))) if args.active_members is None else set(args.active_members)\n    if not selected or any(i<0 or i>=len(args.resumes) for i in selected) or (args.active_members is not None and len(selected)!=len(args.active_members)):\n        raise ValueError('Active members must be distinct valid checkpoint indices')"),
        ("    members=[];active={}", "    state['active_members']=sorted(selected)\n    members=[];active={}"),
        ("members.append(dict(root=target,round=prior['members'][i]['round'],stage='ready'))", "members.append(dict(root=target,round=prior['members'][i]['round'],stage='ready' if i in selected else 'frozen'))"),
        ("            for i,member in enumerate(members):\n                if time.monotonic()>=deadline:", "            for i,member in enumerate(members):\n                if i not in selected: continue\n                if time.monotonic()>=deadline:"),
    ]
    for before, after in replacements:
        if source.count(before) != 1:
            raise ValueError('Unrecognized coordinator around ' + before[:80])
        source = source.replace(before, after, 1)
    compile(source, 'population_resume.py', 'exec')
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--coordinator', type=Path, required=True)
    parser.add_argument('--population', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    args = parser.parse_args()
    with (args.population / '.population.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        status = json.loads((args.population / 'status.json').read_text())
        if status['stage'] not in ('interrupted', 'time_limit') or any(m['pid'] is not None for m in status['members']):
            raise RuntimeError('Stop population training before patching the coordinator')
        before = args.coordinator.read_text()
        after = patch_source(before)
        args.backup.mkdir(parents=True, exist_ok=False)
        shutil.copy2(args.coordinator, args.backup / args.coordinator.name)
        temporary = args.coordinator.with_suffix('.primary-next')
        temporary.write_text(after)
        os.replace(temporary, args.coordinator)
        report = dict(coordinator=str(args.coordinator),
            before_sha256=hashlib.sha256(before.encode()).hexdigest(),
            after_sha256=hashlib.sha256(after.encode()).hexdigest())
        (args.backup / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))


if __name__ == '__main__':
    main()
