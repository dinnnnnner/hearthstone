// Serving projection for the 780-episode v3 policy. Keep independent of new training schemas.
import { ALL_CARDS } from "../src/data";
import { type Game, type Minion, heroPowerState } from "../src/engine";
import { SEASON_HEROES, GIFTS } from "../src/season/catalog";
import { TRINKETS, minionCost, spellCost, refreshPayment } from "../src/season/engine";
import { equippedPowers, powerProgress } from "../src/season/powers";
import { assertActionBounds } from "../rl/actions";

// Extra trinkets can occur at turns 5 (Marin), 6, 8 (Buttons), and 9, at most once per turn.
// Stable entity slots are shared by observations and the candidate-action scorer.
export const ZONES = ["global", "board", "shop", "spellShop", "hand", "discovery", "lastEnemy", "opponents", "powers", "powerOffers", "trinketOffers", "trinkets"];
export const SIZES = [1, 7, 16, 7, 10, 4, 7, 7, 2, 4, 4, 4];
export const OFFSETS = SIZES.map((_, i) => SIZES.slice(0, i).reduce((a, b) => a + b, 0));
export const ENTITY_COUNT = SIZES.reduce((a, b) => a + b, 0);
export const IDS = [...new Set([...ALL_CARDS.map(c => c.id), ...SEASON_HEROES.map(h => h.id), ...TRINKETS.map(t => t.id), ...GIFTS.map(g => g.id)])].sort();
const idMap = new Map(IDS.map((id, index) => [id, index + 1]));
const identity = (id: string) => {
  const result = idMap.get(id);
  if (!result) throw Error(`Unknown entity identity ${id}`);
  return result;
};
type Detail = Record<string, unknown>;
export interface Entity { id: number; zone: number; position: number; details: Detail }

// Static rule descriptions are supplied once in metadata, without artwork or names.
export const DEFINITIONS: Record<string, Detail> = {};
for (const c of ALL_CARDS) DEFINITIONS[identity(c.id)] = {
  kind: c.kind || "minion", tier: c.tier, attack: c.attack, health: c.health,
  cost: c.cost, effect: c.effect, spellSchool: c.spellSchool, mechanics: c.mechanics, token: c.token, tribe: c.tribe, races: c.races, keywords: c.keywords,
  magnetic: c.magnetic, activateCost: c.activateCost, abilities: c.abilities || [],
  goldenAttack: c.goldenAttack, goldenHealth: c.goldenHealth,
};
for (const h of SEASON_HEROES) DEFINITIONS[identity(h.id)] = { kind: "hero", cost: h.cost, passive: h.passive };
for (const t of TRINKETS) DEFINITIONS[identity(t.id)] = { kind: "trinket" };
for (const g of GIFTS) DEFINITIONS[identity(g.id)] = { kind: "gift" };
export const ENTITY_SCHEMA = { version: 2, ids: IDS, definitions: DEFINITIONS, zones: ZONES, sizes: SIZES, offsets: OFFSETS, count: ENTITY_COUNT };

/** Full dynamic own-card effects, with instance links converted to visible slot indices. */
function cardDetails(m: Minion, ref: (uid: string) => number, historical = false): Detail {
  const d: Detail = {
    attack: m.attack, health: m.health, golden: m.golden, keywords: m.keywords,
    lockedUntil: m.lockedUntil, lockedTier: m.lockedTier, bothChoices: m.bothChoices,
    magneticCount: m.magneticCount, learnedSpell: m.learnedSpell, gift: m.gift,
    giftTurn: m.giftTurn, activated: m.activated, temporary: m.temporary,
    extraAbilities: m.extraAbilities, expires: m.expires, tempSpell: m.tempSpell,
    gems: m.gems, reward: m.reward, rebornNext: m.rebornNext,
  };
  if (!historical) { d.counters = m.counters; d.remembered = m.remembered?.map(ref); }
  return d;
}

