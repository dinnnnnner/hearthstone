import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import torch
from tavern_rl.rewards import unused_gold_reward, penalty_coefficient, trajectory_rewards
from tavern_rl.model import advantages
from tavern_rl.rollout import SimulationPool
from tavern_rl.train import parser
from tavern_rl import train


class RewardTests(unittest.TestCase):
    def test_resume_disables_saved_penalty_before_sampling_and_checkpointing(self):
        class StopBeforeRollout(Exception): pass
        pool = MagicMock()
        pool.meta = dict(schema='test', sourceHash='test', observationVersion=1,
                         actionVersion=1, actionCount=1, cardIds=[], heroIds=[],
                         actions=[{'type': 'end'}])
        simulator = MagicMock()
        simulator.reset.return_value = {'observation': [0.]}
        pool.simulators = [simulator]
        pool.worker_count = 1
        pool.collect.side_effect = StopBeforeRollout
        with tempfile.TemporaryDirectory() as directory:
            args = ['train', '--output', directory, '--architecture', 'mlp',
                    '--hidden', '8', '--device', 'cpu', '--workers', '1']
            with patch('tavern_rl.training_performance.make_pool', return_value=pool), patch('sys.argv', args):
                with self.assertRaises(StopBeforeRollout): train.main()
            checkpoint = Path(directory) / 'latest.pt'
            saved = torch.load(checkpoint, weights_only=False)
            saved['config']['unused_gold_penalty'] = .01
            saved['config']['first_place_bonus'] = 1.
            torch.save(saved, checkpoint)
            with patch('tavern_rl.training_performance.make_pool', return_value=pool), patch('sys.argv', args + ['--resume', str(checkpoint)]):
                with self.assertRaises(StopBeforeRollout): train.main()
            self.assertNotIn('unused_gold_penalty', pool.collect.call_args.kwargs)
            self.assertEqual(pool.collect.call_args.kwargs['first_place_bonus'], 1.)
            config = torch.load(checkpoint, weights_only=False)['config']
            self.assertNotIn('unused_gold_penalty', config)
            self.assertEqual(config['reward_mode'], 'placement_only')
            self.assertEqual(config['first_place_bonus'], 1.)
            self.assertNotIn('unused_gold_penalty', json.loads((Path(directory) / 'manifest.json').read_text())['config'])

    def test_end_gold_only_and_invalid_coefficients(self):
        state = {'entities': [{'details': {'gold': 3}}]}
        self.assertAlmostEqual(unused_gold_reward(state, {'type': 'end'}, .01), -.03)
        self.assertEqual(unused_gold_reward(state, {'type': 'buy'}, .01), 0)
        state['entities'][0]['details']['gold'] = 0
        self.assertEqual(unused_gold_reward(state, {'type': 'end'}, .01), 0)
        for value in [-1, float('nan'), float('inf')]:
            with self.assertRaises(ValueError): penalty_coefficient(value)
        self.assertFalse(hasattr(parser().parse_args([]), 'unused_gold_penalty'))

    def test_step_rewards_reach_gae_and_preserve_terminal_ranking(self):
        rewards = trajectory_rewards([0, -.03, 0, -.02], 1.)
        adv, returns = advantages([0, 0, 0, 0], rewards, gamma=1, gae_lambda=1)
        np.testing.assert_allclose(returns, [.95, .95, .98, .98], atol=1e-6)
        legacy = advantages([.2, .3, .4], 1.)
        explicit = advantages([.2, .3, .4], [0., 0., 1.])
        for a, b in zip(legacy, explicit): np.testing.assert_array_equal(a, b)
        with self.assertRaises(ValueError): advantages([0, 0], [0])

    def test_collector_uses_only_terminal_rewards_despite_unspent_gold(self):
        class Simulator:
            def reset(self, seed, options): self.tick = 0; return self.state()
            def state(self):
                done = self.tick == 16
                return dict(actor=None if done else self.tick % 8, observation=[0],
                    entities=[{'details': {'gold': 3 if self.tick < 8 else 10}}],
                    legalActions=[0], terminated=done, truncated=False,
                    info=dict(placements=list(range(1, 9)), rewards=[1.] * 8))
            def step(self, action): self.tick += 1; return self.state()
        class Model(torch.nn.Module):
            observation_kind = 'flat'; recurrent = False
            def distribution(self, obs, masks):
                return torch.distributions.Categorical(logits=torch.zeros_like(masks, dtype=torch.float32)), torch.zeros(len(obs))
        pool = SimulationPool.__new__(SimulationPool)
        pool.simulators = [Simulator()]; pool.executor = ThreadPoolExecutor(max_workers=1)
        pool.meta = dict(actionCount=1, actions=[{'type': 'end'}])
        try:
            tracks, games, stats = pool.collect(Model(), [], [1], {}, 'cpu', learner_seats=8)
            self.assertEqual(len(tracks), 8)
            for records, reward in tracks:
                self.assertEqual(len(records), 2)
                self.assertIsInstance(reward, float)
                self.assertEqual(reward, 1.)
            self.assertEqual(games[0]['rewards'], [1.] * 8)
            self.assertFalse(any('gold' in key for key in stats))
            evaluation, results, _ = pool.collect(Model(), [], [1], {}, 'cpu', collect=False)
            self.assertFalse(evaluation)
            self.assertEqual(results[0]['rewards'], [1.] * 8)
        finally: pool.executor.shutdown()
