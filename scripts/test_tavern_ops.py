"""Exercise release rollback and training-start guards without contacting servers."""
import contextlib
import datetime
import fcntl
import io
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid
import shutil
from unittest.mock import patch

TEMPLATES=Path(__file__).parent/'tavern-ops-templates'


class OperationGuards(unittest.TestCase):
    def test_blackwell_host_and_performance_flags(self):
        spec=importlib.util.spec_from_file_location('ops',Path(__file__).with_name('tavern-ops.py'))
        ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
        self.assertEqual(ops.TRAINING_SERVERS['west'],('root@connect.westb.seetacloud.com','51735'))
        self.assertIn('51735',ops.ssh_args(ops.TRAINING))
        directory=ops.render('test-'+uuid.uuid4().hex,4,model='all',workers=64,games=64,sequence_batch_size=32,fused_adam=True,sampling_processes=8,mps=True,training_graphs=True)
        try:
            source=(directory/'resume.py').read_text()
            self.assertIn("performance_args=['--sequence-batch-size', '32', '--fused-adam', '--training-graphs', '--sampling-processes', '8']",source)
            self.assertIn('use_mps=True',source)
            self.assertIn('*performance_args]',source)
            self.assertIn('hours=4',source)
        finally:shutil.rmtree(directory)

    def test_primary_model_and_batch_parameters_render_into_launcher(self):
        spec=importlib.util.spec_from_file_location('ops',Path(__file__).with_name('tavern-ops.py'))
        ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
        directory=ops.render('test-'+uuid.uuid4().hex,3,model='256',workers=64,games=64)
        try:
            source=(directory/'resume.py').read_text()
            self.assertIn("workers=64;games=64;active_members=['--active-members', '1']",source)
            self.assertIn('hours=3',source)
        finally:shutil.rmtree(directory)
        with self.assertRaises(ValueError):ops.render('invalid',1,model='256',workers=64,games=16)

    def test_resume_duration_and_lock(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'population';root.mkdir();work=Path(d)/'work';work.mkdir()
            initial={'stage':'time_limit','members':[{'pid':None} for _ in range(3)]}
            (root/'status.json').write_text(json.dumps(initial))
            source=(TEMPLATES/'resume.py').read_text().replace('/root/tavern-four-hour-20260914/population',str(root)).replace('/root/tavern-ops/__TAG__',str(work)).replace('__HOURS__','2.5')
            lock=(root/'.population.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with patch('subprocess.Popen') as launch:
                with self.assertRaises(BlockingIOError):exec(compile(source,'resume.py','exec'),{})
                launch.assert_not_called()
                self.assertEqual(json.loads((root/'status.json').read_text()),initial)
            lock.close()
            with patch('subprocess.Popen') as launch,contextlib.redirect_stdout(io.StringIO()):
                launch.return_value.pid=123
                exec(compile(source,'resume.py','exec'),{})
                record=json.loads((work/'resume.json').read_text())
                elapsed=datetime.datetime.fromisoformat(record['deadlineUtc'])-datetime.datetime.fromisoformat(record['startedUtc'])
                self.assertEqual(elapsed.total_seconds(),9000)
                self.assertTrue(launch.call_args.kwargs['start_new_session'])
                self.assertEqual(record['command'][record['command'].index('--workers')+1],'16')
                self.assertNotIn('--unused-gold-penalty',record['command'])

    def test_export_refuses_active_training(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'population';root.mkdir();work=Path(d)/'export'
            (root/'status.json').write_text(json.dumps({'stage':'running','members':[{'pid':123}]}))
            source=(TEMPLATES/'export_all.py').read_text().replace('/root/tavern-four-hour-20260914/population',str(root)).replace('/root/tavern-ops/__TAG__',str(work))
            with self.assertRaises(AssertionError):exec(compile(source,'export_all.py','exec'),{})
            self.assertFalse(work.exists())

    def run_deploy(self, rooms, fail_activation):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'public-rollback.json').write_text(json.dumps({'previousRelease':'/opt/bobs-tavern/releases/custom-previous'}))
            source=(TEMPLATES/'deploy.py').read_text().replace('/tmp/tavern-ops-__TAG__',str(root)).replace('__TAG__','test')
            commands=[]
            def fake_run(args,**kwargs):
                command=args[-1];commands.append(command)
                if 'curl ' in command:out=json.dumps({'rooms':rooms});code=0
                elif fail_activation and 'activate_compute.py' in command:out='';code=1
                else:out='{}';code=0
                return subprocess.CompletedProcess(args,code,stdout=out,stderr='injected' if code else '')
            with patch('subprocess.run',side_effect=fake_run):
                with self.assertRaises((AssertionError,RuntimeError)):exec(compile(source,'deploy.py','exec'),{})
            return commands

    def test_active_rooms_prevent_service_stop(self):
        commands=self.run_deploy(rooms=1,fail_activation=False)
        self.assertEqual(len(commands),1)
        self.assertFalse(any('systemctl stop' in c for c in commands))

    def test_failed_activation_restores_captured_release(self):
        commands=self.run_deploy(rooms=0,fail_activation=True)
        self.assertIn('systemctl stop bobs-tavern',commands)
        self.assertTrue(any("rollback.json" in c and "systemctl" in c for c in commands))
        self.assertTrue(any('custom-previous' in c and 'systemctl start bobs-tavern' in c for c in commands))


if __name__=='__main__':unittest.main()
