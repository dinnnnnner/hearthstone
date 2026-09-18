from __future__ import annotations
import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical

class ActorCritic(nn.Module):
    observation_kind = 'flat'
    recurrent = False
    def __init__(self, observation_size, action_size, hidden=128):
        super().__init__()
        self.observation_size, self.action_size, self.hidden = observation_size, action_size, hidden
        self.encoder = nn.Sequential(nn.Linear(observation_size, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh())
        self.actor = nn.Linear(hidden, action_size)
        self.critic = nn.Linear(hidden, 1)
        for module in self.modules():
            if isinstance(module, nn.Linear):
                nn.init.orthogonal_(module.weight, np.sqrt(2))
                nn.init.zeros_(module.bias)
        nn.init.orthogonal_(self.actor.weight, .01)
        nn.init.orthogonal_(self.critic.weight, 1)

    def forward(self, observations):
        encoded = self.encoder(observations)
        return self.actor(encoded), self.critic(encoded).squeeze(-1)

    def distribution(self, observations, masks):
        if not masks.any(dim=-1).all():
            raise ValueError("Every decision must have a legal action")
        logits, values = self(observations)
        return Categorical(logits=logits.masked_fill(~masks, -1e9)), values

    def specification(self):
        return {"observation_size": self.observation_size, "action_size": self.action_size, "hidden": self.hidden}


def advantages(values, terminal_reward, gamma=1.0, gae_lambda=.95, bootstrap=0.):
    """One complete player's trajectory. Never concatenate opponents' decisions."""
    values = np.asarray(values, dtype=np.float32)
    rewards = np.asarray(terminal_reward, dtype=np.float32)
    if rewards.ndim == 0:
        rewards = np.zeros_like(values)
        if len(values): rewards[-1] = terminal_reward
    if rewards.shape != values.shape or not np.isfinite(rewards).all():
        raise ValueError('Expected finite scalar terminal reward or one reward per decision')
    result = np.empty_like(values)
    last = 0.0
    for i in reversed(range(len(values))):
        next_value = values[i + 1] if i + 1 < len(values) else bootstrap
        reward = rewards[i]
        delta = reward + gamma * next_value - values[i]
        last = float(delta + gamma * gae_lambda * last)
        result[i] = last
    return result, result + values


def ppo_update(model, optimizer, tracks, config, device):
    if getattr(model, 'recurrent', False):
        from .recurrent import recurrent_update
        return recurrent_update(model, optimizer, tracks, config, device)
    observations, masks, actions, log_probs, advs, returns = [], [], [], [], [], []
    for records, reward in tracks:
        if not records:
            continue
        adv, ret = advantages([r[4] for r in records], reward, config["gamma"], config["gae_lambda"])
        observations.extend(r[0] for r in records)
        masks.extend(r[1] for r in records)
        actions.extend(r[2] for r in records)
        log_probs.extend(r[3] for r in records)
        advs.extend(adv); returns.extend(ret)
    if not observations:
        raise RuntimeError("No complete current-policy trajectories collected; inspect truncations")
    obs = torch.as_tensor(np.stack(observations), dtype=torch.float32, device=device)
    legal = torch.as_tensor(np.stack(masks), dtype=torch.bool, device=device)
    chosen = torch.as_tensor(actions, dtype=torch.long, device=device)
    old_log = torch.as_tensor(log_probs, dtype=torch.float32, device=device)
    adv = torch.as_tensor(advs, dtype=torch.float32, device=device)
    target = torch.as_tensor(returns, dtype=torch.float32, device=device)
    adv = (adv - adv.mean()) / (adv.std(unbiased=False) + 1e-8)
    stats = []; stop = False
    model.train()
    for _ in range(config["epochs"]):
        order = torch.randperm(len(obs), device=device)
        for batch in order.split(config["batch_size"]):
            dist, values = model.distribution(obs[batch], legal[batch])
            log_ratio = dist.log_prob(chosen[batch]) - old_log[batch]
            ratio = log_ratio.exp()
            with torch.no_grad():
                kl = ((ratio - 1) - log_ratio).mean()
            if kl > 1.5 * config["target_kl"]:
                stop = True; break
            policy_loss = -torch.minimum(ratio * adv[batch], ratio.clamp(1-config["clip"], 1+config["clip"]) * adv[batch]).mean()
            value_loss = (values - target[batch]).square().mean()
            entropy = dist.entropy().mean()
            loss = policy_loss + config["value_coef"] * value_loss - config["entropy_coef"] * entropy
            if not torch.isfinite(loss):
                raise RuntimeError("Non-finite PPO loss")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            norm = nn.utils.clip_grad_norm_(model.parameters(), config["max_grad_norm"], error_if_nonfinite=True)
            optimizer.step()
            stats.append([float(policy_loss.detach()), float(value_loss.detach()), float(entropy.detach()), float(kl), float(norm)])
        if stop:
            break
    if not stats:
        raise RuntimeError("PPO performed no optimizer updates")
    means = np.mean(stats, axis=0)
    return dict(zip(["policy_loss", "value_loss", "entropy", "approx_kl", "gradient_norm"], means.tolist())) | {"samples": len(obs), "optimizer_steps": len(stats), "kl_early_stop": stop}


def make_model(specification):
    spec = dict(specification)
    auxiliary=spec.pop('auxiliary_heads',None)
    card_value=spec.pop('card_value_head',None)
    action_values=spec.pop('action_values',None)
    scene=spec.pop('scene_value_head',None)
    horizons=spec.pop('multi_horizon',None)
    architecture = spec.pop('architecture', 'mlp')
    if architecture == 'mlp': model=ActorCritic(**spec)
    elif architecture == 'entity-gru':
        from .entity_model import EntityActorCritic
        model=EntityActorCritic(**spec)
    elif architecture == 'entity-gru-ledger':
        if any((auxiliary,card_value,action_values,scene,horizons)):raise ValueError('Ledger model cannot load legacy auxiliary heads')
        from .ledger_model import LedgerActorCritic
        model=LedgerActorCritic(**spec)
    elif architecture == 'entity-gru-moe':
        if any((auxiliary,card_value,action_values,scene,horizons)):raise ValueError('MoE model cannot load legacy auxiliary heads')
        from .moe_model import MoEActorCritic
        model=MoEActorCritic(**spec)
    elif architecture == 'entity-gru-resnet':
        from .deep_model import DeepEntityActorCritic
        model=DeepEntityActorCritic(**spec)
    else:raise ValueError(f'Unknown architecture: {architecture}')
    if auxiliary:
        from .streaming import enable_auxiliary
        enable_auxiliary(model,auxiliary)
    if card_value:
        from .card_value import enable
        enable(model,card_value)
    if action_values:
        from .action_value import enable
        enable(model,action_values)
    if scene:
        from .scene_value import enable
        enable(model,scene)
    if horizons:
        from .multi_horizon import enable
        enable(model,horizons)
    return model
