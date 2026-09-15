import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('watch_training',Path(__file__).with_name('watch-training.py'))
watch=importlib.util.module_from_spec(spec);spec.loader.exec_module(watch)


class WatchTrainingTests(unittest.TestCase):
    def row(self):
        return dict(stage='running',coordinator_valid=True,memory_fraction=.7,disk_free_gib=20,oom_kill=0,
                    members=[dict(index=0,stage='training',pid=10,start_ticks=100,cpu_seconds=20,
                                  episodes=64,activity_age_seconds=1000,process_valid=True,log_error=False)])

    def test_active_ppo_is_not_stalled_even_without_recent_stdout(self):
        row=self.row();before=copy.deepcopy(row);before['members'][0]['cpu_seconds']=10
        self.assertEqual(watch.assess(row,before,1000,2000),[])

    def test_dead_or_idle_worker_and_new_oom_are_reported(self):
        row=self.row();before=copy.deepcopy(row);row['oom_kill']=1
        issues=watch.assess(row,before,1000,2000)
        self.assertTrue(any('no recent progress' in s for s in issues))
        self.assertTrue(any('OOM' in s for s in issues))
        row['members'][0]['process_valid']=False
        self.assertTrue(any('process is missing' in s for s in watch.assess(row,None,1000,2000)))

    def test_new_child_does_not_inherit_previous_child_idle_timer(self):
        row=self.row();before=copy.deepcopy(row);row['members'][0]['start_ticks']+=100
        self.assertEqual(watch.assess(row,before,1000,2000),[])

    def test_expected_deadline_exit_is_healthy_but_early_exit_is_not(self):
        row=self.row();row['stage']='time_limit';row['members'][0]['pid']=None
        self.assertEqual(watch.assess(row,None,2010,2000),[])
        self.assertTrue(watch.assess(row,None,1000,2000))

    def test_training_log_failure_and_checkpoint_regression_are_reported(self):
        row=self.row();before=copy.deepcopy(row)
        row['members'][0].update(log_error=True,episodes=32)
        issues=watch.assess(row,before,1000,2000)
        self.assertTrue(any('exception' in s for s in issues))
        self.assertTrue(any('decreased' in s for s in issues))

    def test_same_pid_with_wrong_member_output_is_not_valid(self):
        member=dict(stage='training',root='/tmp/member-0')
        proc=dict(argv=['python','-m','tavern_rl.train','--output','/tmp/member-1/training'])
        self.assertFalse(watch.correct_member_process(proc,member))
        proc['argv'][-1]='/tmp/member-0/training'
        self.assertTrue(watch.correct_member_process(proc,member))


if __name__=='__main__':unittest.main()
