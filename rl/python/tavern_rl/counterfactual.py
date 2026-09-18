"""Sparse, paired continuations from exact eight-seat training snapshots.

Full games remain on-policy PPO data. Branches only teach a conditional policy
comparison; bootstrap estimates never become invented placements or PPO returns.
"""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import asdict, dataclass
import argparse
import hashlib
import math
import os
import time
from types import SimpleNamespace

import numpy as np
import torch

from .features import prepare_entities
from .placement_rewards import reward_with_first_place_bonus


def digest(*parts):
    return int.from_bytes(hashlib.blake2b(':'.join(map(str, parts)).encode(), digest_size=8).digest(), 'big')


@dataclass(frozen=True)
class BranchConfig:
    roots: int = 1                 # per sampling process / iteration
    trials: int = 12
    min_trials: int = 4
    candidates: int = 8
    workers: int = 16             # branch inference batch / sampling process
    horizon: int = 2              # recruit turns, measured from the root
    terminal_fraction: float = .25
    max_steps: int = 6000         # per branch; cutoffs never receive labels
    temperature: float = .2
    strength: float = .25
    min_gap: float = .02
    epochs: int = 1

    def __post_init__(self):
        for name, low, high in [('roots',1,16),('trials',2,64),('min_trials',2,64),('candidates',4,16),('workers',1,64),('horizon',1,8),('max_steps',1,30000),('epochs',1,4)]:
            value=getattr(self,name)
            if type(value) is not int or not low <= value <= high:raise ValueError(f'Invalid branch {name}')
        for name, low, high in [('terminal_fraction',0.,1.),('temperature',.001,10.),('strength',.001,1.),('min_gap',0.,2.)]:
            value=getattr(self,name)
            if not math.isfinite(value) or not low <= value <= high:raise ValueError(f'Invalid branch {name}')


def add_arguments(parser):
    parser.add_argument('--counterfactual',action=argparse.BooleanOptionalAction,default=None,
                        help='Full-game PPO plus sparse comparisons from exact saved positions')
    for name in ('roots','trials','min_trials','candidates','workers','horizon','max_steps'):
        parser.add_argument('--branch-'+name.replace('_','-'),type=int,default=None)
    parser.add_argument('--branch-terminal-fraction',type=float,default=None)


def configure(config,args):
    enabled=getattr(args,'counterfactual',None)
    if enabled is None and 'TAVERN_COUNTERFACTUAL' in os.environ:
        value=os.environ['TAVERN_COUNTERFACTUAL']
        if value not in ('0','1'):raise ValueError('Invalid TAVERN_COUNTERFACTUAL')
        enabled=value=='1'
    if enabled is False:config.pop('counterfactual',None)
    if enabled is True or config.get('counterfactual'):
        options=dict(config.get('counterfactual',{}))
        for name in ('roots','trials','min_trials','candidates','workers','horizon','max_steps','terminal_fraction'):
            value=getattr(args,'branch_'+name,None)
            if value is not None:options[name]=value
        config['counterfactual']=asdict(BranchConfig(**options))
        # A branch comparison supplements on-policy PPO. A forced search action
        # cannot be relabelled as a PPO sample from the network's distribution.
        config.pop('gold_planning',None)
        config.pop('stage_feedback',None)
        config['reward_mode']='placement_only'
        if config.get('gamma',1.)!=1.:raise ValueError('Counterfactual outcome comparisons currently require gamma=1')


def candidates(legal, probabilities, types, key, limit):
    selected=[]
    for kind in ('end','upgrade','refresh','buy','sell','buySpell','play'):
        group=[a for a in legal if types[a]==kind]
        if group:selected.append(max(group,key=lambda a:(probabilities[a],-a)))
    # Rotate omitted cards independently of the policy prior. Low-prior cards
    # and sales can therefore enter future comparisons; not every root covers all.
    remaining=[a for a in legal if types[a] in ('buy','sell','buySpell','play') and a not in selected]
    remaining.sort(key=lambda a:digest(key,a))
    return (selected+remaining)[:limit]


