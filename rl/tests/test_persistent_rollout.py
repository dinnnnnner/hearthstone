import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock,patch

import torch

from tavern_rl.persistent_rollout import ResidentProcesses, ResidentSampler


class ResidentTests(unittest.TestCase):
    def test_seed_reservation_survives_partial_completion_and_restart(self):
        from tavern_rl.training_performance import reserve_game_seeds
        config=dict(seed=42,games_per_iteration=8)
        first=reserve_game_seeds(config,100)
        # Highest seeds may finish first; a completed-game count is not a cursor.
        resumed=dict(config)
        second=reserve_game_seeds(resumed,102)
        self.assertFalse(set(first)&set(second))
        self.assertEqual(second[0],150)
        legacy=dict(seed=42,games_per_iteration=8,unfinished_games_at_checkpoint=6)
        self.assertEqual(reserve_game_seeds(legacy,102),second)

    def test_real_processes_match_fresh_sampling_across_weight_updates(self):
        from tavern_rl.bridge import Simulator
        from tavern_rl.entity_model import EntityActorCritic
        from tavern_rl.streaming import enable_auxiliary
        from tavern_rl.train import atomic_checkpoint,cpu_weights
        from tavern_rl.process_rollout import ProcessSimulationPool
        torch.set_num_threads(1);torch.manual_seed(145)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'latest.pt'
            simulator=Simulator()
            meta=simulator.meta;simulator.close()
            model=EntityActorCritic(meta['entitySchema'],meta['actions'],hidden=16,heads=2,layers=1)
            enable_auxiliary(model)
            pools=[ProcessSimulationPool(2,2,path,persistent=mode) for mode in (False,True)]
            try:
                pids=None
                for step in range(2):
                    if step:
                        with torch.no_grad():model.critic.bias.add_(.125)
                    atomic_checkpoint(path,dict(meta=meta,model_spec=model.specification(),model=cpu_weights(model),league=[]))
                    results=[pool.collect(model,[],[987621,987622],dict(maxActionsPerTurn=3,maxSteps=10000,recordFrames=False),
                        'cpu',learner_seats=8,streaming=dict(turns=2,auxiliary_coef=.1)) for pool in pools]
                    self.assertEqual(results[0][1],results[1][1])
                    first,second=results[0][0],results[1][0]
                    self.assertEqual(len(first),len(second))
                    for (a,ar),(b,br) in zip(first,second):
                        self.assertEqual([r[2] for r in a],[r[2] for r in b])
                        torch.testing.assert_close(torch.tensor([r[3:5] for r in a]),torch.tensor([r[3:5] for r in b]),rtol=0,atol=0)
                        self.assertEqual(ar['bootstrap'],br['bootstrap'])
                    current=[entry[1].pid for entry in pools[1].resident.workers.values()]
                    if pids is not None:self.assertEqual(pids,current)
                    pids=current
            finally:
                for pool in pools:pool.close()

    def test_trainer_stop_between_collections_reaps_resident_workers(self):
        self.check_trainer_stop_between_collections()

    def check_trainer_stop_between_collections(self,central=False):
        import os,signal,subprocess,sys,time
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);ready=root/'ready.json';log=root/'process.log'
            script="""
import json,os,sys,time
from pathlib import Path
from tavern_rl import train
root=Path(sys.argv[1])
original=train.atomic_checkpoint
calls=0
def checkpoint(path,payload):
    global calls
    calls+=1
    original(path,payload)
    if calls==2:
        # Read only direct children; these include every resident Python worker.
        children=Path('/proc/self/task/'+str(os.getpid())+'/children').read_text().split()
        (root/'ready.json').write_text(json.dumps([int(p) for p in children]))
        time.sleep(60)
train.atomic_checkpoint=checkpoint
sys.argv=['train','--output',str(root/'training'),'--iterations','2',
    '--games-per-iteration','2','--workers','2','--sampling-processes','2',
    '--persistent-samplers','--device','cpu','--architecture','mlp',
    '--hidden','8','--max-steps','10000','--max-actions','3']
train.main()
"""
            if central:script=script.replace("'--persistent-samplers','--device'","'--persistent-samplers','--central-inference','--device'").replace("'--architecture','mlp'","'--architecture','entity-gru'")
            with log.open('w') as output:
                process=subprocess.Popen([sys.executable,'-c',script,str(root)],stdout=output,stderr=output,start_new_session=True)
            children=[]
            try:
                # The real two-game CPU rollout can exceed 30 seconds on the
                # remote instance. The shutdown assertion still has 10 seconds.
                deadline=time.monotonic()+90
                while not ready.exists() and process.poll() is None and time.monotonic()<deadline:time.sleep(.05)
                self.assertTrue(ready.exists(),log.read_text())
                children=json.loads(ready.read_text());self.assertGreaterEqual(len(children),3)
                os.kill(process.pid,signal.SIGTERM)
                process.wait(timeout=10)
                self.assertTrue(all(not Path('/proc',str(pid)).exists() for pid in children),log.read_text())
            finally:
                if process.poll() is None:
                    # A setup timeout must also let the trainer reap workers
                    # which own separate process groups.
                    descendants=Path('/proc',str(process.pid),'task',str(process.pid),'children')
                    if descendants.exists():children=list(set(children)|{int(pid) for pid in descendants.read_text().split()})
                    os.killpg(process.pid,signal.SIGTERM)
                    try:process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid,signal.SIGKILL);process.wait()
                for pid in children:
                    if Path('/proc',str(pid)).exists():
                        try:os.killpg(pid,signal.SIGKILL)
                        except ProcessLookupError:pass

    def test_process_reused_and_closed_with_descendants(self):
        process=Mock(pid=123,poll=Mock(return_value=None))
        with patch('subprocess.Popen',return_value=process) as spawn,patch('os.killpg') as kill:
            pool=ResidentProcesses()
            pool.submit(0,2,Path('/tmp/a/job.json'),0,2)
            pool.submit(0,2,Path('/tmp/b/job.json'),0,2)
            self.assertEqual(spawn.call_count,1)
            self.assertEqual(process.stdin.write.call_count,2)
            with self.assertRaises(ValueError):pool.submit(0,3,Path('/tmp/c/job.json'),0,2)
            pool.close();pool.close()
            kill.assert_called_once()
            with self.assertRaises(RuntimeError):pool.submit(0,2,Path('/tmp/d/job.json'),0,2)

    def test_interrupted_collection_kills_resident_group_and_removes_snapshot(self):
        import signal
        from tavern_rl.process_rollout import ProcessSimulationPool
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'latest.pt';source.write_bytes(b'checkpoint')
            process=Mock(pid=12345,poll=Mock(return_value=None))
            with patch('tavern_rl.process_rollout.Simulator',return_value=Mock(meta={})), \
                 patch('subprocess.Popen',return_value=process), \
                 patch('time.sleep',side_effect=KeyboardInterrupt),patch('os.killpg') as kill:
                pool=ProcessSimulationPool(2,1,source,persistent=True)
                with self.assertRaises(KeyboardInterrupt):pool.collect(None,[],[1,2],{},'cpu')
                pool.close()
                kill.assert_called_once_with(12345,signal.SIGTERM)
            self.assertEqual(list(Path(directory).iterdir()),[source])

    def test_resident_state_and_opponents_survive_policy_reload(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root)
            pool=Mock(simulators=[Mock()],meta={})
            for field in ('planning_examples','card_evaluations','stage_evaluations','branch_labels',
                          'branch_reports','card_value_labels','card_value_reports'):
                setattr(pool,field,[])
            state=dict(done=False,active={0:{'snapshot':'game'}},seeds=[42],cursor=1)
            def collect(*args,**kwargs):
                pool.streaming_state=state
                return ['trajectory'],[],dict(environment_actions=1)
            pool.collect.side_effect=collect
            model=Mock()
            saved=dict(league=[dict(generation=1)],model_spec={})
            with patch('tavern_rl.persistent_rollout.SimulationPool',return_value=pool), \
                 patch('tavern_rl.train.load_checkpoint',return_value=(saved,model)) as load, \
                 patch('tavern_rl.train.frozen_models',return_value=[Mock()]) as frozen:
                sampler=ResidentSampler(1)
                def run(index,reset,seeds=[42]):
                    directory=root/str(index);directory.mkdir()
                    job=directory/'job.json'
                    job.write_text(json.dumps(dict(checkpoint='latest.pt',seeds=seeds,options={},device='cpu',
                                                   kwargs=dict(streaming={'turns':2}),reset_stream=reset)))
                    sampler.run(dict(job=str(job),index=0,start=0,end=1))
                    return torch.load(directory/'0.pt',weights_only=False)
                first=run(0,True);second=run(1,False)
                self.assertEqual(frozen.call_count,1)
                self.assertEqual(load.call_count,2)
                self.assertIs(load.call_args.kwargs['model'],model)
                self.assertTrue(load.call_args.kwargs['mmap'])
                self.assertIs(pool.collect.call_args.kwargs['resume_state'],state)
                self.assertEqual(second['streaming_state'],dict(done=False,active_count=1))
                self.assertEqual(first['tracks'],second['tracks'])
                with self.assertRaisesRegex(ValueError,'identity changed'):run(2,False,[43])
                run(3,True,[43]);self.assertEqual(frozen.call_count,2)
                sampler.close()


if __name__=='__main__':unittest.main()
