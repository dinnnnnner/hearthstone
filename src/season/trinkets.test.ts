import test from "node:test";
import assert from "node:assert/strict";
import { actSeason, advanceRecruit, assertSeasonPool, createSeason, endEffects, minionUsesHealth, offerTrinkets, seasonCombat, seasonPowerState, seasonTargets, spellUsesHealth, TRINKETS, trinketCost } from "./engine";
import { makeMinion, type Action, type Game } from "../engine";
import { getDef } from "../data";
import { ALL_TRIBES, PREFIX } from "./catalog";
import { damageSeasonHero } from "../ranking";
import dependencies from "./trinket-dependencies.json" with { type: "json" };
function seed(n = 915) { return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; }; }
const rng = seed();
function fixture() { const s = createSeason(PREFIX + "lich", seed(), { tribes: [...ALL_TRIBES] }); s.turn = 6; s.tier = 6; s.gold = 10; return s; }
function add(s: Game, id: string, zone: "board" | "hand" = "board", golden = false) { const m = makeMinion(PREFIX + id, golden); s[zone].push(m); return m; }
function apply(s: Game, action: Action) { const result = actSeason(s, action, rng); assert.equal(result.error, undefined, JSON.stringify(action) + ": " + result.error); assertSeasonPool(result.state); return result.state; }
function buy(s: Game, id: string) { s.season!.trinketOffers = [id]; s.season!.trinketOfferCosts = { [id]: 0 }; return apply(s, { type: "buyTrinket", uid: id }); }
function cast(s: Game, id: string, target?: string) { const m = add(s, id, "hand"); return apply(s, { type: "cast", uid: m.uid, target }); }
function drain(s: Game) {
  for (let i = 0; i < 40; i++) {
    if (s.season!.powerChoice) { s = apply(s, { type: "choosePower", uid: s.season!.powerChoice.offers[0] }); continue; }
    if (s.discovery.length) { const card = s.discovery[0]; s = apply(s, { type: "discover", uid: card.uid, target: seasonTargets(s, card, "cast")[0]?.uid }); continue; }
    if (s.season!.trinketOffers.length) { const id = s.season!.trinketOffers.find((id) => trinketCost(s, id) <= s.gold); if (!id) break; s = apply(s, { type: "buyTrinket", uid: id }); continue; }
    break;
  }
  return s;
}
test("every offered trinket can resolve purchase, discoveries, end turn, combat, and next turn without losing pool cards", () => {
  for (const trinket of TRINKETS) {
    let s = fixture();
    for (const id of ["BG25_001", "BG26_147", "BG31_816", "BG31_818"]) add(s, id);
    try {
      s = drain(buy(s, trinket.id)); endEffects(s, rng); s = drain(s);
      seasonCombat(s, [makeMinion(PREFIX + "BG25_001")], 1, seed());
      assertSeasonPool(s); advanceRecruit(s, rng); s = drain(s); assertSeasonPool(s);
      assert.ok(s.board.length <= 7 && s.hand.length + s.rewards.length <= 10);
      assert.ok([...s.board, ...s.hand].every((m) => Number.isFinite(m.attack) && Number.isFinite(m.health)));
    } catch (error) { throw new Error(trinket.id + " " + trinket.name, { cause: error }); }
  }
});
test("protected trinket cards wait for hand space and flush after a spell is played", () => {
  let s = fixture(); for (let i = 0; i < 10; i++) add(s, "BG28_810", "hand");
  s = buy(s, "BG30_MagicItem_406"); assert.equal(s.hand.length, 10); assert.equal(s.season!.pendingTrinketCards!.length, 1);
  s = apply(s, { type: "cast", uid: s.hand[0].uid });
  assert.equal(s.hand.length, 10); assert.ok(s.hand.some((m) => m.id === PREFIX + "BG28_604")); assert.equal(s.season!.pendingTrinketCards!.length, 0);
});
test("purchase rewards continue merging across a full hand without burning generated copies", () => {
  let s = fixture(); add(s, "BGS_115", "hand"); add(s, "BGS_115", "hand"); for (let i = 0; i < 8; i++) add(s, "BG28_810", "hand");
  s = buy(s, "BG32_MagicItem_831"); s = apply(s, { type: "cast", uid: s.hand.find((m) => m.id === PREFIX + "BG28_810")!.uid });
  assert.ok(s.hand.some((m) => m.id === PREFIX + "BGS_115" && m.golden)); assert.equal(s.season!.pendingTrinketCards!.length, 0);
});
test("double pirate merge retains stats, pool ownership and triple reward", () => {
  let s = fixture(); s.season!.trinkets = ["BG30_MagicItem_439"]; const first = add(s, "BG31_826", "hand"), second = add(s, "BG31_826", "hand"); first.attack += 8; second.health += 4;
  s = apply(s, { type: "freeze" }); const golden = s.hand.find((m) => m.golden)!;
  assert.equal(golden.attack, getDef(golden.id).goldenAttack! + 8); assert.equal(golden.health, getDef(golden.id).goldenHealth! + 4);
  s = apply(s, { type: "play", uid: golden.uid }); assert.deepEqual(s.rewards, [6]);
});
test("duplicated lesser/greater effects stack instead of masking each other", () => {
  const s = fixture(); const m = add(s, "BG25_001"); const before = [m.attack, m.health];
  s.season!.trinkets = ["BG36_MagicItem_302", "BG36_MagicItem_302t"]; s.season!.goldenPlayed = 2;
  endEffects(s, rng); assert.deepEqual([m.attack, m.health], [before[0] + 9, before[1] + 7]);
});
test("Souvenir Stand copies the greater trinket and both purchase effects resolve", () => {
  let s = fixture(); s.season!.trinkets = ["BG30_MagicItem_888"]; s = buy(s, "BG36_MagicItem_363");
  assert.deepEqual(s.season!.trinkets, ["BG36_MagicItem_363", "BG36_MagicItem_363"]);
  assert.equal(s.hand.filter((m) => m.id === PREFIX + "BG36_523" && m.golden).length, 2);
});
test("Mystery Cube uses two free choices and preserves the next-turn replacement", () => {
  let s = buy(fixture(), "BG30_MagicItem_703"); assert.equal(s.season!.trinketOffers.length, 2);
  assert.ok(s.season!.trinketOffers.every((id) => trinketCost(s, id) === 0)); s = drain(s); assert.equal(s.season!.trinkets.length, 1);
  advanceRecruit(s, rng); assert.equal(s.season!.trinketOffers.length, 2); assert.ok(s.season!.trinketOffers.every((id) => trinketCost(s, id) === 0));
});
test("Ornate Clock offers a greater trinket on turn seven and does not offer again on nine", () => {
  let s = buy(fixture(), "BG32_MagicItem_271"); advanceRecruit(s, rng);
  assert.ok(s.season!.trinketOffers.length); assert.ok(s.season!.trinketOffers.every((id) => TRINKETS.find((t) => t.id === id)!.school === "GREATER_TRINKET"));
  s = drain(s); advanceRecruit(s, rng); s = drain(s); advanceRecruit(s, rng); assert.equal(s.season!.trinketOffers.length, 0);
});
test("Trinket health purchases are legal at zero gold and spend armor before health", () => {
  let s = fixture(); s.season!.trinkets = ["BG32_MagicItem_822"]; s.gold = 0; s.season!.armor = 8;
  const spell = makeMinion(PREFIX + "BG28_888"); s.season!.spellShop = [spell]; assert.ok(spellUsesHealth(spell, s));
  s = apply(s, { type: "buySpell", uid: spell.uid }); assert.equal(s.gold, 0); assert.equal(s.season!.armor, 8 - getDef(spell.id).cost!);
  assert.equal(spellUsesHealth(spell, s), false);
});
test("Eye of Sargeras counts purchases since acquisition, not earlier purchases", () => {
  let s = fixture(); s.season!.counters = { boughtCards: 3 }; s = buy(s, "BG30_MagicItem_701");
  assert.equal(minionUsesHealth(s, s.shop[0]), false);
  for (let i = 0; i < 3; i++) { s.season!.spellShop = [makeMinion(PREFIX + "BG28_810")]; s = apply(s, { type: "buySpell", uid: s.season!.spellShop[0].uid }); }
  assert.ok(minionUsesHealth(s, s.shop[0]));
});
test("Ice Block prevents one lethal hit, then is consumed", () => {
  const s = fixture(); s.health = 5; s.season!.armor = 2; s.season!.counters = { iceBlock: 1 };
  damageSeasonHero(s, 7); assert.equal(s.health, 5); assert.equal(s.season!.armor, 2); assert.equal(s.season!.counters.iceBlock, 0);
  damageSeasonHero(s, 7); assert.equal(s.health, 0);
});
test("Sous Chef grants one additional use and returns one gold per use", () => {
  let s = fixture(); s.season!.trinkets = ["BG35_MagicItem_801"]; const m = add(s, "BG25_001");
  assert.equal(seasonPowerState(s).remaining, 2); s.gold = 5;
  s = apply(s, { type: "power", target: m.uid }); assert.equal(s.gold, 6); assert.equal(seasonPowerState(s).remaining, 1);
  s = apply(s, { type: "power", target: m.uid }); assert.equal(s.gold, 7); assert.equal(seasonPowerState(s).remaining, 0);
});
test("Ancient Wishbone doubles Blackthorn without consuming a second use", () => {
  let s = createSeason(PREFIX + "blackthorn", seed(), { tribes: [...ALL_TRIBES] }); s.season!.trinkets = ["BG30_MagicItem_804"];
  s = apply(s, { type: "power" }); assert.equal(s.hand.filter((m) => m.id === PREFIX + "BG20_GEM").length, 4); assert.equal(seasonPowerState(s).remaining, 1);
});
test("Naga-associated tier-seven necklace rotates out in preview", () => {
  assert.ok(!TRINKETS.some(t => t.id === 'BG35_MagicItem_821t'));
});

