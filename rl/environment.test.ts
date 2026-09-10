import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfPlayEnv, Random } from "./environment";
import { ACTIONS, candidates, actionId, targets } from "./actions";
import { observe } from "./observation";
import { makeMinion } from "../src/engine";
import { withSimulation } from "../src/simulation";
import { equipPowers } from "../src/season/powers";
import { SHOP_SIZE } from "../src/data";
import chromieReplay from "./fixtures/chromie-spells.json";

function checkPool(env: SelfPlayEnv) {
  const r = env.room;
  for (const [id, total] of Object.entries(r.initial)) {
    const held = r.seats.flatMap(p => p.game ? [...p.game.board, ...p.game.hand, ...p.game.shop, ...p.game.discovery] : [])
      .reduce((n, m) => n + (m.copies[id] || 0), 0);
    assert.equal((r.pool[id] || 0) + held, total, `${id} pool`);
  }
}

test("seeded environments and snapshot restoration preserve actions, RNG and IDs", () => {
  const a = new SelfPlayEnv({ maxActionsPerTurn: 8 }), b = new SelfPlayEnv({ maxActionsPerTurn: 8 });
  assert.deepEqual(a.reset(42), b.reset(42));
  const rng = new Random(34);
  for (let i = 0; i < 50; i++) {
    const saved = a.snapshot();
    const view = a.view(); a.view(); a.legalActions();
    assert.deepEqual(a.snapshot(), saved, "observing/probing must not consume entropy or mutate state");
    const id = view.legalActions[Math.floor(rng.next() * view.legalActions.length)];
    assert.deepEqual(a.step(id), b.step(id));
  }
  const restored = new SelfPlayEnv(); restored.restore(a.snapshot());
  for (let i = 0; i < 50; i++) {
    const ids = a.view().legalActions, id = ids[Math.floor(rng.next() * ids.length)];
    assert.deepEqual(a.step(id), restored.step(id));
    assert.deepEqual(a.snapshot(), restored.snapshot());
  }
  const before = a.snapshot();
  assert.throws(() => a.step(-1), /Illegal action/);
  assert.deepEqual(a.snapshot(), before);
});

test("all eight seats are policy-controlled and headless recording preserves gameplay", () => {
  const a = new SelfPlayEnv({ maxActionsPerTurn: 4 }), b = new SelfPlayEnv({ maxActionsPerTurn: 4, recordFrames: true });
  let state = a.reset(12); b.reset(12);
  assert.equal(a.room.seats.filter(s => s.bot).length, 0);
  const random = new Random(22);
  for (let i = 0; i < 400; i++) {
    const id = state.legalActions[Math.floor(random.next() * state.legalActions.length)];
    state = a.step(id);
    assert.deepEqual(state, b.step(id));
    assert.equal(a.rng.state, b.rng.state);
    assert.equal(a.uidCounter, b.uidCounter);
    if (state.terminated) break;
  }
  assert.ok(a.room.turn > 1);
  assert.equal(a.replays.length, 0);
  assert.ok(b.replays.length > 0);
  assert.ok(a.room.seats.every(s => !s.game!.battle?.frames.length));
  checkPool(a);
});

test("model observations exclude hidden pool, opponent hand and current warband", () => {
  const env = new SelfPlayEnv(); env.reset(10);
  const own = env.room.seats[env.actor].game!, enemy = env.room.seats[(env.actor + 1) % 8].game!;
  const before = observe(own, 0, 64);
  enemy.hand = [makeMinion("s14_BG25_001")];
  enemy.board = [makeMinion("s14_BG25_001")]; enemy.board[0].attack = 999999;
  env.room.pool.s14_BG25_001 = 0;
  assert.deepEqual(observe(own, 0, 64), before);
  assert.ok(before.every(Number.isFinite));
});

test("target slots cover hand spells, play positions and locked-hand legality", () => {
  const env = new SelfPlayEnv(); env.reset(3);
  const s = env.room.seats[env.actor].game!;
  s.season!.powerChoice = undefined; s.discovery = []; s.season!.trinketOffers = [];
  s.hand = [makeMinion("s14_BG20_GEM"), makeMinion("s14_BG25_001")];
  s.hand[1].lockedUntil = 99;
  s.board = [makeMinion("s14_BG25_001")]; s.gold = 10;
  equipPowers(s, ["s14_malygos"]);
  const possible = candidates(s);
  const handTarget = targets(s).findIndex(m => m?.uid === s.hand[0].uid);
  assert.ok(possible.has(actionId("power", 0, handTarget)));
  env.restore(env.snapshot()); // Invalidate the reset-time cache after changing this fixture.
  const legal = env.legalActions();
  assert.ok([...legal].some(([id]) => ACTIONS[id].type === "cast"));
  assert.ok(![...legal].some(([id]) => ACTIONS[id].type === "play" && ACTIONS[id].source === 1));
});

test("Chromie's full spell tavern is observable and every slot remains actionable at all tiers", () => {
  for (let tier = 1; tier <= 6; tier++) {
    const env = new SelfPlayEnv(); env.reset(59);
    const seat = env.actor, s = env.room.seats[seat].game!;
    s.season!.powerChoice = undefined; s.discovery = []; s.season!.trinketOffers = [];
    s.tier = tier; s.gold = 10;
    equipPowers(s, ["s14_chromie"]);
    env.restore(env.snapshot());
    env.step(actionId("power"));
    const changed = env.room.seats[seat].game!;
    assert.equal(changed.season!.spellShop.length, SHOP_SIZE[tier] + 1);
    assert.equal(observe(changed, 1, 64).length, 2705);
    env.actor = seat;
    env.restore(env.snapshot());
    for (let index = 0; index < changed.season!.spellShop.length; index++) {
      assert.ok(env.legalActions().has(actionId("buySpell", index)), `tier ${tier}, spell ${index}`);
    }
    equipPowers(changed, ["s14_malygos"]);
    const lastSpell = changed.season!.spellShop.at(-1)!;
    const target = targets(changed).findIndex(m => m?.uid === lastSpell.uid);
    assert.ok(candidates(changed).has(actionId("power", 0, target)));
  }
});

test("recorded GPU self-play failure replays through the expanded spell shop", () => {
  const env = new SelfPlayEnv(chromieReplay.options);
  let state = env.reset(chromieReplay.seed);
  for (const action of chromieReplay.actions) state = env.step(action);
  assert.equal(env.actor, chromieReplay.expected.actor);
  assert.equal(env.room.turn, chromieReplay.expected.turn);
  assert.equal(env.rng.state, chromieReplay.expected.rng);
  assert.equal(env.uidCounter, chromieReplay.expected.uidCounter);
  assert.equal(env.room.seats[env.actor].game!.season!.spellShop.length, chromieReplay.expected.spellShop);
  assert.ok(state.legalActions.length > 0);
  checkPool(env);
});

test("decision budgets force end, truncations do not fabricate rankings, and scopes unwind", () => {
  const env = new SelfPlayEnv({ maxActionsPerTurn: 1, maxSteps: 1 }); env.reset(6);
  const state = env.step(env.view().legalActions[0]);
  assert.equal(state.truncated, true);
  assert.equal(state.terminated, false);
  assert.deepEqual(state.info.placements, Array(8).fill(null));
  assert.throws(() => env.step(0), /reset required/);
  assert.throws(() => withSimulation({ uid: () => "forced-id", recordFrames: false, recordLogs: false }, () => { throw Error("scope"); }));
  assert.notEqual(makeMinion("s14_BG25_001").uid, "forced-id");
});
