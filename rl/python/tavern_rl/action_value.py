"""Soft action-value decisions with a policy-preserving migration.

Q(s,a) = V(s) + A(s,a) - E_pi[A(s,a)], pi = softmax(A / temperature).
Old conditional scores initialize A; new residual heads learn return differences.
Both real trajectories and paired continuations supervise Q in reward units.
"""
import math
import os
import numpy as np
import torch
from torch import nn
from .features import prepare_entities
VERSION='soft-q-v1'


def enable(model,settings=None):
    settings=dict(settings or dict(version=VERSION,temperature=.2))
    if settings.get('version')!=VERSION or not math.isfinite(settings.get('temperature',0)) or not .01<=settings['temperature']<=2:
        raise ValueError('Invalid action-value specification')
    if not getattr(model,'recurrent',False):raise ValueError('Action values require recurrent entities')
    if hasattr(model,'action_value_type'):
        if model.action_value_settings!=settings:raise ValueError('Cannot silently change action-value temperature')
        return
    with torch.random.fork_rng(devices=[]):
        kind=nn.Linear(model.hidden,len(model.types));source=nn.Linear(model.hidden,model.hidden)
        for layer in (kind,source):nn.init.zeros_(layer.weight);nn.init.zeros_(layer.bias)
    device=next(model.parameters()).device
    model.action_value_type=kind.to(device);model.action_value_source=source.to(device)
    model.action_value_settings=settings


def configure(config,args,model):
    enabled=getattr(args,'action_value',None)
    if enabled is None and 'TAVERN_ACTION_VALUE' in os.environ:
        raw=os.environ['TAVERN_ACTION_VALUE']
        if raw not in ('0','1'):raise ValueError('Invalid TAVERN_ACTION_VALUE')
        enabled=raw=='1'
    if enabled is False and hasattr(model,'action_value_type'):raise ValueError('Action-value checkpoints cannot resume as PPO policies')
    if enabled is True or config.get('action_value'):
        if not config.get('streaming') or not config.get('counterfactual'):raise ValueError('Action values require streaming comparisons')
        options=dict(config.get('action_value',dict(version=VERSION,temperature=.2)))
        enable(model,options);config['action_value']=options
    if hasattr(model,'action_value_type') and not config.get('action_value'):raise ValueError('Missing action-value training configuration')


def from_advantage(advantage,value,legal,temperature):
    dist=torch.distributions.Categorical(logits=(advantage/temperature).masked_fill(~legal,-1e9))
    # Detaching the centering weights avoids a self-referential regression target;
    # the numerical identity E_pi[Q]=V still holds for every forward pass.
    center=(dist.probs.detach()*advantage.masked_fill(~legal,0.)).sum(-1,keepdim=True)
    q=(value[:,None]+advantage-center).masked_fill(~legal,-1e9) if value is not None else None
    return dist,q


def teach(model,optimizer,labels,config,device):
    if not labels:return dict(updates=0,states=0,training_mode='action_value_regression')
    model.train();losses=[];actions=0;scene_losses=[];scene_states=0;scene_actions=0;economic_actions=0
    for start in range(0,len(labels),16):
        batch=labels[start:start+16]
        mask=torch.zeros(len(batch),model.action_size,dtype=torch.bool,device=device)
        for i,row in enumerate(batch):mask[i,row['row']['legal']]=True
        encoded=model.encode([prepare_entities(x['row']['entities']) for x in batch],device)
        memory=model.recurrent_step(encoded,torch.tensor(np.asarray([x['row']['memory'] for x in batch]),dtype=torch.float32,device=device),
            torch.tensor([x['row']['previous'] for x in batch],device=device))
        _,_,q=model.distribution_from(encoded,memory,mask,with_action_values=True)
        terms=[]
        for i,row in enumerate(batch):
            target=torch.tensor(row['values'],dtype=q.dtype,device=device)
            errors=torch.tensor(row['paired_standard_errors'],dtype=q.dtype,device=device)
            weights=1/(1+errors/.05)
            terms.append((nn.functional.smooth_l1_loss(q[i,row['actions']],target,reduction='none')*weights).mean())
            actions+=len(row['actions'])
        loss=torch.stack(terms).mean()
        if config.get('scene_value'):
            from .scene_value import supervision
            scene_loss,counts=supervision(model,encoded,memory,batch,device)
            loss=loss+config['scene_value']['loss_coef']*scene_loss
            scene_losses.append(float(scene_loss.detach()));scene_states+=counts['states'];scene_actions+=counts['actions'];economic_actions+=counts['economic_actions']
        if not torch.isfinite(loss):raise ValueError('Non-finite branch action-value loss')
        optimizer.zero_grad(set_to_none=True);loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(),config['max_grad_norm'],error_if_nonfinite=True);optimizer.step()
        losses.append(float(loss.detach()))
    return dict(updates=len(losses),states=len(labels),actions=actions,loss=float(np.mean(losses)),training_mode='action_value_regression',
        **(dict(scene_loss=float(np.mean(scene_losses)),scene_states=scene_states,scene_actions=scene_actions,economic_actions=economic_actions) if scene_losses else {}))
