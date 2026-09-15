"""Explicit imports of compatible, frozen neural opponents and lineage sampling."""
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
import torch


def fingerprint(specification, weights):
    digest = hashlib.sha256(json.dumps(specification, sort_keys=True, allow_nan=False).encode())
    for key, value in sorted(weights.items()):
        value = value.detach().cpu().contiguous()
        digest.update(json.dumps([key, str(value.dtype), list(value.shape)]).encode())
        digest.update(value.reshape(-1).view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


def sampling_weights(league, external_fraction=.4):
    if not league or not np.isfinite(external_fraction) or not 0 < external_fraction < 1:
        raise ValueError('Need a league and an external fraction strictly between zero and one')
    def difficulty_weights(indices):
        difficulty = np.array([1-(league[i].get('learner_wins',0)+2)/(league[i].get('comparisons',0)+4) for i in indices])
        weight = difficulty**2
        return .5/len(indices) + .5*weight/weight.sum()
    external = [i for i,e in enumerate(league) if e.get('external')]
    if not external: return difficulty_weights(list(range(len(league))))
    history = [i for i,e in enumerate(league) if not e.get('external')]
    if not history: raise ValueError('Keep native self-play opponents')
    groups = {}
    for i in external: groups.setdefault(league[i]['lineage'], []).append(i)
    weights = np.zeros(len(league))
    weights[history] = (1-external_fraction)*difficulty_weights(history)
    for indices in groups.values():
        weights[indices] = external_fraction/len(groups)*difficulty_weights(indices)
    return weights


def members(league):
    return [dict(generation=e['generation'], external=e.get('external',False),
                 architecture=e.get('model_spec',{}).get('architecture','mlp'),
                 depth=e.get('model_spec',{}).get('policy_depth'),
                 lineage=e.get('lineage'), source_episodes=e.get('source_episodes'),
                 source_sha256=e.get('source_sha256')) for e in league]


def mix_checkpoint(saved, opponents, meta, external_fraction=.4, max_per_lineage=None):
    # Imported lazily to keep train's public league helpers backwards compatible.
    from .train import load_checkpoint, prune_league
    if max_per_lineage is not None and (type(max_per_lineage) is not int or max_per_lineage < 1):
        raise ValueError('Positive integer per-lineage limit required')
    sampling_weights(saved['league'], external_fraction)
    league = list(saved['league'])
    known = {fingerprint(e.get('model_spec',saved['model_spec']),e['weights']) for e in league}
    known.add(fingerprint(saved['model_spec'],saved['model']))
    imported = []
    for path in opponents:
        path = Path(path)
        # Read through one file descriptor, so an atomic checkpoint replacement
        # cannot pair one version's checksum with another version's weights.
        with path.open('rb') as stream:
            digest = hashlib.sha256()
            while block := stream.read(8*1024*1024): digest.update(block)
            stream.seek(0)
            source, model = load_checkpoint(stream,meta)
        if source.get('episodes',0) < 1: raise ValueError('Opponent must have completed training games')
        if source['model_spec'].get('entity_schema') != meta.get('entitySchema'):
            raise ValueError('Opponent entity schema differs from the simulator')
        if not all(torch.isfinite(t).all().item() for t in source['model'].values() if t.is_floating_point()):
            raise ValueError('Opponent has nonfinite weights')
        identity = fingerprint(source['model_spec'],source['model'])
        if identity in known:
            del source,model
            continue
        spec = source['model_spec']
        lineage = json.dumps({k:spec.get(k) for k in ['architecture','hidden','heads','layers','policy_depth','value_depth']} |
                             dict(seed=source.get('config',{}).get('seed')),sort_keys=True)
        entry = dict(generation='external:'+identity[:16],anchor=True,external=True,lineage=lineage,
            model_spec=spec,weights=source['model'],comparisons=0,learner_wins=0.,
            source_sha256=digest.hexdigest(),source_model_sha256=identity,
            source_episodes=source['episodes'],source_checkpoint=str(path.resolve()))
        league.append(entry);known.add(identity);imported.append(identity)
        del source,model
    if max_per_lineage is not None:
        # Population refreshes replace older external snapshots without losing
        # native history or difficulty scores for unchanged opponents.
        retained, counts = [], {}
        for entry in reversed(league):
            if entry.get('external'):
                lineage = entry['lineage']
                counts[lineage] = counts.get(lineage,0)+1
                if counts[lineage] > max_per_lineage: continue
            retained.append(entry)
        league = list(reversed(retained))
    # Reserve actual history capacity instead of filling the pool with anchors.
    if sum(e.get('anchor',e['generation']==0) for e in league) > saved['config']['league_size']-4:
        raise ValueError('External opponents must leave at least four native history slots')
    league = prune_league(league,saved['config']['league_size'])
    config = copy.deepcopy(saved['config']);config['external_opponent_fraction'] = external_fraction
    config['opponent_mode'] = 'mixed_self_play' if any(e.get('external') for e in league) else 'self_history_only'
    result = saved | dict(league=league,config=config)
    result['league_imports'] = list(saved.get('league_imports',[])) + [dict(
        at_episodes=saved['episodes'],model_sha256s=imported,external_fraction=external_fraction)]
    return result
