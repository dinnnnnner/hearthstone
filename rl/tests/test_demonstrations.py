import copy
import gzip
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from tavern_rl.demonstrations import continuous_prefix, continuous_segments, load_dataset, split_games


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

    def prefix_steps(self):
        steps=[]
        for i,(turn,counter,action) in enumerate([(1,0,0),(1,1,1),(2,0,0),(2,1,0)]):
            row=copy.deepcopy(self.rows[1])
            row.update(step=i,turn=turn,action=action,previous=2 if i==0 else steps[-1]['action'])
            row['entities'][0]['details'].update(turn=turn,decisions=counter)
            steps.append(row)
        return steps

    def test_prefix_stops_at_missing_action_with_consecutive_recorded_steps(self):
        steps=self.prefix_steps()
        steps[3]['entities'][0]['details']['decisions']=2
        self.assertEqual(continuous_prefix(steps,[{'type':'buy'},{'type':'end'}]),steps[:3])

    def test_prefix_accepts_manual_turn_transition_but_stops_at_automatic_end(self):
        steps=self.prefix_steps();actions=[{'type':'buy'},{'type':'end'}]
        self.assertEqual(continuous_prefix(steps,actions),steps)
        steps[1]['action']=0;steps[2]['previous']=0
        self.assertEqual(continuous_prefix(steps,actions),steps[:2])

    def test_prefix_rejects_missing_beginning_and_malformed_details(self):
        for details in [None,{'turn':1,'decisions':1}, {'turn':1}]:
            steps=self.prefix_steps();steps[0]['entities'][0]['details']=details
            self.assertEqual(continuous_prefix(steps,[{'type':'buy'},{'type':'end'}]),[])

    def test_segments_keep_later_labels_and_reset_unknown_previous_without_mutation(self):
        steps=self.prefix_steps();steps[3]['entities'][0]['details']['decisions']=2
        original=copy.deepcopy(steps)
        segments=continuous_segments(steps,[{'type':'buy'},{'type':'end'}])
        self.assertEqual([len(s) for s in segments],[3,1])
        self.assertEqual(segments[1][0]['previous'],2)
        self.assertEqual([r['action'] for s in segments for r in s],[r['action'] for r in steps])
        self.assertEqual(steps,original)

    def test_segments_reset_after_automatic_end_and_reject_unknown_counters(self):
        steps=self.prefix_steps();steps[1]['action']=0;steps[2]['previous']=0
        self.assertEqual([len(s) for s in continuous_segments(steps,[{'type':'buy'},{'type':'end'}])],[2,2])
        del steps[3]['entities'][0]['details']['decisions']
        with self.assertRaises(ValueError):continuous_segments(steps,[{'type':'buy'},{'type':'end'}])

    def test_partial_loading_requires_flag_and_preserves_original_result(self):
        manifest=json.loads((self.root/'schema.json').read_text())
        schema=json.loads(manifest['schema']);schema['actions']=[{'type':'buy'},{'type':'end'}]
        manifest['schema']=json.dumps(schema)
        manifest['contract']=hashlib.sha256(manifest['schema'].encode()).hexdigest()
        (self.root/'schema.json').write_text(json.dumps(manifest))
        start=copy.deepcopy(self.rows[0]);start['contract']=manifest['contract']
        steps=self.prefix_steps();steps[3]['entities'][0]['details']['decisions']=2
        end=dict(self.rows[-1],complete=False,reasons=['capture_gap','automatic_end'],steps=4)
        self.write([start,*steps,end])
        self.assertEqual(load_dataset(self.root)[1],[])
        _,episodes,rejected=load_dataset(self.root,allow_incomplete_prefix=True)
        self.assertEqual(rejected,[]);self.assertEqual(len(episodes),1)
        self.assertEqual(episodes[0]['steps'],steps[:3])
        self.assertEqual(episodes[0]['end'],end)
        self.assertEqual(episodes[0]['selection']['recordedSteps'],4)
        self.assertEqual(episodes[0]['selection']['retainedSteps'],3)
        _,episodes,rejected=load_dataset(self.root,allow_incomplete_segments=True)
        self.assertEqual(rejected,[])
        self.assertEqual(episodes[0]['steps'],steps)
        self.assertEqual(episodes[0]['end'],end)
        self.assertEqual([len(s) for s in episodes[0]['segments']],[3,1])
        self.assertEqual(episodes[0]['selection']['retainedSteps'],4)
        # A gap is allowed; an illegal label after that gap is still rejected.
        broken=copy.deepcopy(steps);broken[-1]['legal']=[1]
        self.write([start,*broken,end])
        self.assertEqual(load_dataset(self.root,allow_incomplete_segments=True)[1],[])
        with self.assertRaises(ValueError):load_dataset(self.root,allow_incomplete_prefix=True,allow_incomplete_segments=True)
        end['reasons']=['restart'];self.write([start,*steps,end])
        self.assertEqual(load_dataset(self.root,allow_incomplete_prefix=True)[1],[])
        self.assertEqual(load_dataset(self.root,allow_incomplete_segments=True)[1],[])

if __name__=='__main__':unittest.main()
