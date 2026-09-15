"""Public-state gold allocation rollouts and an auxiliary policy learning target.

PPO actions/log-probabilities are never replaced by search actions. Plans use
common random seeds, average complete recruit outcomes and a frozen critic.
"""
from dataclasses import asdict, dataclass
from collections import Counter
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import time
import numpy as np
import torch
from .bridge import ROOT, Simulator
from .features import prepare_entities
from .recruit_search import VERSION, position_key

SPENDING = {'buy', 'buySpell', 'upgrade', 'refresh'}


@dataclass(frozen=True)
class PlanningConfig:
    states: int = 32
    trials: int = 12
    depth: int = 32
    temperature: float = .15
    strength: float = .5
    epochs: int = 2
    min_gap: float = .02

    def __post_init__(self):
        for key, low, high in [('states',1,256),('trials',2,12),('depth',2,64),('epochs',1,4)]:
            v=getattr(self,key)
            if type(v) is not int or not low <= v <= high: raise ValueError(f'Invalid planning {key}')
        if not math.isfinite(self.temperature) or self.temperature <= 0: raise ValueError('Invalid planning temperature')
        if not math.isfinite(self.strength) or not 0 < self.strength <= 1: raise ValueError('Invalid planning strength')
        if not math.isfinite(self.min_gap) or self.min_gap < 0: raise ValueError('Invalid planning value gap')


def configure(config, args):
    enabled = args.gold_planning
    if enabled is None and 'TAVERN_GOLD_PLANNING' in os.environ:
        if os.environ['TAVERN_GOLD_PLANNING'] not in ('0','1'): raise ValueError('TAVERN_GOLD_PLANNING must be 0 or 1')
        enabled = os.environ['TAVERN_GOLD_PLANNING'] == '1'
    if enabled is False: config.pop('gold_planning',None)
    if enabled is True or config.get('gold_planning'):
        options = dict(config.get('gold_planning',{}))
        if args.planning_states is not None: options['states'] = args.planning_states
        trials = getattr(args,'planning_trials',None)
        if trials is None and 'TAVERN_PLANNING_TRIALS' in os.environ:
            trials = int(os.environ['TAVERN_PLANNING_TRIALS'])
        if trials is not None: options['trials'] = trials
        config['gold_planning'] = asdict(PlanningConfig(**options))


def add_arguments(parser):
    parser.add_argument('--gold-planning',action=argparse.BooleanOptionalAction,default=None)
    parser.add_argument('--planning-states',type=int,help='Public learner positions planned per PPO iteration')
    parser.add_argument('--planning-trials',type=int,help='Random outcomes per first action (2–12); overrides saved setting')


def capture(pool, game, seat, action_types, limit):
    """Bounded deterministic reservoir; never consumes the policy/game RNG."""
    state=game['state'];g=state['entities'][0]['details'];key=(seat,g['turn'])
    if key in game['planning_seen'] or g['gold'] < 1: return
    legal=state['legalActions']
    if not any(action_types[a] in SPENDING for a in legal): return
    game['planning_seen'].add(key)
    token=f"{game['seed']}:{seat}:{g['turn']}:{g['decisions']}"
    priority=hashlib.blake2b(token.encode(),digest_size=16).hexdigest()
    rows=pool.planning_examples
    if len(rows)>=limit and priority>=rows[-1]['priority']: return
    rows.append(dict(priority=priority,seed=game['seed'],seat=seat,turn=g['turn'],entities=state['entities'],
                     legal=list(legal),memory=game['memory'][seat].tolist(),previous=game['previous'][seat]))
    rows.sort(key=lambda r:r['priority']);del rows[limit:]


def root_actions(legal, probabilities, types):
    # Root coverage does not depend on the learned preference for freeze/move.
    selected=[0] if 0 in legal else []
    for kind, count in [('upgrade',1),('buy',2),('buySpell',1),('refresh',1),('play',1)]:
        selected += sorted((a for a in legal if types[a]==kind), key=lambda a:(-probabilities[a],a))[:count]
    return selected


def continuation(legal, probabilities, types):
    allowed=[a for a in legal if types[a]!='move']
    if any(types[a] in ('buy','buySpell') for a in allowed):
        allowed=[a for a in allowed if types[a]!='freeze']
    if not allowed: return None
    mass=Counter()
    for a in allowed: mass[types[a]]+=float(probabilities[a])
    kind=max(mass,key=lambda k:(mass[k],k))
    return max((a for a in allowed if types[a]==kind),key=lambda a:(probabilities[a],-a))


