import unittest
import numpy as np
import torch
from tavern_rl.rollout import inference_to_host


class RolloutTransferTests(unittest.TestCase):
    def test_packed_transfer_preserves_actions_logs_values_and_hidden_state_exactly(self):
        for device in ['cpu'] + (['cuda'] if torch.cuda.is_available() else []):
            for batch in (1, 3, 8):
                for recurrent in (False, True):
                    for learner in (False, True):
                        actions = torch.tensor(([0, 4315, 127] * 3)[:batch], device=device)
                        logs = torch.linspace(-12, -.00001, batch, device=device) if learner else None
                        values = torch.linspace(-1, 1, batch, device=device) if learner else None
                        hidden = torch.randn(batch, 128, device=device) if recurrent else None
                        expected = inference_to_host(actions, logs, values, hidden, False)
                        actual = inference_to_host(actions, logs, values, hidden, True)
                        for left, right in zip(expected, actual):
                            if left is None:
                                self.assertIsNone(right)
                            else:
                                np.testing.assert_array_equal(left, right)
                                self.assertEqual(left.dtype, right.dtype)


if __name__ == '__main__': unittest.main()
