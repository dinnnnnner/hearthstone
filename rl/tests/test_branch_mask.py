import unittest

import torch

from tavern_rl.counterfactual import legal_action_mask
from tavern_rl.rollout import sample_masked_cdf


class BranchMaskTests(unittest.TestCase):
    def test_batched_mask_preserves_probabilities_and_sampled_actions(self):
        for device in ['cpu'] + (['cuda'] if torch.cuda.is_available() else []):
            for size in (1, 4, 16):
                rows = [[0, 2, 7], [7], [1, 1, 6], list(range(8))] * 4
                rows = rows[:size]
                expected = torch.zeros(size, 8, dtype=torch.bool, device=device)
                for index, actions in enumerate(rows):
                    expected[index, actions] = True
                actual = legal_action_mask(rows, 8, device)
                self.assertEqual(actual.dtype, torch.bool)
                torch.testing.assert_close(actual, expected, rtol=0, atol=0)
                logits = torch.arange(size * 8, device=device, dtype=torch.float32).reshape(size, 8) / 7
                before = logits.masked_fill(~expected, -torch.inf).softmax(-1)
                after = logits.masked_fill(~actual, -torch.inf).softmax(-1)
                torch.testing.assert_close(after, before, rtol=0, atol=0)
                for quantile in (0., .1, .5, .999):
                    uniforms = torch.full((size,), quantile, device=device)
                    torch.testing.assert_close(sample_masked_cdf(after, actual, uniforms),
                                               sample_masked_cdf(before, expected, uniforms), rtol=0, atol=0)

    def test_empty_rows_and_empty_batch_keep_shape(self):
        for device in ['cpu'] + (['cuda'] if torch.cuda.is_available() else []):
            result = legal_action_mask([[], [0, 3]], 4, device)
            self.assertEqual(result.tolist(), [[False] * 4, [True, False, False, True]])
            self.assertEqual(tuple(legal_action_mask([], 4, device).shape), (0, 4))


if __name__ == '__main__':
    unittest.main()
