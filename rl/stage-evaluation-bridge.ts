import { createInterface } from 'node:readline';
import { evaluateStage, STAGE_VERSION } from './stage-evaluation';
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    const m = JSON.parse(line);
    if (m.command === 'close') process.exit(0);
    const result = m.command === 'meta' ? { version: STAGE_VERSION } : m.command === 'evaluate'
      ? evaluateStage(m.snapshot, m.completedTurn, m.trials) : (() => { throw Error('Unknown stage command'); })();
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n'); }
});
