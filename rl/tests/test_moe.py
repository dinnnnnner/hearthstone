from copy import deepcopy
from unittest.mock import MagicMock, patch
import unittest
import numpy as np
import torch
from tavern_rl.bridge import Simulator
from tavern_rl.features import prepare_entities
from tavern_rl.inference_features import HostEntityBatch, merge_batches
from tavern_rl.ledger_training import LedgerTargets, configure as configure_ledger, supervision_loss
from tavern_rl.model import make_model, ppo_update
from tavern_rl.moe_model import MoEActorCritic, TASKS
from tavern_rl.moe_training import balance_loss, configure, regularization
from tavern_rl.serve import Policy
from tavern_rl.train import parser, validate_resume_architecture


class MoETests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        with Simulator() as simulator:
            cls.view = simulator.reset(912)
            cls.meta = simulator.meta

    def setUp(self):
        torch.manual_seed(37)
        self.raw = deepcopy(self.view['entities'])
        first = next(e for e in self.raw if e and e['zone'] == 2)
        for zone in (1, 4):
            self.raw[self.meta['entitySchema']['offsets'][zone]] = dict(deepcopy(first), zone=zone, position=0)
        self.obs = prepare_entities(self.raw)
        self.model = MoEActorCritic(self.meta['entitySchema'], self.meta['actions'], hidden=16, heads=2, layers=1)
        self.mask = torch.zeros(1, self.model.action_size, dtype=torch.bool)
        self.mask[0, self.view['legalActions']] = True
        self.previous = torch.tensor([self.model.action_size])

    def explain(self, observations=None):
        return self.model.explain(observations or [self.obs], self.mask,
            self.model.initial_memory(1, 'cpu'), self.previous)

    def settings(self):
        args = parser().parse_args(['--architecture', 'entity-gru-moe'])
        config = dict(gamma=1., gae_lambda=.95, clip=.2, value_coef=.5, entropy_coef=.01,
            max_grad_norm=.5, target_kl=.03, epochs=1, sequence_length=3, burn_in=2, sequence_batch_size=2)
        configure_ledger(config, args, self.model, self.meta)
        configure(config, args, self.model)
        return config

    def test_routing_normalizes_and_changes_with_hero_and_state(self):
        dist, value, _, ledger = self.explain()
        weights = ledger['routing']
        self.assertEqual(tuple(weights.shape), (1, len(TASKS), 4))
        torch.testing.assert_close(weights.sum(-1), torch.ones(1, len(TASKS)))
        self.assertFalse(torch.equal(weights[:, 4], weights[:, 5]))
        self.assertEqual(float(dist.probs[~self.mask].sum()), 0.)
        torch.testing.assert_close(ledger['board'], ledger['contributions'].sum(-1))
        other = deepcopy(self.raw)
        hero = next(int(k) for k, v in self.model.schema['definitions'].items()
                    if v.get('kind') == 'hero' and int(k) != other[0]['id'])
        other[0]['id'] = hero
        hero_weights = self.explain([prepare_entities(other)])[3]['routing']
        self.assertGreater(float((weights - hero_weights).abs().max()), 1e-7)
        other = deepcopy(self.raw)
        other[0]['details'].update(gold=9, tier=5, health=3, turn=9)
        changed = self.explain([prepare_entities(other)])[3]['routing']
        self.assertGreater(float((weights - changed).abs().max()), 1e-7)
        self.assertTrue(torch.isfinite(value).all())

    def test_packed_merge_checkpoint_and_batch_invariance(self):
        self.model.eval()
        with torch.no_grad():
            first = self.explain()
            packed = HostEntityBatch.prepare([self.obs], self.model.schema, {})
            second = self.explain(packed)
            torch.testing.assert_close(first[0].probs, second[0].probs)
            merged = merge_batches([packed, packed])
            dist, value, _ = self.model.act(merged, self.mask.expand(2, -1),
                self.model.initial_memory(2, 'cpu'), self.previous.expand(2))
            torch.testing.assert_close(dist.probs, first[0].probs.expand(2, -1))
            torch.testing.assert_close(value, first[1].expand(2))
            restored = make_model(self.model.specification()).eval()
            restored.load_state_dict(self.model.state_dict(), strict=True)
            actual = restored.explain([self.obs], self.mask, restored.initial_memory(1, 'cpu'), self.previous)
            torch.testing.assert_close(actual[0].probs, first[0].probs)
            torch.testing.assert_close(actual[3]['routing'], first[3]['routing'])

    def test_supervision_and_policy_reach_experts_and_all_task_routers(self):
        config = self.settings()
        teacher = LedgerTargets(self.meta)
        try:
            label = teacher.score([self.raw])[0]
        finally:
            teacher.close()
        label.update(combat=1, future=[5, 2, 0])
        encoded = self.model.encode([self.obs], 'cpu')
        memory = self.model.recurrent_step(encoded, self.model.initial_memory(1, 'cpu'), self.previous)
        dist, value = self.model.distribution_from(encoded, memory, self.mask)
        loss, _ = supervision_loss(self.model, encoded, memory, [label], config['ledger'])
        loss = loss - dist.log_prob(torch.tensor([self.view['legalActions'][0]])).mean() + (value - .7).square().mean()
        loss.backward()
        for task, router in self.model.mixture.routers.items():
            self.assertGreater(float(router.weight.grad.abs().sum()), 0., task)
        for expert in self.model.mixture.experts:
            self.assertGreater(sum(float(p.grad.abs().sum()) for p in expert.parameters()), 0.)

    def test_policy_preserves_auxiliary_head_units(self):
        dist, value, _, _ = self.explain()
        (-dist.log_prob(torch.tensor([self.view['legalActions'][0]])).mean() + value.square().mean()).backward()
        for name in ('card_body', 'card_adjustment', 'economy_head', 'future_economy_head', 'combat_head'):
            self.assertTrue(all(p.grad is None for p in getattr(self.model, name).parameters()), name)
        self.assertIsNotNone(self.model.mixture.routers['policy'].weight.grad)

    def test_balance_penalizes_collapse_but_allows_specialized_decisions(self):
        specialized = torch.eye(4)[:, None].expand(-1, len(TASKS), -1)
        self.assertAlmostEqual(float(balance_loss(specialized)), 0.)
        collapsed = torch.zeros(4, len(TASKS), 4)
        collapsed[..., 0] = 1
        self.assertAlmostEqual(float(balance_loss(collapsed)), 3.)
        logits = torch.tensor([3., 0., 0., 0.], requires_grad=True)
        loss = balance_loss(logits.softmax(-1)[None, None].expand(4, len(TASKS), -1))
        loss.backward()
        self.assertGreater(float(logits.grad[0]), 0.)

    def test_recurrent_update_masks_padding_and_replays_routes(self):
        config = self.settings()
        teacher = LedgerTargets(self.meta)
        try:
            label = teacher.score([self.raw])[0]
        finally:
            teacher.close()
        label.update(combat=1, future=[4, 2, 0])
        records = []
        memory = self.model.initial_memory(1, 'cpu')
        previous = self.previous
        self.model.eval()
        with torch.no_grad():
            for _ in range(4):
                dist, value, updated = self.model.act([self.obs], self.mask, memory, previous)
                action = self.view['legalActions'][0]
                records.append((self.obs, self.mask[0].numpy(), action,
                    float(dist.log_prob(torch.tensor([action]))), float(value), memory[0].numpy().copy(), int(previous[0])))
                memory, previous = updated, torch.tensor([action])
        tracks = [(records, dict(rewards=np.array([0., 0., 0., 1.]), ledger=[label] * 4)),
                  (records[:1], dict(rewards=np.array([-1.]), ledger=[label]))]
        stats = ppo_update(self.model, torch.optim.Adam(self.model.parameters(), lr=0), tracks, config, 'cpu')
        self.assertEqual(stats['samples'], 5)
        self.assertLess(abs(stats['approx_kl']), 1e-6)
        self.assertGreater(stats['optimizer_steps'], 0)
        for task in TASKS:
            self.assertAlmostEqual(sum(stats['moe'][f'{task}_expert_{i}'] for i in range(4)), 1., places=5)
        for section in ('moe', 'ledger'):
            self.assertTrue(all(np.isfinite(x) for x in stats[section].values()))
        with self.assertRaisesRegex(ValueError, 'settings differ'):
            ppo_update(self.model, torch.optim.Adam(self.model.parameters()), tracks,
                       {k: v for k, v in config.items() if k != 'moe'}, 'cpu')

    def test_version_and_resume_settings_are_strict(self):
        config = self.settings()
        args = parser().parse_args(['--architecture', 'entity-gru-moe'])
        configure(config, args, self.model)
        config['moe']['implementation_hash'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'changed'):
            configure(config, args, self.model)
        for overrides in (dict(experts=1), dict(experts=True), dict(expert_width=0), dict(moe_version='unknown')):
            with self.assertRaises(ValueError):
                make_model(self.model.specification() | overrides)
        args = parser().parse_args(['--moe-experts', '8'])
        with self.assertRaisesRegex(ValueError, 'Resume restores'):
            validate_resume_architecture(args, self.model.specification())

    def test_serving_exposes_actual_routes_only_for_judgment(self):
        policy = Policy.__new__(Policy)
        policy.model = self.model.eval()
        policy.metadata = dict(contract='test', checkpointSha256='test')
        policy.search = None
        policy.decisions = policy.elapsed = 0
        request = dict(contract='test', judgment=True, probabilities=True, rows=[dict(
            entities=self.raw, legal=self.view['legalActions'], memory=[0.] * 16, previous=self.model.action_size)])
        row = policy.predict(request)['rows'][0]
        self.assertEqual(row['ledger']['moe']['experts'], 4)
        with torch.no_grad():
            expected = self.explain()[3]['routing'][0].numpy()
        for index, task in enumerate(TASKS):
            np.testing.assert_allclose(row['ledger']['moe']['routing'][task], expected[index], atol=1e-6)
        request['judgment'] = False
        self.assertNotIn('ledger', policy.predict(request)['rows'][0])


if __name__ == '__main__':
    unittest.main()
