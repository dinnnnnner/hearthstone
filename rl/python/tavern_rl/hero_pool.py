"""Deterministic hero assignment using the frozen simulator's explicit heroes option."""
from __future__ import annotations

import json
from pathlib import Path
import random


def validate_hero_pool(pool, meta):
    if not isinstance(pool, dict) or pool.get("format") != 1:
        raise ValueError("Hero pool must be a format=1 JSON object")
    heroes = pool.get("heroes")
    if not isinstance(heroes, list) or len(heroes) < 8:
        raise ValueError("Hero pool requires at least eight distinct heroes")
    if any(not isinstance(h, dict) or not isinstance(h.get("id"), str) for h in heroes):
        raise ValueError("Each hero needs a string id")
    ids = [h["id"] for h in heroes]
    if len(set(ids)) != len(ids):
        raise ValueError("Hero pool contains duplicate ids")
    unknown = set(ids) - set(meta["heroIds"])
    if unknown:
        raise ValueError(f"Hero pool contains unimplemented heroes: {sorted(unknown)}")
    return pool


def load_hero_pool(path, meta):
    return validate_hero_pool(json.loads(Path(path).read_text()), meta)


def options_for_seed(options, pool, seed):
    if pool is None:
        return options
    if "heroes" in options:
        raise ValueError("Cannot combine a hero pool with a fixed eight-hero lineup")
    # A private stream leaves training RNG states and opponent sampling untouched.
    ids = [h["id"] for h in pool["heroes"]]
    heroes = random.Random(int(seed) ^ 0x4845524F).sample(ids, 8)
    return dict(options, heroes=heroes)
