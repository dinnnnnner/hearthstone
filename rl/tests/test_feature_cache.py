import math
import random
import struct
import unittest
from unittest.mock import patch
import torch
from tavern_rl import features


def original_numeric(value,kind):
    return [math.copysign(math.log1p(abs(value)),value)/10,math.tanh(value/10),float(kind==2),float(kind==1)]


class FeatureCacheTests(unittest.TestCase):
    def test_scalar_encoding_preserves_float_bits_including_signed_zero(self):
        rng=random.Random(81)
        values=[0.,-0.,1.,-1.,1e-310,-1e-310,1e308,-1e308]+[rng.uniform(-100000,100000) for _ in range(1000)]
        for _ in range(2):
            for value in values:
                for kind in [1,2,3,4]:
                    self.assertEqual(struct.pack('4d',*features.numeric(value,kind)),
                                     struct.pack('4d',*original_numeric(value,kind)))

    def test_packed_fields_and_strings_are_identical_to_uncached_encoding(self):
        schema=dict(count=2,definitions={'1':{'attack':3,'name':'测试'},'2':{'health':6}})
        entities=[{'id':1,'details':{'gold':0.,'delta':-0.,'stats':[1,2,3],'flag':True}},
                  {'id':2,'details':{'attack':3,'effect':None}}]
        observations=[features.prepare_entities(entities),None,features.prepare_entities(entities)]
        actual=features.pack_entities(observations,schema,'cpu')
        with patch.object(features,'numeric',original_numeric):
            expected=features.pack_entities(observations,schema,'cpu')
        for key,value in actual.items():
            if isinstance(value,torch.Tensor):
                self.assertEqual(value.numpy().tobytes(),expected[key].numpy().tobytes())
            else:self.assertEqual(value,expected[key])


if __name__=='__main__':unittest.main()
