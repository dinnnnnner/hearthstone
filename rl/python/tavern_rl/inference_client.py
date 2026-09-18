"""CPU policy proxies and ownership of one shared GPU inference service."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

import numpy as np
import torch

from .inference_features import HostEntityBatch
from .inference_transport import InferenceClient


class SharedInference:
    def __init__(self, max_batch=32, delay_ms=1., clients=5):
        if not 1<=max_batch<=256 or not 0<=delay_ms<=20:raise ValueError('Invalid inference batching settings')
        location='/dev/shm' if Path('/dev/shm').is_dir() and shutil.disk_usage('/dev/shm').free>=256*2**20 else None
        self.directory=tempfile.TemporaryDirectory(prefix='tavern-inference-',dir=location)
        root=Path(self.directory.name);self.address=root/'service.sock';self.control=None;self.process=None
        self.max_batch,self.delay_ms=max_batch,delay_ms
        try:
            with (root/'service.log').open('w') as log:
                self.process=subprocess.Popen([sys.executable,'-u','-m','tavern_rl.inference_server',
                    '--address',str(self.address),'--max-batch',str(max_batch),'--delay-ms',str(delay_ms),
                    '--max-clients',str(clients)],stdout=log,stderr=log,start_new_session=True)
            deadline=time.monotonic()+60
            while not self.address.exists():
                if self.process.poll() is not None:raise RuntimeError((root/'service.log').read_text()[-4000:])
                if time.monotonic()>deadline:raise TimeoutError('Inference service startup')
                time.sleep(.05)
            self.control=InferenceClient(self.address)
        except BaseException:self.close();raise

    def load(self, checkpoint, reset, device):
        token=uuid.uuid4().hex
        result=self.control.call('load',checkpoint=str(checkpoint),reset=reset,device=str(device),version=token)
        return dict(address=str(self.address),version=token,max_batch=self.max_batch,**result)

    def metrics(self):return self.control.call('metrics')

    def close(self):
        if self.control is not None:self.control.close();self.control=None
        if self.process is not None:
            try:os.killpg(self.process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid,signal.SIGKILL);self.process.wait()
            self.process=None
        if self.directory is not None:self.directory.cleanup();self.directory=None


class RemotePolicy:
    recurrent=True
    observation_kind='entities'
    remote=True

    def __init__(self, client, descriptor, metadata, specification, index):
        self.client,self.descriptor,self.index=client,descriptor,index
        self.hidden=specification['hidden'];self.action_size=metadata['actionCount'];self.schema=metadata['entitySchema']
        self._definition_groups={};self.pack_seconds=0.
        self.ledger = specification.get('architecture') in ('entity-gru-ledger', 'entity-gru-moe')
        if specification.get('action_values'):self.action_value_type=True

    def eval(self):return self

    def request(self, method, **payload):
        return self.client.call(method,version=self.descriptor['version'],model=self.index,**payload)

    def sample(self, observations, masks, memory, previous, uniforms, with_value=True, priors=False, value_only=False, log_probs=True):
        rows=[];limit=self.descriptor['max_batch']
        for start in range(0,len(observations),limit):
            end=min(start+limit,len(observations));began=time.monotonic()
            batch=HostEntityBatch.prepare(observations[start:end],self.schema,self._definition_groups)
            self.pack_seconds+=time.monotonic()-began
            rows.append(self.request('sample',features=batch,masks=masks[start:end].cpu().numpy(),
                memory=memory[start:end].cpu().numpy(),previous=previous[start:end].cpu().numpy(),
                uniforms=np.asarray(uniforms[start:end],dtype=np.float32),with_value=with_value,priors=priors,value_only=value_only,log_probs=log_probs))
        return tuple(None if rows[0][i] is None else np.concatenate([row[i] for row in rows]) for i in range(5))

    def act(self, observations, masks, memory, previous, with_value=True):
        # Streaming flush needs bootstrap values and recurrent state, no action.
        _,_,values,updated,_=self.sample(observations,masks,memory,previous,
            np.zeros(len(observations),dtype=np.float32),with_value=with_value,value_only=True,log_probs=False)
        return None,torch.from_numpy(values),torch.from_numpy(updated)

    def reburn(self, histories):return self.request('reburn',histories=histories)

    def card_predictions(self, observations, memory, previous):
        batch=HostEntityBatch.prepare(observations,self.schema,self._definition_groups)
        return self.request('cards',features=batch,memory=np.asarray(memory,dtype=np.float32),previous=np.asarray(previous,dtype=np.int64))
