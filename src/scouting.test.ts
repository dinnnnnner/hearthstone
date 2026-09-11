import test from "node:test";
import assert from "node:assert/strict";
import { createGame, makeMinion, act } from "./engine";
import { recordScoutRound, previousScoutRounds, warbandLabel, type ScoutRound } from "./scouting";

test("warband labels count tribes and report ties, dual tribes, neutral and empty boards", () => {
  const mech = () => makeMinion("s14_BG29_611"), demon = () => makeMinion("s14_BGS_004");
  assert.equal(warbandLabel([mech(), mech(), mech(), demon()]), "3机械");
  assert.equal(warbandLabel([mech(), mech(), demon(), demon()]), "混合");
  assert.equal(warbandLabel([]), "空场");
  assert.equal(warbandLabel([makeMinion("s14_BGS_012")]), "无种族");
  assert.equal(warbandLabel([makeMinion("s14_BG27_080")]), "混合");
  assert.equal(warbandLabel([makeMinion("s14_BG27_080"), mech()]), "2机械");
  assert.equal(warbandLabel([makeMinion("s14_BG36_764")]), "混合");
  assert.equal(warbandLabel([makeMinion("s14_BG36_764"), mech()]), "2机械");
});
test("scouting retains two previous rounds while excluding the currently resolving combat", () => {
  const holder: { scouting?: ScoutRound[] } = {};
  for (let turn = 1; turn <= 4; turn++) recordScoutRound(holder, { turn, warband: "3机械" });
  assert.deepEqual(holder.scouting!.map(r => r.turn), [4, 3, 2]);
  assert.deepEqual(previousScoutRounds(holder.scouting, 4).map(r => r.turn), [3, 2]);
  assert.deepEqual(previousScoutRounds(undefined, 1), []);
  recordScoutRound(holder, { turn: 4, warband: "混合" });
  assert.equal(holder.scouting!.length, 3);
  assert.equal(holder.scouting![0].warband, "混合");
});
test("practice records mirrored results for the player and every AI pairing", () => {
  const s = createGame("s14_lich", () => .37);
  const result = act(s, { type: "end" }, () => .37);
  assert.equal(result.error, undefined);
  const game = result.state, rival = game.opponents[game.nextOpponent];
  assert.equal(rival.scouting![0].battle!.damage, game.battle!.damage);
  assert.equal(rival.scouting![0].battle!.opponent, "你");
  assert.equal(rival.scouting![0].battle!.result, game.battle!.result === "win" ? "loss" : game.battle!.result === "loss" ? "win" : "tie");
  for (const bot of game.opponents.filter(o => o !== rival)) {
    const battle = bot.scouting![0].battle!;
    const other = game.opponents.find(o => o.name === battle.opponent)!;
    assert.ok(other && other !== rival && other !== bot);
    assert.equal(other.scouting![0].battle!.opponent, bot.name);
    assert.equal(other.scouting![0].battle!.damage, battle.damage);
  }
});
