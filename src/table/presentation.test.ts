import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMinion } from "../engine";
import { changesBetween } from "./presentation";
test("snapshot differences distinguish damage, shields, buffs, summons and death without changing rules state", () => {
  const a = makeMinion("BOT_445"),
    b = makeMinion("BOT_445");
  a.keywords = ["圣盾"];
  b.health = 8;
  const before = [a, b],
    copy = structuredClone(before),
    after = structuredClone(before);
  after[0].keywords = [];
  after[0].attack += 2;
  after[1].health = -1;
  const c = makeMinion("BOT_445");
  after.push(c);
  const changes = changesBetween(before, after);
  assert.equal(changes[0].shieldBroken, true);
  assert.equal(changes[0].damage, 0);
  assert.equal(changes[0].attack, 2);
  assert.equal(changes[1].damage, 9);
  assert.equal(changes[1].dead, true);
  assert.equal(changes[2].spawned, true);
  assert.equal(changes[2].damage, 0);
  assert.deepEqual(before, copy);
  const removed = changesBetween(after, [after[0], c]).find(
    (x) => x.uid === b.uid,
  )!;
  assert.equal(removed.dead, true);
  assert.equal(removed.damage, 0);
});