def capture(pool, game, seat, probabilities, options):
    state=game['state'];details=state['entities'][0]['details']
    # A refreshed shop in the middle of a turn is a new decision opportunity.
    key=(seat,details['turn'],details['decisions'])
    if key in game['branch_seen']:return
    types=[a['type'] for a in pool.meta['actions']]
    if not any(types[a] in ('buy','buySpell','upgrade','refresh','sell') for a in state['legalActions']):return
    game['branch_seen'].add(key)
    priority=digest(game['seed'],seat,details['turn'],details['decisions'])
    rows=pool.branch_roots
    if len(rows)>=options.roots and priority>=rows[-1]['priority']:return
    actions=candidates(state['legalActions'],probabilities,types,priority,options.candidates)
    if len(actions)<2:return
    # Called before *any* seat's memory in this inference batch is advanced.
    rows.append(dict(priority=priority,seed=game['seed'],seat=seat,turn=details['turn'],
        tier_tempo=deepcopy(game.get('tier_tempo')),
        action_values=game.get('action_values',False),scene_value=deepcopy(game.get('scene_value')),
        multi_horizon=deepcopy(game.get('multi_horizon')),
        snapshot=pool.simulators[game['worker']].call('snapshot'),
        memories=deepcopy(game['memory']),previous_all=list(game['previous']),controllers=list(game['controllers']),
        actions=actions,priors=[float(probabilities[a]) for a in actions],
        entities=deepcopy(state['entities']),legal=list(state['legalActions']),
        memory=game['memory'][seat].tolist(),previous=game['previous'][seat]))
    if game.get('multi_horizon'):
        from .multi_horizon import choose
        rows[-1]['horizon']=choose(priority)
    rows.sort(key=lambda r:r['priority']);del rows[options.roots:]


def targets(row, outcomes, options):
    actions=row['actions']
    # Require every paired trial for every candidate. Dropping a failed candidate
    # could systematically favour plans that end early or are cheaper to simulate.
    count=len(outcomes[actions[0]])
    if count<min(options.min_trials,options.trials) or any(len(outcomes[a])!=count or any(v is None for v in outcomes[a]) for a in actions):return None
    values=np.asarray([outcomes[a] for a in actions],dtype=np.float64)
    if not np.isfinite(values).all():raise ValueError('Non-finite branch outcomes')
    means=values.mean(1)
    if np.ptp(means)<options.min_gap and not row.get('action_values'):return None
    best=int(means.argmax());baseline=int(np.argmax(row['priors']))
    # Keep most of the frozen prior: bootstrap scores are estimates, not proof
    # of a better action. Standard errors are reported, not confidence gates.
    teacher=np.exp((means-means.max())/options.temperature);teacher/=teacher.sum()
    prior=np.asarray(row['priors'],dtype=np.float64);prior=prior/prior.sum() if prior.sum()>0 else np.full(len(actions),1/len(actions))
    target=(1-options.strength)*prior+options.strength*teacher
    paired=values-values[baseline]
    return dict(row={k:row[k] for k in ('entities','legal','memory','previous','turn')},
        actions=actions,target=target.tolist(),values=means.tolist(),best=actions[best],
        sample_counts=[count]*len(actions),baseline=actions[baseline],
        paired_advantages=paired.mean(1).tolist(),
        paired_standard_errors=(paired.std(1,ddof=1)/math.sqrt(count)).tolist())


def needs_more(outcomes,options):
    if any(any(x is None for x in values) for values in outcomes.values()):return False
    values=np.asarray(list(outcomes.values()),dtype=np.float64)
    means=values.mean(1);best=int(means.argmax());diff=values[best]-values
    errors=diff.std(1,ddof=1)/math.sqrt(values.shape[1])
    if np.ptp(means)<options.min_gap and errors.max()<options.min_gap/2:return False
    # A compute-budget heuristic, not an anytime-valid confidence guarantee.
    return any(means[best]-means[i]<=options.min_gap+2*errors[i] for i in range(len(means)) if i!=best)


def evaluate(pool, models, device, options, first_place_bonus, progress=None):
    from contextlib import ExitStack
    with ExitStack() as resources:
        return _evaluate(pool,models,device,options,first_place_bonus,progress,resources)


def legal_action_mask(legal_actions, action_count, device):
    """Build the whole batch on the host before one transfer to the device."""
    mask = np.zeros((len(legal_actions), action_count), dtype=np.bool_)
    for index, actions in enumerate(legal_actions):
        mask[index, actions] = True
    return torch.as_tensor(mask, device=device)


