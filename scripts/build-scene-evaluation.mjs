import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const training = JSON.parse(await readFile('rl-dist/build.json', 'utf8'));
const result = await build({ entryPoints: ['rl/scene-evaluation-bridge.ts'], bundle: true, platform: 'node', target: 'node20',
  format: 'cjs', write: false, metafile: true, define: { 'import.meta.env.BASE_URL': '"/tavern/"',
    SCENE_SOURCE_HASH: JSON.stringify(training.sourceHash) }, logLevel: 'silent' });
const inputs = {};
for (const path of Object.keys(result.metafile.inputs).sort()) {
  const digest = createHash('sha256').update(await readFile(path)).digest('hex'); inputs[path] = digest;
  if (!path.startsWith('rl/') && training.inputs[path] !== digest)
    throw Error(`Scene evaluator differs from training game rules: ${path}`);
}
await writeFile('rl-dist/scene-evaluation.cjs', result.outputFiles[0].contents);
await writeFile('rl-dist/scene-evaluation.json', JSON.stringify({ version: 'combat-benchmark-v1', sourceHash: training.sourceHash,
  rulesHash: training.rulesHash, inputs }, null, 2) + '\n');
console.log(JSON.stringify({ version: 'combat-benchmark-v1', sourceHash: training.sourceHash, rulesHash: training.rulesHash }));
