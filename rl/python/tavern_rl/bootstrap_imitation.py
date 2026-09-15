"""Create fresh PPO state from the selected best human-imitation candidate."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import numpy as np
import torch
from .bridge import Simulator
from .hero_pool import load_hero_pool
from .model import make_model
from .train import atomic_checkpoint, cpu_weights, league_entry, trainer_hash
from .training_performance import make_optimizer


def bootstrap(candidate, output, meta, *, seed=42, learning_rate=3e-5, hero_pool=None):
    output=Path(output)
    if output.exists():raise FileExistsError(output)
    if not np.isfinite(learning_rate) or not 0<learning_rate<1:raise ValueError('Invalid learning rate')
    with Path(candidate).open('rb') as stream:
        source_sha=hashlib.file_digest(stream,'sha256').hexdigest();stream.seek(0)
        saved=torch.load(stream,map_location='cpu',weights_only=False)
    report=saved.get('report',{});spec=saved.get('model_spec',{})
    if saved.get('kind')!='fresh_human_imitation' or report.get('initialization')!='random':
        raise ValueError('Expected a fresh human-imitation candidate')
    if report.get('updates',0)<1 or report.get('bestEpoch',0)<1 or report['bestEpoch']!=report.get('epoch'):
        raise ValueError('Select best.pt from a completed validation epoch')
    contract=hashlib.sha256(json.dumps(dict(actions=meta['actions'],entity_schema=meta['entitySchema']),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    if meta['observationVersion']!=4 or report.get('contract')!=contract or spec.get('actions')!=meta['actions'] or spec.get('entity_schema')!=meta['entitySchema']:
        raise ValueError('Candidate and simulator contracts differ')
    torch.manual_seed(seed);np.random.seed(seed);random.seed(seed)
    model=make_model(spec);model.load_state_dict(saved['model'],strict=True);model.requires_grad_(True)
    if not all(torch.isfinite(t).all().item() for t in model.state_dict().values()):raise ValueError('Non-finite candidate')
    provenance=dict(source=str(Path(candidate).resolve()),artifactSha256=source_sha,bestEpoch=report['bestEpoch'],
                    bestValidationNll=report['bestValidationNll'],initialWeightSha256=report['initialWeightSha256'],
                    updates=report['updates'],datasets=report['datasets'],selfPlayEpisodes=0)
    config=dict(gamma=1.,gae_lambda=.95,clip=.2,value_coef=.5,entropy_coef=.01,target_kl=.03,max_grad_norm=.5,
                epochs=2,batch_size=256,sequence_length=16,burn_in=8,sequence_batch_size=32,learning_rate=learning_rate,
                seed=seed,learner_seats=4,first_place_bonus=1.,games_per_iteration=64,league_size=12,
                options=dict(maxActionsPerTurn=64,maxSteps=30000,recordFrames=False,aiActionLimits=True),
                reward_mode='placement_only',opponent_mode='self_history_only',external_opponent_fraction=.4,
                packed_host_transfer=False,fused_adam=True,training_graphs=True,freshImitation=provenance)
    if hero_pool is not None:config['hero_pool']=load_hero_pool(hero_pool,meta)
    optimizer=make_optimizer(model,config)
    assert not optimizer.state and all(p.requires_grad for p in model.parameters())
    league=[league_entry(model,0,anchor=True)]
    code_hash=trainer_hash()
    payload=dict(format=1,trainerHash=code_hash,meta=meta,model_spec=model.specification(),model=cpu_weights(model),
                 optimizer=optimizer.state_dict(),iteration=0,episodes=0,league=league,config=config,
                 torch_rng=torch.get_rng_state(),numpy_rng=np.random.get_state(),python_rng=random.getstate(),cuda_rng=None)
    output.mkdir(parents=True)
    atomic_checkpoint(output/'latest.pt',payload)
    manifest=dict(format=1,trainerHash=code_hash,meta={k:v for k,v in meta.items() if k not in ('actions','cardIds','heroIds','entitySchema')},
                  config=config,iteration=0,episodes=0,model_spec={k:v for k,v in spec.items() if k not in ('actions','entity_schema')},
                  league_generations=[0],device='cpu',parameters=sum(p.numel() for p in model.parameters()))
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return dict(sourceSha256=source_sha,output=str(output),depth=spec.get('policy_depth'),bestEpoch=report['bestEpoch'],
                episodes=0,optimizerStates=0,leagueSize=1,goldPlanning=False)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('candidate','output'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--learning-rate',type=float,default=3e-5)
    parser.add_argument('--hero-pool');args=parser.parse_args();torch.set_num_threads(1)
    with Simulator() as simulator:
        result=bootstrap(args.candidate,args.output,simulator.meta,learning_rate=args.learning_rate,hero_pool=args.hero_pool)
    print(json.dumps(result))


if __name__=='__main__':main()
