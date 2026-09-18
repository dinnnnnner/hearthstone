from __future__ import annotations
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]

class Simulator:
    """Training environment using an explicitly selected Rust or TypeScript backend."""
    def __init__(self, bundle=None, timeout=120, backend=None):
        self.native = None
        backend = backend or os.environ.get("TAVERN_RULES_BACKEND", "ts")
        if backend not in ("ts", "rust"):
            raise ValueError("TAVERN_RULES_BACKEND must be ts or rust")
        if backend == "rust":
            if bundle is not None:
                raise ValueError("A JavaScript bundle cannot be used with the Rust backend")
            from .native_rules import NativeSimulator
            self.native = NativeSimulator()
            self.meta = self.native.meta
            return
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
        if self.native is not None:
            return self.native.call(command, **kwargs)
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
        if getattr(self, "native", None) is not None:
            self.native.close()
            return
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
