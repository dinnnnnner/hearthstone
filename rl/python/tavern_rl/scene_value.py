"""Current and action-conditioned future combat quality, independently supervised."""
from copy import deepcopy
import math
import os
import numpy as np
import torch
from torch import nn
from .bridge import Simulator,ROOT
from .features import prepare_entities
VERSION='combat-benchmark-v1'
DEFAULTS=dict(opponents=3,trials=4,loss_coef=.1)
MODULES=('scene_current','scene_successor','scene_target','scene_position','scene_fusion')


def enable(model,version=VERSION):
    if version!=VERSION or not hasattr(model,'action_value_type'):raise ValueError('Scene heads require soft action values')
    if hasattr(model,'scene_current'):return
    h=model.hidden
    with torch.random.fork_rng(devices=[]):
        current=nn.Sequential(nn.Linear(h,h),nn.Tanh(),nn.Linear(h,6))
        future=nn.Sequential(nn.Linear(2*h,h),nn.Tanh(),nn.Linear(h,6))
        target=nn.Linear(h,6,bias=False);position=nn.Embedding(int(model.action_positions.max())+1,6)
        fusion=nn.Linear(h,12)
        for layer in (current[-1],future[-1],target,position,fusion):
            nn.init.zeros_(layer.weight)
            if getattr(layer,'bias',None) is not None:nn.init.zeros_(layer.bias)
    device=next(model.parameters()).device
    for name,layer in zip(MODULES,(current,future,target,position,fusion)):setattr(model,name,layer.to(device))


def configure(config,args,model):
    enabled=getattr(args,'scene_value',None)
    if enabled is None and 'TAVERN_SCENE_VALUE' in os.environ:
        raw=os.environ['TAVERN_SCENE_VALUE']
        if raw not in ('0','1'):raise ValueError('Invalid TAVERN_SCENE_VALUE')
        enabled=raw=='1'
    if enabled is False and hasattr(model,'scene_current'):raise ValueError('Cannot disable saved scene architecture')
    if enabled is True or config.get('scene_value'):
        if not config.get('streaming') or not config.get('action_value') or not config.get('counterfactual'):raise ValueError('Scene training requires streaming action-value comparisons')
        settings=dict(config.get('scene_value',DEFAULTS))
        if settings!=DEFAULTS:raise ValueError('Unsupported scene benchmark settings')
        enable(model);config['scene_value']=settings
    if hasattr(model,'scene_current') and not config.get('scene_value'):raise ValueError('Missing scene training settings')


def physical(raw):
    return torch.cat((raw[...,:3].softmax(-1),nn.functional.softplus(raw[...,3:5]),raw[...,5:].sigmoid()),-1)


def raw_predictions(model,encoded,memory,horizon=None):
    one,two=model.representatives_1,model.representatives_2
    # Exactly the action identity: type, source, target and board position.
    source=encoded[:,model.source_slots[one]]+model.source_index(model.action_sources[one])+model.type_embedding(model.action_types[one])
    target=encoded[:,model.target_slots[two]]+model.target_index(model.action_targets[two])
    context=memory
    if horizon is not None:
        from .multi_horizon import HORIZONS
        context=memory+model.horizon_embedding.weight[HORIZONS.index(horizon)]
    unique=model.scene_successor(torch.cat((context[:,None].expand(-1,len(one),-1),source),-1))
    future=unique[:,model.prefix_1]+model.scene_target(target)[:,model.prefix_2]+model.scene_position(model.action_positions)[None]
    return model.scene_current(memory),future


def adjustment(model,encoded,memory):
    if hasattr(model,'horizon_embedding'):
        from .multi_horizon import adjustment as multiscale
        return multiscale(model,encoded,memory)
    now,future=raw_predictions(model,encoded,memory)
    now=physical(now).detach();future=physical(future).detach()
    # No fixed combat bonus: contextual weights learn from actual action returns.
    delta=future-now[:,None]
    # Current quality must interact with action-dependent changes: adding the
    # same current-state score to all actions would cancel during Q centering.
    features=torch.cat((delta,delta*now[:,None]),-1)
    return (torch.tanh(features)*model.scene_fusion(memory)[:,None]).sum(-1)/math.sqrt(12)


def loss(raw,target):
    return -(target[...,:3]*raw[...,:3].log_softmax(-1)).sum(-1).mean()+nn.functional.smooth_l1_loss(nn.functional.softplus(raw[...,3:5]),target[...,3:5])+nn.functional.binary_cross_entropy_with_logits(raw[...,5],target[...,5])


