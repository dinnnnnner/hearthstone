import copy
import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from test_recurrent import fixture
from tavern_rl.deep_model import DeepEntityActorCritic
from tavern_rl.league import fingerprint, mix_checkpoint, sampling_weights
from tavern_rl.train import atomic_checkpoint, frozen_models, league_entry


class LeagueTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(1);torch.manual_seed(23)
        self.schema,self.actions,self.obs=fixture()
        self.model=DeepEntityActorCritic(self.schema,self.actions,hidden=16,heads=2,layers=1,policy_depth=4,value_depth=4)
        self.meta=dict(schema='test',sourceHash='same-rules',actionVersion=2,actionCount=9,
            observationVersion=4,cardIds=['one'],heroIds=[],actions=self.actions,entitySchema=self.schema)
        self.saved=dict(meta=self.meta,model_spec=self.model.specification(),model=self.model.state_dict(),
            optimizer=torch.optim.Adam(self.model.parameters()).state_dict(),torch_rng=torch.get_rng_state(),
            iteration=2,episodes=8,config=dict(seed=42,league_size=8,learning_rate=3e-5),
            league=[league_entry(self.model,0,anchor=True),league_entry(self.model,2)])

    def opponent(self,root,name='opponent.pt',depth=8,seed=91):
        torch.manual_seed(seed)
        model=DeepEntityActorCritic(self.schema,self.actions,hidden=16,heads=2,layers=1,policy_depth=depth,value_depth=depth)
        payload=dict(meta=copy.deepcopy(self.meta),model_spec=model.specification(),model=model.state_dict(),episodes=32,config=dict(seed=seed))
        path=Path(root)/name;atomic_checkpoint(path,payload)
        return path,payload

    def test_mix_preserves_learner_optimizer_rng_and_restores_frozen_other_architecture(self):
        self.saved['config'].update(opponent_mode='self_history_only', packed_host_transfer=False,
            hero_pool={'format': 1, 'heroes': [{'id': f'hero-{i}'} for i in range(15)]})
        before=fingerprint(self.saved['model_spec'],self.saved['model'])
        with tempfile.TemporaryDirectory() as root:
            first,_=self.opponent(root)
            second,_=self.opponent(root,'second.pt',depth=12)
            result=mix_checkpoint(self.saved,[first,second],self.meta)
            self.assertEqual(before,fingerprint(result['model_spec'],result['model']))
            self.assertIs(result['optimizer'],self.saved['optimizer'])
            torch.testing.assert_close(result['torch_rng'],self.saved['torch_rng'])
            self.assertEqual(result['episodes'],8)
            self.assertEqual(result['iteration'],2)
            self.assertEqual(result['config']['learning_rate'],3e-5)
            self.assertEqual(result['config']['opponent_mode'],'mixed_self_play')
            self.assertEqual(self.saved['config']['opponent_mode'],'self_history_only')
            self.assertEqual(result['config']['hero_pool'],self.saved['config']['hero_pool'])
            self.assertFalse(result['config']['packed_host_transfer'])
            self.assertNotIn('external_opponent_fraction',self.saved['config'])
            self.assertEqual(len(self.saved['league']),2)
            restored=frozen_models(result['league'],result['model_spec'],'cpu')
            self.assertEqual([m.policy_tower.depth for m in restored],[4,8,12,4])
            self.assertTrue(all(not p.requires_grad for m in restored for p in m.parameters()))
            mask=torch.ones(1,9,dtype=torch.bool)
            with torch.inference_mode():
                for model in restored:
                    dist,_,state=model.act([self.obs],mask,model.initial_memory(1,'cpu'),torch.tensor([9]),with_value=False)
                    self.assertTrue(torch.isfinite(dist.probs).all())
                    self.assertTrue(torch.isfinite(state).all())

    def test_copy_and_reimport_do_not_duplicate_policy(self):
        with tempfile.TemporaryDirectory() as root:
            first,payload=self.opponent(root)
            second=Path(root)/'copy.pt';atomic_checkpoint(second,payload | dict(episodes=100))
            mixed=mix_checkpoint(self.saved,[first,second],self.meta)
            self.assertEqual(sum(e.get('external',False) for e in mixed['league']),1)
            again=mix_checkpoint(mixed,[second],self.meta)
            self.assertEqual(len(again['league']),len(mixed['league']))
            own=Path(root)/'self.pt';atomic_checkpoint(own,self.saved)
            own_mix=mix_checkpoint(self.saved,[own],self.meta)
            self.assertFalse(any(e.get('external') for e in own_mix['league']))

    def test_wrong_rules_schema_nonfinite_or_untrained_opponents_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path,payload=self.opponent(root)
            for kind in ['rules','schema','nonfinite','untrained']:
                bad=copy.deepcopy(payload)
                if kind=='rules':bad['meta']['sourceHash']='wrong'
                if kind=='schema':
                    bad['model_spec']['entity_schema']['definitions']={'1':dict(attack=999)}
                if kind=='nonfinite':bad['model']['critic.weight'][0,0]=float('nan')
                if kind=='untrained':bad['episodes']=0
                atomic_checkpoint(path,bad)
                with self.assertRaises(ValueError,msg=kind):mix_checkpoint(self.saved,[path],self.meta)
            self.assertEqual(len(self.saved['league']),2)

    def test_sampling_reserves_native_history_and_balances_external_lineages(self):
        league=[dict(generation=i,comparisons=100,learner_wins=90-i) for i in range(6)]
        original=np.array([1-(e['learner_wins']+2)/(e['comparisons']+4) for e in league])**2
        np.testing.assert_allclose(sampling_weights(league),.5/6+.5*original/original.sum())
        league += [dict(generation='a',external=True,lineage='256'),dict(generation='b',external=True,lineage='256'),
                   dict(generation='c',external=True,lineage='1024')]
        weights=sampling_weights(league,.4)
        self.assertAlmostEqual(sum(weights[:6]),.6)
        self.assertAlmostEqual(sum(weights[6:8]),.2)
        self.assertAlmostEqual(weights[8],.2)
        self.assertTrue((weights>0).all())
        self.assertAlmostEqual(sum(weights),1)
        for value in [0,1,-1,float('nan')]:
            with self.assertRaises(ValueError):sampling_weights(league,value)

    def test_import_must_leave_history_capacity(self):
        with tempfile.TemporaryDirectory() as root:
            paths=[self.opponent(root,f'{i}.pt',seed=90+i)[0] for i in range(4)]
            with self.assertRaisesRegex(ValueError,'history slots'):
                mix_checkpoint(self.saved,paths,self.meta)

    def test_population_refresh_retains_two_versions_and_preserves_native_history(self):
        with tempfile.TemporaryDirectory() as root:
            path,payload=self.opponent(root)
            mixed=self.saved
            for generation in range(6):
                payload['model']['critic.weight'].add_(.01)
                payload['episodes']=32+generation*16
                atomic_checkpoint(path,payload)
                mixed=mix_checkpoint(mixed,[path],self.meta,max_per_lineage=2)
            external=[e for e in mixed['league'] if e.get('external')]
            self.assertEqual([e['source_episodes'] for e in external],[96,112])
            self.assertEqual([e['generation'] for e in mixed['league'] if not e.get('external')],[0,2])
            external[-1]['comparisons']=100
            same=mix_checkpoint(mixed,[path],self.meta,max_per_lineage=2)
            self.assertEqual([e['comparisons'] for e in same['league'] if e.get('external')],[0,100])
            self.assertEqual(same['league_imports'][-1]['model_sha256s'],[])
            self.assertIs(same['optimizer'],self.saved['optimizer'])
            self.assertEqual(fingerprint(same['model_spec'],same['model']),fingerprint(self.saved['model_spec'],self.saved['model']))
            for limit in (0,-1,1.5,True):
                with self.assertRaises(ValueError):mix_checkpoint(mixed,[path],self.meta,max_per_lineage=limit)


if __name__=='__main__':unittest.main()
