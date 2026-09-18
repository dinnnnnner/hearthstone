/** An explicit heuristic baseline. Scores are neither gold prices nor win probabilities. */
import { evaluateMinion, DEFAULT_WEIGHTS, type BasicWeights } from '../src/minion-evaluation';
export { DEFAULT_WEIGHTS, type BasicWeights } from '../src/minion-evaluation';
import { ACTIONS, actionId } from './actions';
import { ENTITY_SCHEMA, IDS, OFFSETS, SIZES, type Entity } from './entities';
import { RecruitSearchEnv } from './recruit-search';

export const BASIC_EVALUATION_VERSION = 'board-economy-v1';
type Input = readonly (Entity | null)[];
type Phase = 'recruit' | 'closed';

function finite(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw Error(`Invalid nonnegative ${name}`);
  return value;
}

function weightsFor(overrides: Partial<BasicWeights>): BasicWeights {
  for (const key of Object.keys(overrides))
    if (!(key in DEFAULT_WEIGHTS)) throw Error(`Unknown evaluation weight: ${key}`);
  const weights = { ...DEFAULT_WEIGHTS, ...overrides };
  for (const [key, value] of Object.entries(weights)) finite(value, `weight ${key}`);
  return weights;
}

function validate(entities: Input) {
  if (entities.length !== ENTITY_SCHEMA.count || !entities[0]) throw Error('Invalid evaluation entity count');
  for (const [slot, entity] of entities.entries()) if (entity && (
    !Number.isInteger(entity.id) || !IDS[entity.id - 1] || !Number.isInteger(entity.zone) ||
    entity.zone < 0 || entity.zone >= SIZES.length || !Number.isInteger(entity.position) ||
    entity.position < 0 || entity.position >= SIZES[entity.zone] ||
    OFFSETS[entity.zone] + entity.position !== slot)) throw Error('Invalid evaluation entity slot');
}

export function evaluateBasic(entities: Input, phase: Phase = 'recruit', overrides: Partial<BasicWeights> = {}) {
  validate(entities);
  if (phase !== 'recruit' && phase !== 'closed') throw Error('Unknown evaluation phase');
  const w = weightsFor(overrides), global = entities[0]!.details;
  const turn = finite(global.turn, 'turn'), tier = finite(global.tier, 'tier');
  if (!Number.isInteger(turn) || turn < 1 || !Number.isInteger(tier) || tier < 1 || tier > 6)
    throw Error('Invalid evaluation turn/tier');
  const gold = finite(global.gold, 'gold'), maxGold = finite(global.maxGold, 'gold cap', 10);
  if (maxGold < 10) throw Error('Unsupported gold cap below ten');
  const nextGold = finite(global.nextGold, 'next gold', 0);
  const freeRefresh = finite(global.freeRefresh, 'free refreshes', 0);
  const spellDiscount = finite(global.spellDiscount, 'spell discount', 0);
  const limitations = new Set<string>();
  const cards = entities.filter((e): e is Entity => !!e && (e.zone === 1 || e.zone === 4)).map(e => {
    const id = IDS[e.id - 1], d = e.details;
    const scored = evaluateMinion(id, d, w);
    const { minion, attack, health, keywords, body: baseBody, keywordBonus, unpricedAbilities } = scored;
    const inBoard = e.zone === 1;
    if (unpricedAbilities.length) limitations.add('Card abilities have no static price; recruit effects are applied by the simulator when comparing lines. Combat triggers and synergies remain unpriced.');
    if (keywords.some(k => ['剧毒', '烈毒', '潜行', '嘲讽'].includes(k)))
      limitations.add('Poison, venom, stealth and taunt depend on the opponent and positioning; no fixed bonus is assigned.');
    if (!minion) limitations.add('Spells have no resale credit or arbitrary purchase-price valuation. Their effects count when actually cast.');
    if (d.expires || d.tempSpell || d.lockedUntil)
      limitations.add('Expiring and locked cards need longer-horizon evaluation; hand potential is only a heuristic.');
    return { ...scored, id, name: scored.name, zone: inBoard ? 'board' : 'hand', position: e.position,
      attack, health, keywords, body: baseBody, keywordBonus,
      boardScore: minion && inBoard ? baseBody + keywordBonus : 0,
      handPotential: minion && !inBoard ? (baseBody + keywordBonus) * w.handPotential : 0,
      // Ordinary sale principal only. Special sell effects are counted after simulation,
      // not pre-credited and then credited again when the sale executes.
      minionAssetUnits: minion ? 1 : 0, unpricedAbilities };
  });
  const sum = (key: 'boardScore' | 'handPotential' | 'minionAssetUnits') => cards.reduce((n, c) => n + c[key], 0);
  const ordinaryNextIncome = Math.min(maxGold, Math.min(10, turn + 3) + maxGold - 10);
  const nextIncome = Math.min(maxGold, ordinaryNextIncome + nextGold);
  // Current gold is overwritten by advanceRecruit. Closed-turn leaves never retain it.
  const usableGold = phase === 'closed' ? 0 : gold;
  const components = {
    board: sum('boardScore'), handPotential: sum('handPotential'),
    cash: usableGold * w.gold, minionAssets: sum('minionAssetUnits') * w.minionAsset,
    futureIncome: nextIncome * w.nextIncome,
    freeRefresh: Math.min(3, freeRefresh) * w.freeRefresh,
    spellDiscount: Math.min(3, spellDiscount) * w.spellDiscount,
    tavernTier: (tier - 1) * w.tier,
  };
  const board = components.board;
  const economy = components.cash + components.minionAssets + components.futureIncome +
    components.freeRefresh + components.spellDiscount + components.tavernTier + components.handPotential;
  limitations.add('Weights are hand-set baseline points, not learned gold equivalents, combat odds or expected placements.');
  limitations.add('Next income excludes start-of-turn triggers. Refresh/discount credits are capped heuristics; tavern tier has a fixed opportunity bonus.');
  const heroHealth = global.health;
  if (typeof heroHealth !== 'number' || !Number.isFinite(heroHealth)) throw Error('Invalid hero health');
  return { version: BASIC_EVALUATION_VERSION, phase, alive: heroHealth > 0,
    total: board + economy, board, economy, components, weights: w, cards,
    resources: { gold, usableGold, expiringGold: gold - usableGold, minionAssetUnits: sum('minionAssetUnits'),
      nextIncome, effectiveExtraIncome: nextIncome - ordinaryNextIncome, maxGold, freeRefresh, spellDiscount, tier,
      heroHealth, armor: finite(global.armor, 'armor', 0) }, limitations: [...limitations] };
}

