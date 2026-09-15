"""Install the sampling decorator into a frozen runtime without replacing it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil


def patch_source(source):
    if '    @accelerate_sampling\n    def collect(' in source:
        return source
    anchor = 'from .bridge import Simulator\n'
    method = '    def collect('
    if source.count(anchor) != 1 or source.count(method) != 1:
        raise ValueError('Unrecognized rollout source; no files changed')
    source = source.replace(anchor, anchor + 'from .sampling_graphs import accelerate_sampling\n', 1)
    source = source.replace(method, '    @accelerate_sampling\n' + method, 1)
    compile(source, 'rollout.py', 'exec')
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--module', required=True, type=Path)
    parser.add_argument('--backup', required=True, type=Path)
    args = parser.parse_args()
    path = args.package / 'rollout.py'
    before = path.read_text()
    after = patch_source(before)
    module = args.module.read_text()
    compile(module, 'sampling_graphs.py', 'exec')
    args.backup.mkdir(parents=True, exist_ok=False)
    shutil.copy2(path, args.backup / 'rollout.py')
    destination = args.package / 'sampling_graphs.py'
    if destination.exists():
        shutil.copy2(destination, args.backup / 'sampling_graphs.py')
    for target, content in [(destination, module), (path, after)]:
        temporary = target.with_suffix('.sampling-next')
        temporary.write_text(content)
        os.replace(temporary, target)
    report = dict(path=str(path), before_sha256=hashlib.sha256(before.encode()).hexdigest(),
                  after_sha256=hashlib.sha256(after.encode()).hexdigest())
    (args.backup / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
