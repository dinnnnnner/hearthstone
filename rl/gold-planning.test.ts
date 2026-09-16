import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoldPlanningBatch } from './gold-planning';
import { createSeason } from '../src/season/engine';
import { enableAIActionLimits } from '../src/ai-action-limits';
import { observeEntities } from './entities';
import { actionId } from './actions';
import { makeMinion } from '../src/engine';

test('gold planning branches keep independent public states and identical sampled seeds', () => {
  const game = createSeason('s14_patchwerk', () => .3); enableAIActionLimits(game);
  const root = { entities: observeEntities(game, 0, 64), decisions: 0, budget: 64 };
  const before = structuredClone(root);
  const batch = new GoldPlanningBatch([root], [{ root: 0, seed: 9 }, { root: 0, seed: 9 }]);
  const initial = batch.views(); assert.deepEqual(initial[0], initial[1]);
  batch.step([{ index: 0, action: actionId('buy', 0) }]);
  assert.equal(batch.views()[0]!.gold, 0); assert.equal(batch.views()[1]!.gold, 3);
  assert.deepEqual(batch.views()[1], initial[1]); assert.deepEqual(root, before);
  const end = batch.step([{ index: 1, action: 0 }])[0];
  assert.equal(end.ended, true); assert.equal(end.turn, 1);
  assert.throws(() => batch.step([{ index: 1, action: 0 }]), /Illegal/);
});

test('planning validates request bounds and rejects duplicate branch updates', () => {
  assert.throws(() => new GoldPlanningBatch([], [{ root: 0, seed: 1 }]), /Invalid/);
  assert.throws(() => new GoldPlanningBatch([], Array.from({ length: 97 }, () => ({ root: 0, seed: 1 }))), /size/);
  const batch = new GoldPlanningBatch([], []);
  assert.throws(() => batch.step([{ index: -1, action: 0 }]), /Invalid/);
  assert.throws(() => batch.step([{ index: 0, action: 0 }, { index: 0, action: 0 }]), /Invalid/);
});

for (const [gold, next] of [[2, 'buy'], [0, 'refresh'], [4, 'upgrade']] as const) {
  test(`planning can sell for the missing coin before ${next}`, () => {
    const game = createSeason('s14_patchwerk', () => .3); enableAIActionLimits(game);
    game.gold = gold; game.upgrade = 5;
    game.board = [makeMinion('s14_BG25_001')];
    const root = { entities: observeEntities(game, 0, 64), decisions: 0, budget: 64 };
    const before = structuredClone(root);
    const batch = new GoldPlanningBatch([root], [{ root: 0, seed: 9 }, { root: 0, seed: 9 }]);
    const spend = next === 'buy' ? actionId('buy', 0) : actionId(next);
    assert.ok(!batch.views()[0]!.legal.includes(spend));
    const sold = batch.step([{ index: 0, action: actionId('sell', 0) }])[0];
    assert.equal(sold.gold, gold + 1); assert.ok(sold.legal.includes(spend));
    assert.ok(!sold.legal.includes(actionId('sell', 0)));
    const spent = batch.step([{ index: 0, action: spend }])[0];
    assert.equal(spent.gold, 0);
    assert.equal(batch.views()[1]!.gold, gold); assert.deepEqual(root, before);
    if (next === 'buy') {
      const played = batch.step([{ index: 0, action: actionId('play', 0) }])[0];
      assert.ok(played.legal.includes(actionId('sell', 0)));
    }
    assert.equal(batch.step([{ index: 0, action: 0 }])[0].ended, true);
  });
}

test('only random transitions expand: sell once, refresh twelve times, preserve spent gold and board', () => {
  const game = createSeason('s14_patchwerk', () => .3); enableAIActionLimits(game);
  game.gold = 0; game.board = [makeMinion('s14_BG25_001')];
  const root = { entities: observeEntities(game, 0, 64), decisions: 0, budget: 64 };
  const seeds = Array.from({ length: 12 }, (_, i) => 100 + i);
  const batch = new GoldPlanningBatch([root], [{ root: 0, seed: 9 }]);
  const sold = batch.expand([{ index: 0, action: actionId('sell', 0), seeds }]);
  assert.equal(sold.length, 1); assert.equal(sold[0].sampled, false); assert.equal(sold[0].view.gold, 1);
  const refreshed = batch.expand([{ index: 0, action: actionId('refresh'), seeds }]);
  assert.equal(refreshed.length, 12); assert.ok(refreshed.every(r => r.sampled && r.view.gold === 0));
  assert.ok(refreshed.every(r => !r.view.legal.includes(actionId('sell', 0))));
  assert.ok(new Set(refreshed.map(r => JSON.stringify(r.view.entities))).size > 1);
  const ended = batch.expand(refreshed.map(r => ({ index: r.index, action: 0 })));
  assert.equal(ended.length, 12); assert.ok(ended.every(r => r.view.ended && !r.sampled));
  assert.throws(() => batch.expand([{ index: 0, action: 0, seeds: [1] }]), /Invalid/);
});

test('later refreshes sample along twelve scenarios without expanding twelve squared', () => {
  const game = createSeason('s14_patchwerk', () => .3); enableAIActionLimits(game);
  game.gold = 2;
  const root = { entities: observeEntities(game, 0, 64), decisions: 0, budget: 64 };
  const batch = new GoldPlanningBatch([root], [{ root: 0, seed: 9 }]);
  const seeds = Array.from({ length: 12 }, (_, i) => i);
  const first = batch.expand([{ index: 0, action: actionId('refresh'), seeds }]);
  assert.equal(first.length, 12);
  const second = batch.expand(first.map(r => ({ index: r.index, action: actionId('refresh') })));
  assert.equal(second.length, 12); assert.ok(second.every(r => r.view.gold === 0 && !r.sampled));
});
