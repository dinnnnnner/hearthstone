import test from "node:test";
import assert from "node:assert/strict";
import { makeMinion, type Action, type Game } from "../engine";
import { getDef } from "../data";
import { ALL_TRIBES, GIFTS, SEASON_CARDS, SEASON_META } from "./catalog";
import { actSeason, assertSeasonPool, createSeason, tribe } from "./engine";
import rules from "./current-rules.json" with { type: "json" };

const fixture = () => createSeason("s14_lich", () => .37, { tribes: [...ALL_TRIBES] });
function step(s: Game, a: Action = { type: "freeze" }) {
  const result = actSeason(s, a, () => .37);
  assert.equal(result.error, undefined); assertSeasonPool(result.state);
  return result.state;
}
function gem(s: Game, target: string) {
  const card = makeMinion("s14_BG20_GEM"); s.hand.push(card);
  return step(s, { type: "cast", uid: card.uid, target });
}

test("preview pool enables announced September 22 content and enforces bans", () => {
  const s = fixture();
  assert.equal(s.season!.patch, "36.6.1-preview"); assert.equal(SEASON_META.build, rules.build);
  for (const id of rules.liveCardUpdates) assert.ok(SEASON_CARDS.some(c => c.sourceId === id));
  assert.ok(!SEASON_CARDS.some(c => c.sourceId === "BGS_121"));
  assert.ok(!GIFTS.some(g => g.id === "BG36_MidGameEffect_000t4"));
  assert.ok(GIFTS.length > 0);
  for (const id of ["BG36_110", "BG36_097"]) assert.ok(SEASON_CARDS.some(c => c.sourceId === id));
  assert.ok(!SEASON_CARDS.some(c => c.tribe === "纳迦"));
  assert.ok(!SEASON_CARDS.some(c => c.sourceId === "BG27_002"));
  assert.equal(getDef("s14_BG27_002").tribe, "畸变怪");
  assert.equal(getDef("s14_BGS_008").tier, 5);
  assert.equal(getDef("s14_BGS_034").tier, 2);
});

test("Holy Vanguard gains a reversible health-threshold aura without counting armor or stacking on repeated actions", () => {
  let s = fixture(); s.health = 16; s.season!.armor = 20;
  s.board = [makeMinion("s14_BG36_372")]; s = step(s);
  assert.deepEqual([s.board[0].attack, s.board[0].health], [5, 5]);
  s.health = 15; s = step(s); s = step(s);
  assert.deepEqual([s.board[0].attack, s.board[0].health], [20, 20]);
  s.board[0].attack += 3; s.board[0].health += 4;
  s.health = 16; s = step(s);
  assert.deepEqual([s.board[0].attack, s.board[0].health], [8, 9]);
});

test("Holy Vanguard triples remove the three normal auras and apply one golden aura on play", () => {
  let s = fixture(); s.health = 15;
  s.board = [makeMinion("s14_BG36_372"), makeMinion("s14_BG36_372")]; s = step(s);
  s.hand.push(makeMinion("s14_BG36_372")); s = step(s);
  const golden = s.hand.find(m => m.id === "s14_BG36_372")!;
  assert.ok(golden.golden); assert.deepEqual([golden.attack, golden.health], [10, 10]);
  s = step(s, { type: "play", uid: golden.uid });
  assert.deepEqual([s.board[0].attack, s.board[0].health], [40, 40]);
});

test("Roogug uses the current gem buff and excludes all copies of itself from targets", () => {
  for (const golden of [false, true]) {
    let s = fixture();
    s.board = [makeMinion("s14_BG28_583", golden), makeMinion("s14_BG28_583"), makeMinion("s14_BG25_001")];
    s.season!.buffs.gem = { attack: 2, health: 3 };
    const target = s.board[2], before = [target.attack, target.health];
    s = gem(s, s.board[0].uid);
    assert.deepEqual([s.board[1].attack, s.board[1].health], [4, 6]);
    const n = golden ? 2 : 1;
    assert.deepEqual([s.board[2].attack, s.board[2].health], [before[0] + 3 * n, before[1] + 4 * n]);
    assert.deepEqual(s.board[2].gems, { attack: 3 * n, health: 4 * n });
  }
});

test("Roogug with no different minion finishes without bouncing gems between copies", () => {
  let s = fixture(); s.board = [makeMinion("s14_BG28_583"), makeMinion("s14_BG28_583")];
  s = gem(s, s.board[0].uid);
  assert.deepEqual(s.board.map(m => [m.attack, m.health]), [[5, 7], [4, 6]]);
});

test("a neutral minion changed to All types receives Elemental scaling", () => {
  let s = fixture(); const m = makeMinion("s14_BG36_372"); m.extraTribes = ["全部"];
  s.board = [m]; s.season!.buffs.elementalGrant = { attack: 2, health: 3 };
  assert.ok(tribe(m, "元素")); s = gem(s, m.uid);
  assert.deepEqual([s.board[0].attack, s.board[0].health], [8, 9]);
});
