"""Experimental BF16 residual-tower GEMMs, with all interfaces and state in FP32."""
from contextlib import contextmanager
import torch
from torch import nn
from torch.nn import functional as F
from tavern_rl.deep_model import ResidualTower


@contextmanager
def bf16_tower_linears(model):
    """Keep normalization, recurrent state, heads, losses and master weights FP32.

    Install before CUDA graph capture and remove after those graphs are released.
    Autocast's weight cache is disabled so optimizer changes cannot reuse old casts.
    """
    installed=[];seen=set()
    try:
        for tower in model.modules():
            if not isinstance(tower,ResidualTower):continue
            for layer in tower.modules():
                if not isinstance(layer,nn.Linear) or id(layer) in seen:continue
                seen.add(id(layer));original=layer.__dict__.get('forward');had='forward' in layer.__dict__
                eager=layer.forward
                def forward(x,layer=layer,eager=eager):
                    if not x.is_cuda:return eager(x)
                    if x.dtype!=torch.float32 or layer.weight.dtype!=torch.float32:
                        raise ValueError('Selective precision requires FP32 inputs and master weights')
                    with torch.autocast('cuda',dtype=torch.bfloat16,cache_enabled=False):
                        result=F.linear(x,layer.weight,layer.bias)
                    return result.float()
                installed.append((layer,had,original));layer.forward=forward
        yield
    finally:
        for layer,had,original in reversed(installed):
            if had:layer.forward=original
            else:del layer.forward
