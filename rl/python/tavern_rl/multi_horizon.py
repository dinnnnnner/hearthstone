"""Horizon-conditioned combat and economic forecasts using exact continuations."""
import math
import os
from pathlib import Path
import torch
from torch import nn
VERSION='multi-horizon-v1'
HORIZONS=(1,3,5)
WEIGHTS=(.7,.2,.1)
TRIAL_CAPS=(12,8,4)
MODULES=('horizon_embedding','horizon_mix','horizon_economy','horizon_economy_target','horizon_economy_position','horizon_economy_fusion')
RESOURCE_FIELDS=('gold','tier','hand_count','board_count','free_refresh','spell_discount','next_gold','health_and_armor')


def enable(model,version=VERSION):
    if version!=VERSION or not hasattr(model,'scene_current'):raise ValueError('Multi-horizon model needs scene heads')
    if hasattr(model,'horizon_embedding'):return
    h=model.hidden
    with torch.random.fork_rng(devices=[]):
        embedding=nn.Embedding(3,h);mix=nn.Linear(h,3)
        economy=nn.Sequential(nn.Linear(2*h,h),nn.Tanh(),nn.Linear(h,8))
        target=nn.Linear(h,8,bias=False);position=nn.Embedding(int(model.action_positions.max())+1,8);fusion=nn.Linear(h,8)
        for layer in (embedding,mix,economy[-1],target,position,fusion):
            nn.init.zeros_(layer.weight)
            if getattr(layer,'bias',None) is not None:nn.init.zeros_(layer.bias)
    device=next(model.parameters()).device
    for name,layer in zip(MODULES,(embedding,mix,economy,target,position,fusion)):setattr(model,name,layer.to(device))


def configure(config,args,model):
    enabled=getattr(args,'multi_horizon',None)
    if enabled is None and 'TAVERN_MULTI_HORIZON' in os.environ:
        raw=os.environ['TAVERN_MULTI_HORIZON']
        if raw not in ('0','1'):raise ValueError('Invalid TAVERN_MULTI_HORIZON')
        enabled=raw=='1'
    if enabled is False and hasattr(model,'horizon_embedding'):raise ValueError('Cannot disable saved horizon architecture')
    if enabled is True or config.get('multi_horizon'):
        if not config.get('scene_value'):raise ValueError('Multi-horizon requires scene training')
        enable(model)
        path=os.environ.get('TAVERN_SCENE_REFERENCE_DIR') or config.get('multi_horizon',{}).get('reference_dir') or str(Path(args.output).resolve()/'scene-reference')
        config['multi_horizon']=dict(version=VERSION,horizons=list(HORIZONS),sampling_weights=list(WEIGHTS),trial_caps=list(TRIAL_CAPS),reference_dir=path)
        config['counterfactual']['terminal_fraction']=0.
    if hasattr(model,'horizon_embedding') and not config.get('multi_horizon'):raise ValueError('Missing horizon settings')


def choose(priority):
    from .counterfactual import digest
    fraction=digest(priority,'multi-horizon')/2**64
    return 1 if fraction<.7 else 3 if fraction<.9 else 5


def inputs(model,encoded,memory,horizon):
    index=HORIZONS.index(horizon);one,two=model.representatives_1,model.representatives_2
    context=memory+model.horizon_embedding.weight[index]
    source=encoded[:,model.source_slots[one]]+model.source_index(model.action_sources[one])+model.type_embedding(model.action_types[one])
    target=encoded[:,model.target_slots[two]]+model.target_index(model.action_targets[two])
    return torch.cat((context[:,None].expand(-1,len(one),-1),source),-1),target


def economic_predictions(model,encoded,memory,horizon):
    source,target=inputs(model,encoded,memory,horizon)
    raw=model.horizon_economy(source)[:,model.prefix_1]+model.horizon_economy_target(target)[:,model.prefix_2]+model.horizon_economy_position(model.action_positions)[None]
    return nn.functional.softplus(raw)


def resources(player):
    game=player['game'];season=game['season']
    if player.get('left') or game['health']<=0:return [0.]*8
    values=[game['gold'],game['tier'],len(game['hand']),len(game['board']),season.get('freeRefresh',0),season.get('spellDiscount',0),season.get('nextGold',0),max(0,game['health'])+season.get('armor',0)]
    return [math.log1p(max(0,v)) for v in values]


def adjustment(model,encoded,memory):
    from .scene_value import raw_predictions,physical
    now,base=raw_predictions(model,encoded,memory);now=physical(now).detach();base=physical(base).detach()
    weights=(model.horizon_mix(memory)+memory.new_tensor(WEIGHTS).log()).softmax(-1)
    coefficients=model.scene_fusion(memory)[:,None]
    def score(future):
        delta=future-now[:,None]
        features=torch.cat((delta,delta*now[:,None]),-1)
        return (torch.tanh(features)*coefficients).sum(-1)/math.sqrt(12)
    baseline=score(base);result=baseline
    economy_weights=model.horizon_economy_fusion(memory)[:,None]
    for i,horizon in enumerate(HORIZONS):
        _,future=raw_predictions(model,encoded,memory,horizon=horizon)
        # Residual formulation gives exact old probabilities on migration.
        result=result+weights[:,i,None]*(score(physical(future).detach())-baseline)
        economic=economic_predictions(model,encoded,memory,horizon).detach()
        result=result+weights[:,i,None]*(torch.tanh(economic/4)*economy_weights).sum(-1)/math.sqrt(8)
    return result
