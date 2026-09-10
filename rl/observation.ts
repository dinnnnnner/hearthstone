import { ALL_CARDS, getDef } from "../src/data";
import { type Game, type Minion, heroPowerState } from "../src/engine";
import { ALL_TRIBES, SEASON_HEROES } from "../src/season/catalog";
import { TRINKETS, minionCost, spellCost, refreshPayment } from "../src/season/engine";
import { equippedPowers } from "../src/season/powers";
import { LIMITS, assertActionBounds } from "./actions";

export const CARD_IDS = [...new Set(ALL_CARDS.map(c => c.id))].sort();
export const HERO_IDS = SEASON_HEROES.map(h => h.id).sort();
const cardIds = new Map(CARD_IDS.map((id, i) => [id, (i + 1) / CARD_IDS.length]));
const heroId = (id: string) => (HERO_IDS.indexOf(id) + 1) / HERO_IDS.length;
const keywords = ["嘲讽", "圣盾", "复生", "剧毒", "风怒", "烈毒", "潜行"];
const scale = (n: number, unit = 100) => Math.tanh((Number.isFinite(n) ? n : 0) / unit);
export function counterFeatures(values: Record<string, number> = {}, size = 32) {
  const buckets = Array(size).fill(0);
  for (const [key, value] of Object.entries(values)) {
    let hash = 2166136261;
    for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
    buckets[hash % size] += Number.isFinite(value) ? value : 0;
  }
  return buckets.map(v => scale(v));
}
function card(m: Minion | undefined, s: Game): number[] {
  if (!m) return Array(50).fill(0);
  const d = getDef(m.id);
  const id = cardIds.get(m.id);
  if (id === undefined) throw Error(`Unknown observation card ${m.id}`);
  const values = [1, id, scale(m.attack), scale(m.health), d.tier / 6, +m.golden, +(d.kind === "spell"), +(!!d.magnetic),
    +(!!m.activated), Math.min(1, Math.max(0, (m.lockedUntil || 0) - s.turn) / 10), Math.min(1, (m.lockedTier || 0) / 6),
    +(!!m.tempSpell), +(!!m.expires), +(!!m.reward), +(!!m.rebornNext), scale(m.magneticCount || 0, 10),
    scale(m.gems?.attack || 0), scale(m.gems?.health || 0), scale(d.cost || 0, 10), scale(d.activateCost || 0, 10),
    ...keywords.map(k => +m.keywords.includes(k as never)),
    ...ALL_TRIBES.map(t => +(d.tribe === "全部" || d.tribe === t || !!d.races?.includes(t))),
    ...counterFeatures(m.counters, 8), +(!!m.bothChoices), +(!!m.gift),
    scale(m.extraAbilities?.length || 0, 10), scale(m.temporary?.attack || 0), scale(m.temporary?.health || 0)];
  if (values.length !== 50) throw Error(`Card encoding size ${values.length}`);
  return values;
}
/** Allowlisted player information only; no pool counts, opponent hands or current boards. */
export function observe(s: Game, stepsInTurn: number, turnLimit: number): number[] {
  assertActionBounds(s);
  const st = s.season!, payment = refreshPayment(s);
  const result = [s.turn / 50, s.tier / 6, scale(s.gold, 10), scale(st.maxGold, 10), scale(s.health, 40), scale(st.armor, 40),
    scale(s.upgrade, 10), +s.frozen, heroId(s.hero), scale(s.triples, 10), scale(s.purchases, 20), scale(s.refreshes, 20),
    st.giftsUsed / 3, +(st.giftUsedTurn === s.turn), Math.min(1, stepsInTurn / turnLimit), scale(payment.gold, 10),
    scale(payment.health, 10), scale(payment.remaining, 5), scale(st.spellDiscount, 10), scale(st.nextGold, 10),
    ...ALL_TRIBES.map(t => +st.tribes.includes(t)), ...counterFeatures(st.counters)];
  for (const [zone, size] of [[s.board, LIMITS.board], [s.shop, LIMITS.shop], [st.spellShop, LIMITS.spellShop], [s.hand, LIMITS.hand], [s.discovery, LIMITS.discovery]] as const)
    for (let i = 0; i < size; i++) result.push(...card(zone[i], s));
  for (let i = 0; i < LIMITS.shop; i++) result.push(s.shop[i] ? scale(minionCost(s, s.shop[i]), 10) : 0);
  for (let i = 0; i < LIMITS.spellShop; i++) result.push(st.spellShop[i] ? scale(spellCost(s, st.spellShop[i]), 10) : 0);
  for (let i = 0; i < 7; i++) {
    const o = s.opponents[i];
    result.push(...(o ? [1, heroId(o.hero), scale(o.health, 40), scale(o.armor || 0, 40), o.tier / 6, +(i === s.nextOpponent)] : Array(6).fill(0)));
  }
  for (let i = 0; i < LIMITS.powers; i++) {
    const id = equippedPowers(s)[i];
    if (!id) { result.push(...Array(4).fill(0)); continue; }
    const p = heroPowerState(s, id);
    result.push(heroId(id), scale(p.cost, 10), scale(p.remaining, 5), +!!p.reason);
  }
  for (let i = 0; i < LIMITS.choices; i++) {
    result.push(heroId(st.powerChoice?.offers[i] || ""));
    result.push((TRINKETS.findIndex(t => t.id === st.trinketOffers[i]) + 1) / TRINKETS.length);
  }
  for (let i = 0; i < 2; i++) result.push((TRINKETS.findIndex(t => t.id === st.trinkets[i]) + 1) / TRINKETS.length);
  for (let i = 0; i < 10; i++) result.push((s.rewards[i] || 0) / 6);
  // Last combat's initial enemy board is visible history, unlike its current recruit board.
  for (let i = 0; i < 7; i++) result.push(...card(st.lastEnemy?.[i], s));
  return result;
}
