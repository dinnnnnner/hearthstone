"""Check that performance installation removes shaping without changing placement rewards."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

spec=importlib.util.spec_from_file_location('performance_patch',Path(__file__).with_name('enable-training-performance.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class PerformancePatchTests(unittest.TestCase):
    def test_coordinator_removes_old_option_and_keeps_first_place_bonus(self):
        artifact=Path(__file__).parents[1]/'docs/rl-primary-scaling-20260915.json'
        source=json.loads(artifact.read_text())['coordinator_before_source']
        changed=module.patch_coordinator(source)
        self.assertEqual(module.patch_coordinator(changed),changed)
        self.assertNotIn('unused_gold_penalty',changed)
        self.assertIn("['--first-place-bonus', '1.0',",changed)
        self.assertIn("['--resume-sequence-batch-size',args.sequence_batch_size]",changed)

    def test_unknown_source_is_rejected(self):
        for patch in [module.patch_train,module.patch_coordinator]:
            with self.assertRaises(ValueError):patch('unexpected format')

    def test_sampler_removes_per_step_work_and_preserves_terminal_expression(self):
        source='''from .rewards import penalty_coefficient, unused_gold_reward, trajectory_rewards
class Pool:
    def collect(self, current, unused_gold_penalty=0.0):
        unused_gold_penalty = penalty_coefficient(unused_gold_penalty)
        penalty_total = 0.; penalized_ends = 0
        game = {"tracks": [[] for _ in range(8)], "step_rewards": [[] for _ in range(8)]}
        if current:
            if True:
                if True:
                    if True:
                        if True:
                            reward = unused_gold_reward(game['state'], action, unused_gold_penalty) if unused_gold_penalty else 0.
                            game['step_rewards'][seat].append(reward)
                            penalty_total -= reward; penalized_ends += int(reward < 0)
                            records.append(record)
                            if True:
                                terminal = reward_with_first_place_bonus(base, rank, first_place_bonus)
                                rewards = trajectory_rewards(game['step_rewards'][seat], terminal) if unused_gold_penalty else terminal
                                tracks.append((records, rewards))
'''
        changed=module.patch_rollout(source)
        self.assertEqual(module.patch_rollout(changed),changed)
        for removed in ['step_rewards','unused_gold','penalty_total']:
            self.assertNotIn(removed,changed)
        self.assertIn('terminal = reward_with_first_place_bonus(base, rank, first_place_bonus)',changed)
        self.assertIn('tracks.append((records, terminal))',changed)


if __name__=='__main__':unittest.main()
