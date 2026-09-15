"""Reclaim duplicate checkpoint storage and clean file cache after managed jobs stop.

Never delete unique checkpoints, datasets, replays or logs. No PyTorch import is
needed: equality is checked over complete files, without loading models into RAM.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
from contextlib import ExitStack
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import time


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))


def regular(path):
    return path.is_file() and path.resolve() == path.absolute() and not path.is_symlink()


def alive(pid):
    return type(pid) is int and pid > 0 and Path(f'/proc/{pid}').exists()


def memory():
    path = Path('/sys/fs/cgroup/memory.stat')
    if not path.exists(): return None
    fields = dict(line.split() for line in path.read_text().splitlines())
    return {key: int(fields.get(key, 0)) for key in ('anon', 'file')}


def advise(fd):
    if hasattr(os, 'posix_fadvise'):
        try: os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        except OSError: pass  # Some filesystems do not support this optional hint.


def discover(bases):
    roots = set()
    for base in bases:
        for status in Path(base).glob('tavern*/rl/runs/**/status.json'):
            if regular(status): roots.add(status.parent)
    return sorted(roots)


def lock_stopped(root, stack):
    if root.resolve() != root.absolute() or not regular(root/'status.json'):
        raise ValueError('Not a regular managed run directory')
    state = json.loads((root/'status.json').read_text())
    # Only group trainers have this schema. Unknown jobs are left alone.
    members = state.get('members')
    if not isinstance(members, list) or not members or not all(isinstance(m, dict) for m in members):
        raise ValueError('Unsupported run schema; no member list')
    if alive(state.get('pid')) or any(alive(m.get('pid')) for m in members):
        raise ValueError('A recorded supervisor or learner is still alive')
    directories = sorted(p for p in root.glob('member-*') if p.is_dir())
    if not directories or any(p.is_symlink() or not p.name[7:].isdigit() for p in directories):
        raise ValueError('Unexpected member directory layout')
    locks = [root/'.maintenance.lock', root/'.population.lock', root/'.independent.lock']
    locks += [p/'training/.train.lock' for p in directories if (p/'training').is_dir()]
    for path in locks:
        if path.resolve() != path.absolute(): raise ValueError('Symlink in a lock path')
        handle = stack.enter_context(path.open('a'))
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Re-read under locks. This also permits a crashed supervisor's stale status,
    # but only after every recorded process has exited and all locks are free.
    current = json.loads((root/'status.json').read_text())
    if current != state: raise ValueError('Run status changed during inspection')
    if alive(state.get('pid')) or any(alive(m.get('pid')) for m in members):
        raise ValueError('Run became active')
    return directories


def cleanup(roots, apply=False, cache=None, min_bytes=1024*1024):
    cache = cache if cache is not None else {}
    report = dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), apply=apply,
                  memory_before=memory(), eligible=[], skipped=[], linked=[], removed_temporaries=[],
                  checkpoint_paths_preserved=True, unique_checkpoints_deleted=0)
    groups = defaultdict(list); checkpoints = []; temporaries = []; held = []
    devices = {}
    try:
        for root in sorted(set(Path(p).absolute() for p in roots)):
            stack = ExitStack()
            try:
                directories = lock_stopped(root, stack)
                found = []; partial = []
                for directory in directories:
                    for path in directory.rglob('*.pt'):
                        if not regular(path): continue
                        info = path.stat()
                        if info.st_size < min_bytes: continue
                        key = (info.st_dev, info.st_size, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
                        found.append((key, path))
                    # These are incomplete files produced by atomic_checkpoint.
                    partial.extend(p for p in directory.rglob('*.pt.next') if regular(p))
                held.append(stack)
                report['eligible'].append(str(root))
                devices.setdefault(root.stat().st_dev, dict(path=str(root), free_before=shutil.disk_usage(root).free))
                for key, path in found:
                    checkpoints.append(path); groups[key].append(path)
                temporaries.extend(partial)
            except (ValueError, OSError, json.JSONDecodeError) as exc:
                stack.close()
                report['skipped'].append(dict(root=str(root), reason=str(exc)))
        for paths in groups.values():
            if len({(p.stat().st_dev, p.stat().st_ino) for p in paths}) < 2: continue
            matches = defaultdict(list)
            for path in sorted(paths, key=lambda p: (p.parts[-2:] != ('training', 'latest.pt'), str(p))):
                before = path.stat(); key = signature(before)
                if key not in cache:
                    digest = hashlib.sha256()
                    with path.open('rb') as source:
                        for block in iter(lambda: source.read(8*1024*1024), b''): digest.update(block)
                        if apply: advise(source.fileno())
                    if signature(path.stat()) != key:
                        report['skipped'].append(dict(path=str(path), reason='Changed while hashing'))
                        continue
                    cache[key] = digest.hexdigest()
                matches[cache[key]].append(path)
            for digest, identical in matches.items():
                canonical = identical[0]
                for path in identical[1:]:
                    original = path.stat(); source = canonical.stat()
                    if (source.st_dev, source.st_ino) == (original.st_dev, original.st_ino): continue
                    # ctime changes when links are added. The cache is refreshed below.
                    if cache.get(signature(original)) != digest or cache.get(signature(source)) != digest:
                        report['skipped'].append(dict(path=str(path), reason='Changed after hashing'))
                        continue
                    if apply:
                        staged = path.with_name(path.name + f'.maintenance-{os.getpid()}')
                        try:
                            os.link(canonical, staged)
                            os.replace(staged, path)
                        finally: staged.unlink(missing_ok=True)
                        cache[signature(canonical.stat())] = digest
                    report['linked'].append(dict(path=str(path), canonical=str(canonical),
                                                 bytes=original.st_size, sha256=digest))
        for path in temporaries:
            size = path.stat().st_size
            if apply: path.unlink()
            report['removed_temporaries'].append(dict(path=str(path), bytes=size))
        if apply:
            # Once per inode, including unique final checkpoints. This only drops
            # clean disk cache, not weights/optimizer memory owned by other jobs.
            advised = set()
            for path in checkpoints:
                info = path.stat(); inode = (info.st_dev, info.st_ino)
                if inode in advised: continue
                advised.add(inode)
                with path.open('rb') as source: advise(source.fileno())
            report['cache_advised_inodes'] = len(advised)
        report['filesystems'] = [row | dict(free_after=shutil.disk_usage(row['path']).free) for row in devices.values()]
        report['memory_after'] = memory()
        # Do not retain stale inode signatures forever in the daemon.
        live = {signature(p.stat()) for p in checkpoints}
        for key in list(cache):
            if key not in live: del cache[key]
        return report
    finally:
        for stack in reversed(held): stack.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, action='append', default=[], help='Discover tavern*/rl/runs/** managed group runs')
    parser.add_argument('--run', type=Path, action='append', default=[])
    parser.add_argument('--report-dir', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--interval', type=int, default=60)
    args = parser.parse_args()
    if not (args.base or args.run) or args.interval < 10: parser.error('Provide run/base paths and interval >= 10 seconds')
    args.report_dir.mkdir(parents=True, exist_ok=True)
    with (args.report_dir/'.watch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        cache = {}
        while True:
            try:
                result = cleanup(args.run + discover(args.base), args.apply, cache)
            except Exception as exc:
                result = dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), error=repr(exc))
            result['pid'] = os.getpid()
            temporary = args.report_dir/'latest.json.next'
            temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
            temporary.replace(args.report_dir/'latest.json')
            if result.get('linked') or result.get('removed_temporaries'):
                audit = args.report_dir/f"cleanup-{time.time_ns()}.json"
                audit.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
                for path in sorted(args.report_dir.glob('cleanup-*.json'))[:-100]: path.unlink()
            if not args.watch:
                print(json.dumps(result, ensure_ascii=False)); break
            time.sleep(args.interval)


if __name__ == '__main__': main()
