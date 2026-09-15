import copy
import unittest
import torch
from tavern_rl.deep_model import ResidualTower
from tavern_rl.training_graphs import training_tower_graphs


class TrainingGraphsTests(unittest.TestCase):
    def test_cpu_falls_back_and_restores_forward_after_failure(self):
        model = ResidualTower(8, 4)
        original = model.forward
        x = torch.randn(3, 8, requires_grad=True)
        expected = model(x)
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            with training_tower_graphs(model) as graphs:
                torch.testing.assert_close(model(x), expected)
                self.assertEqual(graphs[0].replays, 0)
                raise RuntimeError('injected')
        self.assertEqual(model.forward, original)
        self.assertNotIn('forward', model.__dict__)

    @unittest.skipUnless(torch.cuda.is_available(), 'CUDA required')
    def test_outputs_input_gradients_and_adam_updates_match_with_tail_batch(self):
        torch.manual_seed(18)
        eager = ResidualTower(128, 256).cuda().train()
        captured = copy.deepcopy(eager)
        optimizers = [torch.optim.Adam(m.parameters(), lr=3e-5, fused=True) for m in [eager,captured]]
        with training_tower_graphs(captured) as graphs:
            for count in [512,512,7,512]:
                x = torch.randn(count,128,device='cuda')
                target = torch.randn_like(x)
                outputs, gradients = [], []
                for model, optimizer in zip([eager,captured], optimizers):
                    optimizer.zero_grad(set_to_none=True)
                    inputs = x.detach().clone().requires_grad_()
                    output = model(inputs)
                    (output-target).square().mean().backward()
                    outputs.append(output.detach().clone());gradients.append(inputs.grad.detach().clone())
                    optimizer.step()
                torch.testing.assert_close(outputs[0], outputs[1], atol=2e-5, rtol=2e-5)
                torch.testing.assert_close(gradients[0], gradients[1], atol=2e-6, rtol=2e-5)
                for a,b in zip(eager.parameters(),captured.parameters()):
                    torch.testing.assert_close(a,b,atol=2e-6,rtol=2e-5)
            self.assertEqual(graphs[0].replays,3)
        self.assertNotIn('forward',captured.__dict__)


if __name__ == '__main__':unittest.main()
