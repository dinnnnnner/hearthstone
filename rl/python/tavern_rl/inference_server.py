"""Single-owner model service with bounded, versioned dynamic batching."""
import argparse
from collections import defaultdict
from contextlib import nullcontext
import os
from pathlib import Path
import selectors
import signal
import socket
import time

import numpy as np
import torch

from .inference_features import merge_batches
from .inference_transport import accept_endpoint


class ModelService:
    def __init__(self,max_batch):
        self.max_batch=max_batch;self.model=None;self.opponents=[];self.version=None
        self.metadata=None;self.device=None;self.league_identity=None;self.context=None;self.graphs=[]
        self.statistics={}

    def close_graphs(self):
        if self.context is not None:self.context.__exit__(None,None,None);self.context=None
        self.graphs=[]

    def load(self,request):
        from .train import load_checkpoint,frozen_models
        from .sampling_graphs import tower_graphs
        self.close_graphs();started=time.monotonic()
        device=request['device']
        if self.device is not None and device!=self.device:raise ValueError('Inference device changed')
        self.device=device
        if self.metadata is None:
            from .bridge import Simulator
            simulator=Simulator()
            try:self.metadata=simulator.meta
            finally:simulator.close()
        saved,self.model=load_checkpoint(request['checkpoint'],self.metadata,device,model=self.model,mmap=True)
        if self.model.observation_kind!='entities' or not self.model.recurrent:
            raise ValueError('Central inference requires an entity recurrent policy')
        identities=[(e['generation'],e.get('source_model_sha256'),e.get('model_spec',saved['model_spec'])) for e in saved['league']]
        if request['reset']:
            self.opponents.clear();self.opponents=frozen_models(saved['league'],saved['model_spec'],device)
            self.league_identity=identities
        elif self.league_identity!=identities:raise ValueError('League changed during streaming')
        if any(m.observation_kind!='entities' or not m.recurrent for m in self.opponents):raise ValueError('Central inference requires recurrent entity opponents')
        self.version=request['version'];self.model.eval()
        self.models={-1:self.model,**dict(enumerate(self.opponents))}
        for model in self.models.values():model.eval()
        self.context=tower_graphs(self.models.values(),self.max_batch) if torch.device(device).type=='cuda' and os.environ.get('TAVERN_SAMPLING_GRAPHS','1')=='1' else nullcontext([])
        self.graphs=self.context.__enter__()
        self.statistics=dict(requests=0,executions=0,rows=0,coalesced_requests=0,max_actual_batch=0,
            queue_seconds_sum=0.,inference_seconds=0.,load_seconds=time.monotonic()-started,batch_histogram={})
        specs={str(i):{k:v for k,v in m.specification().items() if k in ('hidden','architecture','action_values')} for i,m in self.models.items()}
        return dict(specifications=specs,policy_iteration=saved.get('iteration'),load_seconds=self.statistics['load_seconds'])

    def check(self,request):
        if self.version is None or request.get('version')!=self.version:raise ValueError('Stale inference policy version')
        if request.get('model') not in self.models:raise ValueError('Unknown inference model')
        if request['method']=='sample':
            size=request['features'].data['batch']
            if not 0<size<=self.max_batch:raise ValueError('Inference request exceeds batch limit')
            if any(len(request[k])!=size for k in ('masks','memory','previous','uniforms')):raise ValueError('Inference batch lengths differ')
        return self.models[request['model']]

    @torch.inference_mode()
    def sample(self, requests):
        from .rollout import sample_masked_cdf,inference_to_host
        first=requests[0];model=self.check(first)
        key=lambda r:(r['version'],r['model'],r['with_value'],r['priors'],r['value_only'],r['log_probs'])
        for request in requests:
            self.check(request)
            if key(request)!=key(first):raise ValueError('Cannot merge different policy requests')
        sizes=[r['features'].data['batch'] for r in requests]
        if sum(sizes)>self.max_batch:raise ValueError('Merged batch exceeds limit')
        started=time.monotonic();features=merge_batches([r['features'] for r in requests])
        def tensor(name):return torch.from_numpy(np.concatenate([r[name] for r in requests])).to(self.device)
        masks=tensor('masks');memory=tensor('memory');previous=tensor('previous')
        distribution,values,updated=model.act(features,masks,memory,previous,with_value=first['with_value'])
        uniforms=tensor('uniforms').to(distribution.probs.dtype)
        uniforms=uniforms.clamp_max(torch.nextafter(torch.ones((),device=self.device),torch.zeros((),device=self.device)))
        actions=sample_masked_cdf(distribution.probs,masks,uniforms)
        logs=distribution.log_prob(actions) if first['with_value'] and first['log_probs'] else None
        actions,logs,values,updated=inference_to_host(actions,logs,values if first['with_value'] else None,updated)
        priors=distribution.probs.cpu().numpy() if first['priors'] else None
        outputs=(actions,logs,values,updated,priors);result=[];offset=0
        for size in sizes:
            result.append(tuple(None if item is None else item[offset:offset+size].copy() for item in outputs));offset+=size
        stats=self.statistics;stats['requests']+=len(requests);stats['executions']+=1;stats['rows']+=sum(sizes)
        stats['coalesced_requests']+=len(requests)-1;stats['max_actual_batch']=max(stats['max_actual_batch'],sum(sizes))
        histogram=stats['batch_histogram'];histogram[str(sum(sizes))]=histogram.get(str(sum(sizes)),0)+1
        stats['inference_seconds']+=time.monotonic()-started
        return result

    @torch.inference_mode()
    def auxiliary(self,request):
        model=self.check(request)
        if request['method']=='reburn':
            from .streaming import reburn_histories
            return reburn_histories(model,request['histories'],self.device)
        if request['method']=='cards':
            from .card_value import predictions
            encoded=model.encode(request['features'],self.device)
            memory=model.recurrent_step(encoded,torch.from_numpy(request['memory']).to(self.device),torch.from_numpy(request['previous']).to(self.device))
            return predictions(model,encoded,memory).cpu().numpy()
        raise ValueError('Unknown inference method')

    def metrics(self):
        return dict(self.statistics,mean_batch=self.statistics.get('rows',0)/max(1,self.statistics.get('executions',0)),
            sampling_graph_capture_seconds=sum(g.capture_seconds for g in self.graphs),
            sampling_graph_replays=sum(g.replays for g in self.graphs),pid=os.getpid())


