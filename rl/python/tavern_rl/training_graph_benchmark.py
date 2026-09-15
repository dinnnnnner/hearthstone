"""Compare full PPO updates on the same immutable complete trajectories."""
import argparse
import copy
import gc
import json
from pathlib import Path
import time
import torch
from .model import make_model, ppo_update
from .process_rollout import ProcessSimulationPool
from .sampling_benchmark import rollout_kwargs
from .training_performance import make_optimizer, optimized_update


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--games',type=int,default=16)
    p.add_argument('--processes',type=int,default=16)
    args=p.parse_args();torch.set_num_threads(1)
    args.output.mkdir(parents=True,exist_ok=True)
    saved=torch.load(args.checkpoint,map_location='cpu',weights_only=False)
    pool=ProcessSimulationPool(args.games,min(args.games,args.processes),args.checkpoint)
    try:
        tracks,games,performance=pool.collect(None,[],range(860000,860000+args.games),saved['config']['options'],
            'cuda',**rollout_kwargs(saved),progress=lambda row:print(json.dumps(row),flush=True))
    finally:pool.close()
    if any(g['truncated'] or not g['terminated'] for g in games):raise RuntimeError('Expected complete games')
    if not all(isinstance(reward,(float,int)) for _,reward in tracks):raise RuntimeError('Expected scalar terminal rewards')
    torch.save(dict(tracks=tracks,games=games),args.output/'trajectories.pt')
    report=dict(games=len(games),sampling=performance,rows=[])
    baseline=None
    for enabled in [False,True,False]:
        config=dict(saved['config'],sequence_batch_size=32,fused_adam=True,training_graphs=enabled)
        model=make_model(saved['model_spec']).cuda();model.load_state_dict(saved['model'])
        optimizer=make_optimizer(model,config,copy.deepcopy(saved['optimizer']))
        torch.manual_seed(912);torch.cuda.manual_seed_all(912)
        torch.cuda.synchronize();started=time.monotonic()
        metrics=optimized_update(ppo_update,model,optimizer,tracks,config,'cuda')
        torch.cuda.synchronize();elapsed=time.monotonic()-started
        weights={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
        if baseline is None:baseline=weights
        difference=max(float((v-baseline[k]).abs().max()) for k,v in weights.items() if v.is_floating_point())
        row=dict(graphs=enabled,seconds=elapsed,samples_per_second=metrics['samples']/elapsed,
                 max_weight_difference=difference,**metrics)
        report['rows'].append(row);(args.output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(row),flush=True)
        if difference>2e-5:raise RuntimeError('Graph PPO differs from eager baseline')
        del model,optimizer,weights;gc.collect();torch.cuda.empty_cache()


if __name__=='__main__':main()
