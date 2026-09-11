"""Residual MLP policy/value towers on the entity attention + recurrent encoder."""
import math
from torch import nn
from .entity_model import EntityActorCritic


def validate_depth(depth):
    if type(depth) is not int or depth < 4 or depth % 4:
        raise ValueError('Residual depth must be a positive multiple of four (at least 4)')


class ResidualBlock(nn.Module):
    def __init__(self, width, scale):
        super().__init__()
        # Depth counts Dense layers, excluding normalization/activation/output heads.
        self.branch = nn.Sequential(*[layer for _ in range(4)
            for layer in (nn.Linear(width, width), nn.LayerNorm(width), nn.SiLU())])
        self.scale = scale

    def forward(self, x):
        return x + self.scale * self.branch(x)


class ResidualTower(nn.Module):
    def __init__(self, width, depth):
        super().__init__()
        validate_depth(depth)
        self.depth = depth
        blocks = depth // 4
        # Scale residual accumulation and normalize each output before PPO heads.
        # These are explicit adaptations for recurrent PPO, not a CRL reproduction.
        self.blocks = nn.Sequential(*[ResidualBlock(width, 1 / math.sqrt(blocks)) for _ in range(blocks)])
        self.output_norm = nn.LayerNorm(width)

    def forward(self, x):
        return self.output_norm(self.blocks(x))


class DeepEntityActorCritic(EntityActorCritic):
    def __init__(self, entity_schema, actions, hidden=128, heads=4, layers=2,
                 policy_depth=64, value_depth=64):
        validate_depth(policy_depth); validate_depth(value_depth)
        super().__init__(entity_schema, actions, hidden, heads, layers)
        self.policy_tower = ResidualTower(hidden, policy_depth)
        self.value_tower = ResidualTower(hidden, value_depth)

    def head_features(self, memory, with_value=True):
        return self.policy_tower(memory), self.value_tower(memory) if with_value else None

    def specification(self):
        return super().specification() | dict(architecture='entity-gru-resnet',
            policy_depth=self.policy_tower.depth, value_depth=self.value_tower.depth)
