import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfPlayEnv, Random } from "./environment";
import { ACTIONS, candidates, actionId, targets } from "./actions";
import { observe } from "./observation";
import { observeEntities, OFFSETS, ENTITY_SCHEMA } from "./entities";
import { makeMinion } from "../src/engine";
import { withSimulation } from "../src/simulation";
import { equipPowers } from "../src/season/powers";
import { TRINKETS, advanceRecruit } from "../src/season/engine";
import { SHOP_SIZE } from "../src/data";
import chromieReplay from "./fixtures/chromie-spells.json";
import chromieState from "./fixtures/chromie-spells-state.json";

test("both policy inputs include two public scout rounds and ranking armor without current or private data", () => {
  const env = new SelfPlayEnv(); env.reset(10);
  const own = env.room.seats[env.actor].game!, rival = own.opponents[0], other = own.opponents[1];
  own.turn = 4;
  own.season!.armor = 5; own.season!.spellArmor = 3;
  rival.armor = 6; rival.spellArmor = 4;
  const inputs = () => ({ flat: observe(own, 0, 64), entities: observeEntities(own, 0, 64) });
  const before = inputs();
  rival.scouting = [
    { turn: 3, warband: "4龙", battle: { opponent: other.name, result: "win", damage: 10 } },
    { turn: 2, warband: "混合", battle: { opponent: env.room.seats[env.actor].name, result: "loss", damage: 5 } },
  ];
  own.scouting = [{ turn: 3, warband: "空场", battle: { opponent: "幽灵阵容", result: "tie", damage: 0 } }];
  const visible = structuredClone(inputs());
  assert.notDeepEqual(visible.flat, before.flat);
  assert.notDeepEqual(visible.entities, before.entities);
  assert.equal(visible.flat.length, 3209);
  assert.ok(visible.flat.every(Number.isFinite));
  const details = visible.entities[OFFSETS[7]]!.details;
  assert.equal(details.rankingHealth, rival.health + 2);
  assert.equal(visible.entities[0]!.details.rankingHealth, own.health + 2);
  assert.deepEqual(details.scouting, [
    { turn: 3, warband: { type: "龙", count: 4 }, battle: { opponentSeat: other.seatIndex, result: "win", damage: 10 } },
    { turn: 2, warband: { type: "混合", count: 0 }, battle: { opponentSeat: own.seatIndex, result: "loss", damage: 5 } },
  ]);
  assert.deepEqual(visible.entities[0]!.details.scouting, [
    { turn: 3, warband: { type: "空场", count: 0 }, battle: { opponentSeat: 8, result: "tie", damage: 0 } },
  ]);
  rival.scouting.push({ turn: 1, warband: "无种族" }, { turn: 4, warband: "7恶魔" }, { turn: 5, warband: "7野兽" });
  rival.board = [makeMinion("s14_BG25_001")]; rival.board[0].attack = 999999;
  assert.deepEqual(inputs(), visible);
  rival.scouting[0].battle!.damage++;
  assert.notDeepEqual(inputs().flat, visible.flat);
  assert.notDeepEqual(inputs().entities, visible.entities);
});

test("self-play publishes actual completed battles on the following recruit turn", () => {
  const env = new SelfPlayEnv(); let state = env.reset(42);
  while (env.room.turn === 1) {
    const end = state.legalActions.find(id => ACTIONS[id].type === "end");
    state = env.step(end ?? state.legalActions[0]);
  }
  const own = env.room.seats[env.actor].game!;
  for (const [i, rival] of own.opponents.entries()) {
    const actual = env.room.seats[rival.seatIndex!].game!.battles[0];
    const history = state.entities[OFFSETS[7] + i]!.details.scouting as { turn: number; battle: { result: string; damage: number } }[];
    assert.equal(history.length, 1);
    assert.equal(history[0].turn, 1);
    assert.equal(history[0].battle.result, actual.result);
    assert.equal(history[0].battle.damage, actual.damage);
  }
  const restored = new SelfPlayEnv();
  assert.deepEqual(restored.restore(env.snapshot()), state);
});

test('self-play limits every policy seat, persists spent allowances and resets on the next turn', () => {
  const env = new SelfPlayEnv(); let view = env.reset(42);
  for (const seat of env.room.seats) assert.ok(seat.game!.aiActionUsage);
  // Restore a public test position with insufficient gold on every seat.
  const initial = env.snapshot(); initial.room.seats.forEach(p => { p.game!.gold = 2; });
  view = env.restore(initial);
  const allowed = () => view.entities[0]!.details.aiActionLimits as { freezeRemaining: number; moveRemaining: number };
  for (let i = 0; i < 8; i++) {
    assert.equal(allowed().freezeRemaining, 1);
    view = env.step(actionId('freeze'));
  }
  assert.equal(allowed().freezeRemaining, 0);
  assert.ok(!view.legalActions.includes(actionId('freeze')));
  assert.deepEqual(view.legalActions, [actionId('end')]);
  const saved = env.snapshot(), restored = new SelfPlayEnv();
  assert.deepEqual(restored.restore(saved), view);
  assert.throws(() => env.step(actionId('freeze')), /Illegal action/);
  assert.deepEqual(env.snapshot(), saved);
  while (env.room.turn === 1) view = env.step(view.legalActions.includes(0) ? 0 : view.legalActions[0]);
  assert.equal(allowed().freezeRemaining, 1); assert.equal(allowed().moveRemaining, 6);
  assert.equal(view.entities[0]!.details.aiActionLimits && (view.entities[0]!.details.aiActionLimits as any).freezeClosing, false);
});

