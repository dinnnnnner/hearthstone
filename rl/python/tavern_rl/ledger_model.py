"""Shared per-minion estimates, calibrated board contributions, and placement PPO.

The final encoded channel is an explicit minion-presence flag, so empty slots and
spells cannot enter the board sum. No mutable inference cache carries masks.
"""
import torch
from torch import nn
from torch.nn import functional as F
from .entity_model import EntityActorCritic

VERSION = 'minion-ledger-v1'
ECONOMY = ('cash', 'minionAssets', 'handPotential', 'futureIncome', 'freeRefresh', 'spellDiscount', 'tavernTier')


class LedgerActorCritic(EntityActorCritic):
    ledger = True

    def __init__(self, entity_schema, actions, hidden=128, heads=4, layers=2, ledger_version=VERSION):
        if ledger_version != VERSION or hidden < 8:
            raise ValueError('Unsupported ledger architecture')
        super().__init__(entity_schema, actions, hidden, heads, layers)
        h = hidden
        def head(inputs, outputs):
            return nn.Sequential(nn.Linear(inputs, h), nn.SiLU(), nn.Linear(h, outputs))
        self.card_body = head(h*2, 1)
        self.card_adjustment = head(h*2, 1)
        nn.init.zeros_(self.card_adjustment[-1].weight)
        nn.init.zeros_(self.card_adjustment[-1].bias)
        self.economy_head = head(h, len(ECONOMY))
        self.future_economy_head = head(h, 3)
        self.combat_head = head(h+1, 3)
        self.ledger_fusion = head(1+len(ECONOMY)+3, h)
        self.policy_features = nn.Sequential(head(h, h), nn.LayerNorm(h))
        self.value_features = nn.Sequential(head(h, h), nn.LayerNorm(h))
        definitions = entity_schema['definitions']
        is_minion = [False] + [definitions[str(i+1)].get('kind') == 'minion' for i in range(len(entity_schema['ids']))]
        self.register_buffer('ledger_minion_ids', torch.tensor(is_minion), persistent=False)
        self.register_buffer('ledger_card_zones', torch.tensor([z in (1,2,4) for z in self.zone_ids.tolist()]), persistent=False)
        self.register_buffer('ledger_board_zone', self.zone_ids == 1, persistent=False)

    def specification(self):
        return super().specification() | dict(architecture='entity-gru-ledger', ledger_version=VERSION)

    def encode(self, observations, device):
        from .inference_features import HostEntityBatch
        encoded = super().encode(observations, device)
        ids = torch.as_tensor(observations.data['ids'], device=device) if isinstance(observations, HostEntityBatch) else torch.tensor(
            [o.ids if o else (0,)*self.schema['count'] for o in observations], device=device)
        present = self.ledger_minion_ids[ids] & self.ledger_card_zones[None]
        return torch.cat((encoded[...,:-1], present[...,None].to(encoded.dtype)), -1)

    def ledger_from(self, encoded, memory):
        context = torch.cat((encoded, memory[:,None].expand_as(encoded)), -1)
        present = encoded[...,-1] > .5
        body_raw = self.card_body(context).squeeze(-1)
        body_log = F.softplus(body_raw) * present
        # Preserve the rule head's units: only rule supervision trains its output
        # weights. Combat can assign large contributions to small support minions;
        # its correction has no fixed multiple-of-body ceiling. Cap exp for stability.
        strength_log = F.softplus(body_raw.detach() + self.card_adjustment(context).squeeze(-1))
        strength = torch.expm1(strength_log.clamp(max=12)) * present
        contributions = strength * self.ledger_board_zone[None]
        board = contributions.sum(-1)
        economy = F.softplus(self.economy_head(memory))
        future = F.softplus(self.future_economy_head(memory))
        combat = self.combat_head(torch.cat((memory, board.log1p()[:,None]), -1))
        return dict(body_log=body_log, strength=strength, contributions=contributions, board=board,
                    economy_log=economy, future_log=future, combat_logits=combat, present=present)

    def head_features(self, memory, with_value=True):
        return self.policy_features(memory), self.value_features(memory) if with_value else None

    def distribution_from(self, encoded, memory, masks, with_value=True, with_action_values=False):
        ledger = self.ledger_from(encoded, memory)
        summary = torch.cat((ledger['board'].log1p()[:,None], ledger['economy_log'], ledger['future_log']), -1)
        enriched = memory + self.ledger_fusion(summary.detach())
        return super().distribution_from(encoded, enriched, masks, with_value, with_action_values)

    def explain(self, observations, masks, memory, previous):
        encoded = self.encode(observations, masks.device)
        memory = self.recurrent_step(encoded, memory, previous)
        distribution, value = self.distribution_from(encoded, memory, masks)
        ledger = self.ledger_from(encoded, memory)
        return distribution, value, memory, ledger
