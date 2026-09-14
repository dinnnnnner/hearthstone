"""Add explicit champion reward to a frozen PPO runtime and its stopped coordinator."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('Unexpected runtime source around: ' + old[:90])
    return text.replace(old, new, 1)


def prepare_edits(python_root, coordinator, bonus):
    package = Path(python_root)/'tavern_rl'
    train_path = package/'train.py'; rollout_path = package/'rollout.py'
    train = train_path.read_text(); rollout = rollout_path.read_text()
    train = replace_once(train, 'import argparse\n', 'import argparse\nfrom .placement_rewards import validate_bonus, resolve_bonus\n')
    train = replace_once(train, '    p.add_argument("--resume-learning-rate",',
        '    p.add_argument("--first-place-bonus", type=validate_bonus, help="Additional PPO reward for placement 1; omitted preserves saved value, legacy default 0")\n    p.add_argument("--resume-learning-rate",')
    train = replace_once(train, '                  "seed": args.seed, "learner_seats": args.learner_seats,',
        '                  "seed": args.seed, "learner_seats": args.learner_seats,\n                  "first_place_bonus": resolve_bonus({}, args.first_place_bonus),')
    line = '            config = dict(saved["config"])  # Resume the actual reward/action budget, not accidental CLI defaults.'
    train = replace_once(train, line, line+'\n            config["first_place_bonus"] = resolve_bonus(config, args.first_place_bonus)')
    train = replace_once(train, "                unused_gold_penalty=config[\"unused_gold_penalty\"],",
        '                unused_gold_penalty=config["unused_gold_penalty"], first_place_bonus=config["first_place_bonus"],')
    rollout = replace_once(rollout, 'from .bridge import Simulator\n',
        'from .bridge import Simulator\nfrom .placement_rewards import validate_bonus, reward_with_first_place_bonus\n')
    rollout = replace_once(rollout, 'hero_pool=None, packed_host_transfer=False):',
        'hero_pool=None, packed_host_transfer=False, first_place_bonus=0.):')
    rollout = replace_once(rollout, '        unused_gold_penalty = penalty_coefficient(unused_gold_penalty)',
        '        unused_gold_penalty = penalty_coefficient(unused_gold_penalty)\n        first_place_bonus = validate_bonus(first_place_bonus)')
    rollout = replace_once(rollout, '                                terminal = state["info"]["rewards"][seat]',
        '                                terminal = reward_with_first_place_bonus(state["info"]["rewards"][seat], ranks[seat], first_place_bonus)')
    rollout = replace_once(rollout, '"unused_gold_penalty_coefficient": unused_gold_penalty,',
        '"first_place_bonus": first_place_bonus, "unused_gold_penalty_coefficient": unused_gold_penalty,')
    path = Path(coordinator); coordinator_text = path.read_text()
    line = "        with (target/f'{stage}-{member[\"round\"]:04d}.log').open('a') as log:"
    coordinator_text = replace_once(coordinator_text, line,
        "        if stage=='training': command += ['--first-place-bonus', " + repr(str(bonus)) + "]\n" + line)
    edits = {train_path:train, rollout_path:rollout, path:coordinator_text}
    for path, source in edits.items(): compile(source, str(path), 'exec')
    return edits


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--python-root', required=True, type=Path)
    p.add_argument('--coordinator', required=True, type=Path)
    p.add_argument('--backup', required=True, type=Path)
    p.add_argument('--bonus', type=float, default=1.)
    args=p.parse_args()
    import math
    if not math.isfinite(args.bonus) or args.bonus<0:raise ValueError('Invalid bonus')
    edits=prepare_edits(args.python_root,args.coordinator,args.bonus)
    args.backup.mkdir(parents=True,exist_ok=False)
    report={'first_place_bonus':args.bonus,'files':[]}
    for path,source in edits.items():
        saved=args.backup/path.name;shutil.copy2(path,saved)
        temporary=path.with_suffix(path.suffix+'.bonus-next')
        temporary.write_text(source);os.replace(temporary,path)
        report['files'].append(dict(path=str(path),backup=str(saved),
            before_sha256=hashlib.sha256(saved.read_bytes()).hexdigest(),
            after_sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    (args.backup/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))


if __name__=='__main__':main()
