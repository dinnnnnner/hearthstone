import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from tavern_rl.model import ActorCritic, advantages, ppo_update
from tavern_rl.train import atomic_checkpoint, load_checkpoint
from tavern_rl.rollout import SimulationPool


class PPOTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(1)
        torch.manual_seed(7)

    def test_terminal_returns_stay_with_each_player(self):
        for reward in [-1, 1]:
            adv, returns = advantages([.2, .4, .3], reward, 1, 1)
            np.testing.assert_allclose(returns, [reward] * 3, atol=1e-6)
            np.testing.assert_allclose(adv, np.array([reward] * 3) - [.2, .4, .3], atol=1e-6)
        adv, _ = advantages([0, 0, 0], 1, 1, .5)
        np.testing.assert_allclose(adv, [.25, .5, 1])

    def test_mask_has_zero_illegal_probability(self):
        model = ActorCritic(3, 5, 8)
        masks = torch.tensor([[False, True, False, False, True]])
        dist, _ = model.distribution(torch.zeros(1, 3), masks)
        self.assertEqual(dist.probs[~masks].sum().item(), 0)
        self.assertTrue(set(dist.sample((1000,)).flatten().tolist()) <= {1, 4})
        with self.assertRaises(ValueError):
            model.distribution(torch.zeros(1, 3), torch.zeros(1, 5, dtype=torch.bool))

    def test_clipped_ppo_changes_actor_and_critic_with_finite_gradients(self):
        model = ActorCritic(3, 5, 8)
        obs = torch.randn(32, 3)
        mask = torch.tensor([[False, True, False, False, True]] * 32)
        with torch.no_grad():
            dist, values = model.distribution(obs, mask)
            actions = dist.sample(); logs = dist.log_prob(actions)
        records = [(obs[i].numpy(), mask[i].numpy(), actions[i].item(), logs[i].item(), values[i].item()) for i in range(32)]
        tracks = [(records[:16], 1), (records[16:], -1)]
        before = {k: v.clone() for k, v in model.state_dict().items()}
        config = dict(gamma=1, gae_lambda=.95, epochs=2, batch_size=16, target_kl=.03,
                      clip=.2, value_coef=.5, entropy_coef=.01, max_grad_norm=.5)
        stats = ppo_update(model, torch.optim.Adam(model.parameters(), lr=3e-4), tracks, config, "cpu")
        self.assertEqual(stats["samples"], 32)
        self.assertGreater(stats["optimizer_steps"], 0)
        self.assertTrue(all(np.isfinite(v) for v in stats.values()))
        self.assertFalse(torch.equal(before["actor.weight"], model.actor.weight))
        self.assertFalse(torch.equal(before["critic.weight"], model.critic.weight))

    def test_atomic_checkpoint_and_schema_rejection(self):
        model = ActorCritic(3, 5, 8)
        meta = dict(schema="test", sourceHash="abc", observationVersion=1, actionVersion=1,
                    actionCount=5, cardIds=["one"], heroIds=["two"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "latest.pt"
            atomic_checkpoint(path, dict(meta=meta, model_spec=model.specification(), model=model.state_dict()))
            _, restored = load_checkpoint(path, meta)
            for key, value in model.state_dict().items():
                self.assertTrue(torch.equal(value, restored.state_dict()[key]))
            self.assertFalse(path.with_suffix(".pt.next").exists())
            with self.assertRaisesRegex(ValueError, "sourceHash"):
                load_checkpoint(path, {**meta, "sourceHash": "changed"})

    def test_historical_seats_never_enter_ppo_tracks(self):
        # A tiny deterministic eight-player bridge isolates collector attribution.
        class FakeSimulator:
            def reset(self, seed, options):
                self.seat = 0
                return self.state()
            def state(self):
                done = self.seat == 8
                return dict(actor=None if done else self.seat, observation=[float(self.seat), 0, 0],
                            legalActions=[0, 1], terminated=done, truncated=False,
                            info=dict(placements=list(range(1, 9)), rewards=[(4.5-i)/3.5 for i in range(1, 9)]))
            def step(self, action):
                self.seat += 1
                return self.state()
        from concurrent.futures import ThreadPoolExecutor
        pool = SimulationPool.__new__(SimulationPool)
        pool.simulators = [FakeSimulator()]; pool.meta = {"actionCount": 5, "actions": [dict(type=t) for t in ["end", "buy", "play", "refresh", "upgrade"]]}
        pool.executor = ThreadPoolExecutor(max_workers=1)
        try:
            tracks, games, perf = pool.collect(ActorCritic(3, 5, 8), [ActorCritic(3, 5, 8)], [1, 2], {}, "cpu", learner_seats=1)
            shifted, shifted_games, _ = pool.collect(ActorCritic(3, 5, 8), [ActorCritic(3, 5, 8)], [3, 4], {}, "cpu", learner_seats=1, seat_offset=7)
        finally:
            pool.executor.shutdown()
        self.assertEqual(sum(perf["action_counts"].values()), 16)
        self.assertEqual(sum(perf["learner_action_counts"].values()), 2)
        self.assertEqual(len(tracks), 2)
        self.assertEqual([t[0][0][0][0] for t in tracks], [0, 1])
        self.assertEqual([t[1] for t in tracks], [1, (4.5-2)/3.5])
        self.assertEqual([g["controllers"].count(-1) for g in games], [1, 1])
        self.assertEqual([g['controllers'].index(-1) for g in shifted_games], [7, 0])
        self.assertEqual([t[0][0][0][0] for t in shifted], [7, 0])


if __name__ == "__main__":
    unittest.main()
