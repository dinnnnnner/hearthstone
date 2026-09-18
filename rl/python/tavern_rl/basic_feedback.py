"""Bounded potential differences from the explicit board/economy evaluator.

Only complete per-seat trajectories are accepted. Terminal potential is zero:
sum(shaped rewards) = actual placement reward - initial potential, so cycles
cannot manufacture reward. The scorer is never a policy observation or Q head.
"""
import argparse
import json
import math
from pathlib import Path
import time
import numpy as np

from .bridge import ROOT, Simulator

VERSION = 'board-economy-potential-v1'
SCORER_VERSION = 'board-economy-v1'
CONFLICTS = ('streaming', 'counterfactual', 'card_value', 'action_value', 'scene_value',
             'multi_horizon', 'gold_planning', 'stage_feedback', 'tier_tempo')


def add_arguments(parser):
    parser.add_argument('--basic-feedback', action=argparse.BooleanOptionalAction, default=None,
                        help='Complete-game PPO with bounded board/economy potential feedback; replaces auxiliary estimation modes')
    parser.add_argument('--basic-feedback-coefficient', type=float, default=None)
    parser.add_argument('--basic-feedback-scale', type=float, default=None)
    parser.add_argument('--basic-feedback-weights', type=Path, help='JSON score weights, saved into the training checkpoint')


def enabled(config, args):
    saved = bool(config.get('basic_feedback'))
    requested = getattr(args, 'basic_feedback', None)
    if saved and requested is False:
        raise ValueError('Cannot remove the saved reward objective on resume; use a separate new run')
    return saved if requested is None else requested


def validate(settings):
    if settings.get('version') != VERSION:
        raise ValueError('Unknown basic feedback version')
    for name, low, high in [('coefficient', 0., .25), ('scale', 0., 1e6)]:
        value = settings.get(name)
        if type(value) not in (int, float) or not math.isfinite(value) or not low < value <= high:
            raise ValueError(f'Invalid basic feedback {name}')
    weights = settings.get('weights', {})
    if not isinstance(weights, dict) or any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in weights.values()):
        raise ValueError('Invalid basic feedback weights')


def configure(config, args, model, meta):
    if not enabled(config, args):
        if any(getattr(args, key, None) is not None for key in (
                'basic_feedback_coefficient', 'basic_feedback_scale', 'basic_feedback_weights')):
            raise ValueError('Basic feedback options require --basic-feedback')
        return
    for name in CONFLICTS:
        if config.get(name) or getattr(args, name, None) is True:
            raise ValueError(f'Basic feedback requires complete-game PPO without {name}; use a new run')
    if any(hasattr(model, name) for name in ('action_value_type', 'auxiliary', 'card_value_head', 'scene_current', 'horizon_embedding')):
        raise ValueError('Basic feedback needs a plain PPO model; do not reuse an auxiliary/Q checkpoint')
    if config.get('gamma') != 1.:
        raise ValueError('Basic feedback currently requires gamma=1')
    settings = dict(config.get('basic_feedback', dict(version=VERSION, coefficient=.1, scale=20., weights={})))
    for name in ('coefficient', 'scale'):
        value = getattr(args, 'basic_feedback_' + name, None)
        if value is not None: settings[name] = value
    if getattr(args, 'basic_feedback_weights', None):
        settings['weights'] = json.loads(args.basic_feedback_weights.read_text())
    validate(settings)
    scorer = BasicFeedback(settings, meta)
    try:
        settings['weights'] = {**scorer.simulator.meta['weights'], **settings['weights']}
        settings['implementation_hash'] = scorer.simulator.meta['implementationHash']
    finally:
        scorer.close()
    config['basic_feedback'] = settings
    config['reward_mode'] = VERSION


def shape_rewards(potentials, terminal_reward):
    potentials = np.asarray(potentials, dtype=np.float64)
    if potentials.ndim != 1 or not len(potentials) or not np.isfinite(potentials).all() or not math.isfinite(terminal_reward):
        raise ValueError('Need finite complete per-seat potentials and an actual terminal reward')
    # Successor means the next decision of THIS seat, never the next acting seat.
    rewards = np.diff(np.append(potentials, 0.))
    rewards[-1] += terminal_reward
    return rewards.astype(np.float32)


class BasicFeedback:
    def __init__(self, settings, meta, bundle=None):
        validate(settings)
        self.settings = dict(settings)
        path = bundle or ROOT / 'rl-dist/basic-evaluation.cjs'
        if not Path(path).is_file():
            raise FileNotFoundError('Build the board/economy scorer: node scripts/build-basic-evaluation.mjs')
        self.simulator = Simulator(path)
        try:
            schema = self.simulator.meta
            if schema.get('version') != SCORER_VERSION or schema.get('entitySchema') != meta['entitySchema']:
                raise ValueError('Basic evaluator definitions differ from the training simulator')
            if settings.get('implementation_hash', schema['implementationHash']) != schema['implementationHash']:
                raise ValueError('Basic evaluator implementation changed since the saved checkpoint')
            if set(settings['weights']) - set(schema['weights']):
                raise ValueError('Unknown basic evaluation weights')
        except BaseException:
            self.close()
            raise
        self.states = 0
        self.seconds = 0.

    def score(self, rows):
        started = time.monotonic()
        values = []
        for start in range(0, len(rows), 256):
            reports = self.simulator.call('evaluate', rows=rows[start:start + 256], weights=self.settings['weights'])
            if len(reports) != len(rows[start:start + 256]):
                raise ValueError('Basic evaluator returned a different batch size')
            for report in reports:
                score = report['total']
                if type(score) not in (int, float) or not math.isfinite(score):
                    raise ValueError('Invalid board/economy score')
                values.append(self.settings['coefficient'] * math.tanh(score / self.settings['scale']))
        self.states += len(values)
        self.seconds += time.monotonic() - started
        return values

    def close(self):
        self.simulator.close()
