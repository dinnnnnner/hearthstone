"""Compare PPO batches on identical complete trajectories without saving trained weights."""
import argparse
import copy
import cProfile
import gc
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import torch

from .model import make_model, ppo_update
from .rollout import SimulationPool
from .train import load_checkpoint, frozen_models
from .sampling_benchmark import rollout_kwargs
from .training_performance import make_optimizer


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--games', type=int, default=8)
    p.add_argument('--workers', type=int, default=8)
    args = p.parse_args()
    if min(args.games, args.workers) < 1:
        p.error('Positive game and worker counts required')
    torch.set_num_threads(1)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    pool = SimulationPool(args.workers)
    try:
        with args.checkpoint.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
            source.seek(0)
            saved, actor = load_checkpoint(source, pool.meta, 'cuda')
        config = dict(saved['config'])
        config.pop('unused_gold_penalty', None)
        opponents = frozen_models(saved['league'], actor.specification(), 'cuda')
        profile = cProfile.Profile()
        profile.enable()
        tracks, games, perf = pool.collect(actor, opponents, range(840000,840000+args.games),
            config['options'], 'cuda', **rollout_kwargs(saved),
            progress=lambda row: print(json.dumps(row),flush=True))
        profile.disable()
        profile.dump_stats(str(args.output.with_suffix('.profile')))
        perf['cpu_profile_enabled'] = True
        if any(g['truncated'] or not g['terminated'] for g in games):
            raise RuntimeError('PPO benchmark requires complete games')
        if not all(isinstance(reward,(int,float)) for _,reward in tracks):
            raise RuntimeError('Placement-only PPO must receive scalar terminal rewards')
    finally:
        pool.close()
    del actor, opponents
    gc.collect();torch.cuda.empty_cache()
    report = dict(checkpoint_sha256=digest, games=len(games), sampling=perf, reward_mode='placement_only',
                  note='Identical complete trajectories, two epochs retained, no trained weights saved.', rows=[])
    args.output.parent.mkdir(parents=True,exist_ok=True)
    baseline_weights = None
    for size, fused in [(16,False),(16,True),(32,True),(64,True),(16,False)]:
        model = make_model(saved['model_spec']).cuda()
        model.load_state_dict(saved['model'])
        run_config = dict(config, sequence_batch_size=size, fused_adam=fused)
        optimizer = make_optimizer(model,run_config,copy.deepcopy(saved['optimizer']))
        assert all(bool(g['fused']) == fused for g in optimizer.param_groups)
        torch.manual_seed(830000)
        torch.cuda.synchronize();torch.cuda.reset_peak_memory_stats()
        started = time.monotonic()
        metrics = ppo_update(model,optimizer,tracks,run_config,'cuda')
        torch.cuda.synchronize()
        elapsed = time.monotonic()-started
        if not all(np.isfinite(v) for v in metrics.values()) or metrics['kl_early_stop']:
            raise RuntimeError('PPO numerical validation failed: '+str(metrics))
        if not all(torch.isfinite(p).all() for p in model.parameters()):
            raise RuntimeError('Non-finite parameters')
        row = dict(sequence_batch_size=size,fused_adam=fused,seconds=elapsed,
                   samples_per_second=metrics['samples']/elapsed,metrics=metrics,
                   cuda_peak_mib=torch.cuda.max_memory_allocated()/2**20)
        if baseline_weights is None:
            baseline_weights = {k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
        elif size == 16:
            row['max_weight_difference_from_baseline'] = max(
                float((v.detach().cpu()-baseline_weights[k]).abs().max())
                for k,v in model.state_dict().items() if v.is_floating_point())
        report['rows'].append(row)
        args.output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(row),flush=True)
        del model,optimizer
        gc.collect();torch.cuda.empty_cache()


if __name__ == '__main__':
    main()
