import argparse,contextlib,gc,json,time
from pathlib import Path
import numpy as np
import torch
from tavern_rl.demonstrations import load_dataset
from tavern_rl.features import prepare_entities
from tavern_rl.model import make_model
from tavern_rl.sampling_graphs import tower_graphs
from tavern_rl.training_graphs import training_tower_graphs
from tavern_rl.selective_precision import bf16_tower_linears

def main():
 parser=argparse.ArgumentParser(description='Bounded BF16 tower precision and FP32-state benchmark')
 parser.add_argument('--candidates-root',type=Path,required=True)
 parser.add_argument('--dataset',type=Path,required=True)
 parser.add_argument('--output',type=Path,required=True)
 args=parser.parse_args();torch.set_num_threads(1)
 if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():raise RuntimeError('BF16 CUDA device required')
 base=args.candidates_root
 _,episodes,rejected=load_dataset(args.dataset,allow_incomplete_segments=True,allow_partial_start=True)
 if rejected or not episodes:raise ValueError('Use selected valid human records')
 allrows=[r for e in episodes for r in e['steps']];examples=[allrows[i] for i in np.linspace(0,len(allrows)-1,32,dtype=int)]
 report=dict(scope='Real human observations; inference latency and one-step supervised gradient benchmark, not PPO or games/sec',criticalPrecision='FP32 normalization, residual accumulation, GRU, policy/value heads, probabilities, losses, gradients and Adam; BF16 only tower linear GEMMs',rows=[])
 for depth in (64,256,1024):
  saved=torch.load(base/f'deep{depth}/best.pt',map_location='cpu',weights_only=False)
  for batch in (8,32):
   model=make_model(saved['model_spec']).cuda().eval();model.load_state_dict(saved['model'])
   rows=examples[:batch];obs=[prepare_entities(r['entities']) for r in rows]
   mask=torch.zeros(batch,model.action_size,dtype=torch.bool,device='cuda')
   for i,r in enumerate(rows):mask[i,r['legal']]=True
   memory=torch.zeros(batch,model.hidden,device='cuda');prev=torch.tensor([r['previous'] for r in rows],device='cuda')
   reference=None
   for precision in ('fp32','bf16_linear'):
    with bf16_tower_linears(model) if precision=='bf16_linear' else contextlib.nullcontext():
     with torch.inference_mode(),tower_graphs([model],batch) as graphs:
      for _ in range(3):dist,value,updated=model.act(obs,mask,memory,prev)
      torch.cuda.synchronize();torch.cuda.reset_peak_memory_stats();timings=[]
      for _ in range(12):
       start=time.perf_counter();dist,value,updated=model.act(obs,mask,memory,prev);dist.probs.cpu();value.cpu();updated.cpu();torch.cuda.synchronize();timings.append(time.perf_counter()-start)
      probs=dist.probs.clone();val=value.clone()
      assert probs.dtype==value.dtype==updated.dtype==torch.float32
      assert torch.isfinite(probs).all() and torch.isfinite(val).all() and not probs[~mask].any()
      if reference is None:reference=(probs,val)
      kl=(reference[0]*(reference[0].clamp_min(1e-30).log()-probs.clamp_min(1e-30).log())).sum(-1)
      row=dict(depth=depth,batch=batch,precision=precision,meanMs=float(np.mean(timings))*1000,p95Ms=float(np.quantile(timings,.95))*1000,meanKl=float(kl.mean()),maxValueError=float((val-reference[1]).abs().max()),maxProbabilityError=float((probs-reference[0]).abs().max()),graphReplays=sum(g.replays for g in graphs),peakMiB=torch.cuda.max_memory_allocated()/2**20)
      report['rows'].append(row);print(json.dumps(row),flush=True)
   del model,reference,probs,val,dist,value,updated;gc.collect();torch.cuda.empty_cache()
  # Large tower batch represents the flattened recurrent PPO head input.
  for precision in ('fp32','bf16_linear'):
   model=make_model(saved['model_spec']).cuda().train();model.load_state_dict(saved['model'])
   optimizer=torch.optim.Adam(model.parameters(),lr=1e-5,fused=True)
   x=torch.randn(512,128,device='cuda');times=[]
   with bf16_tower_linears(model) if precision=='bf16_linear' else contextlib.nullcontext():
    with training_tower_graphs(model) as graphs:
     for step in range(5):
      torch.cuda.synchronize();start=time.perf_counter();optimizer.zero_grad(set_to_none=True)
      value=model.policy_tower(x.detach().requires_grad_());loss=value.float().square().mean();loss.backward()
      torch.nn.utils.clip_grad_norm_(model.parameters(),.5,error_if_nonfinite=True);optimizer.step();torch.cuda.synchronize()
      if step>0:times.append(time.perf_counter()-start)
     assert all(p.dtype==torch.float32 and (p.grad is None or p.grad.dtype==torch.float32) for p in model.parameters())
     row=dict(depth=depth,precision=precision,scope='tower_forward_backward_adam',batch=512,meanMs=float(np.mean(times))*1000,loss=float(loss.detach()),graphReplays=sum(g.replays for g in graphs))
     report['rows'].append(row);print(json.dumps(row),flush=True)
   del model,optimizer,value,loss;gc.collect();torch.cuda.empty_cache()
 args.output.parent.mkdir(parents=True,exist_ok=True)
 args.output.write_text(json.dumps(report,indent=2)+'\n')

if __name__=='__main__':main()
