import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mail_training', Path(__file__).with_name('mail-training.py'))
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class MailTrainingTests(unittest.TestCase):
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
