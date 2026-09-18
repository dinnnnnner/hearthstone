"""Dense, task-gated experts over the hero-conditioned recurrent game state.

Experts are anonymous learned features, not hand-labelled economic or combat
strategies. Every sample uses all experts; there is no cross-sample dispatch,
token dropping, or mutable forward cache.
"""
import torch
from torch import nn
from torch.nn import functional as F
from .ledger_model import LedgerActorCritic, VERSION as LEDGER_VERSION

VERSION = 'task-gated-moe-v1'
TASKS = ('card', 'combat', 'economy', 'future', 'policy', 'value')


class TaskMixture(nn.Module):
    def __init__(self, hidden, experts, width):
        super().__init__()
        self.expert_count = experts
        self.input_norm = nn.LayerNorm(hidden)
        self.experts = nn.ModuleList([
            nn.Sequential(nn.Linear(hidden, width), nn.SiLU(),
                          nn.Linear(width, hidden), nn.LayerNorm(hidden))
            for _ in range(experts)
        ])
        self.routers = nn.ModuleDict({task: nn.Linear(hidden, experts) for task in TASKS})
        # Near-uniform initial routing, with distinct experts and a live gradient
        # through the router input from the first update.
        for router in self.routers.values():
            nn.init.normal_(router.weight, std=.01)
            nn.init.zeros_(router.bias)

    def routing(self, memory, tasks=TASKS):
        x = self.input_norm(memory)
        return torch.stack([self.routers[task](x).softmax(-1) for task in tasks], 1)

    def forward(self, memory, tasks=TASKS):
        x = self.input_norm(memory)
        experts = torch.stack([expert(x) for expert in self.experts], 1)
        weights = self.routing(memory, tasks)
        # Residual shared state preserves information when expert mixtures cancel.
        return memory[:, None] + torch.bmm(weights, experts), weights


class MoEActorCritic(LedgerActorCritic):
    moe = True

    def __init__(self, entity_schema, actions, hidden=128, heads=4, layers=2,
                 ledger_version=LEDGER_VERSION, experts=4, expert_width=None,
                 moe_version=VERSION):
        if type(experts) is not int or not 2 <= experts <= 16:
            raise ValueError('MoE requires 2..16 experts')
        width = hidden * 2 if expert_width is None else expert_width
        if type(width) is not int or not 8 <= width <= 4096 or moe_version != VERSION:
            raise ValueError('Unsupported MoE width/version')
        super().__init__(entity_schema, actions, hidden, heads, layers, ledger_version)
        self.expert_count, self.expert_width = experts, width
        self.mixture = TaskMixture(hidden, experts, width)

    def specification(self):
        return super().specification() | dict(architecture='entity-gru-moe',
            experts=self.expert_count, expert_width=self.expert_width, moe_version=VERSION)

    def ledger_from(self, encoded, memory):
        features, weights = self.mixture(memory, TASKS[:4])
        card, combat_state, economy_state, future_state = features.unbind(1)
        context = torch.cat((encoded, card[:, None].expand_as(encoded)), -1)
        present = encoded[..., -1] > .5
        raw = self.card_body(context).squeeze(-1)
        body_log = F.softplus(raw) * present
        strength_log = F.softplus(raw.detach() + self.card_adjustment(context).squeeze(-1))
        strength = torch.expm1(strength_log.clamp(max=12)) * present
        contributions = strength * self.ledger_board_zone[None]
        board = contributions.sum(-1)
        economy = F.softplus(self.economy_head(economy_state))
        future = F.softplus(self.future_economy_head(future_state))
        combat = self.combat_head(torch.cat((combat_state, board.log1p()[:, None]), -1))
        return dict(body_log=body_log, strength=strength, contributions=contributions,
            board=board, economy_log=economy, future_log=future,
            combat_logits=combat, present=present, auxiliary_routing=weights)

    def decision_memory(self, memory, ledger):
        summary = torch.cat((ledger['board'].log1p()[:, None],
                             ledger['economy_log'], ledger['future_log']), -1)
        return memory + self.ledger_fusion(summary.detach())

    def head_features(self, memory, with_value=True):
        tasks = TASKS[4:] if with_value else ('policy',)
        features, _ = self.mixture(memory, tasks)
        return self.policy_features(features[:, 0]), (
            self.value_features(features[:, 1]) if with_value else None)

    def routing_weights(self, memory, ledger):
        # Match the actual policy/value inputs, which also include detached ledger
        # predictions. Never report the routes for a different, raw memory input.
        decision = self.decision_memory(memory, ledger)
        return torch.cat((ledger['auxiliary_routing'],
                          self.mixture.routing(decision, TASKS[4:])), 1)

    def explain(self, observations, masks, memory, previous):
        dist, value, updated, ledger = super().explain(observations, masks, memory, previous)
        ledger['routing'] = self.routing_weights(updated, ledger)
        return dist, value, updated, ledger