def supervision(model,encoded,memory,labels,device):
    now,base=raw_predictions(model,encoded,memory);terms=[];states=0;actions=0;economic_actions=0;cache={};economy={}
    for i,label in enumerate(labels):
        scene=label.get('scene')
        if not scene:continue
        if scene['current'] is not None:
            terms.append(loss(now[i:i+1],torch.tensor([scene['current']],dtype=now.dtype,device=device)));states+=1
        horizon=scene.get('horizon')
        future=base
        if horizon is not None:
            if horizon not in cache:cache[horizon]=raw_predictions(model,encoded,memory,horizon=horizon)[1]
            future=cache[horizon]
        if scene['future'] is not None:
            terms.append(loss(future[i,label['actions']],torch.tensor(scene['future'],dtype=now.dtype,device=device)));actions+=len(label['actions'])
        if 'resources' in scene:
            from .multi_horizon import economic_predictions
            if horizon not in economy:economy[horizon]=economic_predictions(model,encoded,memory,horizon)
            terms.append(nn.functional.smooth_l1_loss(economy[horizon][i,label['actions']],torch.tensor(scene['resources'],dtype=now.dtype,device=device)))
            economic_actions+=len(label['actions'])
    leaves=[leaf for label in labels for leaf in label.get('scene',{}).get('leaves',[])]
    if leaves:
        e=model.encode([prepare_entities(r['entities']) for r in leaves],device)
        h=model.recurrent_step(e,torch.tensor(np.asarray([r['memory'] for r in leaves]),dtype=torch.float32,device=device),torch.tensor([r['previous'] for r in leaves],device=device))
        terms.append(loss(model.scene_current(h),torch.tensor([r['target'] for r in leaves],dtype=now.dtype,device=device)));states+=len(leaves)
    return (torch.stack(terms).mean() if terms else now.sum()*0),dict(states=states,actions=actions,economic_actions=economic_actions)


class Benchmark:
    def __init__(self,root):
        self.options=root['scene_value'];self.root=root;self.multi=bool(root.get('multi_horizon'));self.missing=0
        self.sim=Simulator(ROOT/'rl-dist/scene-evaluation.cjs')
        if self.sim.meta.get('version')!=VERSION or self.sim.meta.get('sourceHash')!=root['snapshot']['sourceHash']:self.sim.close();raise ValueError('Scene evaluator version mismatch')
        seats=root['snapshot']['room']['seats'];seat=root['seat']
        from .counterfactual import digest
        ids=[i for i,p in enumerate(seats) if i!=seat and not p.get('left') and p['game']['health']>0]
        ids.sort(key=lambda i:digest(root['priority'],'scene-opponent',i))
        self.ids=ids[:self.options['opponents']]
        self.enemies=[deepcopy(seats[i]['game']) for i in self.ids]
        self.panels={}
        if self.multi:
            from .reference_pool import ReferencePool
            pool=ReferencePool(root['multi_horizon']['reference_dir'],root['snapshot']['sourceHash'])
            # Freeze both panels before any candidate branches run.
            for turn in (root['turn'],root['turn']+root['horizon']):
                self.panels[turn]=pool.panel(turn,root['seed'],root['priority'],self.options['opponents'])
        try:self.current=self.measure(root['snapshot'],0,current=True)
        except BaseException:self.sim.close();raise
        self.battles=self.current['battles']
        self.futures={a:[] for a in root['actions']};self.economy={a:[] for a in root['actions']};self.leaves=[]
    def measure(self,snapshot,trial,current=False):
        from .counterfactual import digest
        player=snapshot['room']['seats'][self.root['seat']]
        own=deepcopy(player['game']);own['pool']=snapshot['room']['pool']
        if player.get('left') or own['health']<=0:return dict(target=[0.,1.,0.,0.,0.,1.],battles=0)
        enemies=self.enemies
        if self.multi:
            turn=self.root['turn']+(0 if current else self.root['horizon'])
            panel=self.panels[turn]
            if snapshot['room']['turn']!=turn or not panel:
                self.missing+=1
                return dict(target=None,battles=0)
            enemies=[row['game'] for row in panel]
        if not enemies:raise ValueError('No scene reference opponents')
        return self.sim.call('evaluate',game=own,opponents=enemies,seed=digest(self.root['priority'],'scene',trial)&0xffffffff,trials=self.options['trials'])
    def observe(self,simulator,branch,leaf=None):
        snapshot=simulator.call('snapshot');measured=self.measure(snapshot,branch['trial'])
        self.battles+=measured['battles'];self.futures[branch['action']].append((branch['trial'],measured['target']))
        if self.multi:
            from .multi_horizon import resources
            self.economy[branch['action']].append(resources(snapshot['room']['seats'][self.root['seat']]))
        if leaf is not None and branch['trial']==0 and measured['target'] is not None:self.leaves.append(dict(leaf,target=measured['target']))
    def label(self,count):
        if any(len(rows)!=count or sorted(i for i,_ in rows)!=list(range(count)) for rows in self.futures.values()):return None
        future=None if any(v is None for rows in self.futures.values() for _,v in rows) else [np.mean([v for _,v in self.futures[a]],axis=0).tolist() for a in self.root['actions']]
        result=dict(current=self.current['target'],future=future,
            leaves=self.leaves,opponent_seats=self.ids,battles=self.battles,trials=count,combat_trials=self.options['trials'])
        if self.multi:
            result.pop('opponent_seats')
            result.update(horizon=self.root['horizon'],resources=[np.mean(self.economy[a],axis=0).tolist() for a in self.root['actions']],
                reference_panels={str(t):[r['key'] for r in rows] for t,rows in self.panels.items()},reference_missing=self.missing)
        return result
    def close(self):self.sim.close()
