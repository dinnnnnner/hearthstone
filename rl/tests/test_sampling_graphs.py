import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import torch
from tavern_rl.deep_model import ResidualTower
from tavern_rl.sampling_graphs import tower_graphs, accelerate_sampling


class SamplingGraphTests(unittest.TestCase):
    def test_cpu_and_training_preserve_gradient_and_state(self):
        model = ResidualTower(8, 4)
        x = torch.randn(3, 8)
        before = {k: v.clone() for k, v in model.state_dict().items()}
        expected = model(x)
        with tower_graphs([model, model], 4) as graphs:
            self.assertEqual(len(graphs), 1)
            actual = model(x)
            torch.testing.assert_close(actual, expected, rtol=0, atol=0)
            actual.square().sum().backward()
            self.assertTrue(all(p.grad is not None for p in model.parameters()))
        self.assertNotIn('forward', model.__dict__)
        self.assertEqual(set(before), set(model.state_dict()))
        for key, value in before.items():
            torch.testing.assert_close(value, model.state_dict()[key], rtol=0, atol=0)

    def test_restores_forward_on_exception(self):
        model = ResidualTower(8, 4)
        original = model.forward
        model.forward = original
        with self.assertRaisesRegex(RuntimeError, 'game failure'):
            with tower_graphs([model], 4):
                raise RuntimeError('game failure')
        self.assertIs(model.forward, original)

    def test_disabled_decorator_passes_arguments_and_result(self):
        result = object()
        @accelerate_sampling
        def collect(pool, current, opponents, seeds, options, device, **kwargs):
            self.assertEqual(kwargs['first_place_bonus'], 1.)
            self.assertEqual(seeds, [7, 8])
            return result
        with patch.dict(os.environ, {'TAVERN_SAMPLING_GRAPHS': '0'}):
            self.assertIs(collect(None, None, [], [7, 8], {}, 'cuda', first_place_bonus=1.), result)

    def test_frozen_patch_is_narrow_and_idempotent(self):
        file = Path(__file__).parents[2] / 'scripts' / 'enable-sampling-graphs.py'
        # Tests live under rl/tests, repository root is parents[2].
        spec = importlib.util.spec_from_file_location('sampling_patch', file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        source = 'from .bridge import Simulator\nclass Pool:\n    def collect(self, first_place_bonus=1.):\n        return first_place_bonus\n'
        changed = module.patch_source(source)
        self.assertIn('first_place_bonus=1.', changed)
        self.assertEqual(module.patch_source(changed), changed)
        with self.assertRaises(ValueError):
            module.patch_source('unknown')

    @unittest.skipUnless(torch.cuda.is_available(), 'CUDA required')
    def test_graph_records_replay_in_ppo(self):
        import numpy as np
        from test_recurrent import fixture
        from tavern_rl.deep_model import DeepEntityActorCritic
        from tavern_rl.model import ppo_update
        schema, actions, observation = fixture()
        torch.manual_seed(17)
        model = DeepEntityActorCritic(schema, actions, hidden=16, heads=2, layers=1,
                                     policy_depth=64, value_depth=64).cuda().eval()
        memory = model.initial_memory(1, 'cuda')
        previous = torch.tensor([len(actions)], device='cuda')
        mask = torch.ones(1, len(actions), dtype=torch.bool, device='cuda')
        records = []
        with torch.inference_mode(), tower_graphs([model], 16):
            for index in range(6):
                before = memory.cpu().numpy()[0].copy()
                distribution, values, updated = model.act([observation], mask, memory, previous)
                action = torch.tensor([index], device='cuda')
                records.append((observation, mask[0].cpu().numpy(), index,
                    float(distribution.log_prob(action)[0]), float(values[0]), before, int(previous[0])))
                memory, previous = updated, action
        config = dict(gamma=1., gae_lambda=.95, clip=.2, value_coef=.5, entropy_coef=.01,
                      max_grad_norm=.5, target_kl=.03, epochs=1, sequence_length=3,
                      burn_in=2, sequence_batch_size=2)
        stats = ppo_update(model, torch.optim.Adam(model.parameters(), lr=0.),
                           [(records, 2.), (records[:2], -1.)], config, 'cuda')
        self.assertTrue(all(np.isfinite(v) for v in stats.values()))
        self.assertLess(abs(stats['approx_kl']), 1e-6)
        self.assertEqual(stats['samples'], 8)
        self.assertTrue(all('forward' not in tower.__dict__ for tower in [model.policy_tower, model.value_tower]))

    @unittest.skipUnless(torch.cuda.is_available(), 'CUDA required')
    def test_cuda_outputs_new_inputs_release_and_parameter_update(self):
        torch.manual_seed(73)
        model = ResidualTower(128, 64).cuda().eval()
        before = {k: v.clone() for k, v in model.state_dict().items()}
        inputs = [torch.randn(b, 128, device='cuda') for b in [1, 3, 16, 2]]
        with torch.inference_mode():
            expected = [model(x).clone() for x in inputs]
            with tower_graphs([model], 16) as graphs:
                outputs = [model(x) for x in inputs]
                for a, b in zip(outputs, expected):
                    torch.testing.assert_close(a, b, rtol=2e-5, atol=2e-5)
                self.assertEqual(graphs[0].replays, len(inputs))
            self.assertIsNone(graphs[0].graph)
            for key, value in before.items():
                torch.testing.assert_close(value, model.state_dict()[key], rtol=0, atol=0)
        model.train()
        optimizer = torch.optim.SGD(model.parameters(), lr=.01)
        model(inputs[0]).square().sum().backward()
        optimizer.step()
        model.eval()
        with torch.inference_mode():
            expected = model(inputs[0]).clone()
            with tower_graphs([model], 16):
                torch.testing.assert_close(model(inputs[0]), expected, rtol=2e-5, atol=2e-5)


if __name__ == '__main__':
    unittest.main()
