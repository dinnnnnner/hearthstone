import gzip
import json
import unittest
from tavern_rl.serve import decode_request, Policy


class ServingTests(unittest.TestCase):
    def test_normal_server_starts_without_optional_search_module(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        from tavern_rl.serve import main
        policy = SimpleNamespace(metadata={}, search=None)
        with patch.dict('sys.modules', {'tavern_rl.recruit_search': None}), \
                patch('sys.argv', ['serve', 'model.pt']), \
                patch('tavern_rl.serve.Policy', return_value=policy), \
                patch('tavern_rl.serve.HTTPServer') as server, patch('builtins.print'):
            main()
        server.return_value.serve_forever.assert_called_once()

    def test_search_must_be_explicitly_supported_and_boolean(self):
        policy = Policy.__new__(Policy)
        policy.metadata = {'contract': 'c', 'checkpointSha256': 'p'}
        policy.search = None
        for value in (True, 'true', 1):
            with self.assertRaisesRegex(ValueError, 'search is unavailable'):
                policy.predict({'contract': 'c', 'search': value})

    def test_compression_preserves_payload_and_enforces_decoded_limit(self):
        data = {'rows': [{'legal': [1, 2], 'text': '公开战况'}]}
        raw = json.dumps(data).encode()
        self.assertEqual(decode_request(raw), data)
        self.assertEqual(decode_request(gzip.compress(raw), 'gzip'), data)
        with self.assertRaises(ValueError):
            decode_request(gzip.compress(b'x' * 2_000_001), 'gzip')
        with self.assertRaises(ValueError):
            decode_request(gzip.compress(raw)[:-4], 'gzip')
        with self.assertRaises(ValueError):
            decode_request(raw, 'unsupported')

    def test_request_cannot_select_another_checkpoint_with_the_same_schema(self):
        policy = Policy.__new__(Policy)
        policy.metadata = {'contract': 'same-schema', 'checkpointSha256': 'frozen-checkpoint'}
        with self.assertRaisesRegex(ValueError, 'checkpoint differs'):
            policy.predict({'contract': 'same-schema', 'checkpointSha256': 'other-checkpoint'})

    def test_probabilities_are_opt_in_normalized_legal_and_keep_search_choice_separate(self):
        import torch
        class Model:
            action_size=4;hidden=2;schema={'count':1}
            action_value_type=True
            def act(self,observations,masks,memory,previous,with_value=False):
                probs=torch.tensor([[.1,.2,.3,.4]])*masks
                return torch.distributions.Categorical(probs=probs),torch.zeros(len(observations)),memory+1
        class Search:
            def predict(self,row,root,budget):return 0,dict(simulations=4)
        p=Policy.__new__(Policy);p.model=Model();p.metadata=dict(contract='c',checkpointSha256='p')
        p.search=None;p.decisions=0;p.elapsed=0.;p.search_runs=0;p.search_fallbacks=0
        request=dict(contract='c',rows=[dict(entities=[None],legal=[0,2],memory=[0.,0.],previous=4)])
        legacy=p.predict(request)['rows'][0]
        self.assertNotIn('probabilities',legacy);self.assertEqual(legacy['action'],2)
        watched=p.predict(dict(request,probabilities=True))['rows'][0]
        self.assertEqual(watched['selectionMode'],'greedy');self.assertEqual(watched['action'],2)
        self.assertEqual([a for a,_ in watched['probabilities']],[0,2])
        self.assertAlmostEqual(sum(v for _,v in watched['probabilities']),1.)
        self.assertAlmostEqual(dict(watched['probabilities'])[0],.25)
        self.assertEqual(watched['memory'],[1.,1.])
        p.search=Search()
        searched=p.predict(dict(request,probabilities=True,search=True,searchTimeMs=100))['rows'][0]
        self.assertEqual(searched['selectionMode'],'search');self.assertEqual(searched['action'],0)
        self.assertEqual(searched['probabilities'],watched['probabilities'])
        with self.assertRaisesRegex(ValueError,'probability request'):p.predict(dict(request,probabilities='yes'))
