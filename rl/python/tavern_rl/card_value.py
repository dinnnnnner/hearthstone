"""Contextual minion cash equivalents, calibrated with isolated resource swaps.

Interventions are auxiliary comparisons, never legal actions or PPO trajectories.
The scalar is a policy/horizon-dependent estimate, not an intrinsic card price.
"""
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
import math
import os
import numpy as np
import torch
from torch import nn
from .features import prepare_entities

VERSION='card-cash-v1'
DEFAULTS=dict(fraction=.25,loss_coef=.1,cash=[0,1,2,3,4,6,8,12],min_signal=.02)


def enable(model,version=VERSION):
    if version!=VERSION or not getattr(model,'recurrent',False):raise ValueError('Unsupported card value model')
    if hasattr(model,'card_value_head'):return
    with torch.random.fork_rng(devices=[]):
        head=nn.Sequential(nn.Linear(2*model.hidden,model.hidden),nn.Tanh(),nn.Linear(model.hidden,1))
        nn.init.zeros_(head[-1].weight);nn.init.zeros_(head[-1].bias)
        projection=nn.Linear(1,model.hidden,bias=False);nn.init.zeros_(projection.weight)
        type_head=nn.Linear(3,len(model.types),bias=False);nn.init.zeros_(type_head.weight)
    model.card_value_head=head.to(next(model.parameters()).device)
    model.card_value_projection=projection.to(next(model.parameters()).device)
    model.card_value_type=type_head.to(next(model.parameters()).device)
    model.register_buffer('card_value_actions',torch.tensor([a['type'] in ('buy','sell','play') for a in model.actions],
        device=next(model.parameters()).device),persistent=False)
    for kind in ('buy','sell','play'):
        model.register_buffer('card_value_'+kind,torch.tensor([i for i,a in enumerate(model.actions) if a['type']==kind],
            dtype=torch.long,device=next(model.parameters()).device),persistent=False)


def configure(config,args,model):
    enabled=getattr(args,'card_value',None)
    if enabled is None and 'TAVERN_CARD_VALUE' in os.environ:
        raw=os.environ['TAVERN_CARD_VALUE']
        if raw not in ('0','1'):raise ValueError('Invalid TAVERN_CARD_VALUE')
        enabled=raw=='1'
    if enabled is False:config.pop('card_value',None)
    if enabled is True or config.get('card_value'):
        if not config.get('streaming') or not config.get('counterfactual'):raise ValueError('Card values require streaming counterfactual training')
        options=dict(config.get('card_value',deepcopy(DEFAULTS)))
        if not 0<options['fraction']<=1 or not 0<options['loss_coef']<=1:raise ValueError('Invalid card value weights')
        cash=options['cash']
        if cash!=sorted(set(cash)) or len(cash)<3 or cash[0]!=0 or any(type(x)is not int or not 0<=x<=20 for x in cash):raise ValueError('Invalid calibration cash grid')
        if not math.isfinite(options['min_signal']) or options['min_signal']<=0:raise ValueError('Invalid calibration signal')
        config['card_value']=options;enable(model)


def predictions(model,encoded,memory):
    return model.card_value_head(torch.cat([encoded,memory[:,None].expand_as(encoded)],-1)).squeeze(-1)


