import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('after_training',Path(__file__).with_name('after-training.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class ScheduledTransitionTests(unittest.TestCase):
    def state(self, stage='running', **extra):
        return dict(pid=42,deadline_utc='2026-09-15T07:50:39+00:00',stage=stage,members=[dict(pid=None)]*3)|extra
    def check(self,state):return module.ready(state,42,'2026-09-15T07:50:39+00:00')
    def test_waits_for_running_and_requires_the_scheduled_stop(self):
        self.assertFalse(self.check(self.state()))
        self.assertTrue(self.check(self.state('time_limit')))
        for state in [self.state('failed'),self.state('interrupted'),self.state('time_limit',members=[dict(pid=7)])]:
            with self.assertRaises(RuntimeError):self.check(state)
    def test_never_publishes_or_extends_a_replacement_job(self):
        for state in [self.state('time_limit',pid=43),self.state('time_limit',deadline_utc='2026-09-16T07:50:39+00:00')]:
            with self.assertRaises(RuntimeError):self.check(state)

class PipelineOrderTests(unittest.TestCase):
    def exercise(self, fail_publish=False):
        import json,tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);job=root/'job';work=root/'work';work.mkdir();events=[]
            deadline='2099-09-15T07:50:39+00:00'
            stopped=dict(pid=42,deadline_utc=deadline,stage='time_limit',members=[dict(pid=None)]*3)
            receipt=dict(pid=99,deadlineUtc='2099-09-15T11:55:00+00:00',watchPid=100)
            def publish(*args,**kwargs):
                events.append('publish')
                self.assertTrue(kwargs['include_search']);self.assertTrue(kwargs['wait_for_idle'])
                if fail_publish:raise RuntimeError('publication verification failed')
                (work/'model-verification.json').write_text(json.dumps(dict(stage='verified')))
            def train(*args):
                events.append('train');self.assertEqual(args[2],4.)
                (work/'resume.json').write_text(json.dumps(receipt))
            argv=['after-training','--job',str(job),'--expected-pid','42','--deadline-utc',deadline,
                  '--hours','4','--control-path','/tmp/test-socket']
            with patch('sys.argv',argv),patch.object(module.ops,'state',side_effect=[stopped|dict(stage='running'),stopped,stopped,stopped]), \
                 patch.object(module.ops,'ssh_args',return_value=['ssh','host']),patch.object(module.ops,'ssh',return_value='{"ok":true,"rooms":0}'), \
                 patch.object(module.ops,'render',return_value=work),patch.object(module.ops,'publish',side_effect=publish), \
                 patch.object(module.ops,'train',side_effect=train),patch.object(module.ops,'copy_to'), \
                 patch.object(module.ops,'remote_python',return_value=json.dumps(receipt)),patch.object(module.time,'sleep'):
                if fail_publish:
                    with self.assertRaises(RuntimeError):module.main()
                else:module.main()
            status=json.loads((job/'status.json').read_text())
            self.assertEqual(events,['publish'] if fail_publish else ['publish','train'])
            self.assertEqual(status['stage'],'failed' if fail_publish else 'complete')
            if not fail_publish:self.assertEqual(status['watchPid'],100)
    def test_verified_publication_precedes_resume_and_watch(self):self.exercise()
    def test_failed_publication_never_starts_more_training(self):self.exercise(True)

if __name__=='__main__':unittest.main()
