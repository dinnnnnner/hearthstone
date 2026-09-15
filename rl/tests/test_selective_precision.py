import copy
import unittest
import torch
from tavern_rl.deep_model import ResidualTower
from tavern_rl.selective_precision import bf16_tower_linears
from tavern_rl.sampling_graphs import tower_graphs


class SelectivePrecisionTests(unittest.TestCase):
    def test_cpu_uses_fp32_and_restores_forwards(self):
        tower=ResidualTower(8,4);x=torch.randn(3,8);expected=tower(x)
        with self.assertRaisesRegex(RuntimeError,'stop'):
            with bf16_tower_linears(tower):
                torch.testing.assert_close(tower(x),expected,rtol=0,atol=0)
                raise RuntimeError('stop')
        self.assertTrue(all('forward' not in layer.__dict__ for layer in tower.modules()))

    @unittest.skipUnless(torch.cuda.is_available(),'CUDA required')
    def test_normalization_gradients_optimizer_and_graph_outputs_stay_fp32(self):
        torch.manual_seed(42);tower=ResidualTower(128,64).cuda();norm_dtypes=[]
        hooks=[layer.register_forward_pre_hook(lambda _,args:norm_dtypes.append(args[0].dtype))
               for layer in tower.modules() if isinstance(layer,torch.nn.LayerNorm)]
        optimizer=torch.optim.Adam(tower.parameters(),lr=1e-4,fused=True)
        x=torch.randn(8,128,device='cuda');before=copy.deepcopy(tower.state_dict())
        try:
            with bf16_tower_linears(tower):
                for _ in range(2):
                    optimizer.zero_grad(set_to_none=True);out=tower(x.requires_grad_());loss=out.square().mean();loss.backward();optimizer.step()
                    self.assertEqual(out.dtype,torch.float32)
                    self.assertTrue(all(p.dtype==torch.float32 and p.grad.dtype==torch.float32 for p in tower.parameters()))
                tower.eval()
                with torch.inference_mode():
                    eager=tower(x)
                    with tower_graphs([tower],8) as graphs:
                        actual=tower(x);torch.testing.assert_close(actual,eager,rtol=2e-4,atol=2e-4)
                        self.assertGreater(graphs[0].replays,0)
            self.assertTrue(norm_dtypes);self.assertEqual(set(norm_dtypes),{torch.float32})
            self.assertTrue(any(not torch.equal(before[n],p) for n,p in tower.state_dict().items()))
            self.assertTrue(all(v.dtype==torch.float32 for state in optimizer.state.values() for v in state.values() if torch.is_tensor(v)))
        finally:
            for hook in hooks:hook.remove()


if __name__=='__main__':unittest.main()