def targets_from_scores(scores, priors, config):
    # Incomplete branches do not become fake end states or weak negative labels.
    complete={a:values for a,values in scores.items() if len(values)==config.trials}
    if 0 not in complete or len(complete)<2: return None
    actions=sorted(complete);means=np.array([np.mean(complete[a]) for a in actions],dtype=np.float64)
    if not np.isfinite(means).all(): raise ValueError('Non-finite planning values')
    if np.ptp(means)<config.min_gap: return None
    logits=(means-means.max())/config.temperature;teacher=np.exp(logits);teacher/=teacher.sum()
    prior=np.array([priors[a] for a in actions],dtype=np.float64);prior/=prior.sum() if prior.sum()>0 else 1
    if prior.sum()==0: prior[:]=1/len(prior)
    target=(1-config.strength)*prior+config.strength*teacher
    return dict(actions=actions,target=target.tolist(),values=means.tolist(),prior=prior.tolist(),
                best=actions[int(means.argmax())],trials=config.trials)


class GoldPlanner:
    def __init__(self, model, meta, config, device, bundle=None):
        if not getattr(model,'recurrent',False) or model.observation_kind!='entities':
            raise ValueError('Gold planning requires a recurrent entity model')
        self.model,self.config,self.device=model,config,device
        self.types=[a['type'] for a in meta['actions']]
        self.simulator=Simulator(bundle or os.environ.get('TAVERN_PLANNING_BUNDLE',ROOT/'rl-dist/recruit-search.cjs'))
        try:
            raw=json.dumps(dict(actions=meta['actions'],entity_schema=meta['entitySchema']),ensure_ascii=False,separators=(',',':'))
            expected=dict(contract=hashlib.sha256(raw.encode()).hexdigest(),searchVersion=VERSION)
            if self.simulator.meta!=expected: raise ValueError('Planning simulator contract/version differs')
            probe=self.simulator.call('plan_open',roots=[],branches=[])
            if probe['version']!='gold-rollout-v1': raise ValueError('Planning simulator lacks batch support')
        except BaseException:
            self.close();raise

    def close(self):self.simulator.close()

    def evaluate(self, views, memories, previous):
        rows=[]
        with torch.inference_mode():
            for start in range(0,len(views),32):
                batch=views[start:start+32]
                mask=torch.zeros(len(batch),self.model.action_size,dtype=torch.bool,device=self.device)
                for i,v in enumerate(batch):mask[i,v['legal'] or [0]]=True
                dist,values,updated=self.model.act([prepare_entities(v['entities']) for v in batch],mask,
                    torch.tensor(np.asarray(memories[start:start+32]),dtype=torch.float32,device=self.device),
                    torch.tensor(previous[start:start+32],dtype=torch.long,device=self.device))
                probs=dist.probs.cpu().numpy();vals=values.cpu().numpy();mem=updated.cpu().numpy()
                for i,v in enumerate(batch):
                    if not math.isfinite(float(vals[i])):raise ValueError('Non-finite planning critic')
                    rows.append((probs[i],float(vals[i]),mem[i].copy()))
        return rows

    def plan(self, examples):
        from contextlib import nullcontext
        from .sampling_graphs import tower_graphs
        enabled=str(getattr(self,'device','cpu')).startswith('cuda') and os.environ.get('TAVERN_SAMPLING_GRAPHS','1')=='1'
        with tower_graphs([self.model],32) if enabled else nullcontext([]) as graphs:
            result=self._plan(examples)
            result[1]['cuda_graphs']=enabled
            result[1]['graph_replays']=sum(g.replays for g in graphs)
        return result

    def _plan(self, examples):
        started=time.monotonic();self.model.eval();labels=[]
        metrics=Counter(positions=len(examples),trials=self.config.trials);kinds=Counter();traces=[]
        # At most 96 branches, including all outcomes of up to 7 first actions per root.
        roots_per_batch=max(1,96//(7*self.config.trials))
        try:
            for offset in range(0,len(examples),roots_per_batch):
                group=examples[offset:offset+roots_per_batch]
                evaluations=self.evaluate(group,[r['memory'] for r in group],[r['previous'] for r in group])
                roots=[dict(entities=r['entities'],decisions=r['entities'][0]['details']['decisions'],budget=r['entities'][0]['details']['budget']) for r in group]
                requests=[];paths=[];scores=[{} for _ in group]
                for ri,(row,ev) in enumerate(zip(group,evaluations)):
                    actions=root_actions(row['legal'],ev[0],self.types)
                    for action in actions:
                        scores[ri][action]=[];kinds[self.types[action]]+=1
                        for trial in range(self.config.trials):
                            seed=int(hashlib.blake2b(f"{row['priority']}:{trial}".encode(),digest_size=4).hexdigest(),16)
                            requests.append(dict(root=ri,seed=seed))
                            paths.append(dict(root=ri,first=action,memory=ev[2],previous=action,seen=set(),actions=[action],coins=[]))
                opened=self.simulator.call('plan_open',roots=roots,branches=requests)['views']
                active=[];first=[]
                for index,(v,path) in enumerate(zip(opened,paths)):
                    if v is None or path['first'] not in v['legal']:metrics['unsupported_branches']+=1;continue
                    path['seen'].add(position_key(v));path['coins'].append(v['gold'])
                    active.append(index);first.append(dict(index=index,action=path['first']))
                views=self.simulator.call('plan_step',actions=first)
                for depth in range(self.config.depth):
                    if not active:break
                    values=self.evaluate(views,[paths[i]['memory'] for i in active],[paths[i]['previous'] for i in active])
                    metrics['evaluations']+=len(values);next_active=[];steps=[]
                    for index,view,ev in zip(active,views,values):
                        path=paths[index];path['coins'].append(view['gold']);metrics['simulated_steps']+=1
                        if view['ended'] or view.get('dead'):
                            value=-1. if view.get('dead') else ev[1]
                            scores[path['root']][path['first']].append(value);metrics['completed_routes']+=1
                            if len(traces)<24:traces.append(dict(turn=group[path['root']]['turn'],first=self.types[path['first']],
                                actions=[self.types[a] for a in path['actions']],coins=path['coins'],value=value))
                            continue
                        key=position_key(view)
                        if view.get('boundary') or not view['legal'] or key in path['seen'] or depth+1==self.config.depth:
                            metrics['cutoff_routes']+=1;continue
                        path['seen'].add(key)
                        action=continuation(view['legal'],ev[0],self.types)
                        if action is None:metrics['cutoff_routes']+=1;continue
                        path.update(memory=ev[2],previous=action);path['actions'].append(action)
                        next_active.append(index);steps.append(dict(index=index,action=action))
                    active=next_active
                    views=self.simulator.call('plan_step',actions=steps) if steps else []
                for row,ev,score in zip(group,evaluations,scores):
                    target=targets_from_scores(score,ev[0],self.config)
                    if target:labels.append(dict(row=row,**target))
                self.simulator.call('release')
        finally:self.simulator.call('release')
        metrics['labels']=len(labels)
        return labels,dict(metrics)|dict(seconds=time.monotonic()-started,root_candidates=dict(kinds),
                                         preferred=dict(Counter(self.types[x['best']] for x in labels))),traces


def teach(model, optimizer, labels, config, device):
    """Separate post-PPO conditional imitation loss; critic receives no fake returns."""
    if not labels:return dict(updates=0,states=0)
    options=PlanningConfig(**config['gold_planning']);model.train();losses=[];updates=0
    observations=[prepare_entities(x['row']['entities']) for x in labels]
    masks=torch.zeros(len(labels),model.action_size,dtype=torch.bool,device=device)
    for i,x in enumerate(labels):masks[i,x['row']['legal']]=True
    memory=torch.tensor(np.asarray([x['row']['memory'] for x in labels]),dtype=torch.float32,device=device)
    previous=torch.tensor([x['row']['previous'] for x in labels],dtype=torch.long,device=device)
    for _ in range(options.epochs):
        for start in range(0,len(labels),16):
            batch=labels[start:start+16]
            dist,_,_=model.act(observations[start:start+16],masks[start:start+16],memory[start:start+16],previous[start:start+16],with_value=False)
            terms=[]
            for i,x in enumerate(batch):
                logp=torch.log_softmax(dist.logits[i,x['actions']],dim=0)
                target=torch.tensor(x['target'],dtype=logp.dtype,device=device)
                terms.append(-(target*logp).sum())
            loss=torch.stack(terms).mean()
            if not torch.isfinite(loss):raise ValueError('Non-finite gold planning loss')
            optimizer.zero_grad(set_to_none=True);loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(),config['max_grad_norm'],error_if_nonfinite=True)
            optimizer.step();updates+=1;losses.append(float(loss.detach()))
    return dict(updates=updates,states=len(labels),loss=float(np.mean(losses)))
