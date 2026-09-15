import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeason, actSeason, advanceRecruit } from './season/engine';
import { makeMinion, type Action } from './engine';
import { enableAIActionLimits, publicAIActionLimits, aiFreezeOffers } from './ai-action-limits';
import { candidates, actionId } from '../rl/actions';
import { observeEntities } from '../rl/entities';

function setup(ai = true) {
  const s = createSeason('s14_patchwerk', () => .3);
  s.board = ['s14_BG25_001', 's14_BG20_100', 's14_BG21_015'].map(id => makeMinion(id));
  if (ai) enableAIActionLimits(s);
  return s;
}

test('freeze is an optional closing commitment for unaffordable cards, never a spend/reorder loop', () => {
  let s = setup(); s.gold = 2;
  const before = structuredClone(s), result = actSeason(s, { type: 'freeze' });
  assert.equal(result.error, undefined); assert.deepEqual(s, before);
  s = result.state;
  assert.equal(s.frozen, true);
  assert.equal(publicAIActionLimits(s)!.freezeRemaining, 0);
  assert.equal(publicAIActionLimits(s)!.freezeClosing, true);
  assert.deepEqual([...candidates(s).keys()], [actionId('end')]);
  for (const a of [{ type: 'freeze' }, { type: 'refresh' }, { type: 'upgrade' },
    { type: 'buy', uid: s.shop[0].uid }, { type: 'move', uid: s.board[0].uid, to: 1 }] as Action[])
    assert.ok(actSeason(s, a).error);
  advanceRecruit(s, () => .3);
  assert.equal(publicAIActionLimits(s)!.freezeRemaining, 1);
  assert.equal(publicAIActionLimits(s)!.freezeClosing, false);
  assert.ok(candidates(s).has(actionId('refresh')));
});

test('freeze eligibility uses actual prices, free offers and health-paid spells; cancellation remains available', () => {
  const s = setup(); s.season!.spellShop = [];
  assert.ok(actSeason(s, { type: 'freeze' }).error); // All visible minions cost 3, gold is 3.
  s.hand = Array.from({ length: 10 }, () => makeMinion('s14_BG25_001'));
  assert.ok(actSeason(s, { type: 'freeze' }).error); // Full hand alone is not a gold shortage.
  s.gold = 2;
  assert.equal(aiFreezeOffers(s).shop.length, s.shop.length);
  s.season!.powers = ['s14_sindragosa']; // Actual minion price is 2.
  assert.deepEqual(aiFreezeOffers(s), { shop: [], spellShop: [] });
  s.shop = []; s.season!.spellShop = [makeMinion('s14_BG28_571')]; s.gold = 0;
  assert.deepEqual(aiFreezeOffers(s), { shop: [], spellShop: [] });
  s.season!.spellShop = [makeMinion('s14_BG28_897')];
  assert.deepEqual(aiFreezeOffers(s).spellShop, [0]);
  s.season!.spellDiscount = 100;
  assert.deepEqual(aiFreezeOffers(s).spellShop, []);
  assert.ok(actSeason(s, { type: 'freeze' }).error);
  s.frozen = true;
  const cancelled = actSeason(s, { type: 'freeze' });
  assert.equal(cancelled.error, undefined); assert.equal(cancelled.state.frozen, false);
  assert.deepEqual([...candidates(cancelled.state).keys()], [0]);
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
  s = actSeason(s, { type: 'refresh' }, () => .3).state;
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
  assert.deepEqual(input, { version: 2, freezeRemaining: 1, moveRemaining: 5, undoOrder: [2, 0, 1],
    freezeClosing: false, freezeOffers: aiFreezeOffers(s) });
  assert.deepEqual(publicAIActionLimits(JSON.parse(JSON.stringify(s))), input);
  for (const m of s.board) assert.ok(!JSON.stringify(input).includes(m.uid));
  let human = setup(false);
  for (let i = 0; i < 10; i++) {
    const result = actSeason(human, { type: 'freeze' });
    assert.equal(result.error, undefined); human = result.state;
  }
  assert.equal(publicAIActionLimits(human), undefined);
});
