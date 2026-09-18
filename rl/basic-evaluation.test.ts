import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeason } from '../src/season/engine';
import { makeMinion } from '../src/engine';
import { enableAIActionLimits } from '../src/ai-action-limits';
import { observeEntities, OFFSETS, type Entity } from './entities';
import { actionId } from './actions';
import { compareRecruitLines, evaluateBasic } from './basic-evaluation';

function setup() {
  const state = createSeason('s14_patchwerk', () => .3);
  enableAIActionLimits(state);
  state.board = [makeMinion('s14_BG25_013')]; // 1/4, no end-of-turn effect
  state.hand = []; state.gold = 0;
  return state;
}
const entities = (s: ReturnType<typeof setup>): (Entity | null)[] => JSON.parse(JSON.stringify(observeEntities(s, 0, 64)));

test('selling the only 1/4 is an asset conversion during recruitment and a loss at close', () => {
  const s = setup(), before = entities(s), original = structuredClone(before);
  const result = compareRecruitLines(before, [{ name: 'keep', actions: [] }, { name: 'sell', actions: [actionId('sell', 0)] }]);
  const keep = result.lines[0], sell = result.lines[1];
  assert.deepEqual(result.ranking, ['keep', 'sell']);
  assert.equal(keep.meanDelta, 0); assert.ok(Math.abs(sell.meanDelta! + 6) < 1e-10);
  assert.equal(sell.componentDelta!.board, -5);
  assert.equal(sell.componentDelta!.minionAssets, -1);
  assert.equal(sell.componentDelta!.cash, 0);
  assert.equal(sell.trials[0].evaluation!.resources.expiringGold, 1);
  // Before ending, +1 cash exactly offsets the -1 ordinary sale principal.
  const after = structuredClone(before); after[OFFSETS[1]] = null; after[0]!.details.gold = 1;
  const delta = evaluateBasic(after).economy - evaluateBasic(before).economy;
  assert.equal(delta, 0);
  assert.deepEqual(before, original);
});

test('multi-step replacement can justify a sale even when the sale alone loses value', () => {
  const s = setup(); s.gold = 2;
  s.board = ['s14_BG25_013', 's14_BG25_001', 's14_BGS_119', 's14_BG36_921',
    's14_BG32_330', 's14_BG20_100', 's14_BG21_015'].map(id => {
    const m = makeMinion(id); m.attack = m.health = 1; m.keywords = []; return m;
  });
  const strong = makeMinion('s14_BG25_013'); strong.attack = strong.health = 12; s.shop = [strong];
  const result = compareRecruitLines(entities(s), [
    { name: 'keep', actions: [] }, { name: 'sell-only', actions: [actionId('sell', 0)] },
    { name: 'replace', actions: [actionId('sell', 0), actionId('buy', 0), actionId('play', 0)] },
  ]);
  assert.ok(result.lines.every(l => l.comparable), JSON.stringify(result.lines.map(l => l.trials.map(t => t.error))));
  assert.ok(result.lines[1].meanDelta! < 0);
  assert.ok(result.lines[2].meanDelta! > 0);
  assert.equal(result.ranking[0], 'replace');
});

test('hand minions keep sale principal while playing moves potential into actual board stats', () => {
  const s = setup(); s.hand = s.board; s.board = [];
  const before = evaluateBasic(entities(s));
  assert.equal(before.components.board, 0); assert.equal(before.components.handPotential, 1.25);
  assert.equal(before.resources.minionAssetUnits, 1);
  const result = compareRecruitLines(entities(s), [{ name: 'play', actions: [actionId('play', 0)] }]);
  assert.equal(result.lines[0].componentDelta!.minionAssets, 0);
  assert.ok(Math.abs(result.lines[0].meanDelta! - 3.75) < 1e-10);
});

test('income follows the next-turn cap; current gold expires rather than carrying over', () => {
  const s = setup(); s.turn = 8; s.gold = 9; s.season!.nextGold = 5;
  const a = evaluateBasic(entities(s), 'closed');
  assert.equal(a.resources.nextIncome, 10); assert.equal(a.resources.effectiveExtraIncome, 0);
  assert.equal(a.components.cash, 0); assert.equal(a.resources.expiringGold, 9);
  s.turn = 1; s.season!.nextGold = 2;
  assert.equal(evaluateBasic(entities(s)).resources.nextIncome, 6);
  s.season!.maxGold = 12;
  assert.equal(evaluateBasic(entities(s)).resources.nextIncome, 8);
});

test('keyword bonuses are visible and rebirth uses printed stats instead of acquired buffs', () => {
  const s = setup(); const plain = evaluateBasic(entities(s));
  s.board[0].keywords = ['圣盾', '风怒', '复生'];
  s.board[0].attack = 101; s.board[0].health = 104;
  const scored = evaluateBasic(entities(s));
  assert.equal(plain.board, 5);
  assert.equal(scored.cards[0].keywordBonus, 101 + 50.5 + 1);
});

test('spells receive no invented resale principal and weights can be overridden', () => {
  const s = setup(); s.hand = s.season!.spellShop.slice(0, 1);
  const a = evaluateBasic(entities(s));
  assert.equal(a.resources.minionAssetUnits, 1);
  assert.equal(a.cards.find(c => c.zone === 'hand')!.minionAssetUnits, 0);
  assert.equal(evaluateBasic(entities(s), 'recruit', { gold: 0 }).components.cash, 0);
  assert.throws(() => evaluateBasic(entities(s), 'recruit', { attack: NaN }), /weight/);
  const invalid = entities(s); invalid[1]!.details.attack = Infinity;
  assert.throws(() => evaluateBasic(invalid), /attack/);
});

test('illegal and unobservable continuations are reported and excluded from ranking', () => {
  const s = setup(); s.board = [];
  const input = entities(s);
  const result = compareRecruitLines(input, [{ name: 'invalid-sale', actions: [actionId('sell', 0)] }]);
  assert.equal(result.lines[0].comparable, false); assert.equal(result.lines[0].meanDelta, null);
  assert.deepEqual(result.ranking, []); assert.match(result.lines[0].trials[0].error!, /Illegal search action/);
  input[0]!.details.pendingDiscoveries = [{ kind: 'copy' }];
  const unsupported = compareRecruitLines(input, [{ name: 'end', actions: [] }]);
  assert.equal(unsupported.lines[0].comparable, false);
  assert.match(unsupported.lines[0].trials[0].error!, /Pending discovery/);
});

test('paired seeds are deterministic and unused opponent fields never change static score', () => {
  const input = entities(setup());
  const lines = [{ name: 'keep', actions: [] }];
  assert.deepEqual(compareRecruitLines(input, lines), compareRecruitLines(input, lines));
  const before = evaluateBasic(input);
  const opponent = input[OFFSETS[7]]!;
  opponent.details.health = 99999; opponent.details.secretBoard = 'not an input to scoring';
  assert.deepEqual(evaluateBasic(input), before);
  assert.throws(() => compareRecruitLines(input, lines, [1, 1]), /seeds/);
});
