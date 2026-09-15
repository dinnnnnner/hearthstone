"""Train a new policy from human demonstrations with whole-game validation."""
from __future__ import annotations
import argparse
from collections import defaultdict
import datetime
import hashlib
import json
from pathlib import Path
import signal
import time
import torch
from .demonstrations import load_dataset, split_games
from .features import prepare_entities
from .imitate_repeated import atomic_json
from .model import make_model


def fingerprint(weights):
    digest = hashlib.sha256()
    for name, value in sorted(weights.items()):
        digest.update(name.encode()); digest.update(value.detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def sequence_batches(episodes, batch_size, generator=None):
    segments = [segment for episode in episodes for segment in episode['segments']]
    order = torch.randperm(len(segments), generator=generator).tolist() if generator is not None else list(range(len(segments)))
    return [[segments[i] for i in order[start:start+batch_size]] for start in range(0,len(order),batch_size)]


def forward_step(model, segments, offset, memory, device):
    active = [offset < len(segment) for segment in segments]
    rows = [segment[offset] if valid else segment[0] for segment,valid in zip(segments,active)]
    mask = torch.zeros(len(rows),model.action_size,dtype=torch.bool,device=device)
    for i,row in enumerate(rows): mask[i,row['legal']] = True
    previous = torch.tensor([row['previous'] for row in rows],dtype=torch.long,device=device)
    with torch.backends.cudnn.flags(enabled=False):
        distribution,_,updated = model.act([row['prepared'] for row in rows],mask,memory,previous,with_value=False)
    valid = torch.tensor(active,dtype=torch.bool,device=device)
    actions = torch.tensor([row['action'] for row in rows],dtype=torch.long,device=device)
    losses = -distribution.log_prob(actions)
    updated = torch.where(valid[:,None],updated,memory)
    return losses[valid],updated,distribution.probs.argmax(-1),rows,active


def evaluate(model, episodes, types, batch_size, device, stopped):
    groups = defaultdict(lambda:[0,0.,0,0])
    model.eval()
    with torch.no_grad():
        for segments in sequence_batches(episodes,batch_size):
            memory = torch.zeros(len(segments),model.hidden,device=device)
            for offset in range(max(map(len,segments))):
                if stopped(): return None
                losses,memory,predictions,rows,active = forward_step(model,segments,offset,memory,device)
                values=iter(losses.cpu().tolist()); predictions=predictions.cpu().tolist()
                for row,valid,prediction in zip(rows,active,predictions):
                    if not valid: continue
                    loss=next(values);kind=types[row['action']]
                    keys=['all',kind]
                    if len(row['legal'])>1:keys.append('non_forced')
                    for key in keys:
                        group=groups[key];group[0]+=1;group[1]+=loss
                        group[2]+=prediction==row['action'];group[3]+=types[prediction]==kind
    return {key:dict(samples=n,negative_log_likelihood=loss/n,top1_agreement=exact/n,type_agreement=kind/n)
            for key,(n,loss,exact,kind) in groups.items()}


def fresh_trial(dataset, output, deadline_utc, *, depth=64, device='cpu', learning_rate=1e-4,
                batch_size=16, sequence_length=16, patience=6, max_epochs=200, seed=42, hidden=128, heads=4, layers=2):
    end=datetime.datetime.fromisoformat(deadline_utc)
    if end.tzinfo is None or end.timestamp()<=time.time():raise ValueError('A future deadline with timezone is required')
    if not 0<learning_rate<1 or min(batch_size,sequence_length,patience,max_epochs)<1:raise ValueError('Invalid training settings')
    output=Path(output)
    if output.exists():raise FileExistsError(output)
    manifest,episodes,rejected=load_dataset(dataset,allow_incomplete_segments=True,allow_partial_start=True)
    if rejected:raise ValueError('Select valid human records first: '+json.dumps(rejected))
    if len({e['start']['gameId'] for e in episodes})!=len(episodes):raise ValueError('Duplicate game identities')
    training,validation=split_games(episodes)
    schema=json.loads(manifest['schema']);types=[a['type'] for a in schema['actions']]
    spec=dict(architecture='entity-gru-resnet',entity_schema=schema['entity_schema'],actions=schema['actions'],
              hidden=hidden,heads=heads,layers=layers,policy_depth=depth,value_depth=depth)
    torch.manual_seed(seed)
    model=make_model(spec).to(device)
    for name,parameter in model.named_parameters():
        if name.startswith(('critic.','value_tower.')):parameter.requires_grad_(False)
    optimizer=torch.optim.Adam([p for p in model.parameters() if p.requires_grad],lr=learning_rate,
                               **({'fused':True} if str(device).startswith('cuda') else {}))
    generator=torch.Generator().manual_seed(seed)
    for episode in episodes:
        for segment in episode['segments']:
            for row in segment:row['prepared']=prepare_entities(row['entities'])
    output.mkdir(parents=True)
    stop_requested=False
    def on_signal(*_):
        nonlocal stop_requested
        stop_requested=True
    prior={s:signal.signal(s,on_signal) for s in (signal.SIGTERM,signal.SIGINT)}
    deadline=time.monotonic()+end.timestamp()-time.time()
    def stopped():return stop_requested or time.monotonic()>=deadline
    initial={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
    summary=dict(kind='fresh_human_imitation',initialization='random',initialWeightSha256=fingerprint(initial),
                 contract=manifest['contract'],depth=depth,seed=seed,deadlineUtc=deadline_utc,learningRate=learning_rate,
                 batchSize=batch_size,sequenceLength=sequence_length,patience=patience,maxEpochs=max_epochs,
                 selfPlayEpisodes=0,valueHeadTrained=False,
                 datasets=[dict(file=e['file'],sha256=e['sha256'],gameId=e['start']['gameId'],
                     split='training' if e in training else 'validation',steps=len(e['steps']),selection=e['selection']) for e in episodes])
    torch.save(dict(model=initial,model_spec=spec,report=summary),output/'initial.pt');del initial
    epoch=updates=visits=0;best_epoch=0;best_score=float('inf');stale=0;latest_validation=None
    last_save=time.monotonic();last_progress=0.;reason='max_epochs'
    def state(stage):
        return dict(summary,stage=stage,epoch=epoch,updates=updates,supervisedStepVisits=visits,bestEpoch=best_epoch,
                    bestValidationNll=best_score if best_score!=float('inf') else None,validation=latest_validation,
                    timestampUtc=datetime.datetime.now(datetime.timezone.utc).isoformat())
    def save(name):
        weights={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
        if not all(torch.isfinite(v).all().item() for v in weights.values()):raise ValueError('Non-finite candidate')
        pending=output/(name+'.next')
        torch.save(dict(kind='fresh_human_imitation',model=weights,model_spec=spec,report=state('checkpoint'),
                        imitation_optimizer=optimizer.state_dict(),shuffle_rng=generator.get_state()),pending)
        pending.replace(output/name)
    try:
        atomic_json(output/'progress.json',state('evaluating_before'))
        summary['before']=evaluate(model,validation,types,batch_size,device,stopped)
        atomic_json(output/'baseline.json',summary)
        if summary['before'] is None:reason='deadline_before_training'
        else:
            best_score=summary['before']['all']['negative_log_likelihood'];latest_validation=summary['before'];save('best.pt')
            for epoch in range(1,max_epochs+1):
                if stopped():break
                model.eval()  # Disable dropout during both recorded-history replay and supervision.
                for segments in sequence_batches(training,batch_size,generator):
                    memory=torch.zeros(len(segments),model.hidden,device=device)
                    for start in range(0,max(map(len,segments)),sequence_length):
                        terms=[];count=0;memory=memory.detach()
                        for offset in range(start,min(start+sequence_length,max(map(len,segments)))):
                            if stopped():break
                            losses,memory,_,_,_=forward_step(model,segments,offset,memory,device)
                            terms.append(losses.sum());count+=len(losses)
                        if stopped():break
                        loss=torch.stack(terms).sum()/count
                        if not torch.isfinite(loss):raise ValueError('Non-finite loss')
                        optimizer.zero_grad(set_to_none=True);loss.backward()
                        torch.nn.utils.clip_grad_norm_(model.parameters(),.5,error_if_nonfinite=True)
                        if stopped():break
                        optimizer.step();updates+=1;visits+=count
                        if updates==1 or time.monotonic()-last_save>=300:
                            save('latest.pt');last_save=time.monotonic()
                        if updates==1 or time.monotonic()-last_progress>=30:
                            atomic_json(output/'progress.json',state('training'));last_progress=time.monotonic()
                    if stopped():break
                if stopped():break
                atomic_json(output/'progress.json',state('validating'))
                latest_validation=evaluate(model,validation,types,batch_size,device,stopped)
                if latest_validation is None:break
                score=latest_validation['all']['negative_log_likelihood']
                if score<best_score-1e-4:best_score=score;best_epoch=epoch;stale=0;save('best.pt')
                else:stale+=1
                save('latest.pt');last_save=time.monotonic()
                result=state('epoch_complete')
                with (output/'metrics.jsonl').open('a') as log:log.write(json.dumps(result)+'\n')
                atomic_json(output/'progress.json',result)
                print(json.dumps(dict(epoch=epoch,updates=updates,validationNll=score,bestEpoch=best_epoch)),flush=True)
                if stale>=patience:reason='validation_patience';break
        if stopped():reason='interrupted' if stop_requested else 'deadline'
        if updates:save('latest.pt')
        result=state('complete')|dict(stopReason=reason)
        atomic_json(output/'report.json',result);atomic_json(output/'progress.json',result)
        return result
    finally:
        for sig,handler in prior.items():signal.signal(sig,handler)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('dataset','output','deadline-utc'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--depth',type=int,choices=[64,256,1024],required=True)
    parser.add_argument('--device',default='cuda')
    args=parser.parse_args();torch.set_num_threads(1)
    fresh_trial(args.dataset,args.output,args.deadline_utc,depth=args.depth,device=args.device)


if __name__=='__main__':main()
