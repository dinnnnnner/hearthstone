"""Bounded PUCT over one player's recruit actions, with sampled chance outcomes.

Only the first action is committed. Rollouts stop at recruit end; a computation
cutoff bootstraps the critic and never manufactures an end action for the player.
"""
from dataclasses import dataclass, field, replace
import hashlib
import json
import math
import random
import time

VERSION = 'own-recruit-puct-v1'


@dataclass(frozen=True)
class SearchConfig:
    simulations: int = 32
    max_depth: int = 64
    max_nodes: int = 128
    time_ms: int = 1000
    exploration: float = 1.5

    def __post_init__(self):
        for key, limit in [('simulations', 512), ('max_depth', 256), ('max_nodes', 1024), ('time_ms', 3000)]:
            value = getattr(self, key)
            if type(value) is not int or not 1 <= value <= limit:
                raise ValueError(f'{key} must be in 1..{limit}')
        if not math.isfinite(self.exploration) or self.exploration <= 0:
            raise ValueError('exploration must be positive and finite')


@dataclass
class Evaluation:
    priors: dict
    value: float
    memory: object


@dataclass
class Edge:
    visits: int = 0
    total: float = 0.


@dataclass
class Node:
    evaluation: Evaluation
    edges: dict = field(default_factory=dict)
    children: dict = field(default_factory=dict)


def normalized(priors, legal):
    legal = list(dict.fromkeys(legal))
    if not legal:
        return {}
    values = {a: float(priors.get(a, 0.)) for a in legal}
    if any(not math.isfinite(v) or v < 0 for v in values.values()):
        raise ValueError('Invalid policy probabilities')
    total = sum(values.values())
    return {a: v / total if total > 0 else 1 / len(values) for a, v in values.items()}


def fingerprint(view):
    # Public observations only. Never key on a sampled RNG or hidden state.
    raw = json.dumps([view['entities'], view['legal'], view.get('ended'), view.get('boundary')],
                     sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).digest()


def position_key(view):
    entities = view['entities']
    if entities and isinstance(entities[0], dict) and 'details' in entities[0]:
        first = entities[0]
        details = {k: v for k, v in first['details'].items() if k != 'decisions'}
        entities = [dict(first, details=details), *entities[1:]]
    return fingerprint(dict(view, entities=entities))


