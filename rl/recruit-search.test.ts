import { test } from 'node:test';
import { enableAIActionLimits } from '../src/ai-action-limits';
import assert from 'node:assert/strict';
import { createSeason, actSeason, endEffects } from '../src/season/engine';
import { makeMinion } from '../src/engine';
import { withSimulation } from '../src/simulation';
import { observeEntities } from './entities';
import { actionId } from './actions';
import { gameFromObservation, RecruitSearchEnv } from './recruit-search';

const json = (v: unknown) => JSON.parse(JSON.stringify(v));
function setup(decisions = 0) {
  const s = createSeason('s14_patchwerk', () => .3);
  enableAIActionLimits(s);
  const entities = json(observeEntities(s, decisions, 64));
  return { s, entities, branch: new RecruitSearchEnv(entities, decisions) };
}

test('public reconstruction round-trips model input including own effects and two public scout rounds', () => {
  const { s } = setup(); s.turn = 5; s.seatIndex = 0;
  s.board = [makeMinion('s14_BG25_001')]; s.board[0].counters = { arbitraryEffect: 12 };
  s.board[0].remembered = [s.board[0].uid];
  s.season!.frozenMinions = [s.board[0].uid]; s.season!.heroMarks = { teron: s.board[0].uid };
  s.season!.delayed = [{ turn: 6, attack: 3, health: 5, amount: 1, uid: s.board[0].uid }];
  s.opponents.forEach((o, i) => { o.seatIndex = i + 1; });
  s.opponents[0].scouting = [{ turn: 4, warband: '4龙', battle: { opponent: s.opponents[1].name, result: 'win', damage: 6 } },
    { turn: 3, warband: '无种族' }, { turn: 2, warband: '7恶魔' }];
  const entities = json(observeEntities(s, 120, 64));
  assert.deepEqual(json(observeEntities(gameFromObservation(entities), 120, 64)), entities);
});

test('search can buy then play then end in the same recruit turn, without combat or opponent actions', () => {
  const { branch } = setup(); branch.reset(22);
  const turn = branch.state.turn, rivals = structuredClone(branch.state.opponents);
  branch.step(actionId('buy', 0));
  assert.equal(branch.state.hand.length, 1);
  branch.step(actionId('play', 0));
  assert.equal(branch.state.board.length, 1);
  const view = branch.step(actionId('end'));
  assert.equal(view.ended, true); assert.deepEqual(view.legal, []);
  assert.equal(branch.state.phase, 'recruit'); assert.equal(branch.state.battle, null);
  assert.equal(branch.state.turn, turn); assert.deepEqual(branch.state.opponents, rivals);
  assert.throws(() => branch.step(actionId('freeze')), /Illegal search action/);
});

test('search uses no real hidden pool, opposing board, old history or RNG, and never mutates its input', () => {
  const { s } = setup(); const original = json(observeEntities(s, 0, 64));
  s.pool = {}; s.season!.initialPool = {}; s.opponents[0].board = [makeMinion('s14_BG25_001')];
  s.opponents[0].board[0].attack = 999999;
  s.opponents[0].scouting = [{ turn: -10, warband: '7恶魔' }];
  assert.deepEqual(json(observeEntities(s, 0, 64)), original);
  const a = new RecruitSearchEnv(original, 0), b = new RecruitSearchEnv(json(observeEntities(s, 0, 64)), 0);
  assert.deepEqual(a.reset(23), b.reset(23));
  const before = structuredClone(original);
  assert.deepEqual(a.step(actionId('refresh')), b.step(actionId('refresh')));
  assert.deepEqual(original, before);
  const shops = new Set<string>();
  for (let seed = 1; seed < 8; seed++) { a.reset(seed); a.step(actionId('refresh')); shops.add(JSON.stringify(a.state.shop.map(m => m.id))); }
  assert.ok(shops.size > 1, 'chance outcomes are resampled between simulations');
});

test('there is no real 64/96-operation end mask in recruit search', () => {
  const { s } = setup(128); s.season!.freeRefresh = 150;
  const branch = new RecruitSearchEnv(json(observeEntities(s, 128, 64)), 128); branch.reset(3);
  for (let i = 0; i < 110; i++) {
    const view = branch.step(actionId('refresh'));
    assert.equal(view.ended, false); assert.ok(view.legal.includes(actionId('buy', 0)));
  }
  assert.equal(branch.state.turn, 1);
});

test('ordinary recruit effects match authoritative rules on the same reconstructed state', () => {
  const { branch } = setup(); branch.reset(3);
  const initial = structuredClone(branch.state);
  const buy = { type: 'buy' as const, uid: initial.shop[0].uid };
  const expected = actSeason(initial, buy, () => .5).state;
  branch.step(actionId('buy', 0));
  assert.deepEqual(json(observeEntities(branch.state, 1, 64)), json(observeEntities(expected, 1, 64)));
  let serial = 0;
  withSimulation({ uid: () => `end-${serial++}`, recordLogs: false, recordFrames: false }, () => endEffects(expected, () => .5));
  branch.step(actionId('end'));
  assert.deepEqual(json(observeEntities(branch.state, 2, 64)), json(observeEntities(expected, 2, 64)));
});

test('unreconstructable future discoveries and private opposing powers are explicit fallback boundaries', () => {
  const { entities } = setup(); entities[0].details.pendingDiscoveries = [{ kind: 'copy' }];
  assert.throws(() => gameFromObservation(entities), /Pending discovery/);
  const scabbs = createSeason('s14_scabbs', () => .3);
  assert.throws(() => gameFromObservation(json(observeEntities(scabbs, 0, 64))), /unknown opposing warband/);
});

test('search restores remaining allowances and inverse moves, and each branch spends only its own quota', () => {
  let { s } = setup();
  s.board = ['s14_BG25_001', 's14_BG20_100', 's14_BG21_015'].map(id => makeMinion(id));
  s.gold = 2;
  s = actSeason(s, { type: 'move', uid: s.board[0].uid, to: 2 }).state;
  const input = json(observeEntities(s, 2, 64)), before = structuredClone(input);
  const branch = new RecruitSearchEnv(input, 2);
  const root = branch.reset(10);
  assert.deepEqual(json(root.entities), input);
  assert.ok(!root.legal.includes(actionId('move', 2, 0, 0)));
  const child = branch.step(actionId('freeze'));
  assert.ok(!child.legal.includes(actionId('freeze')));
  const closing = child.entities[0]!.details.aiActionLimits as any;
  assert.equal(closing.version, 2); assert.equal(closing.freezeRemaining, 0);
  assert.equal(closing.moveRemaining, 5); assert.equal(closing.freezeClosing, true);
  assert.deepEqual(child.legal, [actionId('end')]);
  const restored = new RecruitSearchEnv(json(child.entities), 3);
  assert.deepEqual(restored.reset(12), { ...child, steps: 0 });
  assert.throws(() => branch.step(actionId('freeze')), /Illegal search action/);
  assert.deepEqual(branch.reset(11), root);
  assert.deepEqual(input, before);
  input[0].details.aiActionLimits.freezeRemaining = 3;
  assert.throws(() => new RecruitSearchEnv(input, 2), /Invalid AI action/);
});
