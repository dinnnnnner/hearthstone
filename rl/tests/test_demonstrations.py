import copy
import gzip
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from tavern_rl.demonstrations import load_dataset, split_games


class DemonstrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        schema = json.dumps({'actions':[{},{}], 'entity_schema':{'count':1,'ids':['hero'],'sizes':[1],'offsets':[0]}})
        self.contract=hashlib.sha256(schema.encode()).hexdigest()
        (self.root/'schema.json').write_text(json.dumps({'format':1,'schema':schema,'contract':self.contract}))
        self.rows=[{'type':'start','format':1,'episode':'episode','gameId':'game','completeStart':True,'contract':self.contract,'source':'human'},
                   {'type':'decision','episode':'episode','step':0,'turn':1,'previous':2,'legal':[0,1],'action':1,'entities':[{'id':1,'zone':0,'position':0,'details':{'turn':1,'gold':3}}]},
                   {'type':'end','episode':'episode','steps':1,'place':4,'complete':True,'reasons':[]}]
    def write(self,rows):
        with gzip.open(self.root/'episode.jsonl.gz','wt') as f:
            for row in rows:f.write(json.dumps(row)+'\n')
    def test_complete_human_accepted(self):
        self.write(self.rows)
        _, episodes, rejected=load_dataset(self.root)
        self.assertEqual(len(episodes),1);self.assertEqual(rejected,[])
    def test_invalid_or_incomplete_episodes_rejected(self):
        for mutate in [lambda r:r.pop(), lambda r:r[1].update(action=3), lambda r:r[1].update(previous=0),
                       lambda r:r[1].update(step=1), lambda r:r[0].update(contract='wrong'),
                       lambda r:r[0].update(completeStart=False),lambda r:r[2].update(complete=False),
                       lambda r:r[2].update(steps=2),lambda r:r[1].update(entities=[]),
                       lambda r:r[1].update(legal=[1,1]),lambda r:r[1]['entities'][0].update(position=2),
                       lambda r:r[2].update(episode='other')]:
            rows=copy.deepcopy(self.rows);mutate(rows);self.write(rows)
            _, episodes, rejected=load_dataset(self.root)
            self.assertEqual(episodes,[]);self.assertEqual(len(rejected),1)
    def test_synthetic_requires_explicit_flag(self):
        self.rows[0]['source']='synthetic';self.write(self.rows)
        self.assertEqual(load_dataset(self.root)[1],[])
        self.assertEqual(len(load_dataset(self.root,True)[1]),1)
    def test_whole_game_split_keeps_seats_together(self):
        episodes=[{'start':{'gameId':g}} for g in ['a','a','b','c','c']]
        training,validation=split_games(episodes)
        train={e['start']['gameId'] for e in training};valid={e['start']['gameId'] for e in validation}
        self.assertTrue(train);self.assertTrue(valid);self.assertFalse(train & valid)
        with self.assertRaises(ValueError):split_games(episodes[:2])
    def test_truncated_gzip_is_rejected(self):
        self.write(self.rows)
        p=self.root/'episode.jsonl.gz';p.write_bytes(p.read_bytes()[:-8])
        self.assertEqual(load_dataset(self.root)[1],[])

if __name__=='__main__':unittest.main()
