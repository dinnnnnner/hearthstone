"""Replay opening turns through an exported serving policy, without training."""
import argparse
import hashlib
import json
from pathlib import Path
import torch

from tavern_rl.bridge import Simulator
from tavern_rl.serve import Policy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seeds', type=int, default=32)
    parser.add_argument('--first-seed', type=int, default=9821501)
    parser.add_argument('--search-bundle', type=Path)
    parser.add_argument('--zero-q-residual', action='store_true',
                        help='Diagnostic ablation in memory only; never saves model weights')
    args = parser.parse_args()
    if args.seeds < 1:
        raise ValueError('Positive seed count required')
    policy = Policy(args.model, search_bundle=args.search_bundle)
    if args.zero_q_residual:
        with torch.no_grad():
            for layer in (policy.model.action_value_type, policy.model.action_value_source):
                layer.weight.zero_()
                layer.bias.zero_()
    report = dict(metadata=policy.metadata, model_sha256=hashlib.sha256(args.model.read_bytes()).hexdigest(),
                  ablation='zero-q-residual' if args.zero_q_residual else None,
                  scope='All eight seats, first recruit turn; natural greedy/search actions, no forced moves.',
                  openings=[], completed=False)
    with Simulator(args.bundle) as sim:
        spec = policy.model.specification()
        if sim.meta['rulesHash'] != policy.metadata['trainedRulesHash']:
            raise ValueError('Simulator rules differ from training')
        if sim.meta['entitySchema'] != spec['entity_schema'] or sim.meta['actions'] != spec['actions']:
            raise ValueError('Simulator observations/actions differ from model')
        report['rules_hash'] = sim.meta['rulesHash']
        ids = sim.meta['entitySchema']['ids']

        def cards(state, zone):
            return [dict(card=ids[e['id'] - 1], position=e['position'], details=e['details'])
                    for e in state['entities'] if e and e['zone'] == zone]

        for seed in range(args.first_seed, args.first_seed + args.seeds):
            state = sim.reset(seed, {'aiActionLimits': True})
            memories = [[0.] * policy.model.hidden for _ in range(8)]
            previous_actions = [policy.model.action_size] * 8
            opening = dict(seed=seed, heroes=state['info']['heroes'], decisions=[])
            for _ in range(8 * 96):
                if state['info']['turn'] != 1 or state['terminated']:
                    break
                actor = state['actor']
                row = dict(entities=state['entities'], legal=state['legalActions'],
                           memory=memories[actor], previous=previous_actions[actor])
                request = dict(contract=policy.metadata['contract'], rows=[row], probabilities=True)
                if args.search_bundle:
                    request.update(search=True, searchTimeMs=1000)
                chosen = policy.predict(request)['rows'][0]
                action = sim.meta['actions'][chosen['action']]
                decision = dict(actor=actor, action_id=chosen['action'], action=action, mode=chosen['selectionMode'],
                                gold=state['entities'][0]['details']['gold'],
                                board=cards(state, 1), shop=cards(state, 2), hand=cards(state, 4),
                                probabilities=sorted(chosen['probabilities'], key=lambda x: -x[1]),
                                top_actions=[dict(action=sim.meta['actions'][a], probability=p)
                                             for a, p in sorted(chosen['probabilities'], key=lambda x: -x[1])[:8]])
                if action['type'] == 'sell':
                    # Exact recurrent input and environment state allow paired follow-up experiments.
                    decision['request'] = request
                    decision['snapshot'] = sim.call('snapshot')
                opening['decisions'].append(decision)
                memories[actor], previous_actions[actor] = chosen['memory'], chosen['action']
                state = sim.step(chosen['action'])
            else:
                raise RuntimeError('Opening did not finish within action budget')
            opening['sold'] = any(d['action']['type'] == 'sell' for d in opening['decisions'])
            report['openings'].append(opening)
            args.output.write_text(json.dumps(report, ensure_ascii=False))
            print(json.dumps(dict(seed=seed, sold=opening['sold'],
                                  seats=[[d['action']['type'] for d in opening['decisions'] if d['actor'] == seat]
                                         for seat in range(8)]), ensure_ascii=False), flush=True)
    report['completed'] = True
    report['sold_openings'] = sum(o['sold'] for o in report['openings'])
    seat_sequences = [[d for d in o['decisions'] if d['actor'] == seat]
                      for o in report['openings'] for seat in range(8)]
    report['seats'] = len(seat_sequences)
    report['seats_sold'] = sum(any(d['action']['type'] == 'sell' for d in ds) for ds in seat_sequences)
    # A descriptive sequence count, not a claim that every sale is a mistake.
    report['buy_play_sell_freeze_end'] = sum([d['action']['type'] for d in ds] ==
                                            ['buy', 'play', 'sell', 'freeze', 'end'] for ds in seat_sequences)
    args.output.write_text(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
