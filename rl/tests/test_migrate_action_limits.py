import copy
import unittest
import numpy as np
import torch
from tavern_rl.migrate_action_limits import (
    migrate, retained_digest, OLD_SOURCE, OLD_RULES, NEW_SOURCE, NEW_RULES,
)


class ActionLimitsMigrationTests(unittest.TestCase):
    def setUp(self):
        old = dict(sourceHash=OLD_SOURCE, rulesHash=OLD_RULES,
                   entitySchema={'version': 3}, actions=[{'type': 'end'}])
        self.meta = old | dict(sourceHash=NEW_SOURCE, rulesHash=NEW_RULES,
                              aiActionLimits=dict(version=1, freezes=2, moves=6))
        spec = dict(entity_schema=old['entitySchema'], actions=old['actions'])
        self.saved = dict(meta=old, model_spec=spec, model={'weight': torch.ones(2)},
                          optimizer={'step': torch.tensor(7)}, league=[dict(model_spec=spec, weights={})],
                          config={'options': {}, 'first_place_bonus': 1.}, episodes=17, iteration=8,
                          torch_rng=torch.tensor([1, 2]), numpy_rng=np.array([2, 3]), python_rng=(1, 2))

    def test_preserves_training_state_and_input(self):
        result = migrate(self.saved, self.meta, 'test-source')
        self.assertEqual(retained_digest(result), retained_digest(self.saved))
        self.assertNotIn('aiActionLimits', self.saved['config']['options'])
        self.assertTrue(result['config']['options']['aiActionLimits'])
        self.assertEqual(result['config']['first_place_bonus'], 1.)
        for key in ('model', 'optimizer', 'league', 'torch_rng', 'numpy_rng', 'python_rng'):
            self.assertIs(result[key], self.saved[key])

    def test_rejects_other_rules_or_schema_changes(self):
        for change in ({'sourceHash': 'other'}, {'rulesHash': 'other'}, {'actions': []},
                       {'aiActionLimits': dict(version=1, freezes=3, moves=6)}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                migrate(self.saved, self.meta | change, 'test-source')

    def test_rejects_partial_or_already_migrated_checkpoints(self):
        partial = self.saved.copy(); del partial['optimizer']
        with self.assertRaises(ValueError): migrate(partial, self.meta, 'test-source')
        with self.assertRaises(ValueError):
            migrate(migrate(self.saved, self.meta, 'test-source'), self.meta, 'test-source')

    def test_rejects_incompatible_history(self):
        saved = copy.deepcopy(self.saved)
        saved['league'][0]['model_spec']['entity_schema'] = {'version': 2}
        with self.assertRaises(ValueError): migrate(saved, self.meta, 'test-source')

    def test_digest_detects_optimizer_and_rng_changes(self):
        before = retained_digest(self.saved)
        self.saved['optimizer']['step'] += 1
        self.assertNotEqual(before, retained_digest(self.saved))


if __name__ == '__main__':
    unittest.main()
