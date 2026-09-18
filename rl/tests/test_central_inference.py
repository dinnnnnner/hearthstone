from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch

from tavern_rl.inference_features import HostEntityBatch,merge_batches
from tavern_rl.inference_client import SharedInference,RemotePolicy
from tavern_rl.inference_transport import InferenceClient
from tavern_rl.entity_model import EntityActorCritic
from tavern_rl.features import prepare_entities
from tavern_rl.rollout import policy_sample
from tavern_rl.train import atomic_checkpoint,cpu_weights
from test_recurrent import fixture


class FeatureBatchTests(unittest.TestCase):
    def test_merged_encoding_preserves_static_definitions_padding_and_numeric_fields(self):
        torch.set_num_threads(1);torch.manual_seed(7)
        schema,actions,rows=fixture()
        model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1).eval()
        entities=[None]*schema['count'];entities[0]=dict(id=1,details=dict(gold=-0.,other='different',nested=[1,2]))
        observations=[rows,None,prepare_entities(entities),rows]
        chunks=[HostEntityBatch.prepare(observations[:1],schema,{}),HostEntityBatch.prepare(observations[1:3],schema,{}),HostEntityBatch.prepare(observations[3:],schema,{})]
        merged=merge_batches(chunks)
        self.assertEqual(merged.data['batch'],4)
        self.assertEqual(len(set(merged.data['static_ids'])),len(merged.data['static_ids']))
        with torch.inference_mode():
            torch.testing.assert_close(model.encode(observations,'cpu'),model.encode(merged,'cpu'),rtol=1e-6,atol=1e-6)


