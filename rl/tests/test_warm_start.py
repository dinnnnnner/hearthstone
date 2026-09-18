import unittest
import torch
from tavern_rl.model import make_model
from tavern_rl.warm_start import plain_ppo_model


class WarmStartTests(unittest.TestCase):
    def test_all_core_tensors_are_exactly_preserved_and_unknown_drops_rejected(self):
        # Use the same entity fixture as the real recurrent model tests.
        from test_deep_model import fixture
        torch.set_num_threads(1)
        schema, actions, *_ = fixture()
        model = make_model(dict(architecture='entity-gru-resnet', entity_schema=schema, actions=actions,
            hidden=16, heads=2, layers=1, policy_depth=4, value_depth=4,
            auxiliary_heads='combat-economy-v1', card_value_head='card-cash-v1',
            action_values={'version':'soft-q-v1','temperature':.2}, scene_value_head='combat-benchmark-v1',
            multi_horizon='multi-horizon-v1'))
        saved = dict(model_spec=model.specification(), model=model.state_dict(), iteration=17, episodes=81)
        converted, report = plain_ppo_model(saved)
        self.assertTrue(report['removed_tensors'])
        self.assertEqual(report['source_iteration'], 17)
        for key, value in converted.state_dict().items():
            self.assertTrue(torch.equal(value, saved['model'][key]), key)
        self.assertFalse(hasattr(converted, 'action_value_type'))
        self.assertFalse(hasattr(converted, 'auxiliary'))
        saved['model']['unexpected.weight'] = torch.ones(1)
        with self.assertRaisesRegex(ValueError, 'unexpected'): plain_ppo_model(saved)


if __name__ == '__main__': unittest.main()
