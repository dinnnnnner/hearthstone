import test from "node:test";
import assert from "node:assert/strict";
import { act, assertPool, createGame, makeMinion, type Game } from "./engine";

const rng = () => 0.37;
function fixture(season: boolean) {
  const s = createGame(season ? "s14_lich" : "lich", rng);
  s.health = 100;
  for (const [i, o] of s.opponents.entries()) {
    o.health = 30; o.armor = 0;
    o.board = Array.from({ length: 7 }, () => {
      const m = makeMinion(season ? "s14_BG25_001" : "cat-token");
      m.attack = i < 4 ? 100 : 0; m.health = i < 4 ? 1000 : 1; m.keywords = [];
      return m;
    });
  }
  return s;
}
function step(s: Game, type: "end" | "continue") {
  const result = act(s, { type }, rng);
  assert.equal(result.error, undefined);
  assertPool(result.state);
  return result.state;
}

for (const season of [false, true]) test(`${season ? "season" : "classic"} practice settles AI damage, elimination and pool returns once`, () => {
  let s = fixture(season);
  const loser = s.opponents[6];
  loser.health = 1; loser.armor = 2; loser.spellArmor = 1;
  const pooled = makeMinion(s.shop[0].id, false, true);
  pooled.attack = 0; pooled.health = 1; pooled.keywords = [];
  loser.board[0] = pooled; s.pool[pooled.id]--;
  const oldPool = s.pool[pooled.id], before = structuredClone(s);
  s = step(s, "end");
  assert.deepEqual(before.opponents[6].board, loser.board, "input state is unchanged");
  assert.ok(s.opponents[6].health <= 0);
  assert.deepEqual(s.opponents[6].board, []);
  assert.equal(s.pool[pooled.id], oldPool + 1);
  assert.equal(s.opponents[6].scouting![0].battle!.opponent, s.opponents[1].name);
  assert.equal(s.opponents[1].scouting![0].battle!.result, "win");
  assert.equal(s.opponents[1].health, 30);
  assert.equal(s.opponents[4].health, season ? 25 : 22);
  assert.equal(s.opponents[5].health, season ? 25 : 22);
  if (season) {
    assert.equal(s.opponents[6].armor, 0);
    assert.equal(s.opponents[6].spellArmor, 0);
    assert.equal(s.opponents[6].health, -2);
  }
  assert.ok(s.practiceGhost!.board.every(m => !Object.keys(m.copies).length));
  const health = s.opponents.map(o => o.health);
  s = step(s, "continue");
  assert.deepEqual(s.opponents.map(o => o.health), health, "continue must not apply damage again");
  assert.equal(s.opponents[s.nextOpponent].health > 0, true);
  const restored = JSON.parse(JSON.stringify(s)) as Game;
  assert.deepEqual(JSON.parse(JSON.stringify(step(restored, "end"))), JSON.parse(JSON.stringify(step(s, "end"))));
});

test("an unmatched practice bot fights the saved ghost and can be eliminated", () => {
  let s = fixture(true);
  for (const o of s.opponents.slice(2)) { o.health = 0; o.board = []; }
  s.opponents[1].board.forEach(m => { m.attack = 0; m.health = 1; });
  s.opponents[1].health = 1;
  const ghost = makeMinion("s14_BG36_356"); ghost.attack = 100; ghost.health = 1000;
  s.practiceGhost = { name: "旧对手", hero: s.opponents[2].hero, health: 0, tier: 6, board: [ghost] };
  s = step(s, "end");
  const battle = s.opponents[1].scouting![0].battle!;
  assert.equal(battle.opponent, "幽灵阵容");
  assert.equal(battle.result, "loss");
  assert.equal(battle.damage, 12);
  assert.equal(s.opponents[1].health, -11);
  assert.equal(s.opponents[0].scouting![0].battle!.opponent, "你");
  assert.equal(s.opponents[2].scouting, undefined);
});
