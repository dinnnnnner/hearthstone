import unittest
import torch
from tavern_rl.rollout import sample_masked_cdf


class MaskedSamplingTests(unittest.TestCase):
    def test_gaps_boundaries_and_tail(self):
        probs = torch.tensor([[0., .25, 0., .5, 0., .25, 0.]]).expand(5, -1)
        draws = torch.tensor([0., .249, .25, .75, 1.])
        actions = sample_masked_cdf(probs, probs > 0, draws)
        self.assertEqual(actions.tolist(), [1, 1, 3, 5, 5])

    def test_sparse_distribution_frequencies(self):
        draws = (torch.arange(10000) + .5) / 10000
        probs = torch.tensor([[0., .1, 0., .3, .6, 0.]]).expand(len(draws), -1)
        actions = sample_masked_cdf(probs, probs > 0, draws)
        self.assertEqual(torch.bincount(actions, minlength=6).tolist(), [0, 1000, 0, 3000, 6000, 0])

    @unittest.skipUnless(torch.cuda.is_available(), 'CUDA parallel-scan regression')
    def test_cuda_zero_mass_crossings_are_never_selected(self):
        legal = [0, 1, 2, 29, 37, 38, 39, 40, 41, 42, 3940, 3941, 3942,
                 3943, 3945, 3946, 34, 71, 72, 73, 74, 75, 77, 35, 78, 79,
                 80, 81, 82, 83, 3735, 3736, 3737, 3738, 3739, 3740, 3741,
                 3742, 3743, 3744, 3745]
        rng = torch.Generator(device='cuda').manual_seed(2177)
        mask = torch.zeros((1, 4316), device='cuda', dtype=torch.bool)
        mask[:, legal] = True
        for _ in range(20):
            probs = torch.randn(mask.shape, device='cuda', generator=rng).masked_fill(~mask, -1e9).softmax(-1)
            cdf = probs.cumsum(-1)
            cdf = cdf / cdf[:, -1:]
            jumps = ((cdf[:, 1:] > cdf[:, :-1]) & ~mask[:, 1:]).nonzero()
            for _, index in jumps[:8].tolist():
                action = sample_masked_cdf(probs, mask, cdf[:, index])
                self.assertTrue(mask[0, action.item()].item())
            # Exercise exact CDF boundaries, including every zero-mass gap.
            draws = cdf[0, :-1].clamp_max(1 - torch.finfo(torch.float32).eps / 2)
            actions = sample_masked_cdf(probs.expand(len(draws), -1), mask.expand(len(draws), -1), draws)
            self.assertTrue(mask[0, actions].all().item())


if __name__ == '__main__':
    unittest.main()