def make_probe(root,meta,options):
    from .counterfactual import digest
    if digest(root['priority'],'card-value')/2**64>=options['fraction']:return None
    source=root['snapshot'];game=source['room']['seats'][root['seat']]['game']
    # Do not edit cards referred to by an unresolved choice.
    st=game['season']
    if game.get('discovery') or st.get('powerChoice') or st.get('trinketOffers'):return None
    buys={meta['actions'][a]['source']:a for a in root['legal'] if meta['actions'][a]['type']=='buy'}
    zones={}
    for slot,entity in enumerate(root['entities']):
        if not entity or entity['zone'] not in (1,2,4):continue
        if meta['entitySchema']['definitions'][str(entity['id'])].get('kind')!='minion':continue
        if entity['zone']==2 and entity['position'] not in buys:continue
        cost=float(entity['details']['buyCost']) if entity['zone']==2 else 0.
        balance=float(game['gold'])-cost
        limit=min(options['cash'][-1],math.floor(st['maxGold']-balance))
        if balance<0 or limit<2:continue
        zones.setdefault(entity['zone'],[]).append((slot,entity,cost,balance,limit))
    if not zones:return None
    zone=min(zones,key=lambda z:digest(root['priority'],'zone',z))
    slot,entity,cost,balance,limit=min(zones[zone],key=lambda row:digest(root['priority'],'card',row[0]))
    cash=[x for x in options['cash'] if x<=limit]
    if cash[-1]!=limit:cash.append(limit)
    cash_snapshot=deepcopy(source);room=cash_snapshot['room'];owned=room['seats'][root['seat']]['game']
    collection={1:'board',2:'shop',4:'hand'}[zone]
    removed=owned[collection].pop(entity['position'])
    # Same finite-pool release as the engine, without selling or triggering effects.
    # This arm asks how much cash replaces ownership; the retained arm may sell
    # normally and gets all real sell triggers. Never add a sale reward by hand.
    for identity,count in removed['copies'].items():room['pool'][identity]=room['pool'].get(identity,0)+count
    for player in room['seats']:
        if player.get('game'):player['game']['pool']=room['pool']
    variants={0:dict(snapshot=source,action=buys[entity['position']] if zone==2 else None)}
    for index,amount in enumerate(cash,1):
        saved=deepcopy(cash_snapshot);saved['room']['seats'][root['seat']]['game']['gold']=balance+amount
        variants[index]=dict(snapshot=saved,action=None)
    probe=dict(root,calibration=True,variants=variants,actions=list(variants),priors=[1/len(variants)]*len(variants),
        descriptors=[dict(type='keep_or_buy_card'),*[dict(type='cash_replacement',gold=k) for k in cash]])
    probe['card_probe']=dict(slot=slot,zone=zone,position=entity['position'],card_id=meta['entitySchema']['ids'][entity['id']-1],
        buy_cost=cost,cash=cash,cash_balance=balance,unit='gold_equivalent',mode='purchase' if zone==2 else 'remaining_ownership')
    return probe


def isotonic(values):
    """Equal-weight nondecreasing least-squares fit, pool adjacent violators."""
    blocks=[]
    for value in values:
        blocks.append([float(value),1])
        while len(blocks)>1 and blocks[-2][0]>blocks[-1][0]:
            b=blocks.pop();a=blocks.pop();n=a[1]+b[1];blocks.append([(a[0]*a[1]+b[0]*b[1])/n,n])
    return np.asarray([v for v,n in blocks for _ in range(n)])


def calibrate(outcomes,cash,min_signal):
    if set(outcomes)!=set(range(len(cash)+1)):return None
    rows=list(outcomes.values())
    if not rows or len(rows[0])<4 or any(len(r)!=len(rows[0]) or any(x is None for x in r) for r in rows):return None
    values=np.asarray([outcomes[k] for k in range(len(cash)+1)],dtype=np.float64)
    if not np.isfinite(values).all():raise ValueError('Non-finite cash comparison')
    differences=values[1:]-values[0]
    raw=differences.mean(1);errors=differences.std(1,ddof=1)/math.sqrt(values.shape[1]);fit=isotonic(raw)
    if np.max(np.abs(fit))<min_signal:return None  # flat critic cannot price a card
    if np.max(np.abs(raw-fit))>min_signal+2*errors.max():return None
    if fit[0]>=0:target=float(cash[0]);bound='upper'
    elif fit[-1]<=0:target=float(cash[-1]);bound='lower'
    else:
        upper=int(np.flatnonzero(fit>=0)[0]);lower=upper-1
        span=fit[upper]-fit[lower]
        if span<min_signal:return None
        target=float(cash[lower]+(cash[upper]-cash[lower])*(-fit[lower])/span);bound='point'
    return dict(gold=target,bound=bound,weight=float(1/(1+errors.max()/min_signal)),cash=cash,
        cash_minus_card=raw.tolist(),fitted_differences=fit.tolist(),paired_standard_errors=errors.tolist(),trials=values.shape[1])