def search(simulator, root_evaluation, evaluate, memory, previous, allowed, seed,
           config=SearchConfig()):
    """evaluate(view, pre-observation memory, previous action) returns Evaluation.

    Simulator owns just one public root and one mutable branch. Nodes keep small
    policy/value/memory records; action/outcome paths preserve recurrent history.
    `memory` is the real pre-observation state and is never mutated here.
    """
    started = time.monotonic(); deadline = started + config.time_ms / 1000
    rng = random.Random(seed)
    root_view = simulator.reset(rng.getrandbits(32))
    legal = sorted(set(root_view['legal']).intersection(allowed))
    if not legal:
        return None, dict(reason='No reconstructable root actions', simulations=0)
    root = Node(Evaluation(normalized(root_evaluation.priors, legal), root_evaluation.value, root_evaluation.memory))
    node_count = 1; completed = 0; ended = 0; cutoffs = 0; deepest = 0; evaluations = 0; cycles = 0
    sampled_outcomes = set()
    # PPO priors can assign almost all mass to move/freeze. Always evaluate the
    # explicit "finish this recruit turn" alternative before searching continuations.
    if 0 in legal and time.monotonic() < deadline:
        terminal = simulator.step(0)
        estimate = evaluate(terminal, root.evaluation.memory, 0)
        if not math.isfinite(estimate.value):
            raise ValueError('Non-finite search value')
        score = -1. if terminal.get('dead') else estimate.value
        root.edges[0] = Edge(1, score)
        key = (0, fingerprint(terminal)); sampled_outcomes.add(key)
        if node_count < config.max_nodes:
            root.children[key] = Node(estimate); node_count += 1
        completed = 1; ended = 1; deepest = 1; evaluations = 1
    for _ in range(config.simulations - completed):
        if time.monotonic() >= deadline:
            break
        view = simulator.reset(rng.getrandbits(32))
        node = root; evaluation = root.evaluation; path = []; depth = 0
        positions = {position_key(view): evaluation.value}
        while True:
            if not math.isfinite(evaluation.value):
                raise ValueError('Non-finite search value')
            value = float(evaluation.value)
            if view.get('dead'):
                value = -1.; break
            if view.get('ended'):
                ended += 1; break
            if view.get('boundary') or not view['legal']:
                cutoffs += 1; break
            if depth >= config.max_depth or time.monotonic() >= deadline:
                cutoffs += 1; break
            priors = normalized(evaluation.priors, legal if depth == 0 else view['legal'])
            if node is not None:
                visits = sum(edge.visits for edge in node.edges.values())
                def priority(action):
                    edge = node.edges.get(action, Edge())
                    q = edge.total / edge.visits if edge.visits else evaluation.value
                    # Keep a little exploration mass for initially unlikely legal moves.
                    p = .98 * priors[action] + .02 / len(priors)
                    return q + config.exploration * p * math.sqrt(visits + 1) / (edge.visits + 1)
                action = max(priors, key=lambda a: (priority(a), priors[a], -a))
                path.append((node, action))
            else:
                action = rng.choices(list(priors), weights=list(priors.values()))[0]
            child_view = simulator.step(action)
            depth += 1; deepest = max(deepest, depth)
            position = position_key(child_view)
            if not child_view.get('ended') and not child_view.get('dead') and position in positions:
                # No-op move/freeze cycles consume search time without changing
                # the recruit position. Bootstrap its first value, do not end the real turn.
                value = positions[position]; cycles += 1; cutoffs += 1; break
            key = (action, fingerprint(child_view))
            if depth == 1:
                sampled_outcomes.add(key)
            child = node.children.get(key) if node else None
            if child is not None:
                next_evaluation = child.evaluation
            else:
                # Each branch receives its parent's updated memory. Real memory
                # returned to serving is still the root's single update.
                next_evaluation = evaluate(child_view, evaluation.memory, action)
                evaluations += 1
            positions[position] = next_evaluation.value
            if node is not None and child is None:
                if node_count < config.max_nodes:
                    node.children[key] = Node(next_evaluation)
                    node_count += 1
                # Expand one node, then sample the rest of this recruit turn.
                node = None
            else:
                node = child
            view = child_view; evaluation = next_evaluation
        for parent, action in path:
            edge = parent.edges.setdefault(action, Edge())
            edge.visits += 1; edge.total += value
        if path:
            completed += 1
    rows = [dict(action=a, visits=root.edges.get(a, Edge()).visits,
                 value=(root.edges[a].total / root.edges[a].visits) if a in root.edges else None, prior=p)
            for a, p in root.evaluation.priors.items()]
    visited = [r for r in rows if r['visits']]
    best = max(visited, key=lambda r: (r['value'], r['visits'], r['prior'])) if visited else None
    # The network is an un-distilled PPO prior. Visit count mostly reflects that
    # prior at small budgets; use the sampled mean value for the final choice.
    # A budget that only fits the end baseline must not force the player to end.
    has_comparison = len(legal) == 1 or any(r['action'] != 0 and r['visits'] for r in rows)
    chosen = best['action'] if best is not None and has_comparison else None
    return chosen, dict(version=VERSION, simulations=completed, recruit_ends=ended, cutoffs=cutoffs,
                        nodes=node_count, max_depth=deepest, evaluations=evaluations,
                        sampled_root_outcomes=len(sampled_outcomes), cycle_cutoffs=cycles,
                        elapsed_ms=round((time.monotonic() - started) * 1000, 2),
                        actions=sorted(rows, key=lambda r: r['visits'], reverse=True))


class SearchPolicy:
    """One shared policy/value network plus one Node simulator, no model per branch."""
    def __init__(self, model, metadata, bundle, config=SearchConfig()):
        import torch
        from .bridge import Simulator
        specification = model.specification()
        if specification.get('policy_depth') not in (64, 256, 1024) or specification.get('value_depth') != specification.get('policy_depth'):
            raise ValueError('Recruit search requires matching 64, 256 or 1024-layer policy/value towers')
        self.simulator = Simulator(bundle=bundle, timeout=5)
        if self.simulator.meta != dict(contract=metadata['contract'], searchVersion=VERSION):
            self.simulator.close()
            raise ValueError('Search simulator contract differs from serving model')
        self.model = model; self.config = config
        self.rng = random.SystemRandom()
        self.torch = torch

    def close(self):
        self.simulator.close()

    def evaluate(self, view, memory, previous):
        from .features import prepare_entities
        torch = self.torch
        masks = torch.zeros(1, self.model.action_size, dtype=torch.bool)
        # The terminal state's critic still needs the observation encoder, but
        # the dummy policy mask is never executed and cannot advance the round.
        masks[0, view['legal'] or [0]] = True
        with torch.inference_mode():
            dist, values, updated = self.model.act([prepare_entities(view['entities'])], masks,
                torch.tensor([memory], dtype=torch.float32), torch.tensor([previous], dtype=torch.long))
        return Evaluation({a: float(dist.probs[0, a]) for a in view['legal']}, float(values[0]), updated[0].tolist())

    def predict(self, row, root_evaluation, time_ms=None):
        g = row['entities'][0]['details']
        try:
            opened = self.simulator.call('open', entities=row['entities'], decisions=g['decisions'], budget=g['budget'])
            if not opened['supported']:
                return None, dict(version=VERSION, simulations=0, fallback=opened['reason'])
            config = self.config if time_ms is None else replace(self.config, time_ms=min(time_ms, self.config.time_ms))
            return search(self.simulator, root_evaluation, self.evaluate, row['memory'], row['previous'],
                          row['legal'], self.rng.getrandbits(64), config)
        finally:
            self.simulator.call('release')