test("Wax Lance uses actual tier-seven pool and legal Dark Gifts", () => {
  const s = buy(fixture(), "BG36_MagicItem_309"); assert.equal(s.discovery.length, 3); assert.ok(s.discovery.every((m) => getDef(m.id).tier === 7 && m.gift));
});
test("honeycomb bonus grows after targeted casts and resets each turn", () => {
  let s = fixture(); const m = add(s, "BG25_001"); const base = m.attack; s.season!.trinkets = ["BG36_MagicItem_371"];
  s = cast(s, "BG28_897", m.uid); assert.equal(s.board[0].attack, base + 3);
  s = cast(s, "BG28_897", m.uid); assert.equal(s.board[0].attack, base + 7);
  advanceRecruit(s, rng); s = cast(s, "BG28_897", m.uid); assert.equal(s.board[0].attack, base + 10);
});
test("lovely locket recasts once on another friendly minion without looping", () => {
  let s = fixture(); const a = add(s, "BG25_001"), b = add(s, "BG25_001"); const before = a.attack; s.season!.trinkets = ["BG36_MagicItem_211"];
  s = cast(s, "BG28_897", a.uid); assert.equal(s.board.find((m) => m.uid === a.uid)!.attack, before + 2); assert.equal(s.board.find((m) => m.uid === b.uid)!.attack, before + 2);
  assert.equal(s.season!.spellsCast, 2);
});
test("satellite size counts tavern spells, and copies remain protected at full hand", () => {
  let s = fixture(); s.season!.trinkets = ["BG36_MagicItem_810", "BG36_MagicItem_810t"]; s = cast(s, "BG28_810"); s = cast(s, "BG28_810");
  endEffects(s, rng); assert.deepEqual(s.hand.map((m) => [m.attack, m.health]), [[6, 6], [14, 14]]);
});
test("Beatboxer copies Accord-o-Tron magnetization including ongoing gold", () => {
  let s = fixture(); s.season!.trinkets = ["BG35_MagicItem_742"]; const mech = add(s, "BG26_146"), boxer = add(s, "BG26_149"); const before = [mech.attack, boxer.attack];
  endEffects(s, rng); assert.equal(mech.magneticCount, 1); assert.equal(boxer.magneticCount, 2);
  assert.equal(mech.attack, before[0] + getDef(PREFIX + "BG26_147").attack); assert.equal(boxer.attack, before[1] + getDef(PREFIX + "BG26_147").attack * 2);
});
test("Corrupted Tome substitutes the reward when a golden minion is played", () => {
  let s = fixture(); s.season!.trinkets = ["BG35_MagicItem_812"]; const m = add(s, "BG25_001", "hand", true); m.reward = true;
  s = apply(s, { type: "play", uid: m.uid }); assert.equal(s.rewards.length, 0); const prize = s.hand.find((m) => m.id === PREFIX + "BG35_MagicItem_812t")!;
  s = apply(s, { type: "cast", uid: prize.uid }); assert.equal(s.discovery.length, 3); assert.ok(s.discovery.every((m) => m.id.startsWith(PREFIX + "BGS_Treasures_")));
});
test("all timewarp dependency cards have executable abilities and finite combat stats", () => {
  for (const id of dependencies.timewarp) { const s = fixture(); const m = add(s, id); add(s, "BG25_001"); assert.ok(getDef(m.id).playable, id); endEffects(s, seed()); seasonCombat(s, [makeMinion(PREFIX + "BG25_001")], 1, seed()); assertSeasonPool(s); }
});
test("offers respect available tribes, neutral/cheap guarantees, owned exclusion and effective price", () => {
  const s = fixture(); s.season!.tribes = ["鱼人", "机械", "海盗", "亡灵", "龙"]; s.season!.trinkets = ["BG30_MagicItem_406"];
  for (let i = 0; i < 20; i++) { offerTrinkets(s, "LESSER_TRINKET", seed(i)); assert.equal(s.season!.trinketOffers.length, 4); assert.equal(new Set(s.season!.trinketOffers).size, 4); assert.ok(!s.season!.trinketOffers.includes("BG30_MagicItem_406")); assert.ok(s.season!.trinketOffers.some((id) => trinketCost(s, id) <= 2)); }
});
test("Deathly Phylactery repeats only the first deathrattle of each combat", () => {
  const s = fixture(); s.season!.trinkets = ["BG30_MagicItem_700"]; add(s, "BG32_111"); add(s, "BG32_111");
  const enemy = makeMinion(PREFIX + "BG26_146"); enemy.attack = enemy.health = 1000;
  seasonCombat(s, [enemy], 1, seed()); assert.equal(s.hand.filter((m) => m.id === PREFIX + "BG28_888").length, 3);
  seasonCombat(s, [enemy], 1, seed()); assert.equal(s.hand.filter((m) => m.id === PREFIX + "BG28_888").length, 6);
});
test("Avenge resets per combat while death progress without Avenge carries over", () => {
  const s = fixture(); s.season!.trinkets = ["BG30_MagicItem_410", "BG35_MagicItem_302"];
  add(s, "BG26_146"); add(s, "BG26_146");
  const enemy = makeMinion(PREFIX + "BG26_146"); enemy.attack = enemy.health = 1000;
  for (let i = 0; i < 3; i++) seasonCombat(s, [enemy], 1, seed(i));
  assert.equal(s.season!.buffs.gem, undefined); assert.equal(s.hand.length, 1);
});
test("Trip Voucher replaces its own slot exactly two turns after purchase", () => {
  let s = buy(fixture(), "BG30_MagicItem_891"); advanceRecruit(s, rng); assert.equal(s.season!.trinketOffers.length, 0);
  advanceRecruit(s, rng); assert.equal(s.season!.replacingTrinket, 0); assert.equal(s.season!.trinketOffers.length, 4);
  s = drain(s); assert.equal(s.season!.trinkets.length, 1); assert.ok(!s.season!.trinkets.includes("BG30_MagicItem_891"));
});
test("Worn Treasure Map grants ten gold exactly two turns after purchase", () => {
  const s = buy(fixture(), "BG32_MagicItem_428");
  advanceRecruit(s, rng); assert.equal(s.gold, 9); advanceRecruit(s, rng); assert.equal(s.gold, 20);
  advanceRecruit(s, rng); assert.equal(s.gold, 10);
});
test("Ornate Clock, Souvenir Stand and Trip Voucher are mutually exclusive offers", () => {
  const s = fixture(); const ids = ["BG30_MagicItem_888", "BG30_MagicItem_891", "BG32_MagicItem_271"];
  for (let i = 0; i < 100; i++) { offerTrinkets(s, "LESSER_TRINKET", seed(i)); assert.ok(s.season!.trinketOffers.filter((id) => ids.includes(id)).length <= 1); }
});
test("health rewinder, low health, hand size and tavern-buff requirements filter offers", () => {
  const s = fixture(); for (let i = 0; i < 5; i++) add(s, "BG26_146");
  for (let i = 0; i < 100; i++) { offerTrinkets(s, i % 2 ? "LESSER_TRINKET" : "GREATER_TRINKET", seed(i)); for (const id of ["BG35_MagicItem_152", "BG30_MagicItem_701", "BG30_MagicItem_541", "BG35_MagicItem_820", "BG35_MagicItem_815", "BG35_MagicItem_156"]) assert.ok(!s.season!.trinketOffers.includes(id), id); }
});
