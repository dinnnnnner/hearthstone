"""Single-threaded loopback inference. Room/seat recurrent state stays in Node."""
import argparse
import json
import time
import gzip
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import torch
from .model import make_model
from .features import prepare_entities


def decode_request(body, encoding='identity'):
    if encoding == 'gzip':
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        body = decoder.decompress(body, 2_000_001)
        if len(body) > 2_000_000 or not decoder.eof or decoder.unused_data:
            raise ValueError('Invalid or oversized compressed request')
    elif encoding != 'identity':
        raise ValueError('Unsupported content encoding')
    return json.loads(body)


class Policy:
    def __init__(self, path, search_bundle=None, search_config=None):
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        saved = torch.load(path, map_location='cpu', weights_only=True)
        self.model = make_model(saved['model_spec']).eval()
        self.model.load_state_dict(saved['model'])
        self.metadata = saved['metadata']
        self.decisions = 0
        self.elapsed = 0.
        self.search = None
        if search_bundle:
            from .recruit_search import SearchPolicy, SearchConfig, VERSION
            config = search_config or SearchConfig()
            self.search = SearchPolicy(self.model, self.metadata, search_bundle, config)
            self.metadata = {**self.metadata, 'search': dict(version=VERSION, **vars(config))}
        self.search_runs = 0
        self.search_fallbacks = 0

    @torch.inference_mode()
    def predict(self, data):
        if data['contract'] != self.metadata['contract']:
            raise ValueError('Runtime rules/schema differ from exported inference artifact')
        if data.get('checkpointSha256', self.metadata['checkpointSha256']) != self.metadata['checkpointSha256']:
            raise ValueError('Requested model checkpoint differs from serving artifact')
        use_search = data.get('search', False)
        if type(use_search) is not bool or use_search and not self.search:
            raise ValueError('Requested search is unavailable')
        search_ms = data.get('searchTimeMs')
        if search_ms is not None and (type(search_ms) is not int or not 0 <= search_ms <= 3000):
            raise ValueError('Invalid search time budget')
        run_search = use_search and search_ms != 0
        rows = data['rows']
        if not isinstance(rows, list) or not 1 <= len(rows) <= 8:
            raise ValueError('Expected 1..8 decisions')
        if use_search and len(rows) != 1:
            raise ValueError('Search requests must contain one decision')
        masks = torch.zeros(len(rows), self.model.action_size, dtype=torch.bool)
        for i, row in enumerate(rows):
            legal = row['legal']
            if not legal or any(type(k) is not int or not 0 <= k < self.model.action_size for k in legal):
                raise ValueError('Invalid legal action list')
            if len(row['entities']) != self.model.schema['count']:
                raise ValueError('Invalid entity count')
            masks[i, legal] = True
        memories = torch.tensor([r['memory'] for r in rows], dtype=torch.float32)
        previous = torch.tensor([r['previous'] for r in rows], dtype=torch.long)
        if memories.shape != (len(rows), self.model.hidden) or not torch.isfinite(memories).all():
            raise ValueError('Invalid recurrent memory')
        if not ((previous >= 0) & (previous <= self.model.action_size)).all():
            raise ValueError('Invalid previous action')
        start = time.perf_counter()
        dist, values, updated = self.model.act([prepare_entities(r['entities']) for r in rows], masks, memories, previous, with_value=run_search)
        if not torch.isfinite(updated).all() or not torch.isfinite(dist.probs).all():
            raise ValueError('Non-finite model output')
        actions = dist.sample().tolist()
        reports = [None] * len(rows)
        if use_search:
            from .recruit_search import Evaluation
            for i, row in enumerate(rows):
                if run_search:
                    root = Evaluation({a: float(dist.probs[i, a]) for a in row['legal']}, float(values[i]), updated[i].tolist())
                    action, reports[i] = self.search.predict(row, root, search_ms)
                else:
                    from .recruit_search import VERSION
                    action, reports[i] = None, dict(version=VERSION, simulations=0, fallback='Recruit deadline reserve; direct policy')
                self.search_runs += 1
                if action is not None:
                    actions[i] = action
                else:
                    self.search_fallbacks += 1
                if 'actions' in reports[i]:
                    reports[i]['actions'] = reports[i]['actions'][:8]
        elapsed = (time.perf_counter() - start) * 1000
        self.decisions += len(rows)
        self.elapsed += elapsed
        return dict(rows=[dict(action=a, memory=m, **({'search': report} if report is not None else {}))
                          for a, m, report in zip(actions, updated.tolist(), reports)], elapsedMs=elapsed)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model')
    parser.add_argument('--port', type=int, default=8790)
    parser.add_argument('--search-bundle', help='Own-turn search simulator for 64, 256 and 1024-layer models')
    parser.add_argument('--search-ms', type=int, default=1000)
    parser.add_argument('--search-simulations', type=int, default=32)
    args = parser.parse_args()
    from .recruit_search import SearchConfig
    policy = Policy(args.model, args.search_bundle, SearchConfig(time_ms=args.search_ms, simulations=args.search_simulations))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, value):
            body = json.dumps(value, allow_nan=False).encode()
            compressed = 'gzip' in self.headers.get('Accept-Encoding', '') and len(body) > 1024
            if compressed:
                body = gzip.compress(body)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            if compressed:
                self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path != '/health':
                return self.reply(404, {'error': 'Not found'})
            self.reply(200, dict(ok=True, **policy.metadata, decisions=policy.decisions,
                searchRuns=policy.search_runs, searchFallbacks=policy.search_fallbacks,
                meanMs=policy.elapsed / max(1, policy.decisions)))

        def do_POST(self):
            if self.path != '/predict':
                return self.reply(404, {'error': 'Not found'})
            self.connection.settimeout(5)
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 2_000_000:
                    raise ValueError('Invalid request size')
                result = policy.predict(decode_request(self.rfile.read(size), self.headers.get('Content-Encoding', 'identity')))
                self.reply(200, result)
            except (ValueError, KeyError, TypeError, IndexError, RuntimeError, zlib.error) as e:
                self.reply(400, {'error': str(e)})

    print(json.dumps(dict(listen=f'127.0.0.1:{args.port}', **policy.metadata)), flush=True)
    try:
        HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
    finally:
        if policy.search:
            policy.search.close()


if __name__ == '__main__':
    main()
