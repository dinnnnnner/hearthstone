import gzip
import json
import unittest
from tavern_rl.serve import decode_request


class ServingTests(unittest.TestCase):
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
