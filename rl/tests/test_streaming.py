import unittest
from types import SimpleNamespace
from copy import deepcopy
import numpy as np
import torch
from tavern_rl.model import advantages,make_model,ppo_update
from tavern_rl.deep_model import DeepEntityActorCritic
from tavern_rl.entity_model import EntityActorCritic
from tavern_rl.streaming import configure,enable_auxiliary,migrate_optimizer,outcome,flush,tier_tempo_reward,TIER_TEMPO
from tavern_rl.rollout import SimulationPool
from test_recurrent import fixture


class StreamingTests(unittest.TestCase):
    def setUp(self):torch.set_num_threads(1);torch.manual_seed(41)

    def test_bootstrap_is_not_a_terminal_reward(self):
        adv,returns=advantages([.2,.4],[0.,0.],gamma=.9,gae_lambda=1.,bootstrap=.8)
        np.testing.assert_allclose(returns,[.648,.72],atol=1e-7)
        _,terminal=advantages([.2,.4],[0.,-1.],gamma=.9,gae_lambda=1.)
        np.testing.assert_allclose(terminal,[-.9,-1.],atol=1e-7)

    def test_deep_checkpoint_and_adam_migration_preserve_old_parameters_and_order(self):
        schema,actions,_=fixture()
        model=DeepEntityActorCritic(schema,actions,hidden=16,heads=2,layers=1,policy_depth=4,value_depth=4)
        optimizer=torch.optim.Adam(model.parameters(),lr=1e-4)
        loss=sum(p.square().sum() for p in model.parameters());loss.backward();optimizer.step()
        old=deepcopy(model.state_dict());state=deepcopy(optimizer.state_dict());old_names=list(dict(model.named_parameters()))
        enable_auxiliary(model)
        for name,value in old.items():torch.testing.assert_close(model.state_dict()[name],value,rtol=0,atol=0)
        restored=make_model(model.specification());restored.load_state_dict(model.state_dict())
        self.assertEqual(list(dict(model.named_parameters())),list(dict(restored.named_parameters())))
        self.assertEqual(list(dict(model.named_parameters()))[:-2],old_names)
        migrated=migrate_optimizer(state,model)
        new=torch.optim.Adam(model.parameters(),lr=1e-4);new.load_state_dict(migrated)
        for key,value in state['state'].items():torch.testing.assert_close(new.state_dict()['state'][key]['exp_avg'],value['exp_avg'])
        self.assertEqual(len(new.param_groups[0]['params']),len(old_names)+2)

    def test_streaming_defaults_keep_branches_short_and_cli_overrides(self):
        schema,actions,_=fixture();model=EntityActorCritic(schema,actions,hidden=16,heads=2,layers=1)
        config=dict(gamma=1.,gold_planning=dict(direct=True))
        configure(config,SimpleNamespace(streaming=True,branch_trials=2,branch_workers=4),model,None)
        self.assertEqual(config['counterfactual']['trials'],2);self.assertEqual(config['counterfactual']['workers'],4)
        self.assertEqual(config['counterfactual']['terminal_fraction'],0.)
        self.assertNotIn('gold_planning',config)
        self.assertNotIn('tier_tempo',config['streaming'])
        configure(config,SimpleNamespace(tier_tempo=True),model,None)
        self.assertEqual(config['streaming']['tier_tempo'],TIER_TEMPO)
        configure(config,SimpleNamespace(tier_tempo=False),model,None)
        self.assertNotIn('tier_tempo',config['streaming'])

    def test_tier_tempo_requires_surviving_actual_turn_eight_combat(self):
        player=dict(game=dict(tier=4,health=1,battles=[dict(turn=8)]))
        self.assertAlmostEqual(tier_tempo_reward(player,8,TIER_TEMPO),.05)
        for turn in (7,9):self.assertEqual(tier_tempo_reward(player,turn,TIER_TEMPO),0)
        player['game']['tier']=5
        self.assertAlmostEqual(tier_tempo_reward(player,8,TIER_TEMPO),.075)
        player['game']['health']=0
        self.assertEqual(tier_tempo_reward(player,8,TIER_TEMPO),0)
        player['game'].update(health=40,tier=3)
        self.assertEqual(tier_tempo_reward(player,8,TIER_TEMPO),0)
        player['game'].update(tier=5,battles=[])
        self.assertEqual(tier_tempo_reward(player,8,TIER_TEMPO),0)

    def test_tempo_is_paid_once_and_added_to_terminal_reward(self):
        base=dict(turn=9,tier=5,health=40,gold=10,hand=[],board=[],season={},
                  battles=[dict(turn=8,result='win',damage=0)])
        snapshot=dict(room=dict(seats=[dict(game=deepcopy(base),place=i+1) for i in range(8)]))
        for player in snapshot['room']['seats'][1:]:player['game']['health']=0
        game=dict(tier_tempo=TIER_TEMPO,tempo_audit=[],tempo_rewards=[{} for _ in range(8)],
            outcomes=[{} for _ in range(8)],tracks=[['record'] for _ in range(8)],controllers=[-1]*8,
            record_turns=[[8] for _ in range(8)],history=[[] for _ in range(8)])
        outcome(game,snapshot,8);outcome(game,snapshot,8)
        self.assertEqual(len(game['tempo_audit']),8)
        self.assertAlmostEqual(sum(game['tempo_rewards'][0].values()),.075)
        tracks=flush(game,SimpleNamespace(call=lambda *args,**kwargs:None),snapshot,None,'cpu',1.)
        self.assertAlmostEqual(float(tracks[0][1]['rewards'][0]),2.075,places=6)
        self.assertEqual(float(tracks[-1][1]['rewards'][0]),-1.)
        self.assertTrue(all(not events for events in game['tempo_rewards']))

    def test_economy_targets_distinguish_cards_and_discounts_at_equal_gold(self):
        base=dict(gold=7,turn=5,hand=[],board=[],season=dict(freeRefresh=0,spellDiscount=0,nextGold=0),
                  battles=[dict(turn=4,result='tie',damage=0)])
        seats=[dict(game=deepcopy(base)) for _ in range(8)]
        seats[1]['game'].update(hand=[{},{}],board=[{}])
        seats[1]['game']['season'].update(freeRefresh=2,spellDiscount=1,nextGold=3)
        game=dict(outcomes=[{} for _ in range(8)])
        outcome(game,dict(room=dict(seats=seats)),4)
        first=game['outcomes'][0][4]['resources'];second=game['outcomes'][1][4]['resources']
        self.assertEqual(first[0],second[0])
        self.assertTrue(all(a<b for a,b in zip(first[1:],second[1:])))

    def test_chunks_resume_exact_games_and_train_before_any_game_finishes(self):
        pool=SimulationPool(1)
        try:
            model=EntityActorCritic(pool.meta['entitySchema'],pool.meta['actions'],hidden=16,heads=2,layers=1)
            enable_auxiliary(model);options=dict(maxActionsPerTurn=3,maxSteps=10000,recordFrames=False)
            baseline,games,_=pool.collect(model,[],[987621],options,'cpu',learner_seats=8,first_place_bonus=1)
            expected=[[r[2] for r in records] for records,_ in baseline]
            all_tracks=[];all_games=[];first=True
            for _ in range(40):
                tracks,done,performance=pool.collect(model,[],[987621],options,'cpu',learner_seats=8,
                    first_place_bonus=1,streaming=dict(turns=2,auxiliary_coef=.1))
                if first:
                    self.assertEqual(done,[]);self.assertFalse(performance['streaming_done'])
                    self.assertTrue(any(not reward['terminal'] for _,reward in tracks))
                    copy=make_model(model.specification());copy.load_state_dict(model.state_dict())
                    config=dict(streaming=dict(turns=2,auxiliary_coef=.1),gamma=1.,gae_lambda=.95,clip=.2,value_coef=.5,
                        entropy_coef=.01,max_grad_norm=.5,target_kl=.03,epochs=1,sequence_length=16,burn_in=8,sequence_batch_size=8)
                    stats=ppo_update(copy,torch.optim.Adam(copy.parameters(),lr=1e-4),tracks,config,'cpu')
                    self.assertGreater(stats['auxiliary_loss'],0.)
                    self.assertGreater(copy.auxiliary.weight.abs().sum().item(),0.)
                    first=False
                all_tracks.extend(tracks);all_games.extend(done)
                if performance['streaming_done']:break
            else:self.fail('Streaming game never finished')
            self.assertEqual([g['placements'] for g in all_games],[g['placements'] for g in games])
            # Per-seat records retain the same pre-decision observations; assemble
            # by matching the next expected action/observation sequence exactly.
            positions=[0]*len(baseline)
            for records,reward in all_tracks:
                matches=[i for i,(full,_) in enumerate(baseline) if positions[i]<len(full) and
                         str(full[positions[i]][0])==str(records[0][0])]
                self.assertEqual(len(matches),1);seat=matches[0];start=positions[seat]
                self.assertEqual([r[2] for r in records],expected[seat][start:start+len(records)])
                positions[seat]+=len(records)
            self.assertEqual(positions,[len(records) for records,_ in baseline])
            self.assertEqual(sum(reward['terminal'] for _,reward in all_tracks),8)
        finally:pool.close()


if __name__=='__main__':unittest.main()
