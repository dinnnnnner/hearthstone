"""Optional first-place bonus for PPO, leaving game standings unchanged."""
import math


def validate_bonus(value):
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise ValueError('First-place bonus must be finite and nonnegative')
    return value


def resolve_bonus(config, override):
    return validate_bonus(config.get('first_place_bonus', 0.) if override is None else override)


def reward_with_first_place_bonus(base_reward, placement, bonus):
    if placement not in range(1, 9) or not math.isfinite(base_reward):
        raise ValueError('Invalid terminal placement or reward')
    return base_reward + (validate_bonus(bonus) if placement == 1 else 0.)
