import copy
import unittest
import numpy as np
import torch
from tavern_rl.action_value import enable,teach
from tavern_rl.card_value import enable as enable_cards
from tavern_rl.streaming import enable_auxiliary,migrate_optimizer
from tavern_rl.entity_model import EntityActorCritic
from tavern_rl.model import make_model,ppo_update
from test_recurrent import fixture

class ActionValueTests(unittest.TestCase):
 def setUp(self):
  torch.set_num_threads(1);torch.manual_seed(47)
  schema,_,self.obs=fixture()
  actions=[dict(type=t,source=0,target=0,position=0) for t in ['end','buy','refresh','upgrade']]
  self.model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1)
  enable_auxiliary(self.model);enable_cards(self.model)
  self.mask=torch.tensor([[True,True,True,False]])
 def forward(self):
  m=self.model;e=m.encode([self.obs],'cpu');h=m.recurrent_step(e,torch.zeros(1,16),torch.tensor([4]))
  return m.distribution_from(e,h,self.mask,with_action_values=True)
 def test_migration_preserves_policy_weights_adam_and_roundtrip(self):
  m=self.model;opt=torch.optim.Adam(m.parameters());sum(p.square().sum() for p in m.parameters()).backward();opt.step()
  old=copy.deepcopy(m.state_dict());state=copy.deepcopy(opt.state_dict());names=list(dict(m.named_parameters()))
  m.eval()
  with torch.no_grad():before=m.act([self.obs],self.mask,torch.zeros(1,16),torch.tensor([4]))
  enable(m)
  with torch.no_grad():d,v,q=self.forward()
  torch.testing.assert_close(before[0].probs,d.probs);torch.testing.assert_close(before[1],v)
  torch.testing.assert_close((d.probs*q).sum(-1),v)
  self.assertEqual(q.argmax(-1).item(),d.probs.argmax(-1).item());self.assertEqual(d.probs[0,3].item(),0.)
  for k,x in old.items():torch.testing.assert_close(m.state_dict()[k],x,rtol=0,atol=0)
  self.assertEqual(list(dict(m.named_parameters()))[:len(names)],names)
  restored=make_model(m.specification());restored.load_state_dict(m.state_dict())
  self.assertEqual(list(dict(restored.named_parameters())),list(dict(m.named_parameters())))
  opt=torch.optim.Adam(m.parameters());opt.load_state_dict(migrate_optimizer(state,m))
  for k,x in state['state'].items():torch.testing.assert_close(opt.state_dict()['state'][k]['exp_avg'],x['exp_avg'])
 def test_branch_return_regression_can_prefer_refresh_or_upgrade(self):
  enable(self.model);self.mask[:]=True
  entities=[None]*self.model.schema['count'];entities[0]=dict(id=1,details=dict(gold=3))
  label=dict(row=dict(entities=entities,legal=[0,1,2,3],memory=[0.]*16,previous=4),actions=[0,1,2,3],values=[-.5,-.2,.8,1.5],paired_standard_errors=[0.]*4)
  opt=torch.optim.Adam(self.model.parameters(),lr=.003)
  for _ in range(60):result=teach(self.model,opt,[label],dict(max_grad_norm=1.),'cpu')
  self.assertEqual(result['training_mode'],'action_value_regression')
  self.model.eval();dist,_,q=self.forward()
  self.assertGreater(q[0,3].item(),q[0,2].item());self.assertGreater(q[0,2].item(),q[0,1].item())
 def test_real_returns_update_q_without_ppo_kl_stop(self):
  m=self.model;enable(m);m.eval()
  with torch.no_grad():dist,v,_=self.forward()
  # Deliberately stale policy probability: Q regression must not use a PPO KL gate.
  record=(self.obs,self.mask[0].numpy(),1,-100.,float(v[0]),np.zeros(16,dtype=np.float32),4)
  cfg=dict(action_value=m.action_value_settings,gamma=1.,gae_lambda=.95,epochs=2,value_coef=.5,max_grad_norm=.5)
  opt=torch.optim.Adam(m.parameters(),lr=.003);result=ppo_update(m,opt,[([record],1.)],cfg,'cpu')
  self.assertEqual(result['training_mode'],'soft_action_value');self.assertEqual(result['optimizer_steps'],2)
  self.assertFalse(result['kl_early_stop']);self.assertGreater(result['action_value_loss'],0.)
  self.assertGreater(m.action_value_type.weight.abs().sum().item(),0.)

if __name__=='__main__':unittest.main()
