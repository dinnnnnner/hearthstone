import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  assertPool,
  combat,
  createGame,
  makeMinion,
  type Game,
  type Action,
  type Minion,
} from "./engine";
import { CARDS, CLASSIC_HEROES as HEROES, POOL_COPIES, getDef } from "./data";
const rng = () => 0.31;
function apply(s: Game, a: Action) {
  const r = act(s, a, rng);
  assert.equal(r.error, undefined, JSON.stringify(a) + ": " + r.error);
  assertPool(r.state);
  return r.state;
}
function reserve(
  s: Game,
  id: string,
  zone: "hand" | "board" = "hand",
  golden = false,
) {
  const m = makeMinion(id, golden, true);
  s.pool[id] -= golden ? 3 : 1;
  s[zone].push(m);
  return m;
}
function advance(s: Game) {
  return apply(apply(s, { type: "end" }), { type: "continue" });
}
function seeded(seed: number) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
test("initial economy, shop, pool counts, and passive hero health", () => {
  const s = createGame("lich", rng);
  assert.equal(s.gold, 3);
  assert.equal(s.tier, 1);
  assert.equal(s.shop.length, 3);
  assert.equal(s.hand.length, 0);
  assertPool(s);
  assert.equal(createGame("patchwerk").health, 60);
  assert.equal(createGame("bartender").upgrade, 4);
  for (const d of CARDS)
    assert.equal(
      s.pool[d.id] + s.shop.filter((m) => m.id === d.id).length,
      POOL_COPIES[d.tier],
    );
});
test("buy goes to hand, costs three, and cannot spend unavailable gold", () => {
  let s = createGame("lich", rng);
  const m = s.shop[0];
  s = apply(s, { type: "buy", uid: m.uid });
  assert.equal(s.gold, 0);
  assert.equal(s.hand[0].uid, m.uid);
  assert.equal(s.board.length, 0);
  const r = act(s, { type: "buy", uid: s.shop[0].uid });
  assert.match(r.error!, /金币不足/);
  assert.deepEqual(r.state, s);
});
test("refresh costs one and returns old stock before weighted drawing", () => {
  let s = createGame("lich", rng);
  const old = s.shop.map((m) => m.uid);
  s = apply(s, { type: "refresh" });
  assert.equal(s.gold, 2);
  assert.equal(s.shop.length, 3);
  assert.ok(s.shop.every((m) => !old.includes(m.uid)));
  assertPool(s);
});
test("freeze preserves offered instances into next round and fills empty slots", () => {
  let s = createGame("lich", rng);
  s = apply(s, { type: "buy", uid: s.shop[0].uid });
  s = apply(s, { type: "freeze" });
  const kept = s.shop.map((m) => m.uid);
  s = advance(s);
  assert.ok(kept.every((uid) => s.shop.some((m) => m.uid === uid)));
  assert.equal(s.shop.length, 3);
  assert.equal(s.frozen, false);
  assert.equal(s.gold, 4);
  assert.equal(s.upgrade, 4);
});
test("upgrade costs, maximum tier, and shop sizes", () => {
  let s = createGame("lich", rng);
  s.gold = 10;
  s = apply(s, { type: "upgrade" });
  assert.equal(s.tier, 2);
  assert.equal(s.gold, 5);
  assert.equal(s.upgrade, 7);
  assert.equal(s.shop.length, 3);
  s = apply(s, { type: "refresh" });
  assert.equal(s.shop.length, 4);
  s.tier = 6;
  assert.match(act(s, { type: "upgrade" }).error!, /最高星级/);
});
test("hand and board limits are enforced, including reward spells", () => {
  const s = createGame("lich", rng);
  s.gold = 10;
  for (let i = 0; i < 10; i++) s.hand.push(makeMinion("cat-token"));
  assert.match(act(s, { type: "buy", uid: s.shop[0].uid }).error!, /手牌已满/);
  s.hand.pop();
  s.rewards.push(2);
  assert.match(act(s, { type: "buy", uid: s.shop[0].uid }).error!, /手牌已满/);
  for (let i = 0; i < 7; i++) s.board.push(makeMinion("cat-token"));
  assert.match(act(s, { type: "play", uid: s.hand[0].uid }).error!, /战场已满/);
});
test("battlecry tokens summon, trigger tidecaller, and have no pool ownership", () => {
  let s = createGame("lich", rng);
  const tide = reserve(s, "EX1_509", "board");
  const hunter = reserve(s, "EX1_506");
  s = apply(s, { type: "play", uid: hunter.uid });
  assert.equal(s.board.length, 3);
  assert.equal(s.board.find((m) => m.uid === tide.uid)!.attack, 3);
  assert.deepEqual(s.board.find((m) => m.id === "scout-token")!.copies, {});
});
test("battlecries require eligible target and golden effects are doubled", () => {
  let s = createGame("lich", rng);
  const target = reserve(s, "EX1_509", "board");
  const rock = reserve(s, "UNG_073", "hand", true);
  assert.match(act(s, { type: "play", uid: rock.uid }).error!, /战吼目标/);
  s = apply(s, { type: "play", uid: rock.uid, target: target.uid });
  const t = s.board.find((m) => m.uid === target.uid)!;
  assert.equal(t.attack, 4);
  assert.equal(t.health, 4);
});
test("Brann multiplies battlecry without multiplying on-play demon triggers", () => {
  let s = createGame("lich", rng);
  reserve(s, "LOE_077", "board");
  const weaver = reserve(s, "BGS_004", "board");
  const demon = reserve(s, "LOOT_013");
  s = apply(s, { type: "play", uid: demon.uid });
  assert.equal(s.health, 35);
  assert.equal(s.board.find((m) => m.uid === weaver.uid)!.attack, 3);
});
test("Pogo counts earlier plays once, including repeated battlecries", () => {
  let s = createGame("lich", rng);
  reserve(s, "LOE_077", "board");
  s.pogo = 2;
  const pogo = reserve(s, "BOT_283");
  s = apply(s, { type: "play", uid: pogo.uid });
  assert.equal(s.board.find((m) => m.uid === pogo.uid)!.attack, 9);
  assert.equal(s.pogo, 3);
});
test("triple merges hand and board, preserves buffs, and defers reward until played", () => {
  let s = createGame("lich", rng);
  const a = reserve(s, "BOT_445", "board");
  a.attack += 3;
  a.health += 2;
  a.keywords.push("圣盾");
  reserve(s, "BOT_445");
  const m = makeMinion("BOT_445", false, true);
  s.pool[m.id]--;
  s.shop.push(m);
  s = apply(s, { type: "buy", uid: m.uid });
  const golden = s.hand.find((x) => x.golden)!;
  assert.ok(golden);
  assert.equal(golden.attack, 5);
  assert.equal(golden.health, 4);
  assert.ok(golden.keywords.includes("圣盾"));
  assert.equal(s.board.length, 0);
  assert.equal(golden.copies.BOT_445, 3);
  assert.equal(s.rewards.length, 0);
  s.tier = 4;
  s = apply(s, { type: "play", uid: golden.uid });
  assert.deepEqual(s.rewards, [5]);
  s = apply(s, { type: "reward" });
  assert.equal(s.discovery.length, 3);
  assert.ok(s.discovery.every((m) => getDef(m.id).tier === 5));
  const chosen = s.discovery[0];
  s = apply(s, { type: "discover", uid: chosen.uid });
  assert.equal(s.discovery.length, 0);
  assert.ok(s.hand.some((m) => m.uid === chosen.uid));
  s = apply(s, { type: "sell", uid: golden.uid });
  assertPool(s);
});
test("discover only shows unique available minions and returns unpicked cards", () => {
  let s = createGame("lich", rng);
  s.rewards = [6];
  const before = { ...s.pool };
  s = apply(s, { type: "reward" });
  assert.equal(new Set(s.discovery.map((m) => m.id)).size, s.discovery.length);
  const chosen = s.discovery[0];
  s = apply(s, { type: "discover", uid: chosen.uid });
  for (const d of CARDS)
    assert.equal(s.pool[d.id], before[d.id] - (d.id === chosen.id ? 1 : 0));
});
test("magnetic supports full boards and returns attached pool copies when sold", () => {
  let s = createGame("lich", rng);
  const target = reserve(s, "BOT_445", "board");
  for (let i = 0; i < 6; i++) s.board.push(makeMinion("cat-token"));
  const module = reserve(s, "BOT_911");
  s = apply(s, { type: "play", uid: module.uid, target: target.uid });
  assert.equal(s.board.length, 7);
  const combined = s.board.find((m) => m.uid === target.uid)!;
  assert.equal(combined.attack, 3);
  assert.equal(combined.health, 5);
  assert.deepEqual(combined.copies, { BOT_445: 1, BOT_911: 1 });
  assert.ok(combined.keywords.includes("圣盾"));
  s = apply(s, { type: "sell", uid: target.uid });
  assertPool(s);
});
test("all eight hero powers and passive powers work within their costs", () => {
  for (const h of HEROES) {
    let s = createGame(h.id, rng);
    s.gold = 10;
    const m = reserve(s, "LOOT_013", "board");
    if (h.passive) {
      assert.ok(act(s, { type: "power" }).error);
      continue;
    }
    s = apply(s, { type: "power", target: m.uid });
    assert.equal(s.gold, 10 - h.cost);
    assert.equal(s.powerUsed, true);
    assert.match(act(s, { type: "power", target: m.uid }).error!, /已使用/);
    const t = s.board[0];
    if (h.id === "lich") assert.equal(t.rebornNext, true);
    if (h.id === "george") assert.ok(t.keywords.includes("圣盾"));
    if (h.id === "jaraxxus") {
      assert.equal(t.attack, 3);
      assert.equal(t.health, 5);
    }
    if (h.id === "pyramid") assert.equal(t.health, 6);
  }
});
test("Millificent adds shop mech stats and buffs do not enter the pool", () => {
  let s = createGame("millificent", () => 0.47);
  for (let i = 0; i < 30; i++) {
    s.gold = 10;
    s = apply(s, { type: "refresh" });
    for (const m of s.shop) {
      const d = getDef(m.id);
      assert.equal(m.attack, d.attack + (d.tribe === "机械" ? 1 : 0));
      assert.equal(m.health, d.health + (d.tribe === "机械" ? 1 : 0));
    }
  }
});
test("taunt is prioritized, attacks simultaneous, and combat cannot change recruitment minions", () => {
  const a = makeMinion("GVG_113");
  const b = makeMinion("LOOT_013");
  const c = makeMinion("CFM_315");
  const original = structuredClone([a, b, c]);
  const r = combat([a], [c, b], 1, 1, () => 0);
  const first = r.frames.find((f) => f.attacker === a.uid);
  assert.equal(first?.target, b.uid);
  assert.deepEqual([a, b, c], original);
});
test("divine shield blocks poison, poison kills after an unshielded hit", () => {
  const a = makeMinion("FP1_010"),
    b = makeMinion("BGS_008");
  b.health = 100;
  b.attack = 1;
  b.keywords = ["圣盾"];
  const r = combat([a], [b], 6, 6, () => 0);
  const first = r.frames.find((f) => f.attacker === a.uid)!;
  assert.equal(first.enemies[0].health, 100);
  assert.ok(!first.enemies[0].keywords.includes("圣盾"));
  const second = r.frames.filter((f) => f.attacker === a.uid)[1];
  assert.ok(
    second?.enemies[0].health! <= 0 ||
      r.frames.some((f) => f.enemies.some((x) => x.health <= 0)),
  );
});
test("deathrattle summons, golden doubles token stats, and Baron doubles deathrattles", () => {
  const lion = makeMinion("EX1_534", true);
  lion.health = 1;
  const baron = makeMinion("FP1_031");
  const big = makeMinion("GVG_113");
  big.attack = 100;
  big.health = 100;
  const r = combat([lion, baron], [big], 4, 6, () => 0);
  assert.ok(
    r.frames.some(
      (f) =>
        f.allies.filter(
          (x) => x.id === "lion-token" && x.attack === 4 && x.health === 4,
        ).length === 4,
    ),
  );
});
test("reborn returns a base-stat minion with one health, only once", () => {
  const m = makeMinion("LOOT_013");
  m.rebornNext = true;
  m.health = 1;
  m.attack = 6;
  const enemy = makeMinion("FP1_010");
  const r = combat([m], [enemy], 1, 6, () => 0);
  assert.ok(
    r.frames.some((f) =>
      f.allies.some(
        (x) =>
          x.uid !== m.uid &&
          x.id === m.id &&
          x.health === 1 &&
          x.attack === 2 &&
          !x.keywords.includes("复生"),
      ),
    ),
  );
});
test("combat transition resets gold and power without retaining combat damage", () => {
  let s = createGame("lich", rng);
  const m = reserve(s, "GVG_113", "board");
  s.gold = 10;
  s = apply(s, { type: "power", target: m.uid });
  const before = s.board[0].health;
  s = apply(s, { type: "end" });
  assert.equal(s.phase, "combat");
  assert.equal(s.board[0].health, before);
  assert.ok(act(s, { type: "buy", uid: s.shop[0].uid }).error);
  s = apply(s, { type: "continue" });
  assert.equal(s.turn, 2);
  assert.equal(s.powerUsed, false);
  assert.equal(s.board[0].rebornNext, false);
  assert.equal(s.gold, 4);
});
test("seeded randomized sequences preserve pool accounting for each hero", () => {
  for (const h of HEROES) {
    const random = seeded(193);
    let s = createGame(h.id, random);
    s.health = 1000;
    for (let n = 0; n < 160; n++) {
      let action: Action;
      if (s.phase === "over") break;
      if (s.phase === "combat") action = { type: "continue" };
      else if (s.discovery.length)
        action = { type: "discover", uid: s.discovery[0].uid };
      else if (s.rewards.length) action = { type: "reward" };
      else if (s.hand.length && s.board.length < 7) {
        const m = s.hand[0];
        action = { type: "play", uid: m.uid, target: undefined };
        const targets = s.board.filter((x) =>
          getDef(m.id).effect === "rockpool"
            ? getDef(x.id).tribe === "鱼人"
            : getDef(m.id).effect === "overseer"
              ? getDef(x.id).tribe === "恶魔"
              : false,
        );
        if (targets.length) action.target = targets[0].uid;
      } else if (s.gold >= s.upgrade && s.tier < 6)
        action = { type: "upgrade" };
      else if (
        s.gold >= 3 &&
        s.shop.length &&
        s.hand.length + s.rewards.length < 10
      )
        action = {
          type: "buy",
          uid: s.shop[Math.floor(random() * s.shop.length)].uid,
        };
      else if (s.board.length >= 7 && s.hand.length)
        action = { type: "sell", uid: s.board[0].uid };
      else action = { type: "end" };
      const r = act(s, action, random);
      assert.equal(r.error, undefined);
      s = r.state;
      assertPool(s);
      assert.ok(s.board.length <= 7);
      assert.ok(s.hand.length + s.rewards.length <= 10);
      assert.ok(s.gold >= 0);
    }
  }
});
