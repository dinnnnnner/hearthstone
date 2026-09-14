import copy
import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import torch
from tavern_rl.imitate_repeated import repeated_trial


class Policy(torch.nn.Module):
    hidden = 1
    action_size = 2
    def __init__(self):
        super().__init__()
        self.weight = torch.nn.Parameter(torch.tensor(.2))
        self.critic = torch.nn.Linear(1, 1)
        self.calls = []
    def act(self, entities, mask, memory, previous, with_value=False):
        self.calls.append((float(memory.item()), int(previous.item())))
        logits = torch.stack([self.weight, -self.weight]).unsqueeze(0)
        return torch.distributions.Categorical(logits=logits), None, memory + 1


class RepeatedImitationTests(unittest.TestCase):
    def test_two_games_repeat_with_gap_resets_and_no_source_or_critic_mutation(self):
        torch.set_num_threads(1)
        model = Policy()
        schema = dict(actions=[dict(type='upgrade'),dict(type='buy')], entity_schema={})
        episodes = []
        for game in ('one','two'):
            segments = [[dict(step=i,action=0,legal=[0,1],previous=2 if i%2==0 else 0,entities=[])
                         for i in indices] for indices in ((0,1),(2,3))]
            episodes.append(dict(start=dict(gameId=game),file=game,sha256=game,selection={},
                                 segments=segments,steps=[s for segment in segments for s in segment]))
        saved = dict(model_spec=dict(schema,architecture='entity-gru'),model=copy.deepcopy(model.state_dict()),
                     meta=dict(observationVersion=4),optimizer={'untouched':True},config={},iteration=3,episodes=48,
                     league=[],torch_rng=torch.get_rng_state(),numpy_rng=(),python_rng=())
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); source=root/'source.pt';torch.save(saved,source)
            original=source.read_bytes()
            deadline=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).isoformat()
            with patch('tavern_rl.imitate_repeated.make_model',return_value=model), \
                 patch('tavern_rl.imitate_repeated.prepare_entities',side_effect=lambda x:x), \
                 patch('tavern_rl.imitate_repeated.load_dataset',return_value=(dict(schema=json.dumps(schema),contract='test'),episodes,[])):
                report=repeated_trial(source,root,root/'trial',deadline,sequence_length=1,max_updates=16)
            self.assertEqual(report['fullPasses'],2)
            self.assertEqual(report['uniqueSupervisedSteps'],8)
            self.assertEqual(report['supervisedStepVisits'],16)
            self.assertEqual(report['actionVisits']['upgrade'],16)
            self.assertEqual(report['after']['upgrade']['samples'],8)
            self.assertEqual(set(model.calls),{(0.,2),(1.,0)})
            self.assertEqual(source.read_bytes(),original)
            candidate=torch.load(root/'trial/candidate.pt',weights_only=False)
            self.assertFalse(torch.equal(candidate['model']['weight'],saved['model']['weight']))
            for key in ('critic.weight','critic.bias'):
                self.assertTrue(torch.equal(candidate['model'][key],saved['model'][key]))
            self.assertEqual(candidate['report']['updates'],16)
            self.assertIn('imitation_optimizer',candidate)

    def test_expired_deadline_does_not_open_or_modify_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'trial'
            with self.assertRaisesRegex(ValueError,'future deadline'):
                repeated_trial('missing','missing',output,'2000-01-01T00:00:00+00:00')
            self.assertFalse(output.exists())


if __name__ == '__main__': unittest.main()
