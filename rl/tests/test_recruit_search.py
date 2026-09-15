import copy
import unittest
from unittest.mock import MagicMock, patch
from tavern_rl.recruit_search import Evaluation, SearchConfig, search


class Turn:
    def reset(self, seed):
        self.path = []; self.seed = seed
        return self.view()

    def view(self):
        ended = bool(self.path and self.path[-1] == 0)
        legal = [] if ended else [0, 1, 2] if not self.path else [0, 3] if self.path == [1] else [0]
        return dict(entities=self.path[:], legal=legal, ended=ended, gold=0)

    def step(self, action):
        assert action in self.view()['legal']
        self.path.append(action)
        return self.view()


def evaluate(view, memory, previous):
    path = view['entities']
    value = 1. if 3 in path else .4 if 2 in path else -.5
    return Evaluation({a: 1 / len(view['legal']) for a in view['legal']}, value, memory + [previous])


class SearchTests(unittest.TestCase):
    def test_search_accepts_all_served_depths_and_rejects_mismatched_towers(self):
        from tavern_rl.recruit_search import SearchPolicy, VERSION
        simulator = MagicMock()
        simulator.meta = dict(contract='test', searchVersion=VERSION)
        with patch('tavern_rl.bridge.Simulator', return_value=simulator):
            for depth in (64,256,1024):
                model = MagicMock()
                model.specification.return_value = dict(policy_depth=depth,value_depth=depth)
                policy = SearchPolicy(model,dict(contract='test'),'bundle')
                self.assertIs(policy.model,model)
                policy.close()
            model.specification.return_value = dict(policy_depth=1024,value_depth=256)
            with self.assertRaises(ValueError):SearchPolicy(model,dict(contract='test'),'bundle')

    def test_legacy_training_penalty_is_not_applied_by_search(self):
        from tavern_rl.recruit_search import SearchPolicy, VERSION
        model = MagicMock()
        model.specification.return_value = dict(policy_depth=64, value_depth=64)
        simulator = MagicMock()
        simulator.meta = dict(contract='test', searchVersion=VERSION)
        with patch('tavern_rl.bridge.Simulator', return_value=simulator):
            policy = SearchPolicy(model, dict(contract='test', unusedGoldPenalty=.01), 'test-bundle')
        self.assertFalse(hasattr(policy, 'penalty'))
        policy.close()

    def test_end_is_compared_even_with_tiny_ppo_prior_and_budget_alone_cannot_force_end(self):
        root = Evaluation({0: .000001, 1: .999999}, 0., [])
        def critic(view, memory, previous):
            return Evaluation({a: 1. for a in view['legal']}, 1. if view['entities'] == [0] else 0., memory)
        action, stats = search(Turn(), root, critic, [], -1, [0, 1], 10, SearchConfig(simulations=16))
        self.assertEqual(action, 0)
        action, stats = search(Turn(), root, critic, [], -1, [0, 1], 10, SearchConfig(simulations=1))
        self.assertIsNone(action)

    def test_freeze_cycles_are_cut_without_forcing_a_real_end(self):
        class Cycle(Turn):
            def view(self):
                return dict(entities=[{'details': {'decisions': len(self.path), 'frozen': bool(len(self.path) % 2)}}],
                            legal=[1], ended=False, gold=3)
        def critic(view, memory, previous):
            return Evaluation({1: 1.}, .25, memory + [previous])
        action, stats = search(Cycle(), Evaluation({1: 1.}, .25, []), critic, [], -1, [1], 5,
                               SearchConfig(simulations=8))
        self.assertEqual(action, 1); self.assertEqual(stats['cycle_cutoffs'], 8)
        self.assertEqual(stats['max_depth'], 2); self.assertEqual(stats['recruit_ends'], 0)

    def test_search_finds_buy_play_sequence_beyond_one_action_and_preserves_real_memory(self):
        memory = [99]; root = Evaluation({0: .05, 1: .3, 2: .65}, 0., [99, -1])
        before = copy.deepcopy(root)
        action, stats = search(Turn(), root, evaluate, memory, -1, [0, 1, 2], 10,
                               SearchConfig(simulations=128, time_ms=2000))
        self.assertEqual(action, 1)
        self.assertEqual(memory, [99]); self.assertEqual(root, before)
        self.assertGreater(stats['recruit_ends'], 0)
        self.assertEqual(sum(r['visits'] for r in stats['actions']), stats['simulations'])
        self.assertLessEqual(stats['nodes'], 128)

    def test_depth_or_node_limit_does_not_force_the_real_end_action(self):
        root = Evaluation({1: 1.}, 0., [])
        action, stats = search(Turn(), root, evaluate, [], -1, [1], 4,
                               SearchConfig(simulations=8, max_depth=1, max_nodes=1, time_ms=2000))
        self.assertEqual(action, 1); self.assertEqual(stats['nodes'], 1)
        self.assertEqual(stats['max_depth'], 1); self.assertEqual(stats['cutoffs'], 8)

    def test_authoritative_legal_mask_always_wins_at_root(self):
        root = Evaluation({0: .01, 1: .98, 2: .01}, 0., [])
        action, stats = search(Turn(), root, evaluate, [], -1, [2], 4, SearchConfig(simulations=8))
        self.assertEqual(action, 2)
        self.assertEqual([r['action'] for r in stats['actions']], [2])

    def test_chance_outcomes_are_distinct_children_and_new_seeds_are_used(self):
        class Chance(Turn):
            def view(self):
                result = super().view()
                if self.path: result['entities'] = [self.seed % 3, *self.path]
                return result
        root = Evaluation({2: 1.}, 0., [])
        _, stats = search(Chance(), root, evaluate, [], -1, [2], 44, SearchConfig(simulations=32))
        self.assertEqual(stats['sampled_root_outcomes'], 3)

    def test_non_finite_values_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Non-finite'):
            search(Turn(), Evaluation({0: 1.}, float('nan'), []), evaluate, [], -1, [0], 2)

    def test_resource_budgets_are_finite_positive_and_bounded(self):
        for kwargs in [dict(time_ms=0), dict(simulations=1000000), dict(max_nodes=-1), dict(exploration=float('inf'))]:
            with self.assertRaises(ValueError): SearchConfig(**kwargs)


if __name__ == '__main__': unittest.main()
