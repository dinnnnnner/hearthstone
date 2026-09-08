import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  createGame,
  makeMinion,
  assertPool,
  type Game,
  type Action,
} from "../engine";
import { getDef, POOL_COPIES } from "../data";
import {
  SEASON_CARDS,
  SEASON_CATALOG,
  SEASON_SPELLS,
  SEASON_HEROES,
  PREFIX,
} from "./catalog";
import {
  seasonCombat,
  seasonTargets,
  giftTierRange,
  refreshCost,
  TRINKETS,
  eligibleGifts,
} from "./engine";
const rng = () => 0.23;
function seed(n: number) {
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}
function fixture(hero = "s14_lich") {
  const s = createGame(hero, seed(22));
  for (const d of SEASON_CARDS)
    if (s.pool[d.id] === undefined) {
      s.pool[d.id] = POOL_COPIES[d.tier];
      s.season!.initialPool[d.id] = POOL_COPIES[d.tier];
    }
  return s;
}
function add(
  s: Game,
  id: string,
  zone: "hand" | "board" | "shop" = "hand",
  golden = false,
) {
  const d = getDef(PREFIX + id);
  assert.ok(d, "Unknown card " + id);
  const pooled =
    getDef(PREFIX + id).kind !== "spell" && s.pool[PREFIX + id] !== undefined;
  const m = makeMinion(PREFIX + id, golden, pooled);
  if (pooled) s.pool[m.id] -= golden ? 3 : 1;
  s[zone].push(m);
  return m;
}
function apply(s: Game, a: Action) {
  const r = act(s, a, rng);
  assert.equal(r.error, undefined, JSON.stringify(a) + " " + r.error);
  assertPool(r.state);
  assert.ok(r.state.board.length <= 7);
  return r.state;
}
function next(s: Game) {
  return apply(apply(s, { type: "end" }), { type: "continue" });
}
test("pinned pool excludes retired and Duos cards, each lobby activates five races", () => {
  assert.equal(SEASON_CATALOG.length, 234);
  assert.equal(
    SEASON_CATALOG.find((d) => d.sourceId === "BG26_174")!.health,
    2,
  );
  assert.equal(
    SEASON_CATALOG.find((d) => d.sourceId === "BG36_509")!.attack,
    5,
  );
  const s = createGame("s14_lich", rng);
  assert.equal(s.season!.tribes.length, 5);
  assert.equal(new Set(s.season!.tribes).size, 5);
  assert.ok(s.shop.every((m) => m.id.startsWith(PREFIX)));
  assert.ok(
    Object.keys(s.pool).every((id) => SEASON_CARDS.some((d) => d.id === id)),
  );
  assertPool(s);
});
test("current heroes have authentic cost, health, and armor instead of classic values", () => {
  let s = fixture();
  assert.equal(s.health, 30);
  assert.equal(s.season!.armor, 14);
  const m = add(s, "BG25_001", "board");
  s = apply(s, { type: "power", target: m.uid });
  assert.equal(s.gold, 3);
  assert.ok(s.board[0].rebornNext);
  const george = SEASON_HEROES.find((h) => h.id === "s14_george")!;
  assert.equal(george.cost, 1);
  assert.equal(george.armor, 15);
  assert.equal(createGame("s14_patchwerk").health, 60);
});
test("current gold, freeze, and spell shelf survive a round transition", () => {
  let s = fixture();
  const ids = s.shop.map((m) => m.uid),
    spell = s.season!.spellShop[0].uid;
  s = apply(s, { type: "freeze" });
  s = next(s);
  assert.ok(ids.every((id) => s.shop.some((m) => m.uid === id)));
  assert.equal(s.season!.spellShop[0].uid, spell);
  assert.equal(s.gold, 4);
  assert.equal(s.frozen, false);
});
test("Nozdormu grants free refresh without spending gold", () => {
  let s = fixture("s14_nozdormu");
  assert.equal(refreshCost(s), 0);
  s = apply(s, { type: "refresh" });
  assert.equal(s.gold, 3);
  assert.equal(s.season!.freeRefresh, 0);
});
test("buy and cast Tavern spell uses cost and adds stats to an eligible target", () => {
  let s = fixture();
  const target = add(s, "BG25_001", "board");
  const spell = makeMinion(PREFIX + "BG28_897");
  s.season!.spellShop = [spell];
  s = apply(s, { type: "buySpell", uid: spell.uid });
  assert.equal(s.gold, 2);
  assert.equal(s.season!.spellShop.length, 0);
  s = apply(s, { type: "cast", uid: spell.uid, target: target.uid });
  assert.equal(s.board[0].attack, 4);
  assert.equal(s.board[0].health, 3);
  assert.equal(s.season!.spellsCast, 1);
  assert.equal(s.hand.length, 0);
});
test("spell cannot be cast on invalid targets or counted toward triples", () => {
  let s = fixture();
  const spell = add(s, "BG36_880");
  const rider = add(s, "BG25_001", "board");
  assert.match(
    act(s, { type: "cast", uid: spell.uid, target: rider.uid }).error!,
    /有效/,
  );
  add(s, "BG36_880");
  add(s, "BG36_880");
  s = apply(s, { type: "freeze" });
  assert.equal(s.triples, 0);
  assert.equal(s.hand.length, 3);
});
test("Activate enforces target, cost, and once-per-minion-per-turn rule", () => {
  let s = fixture();
  const guard = add(s, "BG36_345", "board"),
    target = add(s, "BG25_001", "board");
  assert.match(
    act(s, { type: "activate", uid: guard.uid, target: guard.uid }).error!,
    /目标/,
  );
  s = apply(s, { type: "activate", uid: guard.uid, target: target.uid });
  assert.equal(s.gold, 2);
  assert.equal(s.board[1].attack, 5);
  assert.equal(s.board[1].health, 4);
  assert.match(
    act(s, { type: "activate", uid: guard.uid, target: target.uid }).error!,
    /已经发动/,
  );
  s = next(s);
  assert.equal(s.board[0].activated, false);
});
test("Private Investigator uses the 36.4.2 two-gold payoff next turn", () => {
  let s = fixture();
  const m = add(s, "BG36_509", "board");
  s = apply(s, { type: "activate", uid: m.uid });
  assert.equal(s.season!.nextGold, 2);
  s = next(s);
  assert.equal(s.gold, 6);
});
test("Tyrael activates for one gold and fixes target stats to 50/50", () => {
  let s = fixture();
  const t = add(s, "BG36_356", "board"),
    r = add(s, "BG25_001", "board");
  s = apply(s, { type: "activate", uid: t.uid, target: r.uid });
  assert.equal(s.gold, 2);
  assert.equal(s.board[1].attack, 50);
  assert.equal(s.board[1].health, 50);
});
test("Dark Gift turn eligibility, tier progression, spending, and usage limits", () => {
  let s = fixture();
  assert.match(act(s, { type: "darkGift" }).error!, /第3回合/);
  s.turn = 3;
  s.gold = 10;
  s = apply(s, { type: "darkGift" });
  assert.equal(s.gold, 7);
  assert.equal(s.season!.giftsUsed, 1);
  assert.ok(s.discovery.length >= 1);
  assert.equal(
    new Set(s.discovery.map((m) => m.gift)).size,
    s.discovery.length,
  );
  assert.ok(
    s.discovery.every((m) => getDef(m.id).tier === 2 && !getDef(m.id).magnetic),
  );
  const m = s.discovery[0];
  s = apply(s, { type: "discover", uid: m.uid });
  assert.ok(s.hand.some((x) => x.gift));
  assert.match(act(s, { type: "darkGift" }).error!, /每回合/);
  s.season!.giftsUsed = 3;
  s.turn++;
  assert.match(act(s, { type: "darkGift" }).error!, /3次/);
  assert.deepEqual(giftTierRange(9), [4, 5, 6]);
  assert.deepEqual(giftTierRange(12), [5, 6]);
});
test("Dark Gifts honor Battlecry and poison restrictions", () => {
  const s = fixture();
  s.turn = 5;
  const c = makeMinion(PREFIX + "BG26_963");
  assert.ok(
    eligibleGifts(s, c).every((g) =>
      ["11", "18", "14", "10"].some((n) => g.id.endsWith("000t" + n)),
    ),
  );
  s.turn = 9;
  const venom = makeMinion(PREFIX + "BG33_318");
  assert.ok(!eligibleGifts(s, venom).some((g) => g.id.endsWith("000t69")));
});
test("a triple retains pool ownership and gives a tier-above reward on play", () => {
  let s = fixture();
  const a = add(s, "BG25_001", "board");
  a.attack += 4;
  add(s, "BG25_001");
  const c = add(s, "BG25_001", "shop");
  s = apply(s, { type: "buy", uid: c.uid });
  const g = s.hand.find((m) => m.golden)!;
  assert.equal(g.attack, 8);
  assert.equal(g.copies[g.id], 3);
  s.tier = 3;
  s = apply(s, { type: "play", uid: g.uid });
  assert.deepEqual(s.rewards, [4]);
  s = apply(s, { type: "reward" });
  assert.ok(s.discovery.every((m) => getDef(m.id).tier === 4));
  s = apply(s, { type: "discover", uid: s.discovery[0].uid });
  assertPool(s);
});
test("Magnetic merges keywords, abilities, and pool material ownership", () => {
  let s = fixture();
  const target = add(s, "BG29_611", "board"),
    module = add(s, "BG_BOT_911");
  s = apply(s, { type: "play", uid: module.uid, target: target.uid });
  assert.equal(s.board.length, 1);
  assert.equal(s.board[0].attack, 3);
  assert.ok(s.board[0].keywords.includes("嘲讽"));
  assert.equal(s.board[0].copies[module.id], 1);
  s = apply(s, { type: "sell", uid: target.uid });
  assertPool(s);
});
test("Spellcraft is generated on play and its stat buff expires next recruit turn", () => {
  let s = fixture();
  const n = add(s, "BG23_000"),
    r = add(s, "BG25_001", "board");
  s = apply(s, { type: "play", uid: n.uid });
  const spell = s.hand.find((m) => m.tempSpell)!;
  assert.ok(spell);
  s = apply(s, { type: "cast", uid: spell.uid, target: r.uid });
  assert.equal(s.board[0].attack, 4);
  s = next(s);
  assert.equal(s.board[0].attack, 2);
  assert.equal(s.hand.filter((m) => m.tempSpell).length, 1);
});
test("Soul Rewinder rewinds hero damage and buffs health using current values", () => {
  let s = fixture();
  const w = add(s, "BGS_004", "board"),
    r = add(s, "BG26_174", "board"),
    n = add(s, "BG35_150");
  s = apply(s, { type: "play", uid: n.uid });
  assert.equal(s.health, 30);
  assert.equal(s.season!.armor, 14);
  assert.equal(s.board.find((m) => m.uid === w.uid)!.attack, 3);
  assert.equal(s.board.find((m) => m.uid === r.uid)!.health, 4);
  assert.equal(s.season!.fodder, 3);
});
test("Fodder feeding does not invent shared pool copies", () => {
  let s = fixture();
  const d = add(s, "BGS_004", "board");
  s.season!.fodder = 3;
  s = apply(s, { type: "refresh" });
  assert.equal(s.season!.fodder, 2);
  assert.equal(s.board.find((m) => m.uid === d.uid)!.attack, 3);
  assertPool(s);
});
test("Titus stacks extra deathrattles, Rally generates resources, and combat preserves pool", () => {
  const s = fixture();
  const skull = add(s, "BG28_300", "board");
  add(s, "BG25_354", "board");
  add(s, "BG25_354", "board");
  const enemy = makeMinion(PREFIX + "BG36_356");
  enemy.attack = 200;
  enemy.health = 200;
  skull.health = 1;
  const b = seasonCombat(s, [enemy], 6, () => 0);
  assert.ok(
    b.frames.some(
      (f) =>
        f.allies.filter((m) => m.id === PREFIX + "BG_ICC_026t").length === 5,
    ),
  );
  assertPool(s);
  const r = fixture();
  add(r, "BG20_101", "board");
  seasonCombat(r, [makeMinion(PREFIX + "BG25_001")], 1, rng);
  assert.ok(r.hand.some((m) => m.id === PREFIX + "BG20_GEM"));
});
test("Venomous is consumed after an unshielded hit and cannot pierce Divine Shield", () => {
  const s = fixture();
  const v = add(s, "BGS_131", "board");
  v.health = 100;
  const e = makeMinion(PREFIX + "BG36_356");
  e.keywords = ["圣盾"];
  e.attack = 1;
  const b = seasonCombat(s, [e], 6, () => 0);
  const hit = b.frames.find((f) => f.attacker === v.uid)!;
  assert.equal(hit.enemies[0].health, 10);
  assert.ok(hit.allies[0].keywords.includes("烈毒"));
  assert.ok(
    b.frames.some(
      (f) =>
        f.enemies.some((m) => m.health <= 0) &&
        f.allies.some((m) => !m.keywords.includes("烈毒")),
    ),
  );
});
test("damage is absorbed by armor, early damage cap applies", () => {
  let s = fixture();
  s.opponents[0].board = [makeMinion(PREFIX + "BG36_356")];
  s = apply(s, { type: "end" });
  assert.equal(s.battle!.damage, 5);
  assert.equal(s.season!.armor, 9);
  assert.equal(s.health, 30);
});
test("trinkets offered at turns six/nine and gate recruit actions until selection", () => {
  let s = fixture();
  s.turn = 5;
  s = next(s);
  assert.equal(s.turn, 6);
  assert.equal(s.season!.trinketOffers.length, 4);
  assert.match(act(s, { type: "refresh" }).error!, /饰品/);
  const item = s.season!.trinketOffers[0];
  s = apply(s, { type: "buyTrinket", uid: item });
  assert.ok(s.season!.trinkets.includes(item));
  assert.equal(s.season!.trinketOffers.length, 0);
});
test("current trinket effects apply free buys and refresh discounts", () => {
  let s = fixture();
  s.season!.trinkets = ["BG36_MagicItem_202", "BG36_MagicItem_300"];
  const c = add(s, "BG20_100", "shop");
  s = apply(s, { type: "buy", uid: c.uid });
  assert.equal(s.gold, 3);
  s = apply(s, { type: "refresh" });
  assert.equal(s.upgrade, 4);
});
test("all declared generated cards have data and all playable tiers have candidates", () => {
  for (const d of SEASON_CARDS)
    for (const a of d.abilities || []) {
      if (a.id) assert.ok(getDef(PREFIX + a.id), `${d.id}: missing ${a.id}`);
      if (a.event === "spellcraft")
        assert.ok(getDef(PREFIX + d.sourceId + "t"));
    }
  for (let tier = 1; tier <= 6; tier++)
    assert.ok(SEASON_CARDS.some((d) => d.tier === tier));
  assert.ok(SEASON_SPELLS.length > 20);
  assert.ok(TRINKETS.length >= 8);
});
test("seeded current-season play stays valid across all eleven heroes", () => {
  for (const h of SEASON_HEROES) {
    const random = seed(812);
    let s = createGame(h.id, random);
    s.health = 2000;
    for (let step = 0; step < 140; step++) {
      let action: Action;
      if (s.phase === "over") break;
      if (s.phase === "combat") action = { type: "continue" };
      else if (s.discovery.length)
        action = { type: "discover", uid: s.discovery[0].uid };
      else if (s.season!.trinketOffers.length)
        action = { type: "buyTrinket", uid: s.season!.trinketOffers[0] };
      else if (s.rewards.length) action = { type: "reward" };
      else if (s.hand.length && s.board.length < 7) {
        const m = s.hand[0],
          event = getDef(m.id).kind === "spell" ? "cast" : "battlecry";
        const targets = seasonTargets(s, m, event);
        if (
          getDef(m.id).kind === "spell" &&
          (getDef(m.id).abilities || m.extraAbilities || []).some(
            (a) => a.target === "selected",
          ) &&
          !targets.length
        ) {
          action = { type: "end" };
        } else
          action = {
            type: getDef(m.id).kind === "spell" ? "cast" : "play",
            uid: m.uid,
            target: targets[0]?.uid,
          };
      } else if (s.gold >= s.upgrade && s.tier < 6)
        action = { type: "upgrade" };
      else if (
        s.gold >= 3 &&
        s.shop.length &&
        s.hand.length + s.rewards.length < 10
      )
        action = { type: "buy", uid: s.shop[0].uid };
      else if (s.board.length >= 7 && s.hand.length)
        action = { type: "sell", uid: s.board[0].uid };
      else action = { type: "end" };
      const result = act(s, action, random);
      assert.equal(
        result.error,
        undefined,
        `${h.id}, ${JSON.stringify(action)}: ${result.error}`,
      );
      s = result.state;
      assertPool(s);
      assert.ok(s.gold >= 0);
      assert.ok(s.board.length <= 7);
    }
  }
});

test("Tarecgosa retains each combat buff independently of intervening damage, doubled when golden", () => {
  for (const golden of [false, true]) {
    const s = fixture();
    const m = add(s, "BG21_015", "board", golden);
    m.health = 10;
    m.extraAbilities = [
      { event: "rally", op: "buff", health: 2, noScale: true },
    ];
    const e = makeMinion(PREFIX + "BG36_356");
    e.attack = 1;
    e.health = m.attack * 2 + 1;
    seasonCombat(s, [e], 1, () => 0);
    assert.equal(m.health, golden ? 18 : 14);
    assertPool(s);
  }
});
