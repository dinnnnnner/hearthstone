/** npx tsx scripts/audit-basic-openings.ts [output.json] */
import { readFileSync, writeFileSync } from 'node:fs';
import { compareRecruitLines, type RecruitLine } from '../rl/basic-evaluation';
import type { Entity } from '../rl/entities';

const fixture = JSON.parse(readFileSync(new URL('../rl/fixtures/basic-opening-cases.json', import.meta.url), 'utf8'));
const rows = fixture.cases.map((row: { seed: number; seat: number; hero: string; entities: (Entity | null)[]; lines: RecruitLine[] }) => {
  const result = compareRecruitLines(row.entities, row.lines);
  const sale = result.lines.find(line => line.name === 'sell')!;
  return { seed: row.seed, seat: row.seat, hero: row.hero, comparable: sale.comparable,
    saleDelta: sale.meanDelta, componentDelta: sale.componentDelta, ranking: result.ranking,
    beforeBoard: result.before.cards.filter(card => card.zone === 'board'),
    errors: sale.trials.filter(t => t.error).map(t => t.error) };
});
const comparable = rows.filter((r: { comparable: boolean }) => r.comparable);
const result = { sourceModelSha256: fixture.source_model_sha256, sourceIteration: fixture.source_iteration,
  cases: rows.length, comparable: comparable.length,
  saleScoresLower: comparable.filter((r: { saleDelta: number }) => r.saleDelta < 0).length,
  scope: 'Heuristic replay audit, not a complete-game strength evaluation.', rows };
const text = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2]) writeFileSync(process.argv[2], text);
else process.stdout.write(text);