def _evaluate(pool, models, device, options, first_place_bonus, progress, resources):
    """Reuse idle sampler workers after the real games; batch all branch inference."""
    from .rollout import policy_sample
    from .streaming import tier_tempo_reward
    started=time.monotonic();last=started;steps=0;completed=0;cutoffs=0
    labels=[];reports=[];bootstrap=0;terminal=0;scene_battles=0;scene_roots=0
    for model in models.values():model.eval()
    base_options=options;horizon_counts={f'horizon_{h}_roots':0 for h in (1,3,5)};reference_missing=0
    for root in pool.branch_roots:
        options=base_options
        if root.get('multi_horizon') and not root.get('calibration'):
            from dataclasses import replace
            from .multi_horizon import HORIZONS,TRIAL_CAPS
            horizon=root['horizon'];horizon_counts[f'horizon_{horizon}_roots']+=1
            options=replace(base_options,horizon=horizon,trials=min(base_options.trials,TRIAL_CAPS[HORIZONS.index(horizon)]),terminal_fraction=0.)
        benchmark=None
        if root.get('scene_value') and not root.get('calibration'):
            from .scene_value import Benchmark
            benchmark=Benchmark(root);resources.callback(benchmark.close)
            scene_roots+=1
        complete=digest(root['priority'],'horizon')/2**64 < options.terminal_fraction
        trial_limit=min(options.min_trials,options.trials)
        jobs=[(action,trial) for trial in range(trial_limit) for action in root['actions']]
        outcomes={a:[None]*options.trials for a in root['actions']}
        tempo_rewards={a:[0.]*options.trials for a in root['actions']}
        active={};cursor=0
        def assign(worker):
            nonlocal cursor
            action,trial=jobs[cursor];cursor+=1
            variant=root.get('variants',{}).get(action)
            forced=variant['action'] if variant is not None else action
            saved=deepcopy(variant['snapshot'] if variant is not None else root['snapshot'])
            # Preserve the full current state; resample only the unknown future.
            # The same seed is paired across alternatives, not revealed to a policy.
            saved['rng']=digest(root['priority'],'environment',trial)&0xffffffff
            state=pool.simulators[worker].call('restore',snapshot=saved)
            if state['actor']!=root['seat'] or forced is not None and forced not in state['legalActions']:raise ValueError('Branch root changed')
            active[worker]=dict(state=state,action=action,forced=forced,trial=trial,first=True,steps=0,tempo_reward=0.,
                memory=deepcopy(root['memories']),previous=list(root['previous_all']),
                rng=[np.random.default_rng(digest(root['priority'],'policy',trial,seat)) for seat in range(8)])
        for worker in range(min(len(pool.simulators),len(jobs))):assign(worker)
        while active:
            groups=defaultdict(list)
            for worker,branch in list(active.items()):
                state=branch['state'];place=state['info']['placements'][root['seat']]
                if place is not None:
                    if benchmark:benchmark.observe(pool.simulators[worker],branch)
                    outcomes[branch['action']][branch['trial']]=branch['tempo_reward']+reward_with_first_place_bonus(state['info']['rewards'][root['seat']],place,first_place_bonus)
                    terminal+=1;completed+=1;del active[worker]
                    if cursor<len(jobs):assign(worker)
                    continue
                if state['truncated'] or branch['steps']>=options.max_steps:
                    cutoffs+=1;completed+=1;del active[worker]
                    if cursor<len(jobs):assign(worker)
                    continue
                if state['actor'] is None:raise ValueError('Branch ended without learner placement')
                groups[root['controllers'][state['actor']]].append(worker)
            futures={}
            with torch.inference_mode():
                for controller,workers in groups.items():
                    model=models[controller]
                    seats=[active[w]['state']['actor'] for w in workers]
                    mask=legal_action_mask([active[w]['state']['legalActions'] for w in workers],
                                           pool.meta['actionCount'],device)
                    observations=[prepare_entities(active[w]['state']['entities']) for w in workers]
                    memories=torch.tensor(np.asarray([active[w]['memory'][s] for w,s in zip(workers,seats)]),dtype=torch.float32,device=device)
                    previous=torch.tensor([active[w]['previous'][s] for w,s in zip(workers,seats)],device=device)
                    draws=[active[w]['rng'][seat].random() for w,seat in zip(workers,seats)]
                    actions,_,values,updated,_=policy_sample(model,observations,mask,memories,previous,draws,with_value=True,log_probs=False)
                    for i,(w,seat) in enumerate(zip(workers,seats)):
                        branch=active[w];state=branch['state']
                        if not complete and not branch['first'] and seat==root['seat'] and state['info']['turn']>=root['turn']+options.horizon:
                            if benchmark:
                                benchmark.observe(pool.simulators[w],branch,dict(entities=deepcopy(state['entities']),memory=branch['memory'][seat].tolist(),previous=branch['previous'][seat]))
                            value=float(values[i])
                            if not math.isfinite(value):raise ValueError('Non-finite branch bootstrap')
                            outcomes[branch['action']][branch['trial']]=value+branch['tempo_reward']
                            bootstrap+=1;completed+=1;del active[w]
                            if cursor<len(jobs):assign(w)
                            continue
                        action=branch['forced'] if branch['first'] and branch['forced'] is not None else int(actions[i])
                        branch['first']=False;branch['memory'][seat]=updated[i].copy();branch['previous'][seat]=action
                        futures[w]=pool.executor.submit(pool.simulators[w].step,action)
            for w,future in futures.items():
                branch=active[w];before=branch['state'];state=future.result();tempo=root.get('tier_tempo')
                if tempo and before['info']['turn']==tempo['turn'] and (state['terminated'] or state['info']['turn']!=before['info']['turn']):
                    player=pool.simulators[w].call('snapshot')['room']['seats'][root['seat']]
                    branch['tempo_reward']+=tier_tempo_reward(player,before['info']['turn'],tempo)
                    tempo_rewards[branch['action']][branch['trial']]=branch['tempo_reward']
                branch['state']=state;branch['steps']+=1;steps+=1
            if not active and trial_limit<options.trials and needs_more({a:v[:trial_limit] for a,v in outcomes.items()},options):
                next_limit=min(options.trials,trial_limit+options.min_trials)
                jobs.extend((action,trial) for trial in range(trial_limit,next_limit) for action in root['actions'])
                trial_limit=next_limit
                for worker in range(min(len(pool.simulators),len(jobs)-cursor)):assign(worker)
            if progress and time.monotonic()-last>=30:
                progress(dict(stage='counterfactual',branch_actions=steps,branch_completed=completed,branch_cutoffs=cutoffs,seconds=time.monotonic()-started));last=time.monotonic()
        outcomes={a:v[:trial_limit] for a,v in outcomes.items()}
        label=None if root.get('calibration') else targets(root,outcomes,options)
        if benchmark:
            scene=benchmark.label(trial_limit);scene_battles+=benchmark.battles
            reference_missing+=getattr(benchmark,'missing',0)
            if label and scene:label['scene']=scene
        if label:labels.append(label)
        reports.append(dict(seed=root['seed'],seat=root['seat'],turn=root['turn'],gold=root['entities'][0]['details']['gold'],
            horizon='terminal' if complete else options.horizon,trials_used=trial_limit,actions=root['actions'],
            action_descriptors=root.get('descriptors') or [pool.meta['actions'][a] for a in root['actions']],
            outcomes=outcomes,label=({k:v for k,v in label.items() if k not in ('row','scene')} | ({'scene':{k:v for k,v in label['scene'].items() if k!='leaves'}} if 'scene' in label else {})) if label else None,
            tier_tempo=root.get('tier_tempo'),tempo_rewards={a:v[:trial_limit] for a,v in tempo_rewards.items()},
            # Only public observation is exported. Exact snapshots stay in memory.
            entities=root['entities']))
    return labels,reports,dict(roots=len(pool.branch_roots),labels=len(labels),branches=completed,cutoffs=cutoffs,
        terminal_outcomes=terminal,bootstrap_outcomes=bootstrap,environment_actions=steps,seconds=time.monotonic()-started,scene_battles=scene_battles,scene_roots=scene_roots,reference_missing=reference_missing,**horizon_counts)