def serve(address,max_batch,delay_ms,max_clients):
    listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);selector=selectors.DefaultSelector()
    clients=set();pending=defaultdict(list);service=ModelService(max_batch)
    try:
        listener.bind(str(address));os.chmod(address,0o600);listener.listen(max_clients)
        selector.register(listener,selectors.EVENT_READ,None)
        while True:
            now=time.monotonic()
            timeout=None if not pending else max(0,min(queue[0][2]+delay_ms/1000-now for queue in pending.values()))
            if any(sum(item[1]['features'].data['batch'] for item in q)>=max_batch for q in pending.values()):timeout=0
            for key,_ in selector.select(timeout):
                endpoint=key.data
                if endpoint is None:
                    endpoint=accept_endpoint(listener,address.parent)
                    if len(clients)>=max_clients:endpoint.close();raise RuntimeError('Too many inference clients')
                    clients.add(endpoint);selector.register(endpoint.connection,selectors.EVENT_READ,endpoint);continue
                try:request=endpoint.receive()
                except ConnectionError:
                    if any(any(item[0] is endpoint for item in q) for q in pending.values()):raise RuntimeError('Inference requester died with pending work')
                    selector.unregister(endpoint.connection);clients.remove(endpoint);endpoint.close();continue
                try:
                    method=request['method']
                    if method=='load':
                        if pending:raise ValueError('Cannot replace weights while inference is pending')
                        result=service.load(request)
                    elif method=='metrics':result=service.metrics()
                    elif method=='sample':
                        service.check(request)
                        batch_key=(request['version'],request['model'],request['with_value'],request['priors'],request['value_only'],request['log_probs'])
                        pending[batch_key].append((endpoint,request,time.monotonic()));continue
                    else:result=service.auxiliary(request)
                    endpoint.send(dict(ok=True,result=result))
                except Exception as error:
                    endpoint.send(dict(ok=False,error=str(error)));raise
            if not pending:continue
            batch_key=min(pending,key=lambda k:pending[k][0][2]);queue=pending[batch_key]
            if time.monotonic()<queue[0][2]+delay_ms/1000 and sum(x[1]['features'].data['batch'] for x in queue)<max_batch:continue
            batch=[];count=0
            while queue and count+queue[0][1]['features'].data['batch']<=max_batch:
                item=queue.pop(0);count+=item[1]['features'].data['batch'];batch.append(item)
            if not queue:del pending[batch_key]
            service.statistics['queue_seconds_sum']+=sum(time.monotonic()-item[2] for item in batch)
            result=service.sample([item[1] for item in batch])
            for (endpoint,_,_),value in zip(batch,result):endpoint.send(dict(ok=True,result=value))
    finally:
        service.close_graphs()
        for client in clients:client.close()
        selector.close();listener.close();address.unlink(missing_ok=True)


def main():
    from .process_rollout import interrupted
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--address',type=Path,required=True)
    parser.add_argument('--max-batch',type=int,default=32)
    parser.add_argument('--delay-ms',type=float,default=1.)
    parser.add_argument('--max-clients',type=int,required=True)
    args=parser.parse_args();torch.set_num_threads(1)
    signal.signal(signal.SIGTERM,interrupted)
    serve(args.address,args.max_batch,args.delay_ms,args.max_clients)


if __name__=='__main__':main()
