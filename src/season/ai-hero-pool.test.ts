import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_HERO_POOL, AI_SEASON_HEROES, HERO_TRIBES } from "./catalog";
import { createSeason } from "./engine";
import { Rooms } from "../../server/rooms";

const allowed = new Set(AI_HERO_POOL.heroes.map(h => h.id));
class HeroSelectionRooms extends Rooms {
  override bots() {} // Hero assignment tests do not need automated recruit actions.
}
function check(heroes: string[], human: string) {
  assert.equal(heroes.length, 7);
  assert.equal(new Set([...heroes, human]).size, 8);
  assert.ok(heroes.every(h => allowed.has(h)));
}
test("one shared pool contains 14 implemented heroes compatible with five tribes", () => {
  assert.equal(allowed.size, 14);
  assert.deepEqual(new Set(AI_SEASON_HEROES.map(h => h.id)), allowed);
  assert.ok(new Set(AI_SEASON_HEROES.map(h => HERO_TRIBES[h.id]).filter(Boolean)).size <= 5);
});
test("offline practice opponents use the pool, while the human can choose any hero", () => {
  for (const human of ["s14_genn", "s14_reno"]) {
    for (let seed = 1; seed <= 5; seed++) {
      let state = seed;
      const game = createSeason(human, () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2**32));
      assert.equal(game.hero, human);
      check(game.opponents.map(p => p.hero), human);
    }
  }
});
test("online free choice, draft and friend-room bot filling use the same pool", () => {
  for (const kind of ["ai", "friends"] as const) {
    for (const selection of ["free", "draft"] as const) {
      const service = new HeroSelectionRooms();
      const guest = service.auth(service.guest("英雄池测试").token);
      const room = service.create(guest, kind, "s14_reno", "training", selection);
      if (selection === "draft") service.hero(guest, room.seats[0].heroOffers![0]);
      if (room.stage === "waiting") service.start(guest);
      check(room.seats.filter(p => p.bot).map(p => p.hero), room.seats[0].hero);
      if (selection === "free") assert.equal(room.seats[0].hero, "s14_reno");
    }
  }
});
test("friend room reserves every human's choice before assigning bot heroes", () => {
  const service = new HeroSelectionRooms();
  const host = service.auth(service.guest("房主").token);
  const room = service.create(host, "friends", "s14_genn", "training", "free");
  const friend = service.auth(service.guest("朋友").token);
  service.join(friend, room.code);
  service.hero(friend, "s14_marin");
  service.ready(friend, true);
  service.start(host);
  assert.equal(new Set(room.seats.map(p => p.hero)).size, 8);
  assert.equal(room.seats.filter(p => p.bot).length, 6);
  assert.ok(room.seats.filter(p => p.bot).every(p => allowed.has(p.hero)));
});
