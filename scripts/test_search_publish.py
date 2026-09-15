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

    def test_unknown_regular_model_still_blocks_publication(self):
        with self.assertRaises(RuntimeError):
            ops.published_base_models([dict(id='64'), dict(id='unknown')], [dict(id='64')])


if __name__ == '__main__': unittest.main()
