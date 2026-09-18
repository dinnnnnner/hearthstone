"""Direct native Rust binding shared with the Node/browser Wasm core. No Node subprocess."""
from __future__ import annotations
import ctypes
import json
import os
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[3]
MAX_BYTES = 32 * 1024 * 1024


class NativeRules:
    def __init__(self, library=None):
        suffix = '.dylib' if sys.platform == 'darwin' else '.so'
        default = ROOT / 'native/target/release' / ('libtavern_rules_ffi' + suffix)
        self.path = Path(library or os.environ.get('TAVERN_RUST_LIBRARY', default)).resolve()
        if not self.path.is_file():
            raise FileNotFoundError(f'Build the Rust rules library first: npm run build:rust ({self.path})')
        self.library = ctypes.CDLL(str(self.path))
        self.library.tavern_abi_version.argtypes = []
        self.library.tavern_abi_version.restype = ctypes.c_uint32
        self.library.tavern_alloc.argtypes = [ctypes.c_size_t]
        self.library.tavern_alloc.restype = ctypes.c_void_p
        self.library.tavern_free.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        self.library.tavern_free.restype = None
        self.library.tavern_request.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        self.library.tavern_request.restype = ctypes.c_void_p
        if self.library.tavern_abi_version() != 1:
            raise RuntimeError('Unsupported Rust rules ABI')
        self.meta = self.call('meta')
        if self.meta.get('schema') != 'tavern-rust-kernel-v1' or self.meta.get('abi') != 1:
            raise RuntimeError('Incompatible Rust rules metadata')

    def require_full_engine(self):
        if not self.meta.get('fullEngineReady'):
            raise RuntimeError('RUST_ENGINE_INCOMPLETE: ' + ', '.join(self.meta.get('pending', [])))

    def call(self, command, **kwargs):
        payload = json.dumps(dict(kwargs, command=command), ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
        if not payload or len(payload) > MAX_BYTES:
            raise ValueError('Rust request exceeds 32 MiB')
        request = self.library.tavern_alloc(len(payload))
        if not request:
            raise MemoryError('Rust input allocation failed')
        response = None
        size = 0
        try:
            ctypes.memmove(request, payload, len(payload))
            response = self.library.tavern_request(request, len(payload))
            if not response:
                raise MemoryError('Rust response allocation failed')
            size = struct.unpack('<I', ctypes.string_at(response, 4))[0]
            if size > MAX_BYTES - 4:
                raise RuntimeError('Invalid Rust response buffer')
            result = json.loads(ctypes.string_at(response + 4, size))
            if not result.get('ok'):
                raise RuntimeError(result.get('error', 'Rust rule operation failed'))
            return result['result']
        finally:
            if response and size <= MAX_BYTES - 4:
                self.library.tavern_free(response, size + 4)
            self.library.tavern_free(request, len(payload))


class NativeSimulator:
    """A Rust-owned eight-seat environment with no JavaScript process or HTTP."""
    def __init__(self, library=None):
        self.rules = NativeRules(library)
        self.rules.require_full_engine()
        self.session = self.rules.call('envCreate')
        self.meta = self.rules.call('envMeta')

    def call(self, command, **kwargs):
        if self.session is None:
            raise RuntimeError('Simulator is closed')
        if command == 'meta':
            return self.meta
        commands = {'reset': 'envReset', 'step': 'envStep', 'snapshot': 'envSnapshot',
                    'restore': 'envRestore', 'replay': 'envReplay', 'view': 'envView'}
        if command not in commands:
            raise ValueError(f'Unknown training command: {command}')
        return self.rules.call(commands[command], session=self.session, **kwargs)

    def reset(self, seed, options=None):
        return self.call('reset', seed=int(seed), options=options or {})

    def step(self, action):
        return self.call('step', action=int(action))

    def close(self):
        if self.session is not None:
            self.rules.call('envClose', session=self.session)
            self.session = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
