import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from tavern_rl.campaign import run_stage, write_json
from tavern_rl.train import parser


class CampaignTests(unittest.TestCase):
    def test_stage_timeout_preserves_completed_checkpoint(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);checkpoint=root/'latest.pt'
            command=[sys.executable,'-c','import pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text("complete");time.sleep(10)',str(checkpoint)]
            with self.assertRaises(subprocess.TimeoutExpired):run_stage(command,root/'stage.log',1)
            self.assertEqual(checkpoint.read_text(),'complete')

    def test_failed_stage_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError,'exited 3'):
                run_stage([sys.executable,'-c','raise SystemExit(3)'],Path(temp)/'failed.log',10)

    def test_status_is_atomic_and_resume_changes_are_explicit(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'status.json';write_json(path,dict(stage='training'));write_json(path,dict(stage='time_limit'))
            self.assertEqual(json.loads(path.read_text())['stage'],'time_limit')
            self.assertFalse(path.with_suffix('.json.next').exists())
        defaults=parser().parse_args([])
        self.assertIsNone(defaults.resume_games_per_iteration)
        self.assertIsNone(defaults.resume_learning_rate)
        args=parser().parse_args(['--resume','model.pt','--resume-games-per-iteration','16','--resume-learning-rate','0.0001','--rollout-device','cpu'])
        self.assertEqual(args.resume_games_per_iteration,16);self.assertEqual(args.resume_learning_rate,1e-4)


if __name__=='__main__':unittest.main()
