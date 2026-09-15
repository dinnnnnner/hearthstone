import argparse
import copy
import unittest

import torch
from tavern_rl.training_performance import add_arguments, apply_overrides, make_optimizer


class TrainingPerformanceTests(unittest.TestCase):
    def test_resume_removes_old_gold_rule_and_preserves_placement_and_ppo_settings(self):
        parser = argparse.ArgumentParser()
        parser.add_argument('--resume')
        add_arguments(parser)
        config = dict(sequence_batch_size=16, fused_adam=True, epochs=2,
                      unused_gold_penalty=.01, first_place_bonus=1.)
        original = dict(config)
        original.pop('unused_gold_penalty')
        original['reward_mode'] = 'placement_only'
        apply_overrides(config,parser.parse_args(['--resume','latest.pt']))
        self.assertEqual(config,original)
        apply_overrides(config,parser.parse_args(['--resume','latest.pt',
            '--resume-sequence-batch-size','32','--no-fused-adam','--training-graphs']))
        self.assertEqual(config,dict(original,sequence_batch_size=32,fused_adam=False,training_graphs=True))
        apply_overrides(config,parser.parse_args(['--resume','latest.pt','--no-training-graphs']))
        self.assertFalse(config['training_graphs'])
        with self.assertRaises(ValueError):
            apply_overrides(config,parser.parse_args(['--resume-sequence-batch-size','32']))

    def check_restored_step(self, device, fused):
        torch.manual_seed(83)
        model = torch.nn.Linear(8,2).to(device)
        old = torch.optim.Adam(model.parameters(),lr=.001,eps=1e-5)
        x = torch.randn(3,8,device=device)
        model(x).square().sum().backward();old.step()
        state = copy.deepcopy(old.state_dict())
        restored = make_optimizer(model,dict(learning_rate=.002,fused_adam=fused),state)
        self.assertEqual(restored.param_groups[0]['lr'],.002)
        expected_fused = fused and device == 'cuda'
        self.assertEqual(bool(restored.param_groups[0]['fused']),expected_fused)
        for parameter in model.parameters():
            self.assertEqual(restored.state[parameter]['step'].item(),1)
            if expected_fused:self.assertTrue(restored.state[parameter]['step'].is_cuda)
        before = [p.detach().clone() for p in model.parameters()]
        restored.zero_grad();model(x).square().sum().backward();restored.step()
        self.assertTrue(any(not torch.equal(a,b) for a,b in zip(before,model.parameters())))
        self.assertTrue(all(s['step'].item()==2 for s in restored.state.values()))

    def test_fused_checkpoint_can_resume_on_cpu(self):
        self.check_restored_step('cpu',True)

    @unittest.skipUnless(torch.cuda.is_available(),'CUDA required')
    def test_old_adam_state_can_switch_to_fused_cuda_and_continue(self):
        self.check_restored_step('cuda',True)


if __name__ == '__main__':
    unittest.main()
