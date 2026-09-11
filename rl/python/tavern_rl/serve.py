"""Single-threaded loopback inference. Room/seat recurrent state stays in Node."""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import torch
from .model import make_model
from .features import prepare_entities


class Policy:
    def __init__(self, path):
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        saved = torch.load(path, map_location='cpu', weights_only=True)
        self.model = make_model(saved['model_spec']).eval()
        self.model.load_state_dict(saved['model'])
        self.metadata = saved['metadata']
        self.decisions = 0
        self.elapsed = 0.

    @torch.inference_mode()
    def predict(self, data):
        if data['contract'] != self.metadata['contract']:
            raise ValueError('Runtime rules/schema differ from exported inference artifact')
        rows = data['rows']
        if not isinstance(rows, list) or not 1 <= len(rows) <= 8:
            raise ValueError('Expected 1..8 decisions')
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
        dist, _, updated = self.model.act([prepare_entities(r['entities']) for r in rows], masks, memories, previous)
        if not torch.isfinite(updated).all() or not torch.isfinite(dist.probs).all():
            raise ValueError('Non-finite model output')
        actions = dist.sample().tolist()
        elapsed = (time.perf_counter() - start) * 1000
        self.decisions += len(rows)
        self.elapsed += elapsed
        return dict(rows=[dict(action=a, memory=m) for a, m in zip(actions, updated.tolist())], elapsedMs=elapsed)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model')
    parser.add_argument('--port', type=int, default=8790)
    args = parser.parse_args()
    policy = Policy(args.model)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, value):
            body = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path != '/health':
                return self.reply(404, {'error': 'Not found'})
            self.reply(200, dict(ok=True, **policy.metadata, decisions=policy.decisions,
                meanMs=policy.elapsed / max(1, policy.decisions)))

        def do_POST(self):
            if self.path != '/predict':
                return self.reply(404, {'error': 'Not found'})
            self.connection.settimeout(5)
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 2_000_000:
                    raise ValueError('Invalid request size')
                result = policy.predict(json.loads(self.rfile.read(size)))
                self.reply(200, result)
            except (ValueError, KeyError, TypeError, IndexError, RuntimeError) as e:
                self.reply(400, {'error': str(e)})

    print(json.dumps(dict(listen=f'127.0.0.1:{args.port}', **policy.metadata)), flush=True)
    HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
