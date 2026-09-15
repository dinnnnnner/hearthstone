"""Lossless public fields on the wire; learned encodings, no hashed counter buckets."""
from dataclasses import dataclass
from functools import lru_cache
import json
import math
import numpy as np
import torch

@dataclass(frozen=True)
class EntityObservation:
    ids: tuple
    groups: tuple  # (entity slot, object path, ((field, text, numeric, type), ...))


@lru_cache(maxsize=4096)
def object_groups(serialized):
    value = json.loads(serialized)
    result = []
    def visit(obj, path):
        fields = []
        items = sorted(obj.items()) if isinstance(obj, dict) else [(str(i), v) for i, v in enumerate(obj)]
        for key, value in items:
            if isinstance(value, (dict, list)):
                visit(value, path + '/' + key)
            elif isinstance(value, bool): fields.append((key, '', float(value), 2))
            elif isinstance(value, (float, int)):
                if not math.isfinite(value): raise ValueError('Non-finite public field')
                fields.append((key, '', float(value), 1))
            elif isinstance(value, str): fields.append((key, value, 0., 3))
            elif value is None: fields.append((key, '', 0., 4))
            else: raise TypeError(type(value))
        result.append((path, tuple(fields)))
    visit(value, 'root')
    return tuple(result)


def prepare_entities(entities):
    ids, groups = [], []
    for slot, entity in enumerate(entities):
        ids.append(entity['id'] if entity else 0)
        if entity:
            serialized = json.dumps(entity['details'], sort_keys=True, separators=(',', ':'), ensure_ascii=False)
            groups.extend((slot, path, fields) for path, fields in object_groups(serialized))
    return EntityObservation(tuple(ids), tuple(groups))


def numeric(value, kind):
    # Equal float keys merge +0 and -0 in a cache. Preserve their original bits.
    if value == 0:
        zero = math.copysign(0., value)
        return (zero, zero, float(kind == 2), float(kind == 1))
    return _numeric_nonzero(value, kind)


@lru_cache(maxsize=16384)
def _numeric_nonzero(value, kind):
    return (math.copysign(math.log1p(abs(value)), value) / 10, math.tanh(value / 10), float(kind == 2), float(kind == 1))


def pack_entities(observations, schema, device):
    """Variable effect counts are padded only within a batch; nothing is truncated."""
    count = schema['count']
    ids = [obs.ids if obs else (0,) * count for obs in observations]
    unique_ids = sorted({identity for row in ids for identity in row if identity})
    static_indices = {identity: len(observations) * count + i for i, identity in enumerate(unique_ids)}
    strings, string_indices = [''], {'': 0}
    def symbol(text):
        if text not in string_indices:
            string_indices[text] = len(strings); strings.append(text)
        return string_indices[text]
    group_owners, group_paths, field_groups, field_keys, field_values, field_numbers, field_types = [], [], [], [], [], [], []
    def add(owner, path, fields):
        group_id = len(group_owners); group_owners.append(owner); group_paths.append(symbol(path))
        for key, text, value, kind in fields:
            field_groups.append(group_id); field_keys.append(symbol(key)); field_values.append(symbol(text))
            field_numbers.append(numeric(value, kind)); field_types.append(kind)
    for batch, obs in enumerate(observations):
        if obs:
            for slot, path, fields in obs.groups: add(batch * count + slot, path, fields)
    for identity in unique_ids:
        definition = schema['definitions'].get(str(identity), {})
        for path, fields in object_groups(json.dumps(definition, sort_keys=True, separators=(',', ':'), ensure_ascii=False)):
            add(static_indices[identity], path, fields)
    # Prevent an unexpected runaway effect list from exhausting the host, never silently drop it.
    if len(field_groups) > 2000000: raise ValueError('Observation batch exceeds 2 million fields; reduce sequence batch size')
    index = lambda values: torch.as_tensor(values, dtype=torch.long, device=device)
    return {'ids': index(ids), 'strings': strings, 'group_owners': index(group_owners), 'group_paths': index(group_paths),
            'field_groups': index(field_groups), 'field_keys': index(field_keys), 'field_values': index(field_values),
            'field_numbers': torch.as_tensor(field_numbers, dtype=torch.float32, device=device).reshape(-1, 4),
            'field_types': index(field_types), 'owner_count': len(observations) * count + len(unique_ids),
            'static_ids': index(unique_ids), 'static_owners': index([static_indices[i] for i in unique_ids]),
            'batch': len(observations)}
