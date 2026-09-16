import copy
import unittest
from tavern_rl.card_evaluation import comparison,retain,finalize


class CardEvaluationTests(unittest.TestCase):
    def fixture(self):
        meta=dict(entitySchema=dict(ids=['hero','economy','fighter','core'],offsets=[0,1,2,4,5]),
                  actions=[dict(type='end',source=0),dict(type='refresh',source=0),dict(type='buy',source=0),dict(type='buy',source=1)])
        def e(id,zone,position,**details):return dict(id=id,zone=zone,position=position,details=details)
        entities=[e(1,0,0,turn=7,tier=4,gold=6,health=23,upgrade=7,decisions=3),e(2,1,0,attack=2,health=3),
                  e(3,2,0,attack=6,health=6),e(4,2,1,attack=1,health=4),None,e(2,4,0,attack=2,health=3)]
        row=dict(entities=entities,legal=[0,1,2,3])
        label=dict(actions=[0,1,2,3],values=[0.,.5,.3,.8],sample_counts=[1,12,1,1],target=[.05,.2,.1,.65],best=3)
        return meta,row,label

    def test_each_card_is_compared_to_not_buying_and_other_gold_uses(self):
        meta,row,label=self.fixture();before=copy.deepcopy(row)
        report=comparison(meta,row,label,42,2)
        self.assertEqual(report['context']['turn'],7);self.assertEqual(report['context']['gold'],6)
        self.assertEqual(report['board'][0]['id'],'economy');self.assertEqual(report['hand'][0]['id'],'economy')
        fighter,core=report['purchases']
        self.assertEqual(fighter['card']['id'],'fighter');self.assertAlmostEqual(fighter['gain_vs_end'],.3)
        self.assertAlmostEqual(fighter['gain_vs_best_nonpurchase'],-.2)
        self.assertEqual(core['card']['id'],'core');self.assertTrue(core['selected'])
        self.assertAlmostEqual(core['gain_vs_best_nonpurchase'],.3);self.assertEqual(row,before)

    def test_incomplete_routes_have_no_fabricated_card_score(self):
        meta,row,label=self.fixture()
        for key in ('actions','values','sample_counts','target'):label[key]=label[key][:-1]
        label['best']=1
        report=comparison(meta,row,label,42,0)
        self.assertFalse(report['purchases'][1]['scored']);self.assertNotIn('value',report['purchases'][1])

    def test_examples_are_bounded_and_final_result_is_for_the_correct_game_and_seat(self):
        meta,row,label=self.fixture();examples=[]
        for i in range(30):
            row['entities'][0]['details']['decisions']=i
            retain(examples,comparison(meta,row,label,42 if i%2 else 43,i%8),limit=8)
        self.assertEqual(len(examples),8)
        finalize(examples,42,list(range(1,9)),[1,.7,.4,.1,-.1,-.4,-.7,-1],1)
        for item in examples:
            if item['seed']==42:
                self.assertEqual(item['final_placement'],item['seat']+1)
                self.assertIn('actual_return',item)
            else:self.assertNotIn('actual_return',item)


if __name__=='__main__':unittest.main()
