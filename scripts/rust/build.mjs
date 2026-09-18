import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
execFileSync('node_modules/.bin/tsx',['scripts/rust/export-catalog.ts'],{stdio:'inherit'});
execFileSync('cargo',['build','--release','--manifest-path','native/Cargo.toml'],{stdio:'inherit'});
execFileSync('cargo',['build','--release','--manifest-path','native/Cargo.toml','-p','tavern-rules-ffi','--target','wasm32-unknown-unknown'],{stdio:'inherit'});
mkdirSync('public/rules',{recursive:true});
copyFileSync('native/target/wasm32-unknown-unknown/release/tavern_rules_ffi.wasm','public/rules/tavern_rules.wasm');
