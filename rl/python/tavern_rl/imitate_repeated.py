"""Repeat verified human segments until a deadline; publish policy-only candidates."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import datetime
import hashlib
import json
from pathlib import Path
import time
import torch
from .demonstrations import load_dataset
from .features import prepare_entities
from .model import make_model


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.next')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def repeated_trial(checkpoint, dataset, output, deadline_utc, *, device='cpu',
                   learning_rate=1e-5, sequence_length=16, max_updates=None):
    end = datetime.datetime.fromisoformat(deadline_utc)
    if end.tzinfo is None or end.timestamp() <= time.time():
        raise ValueError('A future deadline with timezone is required')
    if not 0 < learning_rate < 1 or sequence_length < 1 or max_updates is not None and max_updates < 1:
        raise ValueError('Invalid training limits')
    deadline = time.monotonic() + end.timestamp() - time.time()
    output = Path(output)
    if output.exists(): raise FileExistsError(output)
    manifest, episodes, rejected = load_dataset(dataset, allow_incomplete_segments=True, allow_partial_start=True)
    if rejected or len(episodes) < 2:
        raise ValueError('Need at least two explicitly selected, valid human games and no rejected records')
    if len({e['start']['gameId'] for e in episodes}) != len(episodes):
        raise ValueError('Duplicate game identities')
    schema = json.loads(manifest['schema'])
    with Path(checkpoint).open('rb') as f:
        parent_hash = hashlib.file_digest(f, 'sha256').hexdigest()
    base = torch.load(checkpoint, map_location='cpu', weights_only=False)
    for key in ('optimizer', 'config', 'iteration', 'episodes', 'league', 'torch_rng', 'numpy_rng', 'python_rng'):
        if key not in base: raise ValueError('Missing PPO state: ' + key)
    spec = base['model_spec']
    if base['meta']['observationVersion'] != 4 or spec['entity_schema'] != schema['entity_schema'] or spec['actions'] != schema['actions']:
        raise ValueError('Dataset and model contracts differ')
    model = make_model(spec).to(device)
    model.load_state_dict(base['model'], strict=True)
    for name, parameter in model.named_parameters():
        if name.startswith(('critic.', 'value_tower.')): parameter.requires_grad_(False)
    if not all(torch.isfinite(p).all().item() for p in model.parameters()):
        raise ValueError('Non-finite source policy')
    # PPO state is kept in the immutable source file, never rewritten by this worker.
    del base
    optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=learning_rate)
    model.eval()
    chunks = []
    for e in episodes:
        for segment in e['segments']:
            for step in segment: step['prepared'] = prepare_entities(step['entities'])
            chunks.extend((e, segment, start) for start in range(0, len(segment), sequence_length))
    output.mkdir(parents=True)
    summary = dict(kind='repeated_human_imitation', deadline_utc=deadline_utc, parentArtifactSha256=parent_hash,
        contract=manifest['contract'], learningRate=learning_rate, sequenceLength=sequence_length,
        trainingChunks=len(chunks), recordedSteps=sum(len(e['steps']) for e in episodes),
        dataset=[dict(file=e['file'], sha256=e['sha256'], gameId=e['start']['gameId'], selection=e['selection']) for e in episodes],
        validation=None, note='All selected games are training data; agreement is not independent playing-strength evidence.')

    def predict(step, memory):
        mask = torch.zeros((1, model.action_size), dtype=torch.bool, device=device)
        mask[0, step['legal']] = True
        previous = torch.tensor([step['previous']], device=device)
        with torch.backends.cudnn.flags(enabled=False):
            distribution, _, memory = model.act([step['prepared']], mask, memory, previous, with_value=False)
        loss = -distribution.log_prob(torch.tensor([step['action']], device=device)).mean()
        return loss, memory, int(distribution.probs.argmax(-1).item() == step['action'])

    def evaluate():
        groups = defaultdict(lambda: [0, 0., 0])
        with torch.no_grad():
            for e in episodes:
                for segment in e['segments']:
                    memory = torch.zeros((1, model.hidden), device=device)
                    for step in segment:
                        loss, memory, match = predict(step, memory)
                        for key in ('all', schema['actions'][step['action']]['type']):
                            g = groups[key]; g[0] += 1; g[1] += float(loss); g[2] += match
        return {k: dict(samples=n, negative_log_likelihood=loss/n, top1_agreement=correct/n)
                for k, (n, loss, correct) in groups.items()}

    atomic_json(output/'progress.json', dict(summary, stage='evaluating_before', updates=0))
    summary['before'] = evaluate()
    atomic_json(output/'baseline.json', summary)
    generator = torch.Generator().manual_seed(42)
    visits = Counter(); action_visits = Counter(); order = []; updates = 0
    last_save = last_progress = time.monotonic()

    def report(stage):
        return dict(summary, stage=stage, updates=updates, uniqueSupervisedSteps=len(visits),
            supervisedStepVisits=sum(visits.values()), fullPasses=updates//len(chunks),
            actionVisits=dict(action_visits), timestamp_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())

    def save():
        weights = {k:v.detach().cpu() for k,v in model.state_dict().items()}
        if not all(torch.isfinite(v).all().item() for v in weights.values()): raise ValueError('Non-finite candidate')
        temporary = output/'candidate.pt.next'
        torch.save(dict(model=weights, model_spec=spec, parentArtifactSha256=parent_hash,
                        report=report('checkpoint'), imitation_optimizer=optimizer.state_dict(),
                        shuffle_rng=generator.get_state(), remaining_order=order), temporary)
        temporary.replace(output/'candidate.pt')

    while time.monotonic() < deadline and (max_updates is None or updates < max_updates):
        if not order: order = torch.randperm(len(chunks), generator=generator).tolist()
        e, segment, start = chunks[order.pop()]
        memory = torch.zeros((1, model.hidden), device=device)
        with torch.no_grad():
            for step in segment[:start]:
                if time.monotonic() >= deadline: break
                _, memory, _ = predict(step, memory)
        if time.monotonic() >= deadline: break
        terms = []
        selected = segment[start:start+sequence_length]
        for step in selected:
            if time.monotonic() >= deadline: break
            loss, memory, _ = predict(step, memory); terms.append(loss)
        if len(terms) != len(selected) or time.monotonic() >= deadline: break
        loss = torch.stack(terms).mean()
        if not torch.isfinite(loss): raise ValueError('Non-finite imitation loss')
        optimizer.zero_grad(set_to_none=True); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), .5, error_if_nonfinite=True)
        if time.monotonic() >= deadline: break
        optimizer.step(); updates += 1
        for step in selected:
            visits[(e['file'], step['step'])] += 1
            action_visits[schema['actions'][step['action']]['type']] += 1
        if updates == 1 or time.monotonic()-last_save >= 300:
            save(); last_save = time.monotonic()
        if updates == 1 or time.monotonic()-last_progress >= 30:
            state = report('training'); atomic_json(output/'progress.json', state)
            print(json.dumps({k:state[k] for k in ('stage','updates','fullPasses','uniqueSupervisedSteps','actionVisits')}), flush=True)
            last_progress = time.monotonic()
    if not updates: raise RuntimeError('No optimizer update completed before deadline')
    summary['training_stopped_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()  # Keep the final learned policy even if diagnostic evaluation is interrupted.
    summary['after'] = evaluate()
    result = report('complete')
    atomic_json(output/'report.json', result)
    atomic_json(output/'progress.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('checkpoint','dataset','output','deadline-utc'): parser.add_argument('--'+name, required=True)
    parser.add_argument('--device', default='cuda')
    args = parser.parse_args(); torch.set_num_threads(1); torch.manual_seed(42)
    repeated_trial(args.checkpoint, args.dataset, args.output, args.deadline_utc, device=args.device)


if __name__ == '__main__': main()