test("entity input retains effect fields and resolves instance links without leaking private state", () => {
  const env = new SelfPlayEnv(); env.reset(10);
  const own = env.room.seats[env.actor].game!, enemy = env.room.seats[(env.actor + 1) % 8].game!;
  own.board = [makeMinion("s14_BG25_001"), makeMinion("s14_BG25_001")];
  own.board[0].counters = { effectA: 2, effectB: 9 };
  own.board[0].extraAbilities = [{ event: "battlecry", op: "buff", attack: 3, health: 5 }];
  own.board[0].remembered = [own.board[1].uid, "private-unknown-uid"];
  const before = structuredClone(observeEntities(own, 0, 64));
  assert.equal(before.length, ENTITY_SCHEMA.count);
  const card = before[OFFSETS[1]]!;
  assert.deepEqual(card.details.counters, { effectA: 2, effectB: 9 });
  assert.deepEqual(card.details.extraAbilities, own.board[0].extraAbilities);
  assert.deepEqual(card.details.remembered, [OFFSETS[1] + 1, -1]);
  enemy.hand = [makeMinion("s14_BG25_001")]; enemy.board = [makeMinion("s14_BG25_001")];
  enemy.board[0].attack = 999999; env.room.pool.s14_BG25_001 = 0;
  assert.deepEqual(observeEntities(own, 0, 64), before);
  own.board[1].uid = "different-instance"; own.board[0].remembered![0] = "different-instance";
  assert.deepEqual(observeEntities(own, 0, 64), before);
  const json = JSON.stringify(before);
  for (const forbidden of ['private-unknown-uid','different-instance','"copies"','"pool"','"initialPool"']) assert.ok(!json.includes(forbidden));
  own.board[0].counters.effectA = 3;
  assert.notDeepEqual(observeEntities(own, 0, 64), before);
});

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

test("a lethal health refresh updates self-play pairings and survives deterministic restore", () => {
  const env = new SelfPlayEnv(); env.reset(42);
  const seat = env.room.seats[env.actor], s = seat.game!;
  s.discovery = []; s.season!.powerChoice = undefined; s.season!.trinketOffers = [];
  s.board = [makeMinion("s14_BG26_524")]; s.gold = 0; s.health = 1; s.season!.armor = 0;
  s.season!.freeRefresh = 0;
  const restored = new SelfPlayEnv(); env.restore(env.snapshot()); restored.restore(env.snapshot());
  const action = actionId("refresh");
  assert.ok(env.legalActions().has(action));
  assert.deepEqual(env.step(action), restored.step(action));
  assert.deepEqual(env.snapshot(), restored.snapshot());
  assert.equal(env.room.seats.filter(p => p.game!.health > 0).length, 7);
  assert.ok(!env.room.pairings!.flat().includes(seat.id));
  assert.equal(env.room.pairings!.filter(([, b]) => b === null).length, 1);
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
    assert.equal(observe(changed, 1, 64).length, 3209);
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
  // Recovered from the historical tape at HEAD before the trinket expansion, just before
  // the final action. Replaying earlier random offers now produces different cards.
  const env = new SelfPlayEnv({ ...chromieReplay.options, aiActionLimits: false });
  env.restore(chromieState as unknown as ReturnType<SelfPlayEnv["snapshot"]>);
  const state = env.step(chromieReplay.actions.at(-1)!);
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


test("extra trinkets from Marin and Buttons remain observable", () => {
  const env = new SelfPlayEnv(); env.reset(45);
  const s = env.room.seats[env.actor].game!;
  s.season!.trinkets = TRINKETS.slice(0, 4).map(t => t.id);
  const input = observeEntities(s, 0, 64);
  assert.deepEqual(input.slice(OFFSETS[11]).map(e => ENTITY_SCHEMA.ids[e!.id - 1]), s.season!.trinkets);
});

test("third-trinket recruit decision remains legal and observable under current rules", () => {
  // The historical GPU tape uses older rules. Recreate its third-trinket boundary directly.
  const env = new SelfPlayEnv(); env.reset(45);
  const seat = env.actor, s = env.room.seats[seat].game!;
  equipPowers(s, ["s14_marin"]);
  s.season!.powerChoice = undefined; s.discovery = [];
  s.season!.trinkets = TRINKETS.slice(0, 2).map(t => t.id);
  s.season!.trinketDone = [5, 6]; s.turn = 8;
  advanceRecruit(s, () => 0.23); env.room.turn = s.turn;
  env.restore(env.snapshot());
  const action = env.view().legalActions.find(id => ACTIONS[id].type === "buyTrinket");
  assert.notEqual(action, undefined);
  env.step(action!);
  const updated = env.room.seats[seat].game!;
  assert.equal(updated.season!.trinkets.length, 3);
  const input = observeEntities(updated, 1, 64);
  assert.equal(input.length, 73);
  assert.deepEqual(input.slice(OFFSETS[11], OFFSETS[11] + 3).map(e => ENTITY_SCHEMA.ids[e!.id - 1]), updated.season!.trinkets);
  assert.equal(observe(updated, 1, 64).length, 3209);
  checkPool(env);
});
