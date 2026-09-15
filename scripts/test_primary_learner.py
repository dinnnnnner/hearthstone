"""Exercise the deployed coordinator with fake child processes.

Set TAVERN_COORDINATOR_SOURCE to a saved copy of population_resume.py.
"""
import contextlib
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('primary_patch', Path(__file__).with_name('enable-primary-learner.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def reward_parser_stub():
    # These tests exercise process selection, not the separately tested reward parser.
    package = types.ModuleType('tavern_rl')
    package.__path__ = []
    rewards = types.ModuleType('tavern_rl.rewards')
    rewards.penalty_coefficient = float
    package.rewards = rewards
    return {'tavern_rl': package, 'tavern_rl.rewards': rewards}


class PrimaryLearnerTests(unittest.TestCase):
    def test_unknown_source_is_rejected(self):
        with self.assertRaises(ValueError):
            module.patch_source('print("unexpected")')

    def coordinator(self):
        path = os.environ.get('TAVERN_COORDINATOR_SOURCE')
        if path:
            original = Path(path).read_text()
        else:
            artifact = Path(__file__).parents[1] / 'docs/rl-primary-scaling-20260915.json'
            if not artifact.exists():
                self.skipTest('Set TAVERN_COORDINATOR_SOURCE or provide the deployment audit fixture')
            original = json.loads(artifact.read_text())['coordinator_before_source']
        source = module.patch_source(original)
        self.assertEqual(module.patch_source(source), source)
        return source

    def test_only_selected_model_updates_and_other_two_remain_opponents(self):
        self.exercise_selection([1])

    def test_omitted_selection_keeps_all_three_learners(self):
        self.exercise_selection(None)

    def exercise_selection(self, selected):
        source = self.coordinator()
        indices = list(range(3)) if selected is None else selected
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoints = [root / f'member-{i}/training/latest.pt' for i in range(3)]
            for path in checkpoints:
                path.parent.mkdir(parents=True)
                path.write_bytes(b'original-checkpoint')
            (root / 'status.json').write_text(json.dumps(dict(stage='interrupted', members=[dict(pid=None, round=1) for _ in range(3)])))
            commands = []
            def launch(command, **kwargs):
                commands.append(command)
                self.assertTrue(kwargs['start_new_session'])
                if 'tavern_rl.mix_league' in command:
                    output = Path(command[command.index('--output') + 1])
                    output.mkdir()
                    (output / 'latest.pt').write_bytes(b'mixed')
                    (output / 'league.json').write_text('{}')
                process = Mock(pid=500 + len(commands))
                process.poll.return_value = 0
                process.wait.return_value = 0
                return process
            deadline = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).isoformat()
            argv = ['coordinator', '--resumes', *map(str, checkpoints), '--output', str(root),
                    '--deadline-utc', deadline, '--workers', '64', '--games-per-iteration', '64']
            if selected is not None:
                argv += ['--active-members', *map(str, selected)]
            with patch.dict(sys.modules, reward_parser_stub()), patch.object(sys, 'argv', argv), patch('subprocess.Popen', side_effect=launch), \
                 patch('time.sleep', side_effect=[None, KeyboardInterrupt('test stop')]), \
                 patch('os.killpg') as kill, contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(KeyboardInterrupt):
                    exec(compile(source, 'coordinator', 'exec'), {'__name__': '__main__'})
            self.assertEqual(len(commands), 2 * len(indices))
            for offset, index in enumerate(indices):
                mixing, training = commands[offset], commands[len(indices) + offset]
                for other in range(3):
                    if other != index:
                        self.assertIn(str(checkpoints[other]), mixing)
                self.assertEqual(training[training.index('--output') + 1], str(checkpoints[index].parent))
                self.assertEqual(training[training.index('--workers') + 1], '64')
                self.assertEqual(training[training.index('--resume-games-per-iteration') + 1], '64')
                self.assertEqual(training[training.index('--first-place-bonus') + 1], '1.0')
            self.assertTrue(kill.called)
            state = json.loads((root / 'status.json').read_text())
            self.assertEqual(state['active_members'], indices)
            self.assertEqual(state['stage'], 'interrupted')
            self.assertTrue(all(member['pid'] is None for member in state['members']))
            self.assertTrue(all(path.read_bytes() == b'original-checkpoint' for path in checkpoints))

    def test_invalid_member_rejected_before_launch(self):
        source = self.coordinator()
        argv = ['coordinator', '--resumes', '/a', '/b', '/c', '--output', '/unused',
                '--deadline-utc', '2099-01-01T00:00:00+00:00', '--active-members', '3']
        with patch.dict(sys.modules, reward_parser_stub()), patch.object(sys, 'argv', argv), patch('subprocess.Popen') as launch:
            with self.assertRaisesRegex(ValueError, 'Active members'):
                exec(compile(source, 'coordinator', 'exec'), {'__name__': '__main__'})
            launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
