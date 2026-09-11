import unittest

from tavern_rl.bridge import Simulator
from tavern_rl.features import prepare_entities


class PublicObservationTests(unittest.TestCase):
    def test_packaged_simulator_exposes_completed_scouting_to_python(self):
        with Simulator() as simulator:
            meta = simulator.meta
            self.assertEqual(meta['observationVersion'], 4)
            self.assertEqual(meta['entitySchema']['version'], 3)
            self.assertIsNone(meta['legacyV2SourceHash'])
            state = simulator.reset(42)
            while state['info']['turn'] == 1:
                legal = state['legalActions']
                action = next((i for i in legal if meta['actions'][i]['type'] == 'end'), legal[0])
                state = simulator.step(action)
            self.assertEqual(len(state['observation']), 3209)
            offset = meta['entitySchema']['offsets'][7]
            for entity in state['entities'][offset:offset + 7]:
                details = entity['details']
                self.assertEqual(len(details['scouting']), 1)
                self.assertEqual(details['scouting'][0]['turn'], 1)
                self.assertIn(details['scouting'][0]['battle']['result'], ['win', 'loss', 'tie'])
                self.assertIn('rankingHealth', details)
                self.assertIn('spellArmor', details)
            observation = prepare_entities(state['entities'])
            paths = [path for slot, path, fields in observation.groups if slot == offset]
            self.assertIn('root/scouting/0/warband', paths)
            self.assertIn('root/scouting/0/battle', paths)


if __name__ == '__main__':
    unittest.main()
