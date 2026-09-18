import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('supervise_basic',Path(__file__).with_name('supervise-basic-training.py'))
watch=importlib.util.module_from_spec(spec);spec.loader.exec_module(watch)

class SuperviseBasicTests(unittest.TestCase):
    def test_resource_exhaustion_and_new_oom_stop_but_high_utilization_does_not(self):
        sample=dict(memory_fraction=.85,disk_free_gib=3,shm_free_gib=20,oom_kill=0,
                    vram_used_mib=85000,vram_total_mib=98000,gpu_percent=100,cpu_percent=100)
        self.assertEqual(watch.assess(sample,sample,[]),([],[]))
        changed=copy.deepcopy(sample);changed.update(memory_fraction=.95,oom_kill=1)
        warnings,fatal=watch.assess(changed,sample,[])
        self.assertIn('memory_above_94_percent',fatal);self.assertIn('new_oom_kill',fatal)
        changed=copy.deepcopy(sample);changed.update(disk_free_gib=.9,shm_free_gib=1)
        self.assertEqual(set(watch.assess(changed,sample,[])[1]),{'disk_below_1_gib','scratch_below_2_gib'})

    def test_completed_workers_are_healthy_but_stalled_or_failed_ones_are_not(self):
        sample=dict(memory_fraction=.5,disk_free_gib=3,shm_free_gib=20,oom_kill=0)
        member=dict(depth=1024,process_valid=False,finished=True,progress_age_seconds=901)
        self.assertEqual(watch.assess(sample,None,[member]),([],[]))
        member.update(finished=False,process_valid=True,progress_age_seconds=910)
        self.assertIn('1024:no_sampling_or_checkpoint_progress_900s',watch.assess(sample,None,[member])[1])
        member.update(progress_age_seconds=3,error='nonfinite_value_loss')
        self.assertIn('1024:nonfinite_value_loss',watch.assess(sample,None,[member])[1])

if __name__=='__main__':unittest.main()
