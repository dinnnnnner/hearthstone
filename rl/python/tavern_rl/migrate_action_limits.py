"""Explicit, one-way migrations of full PPO checkpoints between audited AI rules.

Only the audited source/rules pair is accepted. Ordinary checkpoint loading
remains strict. The input is never overwritten; callers must stop training.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import numpy as np
import torch
from .bridge import Simulator
from .train import atomic_checkpoint, load_checkpoint, trainer_hash

OLD_SOURCE = '9074e697a84044483b109afa0900472cba382fbdeca99dfb01c70ef1396bb0ad'
OLD_RULES = '9fc789d8e455716068ae811eef6634c35e6d4c8be2401ce5085f1b1081ac47fc'
NEW_SOURCE = 'c7fce93ab131753b8ecf18706a3d6b2b755e3d96f2b7ba6b1d20a164a1aa7bf9'
NEW_RULES = '0adb3881ea81239a3af909b2af96b77a519251e439f590cc6785303819452c2f'
FREEZE_SOURCE = 'eeb18693f226474c80c6cc31da8830d5ec1642551366d70456c7f5d85ccf33b1'
FREEZE_RULES = 'bd04e443dcad24651378e33f4c3a30847b798f15173307504c88d34c6c064a4c'


def migrate(saved, meta, source_sha256):
    required = {'meta', 'model_spec', 'model', 'optimizer', 'league', 'config',
                'episodes', 'iteration', 'torch_rng', 'numpy_rng', 'python_rng'}
    if not required <= saved.keys():
        raise ValueError('Migration requires a full PPO checkpoint')
    old = saved['meta']
    pair = (old.get('sourceHash'), old.get('rulesHash'), meta.get('sourceHash'), meta.get('rulesHash'))
    if pair == (OLD_SOURCE, OLD_RULES, NEW_SOURCE, NEW_RULES):
        limits, kind = dict(version=1, freezes=2, moves=6), 'ai-action-limits-v1'
    elif pair == (NEW_SOURCE, NEW_RULES, FREEZE_SOURCE, FREEZE_RULES):
        if old.get('aiActionLimits') != dict(version=1, freezes=2, moves=6):
            raise ValueError('Source freeze rules differ')
        limits, kind = dict(version=2, freezes=1, moves=6, freezePolicy='unaffordable-at-end'), 'ai-freeze-close-v2'
    else:
        raise ValueError('Source/target is not an audited AI rule transition')
    if meta.get('aiActionLimits') != limits:
        raise ValueError('Unexpected action limits')
    changed = {k for k in old.keys() | meta.keys() if old.get(k) != meta.get(k)}
    if changed != {'sourceHash', 'rulesHash', 'aiActionLimits'}:
        raise ValueError('Other simulator metadata changed; review a separate migration')
    spec = saved['model_spec']
    if spec.get('entity_schema') != meta['entitySchema'] or spec.get('actions') != meta['actions']:
        raise ValueError('Network observation/action definitions differ')
    for entry in saved['league']:
        opponent = entry.get('model_spec', spec)
        if opponent.get('entity_schema') != meta['entitySchema'] or opponent.get('actions') != meta['actions']:
            raise ValueError('Historical opponent has a different observation/action schema')
    record = dict(kind=kind, utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  sourceSha256=source_sha256, oldSourceHash=old['sourceHash'], oldRulesHash=old['rulesHash'],
                  sourceHash=meta['sourceHash'], rulesHash=meta['rulesHash'],
                  episodes=saved['episodes'], iteration=saved['iteration'],
                  retained='model, optimizer, frozen league, counters and RNG; fresh rollouts required')
    config = saved['config'] | {
        'options': saved['config']['options'] | {'aiActionLimits': True},
        'rule_migrations': [*saved['config'].get('rule_migrations', []), record],
    }
    return saved | {'meta': meta, 'config': config, 'trainerHash': trainer_hash()}


def retained_digest(saved):
    digest = hashlib.sha256()
    def visit(value):
        digest.update(type(value).__name__.encode() + b'\0')
        if isinstance(value, torch.Tensor):
            visit(value.detach().cpu().numpy())
        elif isinstance(value, np.ndarray):
            digest.update(str(value.dtype).encode()); digest.update(str(value.shape).encode())
            digest.update(value.tobytes())
        elif isinstance(value, dict):
            for key in sorted(value, key=repr): visit(key); visit(value[key])
        elif isinstance(value, (list, tuple)):
            for item in value: visit(item)
        elif value is None or isinstance(value, (str, int, float, bool)):
            digest.update(repr(value).encode())
        else:
            raise TypeError(f'Unsupported checkpoint value: {type(value)}')
    visit({k: v for k, v in saved.items() if k not in ('meta', 'config', 'trainerHash')})
    return digest.hexdigest()


def sha256(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path, help='New checkpoint file; must not exist')
    parser.add_argument('--bundle', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.source.resolve() == args.output.resolve():
        parser.error('Output must be a new file; preserve the source checkpoint')
    torch.set_num_threads(1)
    with Simulator(args.bundle) as simulator: meta = simulator.meta
    source_sha = sha256(args.source)
    saved = torch.load(args.source, map_location='cpu', weights_only=False)
    retained = retained_digest(saved)
    migrated = migrate(saved, meta, source_sha)
    atomic_checkpoint(args.output, migrated)
    del saved, migrated
    restored, model = load_checkpoint(args.output, meta)
    if retained_digest(restored) != retained:
        raise RuntimeError('Migrated checkpoint did not preserve training state')
    if sha256(args.source) != source_sha:
        raise RuntimeError('Source changed during migration; do not activate the output')
    report = dict(source=str(args.source.resolve()), output=str(args.output.resolve()),
                  sourceSha256=source_sha, outputSha256=sha256(args.output), retainedStateSha256=retained,
                  episodes=restored['episodes'], iteration=restored['iteration'],
                  depth=model.specification().get('policy_depth'), migration=restored['config']['rule_migrations'][-1])
    args.output.with_suffix('.migration.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
