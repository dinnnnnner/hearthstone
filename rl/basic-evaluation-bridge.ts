import { createInterface } from 'node:readline';
import { evaluateBasic, DEFAULT_WEIGHTS, BASIC_EVALUATION_VERSION } from './basic-evaluation';
import { ENTITY_SCHEMA } from './entities';

declare const BASIC_IMPLEMENTATION_HASH: string;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.command === 'close') process.exit(0);
    let result: unknown;
    if (message.command === 'meta') result = { version: BASIC_EVALUATION_VERSION, entitySchema: ENTITY_SCHEMA,
      weights: DEFAULT_WEIGHTS, implementationHash: BASIC_IMPLEMENTATION_HASH };
    else if (message.command === 'evaluate') {
      if (!Array.isArray(message.rows) || message.rows.length < 1 || message.rows.length > 256)
        throw Error('Expected 1..256 public observations');
      result = message.rows.map((entities: Parameters<typeof evaluateBasic>[0]) => {
        const score = evaluateBasic(entities, 'recruit', message.weights);
        return { total: score.total, board: score.board, economy: score.economy };
      });
    } else throw Error('Unknown basic evaluation command');
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n'); }
});
