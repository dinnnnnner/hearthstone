import copy
import unittest

import torch

from tavern_rl.deep_model import DeepEntityActorCritic
from tavern_rl.model import make_model
from tavern_rl.train import parser, validate_resume_architecture
from test_recurrent import fixture


class WideModelTests(unittest.TestCase):
    @unittest.skipUnless(torch.cuda.is_available(),'CUDA required')
    def test_projection_gradients_match_with_training_graphs(self):
        from tavern_rl.deep_model import ProjectedResidualTower
        from tavern_rl.training_graphs import training_tower_graphs
        torch.manual_seed(71)
        eager=ProjectedResidualTower(128,512,64).cuda().train()
        captured=copy.deepcopy(eager)
        optimizers=[torch.optim.Adam(m.parameters(),lr=3e-5,fused=True) for m in (eager,captured)]
        with training_tower_graphs(captured) as graphs:
            for size in (32,32,7):
                inputs=torch.randn(size,128,device='cuda');target=torch.randn_like(inputs)
                outputs=[]
                for model,optimizer in zip((eager,captured),optimizers):
                    optimizer.zero_grad(set_to_none=True)
                    output=model(inputs)
                    (output-target).square().mean().backward()
                    outputs.append(output.detach().clone());optimizer.step()
                torch.testing.assert_close(*outputs,atol=2e-5,rtol=2e-5)
                for a,b in zip(eager.parameters(),captured.parameters()):
                    torch.testing.assert_close(a,b,atol=2e-6,rtol=2e-5)
            self.assertEqual(graphs[0].replays,2)

    def test_projected_towers_roundtrip_and_both_receive_gradients(self):
        torch.set_num_threads(1);torch.manual_seed(81)
        schema,actions,_=fixture()
        model=DeepEntityActorCritic(schema,actions,hidden=16,heads=2,layers=1,
                                  policy_depth=4,value_depth=8,tower_width=32)
        memory=torch.randn(3,16)
        policy,value=model.head_features(memory)
        self.assertEqual(policy.shape,memory.shape)
        self.assertEqual(value.shape,memory.shape)
        weights=torch.arange(16,dtype=torch.float32)
        ((policy*weights).sum()+(value*weights.flip(0)).sum()).backward()
        for tower in (model.policy_tower,model.value_tower):
            self.assertGreater(tower.input_projection.weight.grad.abs().sum().item(),0)
            self.assertGreater(tower.output_projection.weight.grad.abs().sum().item(),0)
        restored=make_model(model.specification());restored.load_state_dict(model.state_dict())
        for a,b in zip(model.head_features(memory),restored.head_features(memory)):
            torch.testing.assert_close(a,b,rtol=0,atol=0)
        validate_resume_architecture(parser().parse_args(['--tower-width','32']),model.specification())
        with self.assertRaisesRegex(ValueError,'requires a new run'):
            validate_resume_architecture(parser().parse_args(['--tower-width','64']),model.specification())

    def test_legacy_specification_keeps_original_checkpoint_keys(self):
        schema,actions,_=fixture()
        model=DeepEntityActorCritic(schema,actions,hidden=16,heads=2,layers=1,
                                  policy_depth=4,value_depth=4)
        self.assertNotIn('tower_width',model.specification())
        self.assertIn('policy_tower.blocks.0.branch.0.weight',model.state_dict())
        restored=make_model(model.specification());restored.load_state_dict(model.state_dict(),strict=True)


if __name__=='__main__':unittest.main()
