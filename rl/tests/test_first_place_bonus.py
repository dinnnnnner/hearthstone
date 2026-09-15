from concurrent.futures import ThreadPoolExecutor
import unittest
import torch
from tavern_rl.rollout import SimulationPool
from tavern_rl.placement_rewards import reward_with_first_place_bonus, resolve_bonus, validate_bonus


class FirstPlaceBonusTests(unittest.TestCase):
    def test_preserves_legacy_resume_and_increases_incentive_to_win(self):
        self.assertEqual(resolve_bonus({},None),0)
        self.assertEqual(resolve_bonus({'first_place_bonus':1},None),1)
        self.assertEqual(resolve_bonus({'first_place_bonus':1},0),0)
        rewards=[reward_with_first_place_bonus((4.5-p)/3.5,p,1) for p in range(1,9)]
        self.assertAlmostEqual(rewards[0],2.)
        self.assertAlmostEqual(rewards[1],5/7)
        self.assertAlmostEqual(rewards[0]-rewards[1],9/7)
        for p in range(2,9):self.assertEqual(rewards[p-1],(4.5-p)/3.5)
        for invalid in (-1,float('nan'),float('inf')):
            with self.assertRaises(ValueError):validate_bonus(invalid)

    def test_collector_adds_bonus_once_without_changing_game_or_evaluation_results(self):
        class Simulator:
            def reset(self,seed,options):self.tick=0;return self.state()
            def state(self):
                done=self.tick==16
                return dict(actor=None if done else self.tick%8,observation=[0],
                    entities=[{'details':{'gold':3 if self.tick<8 else 10}}],legalActions=[0],
                    terminated=done,truncated=False,info=dict(placements=list(range(1,9)),rewards=[(4.5-p)/3.5 for p in range(1,9)]))
            def step(self,action):self.tick+=1;return self.state()
        class Model(torch.nn.Module):
            observation_kind='flat';recurrent=False
            def distribution(self,obs,masks):
                return torch.distributions.Categorical(logits=torch.zeros_like(masks,dtype=torch.float32)),torch.zeros(len(obs))
        pool=SimulationPool.__new__(SimulationPool)
        pool.simulators=[Simulator()];pool.executor=ThreadPoolExecutor(max_workers=1)
        pool.meta=dict(actionCount=1,actions=[{'type':'end'}])
        try:
            tracks,games,stats=pool.collect(Model(),[],[1],{},'cpu',learner_seats=8,first_place_bonus=1.)
            self.assertEqual(len(tracks[0][0]), 2)
            self.assertEqual(tracks[0][1], 2.)
            self.assertAlmostEqual(tracks[1][1], 5/7)
            self.assertEqual(games[0]['rewards'][0],1.)
            self.assertEqual(stats['first_place_bonus'],1.)
            evaluation,results,_=pool.collect(Model(),[],[1],{},'cpu',collect=False,first_place_bonus=1.)
            self.assertFalse(evaluation)
            self.assertEqual(results[0]['rewards'][0],1.)
        finally:pool.executor.shutdown()


if __name__=='__main__':unittest.main()
