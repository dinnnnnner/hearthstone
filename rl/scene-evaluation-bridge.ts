import { createInterface } from 'node:readline';
import { evaluateScene, SCENE_VERSION } from './scene-evaluation';
declare const SCENE_SOURCE_HASH: string;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    const m = JSON.parse(line);
    if (m.command === 'close') process.exit(0);
    const result = m.command === 'meta' ? { version: SCENE_VERSION, sourceHash: SCENE_SOURCE_HASH } : m.command === 'evaluate'
      ? evaluateScene(m.game, m.opponents, m.seed, m.trials) : (() => { throw Error('Unknown scene command'); })();
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n'); }
});
