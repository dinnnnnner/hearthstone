import { test } from "node:test";
import assert from "node:assert/strict";
import { Rooms, type Room, type Seat } from "./rooms";
function setup(n = 2) {
  let now = 100000,
    seed = 42;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const service = new Rooms(() => now, random);
  const identities = Array.from({ length: n }, (_, i) =>
      service.guest("玩家" + i),
    ),
    guests = identities.map((x) => service.auth(x.token));
  service.create(guests[0], "friends", "s14_lich");
  const room = service.member(guests[0]).r;
  for (const g of guests.slice(1)) {
    service.join(g, room.code);
    service.ready(g, true);
  }
  return {
    service,
    guests,
    room,
    identities,
    advance: (ms: number) => {
      now += ms;
      service.tick();
    },
  };
}
function pool(r: Room) {
  for (const [id, total] of Object.entries(r.initial)) {
    const held = r.seats
      .flatMap((p) =>
        p.game
          ? [
              ...p.game.hand,
              ...p.game.shop,
              ...p.game.board,
              ...p.game.discovery,
            ]
          : [],
      )
      .reduce((n, m) => n + (m.copies[id] || 0), 0);
    assert.equal((r.pool[id] || 0) + held, total, `${id} pool mismatch`);
    assert.ok(r.pool[id] >= 0);
  }
}
function recruit(service: Rooms, room: Room, p: Seat) {
  p.bot = true;
  service.bots(room);
  p.bot = false;
  p.ended = false;
}
test("guest tokens, host permissions, room capacity and late join are enforced", () => {
  const { service, guests, room } = setup(8);
  assert.throws(() => service.auth("bad"));
  assert.throws(() => service.guest(""));
  assert.throws(() => service.start(guests[1]), /房主/);
  const extra = service.auth(service.guest("旁观者").token);
  assert.throws(() => service.join(extra, room.code), /8 人/);
  service.ready(guests[1], false);
  assert.throws(() => service.start(guests[0]), /准备/);
  service.ready(guests[1], true);
  service.start(guests[0]);
  assert.equal(room.seats.length, 8);
  assert.equal(room.seats.filter((p) => p.bot).length, 0);
  assert.throws(() => service.join(extra, room.code), /已经开始/);
  pool(room);
});
test("friends share a finite pool and paired clients receive one mirrored battle", () => {
  const { service, guests, room } = setup(8);
  service.start(guests[0]);
  for (const p of room.seats) recruit(service, room, p);
  pool(room);
  for (const g of guests) service.action(g, { type: "end" }, "end-" + g.id, 1);
  assert.equal(room.stage, "combat");
  for (const p of room.seats) {
    const enemy = room.seats.find((x) => x.name === p.game!.battle!.opponent)!;
    assert.deepEqual(
      p.game!.battle!.frames[0].allies,
      enemy.game!.battle!.frames[0].enemies,
    );
    assert.deepEqual(
      p.game!.battle!.frames.at(-1)!.enemies,
      enemy.game!.battle!.frames.at(-1)!.allies,
    );
    assert.equal(p.game!.battle!.damage, enemy.game!.battle!.damage);
  }
  pool(room);
});
test("bots recruit through legal actions, pool survives rounds, duplicate requests cannot buy twice", () => {
  const { service, guests, room } = setup(1);
  service.start(guests[0]);
  assert.equal(room.seats.filter((p) => p.bot).length, 7);
  assert.ok(
    room.seats.filter((p) => p.bot).every((p) => p.game!.board.length > 0),
  );
  const p = room.seats[0],
    offer = p.game!.shop[0];
  service.action(guests[0], { type: "buy", uid: offer.uid }, "same-buy", 1);
  const gold = p.game!.gold;
  service.action(guests[0], { type: "buy", uid: offer.uid }, "same-buy", 1);
  assert.equal(p.game!.gold, gold);
  pool(room);
  for (let i = 0; i < 10 && room.stage !== "finished"; i++) {
    if (p.game!.health <= 0) break;
    recruit(service, room, p);
    pool(room);
    service.action(guests[0], { type: "end" }, "e" + i, room.turn);
    pool(room);
    if (p.game!.health <= 0) break;
    service.action(guests[0], { type: "continue" }, "c" + i, room.turn);
    pool(room);
  }
  assert.ok(room.turn > 2);
});
test("state hides other hands, restart restores tokens and rooms, timeout advances absent players", () => {
  const { service, guests, room, identities, advance } = setup();
  service.start(guests[0]);
  const view = service.view(guests[0]);
  const other = room.seats[1].game!;
  assert.ok(!JSON.stringify(view).includes(other.shop[0].uid));
  assert.ok(view.game!.opponents.every((o) => o.board.length === 0));
  const resumed = new Rooms();
  resumed.restore(service.dump());
  assert.equal(
    resumed.view(resumed.auth(identities[0].token)).room!.code,
    room.code,
  );
  advance(90001);
  assert.equal(room.stage, "combat");
  advance(120001);
  assert.equal(room.turn, 2);
  pool(room);
});
test("host transfer, forfeit and room cleanup do not strand remaining players", () => {
  const { service, guests, room } = setup();
  service.leave(guests[0]);
  assert.equal(room.host, guests[1].id);
  service.start(guests[1]);
  service.leave(guests[1]);
  assert.equal(service.rooms.size, 0);
  assert.equal(guests[1].room, undefined);
});
test("external opponent gets its own hero combat power rather than the first player’s", async () => {
  const { createSeason, seasonCombat } = await import("../src/season/engine");
  const { makeMinion } = await import("../src/engine");
  const a = createSeason("s14_lich"),
    b = createSeason("s14_alakir");
  a.board = [makeMinion("s14_BG25_001")];
  b.board = [makeMinion("s14_BG25_001")];
  a.board[0].health = 20;
  b.board[0].health = 20;
  const battle = seasonCombat(a, b.board, 1, () => 0.4, b);
  const start = battle.frames[1];
  assert.ok(start.enemies[0].keywords.includes("圣盾"));
  assert.ok(start.enemies[0].keywords.includes("风怒"));
  assert.ok(!start.allies[0].keywords.includes("风怒"));
});