def evaluate(pool,models,device,branch_options,bonus,options,progress=None):
    from .counterfactual import evaluate_batched
    probes=[p for r in pool.branch_roots if (p:=make_probe(r,pool.meta,options)) is not None]
    if not probes:return [],[],dict(probes=0,labels=0,branches=0,seconds=0.)
    temporary=SimpleNamespace(meta=pool.meta,branch_roots=probes,simulators=pool.simulators)
    # At least four paired runs. Same adaptive budget as ordinary comparisons.
    opts=replace(branch_options,min_trials=max(4,branch_options.min_trials),trials=max(4,branch_options.trials),terminal_fraction=0.)
    _,reports,metrics=evaluate_batched(temporary,models,device,opts,bonus,progress)
    labels=[]
    with torch.inference_mode():
        model=models[-1];model.eval()
        obs=[prepare_entities(p['entities']) for p in probes]
        if getattr(model,'remote',False):
            estimates=model.card_predictions(obs,[p['memory'] for p in probes],[p['previous'] for p in probes]).tolist()
        else:
            encoded=model.encode(obs,device)
            memory=model.recurrent_step(encoded,torch.tensor(np.asarray([p['memory'] for p in probes]),device=device,dtype=torch.float32),
                torch.tensor([p['previous'] for p in probes],device=device))
            estimates=predictions(model,encoded,memory).cpu().tolist()
    for i,(probe,report) in enumerate(zip(probes,reports)):
        target=calibrate(report['outcomes'],probe['card_probe']['cash'],options['min_signal'])
        report.update(card=probe['card_probe'],calibration=target,predicted_gold=estimates[i][probe['card_probe']['slot']])
        if target:labels.append(dict(row={k:probe[k] for k in ('entities','memory','previous')},slot=probe['card_probe']['slot'],**target))
    return labels,reports,dict(metrics,probes=len(probes),labels=len(labels))


def teach(model,optimizer,labels,config,device):
    if not labels:return dict(updates=0,cards=0)
    model.train();losses=[]
    for start in range(0,len(labels),16):
        batch=labels[start:start+16];encoded=model.encode([prepare_entities(x['row']['entities']) for x in batch],device)
        memory=model.recurrent_step(encoded,torch.tensor(np.asarray([x['row']['memory'] for x in batch]),device=device,dtype=torch.float32),
            torch.tensor([x['row']['previous'] for x in batch],device=device))
        values=predictions(model,encoded,memory)[torch.arange(len(batch),device=device),[x['slot'] for x in batch]]
        target=torch.tensor([x['gold'] for x in batch],device=device,dtype=values.dtype)
        error=values-target
        # Censored prices teach bounds, never pretend a capped grid found the price.
        error=torch.stack([error[i].clamp_max(0) if x['bound']=='lower' else error[i].clamp_min(0) if x['bound']=='upper' else error[i] for i,x in enumerate(batch)])
        weights=torch.tensor([x['weight'] for x in batch],device=device)
        loss=(nn.functional.smooth_l1_loss(error,torch.zeros_like(error),reduction='none')*weights).mean()*config['card_value']['loss_coef']
        if not torch.isfinite(loss):raise ValueError('Non-finite card value loss')
        optimizer.zero_grad(set_to_none=True);loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(),config['max_grad_norm'],error_if_nonfinite=True);optimizer.step()
        losses.append(float(loss.detach()))
    return dict(updates=len(losses),cards=len(labels),loss=float(np.mean(losses)))
