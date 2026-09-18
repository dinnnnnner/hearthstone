import importlib.util
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mail_training', Path(__file__).with_name('mail-training.py'))
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class MailTrainingTests(unittest.TestCase):
    def test_five_minute_interval_with_immediate_new_alert_and_completion(self):
        now=dt.datetime(2026,9,16,12,tzinfo=dt.timezone.utc)
        row=dict(job_pid=123,utc=now.isoformat(),healthy=True)
        state=dict(acceptedUtc=(now-dt.timedelta(seconds=60)).isoformat(),lastHealthy=True,lastIssues=[])
        self.assertFalse(mail.should_send(row,state,'all',300,now))
        self.assertTrue(mail.should_send(row,state,'all',300,now+dt.timedelta(seconds=240)))
        row.update(healthy=False,issues=['new fault'])
        self.assertTrue(mail.should_send(row,state,'all',300,now))
        state.update(lastHealthy=False,lastIssues=['new fault'])
        self.assertFalse(mail.should_send(row,state,'all',300,now))
        row['watch_complete']=True
        self.assertTrue(mail.should_send(row,state,'all',300,now))

    def test_supervised_job_identity_resources_staleness_and_no_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            job_path=Path(tmp)/'job.json';job_path.write_text('{}')
            birth=Path(f'/proc/{os.getpid()}/stat').read_text().rsplit(') ',1)[1].split()[19]
            config=dict(format='supervised-basic',supervisorPid=os.getpid(),supervisorBirth=birth,
                        sender='sender@example.com',recipient='recipient@example.com')
            state=dict(pid=os.getpid(),job=str(job_path),stage='running',started=dt.datetime.now(dt.timezone.utc).isoformat(),
                       members=[dict(depth=1024,episodes=168,iteration=14)],resources=dict(cpu_percent=99,ram_gib=70,gpu_percent=80,vram_used_mib=48000))
            path=Path(tmp)/'status.json';path.write_text(json.dumps(state))
            row=mail.load_snapshot(config,job_path,{})
            self.assertTrue(row['healthy']);self.assertEqual(row['cpu_percent_since_previous_check'],99)
            msg=mail.message(config,row,{})
            self.assertIn('持续训练，无预设停止时间',msg.get_content())
            self.assertIn('1024 层：新评分续训累计 168 局',msg.get_content())
            state['started']='2020-01-01T00:00:00+00:00';path.write_text(json.dumps(state))
            self.assertFalse(mail.load_snapshot(config,job_path,{})['healthy'])
            state['pid']+=1;path.write_text(json.dumps(state))
            with self.assertRaises(ValueError):mail.load_snapshot(config,job_path,{})

    def test_dedup_and_completion_in_alert_mode(self):
        row = dict(job_pid=123, utc='2026-09-15T10:00:00+00:00', healthy=True)
        self.assertTrue(mail.should_send(row, {}, 'all'))
        self.assertFalse(mail.should_send(row, {}, 'alerts'))
        row['watch_complete'] = True
        self.assertTrue(mail.should_send(row, {}, 'alerts'))
        self.assertFalse(mail.should_send(row, {'lastSent': mail.snapshot_key(row)}, 'all'))
        row['utc'] = '2026-09-15T10:05:00+00:00'
        self.assertTrue(mail.should_send(row, {}, 'alerts'))

    def test_recipient_and_beijing_deadline(self):
        config = dict(sender='sender@example.com', recipient='recipient@example.com')
        row = dict(job_pid=123, utc='2026-09-15T10:00:00+00:00', healthy=False,
                   stage='check_failed', issues=['Unable to inspect training'])
        msg = mail.message(config, row, dict(deadlineUtc='2026-09-15T22:52:05+00:00'))
        self.assertEqual(msg['To'], 'recipient@example.com')
        self.assertIn('2026-09-16 06:52:05', msg.get_content())
        self.assertIn('异常', msg['Subject'])

    def test_quit_failure_after_acceptance_does_not_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            secret = Path(tmp) / 'secret'
            secret.write_text('test-only')
            secret.chmod(0o600)
            config = dict(passwordFile=str(secret), host='smtp.example.com', port=465,
                          sender='sender@example.com', recipient='recipient@example.com')
            with patch.object(mail.smtplib, 'SMTP_SSL') as smtp:
                smtp.return_value.send_message.return_value = {}
                smtp.return_value.quit.side_effect = mail.smtplib.SMTPServerDisconnected('closed')
                mail.deliver(config, mail.EmailMessage())
                smtp.return_value.send_message.assert_called_once()
            secret.chmod(0o644)
            with self.assertRaises(ValueError):
                mail.deliver(config, mail.EmailMessage())


if __name__ == '__main__':
    unittest.main()
