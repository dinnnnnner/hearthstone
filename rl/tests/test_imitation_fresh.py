import copy
import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import torch
from tavern_rl.imitate_fresh import fresh_trial,forward_step,fingerprint
from tavern_rl.features import prepare_entities
from tavern_rl.model import make_model
from test_recurrent import fixture


class FreshImitationTests(unittest.TestCase):
    def data(self):
        schema,actions,_=fixture()
        entities=[None]*schema['count'];entities[0]=dict(id=1,details=dict(gold=6))
        episodes=[]
        for game in range(4):
            segments=[[dict(step=i+j*2,action=1,legal=[0,1],previous=9 if i==0 else 1,entities=entities)
                       for i in range(2)] for j in range(2)]
            episodes.append(dict(start=dict(gameId=str(game)),file=str(game),sha256=str(game),selection={},
                                 segments=segments,steps=[r for segment in segments for r in segment]))
        return dict(schema=json.dumps(dict(entity_schema=schema,actions=actions)),contract='test'),episodes,[]

    def test_fresh_weights_holdout_and_frozen_value_parameters(self):
        self.check_fresh_training('cpu')

    @unittest.skipUnless(torch.cuda.is_available(),'CUDA required')
    def test_cuda_fresh_training_and_checkpoint(self):
        self.check_fresh_training('cuda')

    def check_fresh_training(self,device):
        torch.set_num_threads(1)
        data=self.data()
        deadline=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=3)).isoformat()
        with tempfile.TemporaryDirectory() as temp,patch('tavern_rl.imitate_fresh.load_dataset',return_value=data):
            root=Path(temp)/'run'
            result=fresh_trial('unused',root,deadline,depth=4,hidden=16,heads=2,layers=1,
                               batch_size=2,sequence_length=2,max_epochs=2,learning_rate=.003,device=device)
            self.assertEqual(result['initialization'],'random')
            self.assertEqual(result['selfPlayEpisodes'],0)
            self.assertEqual(result['updates'],6)
            self.assertEqual(result['supervisedStepVisits'],24)
            train={r['gameId'] for r in result['datasets'] if r['split']=='training'}
            valid={r['gameId'] for r in result['datasets'] if r['split']=='validation'}
            self.assertFalse(train&valid);self.assertEqual(len(train),3);self.assertEqual(len(valid),1)
            self.assertEqual(result['validation']['all']['samples'],4)
            initial=torch.load(root/'initial.pt',weights_only=False)
            latest=torch.load(root/'latest.pt',weights_only=False)
            self.assertEqual(fingerprint(initial['model']),result['initialWeightSha256'])
            self.assertNotEqual(fingerprint(initial['model']),fingerprint(latest['model']))
            self.assertNotIn('optimizer',latest);self.assertNotIn('league',latest)
            for name,weight in initial['model'].items():
                if name.startswith(('critic.','value_tower.')):
                    torch.testing.assert_close(weight,latest['model'][name],rtol=0,atol=0)
            best=torch.load(root/'best.pt',weights_only=False)
            self.assertEqual(best['report']['bestEpoch'],result['bestEpoch'])
            self.assertLessEqual(result['bestValidationNll'],result['before']['all']['negative_log_likelihood'])

    def test_batch_padding_keeps_memory_and_excludes_padded_loss(self):
        manifest,episodes,_=self.data();schema=json.loads(manifest['schema'])
        model=make_model(dict(schema,architecture='entity-gru',hidden=16,heads=2,layers=1));model.eval()
        segments=copy.deepcopy([episodes[0]['segments'][0],episodes[1]['segments'][0][:1]])
        for segment in segments:
            for row in segment:row['prepared']=prepare_entities(row['entities'])
        memory=torch.zeros(2,16)
        _,memory,_,_,_=forward_step(model,segments,0,memory,'cpu');before=memory.clone()
        losses,updated,_,_,active=forward_step(model,segments,1,memory,'cpu')
        self.assertEqual(active,[True,False]);self.assertEqual(len(losses),1)
        torch.testing.assert_close(updated[1],before[1],rtol=0,atol=0)
        one_loss,one_memory,_,_,_=forward_step(model,[segments[0]],1,before[:1],'cpu')
        torch.testing.assert_close(losses,one_loss);torch.testing.assert_close(updated[:1],one_memory)

    def test_expired_deadline_and_duplicate_games_do_not_create_run(self):
        with tempfile.TemporaryDirectory() as temp:
            output=Path(temp)/'run'
            with self.assertRaises(ValueError):fresh_trial('missing',output,'2000-01-01T00:00:00+00:00')
            self.assertFalse(output.exists())
            manifest,episodes,rejected=self.data();episodes[1]['start']['gameId']=episodes[0]['start']['gameId']
            deadline=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=3)).isoformat()
            with patch('tavern_rl.imitate_fresh.load_dataset',return_value=(manifest,episodes,rejected)):
                with self.assertRaisesRegex(ValueError,'Duplicate'):fresh_trial('unused',output,deadline)
            self.assertFalse(output.exists())


if __name__=='__main__':unittest.main()
