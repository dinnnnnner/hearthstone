"""Install explicit PPO batch/fused-Adam settings into the stopped frozen runtime."""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError('Unrecognized source near ' + before[:80])
    return source.replace(before, after, 1)


def patch_train(source):
    if 'from .training_performance import' in source:
        return patch_graph_train(patch_process_train(remove_gold_train(source)))
    source = replace_once(source, '    return p\n',
        '    from .training_performance import add_arguments\n    add_arguments(p)\n    return p\n')
    source = replace_once(source,
        '        optimizer = torch.optim.Adam(model.parameters(), lr=config["learning_rate"], eps=1e-5)\n'
        '        if saved:\n'
        '            optimizer.load_state_dict(saved["optimizer"])\n'
        "            for group in optimizer.param_groups: group['lr'] = config['learning_rate']",
        '        from .training_performance import apply_overrides, make_optimizer\n'
        '        apply_overrides(config, args)\n'
        '        optimizer = make_optimizer(model, config, saved["optimizer"] if saved else None)')
    compile(source, 'train.py', 'exec')
    return patch_graph_train(patch_process_train(remove_gold_train(source)))


def patch_graph_train(source):
    if 'metrics = optimized_update(' in source:return source
    return replace_once(source,'            metrics = ppo_update(model, optimizer, tracks, config, args.device)',
        '            from .training_performance import optimized_update\n'
        '            metrics = optimized_update(ppo_update, model, optimizer, tracks, config, args.device)')


def patch_process_train(source):
    if 'pool = make_pool(args, output)' in source:return source
    source=replace_once(source,'    pool = SimulationPool(args.workers)',
        '    from .training_performance import make_pool\n    pool = make_pool(args, output)')
    source=source.replace('opponents = frozen_models(league, model.specification(), rollout_device)',
        'opponents = [] if args.sampling_processes > 1 else frozen_models(league, model.specification(), rollout_device)')
    source=source.replace('len(pool.simulators),','getattr(pool, "worker_count", len(pool.simulators)),')
    compile(source,'train.py','exec')
    return source


def remove_gold_train(source):
    source = re.sub(r'^from \.rewards import .*\n', '', source, flags=re.M)
    source = re.sub(r'^    p\.add_argument\("--unused-gold-penalty".*\n', '', source, flags=re.M)
    source = re.sub(r'^\s*"unused_gold_penalty": .*\n', '\n', source, flags=re.M)
    source = re.sub(r"^            config\['unused_gold_penalty'\] = .*\n",
                    "            config.pop('unused_gold_penalty', None)\n", source, flags=re.M)
    source = source.replace('unused_gold_penalty=config["unused_gold_penalty"],', '')
    compile(source, 'train.py', 'exec')
    return source


def remove_gold_coordinator(source):
    source = source.replace('from tavern_rl.rewards import penalty_coefficient\n', '')
    source = re.sub(r"^    p\.add_argument\('--unused-gold-penalty'.*\n", '', source, flags=re.M)
    source = source.replace('unused_gold_penalty=args.unused_gold_penalty,', '')
    source = source.replace("        if stage=='training' and args.unused_gold_penalty is not None:\n"
                            "            command += ['--unused-gold-penalty',args.unused_gold_penalty]\n", '')
    if 'unused_gold_penalty' in source:
        raise ValueError('Unexpected remaining gold-penalty coordinator code')
    compile(source, 'population_resume.py', 'exec')
    return source


def patch_rollout(source):
    if 'step_rewards' not in source:
        if 'unused_gold_penalty' in source: raise ValueError('Partial gold penalty removal')
        return source
    source = source.replace('from .rewards import penalty_coefficient, unused_gold_reward, trajectory_rewards\n', '')
    source = source.replace(', unused_gold_penalty=0.0', '')
    source = source.replace('        unused_gold_penalty = penalty_coefficient(unused_gold_penalty)\n', '')
    source = source.replace('        penalty_total = 0.; penalized_ends = 0\n', '')
    source = source.replace(', "step_rewards": [[] for _ in range(8)]', '')
    source = re.sub(r'^                            reward = unused_gold_reward.*\n', '', source, flags=re.M)
    source = source.replace("                            game['step_rewards'][seat].append(reward)\n", '')
    source = source.replace('                            penalty_total -= reward; penalized_ends += int(reward < 0)\n', '')
    source = source.replace("                                rewards = trajectory_rewards(game['step_rewards'][seat], terminal) if unused_gold_penalty else terminal\n", '')
    source = source.replace('tracks.append((records, rewards))', 'tracks.append((records, terminal))')
    source = source.replace('"unused_gold_penalty_coefficient": unused_gold_penalty, "unused_gold_penalty_total": penalty_total, "unused_gold_penalized_ends": penalized_ends,', '')
    if any(word in source for word in ['unused_gold_penalty','step_rewards','penalty_total','trajectory_rewards']):
        raise ValueError('Unexpected remaining gold-penalty sampler code')
    compile(source, 'rollout.py', 'exec')
    return source