export type BasicEvaluation = ReturnType<typeof evaluateBasic>;
export type RecruitLine = { name: string; actions: number[] };
export function compareRecruitLines(entities: Input, lines: RecruitLine[], seeds = [101, 202, 303, 404],
  overrides: Partial<BasicWeights> = {}) {
  validate(entities);
  if (!lines.length || lines.length > 64 || !seeds.length || seeds.length > 32 ||
    new Set(seeds).size !== seeds.length || seeds.some(s => !Number.isInteger(s) || s < 0 || s > 0xffffffff))
    throw Error('Invalid line count or paired seeds');
  for (const line of lines) if (!line.name || line.actions.length > 64 ||
    line.actions.some(a => !Number.isInteger(a) || !ACTIONS[a])) throw Error('Invalid recruit line');
  const weights = weightsFor(overrides);
  const before = evaluateBasic(entities, 'recruit', weights);
  const decisions = finite(entities[0]!.details.decisions, 'decisions', 0);
  const budget = finite(entities[0]!.details.budget, 'budget', 64);
  const run = (line: RecruitLine, seed: number) => {
    try {
      const env = new RecruitSearchEnv(structuredClone([...entities]), decisions, budget);
      let view = env.reset(seed);
      const actions = [...line.actions];
      if (actions.at(-1) !== actionId('end')) actions.push(actionId('end'));
      for (const action of actions) view = env.step(action);
      if (!view.ended) throw Error('Line did not finish recruitment');
      return { seed, actions, evaluation: evaluateBasic(view.entities, 'closed', weights) };
    } catch (error) {
      return { seed, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const baseline = seeds.map(seed => run({ name: 'end-now', actions: [] }, seed));
  const rows = lines.map(line => {
    const trials = seeds.map(seed => run(line, seed));
    const comparable = trials.every(t => t.evaluation) && baseline.every(t => t.evaluation);
    if (!comparable) return { name: line.name, trials, comparable, meanDelta: null, componentDelta: null, alive: false };
    const componentDelta = Object.fromEntries(Object.keys(before.components).map(key => [key,
      trials.reduce((sum, t, i) => sum + t.evaluation!.components[key as keyof typeof before.components] -
        baseline[i].evaluation!.components[key as keyof typeof before.components], 0) / trials.length]));
    const deltas = trials.map((t, i) => t.evaluation!.total - baseline[i].evaluation!.total);
    return { name: line.name, trials, comparable, meanDelta: deltas.reduce((a, b) => a + b, 0) / trials.length,
      componentDelta, alive: trials.every(t => t.evaluation!.alive) };
  });
  const ranking = rows.filter(r => r.comparable).sort((a, b) => Number(b.alive) - Number(a.alive) || b.meanDelta! - a.meanDelta!);
  return { version: BASIC_EVALUATION_VERSION, before, baseline, seeds, lines: rows,
    ranking: ranking.map(r => r.name), scope: 'Paired own-turn simulations from public observations; every comparable line includes end effects. No combat or final-placement estimate.' };
}
