from __future__ import annotations
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]

class Simulator:
    """One isolated Node process; communication is stdin/stdout, never HTTP."""
    def __init__(self, bundle=None, timeout=120):
        self.bundle = Path(bundle or os.environ.get("TAVERN_RL_BUNDLE", ROOT / "rl-dist/bridge.cjs")).resolve()
        if not self.bundle.is_file():
            raise FileNotFoundError(f"Build the simulator first: npm run build:rl ({self.bundle})")
        self.timeout = timeout
        self.stderr = tempfile.TemporaryFile(mode="w+b")
        self.process = subprocess.Popen(["node", str(self.bundle)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, bufsize=0)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.pending = bytearray()
        try:
            self.meta = self.call("meta")
        except BaseException:
            self.close()
            raise

    def call(self, command, **kwargs):
        if self.process.poll() is not None:
            raise RuntimeError("Simulator exited unexpectedly")
        payload = json.dumps({"command": command, **kwargs}, separators=(",", ":")).encode() + b"\n"
        # FileIO writes may be partial for larger restore requests.
        view = memoryview(payload)
        while view:
            written = self.process.stdin.write(view)
            if not written:
                raise RuntimeError("Simulator stdin closed")
            view = view[written:]
        while b"\n" not in self.pending:
            if not self.selector.select(self.timeout):
                self.process.kill()
                raise TimeoutError("Simulator timed out; process stopped")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                self.stderr.seek(0)
                raise RuntimeError("Simulator EOF: " + self.stderr.read().decode(errors="replace")[-2000:])
            self.pending.extend(chunk)
        line, _, rest = self.pending.partition(b"\n")
        self.pending = bytearray(rest)
        response = json.loads(line)
        if not response["ok"]:
            raise RuntimeError(response["error"])
        return response["result"]

    def reset(self, seed, options=None):
        return self.call("reset", seed=int(seed), options=options or {})

    def step(self, action):
        return self.call("step", action=int(action))

    def close(self):
        if hasattr(self, "process"):
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            if self.process.stdout:
                self.process.stdout.close()
        if hasattr(self, "selector"):
            self.selector.close()
        if hasattr(self, "stderr"):
            self.stderr.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
