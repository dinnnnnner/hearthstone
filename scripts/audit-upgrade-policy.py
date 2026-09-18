"""Measure natural upgrade choices with the exact exported policy and recurrent history."""
import argparse
from collections import Counter,defaultdict
import hashlib
import json
from pathlib import Path
import torch
from tavern_rl.bridge import Simulator
from tavern_rl.serve import Policy


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model',type=Path,required=True)
    p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--games',type=int,default=2)
    p.add_argument('--turns',type=int,default=8)
    p.add_argument('--seed',type=int,default=9817201)
    args=p.parse_args()
    if min(args.games,args.turns)<1:raise ValueError('Positive games and turns required')
    policy=Policy(args.model);torch.manual_seed(args.seed)
    result=dict(metadata=policy.metadata,model_sha256=hashlib.sha256(args.model.read_bytes()).hexdigest(),
                scope='Natural ordinary-policy sampling, all eight seats through turn limit; not a strength evaluation.',games=[],completed=False)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    fixtures=[]
    with Simulator(args.bundle) as sim:
        spec=policy.model.specification()
        assert sim.meta['entitySchema']==spec['entity_schema'] and sim.meta['actions']==spec['actions']
        assert sim.meta['rulesHash']==policy.metadata['trainedRulesHash']
        upgrades={i for i,a in enumerate(sim.meta['actions']) if a['type']=='upgrade'}
        for seed in range(args.seed,args.seed+args.games):
            state=sim.reset(seed,dict(aiActionLimits=True,maxActionsPerTurn=64))
            memories=[[0.]*policy.model.hidden for _ in range(8)];previous=[policy.model.action_size]*8
            game=dict(seed=seed,heroes=state['info']['heroes'],decisions=[],turn_ends=[],turn_starts=[])
            seen=set()
            for step in range(args.turns*8*96):
                if state['terminated'] or state['info']['turn']>args.turns:break
                actor=state['actor'];g=state['entities'][0]['details'];turn=g['turn']
                row=dict(entities=state['entities'],legal=state['legalActions'],memory=memories[actor],previous=previous[actor])
                chosen=policy.predict(dict(contract=policy.metadata['contract'],rows=[row],probabilities=True))['rows'][0]
                action=sim.meta['actions'][chosen['action']]['type'];probs=defaultdict(float)
                for aid,prob in chosen['probabilities']:probs[sim.meta['actions'][aid]['type']]+=prob
                record=dict(actor=actor,turn=turn,tier=g['tier'],gold=g['gold'],cost=g['upgrade'],action=action,
                            upgrade_legal=bool(upgrades.intersection(row['legal'])),probabilities=dict(probs),
                            board_count=sum(bool(e and e['zone']==1) for e in row['entities']))
                game['decisions'].append(record)
                if (actor,turn) not in seen:
                    seen.add((actor,turn));game['turn_starts'].append(record)
                    if record['upgrade_legal'] and len(fixtures)<48:
                        fixtures.append(dict(seed=seed,record=record,row=row,snapshot=sim.call('snapshot')))
                if action=='end':game['turn_ends'].append(record)
                memories[actor]=chosen['memory'];previous[actor]=chosen['action'];state=sim.step(chosen['action'])
            else:raise RuntimeError('Exceeded audit action budget')
            result['games'].append(game)
            args.output.write_text(json.dumps(result,ensure_ascii=False))
            print(json.dumps(dict(seed=seed,actions=len(game['decisions']),upgrades=sum(r['action']=='upgrade' for r in game['decisions']))),flush=True)
    starts=[r for g in result['games'] for r in g['turn_starts']]
    decisions=[r for g in result['games'] for r in g['decisions']]
    result['turns']={turn:dict(seats=sum(r['turn']==turn for r in starts),tiers=dict(Counter(r['tier'] for r in starts if r['turn']==turn)),
        affordable_at_start=sum(r['turn']==turn and r['upgrade_legal'] for r in starts),
        mean_upgrade_probability_at_affordable_start=(sum(r['probabilities'].get('upgrade',0.) for r in starts if r['turn']==turn and r['upgrade_legal'])/max(1,sum(r['turn']==turn and r['upgrade_legal'] for r in starts))),
        upgrades=sum(r['turn']==turn and r['action']=='upgrade' for r in decisions)) for turn in range(1,args.turns+1)}
    result['completed']=True
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    args.output.with_suffix('.fixtures.json').write_text(json.dumps(fixtures,ensure_ascii=False))
    print(json.dumps(result['turns']),flush=True)


if __name__=='__main__':main()