export function observeEntities(s: Game, decisions: number, budget: number): (Entity | null)[] {
  assertActionBounds(s);
  const st = s.season!, result: (Entity | null)[] = Array(ENTITY_COUNT).fill(null);
  const zones = [s.board, s.shop, st.spellShop, s.hand, s.discovery, st.lastEnemy || []];
  const refs = new Map<string, number>();
  zones.slice(0, 5).forEach((cards, zone) => cards.forEach((m, index) => refs.set(m.uid, OFFSETS[zone + 1] + index)));
  const ref = (uid: string) => refs.get(uid) ?? -1;
  const put = (zone: number, position: number, id: number, details: Detail) => {
    if (position >= SIZES[zone]) throw Error(`Entity overflow ${ZONES[zone]}`);
    result[OFFSETS[zone] + position] = { id, zone, position, details };
  };
  // Explicit allowlist: never serialize Game, pool, initialPool or opponents' boards.
  put(0, 0, identity(s.hero), {
    turn: s.turn, tier: s.tier, gold: s.gold, health: s.health, armor: st.armor,
    upgrade: s.upgrade, frozen: s.frozen, powerUsed: s.powerUsed, triples: s.triples, purchases: s.purchases,
    refreshes: s.refreshes, rewards: s.rewards, pogo: s.pogo, decisions, budget,
    tribes: st.tribes, freeRefresh: st.freeRefresh, refreshPayment: refreshPayment(s),
    nextGold: st.nextGold, maxGold: st.maxGold, giftsUsed: st.giftsUsed,
    giftUsedTurn: st.giftUsedTurn, discoveryKind: st.discoveryKind,
    trinketDone: st.trinketDone, buffs: st.buffs, fodder: st.fodder,
    spellDiscount: st.spellDiscount, healthRefreshes: st.healthRefreshes,
    healthRefreshUses: st.healthRefreshUses, playedTurn: st.playedTurn,
    goldenPlayed: st.goldenPlayed, spellsCast: st.spellsCast, lastSpell: st.lastSpell,
    battlecries: st.battlecries, deaths: st.deaths, trinketBuys: st.trinketBuys,
    counters: st.counters, combatEffects: st.combatEffects, goldSpentTurn: st.goldSpentTurn,
    boughtTurn: st.boughtTurn, lastDead: st.lastDead, cookieTribes: st.cookieTribes,
    frozenMinions: st.frozenMinions?.map(ref), powerCycle: st.powerCycle,
    nozdormuRefreshTurn: st.nozdormuRefreshTurn,
    heroMarks: Object.fromEntries(Object.entries(st.heroMarks || {}).map(([k, value]) => [k, k === "tavishId" ? value : ref(value)])),
    delayed: st.delayed?.map(({ uid, ...effect }) => ({ ...effect, target: uid ? ref(uid) : -1 })),
    powerChoiceMode: st.powerChoice?.mode, selectedPowers: st.powerChoice?.selected,
    // Future offer lists are private until that choice becomes active.
    pendingDiscoveries: st.pendingDiscoveries.map(r => ({ kind: r.kind, mechanic: r.mechanic, tiers: r.tiers, tribe: r.tribe, magnetic: r.magnetic, both: r.both })),
    activeDiscovery: st.activeDiscovery ? { kind: st.activeDiscovery.kind, mechanic: st.activeDiscovery.mechanic, both: st.activeDiscovery.both,
      damage: st.activeDiscovery.damage, lockedUntil: st.activeDiscovery.lockedUntil,
      doomedTurn: st.activeDiscovery.doomedTurn, bothChoices: st.activeDiscovery.bothChoices,
      magnetizeTarget: st.activeDiscovery.magnetizeTarget ? ref(st.activeDiscovery.magnetizeTarget) : -1,
      replaceShop: st.activeDiscovery.replaceShop ? ref(st.activeDiscovery.replaceShop) : -1,
      source: st.activeDiscovery.source ? { id: st.activeDiscovery.source.id, ...cardDetails(st.activeDiscovery.source, ref) } : undefined } : undefined,
    lastBattle: s.battles[0] ? { turn: s.battles[0].turn, result: s.battles[0].result, damage: s.battles[0].damage } : undefined,
  });
  zones.forEach((cards, i) => cards.forEach((m, position) => {
    const details = cardDetails(m, ref, i === 5);
    if (i === 1) details.buyCost = minionCost(s, m);
    if (i === 2) details.buyCost = spellCost(s, m);
    put(i + 1, position, identity(m.id), details);
  }));
  s.opponents.forEach((o, i) => put(7, i, identity(o.hero), { health: o.health, armor: o.armor || 0, tier: o.tier, next: i === s.nextOpponent }));
  equippedPowers(s).forEach((id, i) => {
    const p = heroPowerState(s, id);
    put(8, i, identity(id), { ...powerProgress(s, id), cost: p.cost, remaining: p.remaining, unavailable: !!p.reason });
  });
  st.powerChoice?.offers.forEach((id, i) => put(9, i, identity(id), {}));
  st.trinketOffers.forEach((id, i) => put(10, i, identity(id), {}));
  st.trinkets.forEach((id, i) => put(11, i, identity(id), {}));
  return result;
}