def evaluate_batched(pool,models,device,options,first_place_bonus,progress=None):
    """Temporarily widen inference batches without loading another model copy."""
    from .bridge import Simulator
    extra=[]
    width=min(options.workers,max((len(r['actions'])*options.trials for r in pool.branch_roots),default=1))
    try:
        for _ in range(max(0,width-len(pool.simulators))):extra.append(Simulator(pool.simulators[0].bundle))
        with ThreadPoolExecutor(max_workers=width) as executor:
            temporary=SimpleNamespace(meta=pool.meta,branch_roots=pool.branch_roots,
                simulators=(pool.simulators+extra)[:width],executor=executor)
            result=evaluate(temporary,models,device,options,first_place_bonus,progress)
            result[2]['workers']=width
            return result
    finally:
        for simulator in extra:simulator.close()


def teach(model,optimizer,labels,config,device):
    if config.get('action_value'):
        from .action_value import teach as teach_values
        return teach_values(model,optimizer,labels,config,device)
    # Reuse the conditional policy loss. No branch action goes into PPO/GAE, and
    # the critic learns from real trajectories and their streaming bootstraps.
    from .gold_planning import teach as policy_teach, PlanningConfig
    options=BranchConfig(**config['counterfactual'])
    temporary=dict(config,gold_planning=asdict(PlanningConfig(epochs=options.epochs)))
    return policy_teach(model,optimizer,labels,temporary,device)
