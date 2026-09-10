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
  refreshPayment,
  TRINKETS,
  eligibleGifts,
  seasonPowerState,
  advanceRecruit,
  minionCost,
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
  if (a.type === "discover" && s.season?.discoveryKind === "choose" && !a.target) {
    const chosenUid = a.uid;
    const card = s.discovery.find((m) => m.uid === chosenUid);
    if (card) a = { ...a, target: seasonTargets(s, card, "cast")[0]?.uid };
  }
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
test("seeded current-season play stays valid across all supported heroes", () => {
  for (const h of SEASON_HEROES) {
    const random = seed(812);
    let s = createGame(h.id, random);
    s.health = 2000;
    for (let step = 0; step < 140; step++) {
      let action: Action;
      if (s.phase === "over") break;
      if (s.phase === "combat") action = { type: "continue" };
      else if (s.season!.powerChoice)
        action = { type: "choosePower", uid: s.season!.powerChoice.offers[0] };
      else if (s.discovery.length)
        action = { type: "discover", uid: s.discovery[0].uid, target: s.season?.discoveryKind === "choose" ? seasonTargets(s, s.discovery[0], "cast")[0]?.uid : undefined };
      else if (s.season!.trinketOffers.length)
        action = { type: "buyTrinket", uid: s.season!.trinketOffers[0] };
      else if (s.rewards.length) action = { type: "reward" };
      else if (s.hand.length && s.board.length < 7) {
        const m = s.hand[0],
          event = getDef(m.id).kind === "spell" ? "cast" : "battlecry";
        const targets = seasonTargets(s, m, event);
        if (
          (m.lockedUntil || 0) > s.turn || (m.lockedTier || 0) > s.tier || getDef(m.id).kind === "spell" && ![...(getDef(m.id).abilities || []), ...(m.extraAbilities || [])].some((a) => a.event === "cast") || getDef(m.id).kind === "spell" &&
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
      assert.ok(s.hand.length + s.rewards.length <= 10, `${h.id} turn ${s.turn} ${JSON.stringify(action)}: ${s.hand.map((m) => getDef(m.id).name).join(",")} rewards ${s.rewards.length}`);
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


test("Xyrella takes only a shop minion as a 2/2, preserves enchantments and resolves triples", () => {
  let s = fixture("s14_xyrella");
  const friendly = add(s, "BG25_001", "board");
  add(s, "BG25_001", "hand");
  const target = add(s, "BG25_001", "shop");
  target.attack = 12; target.health = 15;
  target.keywords.push("圣盾");
  const rejected = act(s, { type: "power", target: friendly.uid }, rng);
  assert.ok(rejected.error); assert.equal(rejected.state, s);
  s = apply(s, { type: "power", target: target.uid });
  assert.equal(s.gold, 1);
  assert.equal(s.triples, 1);
  assert.equal(s.hand.length, 1);
  assert.ok(s.hand[0].golden && s.hand[0].keywords.includes("圣盾"));
  assert.equal(s.hand[0].attack, getDef(target.id).attack + 2);
  assert.equal(s.hand[0].health, getDef(target.id).health + 2);
  assert.equal(s.purchases, 0);
  assert.ok(act(s, { type: "power", target: s.shop[0].uid }, rng).error);
});
test("Reno preserves buffs and pool ownership without a triple reward and remains spent after restore", () => {
  let s = fixture("s14_reno");
  const target = add(s, "BG25_001", "board");
  target.attack += 7; target.health += 9; target.keywords.push("圣盾");
  const d = getDef(target.id), copies = { ...target.copies };
  s = apply(s, { type: "power", target: target.uid });
  assert.equal(s.board[0].attack, d.goldenAttack! + 7);
  assert.equal(s.board[0].health, d.goldenHealth! + 9);
  assert.deepEqual(s.board[0].copies, copies);
  assert.ok(s.board[0].golden && s.board[0].keywords.includes("圣盾"));
  assert.equal(s.triples, 0); assert.equal(s.rewards.length, 0);
  s = JSON.parse(JSON.stringify(s));
  advanceRecruit(s, rng);
  assert.equal(seasonPowerState(s).status, "本局已使用");
  assert.ok(act(s, { type: "power", target: s.board[0].uid }, rng).error);
  s = apply(s, { type: "sell", uid: s.board[0].uid });
  assertPool(s);
});
test("Reno rejects shop and already golden targets without spending his once-per-game use", () => {
  const s = fixture("s14_reno"), target = add(s, "BG25_001", "board", true);
  for (const uid of [target.uid, s.shop[0].uid]) {
    const result = act(s, { type: "power", target: uid }, rng);
    assert.ok(result.error); assert.equal(result.state, s);
  }
  assert.equal(s.season!.heroPowerUses, 0);
});
test("Elise discovers the exact tavern tier and her price persists across turns and saves", () => {
  let s = fixture("s14_elise"); s.tier = 3; s.gold = 10;
  s = apply(s, { type: "power" });
  assert.equal(s.gold, 9);
  assert.ok(s.discovery.length && s.discovery.every((m) => getDef(m.id).tier === 3));
  s = apply(s, { type: "discover", uid: s.discovery[0].uid });
  s = JSON.parse(JSON.stringify(s)); advanceRecruit(s, rng);
  assert.equal(seasonPowerState(s).cost, 2);
  s = apply(s, { type: "power" });
  assert.equal(s.gold, 2);
});
test("Alexstrasza unlocks at tier four and discovers pooled dragons including higher tiers", () => {
  let s = fixture("s14_alexstrasza");
  assert.ok(s.season!.tribes.includes("龙"));
  assert.ok(act(s, { type: "power" }, rng).error);
  s.tier = 4;
  // Isolate tier-six dragons to prove this discovery is not capped by tavern tier.
  for (const id of Object.keys(s.pool)) {
    const d = getDef(id);
    if (!(d.tier === 6 && d.races?.includes("龙"))) {
      s.season!.initialPool[id] -= s.pool[id]; s.pool[id] = 0;
    }
  }
  s = apply(s, { type: "power" });
  assert.ok(s.discovery.length);
  assert.ok(s.discovery.every((m) => getDef(m.id).races?.includes("龙") && getDef(m.id).tier === 6));
  assert.equal(s.gold, 2);
});
test("Blackthorn permits two uses per turn, resets on the next turn and respects hand capacity", () => {
  let s = fixture("s14_blackthorn");
  s = apply(s, { type: "power" });
  assert.equal(s.hand.length, 2); assert.equal(s.powerUsed, false);
  assert.equal(seasonPowerState(s).remaining, 1);
  s = JSON.parse(JSON.stringify(s));
  s = apply(s, { type: "power" });
  assert.equal(s.hand.length, 4); assert.equal(s.gold, 1); assert.ok(s.powerUsed);
  assert.ok(s.hand.every((m) => m.id === PREFIX + "BG20_GEM"));
  assert.ok(act(s, { type: "power" }, rng).error);
  advanceRecruit(s, rng);
  assert.equal(seasonPowerState(s).remaining, 2);
  while (s.hand.length < 10) s.hand.push(makeMinion(PREFIX + "BG20_GEM"));
  const rejected = act(s, { type: "power" }, rng);
  assert.ok(rejected.error); assert.equal(rejected.state, s);
});
test("Inge buffs board or shop twice and alternates attack and health without expiring the buff", () => {
  let s = fixture("s14_inge"); s.tier = 3;
  const target = add(s, "BG25_001", "board"), a = target.attack, h = target.health;
  s = apply(s, { type: "power", target: target.uid });
  s = apply(s, { type: "power", target: target.uid });
  assert.equal(s.board[0].attack, a + 6); assert.equal(s.board[0].health, h);
  assert.ok(act(s, { type: "power", target: target.uid }, rng).error);
  advanceRecruit(s, rng); s.tier = 4;
  s = apply(s, { type: "power", target: target.uid });
  assert.equal(s.board[0].attack, a + 6); assert.equal(s.board[0].health, h + 4);
  const shop = s.shop[0];
  s = apply(s, { type: "power", target: shop.uid });
  assert.equal(s.shop[0].health, shop.health + 4);
});
test("Millhouse pays two for minions and refresh, one extra for each upgrade, with free refresh respected", () => {
  let s = fixture("s14_millhouse");
  assert.equal(s.upgrade, 6); assert.equal(refreshCost(s), 2);
  assert.equal(minionCost(s, s.shop[0]), 2);
  s = apply(s, { type: "buy", uid: s.shop[0].uid });
  assert.equal(s.gold, 1); assert.ok(act(s, { type: "refresh" }, rng).error);
  s.gold = 10; s = apply(s, { type: "refresh" }); assert.equal(s.gold, 8);
  s.season!.freeRefresh = 1; s = apply(s, { type: "refresh" }); assert.equal(s.gold, 8);
  s = apply(s, { type: "upgrade" }); assert.equal(s.gold, 2); assert.equal(s.upgrade, 8);
  advanceRecruit(s, rng); assert.equal(s.upgrade, 7);
});
test("Chenvaala counts elementals across turns and saves, discounts every third play and never below zero", () => {
  let s = fixture("s14_chenvaala");
  assert.ok(s.season!.tribes.includes("元素"));
  const elemental = SEASON_CARDS.find((d) => d.tier === 1 && d.races?.includes("元素"))!;
  for (let i = 0; i < 3; i++) {
    if (i === 2) { s = JSON.parse(JSON.stringify(s)); advanceRecruit(s, rng); }
    const m = add(s, elemental.sourceId!);
    s = apply(s, { type: "play", uid: m.uid });
    s = apply(s, { type: "sell", uid: m.uid });
  }
  assert.equal(s.season!.elementalsPlayed, 3); assert.equal(s.upgrade, 1);
  s.season!.elementalsPlayed = 5; s.upgrade = 1;
  const m = add(s, elemental.sourceId!); s = apply(s, { type: "play", uid: m.uid });
  assert.equal(s.upgrade, 0);
});
test("old saves without hero counters still enforce the existing once-per-turn power limit", () => {
  let s = fixture("s14_george");
  delete s.season!.heroPowerUses; delete s.season!.heroPowerUsesTurn;
  s.powerUsed = true;
  assert.equal(seasonPowerState(s).used, true);
  advanceRecruit(s, rng);
  assert.equal(seasonPowerState(s).used, false);
});


test("Malchezaar refresh works at zero gold, consumes health charges then returns to gold", () => {
  let s = fixture(); s.gold = 0; s.season!.armor = 0;
  add(s, "BG26_524", "board");
  assert.equal(refreshCost(s), 0);
  assert.equal(refreshPayment(s).remaining, 2);
  const hp = s.health;
  s = apply(s, { type: "refresh" });
  assert.equal(s.health, hp - 1); assert.equal(s.gold, 0);
  s = apply(s, { type: "refresh" });
  assert.equal(s.health, hp - 2); assert.equal(refreshCost(s), 1);
  const rejected = act(s, { type: "refresh" }, rng);
  assert.ok(rejected.error); assert.equal(rejected.state, s);
  advanceRecruit(s, rng);
  assert.equal(refreshPayment(s).remaining, 2);
});
test("each Malchezaar owns its charges, golden grants four, new copies do not inherit spent charges", () => {
  let s = fixture(); s.gold = 0;
  const a = add(s, "BG26_524", "board");
  const b = add(s, "BG26_524", "board", true);
  assert.equal(refreshPayment(s).remaining, 6);
  for (let i = 0; i < 6; i++) s = apply(s, { type: "refresh" });
  assert.equal(s.season!.healthRefreshUses![a.uid], 2);
  assert.equal(s.season!.healthRefreshUses![b.uid], 4);
  s = apply(s, { type: "sell", uid: a.uid });
  const fresh = add(s, "BG26_524");
  s = apply(s, { type: "play", uid: fresh.uid });
  assert.equal(refreshPayment(s).remaining, 2);
  s = JSON.parse(JSON.stringify(s)); s.gold = 0;
  s = apply(s, { type: "refresh" });
  assert.equal(refreshPayment(s).remaining, 1);
});
test("free refresh is used before health and does not spend a Malchezaar charge", () => {
  let s = fixture("s14_nozdormu"); s.gold = 0;
  add(s, "BG26_524", "board");
  const hp = s.health, armor = s.season!.armor;
  assert.equal(refreshPayment(s).health, 0);
  s = apply(s, { type: "refresh" });
  assert.equal(s.health, hp); assert.equal(s.season!.armor, armor);
  assert.equal(refreshPayment(s).remaining, 2);
  assert.match(s.logs[0], /免费/); assert.doesNotMatch(s.logs[0], /生命/);
  s = apply(s, { type: "refresh" });
  assert.equal(s.season!.armor, armor - 1);
  assert.equal(refreshPayment(s).remaining, 1);
});
test("old shared refresh counter migrates without restoring spent uses and supports a newly played copy", () => {
  let s = fixture(); s.gold = 0;
  add(s, "BG26_524", "board");
  delete s.season!.healthRefreshUses; s.season!.healthRefreshes = 2;
  assert.equal(refreshPayment(s).remaining, 0);
  const fresh = add(s, "BG26_524");
  s = apply(s, { type: "play", uid: fresh.uid });
  assert.equal(refreshPayment(s).remaining, 2);
  s = apply(s, { type: "refresh" });
  assert.equal(refreshPayment(s).remaining, 1);
});
test("Malchezaar self damage triggers Soul Rewinder and can eliminate an unprotected hero", () => {
  let s = fixture(); s.gold = 0; s.health = 1; s.season!.armor = 0;
  add(s, "BG26_524", "board");
  const rewinder = add(s, "BG26_174", "board"), health = rewinder.health;
  s = apply(s, { type: "refresh" });
  assert.equal(s.health, 1); assert.equal(s.board[1].health, health + 2);
  s = apply(s, { type: "sell", uid: rewinder.uid });
  s = apply(s, { type: "refresh" });
  assert.equal(s.phase, "over"); assert.equal(s.health, 0);
});

test("Finley offers three unique supported powers, gates actions, rejects forged choices and preserves identity", () => {
  let s = fixture("s14_finley");
  const before = JSON.stringify(s), choice = s.season!.powerChoice!;
  assert.equal(choice.offers.length, 3); assert.equal(new Set(choice.offers).size, 3);
  assert.ok(act(s, { type: "buy", uid: s.shop[0].uid }).error);
  assert.ok(act(s, { type: "choosePower", uid: "s14_genn" }).error);
  assert.equal(JSON.stringify(s), before);
  const id = choice.offers[0], hp = s.health, armor = s.season!.armor;
  s = apply(s, { type: "choosePower", uid: id });
  assert.deepEqual(s.season!.powers, [id]); assert.equal(s.hero, "s14_finley");
  assert.equal(s.health, hp); assert.equal(s.season!.armor, armor);
  assert.equal(s.season!.powerChoice, undefined);
  assert.ok(act(s, { type: "power", powerId: "s14_genn" }).error);
  assertPool(s);
});

test("Nguyen offers two fresh powers every turn including after save restore, Identity Reveal ends the cycle", () => {
  let s = fixture("s14_nguyen");
  const id = s.season!.powerChoice!.offers[0];
  s = apply(s, { type: "choosePower", uid: id });
  s = JSON.parse(JSON.stringify(s)); advanceRecruit(s, rng);
  assert.equal(s.season!.powerChoice!.offers.length, 2);
  assert.ok(!s.season!.powerChoice!.offers.includes(id));
  s = apply(s, { type: "choosePower", uid: s.season!.powerChoice!.offers[0] });
  const spell = add(s, "EBG_Spell_037");
  s = apply(s, { type: "cast", uid: spell.uid });
  const selected = s.season!.powerChoice!.offers[0];
  s = apply(s, { type: "choosePower", uid: selected });
  advanceRecruit(s, rng);
  assert.equal(s.season!.powerChoice, undefined);
  assert.deepEqual(s.season!.powers, [selected]); assert.equal(s.hero, "s14_nguyen");
});

test("Genn discovers twice on turn four; choices survive restore and cannot duplicate", () => {
  let s = fixture("s14_genn");
  advanceRecruit(s, rng); advanceRecruit(s, rng);
  assert.equal(s.season!.powerChoice, undefined);
  advanceRecruit(s, rng);
  const first = s.season!.powerChoice!.offers[0];
  s = apply(s, { type: "choosePower", uid: first });
  assert.ok(!s.season!.powerChoice!.offers.includes(first));
  assert.ok(act(s, { type: "end" }).error);
  s = JSON.parse(JSON.stringify(s));
  const second = s.season!.powerChoice!.offers[0];
  s = apply(s, { type: "choosePower", uid: second });
  assert.deepEqual(s.season!.powers, [first, second]);
  while (s.discovery.length) s = apply(s, { type: "discover", uid: s.discovery[0].uid });
  const spell = add(s, "EBG_Spell_037");
  s = apply(s, { type: "cast", uid: spell.uid });
  assert.ok(s.season!.powerChoice!.offers.every((id) => id !== first && id !== second));
  const replacement = s.season!.powerChoice!.offers[0];
  s = apply(s, { type: "choosePower", uid: replacement });
  assert.deepEqual(s.season!.powers, [replacement, second]);
});

test("dual powers track independent costs, targets and turn limits across a save", async () => {
  const { equipPowers } = await import("./powers");
  let s = fixture("s14_genn"); s.gold = 10;
  equipPowers(s, ["s14_george", "s14_inge"]);
  const m = add(s, "BG25_001", "board");
  s = apply(s, { type: "power", powerId: "s14_george", target: m.uid });
  s = apply(s, { type: "power", powerId: "s14_inge", target: m.uid });
  s = JSON.parse(JSON.stringify(s));
  s = apply(s, { type: "power", powerId: "s14_inge", target: m.uid });
  assert.ok(s.board[0].keywords.includes("圣盾"));
  assert.equal(s.board[0].attack, 4);
  assert.equal(seasonPowerState(s, "s14_george").remaining, 0);
  assert.equal(seasonPowerState(s, "s14_inge").remaining, 0);
  assert.equal(s.gold, 9);
  advanceRecruit(s, rng);
  assert.equal(seasonPowerState(s, "s14_george").remaining, 1);
  assert.equal(seasonPowerState(s, "s14_inge").remaining, 2);
});

test("changing powers updates economic passives, never banks Nozdormu refreshes and preserves Reno exhaustion", async () => {
  const { equipPowers } = await import("./powers");
  let s = fixture("s14_reno"); const m = add(s, "BG25_001", "board");
  s = apply(s, { type: "power", target: m.uid });
  equipPowers(s, ["s14_millhouse"]);
  assert.equal(refreshCost(s), 2); assert.equal(minionCost(s, s.shop[0]), 2); assert.equal(s.upgrade, 6);
  equipPowers(s, ["s14_nozdormu"]);
  assert.equal(s.upgrade, 5); assert.equal(refreshCost(s), 0);
  advanceRecruit(s, rng); advanceRecruit(s, rng);
  s = apply(s, { type: "refresh" }); assert.equal(refreshCost(s), 1);
  equipPowers(s, ["s14_omu"]); equipPowers(s, ["s14_nozdormu"]);
  assert.equal(refreshCost(s), 1);
  equipPowers(s, ["s14_reno"]);
  assert.equal(seasonPowerState(s).status, "本局已使用");
});

test("filtered discoveries reserve only eligible pool copies and return unchosen candidates", () => {
  for (const [id, mechanic] of [["BG33_101", ""], ["BG28_882", "DEATHRATTLE"], ["BG28_GIL_836", "BATTLECRY"]]) {
    let s = fixture(); s.tier = 6;
    const spell = add(s, id); s = apply(s, { type: "cast", uid: spell.uid });
    assert.equal(s.discovery.length, 3);
    assert.ok(s.discovery.every((m) => mechanic ? getDef(m.id).mechanics?.includes(mechanic) : getDef(m.id).tier === 1));
    const chosen = s.discovery[0]; s = apply(s, { type: "discover", uid: chosen.uid });
    assert.ok(s.hand.some((m) => m.uid === chosen.uid)); assertPool(s);
  }
});

test("golden battlecry discovery queues twice and golden transformations keep buffs without triple rewards", () => {
  let s = fixture(); s.tier = 6;
  const performer = add(s, "BG28_550", "hand", true);
  s = apply(s, { type: "play", uid: performer.uid });
  for (let i = 0; i < 2; i++) {
    assert.equal(s.discovery.length, 3);
    s = apply(s, { type: "discover", uid: s.discovery[0].uid });
  }
  assert.equal(s.discovery.length, 0); assert.equal(s.hand.length, 2);
  const target = add(s, "BG25_001", "board"); target.attack += 7;
  const eye = add(s, "EBG_Spell_017");
  assert.ok(act(s, { type: "cast", uid: eye.uid, target: performer.uid }).error);
  s = apply(s, { type: "cast", uid: eye.uid, target: target.uid });
  const golden = s.board.find((m) => m.uid === target.uid)!;
  assert.equal(golden.attack, 11); assert.equal(golden.golden, true);
  assert.deepEqual(golden.copies, target.copies); assert.equal(s.rewards.length, 0);
  const touch = add(s, "BG28_830"); s = apply(s, { type: "cast", uid: touch.uid });
  assert.equal(s.shop.filter((m) => m.golden).length, 1); assertPool(s);
});

test("Skylancer targets only Rally minions, golden repeats twice and Dragonbreath casts during recruit", () => {
  let s = fixture(); s.gold = 10;
  const dragon = add(s, "BG36_243", "board", true);
  const gemmer = add(s, "BG20_104", "board");
  const plain = add(s, "BG25_001", "board");
  assert.ok(!seasonTargets(s, dragon, "activate").some((m) => m.uid === plain.uid));
  s = apply(s, { type: "activate", uid: dragon.uid, target: gemmer.uid });
  assert.equal(s.board.find((m) => m.uid === plain.uid)!.attack, plain.attack + 2);
  assert.equal(s.gold, 9);
  assert.ok(act(s, { type: "activate", uid: dragon.uid, target: gemmer.uid }).error);
  advanceRecruit(s, rng);
  const caster = add(s, "BG36_241", "board");
  const before = s.board.find((m) => m.uid === plain.uid)!.attack;
  s = apply(s, { type: "activate", uid: dragon.uid, target: caster.uid });
  assert.equal(s.board.find((m) => m.uid === plain.uid)!.attack, before + 6);
  assert.equal(s.hand.length, 0);
});

test("Sticky Shields give permanent taunt; Humon'gozz aura follows repeated stat grants and stops after sale", () => {
  let s = fixture();
  const slime = add(s, "BG27_002"); s = apply(s, { type: "play", uid: slime.uid });
  assert.equal(s.hand.length, 2);
  s = apply(s, { type: "cast", uid: s.hand[0].uid, target: slime.uid });
  assert.equal(s.board[0].attack, 3); assert.ok(s.board[0].keywords.includes("嘲讽"));
  const aura = add(s, "BG32_341", "board");
  const dragon = add(s, "BG36_241", "board");
  const breath = add(s, "BG36_246");
  s = apply(s, { type: "cast", uid: breath.uid });
  assert.equal(s.board.find((m) => m.uid === dragon.uid)!.attack, dragon.attack + 9 + 3);
  assert.equal(s.board.find((m) => m.uid === dragon.uid)!.health, dragon.health + 6 + 6);
  s = apply(s, { type: "sell", uid: aura.uid });
  const buff = add(s, "BG28_897");
  const before = s.board[0].attack;
  s = apply(s, { type: "cast", uid: buff.uid, target: slime.uid });
  assert.equal(s.board[0].attack, before + 2);
});

test("Choral Mrrrglr reads its own hand in combat; Motley Phalanx buffs persist; Tea Master generates into hand", () => {
  const s = fixture();
  const choral = add(s, "BG26_354", "board");
  const tea = add(s, "BG32_111", "board"); tea.health = 1;
  const motley = add(s, "BG27_080", "board"); motley.health = 1;
  const hand = add(s, "BG25_001"); hand.attack = 40; hand.health = 50;
  const enemy = makeMinion("s14_BG25_001"); enemy.attack = 200; enemy.health = 500;
  const battle = seasonCombat(s, [enemy], 6, rng);
  const opened = battle.frames.find((f) => f.allies.some((m) => m.uid === choral.uid && m.attack >= 46));
  assert.ok(opened);
  assert.ok(s.hand.some((m) => m.id === "s14_BG28_888"));
  assert.equal(s.board.find((m) => m.uid === choral.uid)!.attack, 6);
  const permanent = fixture();
  const guard = add(permanent, "BG27_080", "board"); guard.health = 1;
  const fish = add(permanent, "BG26_354", "board"); fish.attack = 0;
  seasonCombat(permanent, [enemy], 6, rng);
  assert.equal(permanent.board.find((m) => m.uid === fish.uid)!.attack, 3);
  assertPool(s);
});

test("new tribal spells respect the shared finite pool and same-type buffs include the tavern", () => {
  let s = fixture(); s.tier = 6;
  add(s, "BG31_816", "board"); add(s, "BG31_818", "board");
  const shop = add(s, "BG31_816", "shop");
  for (const id of ["BG28_521", "BG33_814", "BG31_819"]) {
    const spell = add(s, id); s = apply(s, { type: "cast", uid: spell.uid });
    if (s.discovery.length) {
      assert.ok(s.discovery.every((m) => getDef(m.id).races?.includes("元素") || getDef(m.id).tribe === "全部"));
      s = apply(s, { type: "discover", uid: s.discovery[0].uid });
    }
  }
  assert.ok(s.hand.filter((m) => getDef(m.id).races?.includes("元素") || getDef(m.id).tribe === "全部").reduce((n, m) => n + Object.values(m.copies).reduce((a, b) => a + b, 0), 0) >= 4);
  const buff = add(s, "BG28_845");
  s = apply(s, { type: "cast", uid: buff.uid, target: shop.uid });
  assert.equal(s.shop.find((m) => m.uid === shop.uid)!.attack, shop.attack + 2);
  assertPool(s);
});

test("Lullabot magnetic end-of-turn growth carries over to the host, without extra golden scaling", () => {
  let s = fixture();
  const mech = add(s, "BG29_611", "board", true);
  const magnetic = add(s, "BG26_146");
  s = apply(s, { type: "play", uid: magnetic.uid, target: mech.uid });
  const before = s.board[0].health;
  s = apply(s, { type: "end" });
  assert.equal(s.board[0].health, before + 1); assertPool(s);
});

test("Temperature Shift is not offered in lobbies without Elementals", () => {
  let s = fixture(); s.tier = 6;
  s.season!.tribes = ["机械", "海盗", "野兽", "龙", "亡灵"];
  s.season!.freeRefresh = 150;
  const random = seed(893);
  for (let i = 0; i < 150; i++) {
    const result = act(s, { type: "refresh" }, random);
    assert.equal(result.error, undefined); s = result.state;
    assert.ok(s.season!.spellShop.every((m) => m.id !== "s14_BG31_819"));
  }
  assertPool(s);
});

test("Balinda repeats friendly targeted spells, golden repeats three times, copies do not multiply", () => {
  for (const golden of [false, true]) {
    let s = fixture();
    add(s, "BG35_883", "board", golden); add(s, "BG35_883", "board");
    const friend = add(s, "BG25_001", "board"), shop = s.shop[0];
    const spell = add(s, "BG28_897"), before = friend.attack;
    s = apply(s, { type: "cast", uid: spell.uid, target: friend.uid });
    assert.equal(s.board.find((m) => m.uid === friend.uid)!.attack, before + (golden ? 6 : 4));
    assert.equal(s.season!.spellsCast, golden ? 3 : 2);
    const other = add(s, "BG28_897"), old = shop.attack;
    s = apply(s, { type: "cast", uid: other.uid, target: shop.uid });
    assert.equal(s.shop.find((m) => m.uid === shop.uid)!.attack, old + 2);
  }
});

test("Balinda stops when Butchering destroys its target and returns finite pool copies once", () => {
  let s = fixture(); add(s, "BG35_883", "board", true);
  const victim = add(s, "BG25_001", "board"), spell = add(s, "BG28_604");
  const available = s.pool[victim.id];
  assert.ok(!seasonTargets(s, spell, "cast").some((x) => s.shop.includes(x)));
  s = apply(s, { type: "cast", uid: spell.uid, target: victim.uid });
  assert.equal(s.season!.buffs.undead.attack, 5);
  assert.equal(s.season!.spellsCast, 1);
  assert.equal(s.pool[victim.id], available + 1);
});

test("Lava Lurker keeps the first spellcraft permanent including Balinda repeats, later spells expire", () => {
  let s = fixture(); add(s, "BG35_883", "board");
  const lurker = add(s, "BG23_009", "board"), caster = add(s, "BG23_000");
  s = apply(s, { type: "play", uid: caster.uid });
  const spell = s.hand.find((m) => m.tempSpell)!;
  s = apply(s, { type: "cast", uid: spell.uid, target: lurker.uid });
  const first = s.board.find((m) => m.uid === lurker.uid)!;
  assert.equal(first.attack, lurker.attack + 4); assert.equal(first.temporary, undefined);
  const secondCaster = add(s, "BG23_000"); s = apply(s, { type: "play", uid: secondCaster.uid });
  const secondSpell = s.hand.find((m) => m.tempSpell)!;
  s = apply(s, { type: "cast", uid: secondSpell.uid, target: lurker.uid });
  assert.equal(s.board.find((m) => m.uid === lurker.uid)!.temporary!.attack, 4);
  advanceRecruit(s, rng);
  assert.equal(s.board.find((m) => m.uid === lurker.uid)!.attack, lurker.attack + 4);
});

test("Choose One waits for selection, rejects bad targets, and Brann does not duplicate it", () => {
  let s = fixture(); add(s, "BG_LOE_077", "board");
  const beast = add(s, "BG31_803", "board"), beetle = add(s, "BG27_084");
  s = apply(s, { type: "play", uid: beetle.uid });
  assert.equal(s.discovery.length, 2); assert.equal(s.season!.discoveryKind, "choose");
  assert.ok(act(s, { type: "discover", uid: s.discovery[0].uid, target: "missing" }).error);
  s = apply(s, { type: "discover", uid: s.discovery[0].uid, target: beast.uid });
  assert.equal(s.board.find((m) => m.uid === beast.uid)!.attack, beast.attack + 1);
  assert.ok(s.board.find((m) => m.uid === beast.uid)!.keywords.includes("复生"));
  assert.equal(s.discovery.length, 0);
});

test("Choose One tavern spell counts under its original ID and Balinda repeats the selected effect", () => {
  let s = fixture(); add(s, "BG35_883", "board");
  const target = add(s, "BG25_001", "board"), spell = add(s, "BG31_880");
  s = apply(s, { type: "cast", uid: spell.uid });
  assert.equal(s.season!.spellsCast, 0);
  s = apply(s, { type: "discover", uid: s.discovery[0].uid, target: target.uid });
  assert.equal(s.board.find((m) => m.uid === target.uid)!.attack, target.attack + 6);
  assert.equal(s.season!.spellsCast, 2); assert.equal(s.season!.lastSpell, spell.id);
});

test("Bristleback gives both Choose One options once per turn and Gem Training has real options", () => {
  let s = fixture(); add(s, "BG31_327", "board");
  const miner = add(s, "BG31_320"); s = apply(s, { type: "play", uid: miner.uid });
  assert.ok(s.season!.activeDiscovery?.both);
  s = apply(s, { type: "discover", uid: s.discovery[0].uid });
  assert.equal(s.hand.filter((m) => m.id === PREFIX + "BG20_GEM").length, 2);
  const training = s.hand.find((m) => m.id === PREFIX + "BG31_893")!;
  assert.ok(training); s = apply(s, { type: "cast", uid: training.uid });
  assert.equal(s.season!.activeDiscovery?.both, false);
  s = apply(s, { type: "discover", uid: s.discovery[0].uid });
  assert.equal(s.season!.buffs.gem.attack, 1); assert.equal(s.season!.buffs.gem.health, 0);
});

test("health-priced spell spends health rather than gold and can trigger damage watchers", () => {
  let s = fixture(); s.gold = 0;
  const demon = add(s, "BG26_523", "board"), spell = makeMinion(PREFIX + "BG28_571");
  s.season!.spellShop = [spell];
  const armor = s.season!.armor;
  s = apply(s, { type: "buySpell", uid: spell.uid });
  assert.equal(s.gold, 0); assert.equal(s.season!.armor, armor - getDef(spell.id).cost!);
  assert.equal(s.board.find((m) => m.uid === demon.uid)!.attack, demon.attack + 4);
});

test("locked discoveries cannot be played early and delayed buffs resolve at the next recruit start", () => {
  let s = fixture(); const spell = add(s, "BG34_330");
  s = apply(s, { type: "cast", uid: spell.uid }); const discovered = s.discovery[0];
  s = apply(s, { type: "discover", uid: discovered.uid });
  assert.match(act(s, { type: "play", uid: discovered.uid }).error!, /解锁/);
  advanceRecruit(s, rng);
  s = apply(s, { type: "play", uid: discovered.uid });
  assert.ok(s.board.some((m) => m.uid === discovered.uid));
});

test("Lockbox opens after five turns or acceleration, generates a golden typed minion without triple reward", () => {
  let s = fixture(); const maker = add(s, "BG36_520");
  s = apply(s, { type: "play", uid: maker.uid });
  const chest = s.hand.find((m) => m.id === PREFIX + "BG36_520t")!;
  assert.equal(chest.lockedUntil, 6);
  for (let i = 0; i < 4; i++) advanceRecruit(s, rng);
  assert.ok(s.hand.some((m) => m.id === chest.id));
  s.season!.trinketOffers = [];
  const second = add(s, "BG36_520"); s = apply(s, { type: "play", uid: second.uid });
  assert.ok(!s.hand.some((m) => m.id === chest.id));
  assert.ok(s.hand.some((m) => m.golden && getDef(m.id).races?.length));
  assert.equal(s.rewards.length, 0);
});

test("Elemental of Surprise joins a triple and preserves each source pool copy", () => {
  let s = fixture(); add(s, "BG31_816", "board"); add(s, "BG31_816"); add(s, "BG26_175");
  s = apply(s, { type: "freeze" });
  const golden = s.hand.find((m) => m.golden)!;
  assert.ok(golden); assert.equal(golden.id, PREFIX + "BG31_816");
  assert.equal(golden.copies[PREFIX + "BG31_816"], 2); assert.equal(golden.copies[PREFIX + "BG26_175"], 1);
  assert.ok(golden.keywords.includes("圣盾"));
});

test("Fishbait can replace a shop spell and recruits trigger Rally without consuming a hand slot", () => {
  let s = fixture(); s.gold = 10;
  const beast = add(s, "BG36_200", "board"), fish = add(s, "BG36_201", "board"), target = s.season!.spellShop[0];
  assert.ok(seasonTargets(s, fish, "activate").some((x) => x.uid === target.uid));
  s = apply(s, { type: "activate", uid: fish.uid, target: target.uid });
  assert.equal(s.gold, 8);
  assert.equal(s.board.find((m) => m.uid === beast.uid)!.attack, beast.attack + 5);
  assert.ok(s.board.length > 2); assert.equal(s.hand.length, 0);
});

test("Leeroy kills the minion that dealt lethal damage", () => {
  const s = fixture(); add(s, "BG23_318", "board");
  const giant = makeMinion(PREFIX + "BG25_001"); giant.attack = giant.health = 200; giant.keywords = [];
  const result = seasonCombat(s, [giant], 6, () => 0);
  assert.equal(result.result, "tie");
});

test("every pinned pool minion and tavern spell has executable rules", () => {
  assert.equal(SEASON_CARDS.length, 234); assert.equal(SEASON_SPELLS.length, 67);
  for (const d of SEASON_CARDS) {
    let s = fixture(); s.tier = 6; s.gold = 50; s.health = 200;
    add(s, "BG25_001", "board"); const minion = add(s, d.sourceId!);
    s = apply(s, { type: "play", uid: minion.uid, target: seasonTargets(s, minion)[0]?.uid });
    for (let i = 0; i < 12 && s.discovery.length; i++) s = apply(s, { type: "discover", uid: s.discovery[0].uid });
    const own = s.board.find((m) => m.uid === minion.uid);
    if (own && d.abilities?.some((a) => a.event === "activate")) {
      const result = act(s, { type: "activate", uid: own.uid, target: seasonTargets(s, own, "activate")[0]?.uid }, rng);
      if (!result.error) { s = result.state; assertPool(s); }
    }
    const enemy = makeMinion(PREFIX + "BG25_001"); enemy.attack = 1000; enemy.health = 10000;
    seasonCombat(s, [enemy], 6, rng); assertPool(s);
  }
});

test("Clockwork triples with two copies, awards a coin on play, and keeps finite pool accounting", () => {
  let s = fixture("s14_clockwork"); add(s, "BG25_001"); add(s, "BG25_001");
  s = apply(s, { type: "freeze" }); const golden = s.hand.find((m) => m.golden)!;
  assert.equal(golden.copies[golden.id], 2); assert.ok(!golden.reward);
  s = apply(s, { type: "play", uid: golden.uid });
  assert.equal(s.rewards.length, 0); assert.ok(s.hand.some((m) => m.id === PREFIX + "BG28_810"));
});

test("Mutanus sells a target and transfers its stats; Zerek creates a copy only once per game", () => {
  let s = fixture("s14_mutanus");
  const a = add(s, "BG25_001", "board"), b = add(s, "BG31_803", "board");
  s = apply(s, { type: "power", target: a.uid });
  assert.equal(s.board.length, 1); assert.equal(s.board[0].attack, a.attack + b.attack); assert.equal(s.gold, 4);
  let z = fixture("s14_zerek"); const target = add(z, "BG25_001", "board"); target.attack = 33;
  z = apply(z, { type: "power", target: target.uid });
  assert.equal(z.board.length, 2); assert.equal(z.board[1].attack, 33); assert.deepEqual(z.board[1].copies, {});
  advanceRecruit(z, rng); assert.match(seasonPowerState(z).reason!, /本局/);
});

test("Snake Eyes pays before adding gold, caps the result, and enforces the rolled cooldown", () => {
  let s = fixture("s14_snakeEyes"); s.gold = 10;
  s = apply(s, { type: "power" });
  assert.equal(s.gold, 10);
  advanceRecruit(s, rng); assert.match(seasonPowerState(s).reason!, /第3回合/);
  advanceRecruit(s, rng); assert.equal(seasonPowerState(s).reason, undefined);
});

test("Maiev locks a purchased card and Galakrond replaces the shop with a reserved discovered copy", () => {
  let s = fixture("s14_maiev"), target = s.shop[0];
  s = apply(s, { type: "power", target: target.uid });
  assert.equal(s.hand[0].lockedUntil, 3);
  assert.match(act(s, { type: "play", uid: target.uid }).error!, /解锁/);
  let g = fixture("s14_galakrond"); target = g.shop[0];
  g = apply(g, { type: "power", target: target.uid });
  assert.ok(g.discovery.every((m) => getDef(m.id).tier === getDef(target.id).tier + 1));
  const selected = g.discovery[0]; g = apply(g, { type: "discover", uid: selected.uid });
  assert.ok(g.shop.some((m) => m.uid === selected.uid)); assert.equal(g.hand.length, 0);
});

test("AFK skips the first two turns and receives tier three and four discoveries", () => {
  let s = fixture("s14_afk"); assert.equal(s.gold, 0);
  advanceRecruit(s, rng); assert.equal(s.gold, 0);
  advanceRecruit(s, rng); assert.ok(s.discovery.every((m) => getDef(m.id).tier === 3));
  s = apply(s, { type: "discover", uid: s.discovery[0].uid });
  assert.ok(s.discovery.every((m) => getDef(m.id).tier === 4));
});

test("Rokara kill buff is permanent and Greyborough affects summoned bodies only", () => {
  const s = fixture("s14_rokara"), minion = add(s, "BG25_001", "board"); minion.attack = 20; minion.health = 40;
  const enemy = makeMinion(PREFIX + "BG31_803"); enemy.attack = 0; enemy.health = 1;
  seasonCombat(s, [enemy], 1, () => 0); assert.ok(minion.attack > 20);
  const g = fixture("s14_greybough"), raptor = add(g, "BG25_806", "board"); raptor.health = 1;
  const giant = makeMinion(PREFIX + "BG36_356"); giant.attack = 50; giant.health = 100;
  const result = seasonCombat(g, [giant], 6, () => 0);
  assert.ok(result.frames.some((f) => f.allies.some((m) => m.uid !== raptor.uid && m.health === 8 && m.keywords.includes("嘲讽"))));
});

test("newly acquired purchase powers do not inherit purchases made under another hero power", async () => {
  const { equipPowers } = await import("./powers");
  const { spellCost } = await import("./engine");
  let s = fixture(); s.gold = 30;
  for (let i = 0; i < 2; i++) {
    const spell = makeMinion(PREFIX + "BG28_897"); s.season!.spellShop = [spell];
    s = apply(s, { type: "buySpell", uid: spell.uid });
  }
  equipPowers(s, ["s14_taethelan"]);
  assert.equal(spellCost(s, makeMinion(PREFIX + "BG28_897")), 1);
  for (let i = 0; i < 2; i++) {
    const spell = makeMinion(PREFIX + "BG28_897"); s.season!.spellShop = [spell];
    s = apply(s, { type: "buySpell", uid: spell.uid });
  }
  assert.equal(spellCost(s, makeMinion(PREFIX + "BG28_897")), 0);
  equipPowers(s, ["s14_lich"]);
  const other = makeMinion(PREFIX + "BG28_897"); s.season!.spellShop = [other];
  s = apply(s, { type: "buySpell", uid: other.uid });
  equipPowers(s, ["s14_taethelan"]);
  assert.equal(spellCost(s, makeMinion(PREFIX + "BG28_897")), 0);
});

test("magnetic plays attach satellites to the host and attached spell auras do not scale with a golden host", () => {
  let s = fixture(); add(s, "BG36_851", "board");
  const host = add(s, "BG29_611", "board", true), magnetic = add(s, "BG35_341");
  s = apply(s, { type: "play", uid: magnetic.uid, target: host.uid });
  assert.equal(s.board.find((m) => m.uid === host.uid)!.attack, host.attack + magnetic.attack + 2);
  const spell = add(s, "BG28_897"), before = s.board.find((m) => m.uid === host.uid)!.attack;
  s = apply(s, { type: "cast", uid: spell.uid, target: host.uid });
  assert.equal(s.board.find((m) => m.uid === host.uid)!.attack, before + 3);
});

test("Fandral's Fortune discovers Choose One spells as well as minions, preserving both options", () => {
  let s = fixture(); s.tier = 6;
  for (const d of SEASON_CARDS.filter((d) => d.abilities?.some((a) => a.op === "choose"))) {
    // Hold every copy so only spells can be offered, without changing pool totals.
    const count = s.pool[d.id] || 0;
    if (count) { const held = makeMinion(d.id); held.copies = { [d.id]: count }; s.opponents[0].board.push(held); s.pool[d.id] = 0; }
  }
  const spell = add(s, "BG31_892"); s = apply(s, { type: "cast", uid: spell.uid });
  assert.equal(s.discovery.length, 3); assert.ok(s.discovery.every((m) => getDef(m.id).kind === "spell"));
  const chosen = s.discovery[0]; s = apply(s, { type: "discover", uid: chosen.uid });
  assert.ok(s.hand.find((m) => m.uid === chosen.uid)!.bothChoices);
  s = apply(s, { type: "cast", uid: chosen.uid }); assert.ok(s.season!.activeDiscovery?.both);
});
