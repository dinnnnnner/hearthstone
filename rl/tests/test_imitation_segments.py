"""Verify recurrent resets and full sample coverage through the training loop."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from tavern_rl.imitate import train_trial


class TinyPolicy(torch.nn.Module):
    hidden = 1
    action_size = 2

    def __init__(self):
        super().__init__()
        self.weight = torch.nn.Parameter(torch.tensor(.2))
        self.calls = []

    def act(self, entities, mask, memory, previous, with_value=False):
        self.calls.append((float(memory.item()), int(previous.item())))
        logits = torch.stack([self.weight, -self.weight]).unsqueeze(0)
        distribution = torch.distributions.Categorical(logits=logits.masked_fill(~mask, -torch.inf))
        return distribution, None, memory + 1


class ImitationSegmentTests(unittest.TestCase):
    def test_training_and_evaluation_reset_each_segment_and_cover_all_labels(self):
        actions = [{'type': 'buy'}, {'type': 'end'}]
        schema = {'actions': actions, 'entity_schema': {}}
        manifest = {'schema': json.dumps(schema), 'contract': 'test'}
        segments = [[{'step': i, 'action': 0, 'legal': [0, 1], 'previous': 2 if i % 2 == 0 else 0,
                      'entities': []} for i in indices] for indices in [(0, 1), (2, 3)]]
        episode = {'start': {'gameId': 'one', 'source': 'human', 'buildId': 'test'},
                   'file': 'one.jsonl.gz', 'sha256': 'test', 'selection': {'mode': 'continuous_segments'},
                   'steps': [r for s in segments for r in s], 'segments': segments}
        policy = TinyPolicy()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / 'base.pt'
            torch.save({'model_spec': dict(schema, architecture='entity-gru'), 'model': policy.state_dict(),
                        'metadata': {'contract': 'test', 'checkpointSha256': 'base', 'imitationUpdates': 8}}, checkpoint)
            with patch('tavern_rl.imitate.load_dataset', return_value=(manifest, [copy.deepcopy(episode)], [])), \
                 patch('tavern_rl.imitate.make_model', return_value=policy), \
                 patch('tavern_rl.imitate.prepare_entities', side_effect=lambda x: x):
                report = train_trial(checkpoint, root, root / 'trial', updates=4, sequence_length=1,
                                     single_game=True, allow_incomplete_segments=True)
            self.assertEqual(report['trainingChunks'], 4)
            self.assertEqual(report['uniqueSupervisedSteps'], 4)
            self.assertEqual(report['before']['training']['samples'], 4)
            self.assertIsNone(report['before']['validation'])
            self.assertIsNone(report['after']['validation'])
            self.assertTrue(report['changedTensors'])
            self.assertEqual(set(policy.calls), {(0., 2), (1., 0)})
            saved = torch.load(root / 'trial/candidate.pt', weights_only=True)
            self.assertEqual(saved['metadata']['imitationTotalUpdates'], 12)
            self.assertEqual(saved['metadata']['parentCheckpointSha256'], 'base')


if __name__ == '__main__':
    unittest.main()
