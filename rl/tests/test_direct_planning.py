import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import torch
from tavern_rl.entity_model import EntityActorCritic
from tavern_rl.model import ppo_update
from tavern_rl.rollout import SimulationPool
from test_recurrent import fixture


class DirectPlanningTests(unittest.TestCase):
    def test_search_policy_update_ignores_ppo_likelihood_and_uses_final_placement(self):
        torch.set_num_threads(1);torch.manual_seed(12)
        schema,actions,obs=fixture();model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1)
        mask=np.ones(9,dtype=np.bool_)
        teacher=dict(action=1,actions=[0,1],target=[0.,1.])
        # Invalid old log-probabilities and absurd old value estimates must not enter
        # search cross-entropy or the terminal-placement value target.
        record=(obs,mask,1,float('nan'),9999.,np.zeros(16,dtype=np.float32),9,teacher)
        config=dict(gold_planning=dict(direct=True),gamma=1,gae_lambda=.95,clip=.2,value_coef=.5,entropy_coef=.01,
                    max_grad_norm=.5,target_kl=.03,epochs=1,sequence_length=2,burn_in=1,sequence_batch_size=2)
        model.eval()
        with torch.no_grad():
            dist,value,_=model.act([obs],torch.tensor(mask[None]),torch.zeros(1,16),torch.tensor([9]))
            before=torch.softmax(dist.logits[0,[0,1]],0)[1].item();expected=(value.item()-2.)**2
        frozen=ppo_update(model,torch.optim.Adam(model.parameters(),lr=0),[([record],2.)],config,'cpu')
        self.assertAlmostEqual(frozen['value_loss'],expected,places=5)
        stats=ppo_update(model,torch.optim.Adam(model.parameters(),lr=.003),[([record],2.)],config,'cpu')
        self.assertEqual(stats['training_mode'],'search_policy_value');self.assertEqual(stats['search_policy_samples'],1)
        self.assertTrue(np.isfinite(stats['policy_loss']));self.assertEqual(stats['approx_kl'],0)
        with torch.no_grad():
            dist,_,_=model.act([obs],torch.tensor(mask[None]),torch.zeros(1,16),torch.tensor([9]))
            self.assertGreater(torch.softmax(dist.logits[0,[0,1]],0)[1].item(),before)
        wrong=dict(config);wrong.pop('gold_planning')
        with self.assertRaisesRegex(ValueError,'not PPO'):
            ppo_update(model,torch.optim.Adam(model.parameters()),[([record],2.)],wrong,'cpu')
        fallback=(*record[:7],None)
        stats=ppo_update(model,torch.optim.Adam(model.parameters(),lr=0),[([fallback],-1.)],config,'cpu')
        self.assertEqual(stats['search_policy_samples'],0);self.assertEqual(stats['policy_loss'],0)

    def test_sampler_executes_search_action_and_records_real_previous_action(self):
        class Simulator:
            def reset(self,seed,options):self.tick=0;self.actions=[];return self.state()
            def state(self):
                return dict(actor=0,observation=[0],legalActions=[0,1],terminated=False,truncated=False,
                            entities=[dict(details=dict(turn=1,gold=3-self.tick,decisions=self.tick))])
            def step(self,action):
                self.actions.append(action);self.tick+=1
                if self.tick==2:return dict(actor=None,terminated=True,truncated=False,info=dict(placements=list(range(1,9)),rewards=[1]*8))
                return self.state()
        class Policy(torch.nn.Module):
            observation_kind='flat';recurrent=True;hidden=1
            def act(self,obs,masks,memory,previous,with_value=True):
                return torch.distributions.Categorical(probs=torch.tensor([[1.,0.]]*len(obs))),torch.zeros(len(obs)),memory+1
        class Planner:
            def __init__(self,*args):self.calls=0
            def choose(self,game,seat,evaluation):
                self.calls+=1
                return dict(action=1,actions=[0,1],target=[0.,1.])
            def metrics(self):return dict(decisions=self.calls)
            def close(self):pass
        pool=SimulationPool.__new__(SimulationPool);pool.simulators=[Simulator()]
        pool.meta=dict(actionCount=2,actions=[dict(type='end'),dict(type='buy')]);pool.executor=ThreadPoolExecutor(max_workers=1)
        try:
            with patch('tavern_rl.gold_planning.DirectPlanner',Planner):
                tracks,games,metrics=pool.collect(Policy(),[],[42],{},'cpu',direct_planning=dict(direct=True))
            records=tracks[0][0]
            self.assertEqual(pool.simulators[0].actions,[1,1]);self.assertEqual([r[2] for r in records],[1,1])
            self.assertEqual([r[6] for r in records],[2,1]);self.assertTrue(all(np.isnan(r[3]) for r in records))
            self.assertEqual(metrics['direct_planning']['decisions'],2)
        finally:pool.executor.shutdown()


if __name__=='__main__':unittest.main()
