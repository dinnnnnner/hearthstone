import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeason, actSeason, advanceRecruit } from './season/engine';
import { makeMinion, type Action } from './engine';
import { enableAIActionLimits, publicAIActionLimits } from './ai-action-limits';
import { candidates, actionId } from '../rl/actions';
import { observeEntities } from '../rl/entities';

function setup(ai = true) {
  const s = createSeason('s14_patchwerk', () => .3);
  s.board = ['s14_BG25_001', 's14_BG20_100', 's14_BG21_015'].map(id => makeMinion(id));
  if (ai) enableAIActionLimits(s);
  return s;
}

test('two freeze toggles share one per-turn allowance; other actions never refill it', () => {
  let s = setup();
  for (const remaining of [1, 0]) {
    const before = structuredClone(s);
    const result = actSeason(s, { type: 'freeze' });
    assert.equal(result.error, undefined); assert.deepEqual(s, before);
    s = result.state; assert.equal(publicAIActionLimits(s)!.freezeRemaining, remaining);
  }
  assert.equal(s.frozen, false);
  assert.ok(actSeason(s, { type: 'freeze' }).error);
  assert.ok(!candidates(s).has(actionId('freeze')));
  s = actSeason(s, { type: 'refresh' }, () => .3).state;
  assert.equal(publicAIActionLimits(s)!.freezeRemaining, 0);
  s.gold = 100;
  s = actSeason(s, { type: 'buy', uid: s.shop[0].uid }, () => .3).state;
  assert.equal(publicAIActionLimits(s)!.freezeRemaining, 0);
  assert.ok(candidates(s).has(actionId('end')));
  advanceRecruit(s, () => .3);
  assert.deepEqual(publicAIActionLimits(s), { version: 1, freezeRemaining: 2, moveRemaining: 6 });
  assert.ok(candidates(s).has(actionId('freeze')));
});

test('insertion moves count once; six moves are allowed, immediate inverse and no-op are masked', () => {
  let s = setup();
  const original = s.board.map(m => m.uid), first = s.board[0].uid;
  s = actSeason(s, { type: 'move', uid: first, to: 2 }).state;
  assert.deepEqual(s.board.map(m => m.uid), [original[1], original[2], original[0]]);
  assert.ok(actSeason(s, { type: 'move', uid: first, to: 0 }).error);
  assert.ok(!candidates(s).has(actionId('move', 2, 0, 0)));
  assert.ok(actSeason(s, { type: 'move', uid: first, to: 2 }).error);
  for (let n = 1; n < 6; n++) {
    const result = actSeason(s, { type: 'move', uid: s.board[0].uid, to: 2 });
    assert.equal(result.error, undefined); s = result.state;
  }
  assert.equal(publicAIActionLimits(s)!.moveRemaining, 0);
  assert.ok([...candidates(s).values()].every(a => a.type !== 'move'));
  const before = structuredClone(s);
  assert.ok(actSeason(s, { type: 'move', uid: s.board[0].uid, to: 2 }).error);
  assert.deepEqual(s, before);
});

test('inverse detection compares the whole order even if a different minion reverses the move', () => {
  let s = setup(); s.board.pop();
  const moved = s.board[0].uid;
  s = actSeason(s, { type: 'move', uid: moved, to: 1 }).state;
  assert.ok(actSeason(s, { type: 'move', uid: s.board[0].uid, to: 1 }).error);
  // A successful intervening action ends the immediate-undo restriction, not the quota.
  s = actSeason(s, { type: 'freeze' }).state;
  assert.equal(actSeason(s, { type: 'move', uid: moved, to: 0 }).error, undefined);
  assert.equal(publicAIActionLimits(s)!.moveRemaining, 5);
});

test('failed moves and legal-action probes spend nothing; playing at a position is not moving', () => {
  let s = setup(); s.hand = [makeMinion('s14_BG25_001')];
  const before = structuredClone(s);
  for (const a of [{ type: 'move', uid: 'missing', to: 1 }, { type: 'move', uid: s.board[0].uid, to: NaN }] as Action[])
    assert.ok(actSeason(s, a).error);
  candidates(s); observeEntities(s, 0, 64);
  assert.deepEqual(s, before);
  s = actSeason(s, { type: 'play', uid: s.hand[0].uid, position: 1 }).state;
  assert.equal(publicAIActionLimits(s)!.moveRemaining, 6);
});

test('public allowance round-trips persistence without exposing instance IDs; humans remain unrestricted', () => {
  let s = setup(); s = actSeason(s, { type: 'move', uid: s.board[0].uid, to: 2 }).state;
  const input = observeEntities(s, 1, 64)[0]!.details.aiActionLimits;
  assert.deepEqual(input, { version: 1, freezeRemaining: 2, moveRemaining: 5, undoOrder: [2, 0, 1] });
  assert.deepEqual(publicAIActionLimits(JSON.parse(JSON.stringify(s))), input);
  for (const m of s.board) assert.ok(!JSON.stringify(input).includes(m.uid));
  let human = setup(false);
  for (let i = 0; i < 10; i++) {
    const result = actSeason(human, { type: 'freeze' });
    assert.equal(result.error, undefined); human = result.state;
  }
  assert.equal(publicAIActionLimits(human), undefined);
});
