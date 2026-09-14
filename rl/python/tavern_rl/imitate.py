"""Bounded behavior-cloning trial from recorded human games; writes a separate candidate."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import torch
from .demonstrations import load_dataset, split_games
from .features import prepare_entities
from .model import make_model


def train_trial(checkpoint, dataset, output, *, updates=8, sequence_length=16, learning_rate=1e-5, device='cpu', allow_synthetic=False,
                single_game=False, allow_incomplete_prefix=False):
    if updates < 1 or sequence_length < 1 or not 0 < learning_rate < 1:
        raise ValueError('Invalid training limits')
    output = Path(output)
    if output.exists(): raise ValueError('Output must be a new directory; never overwrite a serving model')
    if allow_incomplete_prefix and not single_game:
        raise ValueError('Incomplete prefixes require an explicit single-game trial')
    manifest, episodes, rejected = load_dataset(dataset, allow_synthetic, allow_incomplete_prefix)
    if single_game:
        if len(episodes) != 1 or rejected:
            raise ValueError('Single-game trial requires exactly one accepted episode and no rejected files')
        training, validation = episodes, []
    else:
        training, validation = split_games(episodes)
    saved = torch.load(checkpoint, map_location='cpu', weights_only=True)
    spec = saved['model_spec']; schema = json.loads(manifest['schema'])
    if spec.get('architecture') not in ('entity-gru', 'entity-gru-resnet') or spec['actions'] != schema['actions'] or spec['entity_schema'] != schema['entity_schema']:
        raise ValueError('Model and dataset input/action definitions differ')
    if saved.get('metadata', {}).get('contract') != manifest['contract']:
        raise ValueError('Use a compatible exported inference artifact')
    model = make_model(spec).to(device)
    model.load_state_dict(saved['model'], strict=True)
    if not all(torch.isfinite(p).all().item() for p in model.parameters()): raise ValueError('Non-finite model')
    # The value head has no human-return target in this trial.
    for name, parameter in model.named_parameters():
        if name.startswith(('value_tower.', 'critic.')): parameter.requires_grad_(False)
    optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=learning_rate)
    for episode in episodes:
        for step in episode['steps']: step['prepared'] = prepare_entities(step['entities'])
    def predict(step, memory):
        mask = torch.zeros((1, model.action_size), dtype=torch.bool, device=device)
        mask[0, step['legal']] = True
        previous = torch.tensor([step['previous']], device=device)
        distribution, _, memory = model.act([step['prepared']], mask, memory, previous, with_value=False)
        loss = -distribution.log_prob(torch.tensor([step['action']], device=device)).mean()
        return loss, memory, int(distribution.probs.argmax(-1).item() == step['action'])
    def evaluate(items):
        if not items: return None
        model.eval(); losses=[]; matches=0
        with torch.no_grad():
            for episode in items:
                memory = torch.zeros((1, model.hidden), device=device)
                for step in episode['steps']:
                    loss, memory, match = predict(step, memory)
                    losses.append(float(loss)); matches += match
        return {'samples':len(losses), 'negative_log_likelihood':sum(losses)/len(losses), 'top1_agreement':matches/len(losses)}
    before = {'training':evaluate(training), 'validation':evaluate(validation)}
    chunks = [(episode, start) for episode in training for start in range(0,len(episode['steps']),sequence_length)]
    generator = torch.Generator().manual_seed(42)
    losses=[]
    order=[]
    for _ in range(updates):
        if not order: order=torch.randperm(len(chunks),generator=generator).tolist()
        episode,start=chunks[order.pop()]
        model.eval()  # No inference/training dropout mismatch during human-sequence replay.
        memory=torch.zeros((1,model.hidden),device=device)
        # Recompute this model's memory from the beginning with its latest weights.
        # Never borrow a different depth's state or cross a game boundary.
        with torch.no_grad():
            for step in episode['steps'][:start]: _,memory,_=predict(step,memory)
        terms=[]
        for step in episode['steps'][start:start+sequence_length]:
            loss,memory,_=predict(step,memory);terms.append(loss)
        loss=torch.stack(terms).mean()
        if not torch.isfinite(loss): raise ValueError('Non-finite imitation loss')
        optimizer.zero_grad(set_to_none=True);loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(),.5,error_if_nonfinite=True)
        optimizer.step();losses.append(float(loss.detach()))
    after={'training':evaluate(training),'validation':evaluate(validation)}
    weights={k:v.detach().cpu() for k,v in model.state_dict().items()}
    if not all(torch.isfinite(v).all().item() for v in weights.values()): raise ValueError('Non-finite candidate')
    changed=sum(not torch.equal(saved['model'][k],v) for k,v in weights.items())
    if not changed: raise ValueError('No parameter changed')
    digest=hashlib.sha256()
    for k,v in sorted(weights.items()): digest.update(k.encode());digest.update(v.contiguous().numpy().tobytes())
    identity=digest.hexdigest()
    metadata=dict(saved['metadata'], checkpointSha256=identity, parentCheckpointSha256=saved['metadata']['checkpointSha256'], imitationUpdates=updates)
    report={'kind':'behavior_cloning_trial','contract':manifest['contract'],'parentArtifactSha256':hashlib.sha256(Path(checkpoint).read_bytes()).hexdigest(),
            'syntheticAllowed':allow_synthetic,'singleGame':single_game,'incompletePrefixAllowed':allow_incomplete_prefix,
            'updates':updates,'learningRate':learning_rate,'sequenceLength':sequence_length,
            'changedTensors':changed,'losses':losses,'before':before,'after':after,'rejected':rejected,
            'trainingGames':sorted({e['start']['gameId'] for e in training}),
            'validationGames':sorted({e['start']['gameId'] for e in validation}),
            'dataset':[{'file':e['file'],'sha256':e['sha256'],'source':e['start']['source'],'buildId':e['start']['buildId'],
                        'selection':e['selection']} for e in episodes],
            'deployed':False,'note':'Agreement on demonstrations is not playing strength; run independent arena evaluation before deployment.'}
    output.mkdir(parents=True)
    torch.save(dict(saved,model=weights,metadata=metadata),output/'candidate.pt')
    (output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint',required=True,type=Path,help='Exported inference artifact, not a full PPO checkpoint')
    parser.add_argument('--dataset',required=True,type=Path,help='Contract directory containing schema.json and episodes')
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--updates',type=int,default=8)
    parser.add_argument('--sequence-length',type=int,default=16)
    parser.add_argument('--learning-rate',type=float,default=1e-5)
    parser.add_argument('--device',default='cpu')
    parser.add_argument('--allow-synthetic',action='store_true',help='Explicit pipeline verification only')
    parser.add_argument('--single-game',action='store_true',help='Train one explicitly selected episode; no independent validation')
    parser.add_argument('--allow-incomplete-prefix',action='store_true',help='Only use the verified prefix before the first gap; requires --single-game')
    args=parser.parse_args();torch.set_num_threads(1);torch.manual_seed(42)
    print(json.dumps(train_trial(args.checkpoint,args.dataset,args.output,updates=args.updates,sequence_length=args.sequence_length,
                                learning_rate=args.learning_rate,device=args.device,allow_synthetic=args.allow_synthetic,
                                single_game=args.single_game,allow_incomplete_prefix=args.allow_incomplete_prefix)))

if __name__=='__main__': main()
