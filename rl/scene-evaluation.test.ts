import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelfPlayEnv } from './environment';
import { makeMinion } from '../src/engine';
import { evaluateScene } from './scene-evaluation';
function fixture() {
  const env = new SelfPlayEnv(); env.reset(71);
  const own = env.room.seats[0].game!, enemy = env.room.seats[1].game!;
  for (const s of [own, enemy]) {
    s.board = []; s.season!.powers = []; s.season!.trinkets = []; s.season!.armor = 0;
    s.season!.combatEffects = {}; s.turn = 8; s.health = 30;
  }
  return { env, own, enemy };
}
test('combat labels distinguish boards without rank predictions or mutating the game', () => {
  const { env, own, enemy } = fixture();
  const m = makeMinion('s14_BG25_001'); m.attack = 100; m.health = 100;
  enemy.board = [m]; const before = env.snapshot();
  const weak = evaluateScene(own, [enemy], 1, 4);
  assert.deepEqual(weak.target.slice(0, 3), [0, 1, 0]); assert.ok(weak.meanDamageTaken! > 0);
  assert.deepEqual(env.snapshot(), before); assert.deepEqual(weak, evaluateScene(own, [enemy], 1, 4));
  own.board = [structuredClone(m)]; own.board[0].uid = 'own-strong'; own.board[0].attack = 1000; own.board[0].health = 1000;
  const strong = evaluateScene(own, [enemy], 1, 4);
  assert.deepEqual(strong.target.slice(0, 3), [1, 0, 0]); assert.ok(strong.meanDamageDealt! > 0);
});
test('damage protection and actual armor determine elimination labels', () => {
  const { own, enemy } = fixture(); own.turn = 1; own.health = 1;
  enemy.tier = 6; enemy.board = Array.from({ length: 7 }, () => makeMinion('s14_BG25_001'));
  const exposed = evaluateScene(own, [enemy], 3, 4);
  assert.equal(exposed.meanDamageTaken, 5); assert.equal(exposed.target[5], 1);
  own.season!.armor = 5;
  const armored = evaluateScene(own, [enemy], 3, 4);
  assert.equal(armored.meanDamageTaken, 5); assert.equal(armored.target[5], 0);
  assert.equal(own.season!.armor, 5);
});
test('ties and dead states have explicit labels; invalid budgets are rejected', () => {
  const { own, enemy } = fixture();
  assert.deepEqual(evaluateScene(own, [enemy], 4, 2).target, [0, 0, 1, 0, 0, 0]);
  own.health = 0; assert.deepEqual(evaluateScene(own, [enemy], 4, 2).target, [0, 1, 0, 0, 0, 1]);
  assert.throws(() => evaluateScene(own, [], 4, 2)); assert.throws(() => evaluateScene(own, [enemy], 4, 3));
});
