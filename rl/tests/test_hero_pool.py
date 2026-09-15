import copy
import datetime
import json
from pathlib import Path
import random
import tempfile
import unittest
from unittest.mock import patch

from tavern_rl.hero_pool import load_hero_pool, options_for_seed, validate_hero_pool
from tavern_rl.independent import supervise


class HeroPoolTests(unittest.TestCase):
    def setUp(self):
        self.pool = dict(format=1, heroes=[dict(id=f'hero-{i}') for i in range(10)])
        self.meta = dict(heroIds=[h['id'] for h in self.pool['heroes']])

    def test_seeded_assignments_are_distinct_confined_and_cover_pool(self):
        seen = set()
        for seed in range(100):
            result = options_for_seed({}, self.pool, seed)['heroes']
            self.assertEqual(len(result), 8)
            self.assertEqual(len(set(result)), 8)
            self.assertTrue(set(result) <= set(self.meta['heroIds']))
            self.assertEqual(result, options_for_seed({}, self.pool, seed)['heroes'])
            seen.update(result)
        self.assertEqual(seen, set(self.meta['heroIds']))
        self.assertNotEqual(options_for_seed({}, self.pool, 1), options_for_seed({}, self.pool, 2))

    def test_no_global_rng_or_input_mutation_and_disabled_mode_unchanged(self):
        options = dict(maxSteps=30000)
        original = copy.deepcopy(self.pool)
        rng = random.getstate()
        self.assertIs(options_for_seed(options, None, 1), options)
        options_for_seed(options, self.pool, 1)
        self.assertEqual(options, dict(maxSteps=30000))
        self.assertEqual(self.pool, original)
        self.assertEqual(random.getstate(), rng)
        with self.assertRaisesRegex(ValueError, 'fixed'):
            options_for_seed(dict(heroes=[]), self.pool, 1)

    def test_invalid_whitelists_fail_instead_of_falling_back(self):
        for pool in ({}, dict(format=1, heroes=self.pool['heroes'][:7]),
                     dict(format=1, heroes=self.pool['heroes'][:8] + [self.pool['heroes'][0]]),
                     dict(format=1, heroes=[dict(id='unknown')] + self.pool['heroes'][1:])):
            with self.assertRaises(ValueError):
                validate_hero_pool(pool, self.meta)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'heroes.json'
            path.write_text(json.dumps(self.pool))
            self.assertEqual(load_hero_pool(path, self.meta), self.pool)

    def test_existing_deadline_is_not_extended_on_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deadline = datetime.datetime.fromtimestamp(110, datetime.timezone.utc)
            ticks = iter([50., 61.])
            with patch('tavern_rl.independent.time.time', return_value=100.), \
                 patch('tavern_rl.independent.time.monotonic', side_effect=lambda: next(ticks)), \
                 patch('tavern_rl.independent.stop_processes'), patch('builtins.print'):
                supervise(root, [], 4, 3, 'cuda', deadline)
            state = json.loads((root/'status.json').read_text())
            self.assertEqual(state['deadline_utc'], deadline.isoformat())
            self.assertAlmostEqual(state['hours'], 10/3600)
            with patch('tavern_rl.independent.time.time', return_value=111.):
                with self.assertRaisesRegex(ValueError, 'passed'):
                    supervise(root, [], 4, 3, 'cuda', deadline)


if __name__ == '__main__':
    unittest.main()
