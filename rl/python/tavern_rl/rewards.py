"""Training-only shaping; game scores and evaluation placements stay unchanged."""
import math

DEFAULT_UNUSED_GOLD_PENALTY = 0.0


def penalty_coefficient(value):
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise ValueError('Unused gold penalty must be finite and nonnegative')
    return value


def unused_gold_reward(state, action_spec, coefficient):
    if not coefficient or action_spec['type'] != 'end':
        return 0.0
    # Read before step(): the final end action can resolve combat and start the
    # next recruit phase, replacing the old gold with the next turn's income.
    gold = state['entities'][0]['details']['gold']
    if not isinstance(gold, (int, float)) or not math.isfinite(gold) or gold < 0:
        raise ValueError('Invalid gold in ending player observation')
    return -coefficient * gold


def trajectory_rewards(step_rewards, terminal_reward):
    rewards = list(step_rewards)
    if not rewards:
        raise ValueError('Cannot reward an empty trajectory')
    rewards[-1] += terminal_reward
    return rewards
