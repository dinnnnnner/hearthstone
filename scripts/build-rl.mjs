import { build, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const settings = { platform: 'node', target: 'node20', format: 'cjs',
  tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } } };
const options = { ...settings, entryPoints: ['rl/bridge.ts'], bundle: true, write: false, metafile: true, logLevel: 'silent' };
const definitions = (source, rules, legacy) => ({
  'import.meta.env.BASE_URL': '"/tavern/"', RL_SOURCE_HASH: JSON.stringify(source),
  RL_RULES_HASH: JSON.stringify(rules), RL_LEGACY_V2_COMPATIBLE: JSON.stringify(legacy),
});
const probe = await build({ ...options, define: definitions('probe', 'probe', false) });
const inputs = Object.keys(probe.metafile.inputs).sort();
const inputHashes = {};
const content = new Map();
for (const path of inputs) {
  const bytes = await readFile(path); content.set(path, bytes);
  inputHashes[path] = createHash('sha256').update(bytes).digest('hex');
}
const digest = (paths) => {
  const hash = createHash('sha256').update(JSON.stringify(settings));
  for (const path of paths) hash.update(path).update(content.get(path));
  return hash.digest('hex');
};
// Only the bundle's real dependencies count. UI, audio, fixtures and Python do not.
const rulesInputs = inputs.filter(p => !p.startsWith('rl/'));
const rulesHash = digest(rulesInputs);
const sourceHash = createHash('sha256').update(digest(inputs)).update(esbuildVersion)
  .update(await readFile('scripts/build-rl.mjs')).digest('hex');

// Frozen v2 baselines may be compared only while rules, action mapping, old input
// projection and gameplay scheduling match the already-validated source revision.
function gameplay(text) {
  const file = ts.createSourceFile('environment.ts', text, ts.ScriptTarget.Latest, true);
  const parts = [];
  for (const statement of file.statements) {
    if (ts.isClassDeclaration(statement)) {
      parts.push(statement.members.filter(member => member.name?.getText(file) !== 'view').map(m => m.getText(file)).join('\n'));
    }
  }
  return parts.join('\n');
}
let legacyCompatible = false;
try {
  legacyCompatible = [...rulesInputs, 'rl/actions.ts', 'rl/observation.ts'].every(path => {
    const previous = execFileSync('git', ['show', `686fb73:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    return previous.equals(content.get(path));
  }) && gameplay(execFileSync('git', ['show', '686fb73:rl/environment.ts'], { encoding: 'utf8' })) === gameplay((await readFile('rl/environment.ts')).toString());
} catch { /* A source archive without git history simply cannot import v2 baselines. */ }
const output = await build({ ...options, define: definitions(sourceHash, rulesHash, legacyCompatible) });
await mkdir('rl-dist', { recursive: true });
await writeFile('rl-dist/bridge.cjs', output.outputFiles[0].contents);
await writeFile('rl-dist/build.json', JSON.stringify({ schema: 2, sourceHash, rulesHash, legacyV2Compatible: legacyCompatible,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), esbuild: esbuildVersion, inputs: inputHashes }, null, 2));
console.log(JSON.stringify({ sourceHash, rulesHash, legacyV2Compatible: legacyCompatible, dependencies: inputs.length }));
