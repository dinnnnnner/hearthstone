"""Read complete, versioned human episodes; split entire games before training."""
from __future__ import annotations
import gzip
import hashlib
import json
import math
from pathlib import Path


def load_dataset(directory, allow_synthetic=False):
    root = Path(directory)
    manifest = json.loads((root / 'schema.json').read_text())
    if manifest['format'] != 1 or hashlib.sha256(manifest['schema'].encode()).hexdigest() != manifest['contract']:
        raise ValueError('Invalid demonstration schema contract')
    schema = json.loads(manifest['schema'])
    count = len(schema['actions']); entity_schema = schema['entity_schema']
    episodes, rejected = [], []
    for path in sorted(root.glob('*.jsonl.gz')):
        try:
            rows = []
            size = 0
            with gzip.open(path, 'rt', encoding='utf-8') as f:
                while line := f.readline(2_000_001):
                    size += len(line)
                    if len(line) > 2_000_000 or size > 64 * 1024 ** 2 or len(rows) >= 4098:
                        raise ValueError('Oversized episode')
                    rows.append(json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite JSON'))))
            if len(rows) < 3: raise ValueError('Missing trajectory or terminal result')
            start, *steps, end = rows
            if start.get('type') != 'start' or start.get('format') != 1 or not start.get('completeStart'):
                raise ValueError('Partial start')
            if start.get('contract') != manifest['contract']: raise ValueError('Contract mismatch')
            if start.get('source') != 'human' and not (allow_synthetic and start.get('source') == 'synthetic'):
                raise ValueError('Synthetic data excluded')
            if not isinstance(start.get('gameId'), str) or not start['gameId']: raise ValueError('Missing game identity')
            if end.get('type') != 'end' or end.get('complete') is not True or end.get('reasons'):
                raise ValueError('Incomplete or interrupted episode')
            if type(end.get('place')) is not int or not 1 <= end['place'] <= 8 or end.get('steps') != len(steps):
                raise ValueError('Invalid result/step count')
            previous, turn = count, 1
            for i, row in enumerate(steps):
                if row.get('type') != 'decision' or row.get('step') != i or row.get('episode') != start.get('episode'):
                    raise ValueError('Missing or duplicate decision')
                if row.get('previous') != previous or type(row.get('turn')) is not int or row['turn'] < turn:
                    raise ValueError('Broken sequence')
                legal = row.get('legal')
                if not isinstance(legal, list) or not legal or len(set(legal)) != len(legal) or any(type(a) is not int or not 0 <= a < count for a in legal):
                    raise ValueError('Invalid legal mask')
                if type(row.get('action')) is not int or row['action'] not in legal:
                    raise ValueError('Illegal action label')
                entities = row.get('entities')
                if not isinstance(entities, list) or len(entities) != entity_schema['count']:
                    raise ValueError('Invalid observation shape')
                for slot, entity in enumerate(entities):
                    if entity is None: continue
                    if type(entity.get('id')) is not int or not 1 <= entity['id'] <= len(entity_schema['ids']):
                        raise ValueError('Unknown entity identity')
                    zone, position = entity.get('zone'), entity.get('position')
                    if type(zone) is not int or not 0 <= zone < len(entity_schema['sizes']) or type(position) is not int or not 0 <= position < entity_schema['sizes'][zone] or entity_schema['offsets'][zone] + position != slot or not isinstance(entity.get('details'), dict):
                        raise ValueError('Invalid entity slot')
                previous, turn = row['action'], row['turn']
            if end.get('episode') != start.get('episode'): raise ValueError('Terminal identity mismatch')
            episodes.append(dict(start=start, steps=steps, end=end, file=path.name,
                                 sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        except (ValueError, KeyError, TypeError, OSError, EOFError) as error:
            rejected.append(dict(file=path.name, reason=str(error)))
    return manifest, episodes, rejected


def split_games(episodes, validation_fraction=.2):
    if not 0 < validation_fraction < 1: raise ValueError('Validation fraction must be between zero and one')
    games = sorted({e['start']['gameId'] for e in episodes}, key=lambda game: hashlib.sha256(game.encode()).digest())
    if len(games) < 2: raise ValueError('Need at least two complete games for separate training and validation')
    held_out = set(games[:min(len(games)-1, max(1, math.ceil(len(games)*validation_fraction)))])
    return ([e for e in episodes if e['start']['gameId'] not in held_out],
            [e for e in episodes if e['start']['gameId'] in held_out])
