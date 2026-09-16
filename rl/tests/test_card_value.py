import copy
from types import SimpleNamespace
import unittest
import numpy as np
import torch
from tavern_rl.card_value import DEFAULTS,calibrate,configure,enable,evaluate,make_probe,predictions,teach
from tavern_rl.counterfactual import BranchConfig,capture
from tavern_rl.entity_model import EntityActorCritic
from tavern_rl.deep_model import DeepEntityActorCritic
from tavern_rl.features import prepare_entities
from tavern_rl.model import make_model
from tavern_rl.rollout import SimulationPool
from tavern_rl.streaming import enable_auxiliary,migrate_optimizer
from test_recurrent import fixture


class CardValueTests(unittest.TestCase):
    def setUp(self):torch.set_num_threads(1);torch.manual_seed(71)

    def test_gold_calibration_interpolates_and_does_not_call_bounds_prices(self):
        # Rank units change arbitrarily; the crossing remains 2.5 gold.
        cash=[0,1,2,3,4]
        for scale in (1.,.1):
            outcomes={0:[.5*scale]*4,**{i+1:[(k-2)*scale]*4 for i,k in enumerate(cash)}}
            label=calibrate(outcomes,cash,.01)
            self.assertAlmostEqual(label['gold'],2.5);self.assertEqual(label['bound'],'point')
        high={0:[2.]*4,1:[0.]*4,2:[1.]*4,3:[1.5]*4}
        self.assertEqual(calibrate(high,[0,1,2],.01)['bound'],'lower')
        self.assertIsNone(calibrate({0:[0.]*4,1:[0.]*4,2:[0.]*4},[0,1],.01))
        self.assertIsNone(calibrate({0:[0.]*4,1:[0.]*4,2:[None]*4},[0,1],.01))

    def test_severely_nonmonotonic_cash_does_not_make_a_target(self):
        self.assertIsNone(calibrate({0:[.5]*4,1:[0.]*4,2:[1.]*4,3:[-.5]*4},[0,1,2],.02))

    def test_old_deep_weights_optimizer_and_outputs_are_preserved(self):
        schema,actions,obs=fixture()
        for auxiliary in (False,True):
            model=DeepEntityActorCritic(schema,actions,hidden=16,heads=2,layers=1,policy_depth=4,value_depth=4)
            if auxiliary:enable_auxiliary(model)
            opt=torch.optim.Adam(model.parameters());sum(p.square().sum() for p in model.parameters()).backward();opt.step()
            old=copy.deepcopy(model.state_dict());state=copy.deepcopy(opt.state_dict());names=list(dict(model.named_parameters()))
            model.eval();mask=torch.ones(1,len(actions),dtype=torch.bool);memory=torch.zeros(1,16);previous=torch.tensor([len(actions)])
            with torch.no_grad():before=model.act([obs],mask,memory,previous)
            enable_auxiliary(model);enable(model)
            with torch.no_grad():after=model.act([obs],mask,memory,previous)
            torch.testing.assert_close(before[0].probs,after[0].probs,rtol=0,atol=0)
            torch.testing.assert_close(before[1],after[1],rtol=0,atol=0)
            for name,value in old.items():torch.testing.assert_close(model.state_dict()[name],value,rtol=0,atol=0)
            self.assertEqual(list(dict(model.named_parameters()))[:len(names)],names)
            restored=make_model(model.specification());restored.load_state_dict(model.state_dict())
            self.assertEqual(list(dict(restored.named_parameters())),list(dict(model.named_parameters())))
            next_opt=torch.optim.Adam(model.parameters());next_opt.load_state_dict(migrate_optimizer(state,model))
            for key,value in state['state'].items():torch.testing.assert_close(next_opt.state_dict()['state'][key]['exp_avg'],value['exp_avg'])

    def test_head_conditions_on_card_and_current_context_and_trains(self):
        schema,actions,obs=fixture();model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1);enable(model)
        original=[None]*schema['count'];original[0]=dict(id=1,zone=0,position=0,details=dict(gold=3));original[1]=dict(id=1,zone=1,position=0,details=dict(attack=2,health=2));changed=copy.deepcopy(original)
        changed[0]['details']['gold']=9
        changed[2]=dict(id=1,zone=1,position=1,details=dict(attack=10,health=10,extraAbilities=[dict(event='aura',op='brann')]))
        encoded=model.encode([prepare_entities(original),prepare_entities(changed)],'cpu')
        self.assertFalse(torch.equal(encoded[0,1],encoded[1,1]))
        labels=[dict(row=dict(entities=x,memory=[0.]*16,previous=len(actions)),slot=1,gold=gold,bound='point',weight=1.) for x,gold in [(original,1.5),(changed,4.)]]
        cfg=dict(card_value=dict(DEFAULTS),max_grad_norm=.5);optimizer=torch.optim.Adam(model.parameters(),lr=.001)
        for _ in range(100):result=teach(model,optimizer,labels,cfg,'cpu')
        self.assertEqual(result['cards'],2)
        encoded=model.encode([prepare_entities(original),prepare_entities(changed)],'cpu')
        memory=model.recurrent_step(encoded,torch.zeros(2,16),torch.full((2,),len(actions)))
        values=predictions(model,encoded,memory)
        self.assertTrue(torch.isfinite(values).all());self.assertGreater(float(values[1,1].detach()),float(values[0,1].detach()))
        self.assertGreater(model.card_value_head[-1].weight.abs().sum().item(),0)

    def test_policy_can_use_prices_without_changing_price_units_by_backprop(self):
        schema,actions,obs=fixture();model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1);enable(model)
        mask=torch.ones(1,len(actions),dtype=torch.bool);memory=torch.zeros(1,16);previous=torch.tensor([len(actions)])
        before=model.act([obs],mask,memory,previous)[0].probs.detach()
        with torch.no_grad():
            model.card_value_head[-1].bias.fill_(4.)
            model.card_value_type.weight[model.types.index('play'),2]=1.
        dist,_,_=model.act([obs],mask,memory,previous)
        self.assertGreater(float(dist.probs[0,1:].sum().detach()),float(before[0,1:].sum()))
        (-dist.log_prob(torch.tensor([1]))).backward()
        self.assertIsNone(model.card_value_head[-1].weight.grad)
        self.assertGreater(model.card_value_type.weight.grad.abs().sum().item(),0.)

    def test_real_simulator_resource_swaps_are_isolated_and_produce_reports(self):
        pool=SimulationPool(2)
        try:
            state=pool.simulators[0].reset(19,dict(maxActionsPerTurn=4,maxSteps=10000,recordFrames=False))
            model=EntityActorCritic(pool.meta['entitySchema'],pool.meta['actions'],hidden=16,heads=2,layers=1);enable(model)
            game=dict(state=state,seed=19,worker=0,branch_seen=set(),memory=[np.zeros(16,dtype=np.float32) for _ in range(8)],
                      previous=[model.action_size]*8,controllers=[-1]*8)
            pool.branch_roots=[];capture(pool,game,state['actor'],np.ones(model.action_size)/model.action_size,BranchConfig())
            root=pool.branch_roots[0];before=copy.deepcopy(root['snapshot']);options=dict(DEFAULTS,fraction=1.)
            probe=make_probe(root,pool.meta,options)
            self.assertIsNotNone(probe);self.assertEqual(probe['card_probe']['mode'],'purchase')
            seat=root['seat'];index=probe['card_probe']['position'];original=before['room']['seats'][seat]['game']
            removed=original['shop'][index]
            for key,variant in probe['variants'].items():
                if key==0:continue
                snapshot=variant['snapshot'];current=snapshot['room']['seats'][seat]['game']
                self.assertEqual(len(current['shop']),len(original['shop'])-1)
                self.assertNotIn(removed['uid'],[m['uid'] for m in current['shop']])
                self.assertLessEqual(current['gold'],current['season']['maxGold'])
                for identity,n in removed['copies'].items():self.assertEqual(snapshot['room']['pool'][identity],before['room']['pool'].get(identity,0)+n)
                view=pool.simulators[1].call('restore',snapshot=snapshot)
                self.assertEqual(view['actor'],seat);self.assertTrue(view['legalActions'])
            labels,reports,metrics=evaluate(pool,{-1:model},'cpu',BranchConfig(trials=4,min_trials=4,horizon=1,workers=8),1.,options)
            self.assertEqual(metrics['probes'],1);self.assertEqual(metrics['cutoffs'],0)
            self.assertEqual(reports[0]['card']['unit'],'gold_equivalent')
            self.assertEqual(root['snapshot'],before)
            self.assertNotIn('snapshot',reports[0]);self.assertIsNone(reports[0]['label'])
        finally:pool.close()


if __name__=='__main__':unittest.main()
