import copy
import unittest
import numpy as np
import torch
from tavern_rl.scene_value import enable,physical,supervision,adjustment,DEFAULTS
from tavern_rl.action_value import enable as enable_actions,teach
from tavern_rl.card_value import enable as enable_cards
from tavern_rl.streaming import enable_auxiliary,migrate_optimizer
from tavern_rl.model import make_model
from tavern_rl.deep_model import DeepEntityActorCritic
from tavern_rl.features import prepare_entities
from tavern_rl.rollout import SimulationPool
from test_recurrent import fixture

class SceneTests(unittest.TestCase):
 def setUp(self):torch.set_num_threads(1);torch.manual_seed(91)
 def model(self):
  schema,actions,obs=fixture();m=DeepEntityActorCritic(schema,actions,hidden=16,heads=2,layers=1,policy_depth=4,value_depth=4)
  enable_auxiliary(m);enable_cards(m);enable_actions(m)
  return m,obs
 def test_migration_keeps_all_weights_policy_and_adam(self):
  m,obs=self.model();opt=torch.optim.Adam(m.parameters());sum(p.square().sum() for p in m.parameters()).backward();opt.step()
  weights=copy.deepcopy(m.state_dict());saved=copy.deepcopy(opt.state_dict());names=list(dict(m.named_parameters()))
  mask=torch.ones(1,m.action_size,dtype=torch.bool);mem=torch.zeros(1,16);prev=torch.tensor([m.action_size]);m.eval()
  with torch.no_grad():before=m.act([obs],mask,mem,prev)
  enable(m)
  with torch.no_grad():after=m.act([obs],mask,mem,prev)
  torch.testing.assert_close(before[0].probs,after[0].probs,rtol=0,atol=0);torch.testing.assert_close(before[1],after[1],rtol=0,atol=0)
  for k,v in weights.items():torch.testing.assert_close(m.state_dict()[k],v,rtol=0,atol=0)
  self.assertEqual(list(dict(m.named_parameters()))[:len(names)],names)
  restored=make_model(m.specification());restored.load_state_dict(m.state_dict())
  self.assertEqual(list(dict(m.named_parameters())),list(dict(restored.named_parameters())))
  nextopt=torch.optim.Adam(m.parameters());nextopt.load_state_dict(migrate_optimizer(saved,m))
  for k,v in saved['state'].items():torch.testing.assert_close(nextopt.state_dict()['state'][k]['exp_avg'],v['exp_avg'])
 def test_independent_combat_labels_train_heads_even_when_rank_targets_are_equal(self):
  m,obs=self.model();enable(m)
  raw=[None]*m.schema['count'];raw[0]=dict(id=1,details=dict(gold=3))
  label=dict(row=dict(entities=raw,legal=list(range(m.action_size)),memory=[0.]*16,previous=m.action_size),
   actions=[0,1],values=[0.,0.],paired_standard_errors=[0.,0.],scene=dict(current=[0.,1.,0.,0.,.5,1.],future=[[0.,1.,0.,0.,.5,1.],[1.,0.,0.,.5,0.,0.]],leaves=[]))
  opt=torch.optim.Adam(m.parameters(),lr=.003);cfg=dict(max_grad_norm=1.,scene_value=dict(DEFAULTS))
  for _ in range(50):result=teach(m,opt,[label],cfg,'cpu')
  self.assertGreater(result['scene_states'],0);self.assertGreater(result['scene_actions'],0)
  from tavern_rl.scene_value import raw_predictions
  e=m.encode([prepare_entities(raw)],'cpu');h=m.recurrent_step(e,torch.zeros(1,16),torch.tensor([m.action_size]))
  current,future=raw_predictions(m,e,h);scores=physical(future)
  self.assertGreater(scores[0,1,0].item(),scores[0,0,0].item()+.3)
  self.assertGreater(physical(current)[0,1].item(),.7)
  # Return gradients may learn fusion weights, but cannot redefine combat labels.
  m.zero_grad(set_to_none=True)
  with torch.no_grad():m.scene_fusion.bias[6]=1.
  adjustment(m,e,h).sum().backward()
  self.assertIsNone(m.scene_current[-1].weight.grad);self.assertIsNone(m.scene_successor[-1].weight.grad)
  self.assertGreater(m.scene_fusion.weight.grad.abs().sum().item(),0.)
  with torch.no_grad():
   m.scene_fusion.weight.zero_();m.scene_fusion.bias.zero_();m.scene_fusion.bias[6]=1.
   before=adjustment(m,e,h);m.scene_current[-1].bias[0]+=6.;after=adjustment(m,e,h)
   self.assertGreater(abs(float((after[0,1]-after[0,0])-(before[0,1]-before[0,0]))),1e-3)
 def test_real_branches_share_panel_and_produce_current_future_and_leaf_labels(self):
  pool=SimulationPool(2)
  try:
   m=DeepEntityActorCritic(pool.meta['entitySchema'],pool.meta['actions'],hidden=16,heads=2,layers=1,policy_depth=4,value_depth=4)
   enable_auxiliary(m);enable_actions(m);enable(m)
   tracks,games,perf=pool.collect(m,[],[942261],dict(maxActionsPerTurn=3,maxSteps=30000,recordFrames=False),'cpu',learner_seats=8,
    streaming=dict(turns=2,auxiliary_coef=.1),counterfactual=dict(roots=1,trials=4,min_trials=4,candidates=4,workers=8,horizon=1,terminal_fraction=0.),scene_value=dict(DEFAULTS))
   self.assertGreater(perf['counterfactual']['scene_battles'],0);self.assertEqual(perf['counterfactual']['cutoffs'],0)
   label=pool.branch_labels[0];scene=label['scene']
   self.assertEqual(len(scene['future']),len(label['actions']));self.assertEqual(len(scene['current']),6);self.assertTrue(scene['leaves'])
   self.assertEqual(len(scene['opponent_seats']),3);self.assertEqual(scene['trials'],4)
   self.assertNotIn('leaves',pool.branch_reports[0]['label']['scene'])
   self.assertNotIn('snapshot',label['row']);self.assertNotIn('opponents',label['row'])
   result=teach(m,torch.optim.Adam(m.parameters()),pool.branch_labels,dict(max_grad_norm=.5,scene_value=dict(DEFAULTS)),'cpu')
   self.assertGreater(result['scene_loss'],0);self.assertGreater(m.scene_current[-1].weight.abs().sum().item(),0)
  finally:pool.close()

if __name__=='__main__':unittest.main()
