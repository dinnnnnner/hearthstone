import hashlib,json,tempfile,unittest
from pathlib import Path
import torch
from tavern_rl.bootstrap_imitation import bootstrap
from tavern_rl.model import make_model
from test_recurrent import fixture


class BootstrapImitationTests(unittest.TestCase):
    def source(self):
        schema,actions,_=fixture();spec=dict(architecture='entity-gru',entity_schema=schema,actions=actions,hidden=16,heads=2,layers=1)
        model=make_model(spec)
        contract=hashlib.sha256(json.dumps(dict(actions=actions,entity_schema=schema),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        report=dict(initialization='random',updates=20,epoch=7,bestEpoch=7,bestValidationNll=2.,initialWeightSha256='initial',datasets=[],contract=contract)
        return dict(kind='fresh_human_imitation',report=report,model_spec=spec,model=model.state_dict(),imitation_optimizer=dict(old='discard'))

    def test_bootstrap_copies_best_weights_but_initializes_training_state(self):
        torch.set_num_threads(1);saved=self.source()
        meta=dict(actions=saved['model_spec']['actions'],entitySchema=saved['model_spec']['entity_schema'],observationVersion=4)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);torch.save(saved,root/'best.pt');original=(root/'best.pt').read_bytes()
            bootstrap(root/'best.pt',root/'ppo',meta)
            result=torch.load(root/'ppo/latest.pt',weights_only=False)
            self.assertEqual(result['episodes'],0);self.assertEqual(result['iteration'],0)
            self.assertEqual(result['optimizer']['state'],{});self.assertEqual(len(result['league']),1)
            self.assertEqual(result['config']['freshImitation']['bestEpoch'],7)
            self.assertNotIn('gold_planning',result['config'])
            self.assertTrue(result['config']['options']['aiActionLimits'])
            for name,value in saved['model'].items():
                torch.testing.assert_close(result['model'][name],value,rtol=0,atol=0)
                torch.testing.assert_close(result['league'][0]['weights'][name],value,rtol=0,atol=0)
            self.assertEqual(original,(root/'best.pt').read_bytes())
            model=make_model(result['model_spec']);model.load_state_dict(result['model'])
            self.assertTrue(all(p.requires_grad for p in model.parameters()))

    def test_rejects_non_best_and_wrong_contract_before_output(self):
        saved=self.source();meta=dict(actions=saved['model_spec']['actions'],entitySchema=saved['model_spec']['entity_schema'],observationVersion=4)
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for key,value in [('epoch',8),('contract','wrong')]:
                candidate={**saved,'report':{**saved['report'],key:value}};torch.save(candidate,root/'candidate.pt')
                with self.assertRaises(ValueError):bootstrap(root/'candidate.pt',root/'ppo',meta)
                self.assertFalse((root/'ppo').exists())


if __name__=='__main__':unittest.main()
