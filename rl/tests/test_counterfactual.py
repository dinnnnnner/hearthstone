import copy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import torch

from tavern_rl.counterfactual import BranchConfig, candidates, capture, configure, evaluate, targets, teach


class CounterfactualTests(unittest.TestCase):
    def test_explicit_migration_preserves_weights_config_and_removes_conflicting_modes(self):
        config=dict(learning_rate=3e-5,gold_planning=dict(direct=True),stage_feedback=dict(turns=[4]),first_place_bonus=1)
        configure(config,SimpleNamespace(counterfactual=True,branch_trials=12))
        self.assertNotIn('gold_planning',config);self.assertNotIn('stage_feedback',config)
        self.assertEqual(config['first_place_bonus'],1)
        self.assertEqual(config['counterfactual']['trials'],12)
        with self.assertRaises(ValueError):BranchConfig(trials=1)

    def test_candidates_cover_spending_sales_and_rotate_zero_prior_cards(self):
        types=['end','upgrade','refresh','buy','buy','buy','sell','sell','move','freeze','buySpell','play']
        priors=np.zeros(len(types));priors[8]=1
        rows=[candidates(list(range(len(types))),priors,types,key,8) for key in range(40)]
        for row in rows:
            self.assertTrue({0,1,2,3,6,10,11}.issubset(row));self.assertNotIn(8,row);self.assertNotIn(9,row)
        self.assertTrue({4,5,7}.issubset(set(a for row in rows for a in row)))

    def test_targets_require_all_paired_trials_and_report_uncertainty(self):
        options=BranchConfig(trials=3)
        row=dict(actions=[0,1],priors=[.9,.1],entities=[],legal=[0,1],memory=[0],previous=2,turn=4)
        label=targets(row,{0:[0,1,-1],1:[.5,1.5,-.5]},options)
        self.assertEqual(label['best'],1);self.assertEqual(label['baseline'],0)
        np.testing.assert_allclose(label['paired_advantages'],[0,.5])
        np.testing.assert_allclose(label['paired_standard_errors'],[0,0])
        self.assertAlmostEqual(sum(label['target']),1)
        self.assertIsNone(targets(row,{0:[0,1,-1],1:[.5,None,-.5]},options))

    def test_snapshot_capture_preserves_all_seat_memory_and_zero_gold_sale(self):
        class Simulator:
            def call(self,command):return dict(room=dict(turn=3),rng=123)
        pool=SimpleNamespace(branch_roots=[],simulators=[Simulator()],meta=dict(actions=[dict(type='end'),dict(type='sell')]))
        game=dict(state=dict(entities=[dict(details=dict(turn=3,gold=0,decisions=2))],legalActions=[0,1]),
                  branch_seen=set(),seed=12,worker=0,memory=[np.array([i],dtype=np.float32) for i in range(8)],
                  previous=list(range(8)),controllers=[-1]+[0]*7)
        capture(pool,game,0,[.5,.5],BranchConfig())
        game['memory'][1][0]=99;game['previous'][1]=99
        self.assertEqual(pool.branch_roots[0]['memories'][1][0],1)
        self.assertEqual(pool.branch_roots[0]['previous_all'][1],1)
        self.assertEqual(pool.branch_roots[0]['actions'],[0,1])

    def test_new_shop_decision_in_same_turn_remains_eligible(self):
        simulator=SimpleNamespace(call=lambda command:dict(rng=1,room=dict(turn=4)))
        pool=SimpleNamespace(branch_roots=[],simulators=[simulator],meta=dict(actions=[dict(type='end'),dict(type='buy')]))
        game=dict(state=dict(entities=[dict(details=dict(turn=4,gold=5,decisions=1))],legalActions=[0,1]),
            branch_seen=set(),seed=2,worker=0,memory=[np.zeros(1)]*8,previous=[2]*8,controllers=[-1]*8)
        capture(pool,game,0,[.5,.5],BranchConfig(roots=2))
        game['state']['entities'][0]['details'].update(gold=4,decisions=2)
        capture(pool,game,0,[.5,.5],BranchConfig(roots=2))
        self.assertEqual(len(pool.branch_roots),2)

    def run_branches(self,*,terminal_fraction=1.,max_steps=100,tempo=False):
        class Simulator:
            def __init__(self):self.restores=[]
            def call(self,command,**kwargs):
                if command=='snapshot':return dict(room=dict(seats=[dict(game=dict(tier=5 if self.choice else 4,health=40,battles=[dict(turn=8)]))]*8))
                assert command=='restore'
                self.saved=copy.deepcopy(kwargs['snapshot']);self.restores.append(copy.deepcopy(self.saved))
                self.tick=0;self.choice=None;return self.state()
            def state(self):
                done=self.tick>=6;place=1 if self.choice==1 else 8
                return dict(actor=None if done else self.tick%2,terminated=done,truncated=False,
                    legalActions=[] if done else [0,1],entities=[dict(details=dict(gold=float(self.choice or 0)))],
                    info=dict(turn=(8 if tempo else 1)+self.tick//2,placements=[place if done else None]+[None]*7,
                              rewards=[(4.5-place)/3.5 if done else 0]+[0]*7))
            def step(self,action):
                if self.tick==0:self.choice=action
                self.tick+=1;return self.state()
        class Model:
            def eval(self):return self
            def act(self,obs,masks,memory,previous,with_value=True):
                return torch.distributions.Categorical(probs=torch.ones(len(obs),2)/2),torch.tensor([x[0]['details']['gold'] for x in obs]),memory+1
        root=dict(priority=22,seed=32,seat=0,turn=8 if tempo else 1,snapshot=dict(rng=123,room=dict(turn=1)),
                  memories=[np.array([i],dtype=np.float32) for i in range(8)],previous_all=list(range(8)),
                  controllers=[-1]+[0]*7,actions=[0,1],priors=[.5,.5],
                  entities=[dict(details=dict(gold=3))],legal=[0,1],memory=[0.],previous=2)
        if tempo:root['tier_tempo']=dict(turn=8,tier4=.05,tier5=.025)
        pool=SimpleNamespace(branch_roots=[root],meta=dict(actionCount=2,actions=[dict(type='end'),dict(type='buy')]),
                             simulators=[Simulator(),Simulator()],executor=ThreadPoolExecutor(max_workers=2))
        before=copy.deepcopy(root)
        try:
            with patch('tavern_rl.counterfactual.prepare_entities',lambda x:x):
                labels,reports,metrics=evaluate(pool,{-1:Model(),0:Model()},'cpu',
                    BranchConfig(trials=3,horizon=1,terminal_fraction=terminal_fraction,max_steps=max_steps),1.)
            self.assertEqual(root['snapshot'],before['snapshot'])
            for a,b in zip(root['memories'],before['memories']):np.testing.assert_equal(a,b)
            rngs=[s['rng'] for simulator in pool.simulators for s in simulator.restores]
            self.assertEqual(sorted(np.unique(rngs,return_counts=True)[1].tolist()),[2,2,2])
            return labels,reports,metrics
        finally:pool.executor.shutdown()

    def test_full_branches_use_real_placement_and_isolated_paired_restore(self):
        labels,reports,metrics=self.run_branches()
        self.assertEqual(labels[0]['values'],[-1,2]);self.assertEqual(metrics['terminal_outcomes'],6)
        self.assertEqual(metrics['bootstrap_outcomes'],0);self.assertEqual(reports[0]['horizon'],'terminal')

    def test_short_branches_wait_for_own_decision_and_report_bootstrap(self):
        labels,_,metrics=self.run_branches(terminal_fraction=0.)
        self.assertEqual(labels[0]['values'],[0,1]);self.assertEqual(metrics['bootstrap_outcomes'],6)
        self.assertEqual(metrics['terminal_outcomes'],0)

    def test_cutoff_never_becomes_a_loss_or_fake_rank(self):
        labels,reports,metrics=self.run_branches(max_steps=1)
        self.assertEqual(labels,[]);self.assertEqual(metrics['cutoffs'],6)
        self.assertIsNone(reports[0]['label'])

    def test_branch_tempo_matches_real_reward_for_bootstrap_and_terminal(self):
        for fraction,expected in [(0.,[.05,1.075]),(1.,[-.95,2.075])]:
            labels,reports,_=self.run_branches(terminal_fraction=fraction,tempo=True)
            np.testing.assert_allclose(labels[0]['values'],expected)
            np.testing.assert_allclose(reports[0]['tempo_rewards'][1],[.075]*3)


if __name__=='__main__':unittest.main()
