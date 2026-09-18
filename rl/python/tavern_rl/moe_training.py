"""Task-wise batch routing regularization; game rewards remain unchanged."""
import hashlib
import math
from pathlib import Path
import torch
from .moe_model import VERSION, TASKS


def configure(config, args, model):
    previous = config.get('moe')
    coefficient = getattr(args, 'moe_balance_coef', None)
    if coefficient is None:
        coefficient = previous['balance_coefficient'] if previous else .01
    if not math.isfinite(coefficient) or not 0 <= coefficient <= 1:
        raise ValueError('MoE balance coefficient must be in [0, 1]')
    digest = hashlib.sha256()
    for filename in ('moe_model.py', 'moe_training.py', 'entity_model.py', 'features.py',
                     'ledger_model.py', 'ledger_training.py', 'recurrent.py'):
        digest.update(filename.encode())
        digest.update(Path(__file__).with_name(filename).read_bytes())
    settings = dict(version=VERSION, tasks=list(TASKS), experts=model.expert_count,
                    expert_width=model.expert_width, balance_coefficient=coefficient,
                    implementation_hash=digest.hexdigest())
    if previous is not None and previous != settings:
        raise ValueError('MoE settings/implementation changed; start a new experiment')
    config['moe'] = settings


def balance_loss(weights):
    """Balance average use per task, not each individual decision's route."""
    usage = weights.mean(0)
    return (weights.shape[-1] * usage.square().sum(-1) - 1).mean()


def regularization(model, encoded, memory, settings):
    if not len(memory):
        raise ValueError('MoE regularization needs valid trajectory rows')
    ledger = model.ledger_from(encoded, memory)
    weights = model.routing_weights(memory, ledger)
    loss = balance_loss(weights)
    usage = weights.detach().mean(0)
    entropy = -(weights.detach() * weights.detach().clamp_min(1e-12).log()).sum(-1).mean(0)
    stats = dict(balance_loss=float(loss.detach()))
    for task, average, ent in zip(TASKS, usage, entropy):
        stats[f'{task}_entropy'] = float(ent)
        for expert, value in enumerate(average):
            stats[f'{task}_expert_{expert}'] = float(value)
    return settings['balance_coefficient'] * loss, stats
