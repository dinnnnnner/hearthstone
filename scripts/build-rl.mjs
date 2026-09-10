import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const hash = createHash('sha256');
async function walk(dir) {
  for (const name of (await readdir(dir, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path = `${dir}/${name.name}`;
    if (name.isDirectory()) { if (name.name !== 'runs' && name.name !== '__pycache__') await walk(path); }
    else if (/\.(ts|json)$/.test(path) && !path.endsWith('.test.ts')) hash.update(path).update(await readFile(path));
  }
}
for (const dir of ['src', 'server', 'rl']) await walk(dir);
for (const path of ['docs/rules-coverage.json', 'scripts/build-rl.mjs']) hash.update(path).update(await readFile(path));
const sourceHash = hash.digest('hex');
await mkdir('rl-dist', { recursive: true });
await build({ entryPoints: ['rl/bridge.ts'], outfile: 'rl-dist/bridge.cjs', bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': '"/tavern/"', RL_SOURCE_HASH: JSON.stringify(sourceHash) }, logLevel: 'info' });
await writeFile('rl-dist/build.json', JSON.stringify({ sourceHash, commit: execFileSync('git', ['rev-parse','HEAD'], { encoding:'utf8' }).trim() }, null, 2));
