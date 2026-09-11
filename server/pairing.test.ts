import test from "node:test";
import assert from "node:assert/strict";
import { roundRobinPairings, createPairingCycle, cyclePairings, type Pair } from "./pairing";

test("eight seats face seven unique opponents and repeat the exact schedule from round eight", () => {
  const members = Array.from({ length: 8 }, (_, i) => String(i));
  const seen = new Map(members.map(id => [id, new Set<string>()]));
  for (let round = 0; round < 7; round++) {
    const pairs = roundRobinPairings(members, round);
    assert.equal(new Set(pairs.flat()).size, 8);
    for (const [a, b] of pairs) {
      assert.ok(b && a !== b);
      assert.ok(!seen.get(a)!.has(b));
      seen.get(a)!.add(b); seen.get(b)!.add(a);
    }
    assert.deepEqual(roundRobinPairings(members, round + 7), pairs);
    assert.deepEqual(roundRobinPairings(members, round + 14), pairs);
  }
  for (const opponents of seen.values()) assert.equal(opponents.size, 7);
});
test("even survivor groups restart a complete shorter rotation", () => {
  for (const n of [2, 4, 6]) {
    const members = Array.from({ length: n }, (_, i) => String(i));
    const pairs = new Set<string>();
    for (let round = 0; round < n - 1; round++) for (const pair of roundRobinPairings(members, round)) {
      const key = pair.sort().join(":");
      assert.ok(!pairs.has(key)); pairs.add(key);
    }
    assert.equal(pairs.size, n * (n - 1) / 2);
  }
});
test("odd pairings keep the ghost among eligible bottom seats and never repeat a living opponent immediately", () => {
  for (const n of [3, 5, 7]) {
    const members = Array.from({ length: n }, (_, i) => String(i));
    const cycle = createPairingCycle(members, 8);
    let previous: Pair[] = [];
    for (let turn = 8; turn < 40; turn++) {
      const bottom = [...members.slice(turn % n), ...members.slice(0, turn % n)].slice(-3);
      const pairs = cyclePairings(cycle, turn, bottom, () => .37, previous);
      assert.deepEqual(pairs.flat().filter(id => id !== null).sort(), [...members].sort());
      assert.equal(pairs.filter(([, b]) => !b).length, 1);
      assert.ok(bottom.includes(pairs.find(([, b]) => !b)![0]));
      const old = new Set(previous.filter(([, b]) => b).map(p => [...p].sort().join(":")));
      assert.ok(pairs.filter(([, b]) => b).every(p => !old.has([...p].sort().join(":"))));
      const saved = JSON.parse(JSON.stringify(cycle));
      assert.deepEqual(cyclePairings(saved, turn, bottom, () => .99, previous), pairs);
      previous = pairs;
    }
  }
});
test("rebuilding an even survivor cycle avoids last round's opponents, except in the final two", () => {
  const previous: Pair[] = [["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]];
  const cycle = createPairingCycle(["a", "b", "c", "d", "e", "f"], 5);
  const next = cyclePairings(cycle, 5, [], () => .2, previous);
  const old = new Set(previous.map(p => p.join(":")));
  assert.ok(next.every(p => !old.has(p.join(":"))));
  assert.deepEqual(cyclePairings(createPairingCycle(["a", "b"], 5), 5, [], () => 0, previous), [["a", "b"]]);
});
