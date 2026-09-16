import copy
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import torch
from tavern_rl.multi_horizon import enable,choose,economic_predictions
from tavern_rl.scene_value import enable as enable_scene,raw_predictions,physical,DEFAULTS,Benchmark
from tavern_rl.action_value import teach
from tavern_rl.reference_pool import ReferencePool
from tavern_rl.streaming import migrate_optimizer
from tavern_rl.model import make_model
from tavern_rl.features import prepare_entities
from tavern_rl.rollout import SimulationPool
import test_scene_value

class HorizonTests(unittest.TestCase):
 def setUp(self):torch.set_num_threads(1);torch.manual_seed(93)
 def model(self):
  m,obs=test_scene_value.SceneTests().model();enable_scene(m);return m,obs
 def test_migration_preserves_learned_scene_policy_and_adam(self):
  m,obs=self.model();opt=torch.optim.Adam(m.parameters());sum(p.square().sum() for p in m.parameters()).backward();opt.step()
  with torch.no_grad():m.scene_fusion.bias.uniform_(-1,1);m.scene_successor[-1].weight.uniform_(-.1,.1)
  old=copy.deepcopy(m.state_dict());saved=copy.deepcopy(opt.state_dict());names=list(dict(m.named_parameters()))
  mask=torch.ones(1,m.action_size,dtype=torch.bool);memory=torch.zeros(1,16);previous=torch.tensor([m.action_size]);m.eval()
  with torch.no_grad():before=m.act([obs],mask,memory,previous)
  enable(m)
  with torch.no_grad():after=m.act([obs],mask,memory,previous)
  torch.testing.assert_close(before[0].probs,after[0].probs,rtol=0,atol=0)
  torch.testing.assert_close(before[1],after[1],rtol=0,atol=0)
  for k,v in old.items():torch.testing.assert_close(m.state_dict()[k],v,rtol=0,atol=0)
  self.assertEqual(list(dict(m.named_parameters()))[:len(names)],names)
  restored=make_model(m.specification());restored.load_state_dict(m.state_dict())
  self.assertEqual(list(dict(m.named_parameters())),list(dict(restored.named_parameters())))
  newopt=torch.optim.Adam(m.parameters());newopt.load_state_dict(migrate_optimizer(saved,m))
  for k,v in saved['state'].items():torch.testing.assert_close(newopt.state_dict()['state'][k]['exp_avg'],v['exp_avg'])
 def test_same_action_learns_different_future_horizons_and_economy(self):
  m,_=self.model();enable(m);raw=[None]*m.schema['count'];raw[0]=dict(id=1,details=dict(gold=3))
  labels=[]
  for h in (1,3,5):
   strong=h==5
   labels.append(dict(row=dict(entities=raw,legal=list(range(m.action_size)),memory=[0.]*16,previous=m.action_size),actions=[0],values=[0.],paired_standard_errors=[0.],
    scene=dict(horizon=h,current=None,future=[[1.,0.,0.,.5,0.,0.] if strong else [0.,1.,0.,0.,.5,1.]],resources=[[3.]*8 if strong else [0.]*8],leaves=[])))
  opt=torch.optim.Adam(m.parameters(),lr=.02);config=dict(max_grad_norm=1.,scene_value=dict(DEFAULTS))
  for _ in range(100):result=teach(m,opt,labels,config,'cpu')
  self.assertEqual(result['economic_actions'],3)
  e=m.encode([prepare_entities(raw)],'cpu');memory=m.recurrent_step(e,torch.zeros(1,16),torch.tensor([m.action_size]))
  short=physical(raw_predictions(m,e,memory,1)[1])[0,0,0];long=physical(raw_predictions(m,e,memory,5)[1])[0,0,0]
  self.assertGreater(float((long-short).detach()),.5)
  self.assertGreater(float((economic_predictions(m,e,memory,5)[0,0].mean()-economic_predictions(m,e,memory,1)[0,0].mean()).detach()),1.)
  self.assertTrue(all(torch.isfinite(p).all() for p in m.parameters()))
 def test_reference_pool_bounds_turns_rules_and_excludes_same_game(self):
  with tempfile.TemporaryDirectory() as directory,closing(SimulationPool(1)) as pool:
   pool.simulators[0].reset(123,{})
   snapshot=pool.simulators[0].call('snapshot');before=copy.deepcopy(snapshot)
   bank=ReferencePool(directory,snapshot['sourceHash'],capacity=8)
   self.assertEqual(bank.offer(snapshot),8);self.assertEqual(snapshot,before)
   self.assertFalse(bank.panel(1,123,0,3));self.assertFalse(bank.panel(2,124,0,3))
   self.assertEqual(len(bank.panel(1,124,0,3)),3)
   snapshot['actionsInTurn'][0]=1;self.assertEqual(bank.offer(snapshot),0)
   snapshot['actionsInTurn'][0]=0;snapshot['seed']=124;bank.offer(snapshot)
   self.assertLessEqual(len(__import__('json').loads(next(bank.root.glob('*.json')).read_text())),8)
   snapshot['sourceHash']='wrong'
   with self.assertRaises(ValueError):bank.offer(snapshot)
 def test_real_warmup_branches_match_turns_and_cold_pool_keeps_economy(self):
  with tempfile.TemporaryDirectory() as directory,closing(SimulationPool(2)) as pool:
   from tavern_rl.deep_model import DeepEntityActorCritic
   from tavern_rl.streaming import enable_auxiliary
   from tavern_rl.action_value import enable as enable_actions
   m=DeepEntityActorCritic(pool.meta['entitySchema'],pool.meta['actions'],hidden=16,heads=2,layers=1,policy_depth=4,value_depth=4)
   enable_auxiliary(m);enable_actions(m);enable_scene(m);enable(m)
   opts=dict(maxActionsPerTurn=3,maxSteps=30000,recordFrames=False)
   _,_,_=pool.collect(m,[],[9871,9872],opts,'cpu',streaming=dict(turns=7,auxiliary_coef=.1),reference_pool=directory)
   self.assertTrue((Path(directory)/pool.meta['sourceHash']/'turn-007.json').exists())
   pool.streaming_state=None
   for h in (1,3,5):
    with patch('tavern_rl.multi_horizon.choose',return_value=h):
     tracks,_,perf=pool.collect(m,[],[9880+h],opts,'cpu',learner_seats=8,streaming=dict(turns=2,auxiliary_coef=.1),
      counterfactual=dict(roots=1,trials=4,min_trials=4,candidates=4,workers=8,horizon=2,terminal_fraction=0.),scene_value=dict(DEFAULTS),multi_horizon=dict(reference_dir=directory))
    label=pool.branch_labels[0];scene=label['scene'];turn=pool.branch_reports[0]['turn']
    self.assertEqual(scene['horizon'],h);self.assertEqual(perf['counterfactual'][f'horizon_{h}_roots'],1)
    self.assertIsNotNone(scene['future']);self.assertEqual(len(scene['resources']),len(label['actions']))
    self.assertEqual(set(scene['reference_panels']),{str(turn),str(turn+h)})
    for t,keys in scene['reference_panels'].items():self.assertTrue(all(int(k.split(':')[-1])==int(t) for k in keys))
    result=teach(m,torch.optim.Adam(m.parameters()),[label],dict(max_grad_norm=1.,scene_value=dict(DEFAULTS)),'cpu');self.assertGreater(result['economic_actions'],0)
    pool.streaming_state=None
   # Exact-turn absence never substitutes an earlier panel.
   pool.simulators[0].reset(9991,opts)
   root=dict(snapshot=pool.simulators[0].call('snapshot'),seed=9991,seat=0,turn=1,horizon=5,priority=71,actions=[0],scene_value=dict(DEFAULTS),multi_horizon=dict(reference_dir=str(Path(directory)/'cold')))
   benchmark=Benchmark(root)
   try:
    self.assertIsNone(benchmark.current['target'])
    self.assertEqual(benchmark.current['battles'],0)
   finally:benchmark.close()
 def test_sampler_allocates_most_roots_to_short_horizons(self):
  counts={h:sum(choose(i)==h for i in range(2000)) for h in (1,3,5)}
  self.assertGreater(counts[1],1200);self.assertGreater(counts[3],300);self.assertGreater(counts[5],100)

if __name__=='__main__':unittest.main()
