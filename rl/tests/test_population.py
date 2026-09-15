import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from tavern_rl import population


class PopulationTests(unittest.TestCase):
    def run_population(self, root, fail=False):
        sources=[]
        for i in range(3):
            p=root/f'source-{i}.pt';p.write_bytes(bytes([i]));sources.append(str(p))
        out=root/'population';commands=[];processes=[]
        class Process:
            def __init__(self, command, **kwargs):
                self.pid=90000+len(processes);processes.append(self);commands.append(command)
                self.command=command;self.code=None
            def poll(self):
                if self.code is not None:return self.code
                c=self.command;directory=Path(c[c.index('--output')+1]);directory.mkdir(exist_ok=True)
                if c[2]=='tavern_rl.mix_league':
                    (directory/'latest.pt').write_bytes(b'mixed')
                    (directory/'league.json').write_text('{}')
                else:
                    (directory/'latest.pt').write_bytes(b'trained')
                self.code=1 if fail and c[2]=='tavern_rl.train' else 0
                return self.code
        ticks=[0.]
        def monotonic():ticks[0]+=.2;return ticks[0]
        args=['population','--resumes',*sources,'--output',str(out),
            '--deadline-utc','1970-01-01T00:00:30+00:00','--device','cpu','--first-place-bonus','1']
        with patch('sys.argv',args),patch.object(population.time,'time',return_value=0),\
             patch.object(population.time,'monotonic',side_effect=monotonic),patch.object(population.time,'sleep'),\
             patch.object(population.subprocess,'Popen',side_effect=Process),\
             patch.object(population,'stop_processes') as stop,patch('builtins.print'):
            if fail:
                with self.assertRaisesRegex(RuntimeError,'exited 1'):population.main()
            else:population.main()
            self.assertTrue(stop.called)
        return out,commands

    def test_independent_learners_refresh_without_waiting_for_other_segments(self):
        with tempfile.TemporaryDirectory() as directory:
            out,commands=self.run_population(Path(directory))
            status=json.loads((out/'status.json').read_text())
            self.assertEqual(status['stage'],'time_limit')
            self.assertEqual(len(status['members']),3)
            self.assertTrue(all(m['round']>1 for m in status['members']))
            mixing=[c for c in commands if c[2]=='tavern_rl.mix_league']
            self.assertTrue(any('/training/latest.pt' in p for c in mixing for p in c[c.index('--opponents')+1:c.index('--output')]))
            for c in commands:
                target=Path(c[c.index('--output')+1]).parent
                resume=Path(c[c.index('--resume')+1])
                self.assertTrue(resume.is_relative_to(target))
                if c[2]=='tavern_rl.train':
                    from tavern_rl.train import parser
                    parsed = parser().parse_args(c[3:])
                    self.assertEqual(parsed.first_place_bonus, 1.)
                    self.assertNotIn('--unused-gold-penalty', c)
                if c[2]=='tavern_rl.mix_league':
                    opponents=c[c.index('--opponents')+1:c.index('--output')]
                    self.assertEqual(len(opponents),2)
                    self.assertTrue(all(not Path(p).is_relative_to(target) for p in opponents))
            # Sources remain intact, and generated resume files stay bounded.
            self.assertEqual((Path(directory)/'source-0.pt').read_bytes(),b'\0')
            self.assertEqual(len(list(out.glob('member-*/exchange/latest.pt'))),3)

    def test_failure_stops_population_and_keeps_completed_checkpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            out,_=self.run_population(Path(directory),fail=True)
            status=json.loads((out/'status.json').read_text())
            self.assertEqual(status['stage'],'failed')
            self.assertTrue((out/'member-0/training/latest.pt').exists())

    def test_deadline_requires_explicit_timezone(self):
        with self.assertRaises(ValueError):population.deadline_seconds('2026-09-11T19:30:34')
        self.assertEqual(population.deadline_seconds('2026-09-11T19:30:34+08:00'),
            population.deadline_seconds('2026-09-11T11:30:34+00:00'))


if __name__=='__main__':unittest.main()
