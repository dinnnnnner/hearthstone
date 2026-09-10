import { test } from "node:test";
import assert from "node:assert/strict";
import { Rooms, OFFLINE_GRACE_MS, type Room, type Seat } from "./rooms";
import { makeMinion } from "../src/engine";
import { equipPowers } from "../src/season/powers";
function setup(n = 2, mode: Room["mode"] = "timed") {
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
  service.create(guests[0], "friends", "s14_lich", mode);
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
test("Scabbs discovers the paired warband without exposing it in the player snapshot", () => {
  const { service, guests, room } = setup(2); service.start(guests[0]);
  const seat = room.seats[0], pair = room.pairings!.find((p) => p.includes(seat.id))!;
  const enemy = room.seats.find((p) => p.id === pair.find((id) => id !== seat.id))!;
  // Return the normal board before installing a generated test body.
  for (const m of enemy.game!.board) for (const [id, n] of Object.entries(m.copies)) room.pool[id] += n;
  enemy.game!.board = [makeMinion("s14_BG35_883")];
  equipPowers(seat.game!, ["s14_scabbs"]); seat.game!.gold = 10;
  assert.equal(service.apply(room, seat, { type: "power", powerId: "s14_scabbs" }), undefined);
  assert.equal(seat.game!.discovery[0].id, "s14_BG35_883");
  assert.deepEqual(seat.game!.discovery[0].copies, {});
  assert.ok(service.view(guests[0]).game!.opponents.every((o) => o.board.length === 0));
  pool(room);
});
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

test("a bot killed by its own health refresh is ranked and releases every held card once", () => {
  const { service, guests, room } = setup(2);
  service.start(guests[0]);
  const p = room.seats.find((p) => p.bot)!;
  p.game!.hand.push(...p.game!.board);
  p.game!.board = [
    "s14_BG26_524",
    ...Object.keys(room.initial)
      .filter((id) => id !== "s14_BG26_524")
      .slice(0, 6),
  ].map((id) => makeMinion(id));
  p.game!.health = 1;
  p.game!.season!.armor = 0;
  p.game!.season!.freeRefresh = 0;
  p.game!.gold = 1;
  p.game!.powerUsed = true;
  p.game!.season!.healthRefreshes = 0;
  p.game!.tier = 6;
  p.ended = false;
  pool(room);
  service.bots(room);
  assert.equal(p.game!.health, 0);
  assert.equal(p.place, 8);
  assert.equal(
    p.game!.shop.length + p.game!.board.length + p.game!.hand.length,
    0,
  );
  pool(room);
  service.bots(room);
  service.fight(room);
  assert.equal(p.place, 8);
  pool(room);
});

test("six abandoned games release capacity after the last human's grace period despite auto rounds", () => {
  const { service, guests, advance } = setup(1);
  service.start(guests[0]);
  for (let i = 0; i < 5; i++) {
    const g = service.auth(service.guest("离线" + i).token);
    service.create(g, "ai", "s14_lich");
  }
  for (let i = 0; i < OFFLINE_GRACE_MS / 1000 - 1; i++) advance(1000);
  assert.equal(service.rooms.size, 6);
  advance(1001);
  assert.equal(service.rooms.size, 0);
  assert.ok([...service.guests.values()].every((g) => !g.room));
  service.create(guests[0], "ai", "s14_lich");
  assert.equal(service.member(guests[0]).r.stage, "recruit");
});

test("one returning guest keeps the room and heartbeat survives a saved restart", () => {
  const { service, guests, room, identities, advance } = setup(2);
  service.start(guests[0]);
  advance(OFFLINE_GRACE_MS - 10000);
  const seq = service.seq;
  service.auth(identities[1].token);
  assert.ok(service.seq > seq);
  const resumed = new Rooms(service.now);
  resumed.restore(service.dump());
  advance(20000);
  resumed.tick();
  assert.ok(service.rooms.has(room.code));
  assert.ok(resumed.rooms.has(room.code));
  advance(OFFLINE_GRACE_MS);
  assert.equal(service.rooms.size, 0);
});

test("the opponent shown throughout recruit is the actual opponent for consecutive rounds", () => {
  const { service, guests, room } = setup(8);
  service.start(guests[0]);
  for (let turn = 1; turn <= 3; turn++) {
    for (const p of room.seats) service.autoChoices(room, p);
    const shown = room.seats.map(
      (p) => p.game!.opponents[p.game!.nextOpponent].name,
    );
    for (const g of guests)
      service.action(g, { type: "end" }, "end" + turn, turn);
    assert.deepEqual(
      room.seats.map((p) => p.game!.battle!.opponent),
      shown,
    );
    for (const g of guests)
      service.action(g, { type: "continue" }, "next" + turn, turn);
  }
});

test("a mid-recruit forfeit changes only its paired opponent to a ghost", () => {
  const { service, guests, room } = setup(8);
  service.start(guests[0]);
  for (const p of room.seats) service.autoChoices(room, p);
  const shown = room.seats.map(
    (p) => p.game!.opponents[p.game!.nextOpponent].name,
  );
  service.leave(guests[7]);
  const opponents = room.seats[0].game!.opponents;
  assert.equal(new Set(opponents.map((o) => o.hero)).size, 7);
  assert.equal(opponents.filter((o) => o.health > 0).length, 6);
  assert.equal(
    room.seats[0].game!.opponents[room.seats[0].game!.nextOpponent].name,
    "幽灵阵容",
  );
  for (const g of guests.slice(0, 7))
    service.action(g, { type: "end" }, "end", 1);
  assert.equal(room.seats[0].game!.battle!.opponent, "幽灵阵容");
  for (let i = 1; i < 7; i++)
    assert.equal(room.seats[i].game!.battle!.opponent, shown[i]);
  pool(room);
});

test("known replays omit frames; unrelated ready updates preserve game version; restart restores full replay", () => {
  const { service, guests, room, identities } = setup(8);
  service.start(guests[0]);
  for (const p of room.seats) service.autoChoices(room, p);
  for (const g of guests) service.action(g, { type: "end" }, "end", 1);
  const first = service.view(guests[0]);
  assert.ok(first.battleId);
  assert.ok(first.game!.battle!.frames.length);
  service.action(guests[1], { type: "continue" }, "next", 1);
  const update = service.view(guests[0], first.battleId);
  assert.equal(update.game!.battle!.frames.length, 0);
  assert.equal(update.gameVersion, first.gameVersion);
  assert.notEqual(update.version, first.version);
  assert.ok(
    service.view(guests[0], "another-player-battle").game!.battle!.frames
      .length,
  );
  service.dump(); // Populate the per-room snapshot cache before another mutation.
  service.action(guests[2], { type: "continue" }, "next", 1);
  const resumed = new Rooms(service.now);
  resumed.restore(service.dump());
  const restored = resumed.view(resumed.auth(identities[0].token));
  assert.equal(restored.battleId, first.battleId);
  assert.deepEqual(
    restored.game!.battle!.frames,
    JSON.parse(JSON.stringify(first.game!.battle!.frames)),
  );
  assert.equal(restored.room!.seats[2].continued, true);
  assert.deepEqual(
    resumed.member(resumed.auth(identities[0].token)).r.pairings,
    room.pairings,
  );
});

test("legacy saves gain planned opponents and settle previously unranked dead bots", () => {
  const { service, guests, room } = setup(8);
  service.start(guests[0]);
  const raw = JSON.parse(service.dump());
  delete raw.rooms[0].pairings;
  delete raw.rooms[0].gameRev;
  delete raw.rooms[0].storageRev;
  for (const g of raw.guests) g.seen -= OFFLINE_GRACE_MS * 2;
  const dead = raw.rooms[0].seats[7];
  dead.bot = true;
  dead.game.health = 0;
  dead.game.phase = "over";
  const resumed = new Rooms(service.now);
  resumed.restore(JSON.stringify(raw));
  const restored = resumed.rooms.get(room.code)!;
  assert.equal(restored.seats[7].place, 8);
  assert.equal(restored.seats[7].game!.shop.length, 0);
  assert.equal(restored.pairings!.length, 4);
  resumed.tick();
  assert.ok(resumed.rooms.has(room.code));
  pool(restored);
  const again = new Rooms(service.now);
  again.restore(resumed.dump());
  pool(again.rooms.get(room.code)!);
});


test("expanded hero room preserves required tribes, two-use powers and golden ownership after restart", () => {
  const { service, guests, room, identities } = setup(8);
  const heroes = ["xyrella", "reno", "elise", "alexstrasza", "blackthorn", "inge", "millhouse", "chenvaala"];
  room.seats.forEach((p, i) => { p.hero = "s14_" + ["lich", "george", "patchwerk", "pyramid", "millificent", "nozdormu", "omu", "alakir"][i]; });
  heroes.forEach((key, i) => service.hero(guests[i], "s14_" + key));
  guests.slice(1).forEach((g) => service.ready(g, true));
  service.start(guests[0]);
  assert.equal(room.tribes.length, 5);
  for (const race of ["龙", "野猪人", "元素"]) assert.ok(room.tribes.includes(race as any));
  const xyrella = room.seats[0], target = xyrella.game!.shop[0];
  service.action(guests[0], { type: "power", target: target.uid }, "take", 1);
  assert.equal(xyrella.game!.hand[0].attack, 2);
  assert.equal(xyrella.game!.hand[0].health, 2);
  const reno = room.seats[1], offer = reno.game!.shop[0];
  service.action(guests[1], { type: "buy", uid: offer.uid }, "buy", 1);
  service.action(guests[1], { type: "play", uid: offer.uid }, "play", 1);
  service.action(guests[1], { type: "power", target: offer.uid }, "golden", 1);
  assert.ok(reno.game!.board[0].golden);
  service.action(guests[4], { type: "power" }, "gems1", 1);
  service.action(guests[4], { type: "power" }, "gems2", 1);
  assert.throws(() => service.action(guests[4], { type: "power" }, "gems3", 1));
  pool(room);
  const resumed = new Rooms(); resumed.restore(service.dump());
  const guest = resumed.auth(identities[4].token);
  const restored = resumed.member(guest).p.game!;
  assert.equal(restored.season!.heroPowerUsesTurn, 2);
  assert.equal(restored.hand.length, 4);
  assert.throws(() => resumed.action(guest, { type: "power" }, "gems-after-restore", 1));
  pool(resumed.member(guest).r);
});
test("bots use new heroes with valid targets and both Inge charges without stranding the first turn", () => {
  const { service, guests, room } = setup(8);
  const heroes = ["chenvaala", "xyrella", "reno", "elise", "alexstrasza", "blackthorn", "inge", "millhouse"];
  room.seats.forEach((p, i) => { p.hero = "s14_" + ["lich", "george", "patchwerk", "pyramid", "millificent", "nozdormu", "omu", "alakir"][i]; });
  heroes.forEach((key, i) => service.hero(guests[i], "s14_" + key));
  room.seats.slice(1).forEach((p) => { p.bot = true; p.ready = true; });
  service.start(guests[0]);
  assert.ok(room.seats.slice(1).every((p) => p.game!.board.length > 0));
  assert.equal(room.seats[1].game!.season!.heroPowerUses, 1);
  assert.ok(room.seats[2].game!.board[0].golden);
  assert.equal(room.seats[6].game!.season!.heroPowerUsesTurn, 2);
  pool(room);
});


test("zero-gold health refresh can eliminate a room player and returns their pool copies", () => {
  const { service, guests, room } = setup(8);
  service.start(guests[0]);
  const p = room.seats[0], id = "s14_BG26_524";
  if (room.pool[id] === undefined) { room.pool[id] = 11; room.initial[id] = 11; }
  const prince = makeMinion(id, false, true);
  room.pool[id]--; p.game!.board.push(prince);
  p.game!.gold = 0; p.game!.health = 1; p.game!.season!.armor = 0;
  service.action(guests[0], { type: "refresh" }, "lethal-health-refresh", room.turn);
  assert.equal(p.game!.health, 0);
  assert.equal(p.place, 8);
  assert.equal(p.game!.board.length, 0);
  pool(room);
});

test("Finley choices survive room restore, gate ready actions, and validate ownership on the server", () => {
  const { service, guests, room, identities } = setup(2);
  room.seats[0].hero = "s14_finley";
  service.start(guests[0]);
  const offers = room.seats[0].game!.season!.powerChoice!.offers;
  assert.throws(() => service.action(guests[0], { type: "end" }, "end-pending", 1), /选择/);
  const restored = new Rooms(service.now);
  restored.restore(service.dump());
  const guest = restored.auth(identities[0].token);
  assert.deepEqual(restored.view(guest).game!.season!.powerChoice!.offers, offers);
  assert.throws(() => restored.action(guest, { type: "choosePower", uid: "s14_genn" }, "forged", 1), /候选/);
  restored.action(guest, { type: "choosePower", uid: offers[0] }, "choice", 1);
  assert.deepEqual(restored.view(guest).game!.season!.powers, [offers[0]]);
  assert.equal(restored.view(guest).game!.hero, "s14_finley");
  assert.throws(() => restored.action(guest, { type: "power", powerId: "s14_genn" }, "forged-power", 1), /没有/);
  pool(restored.member(guest).r);
});

test("bots and timeout auto-selection settle Nguyen and both Genn discoveries without blocking combat", () => {
  const { service, guests, room, advance, identities } = setup(2);
  room.seats[0].hero = "s14_genn"; room.seats[1].hero = "s14_nguyen";
  service.start(guests[0]);
  for (let turn = 1; turn <= 4; turn++) {
    assert.ok(room.seats[1].game!.season!.powerChoice);
    if (turn === 4) assert.ok(room.seats[0].game!.season!.powerChoice);
    for (const identity of identities) service.auth(identity.token);
    advance(90001);
    assert.equal(room.stage, "combat");
    for (const p of room.seats) assert.equal(p.game!.season!.powerChoice, undefined);
    pool(room);
    if (turn === 4) assert.equal(room.seats[0].game!.season!.powers!.length, 2);
    for (const g of guests) service.action(g, { type: "continue" }, `continue-${turn}`, turn);
  }
});

test("training rooms wait for all humans in recruit and combat and retain mode on restore", () => {
  const { service, guests, room, advance, identities } = setup(2, "training");
  service.start(guests[0]);
  assert.equal(room.deadline, 0);
  advance(100000);
  assert.equal(room.stage, "recruit");
  service.action(guests[0], { type: "end" }, "training-end-1", 1);
  assert.equal(room.stage, "recruit");
  service.action(guests[1], { type: "end" }, "training-end-2", 1);
  assert.equal(room.stage, "combat");
  assert.equal(room.deadline, 0);
  advance(130000);
  assert.equal(room.stage, "combat");
  service.action(guests[0], { type: "continue" }, "training-next-1", 1);
  assert.equal(room.stage, "combat");
  service.action(guests[1], { type: "continue" }, "training-next-2", 1);
  assert.equal(room.turn, 2);
  assert.equal(room.deadline, 0);
  const restored = new Rooms(service.now, service.random);
  restored.restore(service.dump());
  const guest = restored.auth(identities[0].token);
  assert.equal(restored.view(guest).room!.mode, "training");
  assert.equal(restored.view(guest).room!.deadline, 0);
  restored.tick();
  assert.equal(restored.member(guest).r.stage, "recruit");
  pool(restored.member(guest).r);
});

test("training keeps an online room without a turn deadline but reclaims it after everyone disconnects", () => {
  const { service, guests, room, advance, identities } = setup(1, "training");
  service.start(guests[0]);
  for (let minute = 0; minute < 130; minute++) {
    service.auth(identities[0].token);
    advance(60000);
  }
  assert.equal(service.rooms.get(room.code)?.stage, "recruit");
  advance(OFFLINE_GRACE_MS);
  assert.equal(service.rooms.size, 0);
  assert.equal(guests[0].room, undefined);
});

test("legacy rooms retain the timed deadline and invalid mode cannot create a room", () => {
  const { service, guests, room, identities } = setup(1);
  service.start(guests[0]);
  const data = JSON.parse(service.dump());
  delete data.rooms[0].mode;
  let now = service.now();
  const restored = new Rooms(() => now, service.random);
  restored.restore(JSON.stringify(data));
  const guest = restored.auth(identities[0].token);
  assert.equal(restored.view(guest).room!.mode, "timed");
  assert.equal(restored.view(guest).room!.deadline, room.deadline);
  now = room.deadline;
  restored.tick();
  assert.equal(restored.member(guest).r.stage, "combat");
  const fresh = restored.auth(restored.guest("错误模式").token);
  assert.throws(() => restored.create(fresh, "ai", "s14_lich", "invalid" as Room["mode"]), /无效对局模式/);
  assert.equal(fresh.room, undefined);
});

test("eight players reserve distinct four-hero offers across repeated slot refreshes", () => {
  const service = new Rooms(() => 100000, () => .37);
  const guests = Array.from({ length: 8 }, (_, i) => service.auth(service.guest(`选将${i}`).token));
  const room = service.create(guests[0], "friends", "s14_lich", "timed", "draft");
  for (const g of guests.slice(1)) service.join(g, room.code);
  const unique = () => {
    const offers = room.seats.flatMap((p) => p.heroOffers!);
    assert.equal(offers.length, 32);
    assert.equal(new Set(offers).size, 32);
    for (const p of room.seats) if (p.hero) assert.ok(p.heroOffers!.includes(p.hero));
  };
  unique();
  assert.throws(() => service.start(guests[0]), /选择英雄/);
  assert.throws(() => service.ready(guests[1], true), /选择英雄/);
  assert.throws(() => service.hero(guests[0], room.seats[1].heroOffers![0]), /候选/);
  for (let i = 0; i < 128; i++) {
    const index = i % 8, slot = Math.floor(i / 8) % 4, p = room.seats[index];
    const previous = [...p.heroOffers!];
    service.hero(guests[index], previous[slot]);
    service.ready(guests[index], true);
    service.refreshHero(guests[index], slot, previous[slot]);
    assert.equal(p.hero, "");
    assert.equal(p.ready, false);
    assert.notEqual(p.heroOffers![slot], previous[slot]);
    for (let j = 0; j < 4; j++) if (j !== slot) assert.equal(p.heroOffers![j], previous[j]);
    const after = [...p.heroOffers!];
    assert.throws(() => service.refreshHero(guests[index], slot, previous[slot]), /已更新/);
    assert.deepEqual(p.heroOffers, after);
    unique();
  }
  const view = service.view(guests[0]).room!;
  assert.deepEqual(view.heroOffers, room.seats[0].heroOffers);
  assert.ok(view.seats.every((p) => !("heroOffers" in p)));
  const released = [...room.seats[7].heroOffers!];
  service.leave(guests[7]);
  assert.ok(released.every((id) => service.availableHeroes(room).some((h) => h.id === id)));
  for (const [i, g] of guests.slice(0, 7).entries()) {
    service.hero(g, room.seats[i].heroOffers![0]);
    service.ready(g, true);
  }
  service.start(guests[0]);
  assert.equal(new Set(room.seats.map((p) => p.hero)).size, 8);
  assert.ok(room.seats.every((p) => !p.heroOffers));
  assert.throws(() => service.refreshHero(guests[0], 0, released[0]), /不能刷新/);
});

test("draft AI waits for selection, saves offers and redraws them on rematch; old rooms stay free choice", () => {
  const service = new Rooms(() => 100000, () => .37);
  const identity = service.guest("四选一恢复"), guest = service.auth(identity.token);
  const room = service.create(guest, "ai", "s14_lich", "training", "draft");
  assert.equal(room.stage, "waiting");
  assert.equal(room.seats.length, 1);
  service.hero(guest, room.seats[0].heroOffers![2]);
  const before = service.view(guest).room!;
  const restored = new Rooms(service.now, service.random);
  restored.restore(service.dump());
  const g = restored.auth(identity.token), r = restored.member(g).r;
  assert.equal(r.heroSelection, "draft");
  assert.deepEqual(restored.view(g).room!.heroOffers, before.heroOffers);
  assert.equal(r.seats[0].hero, room.seats[0].hero);
  restored.start(g);
  assert.equal(r.stage, "recruit");
  assert.equal(new Set(r.seats.map((p) => p.hero)).size, 8);
  r.stage = "finished";
  restored.rematch(g);
  assert.equal(r.stage, "waiting");
  assert.equal(r.seats[0].hero, "");
  assert.equal(r.seats[0].heroOffers!.length, 4);
  assert.equal(new Set(r.seats[0].heroOffers).size, 4);
  const old = JSON.parse(service.dump());
  delete old.rooms[0].heroSelection;
  restored.restore(JSON.stringify(old));
  assert.equal(restored.member(restored.auth(identity.token)).r.heroSelection, "free");
});

test("Finley may discover and use the power of another hero already seated in the same room", () => {
  let matched = false;
  for (let seed = 1; seed <= 100 && !matched; seed++) {
    let value = seed;
    const service = new Rooms(() => 100000, () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 2 ** 32;
    });
    const guest = service.auth(service.guest("芬利共享技能").token);
    const room = service.create(guest, "ai", "s14_finley");
    const p = room.seats[0];
    const overlap = p.game!.season!.powerChoice!.offers.find((id) => room.seats.some((other) => other.id !== p.id && other.hero === id));
    if (!overlap) continue;
    const identities = room.seats.map((p) => p.hero);
    service.action(guest, { type: "choosePower", uid: overlap }, "finley-overlap", 1);
    assert.equal(p.game!.season!.powerChoice, undefined);
    assert.deepEqual(p.game!.season!.powers, [overlap]);
    assert.deepEqual(room.seats.map((p) => p.hero), identities);
    matched = true;
  }
  assert.equal(matched, true, "Expected a naturally dealt Finley power matching an occupied hero");
});
