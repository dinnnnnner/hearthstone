import { readFileSync } from 'node:fs';
import { RustKernel } from '../src/rules/rust-kernel';
export function loadServerRustRules(path:string) {
  const bytes=readFileSync(path);
  return new RustKernel(Uint8Array.from(bytes));
}

let configured: RustKernel | undefined;
/** Explicit selection never silently falls back after a Rust load or rule failure. */
export function loadConfiguredRustRules(): RustKernel | undefined {
  const backend = process.env.TAVERN_RULES_BACKEND || 'ts';
  if (backend === 'ts') return undefined;
  if (backend !== 'rust') throw Error('TAVERN_RULES_BACKEND must be ts or rust');
  if (!configured) {
    configured = loadServerRustRules(process.env.TAVERN_RUST_WASM || 'public/rules/tavern_rules.wasm');
    configured.requireFullEngine();
  }
  return configured;
}
