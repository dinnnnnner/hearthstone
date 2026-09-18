from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch, MagicMock
import unittest
import numpy as np
import torch
from tavern_rl.bridge import Simulator
from tavern_rl.features import prepare_entities
from tavern_rl.inference_features import HostEntityBatch
from tavern_rl.ledger_model import LedgerActorCritic
from tavern_rl.ledger_training import LedgerTargets, COEFFICIENTS, attach_outcomes, supervision_loss, configure
from tavern_rl.model import make_model
from tavern_rl.train import parser
from tavern_rl.serve import Policy


class LedgerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        with Simulator() as simulator:
            cls.view=simulator.reset(912);cls.meta=simulator.meta

    def setUp(self):
        torch.manual_seed(15)
        self.raw=deepcopy(self.view['entities'])
        # The same minion is simultaneously represented in board, shop and hand.
        first=next(e for e in self.raw if e and e['zone']==2)
        for zone in (1,4):
            slot=self.meta['entitySchema']['offsets'][zone]
            self.raw[slot]=dict(deepcopy(first),zone=zone,position=0)
        self.obs=prepare_entities(self.raw)
        self.model=LedgerActorCritic(self.meta['entitySchema'],self.meta['actions'],hidden=16,heads=2,layers=1)
        self.mask=torch.zeros(1,self.model.action_size,dtype=torch.bool);self.mask[0,self.view['legalActions']]=True
        self.previous=torch.tensor([self.model.action_size])

    def forward(self):
        return self.model.explain([self.obs],self.mask,self.model.initial_memory(1,'cpu'),self.previous)

    def test_present_masks_and_board_sum_survive_zero_weights_and_packed_inference(self):
        for parameter in self.model.parameters():parameter.data.zero_()
        dist,value,memory,ledger=self.forward()
        self.assertAlmostEqual(float(ledger['board']),1.,places=6)
        self.assertEqual(float(ledger['contributions'].sum()),float(ledger['board']))
        self.assertEqual(int(torch.count_nonzero(ledger['contributions'])),1)
        self.assertEqual(float(ledger['contributions'][0,8]),0.,'shop never enters board sum')
        packed=HostEntityBatch.prepare([self.obs],self.model.schema,{})
        torch.testing.assert_close(self.model.encode([self.obs],'cpu'),self.model.encode(packed,'cpu'))
        self.assertAlmostEqual(float(dist.probs.sum()),1.,places=6)
        restored=make_model(self.model.specification());restored.load_state_dict(self.model.state_dict())
        torch.testing.assert_close(value,restored.act([self.obs],self.mask,restored.initial_memory(1,'cpu'),self.previous)[1])

    def test_rule_labels_are_shared_and_supervised_heads_receive_gradients(self):
        teacher=LedgerTargets(self.meta)
        try: label=teacher.score([self.raw])[0]
        finally: teacher.close()
        offsets=self.meta['entitySchema']['offsets']
        self.assertEqual(label['cards'][offsets[1]],label['cards'][offsets[2]])
        self.assertEqual(label['cards'][offsets[1]],label['cards'][offsets[4]])
        label.update(combat=1,future=[4,2,0])
        encoded=self.model.encode([self.obs],'cpu')
        memory=self.model.recurrent_step(encoded,self.model.initial_memory(1,'cpu'),self.previous)
        loss,report=supervision_loss(self.model,encoded,memory,[label],dict(coefficients=COEFFICIENTS))
        self.assertTrue(torch.isfinite(loss));self.assertEqual(report['combat_labels'],1)
        loss.backward()
        for head in ('card_body','card_adjustment','economy_head','future_economy_head','combat_head'):
            gradient=sum(float(p.grad.abs().sum()) for p in getattr(self.model,head).parameters() if p.grad is not None)
            self.assertGreater(gradient,0.,head)

    def test_ppo_does_not_redefine_auxiliary_output_units(self):
        dist,value,_,_=self.forward()
        (-dist.log_prob(torch.tensor([self.view['legalActions'][0]])).sum()+value.square().sum()).backward()
        for head in ('card_body','card_adjustment','economy_head','future_economy_head'):
            self.assertTrue(all(p.grad is None for p in getattr(self.model,head).parameters()),head)
        self.assertTrue(any(p.grad is not None and p.grad.abs().sum()>0 for p in self.model.ledger_fusion.parameters()))

    def test_future_and_combat_are_real_labels_for_the_correct_round_and_seat(self):
        rows=[dict(turn=2,end=False),dict(turn=2,end=True),dict(turn=1,end=True)]
        game=dict(controllers=[-1,0],ledger_targets=[rows,deepcopy(rows)])
        state=dict(turn=3,gold=5,tier=2,health=20,season=dict(nextGold=1),battles=[dict(turn=2,result='loss')])
        snapshot=dict(room=dict(seats=[dict(game=state),dict(game=deepcopy(state))]))
        attach_outcomes(game,snapshot,2)
        self.assertNotIn('combat',rows[0]);self.assertEqual(rows[1]['combat'],1)
        self.assertNotIn('combat',rows[2]);self.assertEqual(rows[0]['future'],[5,2,1])
        self.assertNotIn('future',rows[2]);self.assertNotIn('future',game['ledger_targets'][1][0])

    def test_training_fingerprint_conflicts_and_served_ledger(self):
        config=dict(gamma=1.)
        args=parser().parse_args(['--architecture','entity-gru-ledger'])
        configure(config,args,self.model,self.meta)
        configure(config,args,self.model,self.meta)
        config['ledger']['implementation_hash']='wrong'
        with self.assertRaisesRegex(ValueError,'changed'):configure(config,args,self.model,self.meta)
        with self.assertRaisesRegex(ValueError,'incompatible'):
            configure({},parser().parse_args(['--basic-feedback']),self.model,self.meta)
        policy=Policy.__new__(Policy);policy.model=self.model.eval()
        policy.metadata=dict(contract='test',checkpointSha256='test');policy.search=None
        policy.decisions=policy.elapsed=0
        request=dict(contract='test',judgment=True,probabilities=True,rows=[dict(entities=self.raw,
            legal=self.view['legalActions'],memory=[0.]*16,previous=self.model.action_size)])
        response=policy.predict(request)['rows'][0]
        self.assertAlmostEqual(sum(c['contribution'] for c in response['ledger']['cards']),response['ledger']['boardStrength'],places=5)
        self.assertAlmostEqual(sum(response['ledger']['combat']),1.,places=5)
        self.assertAlmostEqual(sum(p for _,p in response['probabilities']),1.,places=5)
        request['judgment']=False
        self.assertNotIn('ledger',policy.predict(request)['rows'][0])

    def test_search_restores_root_and_leaf_potential_once(self):
        from tavern_rl.recruit_search import SearchPolicy, Evaluation, VERSION
        simulator=MagicMock();simulator.meta=dict(contract='test',searchVersion=VERSION)
        scorer=MagicMock();scorer.score.return_value=[.08]
        model=MagicMock();model.specification.return_value=dict(policy_depth=64,value_depth=64,entity_schema={})
        with patch('tavern_rl.bridge.Simulator',return_value=simulator),patch('tavern_rl.basic_feedback.BasicFeedback',return_value=scorer):
            search=SearchPolicy(model,dict(contract='test',valueConvention='placement-minus-basic-potential-v1',basicFeedback={'settings':'test'}),'unused')
        try:
            dist=SimpleNamespace(probs=torch.ones(1,1));model.act.return_value=(dist,torch.tensor([.42]),torch.zeros(1,16))
            search.model.action_size=1
            leaf=search.evaluate(dict(entities=self.raw,legal=[0]),[0.]*16,1)
            self.assertAlmostEqual(leaf.value,.5,places=6)
            root=Evaluation({0:1.},.42,[0.]*16)
            simulator.call.return_value=dict(supported=True)
            with patch('tavern_rl.recruit_search.search',return_value=(0,{})) as traverse:
                search.predict(dict(entities=self.raw,legal=[0],memory=[0.]*16,previous=1),root)
                self.assertAlmostEqual(traverse.call_args.args[1].value,.5,places=6)
                self.assertEqual(root.value,.42,'do not mutate/reapply correction to caller root')
            self.assertEqual(scorer.score.call_count,2)
        finally:search.close()
        scorer.close.assert_called_once()


if __name__=='__main__':unittest.main()
