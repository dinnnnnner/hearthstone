"""State-dependent purchase comparisons; scores are returns, not fixed card ratings."""
import hashlib


def comparison(meta, row, label, seed, seat):
    entities=row['entities'];g=entities[0]['details'];schema=meta['entitySchema']
    def card(entity):
        return dict(id=schema['ids'][entity['id']-1],position=entity['position'],details=entity['details'])
    def zone(number):return [card(e) for e in entities if e and e.get('zone')==number]
    scores=dict(zip(label['actions'],label['values']))
    counts=dict(zip(label['actions'],label['sample_counts']))
    targets=dict(zip(label['actions'],label['target']))
    alternatives=[value for action,value in scores.items() if meta['actions'][action]['type'] not in ('buy','buySpell')]
    best_other=max(alternatives) if alternatives else None
    cards=[];other=[]
    for action in row['legal']:
        spec=meta['actions'][action];kind=spec['type']
        item=dict(action=action,kind=kind,selected=action==label['best'],scored=action in scores)
        if action in scores:item.update(value=scores[action],samples=counts[action],target=targets[action])
        if kind in ('buy','buySpell'):
            entity=entities[schema['offsets'][2 if kind=='buy' else 3]+spec['source']]
            if entity is None:raise ValueError('Purchase action has no visible card')
            item['card']=card(entity)
            if action in scores:
                item['gain_vs_end']=scores[action]-scores[0]
                item['gain_vs_best_nonpurchase']=scores[action]-best_other if best_other is not None else None
            cards.append(item)
        elif action in scores:other.append(item)
    token=f"{seed}:{seat}:{g['turn']}:{g['decisions']}"
    return dict(priority=hashlib.blake2b(token.encode(),digest_size=16).hexdigest(),seed=seed,seat=seat,
                context={k:g[k] for k in ('turn','tier','gold','health','armor','upgrade','nextGold','freeRefresh','decisions') if k in g},
                board=zone(1),hand=zone(4),purchases=cards,alternatives=other,selected_action=label['best'],
                value_unit='expected_final_placement_reward')


def retain(examples, item, limit=64):
    """Bounded, RNG-neutral examples spread over the whole rollout."""
    if not item['purchases']:return
    if len(examples)>=limit and item['priority']>=examples[-1]['priority']:return
    examples.append(item);examples.sort(key=lambda r:r['priority']);del examples[limit:]


def finalize(examples, seed, ranks, rewards, bonus, stage_totals=None):
    from .placement_rewards import reward_with_first_place_bonus
    for item in examples:
        if item['seed']!=seed:continue
        seat=item['seat'];item['final_placement']=ranks[seat]
        item['actual_return']=reward_with_first_place_bonus(rewards[seat],ranks[seat],bonus)
        item['final_placement_reward']=item['actual_return']
        if stage_totals is not None:item['actual_return']+=stage_totals[seat]-item.get('stage_bonus_before',0.)
