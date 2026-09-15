import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoldPlanningBatch } from './gold-planning';
import { createSeason } from '../src/season/engine';
import { enableAIActionLimits } from '../src/ai-action-limits';
import { observeEntities } from './entities';
import { actionId } from './actions';

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
