import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from torch import nn
from test_recurrent import fixture
from tavern_rl.deep_model import DeepEntityActorCritic, ResidualTower
from tavern_rl.entity_model import EntityActorCritic
from tavern_rl.model import make_model, ppo_update
from tavern_rl.train import parser, validate_resume_architecture, atomic_checkpoint, load_checkpoint, frozen_models


class DeepModelTests(unittest.TestCase):
    depth = 64
    def setUp(self):
        torch.set_num_threads(1); torch.manual_seed(17)
        self.schema, self.actions, self.obs = fixture()

    def model(self, depth=None):
        depth = self.depth if depth is None else depth
        return DeepEntityActorCritic(self.schema, self.actions, hidden=16, heads=2, layers=1,
                                    policy_depth=depth, value_depth=depth)

    def test_depth_and_roundtrip_keep_independent_policy_and_value_towers(self):
        model = self.model().eval()
        for tower in (model.policy_tower, model.value_tower):
            self.assertEqual(sum(isinstance(m, nn.Linear) for m in tower.modules()), self.depth)
            self.assertEqual(len(tower.blocks), self.depth // 4)
        policy_ids = {id(p) for p in model.policy_tower.parameters()}
        self.assertFalse(policy_ids.intersection(id(p) for p in model.value_tower.parameters()))
        copy = make_model(model.specification()).eval(); copy.load_state_dict(model.state_dict())
        mask = torch.tensor([[True, True] + [False] * 7])
        with torch.no_grad():
            first = model.act([self.obs], mask, model.initial_memory(1, 'cpu'), torch.tensor([9]))
            second = copy.act([self.obs], mask, copy.initial_memory(1, 'cpu'), torch.tensor([9]))
        torch.testing.assert_close(first[0].probs, second[0].probs)
        torch.testing.assert_close(first[1], second[1]); torch.testing.assert_close(first[2], second[2])
        self.assertTrue(torch.isfinite(first[1]).all())
        self.assertEqual(float(first[0].probs[:, 2:].sum()), 0.)

    def test_ppo_updates_every_layer_and_replays_burn_in_consistently(self):
        model = self.model().eval(); memory = model.initial_memory(1, 'cpu')
        previous = torch.tensor([9]); mask = torch.ones(1, 9, dtype=torch.bool); records = []
        with torch.no_grad():
            for i in range(5):
                before = memory.numpy()[0].copy()
                dist, value, updated = model.act([self.obs], mask, memory, previous)
                action = torch.tensor([i % 9])
                records.append((self.obs, mask[0].numpy(), int(action[0]), float(dist.log_prob(action)[0]),
                                float(value[0]), before, int(previous[0])))
                memory = updated; previous = action
        config = dict(gamma=1, gae_lambda=.95, clip=.2, value_coef=.5, entropy_coef=.01,
                      max_grad_norm=.5, target_kl=.03, epochs=1, sequence_length=3, burn_in=2, sequence_batch_size=8)
        tracks = [(records, 1.), (records[:2], -1.)]
        stats = ppo_update(model, torch.optim.Adam(model.parameters(), lr=0), tracks, config, 'cpu')
        self.assertLess(abs(stats['approx_kl']), 1e-6)
        weights = {k: p.detach().clone() for k, p in model.named_parameters() if '.branch.' in k and k.endswith('.weight')}
        stats = ppo_update(model, torch.optim.Adam(model.parameters(), lr=1e-4), tracks, config, 'cpu')
        self.assertTrue(all(np.isfinite(v) for v in stats.values()))
        for key, parameter in model.named_parameters():
            if key in weights:
                self.assertTrue(torch.isfinite(parameter.grad).all(), key)
                self.assertGreater(float(parameter.grad.abs().sum()), 0, key)
                self.assertFalse(torch.equal(weights[key], parameter), key)
        self.assertGreater(float(model.memory.weight_hh.grad.abs().sum()), 0)

    def test_legacy_architecture_and_checkpoint_still_load_without_new_weights(self):
        model = EntityActorCritic(self.schema, self.actions, hidden=16, heads=2, layers=1)
        copy = make_model(model.specification()); copy.load_state_dict(model.state_dict(), strict=True)
        self.assertFalse(any('tower' in k for k in copy.state_dict()))

    def test_checkpoint_and_league_restore_depth_and_reject_wrong_rules(self):
        model = self.model()
        meta = dict(actionVersion=2, actionCount=9, cardIds=[], heroIds=[], schema='test',
                    sourceHash='current-rules', observationVersion=4, actions=self.actions)
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'deep.pt'
            atomic_checkpoint(path, dict(meta=meta, model_spec=model.specification(), model=model.state_dict()))
            _, copy = load_checkpoint(path, meta)
            self.assertEqual(copy.policy_tower.depth, self.depth)
            self.assertEqual(copy.value_tower.depth, self.depth)
            with self.assertRaisesRegex(ValueError, 'sourceHash'):
                load_checkpoint(path, meta | dict(sourceHash='old-rules'))
        rivals = frozen_models([dict(weights=model.state_dict(), model_spec=model.specification())], {}, 'cpu')
        self.assertEqual(rivals[0].policy_tower.depth, self.depth)
        self.assertTrue(all(not p.requires_grad for p in rivals[0].parameters()))

    def test_bad_depth_and_resume_architecture_changes_are_rejected(self):
        for depth in (0, -4, 2, 63, 1.5):
            with self.assertRaises(ValueError): ResidualTower(16, depth)
        spec = self.model().specification()
        validate_resume_architecture(parser().parse_args([]), spec)
        validate_resume_architecture(parser().parse_args(['--policy-depth', str(self.depth)]), spec)
        with self.assertRaisesRegex(ValueError, 'new run'):
            validate_resume_architecture(parser().parse_args(['--policy-depth', '16']), spec)
        with self.assertRaisesRegex(ValueError, 'new run'):
            validate_resume_architecture(parser().parse_args(['--architecture', 'entity-gru']), spec)

    def test_opponent_inference_skips_critic_without_changing_policy_or_memory(self):
        model = self.model().eval()
        mask = torch.tensor([[True, True] + [False] * 7])
        inputs = ([self.obs], mask, model.initial_memory(1, 'cpu'), torch.tensor([9]))
        with torch.inference_mode():
            expected = model.act(*inputs)
            calls = []
            hook = model.value_tower.register_forward_hook(lambda *_: calls.append(True))
            try: actual = model.act(*inputs, with_value=False)
            finally: hook.remove()
        self.assertEqual(calls, [])
        self.assertIsNone(actual[1])
        torch.testing.assert_close(expected[0].probs, actual[0].probs, rtol=0, atol=0)
        torch.testing.assert_close(expected[2], actual[2], rtol=0, atol=0)
        self.assertFalse(any('option_parent' in key or key in ('root_ids', 'leaf_ids') for key in model.state_dict()))


class Deep256ModelTests(DeepModelTests):
    depth = 256


class Deep1024ModelTests(DeepModelTests):
    depth = 1024


if __name__ == '__main__': unittest.main()
