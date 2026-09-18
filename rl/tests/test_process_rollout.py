import unittest
from pathlib import Path
import signal
import tempfile
from unittest.mock import Mock,patch
from tavern_rl.process_rollout import shards,ProcessSimulationPool,prepare_descriptor_limit,rollout_storage


class ProcessRolloutTests(unittest.TestCase):
    def test_ram_scratch_pins_old_checkpoint_and_cleans_up_after_failure(self):
        with tempfile.TemporaryDirectory() as disk, tempfile.TemporaryDirectory() as ram:
            source=Path(disk)/'latest.pt';source.write_bytes(b'old weights')
            with patch.dict('os.environ',{'TAVERN_ROLLOUT_SCRATCH':ram}):
                with self.assertRaisesRegex(RuntimeError,'interrupted'):
                    with rollout_storage(source) as (directory,snapshot):
                        self.assertEqual(directory.parent,Path(ram))
                        self.assertEqual(snapshot.parent.parent,Path(disk))
                        replacement=Path(disk)/'next.pt';replacement.write_bytes(b'new weights')
                        replacement.replace(source)
                        self.assertEqual(snapshot.read_bytes(),b'old weights')
                        (directory/'0.pt').write_bytes(b'trajectories')
                        raise RuntimeError('interrupted')
            self.assertEqual(list(Path(ram).iterdir()),[])
            self.assertEqual(list(Path(disk).iterdir()),[source])
            self.assertEqual(source.read_bytes(),b'new weights')

    def test_completion_order_does_not_reorder_ppo_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'latest.pt';source.write_bytes(b'immutable')
            simulator=Mock(meta={})
            processes=[Mock(pid=100, poll=Mock(side_effect=[None,0,0])),Mock(pid=101,poll=Mock(return_value=0))]
            def start(*args,**kwargs):
                temporary=next(Path(directory).glob('.rollout-*'))
                for index in [0,1]:(temporary/f'{index}.pt').touch()
                return processes.pop(0)
            def result(path,**kwargs):
                index=int(path.stem)
                return dict(tracks=[f'track-{index}'],games=[dict(seed=index)],planning_examples=[dict(priority=str(1-index))],performance=dict(
                    environment_actions=1,inference_batches=1,mean_inference_batch=1,
                    inference_seconds=0.,simulator_wait_seconds=0.))
            with patch('tavern_rl.process_rollout.Simulator',return_value=simulator), \
                 patch('subprocess.Popen',side_effect=start),patch('torch.load',side_effect=result),patch('time.sleep'):
                pool=ProcessSimulationPool(2,2,source)
                tracks,games,_=pool.collect(None,[],[0,1],{},'cpu',planning_states=1)
                self.assertEqual(pool.planning_examples,[dict(priority='0')])
                pool.close()
            self.assertEqual(tracks,['track-0','track-1'])
            self.assertEqual([g['seed'] for g in games],[0,1])

    def test_shards_preserve_global_seat_offsets_and_cover_each_seed_once(self):
        seeds=list(range(17))
        parts=shards(seeds,10,3)
        self.assertEqual(sum(workers for _,_,workers in parts),10)
        self.assertEqual([seed for a,b,_ in parts for seed in seeds[a:b]],seeds)
        base_offset=2268
        self.assertEqual([(base_offset+a+i)%8 for a,b,_ in parts for i in range(b-a)],
                         [(base_offset+i)%8 for i in range(len(seeds))])

    def test_fewer_games_than_processes_never_launches_an_empty_shard(self):
        self.assertEqual(shards([1,2],8,8),[(0,1,4),(1,2,4)])
        for workers,processes in [(0,1),(2,3),(4,0)]:
            with self.assertRaises(ValueError):shards([1],workers,processes)

    def test_interruption_stops_process_groups_and_removes_temporary_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'latest.pt';source.write_bytes(b'immutable')
            simulator=Mock(meta={});process=Mock(pid=123456,poll=Mock(return_value=None),wait=Mock(return_value=0))
            previous=signal.getsignal(signal.SIGTERM)
            with patch('tavern_rl.process_rollout.Simulator',return_value=simulator), \
                 patch('subprocess.Popen',return_value=process),patch('time.sleep',side_effect=KeyboardInterrupt), \
                 patch('os.killpg') as kill:
                pool=ProcessSimulationPool(2,1,source)
                with self.assertRaises(KeyboardInterrupt):pool.collect(None,[],[1,2],{},'cuda')
                pool.close()
            kill.assert_called_once_with(123456,signal.SIGTERM)
            self.assertEqual(signal.getsignal(signal.SIGTERM),previous)
            self.assertEqual(list(Path(directory).iterdir()),[source])
            self.assertEqual(source.read_bytes(),b'immutable')

    def test_descriptor_limit_is_bounded_by_the_existing_hard_limit(self):
        with patch('resource.getrlimit',return_value=(1024,4096)),patch('resource.setrlimit') as change:
            prepare_descriptor_limit(256)
            self.assertEqual(change.call_args.args[1],(2304,4096))
            with self.assertRaises(ValueError):prepare_descriptor_limit(1024)


if __name__=='__main__':unittest.main()
