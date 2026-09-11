import test from "node:test";
import assert from "node:assert/strict";
import { act, createGame, makeMinion } from "./engine";
import { absorbArmor, gameRankingHealth } from "./ranking";

test("initial armor counts, spell armor cannot rebound ranking, and damage consumes added armor first", () => {
  let game = createGame("s14_lich", () => .37);
  game.health = 20; game.season!.armor = 2;
  assert.equal(gameRankingHealth(game), 22);
  const armor = makeMinion("s14_BG28_500"); game.hand = [armor];
  const result = act(game, { type: "cast", uid: armor.uid });
  assert.equal(result.error, undefined); game = result.state;
  assert.equal(game.season!.armor, 5);
  assert.equal(game.season!.spellArmor, 3);
  assert.equal(gameRankingHealth(game), 22);
  game.health -= absorbArmor(game.season!, 2);
  assert.equal(gameRankingHealth(game), 22);
  game.health -= absorbArmor(game.season!, 2);
  assert.equal(gameRankingHealth(game), 21);
  game.health -= absorbArmor(game.season!, 3);
  assert.equal(gameRankingHealth(game), 18);
  const refill = makeMinion("s14_BG28_500"); game.hand = [refill];
  game = act(game, { type: "cast", uid: refill.uid }).state;
  assert.equal(gameRankingHealth(game), 18);
  assert.equal(gameRankingHealth(JSON.parse(JSON.stringify(game))), 18);
});
