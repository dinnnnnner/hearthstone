import fcntl
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tavern_rl.maintenance import cleanup, discover


def run(root, name, content=b'checkpoint'):
    directory = root/name
    training = directory/'member-0/training'
    training.mkdir(parents=True)
    (training/'latest.pt').write_bytes(content)
    (directory/'status.json').write_text(json.dumps(dict(stage='time_limit', members=[dict(pid=None)])))
    return directory


class MaintenanceTests(unittest.TestCase):
    def test_dedup_preserves_all_paths_unique_weights_and_atomic_next_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);a=run(root,'a');b=run(root,'b')
            unique=b/'member-0/best.pt';unique.write_bytes(b'other-best')
            log=b/'member-0/training/metrics.jsonl';log.write_text('metrics')
            initial=a/'member-0/initial.pt';initial.write_bytes(b'checkpoint')
            data=b/'member-0/human.jsonl';data.write_text('training-data')
            partial=b/'member-0/training/latest.pt.next';partial.write_bytes(b'incomplete')
            result=cleanup([a,b],True,min_bytes=1)
            first=a/'member-0/training/latest.pt';second=b/'member-0/training/latest.pt'
            self.assertEqual(first.stat().st_ino,second.stat().st_ino)
            self.assertEqual(initial.read_bytes(),b'checkpoint')
            self.assertEqual(unique.read_bytes(),b'other-best')
            self.assertEqual(log.read_text(),'metrics');self.assertEqual(data.read_text(),'training-data')
            self.assertFalse(partial.exists())
            self.assertEqual(result['unique_checkpoints_deleted'],0)
            partial.write_bytes(b'new-version');partial.replace(second)
            self.assertEqual(first.read_bytes(),b'checkpoint')
            self.assertEqual(second.read_bytes(),b'new-version')

    def test_live_processes_and_held_training_locks_block_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=run(Path(tmp),'run')
            partial=root/'member-0/training/latest.pt.next';partial.write_bytes(b'partial')
            state=dict(stage='time_limit',pid=os.getpid(),members=[dict(pid=None)])
            (root/'status.json').write_text(json.dumps(state))
            self.assertTrue(cleanup([root],True,min_bytes=1)['skipped'])
            state.pop('pid');(root/'status.json').write_text(json.dumps(state))
            with (root/'member-0/training/.train.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertTrue(cleanup([root],True,min_bytes=1)['skipped'])
                self.assertTrue(partial.exists())

    def test_dry_run_reports_but_does_not_replace_or_delete(self):
        with tempfile.TemporaryDirectory() as tmp:
            a=run(Path(tmp),'a');b=run(Path(tmp),'b')
            partial=b/'member-0/initial.pt.next';partial.write_bytes(b'partial')
            result=cleanup([a,b],False,min_bytes=1)
            self.assertTrue(result['linked']);self.assertTrue(partial.exists())
            self.assertNotEqual((a/'member-0/training/latest.pt').stat().st_ino,(b/'member-0/training/latest.pt').stat().st_ino)

    def test_symlinks_and_unknown_jobs_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);a=run(base,'a');outside=base/'external.pt';outside.write_bytes(b'checkpoint')
            (a/'member-0/link.pt').symlink_to(outside)
            unknown=base/'human';unknown.mkdir();(unknown/'status.json').write_text('{"stage":"finished"}')
            result=cleanup([a,unknown],True,min_bytes=1)
            self.assertTrue((a/'member-0/link.pt').is_symlink())
            self.assertEqual(outside.read_bytes(),b'checkpoint')
            self.assertEqual(len(result['skipped']),1)

    def test_hash_cache_does_not_rehash_unchanged_files_on_every_poll(self):
        with tempfile.TemporaryDirectory() as tmp:
            a=run(Path(tmp),'a',b'123456');b=run(Path(tmp),'b',b'abcdef');cache={}
            cleanup([a,b],True,cache,min_bytes=1)
            with patch('tavern_rl.maintenance.hashlib.sha256',side_effect=AssertionError('Unexpected rehash')):
                cleanup([a,b],True,cache,min_bytes=1)
            (b/'member-0/training/latest.pt').write_bytes(b'123456')
            result=cleanup([a,b],True,cache,min_bytes=1)
            self.assertEqual(len(result['linked']),1)

    def test_discovery_only_targets_project_group_run_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);a=run(base/'tavern-test/rl/runs','job')
            run(base/'another-project/rl/runs','job')
            self.assertEqual(discover([base]),[a])


if __name__=='__main__':unittest.main()
