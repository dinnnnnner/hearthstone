import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const options = { entryPoints: ['rl/ledger-evaluation-bridge.ts'], bundle: true, platform: 'node',
  target: 'node20', format: 'cjs', write: false, metafile: true, logLevel: 'silent' };
const define = { 'import.meta.env.BASE_URL': '"/tavern/"', LEDGER_IMPLEMENTATION_HASH: '"pending"' };
const probe = await build({ ...options, define });
const hash = createHash('sha256');
for (const path of [...Object.keys(probe.metafile.inputs), 'scripts/build-ledger-evaluation.mjs'].sort())
  hash.update(path).update(await readFile(path));
const implementationHash = hash.digest('hex');
const result = await build({ ...options, define: { ...define, LEDGER_IMPLEMENTATION_HASH: JSON.stringify(implementationHash) } });
await mkdir('rl-dist', { recursive: true });
await writeFile('rl-dist/ledger-evaluation.cjs', result.outputFiles[0].contents);
console.log(JSON.stringify({ output: 'rl-dist/ledger-evaluation.cjs', implementationHash }));
