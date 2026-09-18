"""Compare tower shapes on recorded real observations; never train or save weights."""
import argparse
from copy import deepcopy
import gc
import json
from pathlib import Path
import statistics
import time

import numpy as np
import torch

from tavern_rl.model import make_model
from tavern_rl.sampling_graphs import tower_graphs


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint',type=Path,required=True)
    parser.add_argument('--observations',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--repeats',type=int,default=20)
    args=parser.parse_args();torch.set_num_threads(1);torch.manual_seed(873)
    saved=torch.load(args.checkpoint,map_location='cpu',mmap=True,weights_only=False)
    fixture=torch.load(args.observations,map_location='cpu',weights_only=False)
    records=[record for track,_ in fixture['tracks'] for record in track]
    records=[records[int(i)] for i in np.linspace(0,len(records)-1,32)]
    base=saved['model_spec'];hidden=base['hidden']
    report=dict(torch=torch.__version__,device=torch.cuda.get_device_name(),encoder_hidden=hidden,
                source_iteration=saved['iteration'],repeats=args.repeats,
                note='Warm neural forward only, recorded observations, no simulator or training. Candidate towers are untrained. CUDA graph padding is 32 for every shape.',rows=[])
    candidates=[('original',base['policy_depth'],None),('narrow64',64,None),
                ('wide64x512',64,512),('wide32x512',32,512),('wide16x1024',16,1024)]
    for name,depth,width in candidates:
        spec=deepcopy(base);spec.update(policy_depth=depth,value_depth=depth)
        if width is not None:spec['tower_width']=width
        model=make_model(spec)
        if name=='original':model.load_state_dict(saved['model'])
        else:
            # Hold all non-tower weights fixed. Fresh tower quality is unmeasured.
            state=model.state_dict()
            state.update({key:value for key,value in saved['model'].items() if not key.startswith(('policy_tower.','value_tower.'))})
            model.load_state_dict(state)
        model=model.cuda().eval();torch.cuda.reset_peak_memory_stats()
        with torch.inference_mode(),tower_graphs([model],32):
            for size in (1,8,32):
                rows=records[:size];observations=[r[0] for r in rows]
                masks=torch.as_tensor(np.stack([r[1] for r in rows]),device='cuda')
                memory=torch.as_tensor(np.stack([r[5] for r in rows]),device='cuda')
                previous=torch.tensor([r[6] for r in rows],device='cuda')
                def measure(call):
                    for _ in range(5):call()
                    torch.cuda.synchronize();times=[]
                    for _ in range(args.repeats):
                        started=time.perf_counter();result=call();torch.cuda.synchronize()
                        times.append((time.perf_counter()-started)*1000)
                    return dict(median_ms=statistics.median(times),p95_ms=sorted(times)[int(.95*(len(times)-1))])
                full=measure(lambda:model.act(observations,masks,memory,previous))
                encoder=measure(lambda:model.encode(observations,'cuda'))
                towers=measure(lambda:model.head_features(memory))
                entry=dict(candidate=name,depth=depth,tower_width=width or hidden,batch=size,
                           parameters=sum(p.numel() for p in model.parameters()),
                           full=full,encoder=encoder,towers=towers,
                           peak_allocated_mib=torch.cuda.max_memory_allocated()/2**20)
                report['rows'].append(entry);print(json.dumps(entry),flush=True)
                args.output.write_text(json.dumps(report,indent=2))
        del model;gc.collect();torch.cuda.empty_cache()
    report['completed']=True;args.output.write_text(json.dumps(report,indent=2))


if __name__=='__main__':main()
