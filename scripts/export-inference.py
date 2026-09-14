"""Export trusted training weights for CPU serving, with explicit rule adaptation."""
import argparse
import hashlib
import json
from pathlib import Path
import torch

p = argparse.ArgumentParser()
p.add_argument('checkpoint', type=Path)
p.add_argument('schema', type=Path, help='JSON from server/neural.ts runtimeSchema')
p.add_argument('output', type=Path)
a = p.parse_args()
saved = torch.load(a.checkpoint, map_location='cpu', weights_only=False)
raw = a.schema.read_bytes()
current = json.loads(raw)
spec = dict(saved['model_spec'])
if spec['architecture'] not in ('entity-gru', 'entity-gru-resnet') or spec['actions'] != current['actions']:
    raise ValueError('Model architecture/action encoding requires migration')
if spec['hidden'] != 128:
    raise ValueError('Online recurrent state requires hidden=128')
if not all(torch.isfinite(t).all().item() for t in saved['model'].values()):
    raise ValueError('Checkpoint contains non-finite weights')
old = spec['entity_schema']
for key in ('version', 'ids', 'zones', 'sizes', 'offsets', 'count'):
    if old[key] != current['entity_schema'][key]:
        raise ValueError(f'Entity {key} requires weight migration')
changed = sum(v != current['entity_schema']['definitions'].get(k) for k, v in old['definitions'].items())
spec['entity_schema'] = current['entity_schema']
metadata = dict(episodes=saved['episodes'], architecture=spec['architecture'],
    checkpointSha256=hashlib.sha256(a.checkpoint.read_bytes()).hexdigest(),
    trainedRulesHash=saved['meta']['rulesHash'], adaptedDefinitions=changed,
    contract=hashlib.sha256(raw).hexdigest(), hidden=spec['hidden'], actionCount=len(spec['actions']))
metadata.update(policyDepth=spec.get('policy_depth'), valueDepth=spec.get('value_depth'),
                observationVersion=saved['meta']['observationVersion'], entityVersion=old['version'],
                iteration=saved['iteration'], unusedGoldPenalty=saved['config'].get('unused_gold_penalty', 0.0))
history = saved['config'].get('humanImitation', [])
if history:
    metadata.update(humanImitation=history, imitationUpdates=sum(entry['updates'] for entry in history),
                    demonstrationGames=len({digest for entry in history for digest in entry['datasets']}))
a.output.parent.mkdir(parents=True, exist_ok=True)
torch.save(dict(model=saved['model'], model_spec=spec, metadata=metadata), a.output)
print(json.dumps(metadata, indent=2))
print(f'Inference artifact: {a.output.stat().st_size} bytes')
