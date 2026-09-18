import { createInterface } from 'node:readline';
import { evaluateBasic } from './basic-evaluation';
import { evaluateMinion } from '../src/minion-evaluation';
import { ENTITY_SCHEMA, IDS, type Entity } from './entities';

declare const LEDGER_IMPLEMENTATION_HASH: string;
const economy = ['cash', 'minionAssets', 'handPotential', 'futureIncome', 'freeRefresh', 'spellDiscount', 'tavernTier'] as const;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.command === 'close') process.exit(0);
    let result: unknown;
    if (message.command === 'meta') result = { version: 'minion-ledger-targets-v1', entitySchema: ENTITY_SCHEMA,
      economy, implementationHash: LEDGER_IMPLEMENTATION_HASH };
    else if (message.command === 'evaluate') {
      if (!Array.isArray(message.rows) || !message.rows.length || message.rows.length > 256) throw Error('Expected 1..256 observations');
      result = message.rows.map((entities: (Entity | null)[]) => {
        const score = evaluateBasic(entities);
        const cards = entities.map(e => {
          if (!e || ![1,2,4].includes(e.zone)) return null;
          const value = evaluateMinion(IDS[e.id-1], e.details);
          return value.minion ? value.score : null;
        });
        return { cards, economy: economy.map(key => score.components[key]), turn: entities[0]!.details.turn };
      });
    } else throw Error('Unknown ledger evaluation command');
    process.stdout.write(JSON.stringify({ ok: true, result })+'\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error) })+'\n'); }
});
