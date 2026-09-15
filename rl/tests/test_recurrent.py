import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from tavern_rl.entity_model import EntityActorCritic, StringEncoder
from tavern_rl.features import prepare_entities, object_groups
from tavern_rl.model import ppo_update
from tavern_rl.train import prune_league, league_weights, atomic_checkpoint
from tavern_rl.arena import create_suite, read_suite, comparison, held_out


def fixture():
    sizes=[1,7,16,7,10,4,7,7,2,4,4,4]
    schema=dict(count=sum(sizes),ids=['one'],sizes=sizes,offsets=np.cumsum([0]+sizes[:-1]).tolist(),definitions={'1':dict(abilities=[dict(trigger='battlecry',effect='buff',attack=2)])})
    actions=[dict(type='end',source=0,target=0,position=0)]+[dict(type='play',source=0,target=0,position=i) for i in range(8)]
    entities=[None]*sum(sizes);entities[0]=dict(id=1,details=dict(gold=3,counters=dict(foo=2,bar=7)))
    return schema,actions,prepare_entities(entities)


class RecurrentTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(1);torch.manual_seed(17)
        schema,actions,self.obs=fixture()
        self.model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1)

    def test_conditional_tree_does_not_reward_more_position_choices(self):
        for parameter in self.model.parameters(): parameter.data.zero_()
        mask=torch.ones(1,9,dtype=torch.bool)
        dist,_,_=self.model.act([self.obs],mask,self.model.initial_memory(1,'cpu'),torch.tensor([9]))
        np.testing.assert_allclose(dist.probs.detach().numpy(),[[.5]+[.5/8]*8],atol=1e-6)
        mask[0,2:]=False
        dist,_,_=self.model.act([self.obs],mask,self.model.initial_memory(1,'cpu'),torch.tensor([9]))
        np.testing.assert_allclose(dist.probs.detach().numpy(),[[.5,.5]+[0]*7],atol=1e-6)

    def test_symbols_and_nested_effects_keep_order_and_distinct_fields(self):
        encoder=StringEncoder();out=encoder(['ab','ba'],'cpu')
        self.assertFalse(torch.equal(out[0],out[1]))
        a=object_groups(json.dumps(dict(effects=[dict(attack=3,health=1),dict(attack=1,health=3)])))
        b=object_groups(json.dumps(dict(effects=[dict(attack=1,health=3),dict(attack=3,health=1)])))
        self.assertNotEqual(a,b)
        self.model.eval()
        with torch.no_grad():
            first=self.model.encode([self.obs],'cpu')
            self.model.symbol.cache.update({f'extra-{i}':torch.zeros(24) for i in range(20001)})
            second=self.model.encode([self.obs],'cpu')
        torch.testing.assert_close(first,second)

    def test_source_and_target_branches_normalize_independently(self):
        schema,_,obs=fixture()
        actions=[dict(type='end',source=0,target=0,position=0)]
        actions += [dict(type='buy',source=i,target=0,position=0) for i in range(2)]
        actions += [dict(type='play',source=0,target=0,position=i) for i in range(2)]
        actions += [dict(type='play',source=1,target=t,position=i) for t in [1,2] for i in range(4)]
        model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1)
        for parameter in model.parameters():parameter.data.zero_()
        masks=torch.ones(1,len(actions),dtype=torch.bool)
        dist,_,_=model.act([obs],masks,model.initial_memory(1,'cpu'),torch.tensor([len(actions)]))
        expected=[1/3]+[1/6]*2+[1/12]*2+[1/48]*8
        np.testing.assert_allclose(dist.probs.detach().numpy()[0],expected,atol=1e-6)

    def test_sequence_update_has_finite_gradients_and_uses_history(self):
        model=self.model;model.eval();records=[];memory=model.initial_memory(1,'cpu');previous=torch.tensor([9]);mask=torch.ones(1,9,dtype=torch.bool)
        with torch.no_grad():
            for i in range(7):
                before=memory.numpy().copy()[0]
                dist,values,updated=model.act([self.obs],mask,memory,previous)
                action=torch.tensor([i%9])
                records.append((self.obs,mask[0].numpy(),int(action[0]),float(dist.log_prob(action)[0]),float(values[0]),before,int(previous[0])))
                memory=updated;previous=action
            reset=model.act([self.obs],mask,model.initial_memory(1,'cpu'),previous)[2]
            continued=model.act([self.obs],mask,memory,previous)[2]
            self.assertFalse(torch.equal(reset,continued))
        # LR zero isolates replay consistency: all burn-in/chunk log ratios must remain zero.
        config=dict(gamma=1,gae_lambda=.95,clip=.2,value_coef=.5,entropy_coef=.01,max_grad_norm=.5,target_kl=.03,
                    epochs=1,sequence_length=3,burn_in=2,sequence_batch_size=2)
        stats=ppo_update(model,torch.optim.Adam(model.parameters(),lr=0),[(records,1),(records[:2],-1)],config,'cpu')
        self.assertLess(abs(stats['approx_kl']),1e-6)
        self.assertEqual(stats['samples'],9)
        before=model.memory.weight_hh.detach().clone()
        stats=ppo_update(model,torch.optim.Adam(model.parameters(),lr=1e-4),[(records,1),(records[:2],-1)],config,'cpu')
        self.assertTrue(all(np.isfinite(v) for v in stats.values()))
        self.assertFalse(torch.equal(before,model.memory.weight_hh))
        self.assertGreater(model.memory.weight_hh.grad.abs().sum().item(),0)
        self.assertGreater(model.symbol.gru.weight_ih_l0.grad.abs().sum().item(),0)

    def test_league_keeps_anchors_older_and_recent_models(self):
        league=[dict(generation=i,anchor=i==0,comparisons=100,learner_wins=90 if i%2 else 10) for i in range(20)]
        keep=prune_league(league,6)
        self.assertEqual(len(keep),6)
        self.assertEqual(keep[0]['generation'],0);self.assertEqual(keep[-1]['generation'],19)
        self.assertTrue(any(0<e['generation']<10 for e in keep))
        weights=league_weights(league);self.assertAlmostEqual(weights.sum(),1)
        self.assertGreater(weights[0],weights[1]);self.assertTrue((weights>0).all())

    def test_collector_memory_is_per_seat_and_resets_between_games(self):
        from concurrent.futures import ThreadPoolExecutor
        from tavern_rl.rollout import SimulationPool
        class FakeSimulator:
            def reset(self,seed,options): self.tick=0;return self.state()
            def state(self):
                done=self.tick==16
                return dict(actor=None if done else self.tick%8,observation=[self.tick%8],legalActions=[0,1],terminated=done,truncated=False,
                            entities=[dict(details=dict(turn=self.tick//8+1,gold=3,decisions=self.tick))],
                            info=dict(placements=list(range(1,9)),rewards=list(range(8))))
            def step(self,action):self.tick+=1;return self.state()
        class CountingModel(torch.nn.Module):
            observation_kind='flat';recurrent=True;hidden=1
            def act(self,obs,masks,memory,previous,with_value=True):
                expected=torch.where(memory[:,0]==0,2,previous)
                if not torch.equal(previous,expected):raise AssertionError('Previous action leaked across games')
                return torch.distributions.Categorical(logits=torch.zeros_like(masks,dtype=torch.float32)),memory[:,0],memory+1
        pool=SimulationPool.__new__(SimulationPool);pool.simulators=[FakeSimulator()];pool.meta=dict(actionCount=2, actions=[dict(type="end"), dict(type="buy")])
        pool.executor=ThreadPoolExecutor(max_workers=1)
        try:
            tracks,games,_=pool.collect(CountingModel(),[],[1,2],{},'cpu',learner_seats=8)
            planned,_,_=pool.collect(CountingModel(),[],[1,2],{},'cpu',learner_seats=8,planning_states=4)
            self.assertEqual(len(pool.planning_examples),4)
            self.assertEqual([[r[2] for r in records] for records,_ in tracks],[[r[2] for r in records] for records,_ in planned])
        finally:pool.executor.shutdown()
        self.assertEqual(len(tracks),16)
        for records,_ in tracks:
            self.assertEqual([r[5].item() for r in records],[0,1])
            self.assertEqual(records[0][6],2)
            self.assertEqual(records[1][6],records[0][2])

    def test_fixed_suite_rejects_tampering_and_overlapping_seeds(self):
        model=self.model
        meta=dict(schema='test',sourceHash='same',observationVersion=3,actionVersion=2,actionCount=9,cardIds=[],heroIds=[],actions=model.actions)
        saved=dict(meta=meta,model_spec=model.specification(),model=model.state_dict(),config=dict(seed=42),episodes=10)
        with self.assertRaises(ValueError):held_out(saved,[51])
        held_out(saved,[52])
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);checkpoint=root/'model.pt';atomic_checkpoint(checkpoint,saved)
            suite=create_suite(root/'suite',[checkpoint],meta,games=8)
            self.assertEqual(read_suite(root/'suite',meta),suite)
            self.assertEqual([row.index(-1) for row in suite['schedule']],list(range(8)))
            with self.assertRaises(FileExistsError):create_suite(root/'suite',[checkpoint],meta,games=8)
            opponent=root/'suite'/suite['opponents'][0]['file'];opponent.write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError,'checksum'):read_suite(root/'suite',meta)

    def test_simulator_runs_while_next_policy_is_inferred(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from tavern_rl.rollout import SimulationPool
        stepped = Event()
        class FakeSimulator:
            def reset(self, seed, options):
                return dict(actor=0, observation=[0], legalActions=[0], terminated=False, truncated=False)
            def step(self, action):
                stepped.set()
                return dict(actor=None, terminated=True, truncated=False,
                            info=dict(placements=list(range(1, 9)), rewards=list(range(8))))
        class Policy(torch.nn.Module):
            observation_kind = 'flat'; recurrent = True; hidden = 1
            def __init__(self, wait=False): super().__init__(); self.wait = wait
            def act(self, obs, masks, memory, previous, with_value=True):
                if self.wait and not stepped.wait(timeout=2):
                    raise AssertionError('Simulator was held until every policy finished inference')
                if self.wait and with_value: raise AssertionError('Frozen opponent requested a critic')
                dist = torch.distributions.Categorical(probs=torch.ones(len(obs), 1))
                return dist, torch.zeros(len(obs)) if with_value else None, memory + 1
        pool = SimulationPool.__new__(SimulationPool)
        pool.simulators = [FakeSimulator(), FakeSimulator()]; pool.meta = dict(actionCount=1, actions=[dict(type="end")])
        pool.executor = ThreadPoolExecutor(max_workers=2)
        try:
            tracks, games, perf = pool.collect(Policy(), [Policy(wait=True)], [1, 2], {}, 'cpu',
                schedule=[[-1] * 8, [0] * 7 + [-1]])
        finally: pool.executor.shutdown()
        self.assertEqual(len(tracks), 1)
        self.assertEqual(len(games), 2)
        self.assertEqual(perf['environment_actions'], 2)
        self.assertEqual(perf['action_counts'], {'end': 2})
        self.assertEqual(perf['learner_action_counts'], {'end': 1})
        self.assertEqual(perf['mean_inference_batch'], 1)

    def test_comparison_needs_enough_games_and_clear_improvement(self):
        self.assertFalse(comparison([1]*8,[8]*8)['gate_passed'])
        self.assertFalse(comparison([4]*256,[4]*256)['gate_passed'])
        result=comparison([3]*256,[4]*256)
        self.assertTrue(result['gate_passed']);self.assertEqual(result['paired_95_percent_interval'],[-1.,-1.])


if __name__=='__main__':unittest.main()
