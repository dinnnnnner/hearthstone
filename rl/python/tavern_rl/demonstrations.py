"""Read complete, versioned human episodes; split entire games before training."""
from __future__ import annotations
import gzip
import hashlib
import json
import math
from pathlib import Path


def continuous_prefix(steps, actions):
    """Stop before the first unrecorded action/automatic turn transition; never bridge a gap."""
    kept = []
    previous = len(actions)
    turn, counter = 1, 0
    for row in steps:
        if row.get('type') != 'decision' or row.get('step') != len(kept): break
        current = row.get('turn')
        if current != turn:
            if not kept or current != turn + 1 or actions[kept[-1]['action']]['type'] != 'end': break
            turn, counter = current, 0
        elif kept and actions[kept[-1]['action']]['type'] == 'end': break
        entities = row.get('entities')
        if not isinstance(entities, list) or not entities or not isinstance(entities[0], dict): break
        details = entities[0].get('details', {})
        if not isinstance(details, dict): break
        if type(details.get('decisions')) is not int or details['decisions'] != counter or details.get('turn') != turn: break
        if row.get('previous') != previous: break
        if type(row.get('action')) is not int or not 0 <= row['action'] < len(actions): break
        kept.append(row); previous = row['action']; counter += 1
    return kept


def continuous_segments(steps, actions):
    """Retain observed labels; reset recurrent context wherever history is unknown."""
    segments = []
    last = None
    for row in steps:
        details = row['entities'][0]['details']
        counter = details.get('decisions')
        if type(counter) is not int or counter < 0 or details.get('turn') != row['turn']:
            raise ValueError('Invalid decision counter for segment continuity')
        if last is None:
            if row['turn'] != 1 or counter != 0:
                raise ValueError('Missing initial context')
            connected = False
        elif row['turn'] == last['turn']:
            connected = counter == last['entities'][0]['details']['decisions'] + 1 and actions[last['action']]['type'] != 'end'
        else:
            connected = row['turn'] == last['turn'] + 1 and counter == 0 and actions[last['action']]['type'] == 'end'
        if not connected: segments.append([])
        # The initial-action token represents an explicit reset, not an inferred missing action.
        segments[-1].append(dict(row, previous=row['previous'] if connected else len(actions)))
        last = row
    return segments


def load_dataset(directory, allow_synthetic=False, allow_incomplete_prefix=False, allow_incomplete_segments=False):
    if allow_incomplete_prefix and allow_incomplete_segments:
        raise ValueError('Choose prefix or segment mode, not both')
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
            partial = end.get('complete') is not True or bool(end.get('reasons'))
            if end.get('type') != 'end' or partial and not (allow_incomplete_prefix or allow_incomplete_segments):
                raise ValueError('Incomplete or interrupted episode')
            if type(end.get('place')) is not int or not 1 <= end['place'] <= 8 or end.get('steps') != len(steps):
                raise ValueError('Invalid result/step count')
            selection = {'mode': 'complete_game', 'recordedSteps': len(steps)}
            if partial:
                if not end.get('reasons') or not set(end['reasons']) <= {'capture_gap', 'automatic_end'}:
                    raise ValueError('Prefix mode only accepts known capture/automatic-end gaps with a final result')
                if allow_incomplete_prefix:
                    steps = continuous_prefix(steps, schema['actions'])
                    if not steps: raise ValueError('No verified continuous prefix')
                    selection.update(mode='continuous_prefix', retainedSteps=len(steps), originalReasons=end['reasons'])
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
            segments = continuous_segments(steps, schema['actions']) if allow_incomplete_segments else [steps]
            if allow_incomplete_segments:
                selection.update(mode='continuous_segments', retainedSteps=len(steps), originalReasons=end['reasons'],
                                 context='Zero GRU memory and initial-action token at each segment start; missing history is not reconstructed',
                                 segments=[{'firstStep':s[0]['step'], 'lastStep':s[-1]['step'], 'steps':len(s)} for s in segments])
            episodes.append(dict(start=start, steps=steps, segments=segments, end=end, selection=selection, file=path.name,
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
