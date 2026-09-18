import { assetUrl } from '../paths';
import { RustKernel } from './rust-kernel';
export async function loadRustRules(url=assetUrl('rules/tavern_rules.wasm')) {
  const response=await fetch(url);
  if(!response.ok)throw Error(`Rust rules download failed: ${response.status}`);
  return new RustKernel(await response.arrayBuffer());
}