class ServiceTests(unittest.TestCase):
    def setUp(self):torch.set_num_threads(1);torch.manual_seed(93)

    def test_shared_sampling_batches_requests_and_rejects_stale_weights(self):
        from tavern_rl.bridge import Simulator
        simulator=Simulator()
        try:meta=simulator.meta;state=simulator.reset(83920)
        finally:simulator.close()
        model=EntityActorCritic(meta['entitySchema'],meta['actions'],hidden=16,heads=2,layers=1).eval()
        from tavern_rl.card_value import enable,predictions
        enable(model)
        with torch.no_grad():model.card_value_head[-1].weight.fill_(.03)
        model.eval()
        row=prepare_entities(state['entities']);mask=torch.zeros(1,meta['actionCount'],dtype=torch.bool);mask[0,state['legalActions']]=True
        memory=torch.zeros(1,16);previous=torch.tensor([meta['actionCount']]);draws=[.734]
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model.pt'
            def save(iteration):atomic_checkpoint(path,dict(meta=meta,model_spec=model.specification(),model=cpu_weights(model),league=[],iteration=iteration))
            save(7);server=SharedInference(max_batch=8,delay_ms=20,clients=3);clients=[]
            try:
                descriptor=server.load(path,True,'cpu')
                clients=[InferenceClient(server.address) for _ in range(2)]
                policies=[RemotePolicy(c,descriptor,meta,descriptor['specifications']['-1'],-1) for c in clients]
                with torch.inference_mode():expected=policy_sample(model,[row],mask,memory,previous,draws,priors=True)
                import threading
                barrier=threading.Barrier(2)
                def run(policy):
                    barrier.wait()
                    return policy.sample([row],mask,memory,previous,draws,priors=True)
                with ThreadPoolExecutor(2) as executor:actual=list(executor.map(run,policies))
                for result in actual:
                    for a,b in zip(expected,result):np.testing.assert_allclose(a,b,atol=2e-6,rtol=1e-6)
                with torch.inference_mode():
                    encoded=model.encode([row],'cpu');updated=model.recurrent_step(encoded,memory,previous)
                    expected_cards=predictions(model,encoded,updated).numpy()
                actual_cards=policies[0].card_predictions([row],memory.numpy(),previous.numpy())
                np.testing.assert_allclose(actual_cards,expected_cards,atol=1e-6,rtol=1e-6)
                metrics=server.metrics();self.assertEqual(metrics['requests'],2)
                self.assertEqual(metrics['executions'],1);self.assertEqual(metrics['max_actual_batch'],2)
                with torch.no_grad():model.critic.bias.add_(1.)
                save(8);new=server.load(path,False,'cpu')
                policies[0].descriptor=new
                changed=policies[0].sample([row],mask,memory,previous,draws)
                np.testing.assert_allclose(changed[2],expected[2]+1,atol=1e-6)
                with self.assertRaisesRegex(RuntimeError,'Stale inference policy version'):
                    policies[1].sample([row],mask,memory,previous,draws)
            finally:
                for client in clients:client.close()
                server.close()

    def test_stopping_trainer_also_reaps_shared_inference_owner(self):
        from test_persistent_rollout import ResidentTests
        ResidentTests.check_trainer_stop_between_collections(self,central=True)

    def test_pool_fails_promptly_when_inference_owner_dies(self):
        from unittest.mock import patch
        from tavern_rl.bridge import Simulator
        from tavern_rl.process_rollout import ProcessSimulationPool
        simulator=Simulator();meta=simulator.meta;simulator.close()
        model=EntityActorCritic(meta['entitySchema'],meta['actions'],hidden=16,heads=2,layers=1)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model.pt'
            atomic_checkpoint(path,dict(meta=meta,model_spec=model.specification(),model=cpu_weights(model),league=[],iteration=1))
            pool=ProcessSimulationPool(2,2,path,persistent=True,inference=dict(max_batch=8,delay_ms=1.))
            original=pool.resident.submit
            def submit(*args,**kwargs):
                process=original(*args,**kwargs)
                if args[0]==0:pool.inference.process.kill();pool.inference.process.wait()
                return process
            try:
                with patch.object(pool.resident,'submit',side_effect=submit):
                    with self.assertRaisesRegex(RuntimeError,'Inference service exited'):
                        pool.collect(model,[],[1,2],dict(maxActionsPerTurn=3,maxSteps=10000),'cpu')
                self.assertIsNone(pool.inference)
                self.assertFalse(pool.resident.workers)
                self.assertFalse(list(Path(directory).glob('.rollout-*')))
            finally:pool.close()

    def test_real_streaming_pool_matches_resident_pipeline_across_updates(self):
        from tavern_rl.bridge import Simulator
        from tavern_rl.streaming import enable_auxiliary
        from tavern_rl.process_rollout import ProcessSimulationPool
        simulator=Simulator();meta=simulator.meta;simulator.close()
        model=EntityActorCritic(meta['entitySchema'],meta['actions'],hidden=16,heads=2,layers=1)
        enable_auxiliary(model)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model.pt'
            pools=[ProcessSimulationPool(2,2,path,persistent=True,inference=settings) for settings in (None,dict(max_batch=8,delay_ms=2.))]
            try:
                for step in range(2):
                    with torch.no_grad():model.critic.bias.add_(.1)
                    atomic_checkpoint(path,dict(meta=meta,model_spec=model.specification(),model=cpu_weights(model),league=[],iteration=step))
                    results=[p.collect(model,[],[32150,32151],dict(maxActionsPerTurn=3,maxSteps=10000,recordFrames=False),'cpu',
                        learner_seats=8,streaming=dict(turns=2,auxiliary_coef=.1)) for p in pools]
                    self.assertEqual(results[0][1],results[1][1])
                    a,b=results[0][0],results[1][0];self.assertEqual(len(a),len(b))
                    for (left,lr),(right,rr) in zip(a,b):
                        self.assertEqual([r[2] for r in left],[r[2] for r in right])
                        np.testing.assert_allclose([r[3:5] for r in left],[r[3:5] for r in right],atol=3e-6,rtol=1e-6)
                        self.assertAlmostEqual(lr['bootstrap'],rr['bootstrap'],places=5)
                    self.assertEqual(results[1][2]['sampler_policy_iteration'],step)
                    self.assertGreater(results[1][2]['central_inference']['rows'],0)
                    self.assertEqual(results[1][2]['central_inference']['pid'],pools[1].inference.process.pid)
            finally:
                for p in pools:p.close()


if __name__=='__main__':unittest.main()