def patch_coordinator(source):
    if "p.add_argument('--sequence-batch-size'" in source:
        return patch_graph_coordinator(patch_process_coordinator(remove_gold_coordinator(source)))
    source = replace_once(source, '    args=p.parse_args()',
        "    p.add_argument('--sequence-batch-size',type=int)\n"
        "    p.add_argument('--fused-adam',action=argparse.BooleanOptionalAction,default=None)\n"
        '    args=p.parse_args()\n'
        "    if args.sequence_batch_size is not None and args.sequence_batch_size < 1: raise ValueError('Invalid sequence batch size')")
    source = replace_once(source, "        if stage=='training': command += ['--first-place-bonus', '1.0']",
        "        if stage=='training': command += ['--first-place-bonus', '1.0']\n"
        "        if stage=='training' and args.sequence_batch_size is not None:\n"
        "            command += ['--resume-sequence-batch-size',args.sequence_batch_size]\n"
        "        if stage=='training' and args.fused_adam is not None:\n"
        "            command += ['--fused-adam' if args.fused_adam else '--no-fused-adam']")
    compile(source, 'population_resume.py', 'exec')
    return patch_graph_coordinator(patch_process_coordinator(remove_gold_coordinator(source)))


def patch_graph_coordinator(source):
    if "p.add_argument('--training-graphs'" in source:return source
    source=replace_once(source,'    args=p.parse_args()',
        "    p.add_argument('--training-graphs',action=argparse.BooleanOptionalAction,default=None)\n    args=p.parse_args()")
    return replace_once(source,"        if stage=='training' and args.fused_adam is not None:",
        "        if stage=='training' and args.training_graphs is not None:\n"
        "            command += ['--training-graphs' if args.training_graphs else '--no-training-graphs']\n"
        "        if stage=='training' and args.fused_adam is not None:")


def patch_process_coordinator(source):
    if "p.add_argument('--sampling-processes'" in source:return source
    source=replace_once(source,'    args=p.parse_args()',
        "    p.add_argument('--sampling-processes',type=int,default=1)\n    args=p.parse_args()\n"
        "    if not 1 <= args.sampling_processes <= args.workers: raise ValueError('Invalid sampling process count')")
    source=replace_once(source,"        if stage=='training': command += ['--first-place-bonus', '1.0']",
        "        if stage=='training': command += ['--first-place-bonus', '1.0', '--sampling-processes',str(args.sampling_processes)]")
    compile(source,'coordinator.py','exec')
    return source


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--coordinator', type=Path, required=True)
    p.add_argument('--population', type=Path, required=True)
    p.add_argument('--module', type=Path, required=True)
    p.add_argument('--process-module', type=Path, help='Defaults to process_rollout.py beside --module')
    p.add_argument('--backup', type=Path, required=True)
    args = p.parse_args()
    modules = [args.module, args.process_module or args.module.with_name('process_rollout.py'),
               args.module.with_name('training_graphs.py')]
    for module in modules:
        compile(module.read_text(), str(module), 'exec')
    with (args.population / '.population.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads((args.population / 'status.json').read_text())
        if state['stage'] not in ('interrupted', 'time_limit') or any(m['pid'] for m in state['members']):
            raise RuntimeError('Stop training before changing its runtime')
        changes = [(args.runtime/'train.py', patch_train), (args.runtime/'rollout.py', patch_rollout),
                   (args.coordinator, patch_coordinator)]
        prepared = [(path, path.read_text(), patch(path.read_text())) for path, patch in changes]
        args.backup.mkdir(parents=True, exist_ok=False)
        report = []
        for module, name in zip(modules, ['training_performance.py', 'process_rollout.py', 'training_graphs.py']):
            if module.resolve() != (args.runtime/name).resolve():
                shutil.copy2(module, args.runtime/name)
        for path, before, after in prepared:
            (args.backup/path.name).write_text(before)
            temporary = path.with_suffix('.performance-next')
            temporary.write_text(after); temporary.replace(path)
            report.append(dict(path=str(path), before=hashlib.sha256(before.encode()).hexdigest(),
                               after=hashlib.sha256(after.encode()).hexdigest()))
        (args.backup/'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report))


if __name__ == '__main__':
    main()
