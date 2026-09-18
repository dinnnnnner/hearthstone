from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import torch

from tavern_rl.basic_feedback import BasicFeedback, VERSION, configure, shape_rewards, validate
from tavern_rl.bridge import ROOT, Simulator
from tavern_rl.model import ActorCritic, advantages
from tavern_rl.rollout import SimulationPool
from tavern_rl.train import parser


def settings():
    return dict(version=VERSION, coefficient=.1, scale=20., weights={})


class BasicFeedbackTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(1)

    def test_cycles_cannot_create_complete_game_return_and_terminal_is_zero(self):
        for potentials in ([.02, .08, .02], [.02, .02], [.02, .09, .04, .01]):
            for rank_reward in (-1., 0., 1.):
                rewards = shape_rewards(potentials, rank_reward)
                self.assertAlmostEqual(float(rewards.sum()), rank_reward - .02, places=6)
                self.assertAlmostEqual(float(rewards[-1]), rank_reward - potentials[-1], places=6)
                _, returns = advantages(np.zeros(len(rewards)), rewards, 1., 1.)
                np.testing.assert_allclose(returns, rank_reward - np.array(potentials), atol=1e-6)
        self.assertLess(shape_rewards([.08, .02], 0.)[0], 0.)

    def test_invalid_or_unbounded_settings_and_targets_are_rejected(self):
        for key, value in [('coefficient', 0), ('coefficient', .3), ('scale', float('nan'))]:
            with self.assertRaises(ValueError): validate({**settings(), key: value})
        for potentials in ([], [.1, np.inf], [[.1]]):
            with self.assertRaises(ValueError): shape_rewards(potentials, 1.)
        with self.assertRaises(ValueError): shape_rewards([.1], float('nan'))

    def test_real_scorer_sale_signal_config_roundtrip_and_implementation_guard(self):
        fixture = json.loads((ROOT / 'rl/fixtures/basic-opening-cases.json').read_text())['cases'][0]
        before = fixture['entities']; after = deepcopy(before)
        after[1] = None; after[0]['details']['gold'] = 1
        with Simulator() as simulator:
            meta = simulator.meta
        evaluator = BasicFeedback(settings(), meta)
        try:
            p = evaluator.score([before, after])
            self.assertGreater(p[0], p[1])
            self.assertTrue(all(0 <= value <= .1 for value in p))
            self.assertEqual(evaluator.states, 2)
        finally: evaluator.close()
        args = parser().parse_args(['--basic-feedback'])
        config = dict(gamma=1., options={})
        model = ActorCritic(3, 2, 8)
        configure(config, args, model, meta)
        before_config = deepcopy(config)
        configure(config, parser().parse_args([]), model, meta)
        self.assertEqual(config, before_config)
        self.assertIn('attack', config['basic_feedback']['weights'])
        self.assertEqual(config['reward_mode'], VERSION)
        with self.assertRaisesRegex(ValueError, 'implementation changed'):
            BasicFeedback({**settings(), 'implementation_hash': 'different'}, meta)
        with self.assertRaisesRegex(ValueError, 'definitions differ'):
            BasicFeedback(settings(), {'entitySchema': {}})
        with self.assertRaisesRegex(ValueError, 'Unknown basic'):
            BasicFeedback({**settings(), 'weights': {'invented': 1.}}, meta)

    def test_conflicting_modes_and_unsupported_resume_are_explicit(self):
        args = parser().parse_args(['--basic-feedback'])
        model = ActorCritic(3, 2, 8)
        with self.assertRaisesRegex(ValueError, 'streaming'):
            configure(dict(gamma=1., streaming={'turns': 2}), args, model, {})
        model.action_value_type = True
        with self.assertRaisesRegex(ValueError, 'plain PPO'):
            configure(dict(gamma=1.), args, model, {})
        with self.assertRaisesRegex(ValueError, 'Cannot remove'):
            configure(dict(basic_feedback=settings()), parser().parse_args(['--no-basic-feedback']), model, {})
        with self.assertRaisesRegex(ValueError, 'require --basic-feedback'):
            configure({}, parser().parse_args(['--basic-feedback-scale', '10']), model, {})

    def test_collector_uses_each_seats_own_successor_and_excludes_opponent_tracks(self):
        class FakeSimulator:
            def reset(self, seed, options): self.tick = 0; return self.state()
            def state(self):
                done = self.tick == 16
                seat = self.tick % 8
                return dict(actor=None if done else seat, observation=[float(seat), 0, 0],
                    entities=[dict(potential=.01 + seat * .01 + (self.tick // 8) * .02)],
                    legalActions=[0, 1], terminated=done, truncated=False,
                    info=dict(placements=list(range(1, 9)), rewards=[(4.5 - i) / 3.5 for i in range(1, 9)]))
            def step(self, action): self.tick += 1; return self.state()
            def close(self): pass

        class FakeFeedback:
            def __init__(self, config, meta): self.settings = config; self.states = 0; self.seconds = 0.
            def score(self, rows): self.states += len(rows); return [r[0]['potential'] for r in rows]
            def close(self): pass

        pool = SimulationPool.__new__(SimulationPool)
        pool.simulators = [FakeSimulator()]
        pool.meta = dict(actionCount=2, actions=[dict(type='end'), dict(type='buy')])
        pool.executor = ThreadPoolExecutor(max_workers=1)
        try:
            with patch('tavern_rl.basic_feedback.BasicFeedback', FakeFeedback):
                tracks, games, metrics = pool.collect(ActorCritic(3, 2, 8), [ActorCritic(3, 2, 8)],
                    [42], {}, 'cpu', learner_seats=1, basic_feedback=settings())
                self.assertEqual(len(tracks), 1)
                records, rewards = tracks[0]
                self.assertEqual(len(records), 2)
                np.testing.assert_allclose(rewards, [.02, .97], atol=1e-6)
                self.assertEqual(metrics['basic_feedback']['states'], 2)
                self.assertEqual(metrics['basic_feedback']['trajectories'], 1)
                self.assertAlmostEqual(metrics['basic_feedback']['feedback_sum'], -.01, places=6)
                self.assertEqual(games[0]['rewards'][0], 1.)
                # Returning to the disabled path closes the scorer and preserves scalar rewards.
                tracks, _, metrics = pool.collect(ActorCritic(3, 2, 8), [], [43], {}, 'cpu')
                self.assertIsNone(pool.basic_evaluator)
                self.assertIsInstance(tracks[0][1], float)
                self.assertNotIn('basic_feedback', metrics)
        finally: pool.close()


if __name__ == '__main__': unittest.main()
