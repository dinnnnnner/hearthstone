import copy
import random
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import torch
from tavern_rl.gold_planning import PlanningConfig, GoldPlanner, capture, root_actions, targets_from_scores, teach, configure


class GoldPlanningTests(unittest.TestCase):
    def test_scores_average_random_outcomes_and_never_label_incomplete_branches(self):
        config=PlanningConfig(trials=3)
        result=targets_from_scores({0:[0,0,0],1:[1,1,1],2:[-2,-2,3],3:[10]},[.1,.1,.7,.1],config)
        self.assertEqual(result['best'],1)
        self.assertNotIn(3,result['actions'])
        self.assertLess(result['values'][2],0)
        self.assertIsNone(targets_from_scores({0:[0,0,0],1:[1]},[.5,.5],config))
        self.assertIsNone(targets_from_scores({0:[1,1,1],1:[1,1,1]},[.5,.5],config))

    def test_root_coverage_ignores_extreme_move_prior(self):
        types=['end','buy','buy','upgrade','refresh','move','freeze']
        actions=root_actions(list(range(7)),[0,0,0,0,0,.999,.001],types)
        self.assertEqual(set(actions),{0,1,2,3,4})

    def test_capture_is_bounded_and_does_not_consume_random_streams(self):
        pool=SimpleNamespace(planning_examples=[])
        before=random.getstate();numpy_before=np.random.get_state()
        for turn in range(1,50):
            g=dict(seed=42,state=dict(legalActions=[0,1],entities=[dict(details=dict(turn=turn,gold=3,decisions=1))]),
                   planning_seen=set(),memory=[np.zeros(2)],previous=[2])
            capture(pool,g,0,['end','buy'],4);capture(pool,g,0,['end','buy'],4)
        self.assertEqual(len(pool.planning_examples),4)
        self.assertEqual(len({r['turn'] for r in pool.planning_examples}),4)
        self.assertEqual(random.getstate(),before)
        np.testing.assert_equal(np.random.get_state(),numpy_before)

    def test_config_is_explicit_and_resumes_saved_settings(self):
        args=SimpleNamespace(gold_planning=None,planning_states=None)
        config={}
        with patch.dict('os.environ',{},clear=True):configure(config,args)
        self.assertNotIn('gold_planning',config)
        with patch.dict('os.environ',{'TAVERN_GOLD_PLANNING':'1'}):configure(config,args)
        self.assertEqual(config['gold_planning']['trials'],12)
        with patch.dict('os.environ',{},clear=True):configure(config,args)
        self.assertEqual(config['gold_planning']['states'],32)
        with self.assertRaises(ValueError):PlanningConfig(trials=1)
        with self.assertRaises(ValueError):PlanningConfig(strength=float('nan'))

    def test_trial_override_migrates_saved_config_and_cli_takes_precedence(self):
        args=SimpleNamespace(gold_planning=None,planning_states=None,planning_trials=None)
        config={'gold_planning':{'trials':3}}
        with patch.dict('os.environ',{},clear=True):configure(config,args)
        self.assertEqual(config['gold_planning']['trials'],3)
        with patch.dict('os.environ',{'TAVERN_PLANNING_TRIALS':'12'},clear=True):configure(config,args)
        self.assertEqual(config['gold_planning']['trials'],12)
        with patch.dict('os.environ',{},clear=True):configure(config,args)
        self.assertEqual(config['gold_planning']['trials'],12)
        args.planning_trials=6
        with patch.dict('os.environ',{'TAVERN_PLANNING_TRIALS':'12'},clear=True):configure(config,args)
        self.assertEqual(config['gold_planning']['trials'],6)
        args.planning_trials=None
        for invalid in ['1','13','1.5','invalid']:
            with patch.dict('os.environ',{'TAVERN_PLANNING_TRIALS':invalid},clear=True):
                with self.assertRaises(ValueError):configure(config,args)

    def test_multistep_upgrade_buy_play_beats_lucky_refresh_and_preserves_memory(self):
        self.assert_multistep_plan(3)

    def test_twelve_outcomes_keep_paired_seeds_and_multistep_comparison(self):
        self.assert_multistep_plan(12)

    def assert_multistep_plan(self,trials):
        types=['end','buy','play','upgrade','refresh']
        def view(gold=10,legal=None,value=0,ended=False,stage='root'):
            return dict(gold=gold,legal=legal if legal is not None else [0,1,3,4],ended=ended,
                        entities=[dict(details=dict(gold=gold,turn=5,decisions=0,budget=64,stage=stage,value=value))])
        class Batch:
            def call(self,command,**kwargs):
                if command=='release':return {}
                if command=='plan_open':
                    self.requests=kwargs['branches'];self.rows=[view() for _ in self.requests];self.routes=[[] for _ in self.requests]
                    return dict(views=copy.deepcopy(self.rows))
                output=[]
                for r in kwargs['actions']:
                    i,a=r['index'],r['action'];old=self.rows[i];route=self.routes[i];route.append(a)
                    if a==0:new=view(old['gold'],[],old['entities'][0]['details']['value'],True,'end')
                    elif a==3:new=view(5,[0,1],.2,stage='upgraded')
                    elif a==1:new=view(old['gold']-3,[0,2],.3,stage='bought')
                    elif a==2:new=view(old['gold'],[0],1.2 if 3 in route else .6,stage='played')
                    else:new=view(9,[0],[-2,-2,3][i%3],stage='refreshed')
                    self.rows[i]=new;output.append(copy.deepcopy(new))
                return output
        planner=GoldPlanner.__new__(GoldPlanner);planner.types=types;planner.config=PlanningConfig(states=1,trials=trials)
        planner.model=SimpleNamespace(eval=lambda:None);planner.simulator=Batch()
        memories=[]
        def evaluate(views,memory,previous):
            memories.extend(np.array(m).copy() for m in memory)
            return [(np.array([.001,.2,.2,.001,.598]),v['entities'][0]['details']['value'],np.array(m)+1) for v,m in zip(views,memory)]
        planner.evaluate=evaluate
        row=dict(view(),priority='fixed',memory=[7.],previous=5,turn=5)
        original=copy.deepcopy(row);labels,metrics,traces=planner.plan([row])
        self.assertEqual(row,original);self.assertEqual(labels[0]['best'],3)
        self.assertEqual(metrics['root_candidates']['upgrade'],1)
        if trials==3:
            self.assertTrue(any(t['actions']==['upgrade','buy','play','end'] and t['coins'][:3]==[10,5,2] for t in traces))
        seeds={a:[r['seed'] for r,route in zip(planner.simulator.requests,planner.simulator.routes) if route[0]==a] for a in [0,1,3,4]}
        self.assertTrue(all(s==seeds[0] for s in seeds.values()))
        self.assertEqual(len(set(seeds[0])),trials)
        self.assertEqual(metrics['completed_routes'],4*trials)
        self.assertEqual(labels[0]['trials'],trials)
        self.assertEqual(metrics['trials'],trials)
        self.assertLessEqual(len(planner.simulator.requests),96)
        self.assertEqual(float(memories[0][0]),7.)
        self.assertGreater(max(float(m[0]) for m in memories),8.)

    def test_auxiliary_update_learns_policy_without_updating_critic_parameters(self):
        from test_recurrent import fixture
        from tavern_rl.entity_model import EntityActorCritic
        schema,actions,_=fixture();torch.set_num_threads(1);torch.manual_seed(12)
        model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1)
        entities=[None]*schema['count'];entities[0]=dict(id=1,details=dict(gold=6))
        row=dict(entities=entities,legal=list(range(9)),memory=[0.]*16,previous=9)
        label=dict(row=row,actions=[0,1],target=[.05,.95])
        from tavern_rl.features import prepare_entities
        def prob():
            with torch.no_grad():
                d,_,_=model.act([prepare_entities(entities)],torch.ones(1,9,dtype=torch.bool),torch.zeros(1,16),torch.tensor([9]))
                return torch.softmax(d.logits[0,[0,1]],0)[1].item()
        before=prob();critic={n:p.detach().clone() for n,p in model.named_parameters() if n.startswith('critic.')}
        self.assertTrue(critic)
        result=teach(model,torch.optim.Adam(model.parameters(),lr=.003),[label],dict(gold_planning=PlanningConfig().__dict__,max_grad_norm=.5),'cpu')
        self.assertEqual(result['updates'],2);self.assertGreater(prob(),before)
        for name,p in model.named_parameters():
            if name in critic:torch.testing.assert_close(p,critic[name],rtol=0,atol=0)


if __name__=='__main__':unittest.main()
