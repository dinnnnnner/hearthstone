import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('tavern_ops', Path(__file__).with_name('tavern-ops.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class SearchPublicationTests(unittest.TestCase):
    def test_regular_publication_preserves_frozen_search_variant(self):
        models = [dict(id='64', checkpointSha256='old'), dict(id='64-search', search=True, checkpointSha256='frozen'), dict(id='256')]
        base = ops.published_base_models(models, [dict(id='64'), dict(id='256')])
        base[0]['checkpointSha256'] = 'new'
        self.assertEqual(models[0]['checkpointSha256'], 'new')
        self.assertEqual(models[1]['checkpointSha256'], 'frozen')
        self.assertEqual([m['id'] for m in models], ['64', '64-search', '256'])

    def test_including_search_pairs_weights_but_preserves_endpoints_and_ids(self):
        import copy
        reports=[dict(id=ident,episodes=i+10,checkpointSha256=str(i),hashes={'model.pt':str(i)})
                 for i,ident in enumerate(['deep64-1480','deep256-1164','deep1024-612'])]
        models=[dict(id=r['id'],url='base/'+r['id']) for r in reports]
        models += [dict(id=f'deep{d}-search-123',search=True,url=f'search/{d}') for d in [64,256,1024]]
        original=copy.deepcopy(models)
        plan=ops.publication_plan(models,reports,True)
        self.assertEqual([p['port'] for p in plan],[18890,18896,18892,18900,18894,18902])
        for i in range(3):
            self.assertEqual(models[i]['checkpointSha256'],models[i+3]['checkpointSha256'])
            self.assertEqual(plan[i*2]['source'],plan[i*2+1]['source'])
        self.assertEqual([(m['id'],m['url']) for m in models],[(m['id'],m['url']) for m in original])
        self.assertEqual(plan[-1]['unit'],'tavern-deep1024-search')
        with self.assertRaises(RuntimeError):ops.publication_plan(original[:-1],reports,True)

    def test_unknown_regular_model_still_blocks_publication(self):
        with self.assertRaises(RuntimeError):
            ops.published_base_models([dict(id='64'), dict(id='unknown')], [dict(id='64')])


if __name__ == '__main__': unittest.main()
