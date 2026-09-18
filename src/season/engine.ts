import currentRules from "./current-rules.json" with { type: "json" };
import { recordsFrames, recordsLogs } from "../simulation";
import { aiActionError, recordAIAction } from '../ai-action-limits';
import { practiceBattles } from "../practice";
import { damageSeasonHero } from "../ranking";
import {
  CARDS,
  POOL_COPIES,
  SHOP_SIZE,
  UPGRADE_COST,
  getDef,
  type Ability,
  type CardDef,
  type Keyword,
  type Tribe,
} from "../data";
import {
  makeMinion,
  type Game,
  type Minion,
  type Action,
  type Battle,
  type BattleFrame,
  type Opponent,
} from "../engine";
import {
  SEASON_META,
  SEASON_CARDS,
  SEASON_HEROES,
  AI_SEASON_HEROES,
  HERO_TRIBES,
  SEASON_SPELLS,
  SEASON_CATALOG,
  SEASON_RELATED,
  ALL_TRIBES,
  GIFTS,
  PREFIX,
  RAW_TRINKETS,
} from "./catalog";
import { equippedPowers, hasPower, powerDefinition, powerProgress, savePowerProgress, equipPowers, nguyenPowerEligible, type PowerProgress, type PowerChoice } from "./powers";
import { boardPowerTargets, shopPowerTargets, mixedPowerTargets } from "./expanded-heroes";
import trinketPool from "./trinket-pool.json" with { type: "json" };
import trinketTypes from "./trinket-types.json" with { type: "json" };
import trinketDependencies from "./trinket-dependencies.json" with { type: "json" };
import tierSevenPool from "./tier-seven-pool.json" with { type: "json" };
import { returningTrinkets } from "./trinkets";
export interface SeasonState {
  deity?: { id: string; attack: number; health: number; golden: boolean };
  kiriSlot?: number;
  trinketPower?: string;
  pendingTrinketCards?: Minion[];
  trinketOfferCosts?: Record<string, number>;
  trinketOfferTypes?: Record<string, Tribe>;
  trinketData?: Record<string, { turn: number; type?: Tribe; card?: string; stored?: Minion[] }>;
  pendingTrinketChoices?: { slot: number; school: string; free?: boolean }[];
  replacingTrinket?: number;
  mysteryCubeSlots?: number[];
  boughtTurn?: string[];
  lastDead?: string[];
  lastEnemy?: Minion[];
  heroMarks?: Record<string, string>;
  cookieTribes?: string[];
  frozenMinions?: string[];
  counters?: Record<string, number>;
  goldSpentTurn?: number;
  activeDiscovery?: DiscoveryRequest;
  combatEffects?: Record<string, number>;
  delayed?: { turn: number; attack: number; health: number; amount: number; uid?: string; win?: boolean }[];
  powers?: string[];
  powerProgress?: Record<string, PowerProgress>;
  powerChoice?: PowerChoice;
  powerCycle?: boolean;
  patch: string;
  armor: number;
  spellArmor?: number;
  tribes: Tribe[];
  spellShop: Minion[];
  initialPool: Record<string, number>;
  freeRefresh: number;
  nozdormuRefreshTurn?: number;
  nextGold: number;
  temporaryGoldCap?: number;
  maxGold: number; // Normal ten-gold limit plus permanent gold increases.
  giftsUsed: number;
  giftUsedTurn: number;
  discoveryKind: string;
  pendingDiscoveries: DiscoveryRequest[];
  trinkets: string[];
  trinketOffers: string[];
  trinketDone: number[];
  buffs: Record<string, { attack: number; health: number }>;
  fodder: number;
  spellDiscount: number;
  healthRefreshes: number;
  healthRefreshUses?: Record<string, number>;
  playedTurn: number;
  goldenPlayed: number;
  spellsCast: number;
  lastSpell?: string;
  battlecries: number;
  deaths: number;
  trinketBuys: number;
  heroPowerUses?: number;
  heroPowerUsesTurn?: number;
  elementalsPlayed?: number;
}
interface DiscoveryRequest {
  trinketKey?: string;
  stats?: { attack: number; health: number };
  golden?: boolean;
  typed?: boolean;
  darkGift?: boolean;
  trinket?: boolean;
  replaceBoard?: string;
  creationPart?: Minion;
  replaceShop?: string;
  magnetizeTarget?: string;
  kind: string;
  tiers?: number[];
  tribe?: string;
  magnetic?: boolean;
  mechanic?: string;
  options?: string[];
  source?: Minion;
  both?: boolean;
  damage?: boolean;
  lockedUntil?: number;
  doomedTurn?: number;
  bothChoices?: boolean;
}
export const TRINKETS = RAW_TRINKETS.filter((t) => trinketPool.ids.includes(t.id));
const clone = <T>(x: T): T => structuredClone(x);
const pick = <T>(a: T[], rng: () => number): T | undefined =>
  a[Math.floor(rng() * a.length)];
const shuffled = <T>(a: T[], rng: () => number) => {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const ss = (s: Game) => s.season!;
const tavernSpellIds = new Set([...SEASON_SPELLS, ...SEASON_RELATED.filter((c) => c.spellSchool === "TAVERN")].map((c) => c.id));
const count = (s: Game, key: string) => ss(s).counters?.[key] || 0;
const bump = (s: Game, key: string, n = 1) => (ss(s).counters ??= {})[key] = count(s, key) + n;
const powerCount = (s: Game, hero: string, metric: string) => count(s, `power:${hero}:${metric}`);
function countPowerEvent(s: Game, metric: string, amount = 1) {
  for (const id of equippedPowers(s)) bump(s, `power:${id.slice(4)}:${metric}`, amount);
}
const mcount = (m: Minion, key: string) => m.counters?.[key] || 0;
const mbump = (m: Minion, key: string, n = 1) => (m.counters ??= {})[key] = mcount(m, key) + n;
// Combat-only links track granted stats separately from damage; never enter saved state.
const retained = new WeakMap<Minion, { original: Minion; factor: number }>();
const keyword = (m: Minion, k: Keyword) => {
  if (!m.keywords.includes(k)) m.keywords.push(k);
  const kept = retained.get(m);
  if (kept && !kept.original.keywords.includes(k))
    kept.original.keywords.push(k);
};
export const tribe = (m: Minion, t: string) =>
  getDef(m.id).tribe === t ||
  getDef(m.id).tribe === "全部" ||
  getDef(m.id).races?.includes(t as Tribe) ||
  m.extraTribes?.includes(t as Tribe) ||
  m.extraTribes?.includes("全部") ||
  m.gift === "BG36_MidGameEffect_000t22";
const ability = (m: Minion, event?: string) =>
  [...(getDef(m.id).abilities || []).filter((a) => !m.counters?.chosenSpell || a.event !== "cast"), ...(m.extraAbilities || [])].filter(
    (a) => !event || a.event === event,
  );
const has = (m: Minion, op: string) => ability(m).some((a) => a.op === op);
const trinket = (s: Game, n: string) =>
  ss(s).trinkets.includes("BG36_MagicItem_" + n);
const trinketCopies = (s: Game, n: string) => ss(s).trinkets.filter((id) => id === "BG36_MagicItem_" + n).length;
const itemCount = (s: Game, id: string) => ss(s).trinkets.filter((item) => item === id).length;
const boardTypes = (board: Minion[]) => ALL_TRIBES.filter((t) => board.some((m) => tribe(m, t)));
function trinketCard(s: Game, card: Minion) {
  (ss(s).pendingTrinketCards ??= []).push(card);
  flushTrinketCards(s);
}
function flushTrinketCards(s: Game) {
  const pending = ss(s).pendingTrinketCards;
  while (pending?.length && room(s)) putHand(s, pending.shift()!);
}
function giveCard(ctx: Context, card: Minion) {
  if (ctx.trinket) trinketCard(ctx.s, card); else putHand(ctx.s, card, true, ctx.board);
}
function queueEffectDiscover(ctx: Context, kind: string, opts: Omit<DiscoveryRequest, "kind"> = {}) {
  queueDiscover(ctx.s, kind, { ...opts, trinket: ctx.trinket });
}
export function trinketCost(s: Game, id: string) {
  return ss(s).trinketOfferCosts?.[id] ?? TRINKETS.find((t) => t.id === id)?.cost ?? 0;
}
function trinketRaces(id: string): Tribe[] {
  return ((trinketTypes as Record<string, { types: string[] }>)[id]?.types || []) as Tribe[];
}
function canOfferTrinket(s: Game, id: string) {
  if (id === "BG36_MagicItem_411" && equippedPowers(s).length >= 2) return false;
  const owned = [...s.board, ...s.hand.filter((m) => getDef(m.id).kind !== "spell")];
  const travel = ["BG30_MagicItem_888", "BG30_MagicItem_891", "BG32_MagicItem_271"];
  if (travel.includes(id) && (hasPower(s, "marin") || hasPower(s, "buttons"))) return false;
  if (id === "BG32_MagicItem_400" && s.board.length < 6) return false;
  if (["BG35_MagicItem_152", "BG30_MagicItem_701", "BG30_MagicItem_541"].includes(id) && !s.board.some((m) => has(m, "rewind"))) return false;
  if (["BG35_MagicItem_301", "BG35_MagicItem_741"].includes(id) && s.tier < 3) return false;
  if (id === "BG35_MagicItem_815" && owned.length >= 5) return false;
  if (id === "BG35_MagicItem_817" && !s.board.some((m) => getDef(m.id).tier === 3)) return false;
  if (id === "BG30_MagicItem_998" && ss(s).tribes.includes("恶魔")) return false;
  if (["BG35_MagicItem_861", "BG36_MagicItem_390"].includes(id) && !count(s, "soldBaller")) return false;
  if (["BG35_MagicItem_154", "BG35_MagicItem_156"].includes(id) && !Object.entries(ss(s).buffs).some(([key, value]) => /shop/i.test(key) && value.attack + value.health > 0)) return false;
  if (id === "BG35_MagicItem_754" && !s.hand.some((m) => getDef(m.id).kind !== "spell" && m.attack >= 10)) return false;
  if (id === "BG32_MagicItem_306" && !s.board.some((m) => ability(m, "death").length)) return false;
  if (id === "BG35_MagicItem_820" && s.health + ss(s).armor >= 16) return false;
  if (["BG30_MagicItem_422", "BG30_MagicItem_422t", "BG32_MagicItem_801t"].includes(id) && delta(s, "spell").attack + delta(s, "spell").health <= 0) return false;
  if (id === "BG35_MagicItem_812" && hasPower(s, "clockwork")) return false;
  if (["BG35_MagicItem_821", "BG35_MagicItem_821t"].includes(id) && hasPower(s, "voone")) return false;
  if (["BG30_MagicItem_847", "BG30_MagicItem_996"].includes(id) && hasPower(s, "gallywix")) return false;
  if (id === "BG30_MagicItem_821" && hasPower(s, "greybough")) return false;
  if (id === "BG36_MagicItem_370" && !s.board.length) return false;
  if (id === "BG30_MagicItem_403" && owned.filter((m) => !boardTypes([m]).length).length < 3) return false;
  return true;
}
export function trinketText(s: Game, id: string, slot = ss(s).trinkets.indexOf(id)) {
  const item = RAW_TRINKETS.find((t) => t.id === id);
  if (!item) return "";
  const key = `trinket:${slot}:${id}`;
  const type = ss(s).trinketData?.[key]?.type || ss(s).trinketOfferTypes?.[id];
  let text = item.text.replace(/92/g, type || "所选类型的随从");
  const rules = returningTrinkets[id];
  const index = rules?.findIndex((r) => !!r.every || !!r.limit) ?? -1;
  if (index >= 0) {
    const rule = rules[index];
    const value = count(s, `${key}:${index}${rule.perTurn ? ":" + s.turn : ""}`);
    const remaining = rule.every ? rule.every - value % rule.every : Math.max(0, rule.limit! - value);
    text = text.replace(/还剩\d+/, "还剩" + remaining);
  }
  return text;
}
export function offerTrinkets(s: Game, school: string, rng: () => number) {
  const threshold = school === "LESSER_TRINKET" ? 2 : 3;
  const owned = [...s.board, ...s.hand.filter((m) => getDef(m.id).kind !== "spell")];
  const counts = ALL_TRIBES.map((t) => ({ type: t, count: owned.filter((m) => tribe(m, t)).length }));
  const heroTypes = equippedPowers(s).map((id) => HERO_TRIBES[id]).filter(Boolean);
  const inTypes = counts.filter((entry) => entry.count >= threshold || heroTypes.includes(entry.type));
  const maximum = Math.max(0, ...inTypes.map((entry) => entry.count));
  const majority = pick(inTypes.filter((entry) => entry.count === maximum), rng)?.type;
  const pool = shuffled(TRINKETS.filter((t) => t.school === school && !ss(s).trinkets.includes(t.id) && canOfferTrinket(s, t.id) &&
    (!trinketRaces(t.id).length || trinketRaces(t.id).some((race) => ss(s).tribes.includes(race))) &&
    (t.id !== "BG36_MagicItem_390" || count(s, "soldBaller") > 0) &&
    (t.id !== "BG36_MagicItem_370" || s.board.length > 0)), rng);
  const costs = Object.fromEntries(pool.map((t) => [t.id, Math.max(0, t.cost -
    (trinketRaces(t.id).length && !trinketRaces(t.id).some((race) => inTypes.some((entry) => entry.type === race)) ? 2 : 0))]));
  const offers: typeof pool = [];
  const travel = ["BG30_MagicItem_888", "BG30_MagicItem_891", "BG32_MagicItem_271"];
  const compatible = (t: typeof pool[number]) => !offers.includes(t) && !(travel.includes(t.id) && offers.some((other) => travel.includes(other.id))) && !trinketRaces(t.id).some((race) =>
    race !== majority && offers.some((other) => trinketRaces(other.id).includes(race)));
  const add = (test: (t: typeof pool[number]) => boolean) => {
    const t = pool.find((t) => test(t) && compatible(t)); if (t) offers.push(t);
  };
  if (majority) add((t) => trinketRaces(t.id).includes(majority));
  add((t) => !trinketRaces(t.id).length);
  if (!offers.some((t) => costs[t.id] <= 2)) add((t) => costs[t.id] <= 2);
  while (offers.length < 4) { const size = offers.length; add(() => true); if (size === offers.length) break; }
  ss(s).trinketOfferTypes = Object.fromEntries(offers.filter((t) => /92/.test(t.text)).map((t) => [t.id, majority || pick(ss(s).tribes, rng)!]));
  ss(s).trinketOffers = offers.map((t) => t.id);
  ss(s).trinketOfferCosts = Object.fromEntries(offers.map((t) => [t.id, costs[t.id]]));
}
const log = (s: Game, text: string) => {
  if (!recordsLogs()) return;
  s.logs.unshift(text);
  s.logs = s.logs.slice(0, 80);
};
const room = (s: Game) => s.hand.length + s.rewards.length < 10;
function release(s: Game, m: Minion) {
  for (const [id, n] of Object.entries(m.copies))
    s.pool[id] = (s.pool[id] || 0) + n;
  m.copies = {};
}
const gold = (s: Game, n: number) => {
  // A temporary surplus must survive subsequent refunds and sales.
  s.gold = Math.min(Math.max(ss(s).maxGold, ss(s).temporaryGoldCap || 0, s.gold), s.gold + n);
};
function trinketGold(s: Game, amount: number) {
  s.gold += amount;
  ss(s).temporaryGoldCap = Math.max(ss(s).temporaryGoldCap || 0, s.gold);
}
function putHand(s: Game, m: Minion, markEntered = true, board = s.board) {
  if (markEntered && !mcount(m, "enteredTurn")) (m.counters ??= {}).enteredTurn = s.turn;
  if (room(s)) {
    s.hand.push(m);
    for (const source of board.filter(x => x.id === PREFIX + "BG36_109")) deityGain(s, 3 * (source.golden ? 2 : 1), 4 * (source.golden ? 2 : 1), board);
    for (const source of s.board.filter((x) => x.id === PREFIX + "BG34_Giant_327")) for (const pirate of s.board.filter((x) => tribe(x, "海盗"))) addStats(pirate, source.golden ? 2 : 1, source.golden ? 2 : 1);
    if (getDef(m.id).kind !== "spell" && tribe(m, "海盗") && s.board[0]) {
      const bonus = 16 * itemCount(s, "BG35_MagicItem_713");
      if (bonus) addStats(s.board[0], bonus, bonus);
    }
  }
  else {
    release(s, m);
    log(s, `手牌已满，${getDef(m.id).name}未加入手牌。`);
  }
}
function poolCards(s: Game) {
  return SEASON_CARDS.filter((d) => s.pool[d.id] !== undefined);
}
function available(d: CardDef, tribes: Tribe[]) {
  return (
    !d.races?.length ||
    d.races.includes("全部") ||
    d.races.some((t) => tribes.includes(t))
  );
}
function draw(
  s: Game,
  rng: () => number,
  filter: (c: CardDef) => boolean = (d) => d.tier <= s.tier,
): Minion | undefined {
  const ds = poolCards(s).filter((d) => s.pool[d.id] > 0 && filter(d));
  let n = rng() * ds.reduce((v, d) => v + s.pool[d.id], 0);
  for (const d of ds) {
    n -= s.pool[d.id];
    if (n < 0) {
      s.pool[d.id]--;
      const m = makeMinion(d.id, false, true);
      applyGlobal(s, m);
      return m;
    }
  }
}
function drawSpell(
  s: Game,
  rng: () => number,
  filter: (c: CardDef) => boolean = (d) => d.tier <= s.tier,
) {
  const ds = SEASON_SPELLS.filter(filter).filter((d) =>
    (d.id !== PREFIX + "BG31_819" || ss(s).tribes.includes("元素")) &&
    (d.id !== PREFIX + "BG28_606" || ss(s).tribes.includes("纳迦")),
  );
  const weights = [0, 5, 7, 9, 11, 7, 5];
  let n = rng() * ds.reduce((v, d) => v + weights[d.tier], 0);
  for (const d of ds) {
    n -= weights[d.tier];
    if (n < 0) return makeMinion(d.id);
  }
}
function delta(s: Game, key: string) {
  return ss(s).buffs[key] || { attack: 0, health: 0 };
}
function addStats(m: Minion, a: number, h: number) {
  if (m.id === PREFIX + "BG36_205") return;
  const kept = retained.get(m);
  const factor = kept?.factor || 1;
  m.attack = Math.max(0, m.attack + a * factor);
  m.health += h * factor;
  if (m.counters?.deathStatsHealth !== undefined) m.counters.deathStatsHealth += h * factor;
  if (kept) {
    kept.original.attack = Math.max(0, kept.original.attack + a * factor);
    kept.original.health += h * factor;
  }
}
function applyGlobal(s: Game, m: Minion) {
  if (tribe(m, "野兽")) { const b = delta(s, "beast"); addStats(m, b.attack, b.health); }
  if (tribe(m, "亡灵")) {
    const b = delta(s, "undead");
    addStats(m, b.attack, b.health);
  }
  if (m.id === PREFIX + "BG28_603t") {
    const b = delta(s, "beetle");
    addStats(m, b.attack, b.health);
  }
  syncCardStats(s, m);
}
function syncCardStats(s: Game, m: Minion, board = s.board) {
  if (VOLUMIZERS.includes(getDef(m.id).sourceId!)) {
    const b = delta(s, 'volumizer'); addStats(m, b.attack - mcount(m, 'volumizerAttack'), b.health - mcount(m, 'volumizerHealth'));
    (m.counters ??= {}).volumizerAttack = b.attack; m.counters.volumizerHealth = b.health;
  }
  if (m.id === PREFIX + 'BG34_405') { if (m.keywords.includes('圣盾')) keyword(m, '嘲讽'); else m.keywords = m.keywords.filter(k => k !== '嘲讽'); }
  const hammer = (1 + count(s, 'discarded')) * (trinketCopies(s, '403') + 2 * trinketCopies(s, '403t'));
  const hammerHealth = (1 + count(s, 'discarded')) * trinketCopies(s, '403t');
  const attack = board.includes(m) ? hammer : 0, health = board.includes(m) ? hammerHealth : 0;
  if (attack || health || mcount(m, 'hammerAttack') || mcount(m, 'hammerHealth')) {
    m.attack += attack - mcount(m, 'hammerAttack'); m.health += health - mcount(m, 'hammerHealth');
    (m.counters ??= {}).hammerAttack = attack; m.counters.hammerHealth = health;
  }

  for (const a of ability(m).filter((a) => a.op === "lowHeroHealth")) {
    const f = board.includes(m) && s.health <= (a.amount || 15) ? (m.golden ? 2 : 1) : 0;
    const attack = (a.attack || 0) * f, health = (a.health || 0) * f;
    // Conditional stats are an aura, not permanent enchantments retained by Poet.
    m.attack = Math.max(0, m.attack + attack - mcount(m, "lowHeroHealthAttack"));
    m.health += health - mcount(m, "lowHeroHealthHealth");
    (m.counters ??= {}).lowHeroHealthAttack = attack;
    m.counters.lowHeroHealthHealth = health;
  }
  if (m.id === PREFIX + "BG25_008") {
    const bonus = delta(s, "eternalPortrait");
    addStats(m, bonus.attack - mcount(m, "eternalPortraitAttack"), bonus.health - mcount(m, "eternalPortraitHealth"));
    (m.counters ??= {}).eternalPortraitAttack = bonus.attack;
    m.counters.eternalPortraitHealth = bonus.health;
  }
  if (m.gift === 'BG36_MidGameEffect_000t88') { const n = 3 * count(s, 'discarded'); addStats(m, n - mcount(m, 'discardGift'), n - mcount(m, 'discardGift')); (m.counters ??= {}).discardGift = n; }
  if (has(m, "alwaysGolden")) makeGolden(m);
  for (const a of ability(m).filter((a) => a.op === "globalStats")) {
    const key = a.key!;
    const total = key === "battlecries" ? ss(s).battlecries : key === "tavernSpells" ? ss(s).spellsCast : key === "goldenPlayed" ? ss(s).goldenPlayed : count(s, key);
    const value = Math.max(0, total - (key === "automatonSummons" ? mcount(m, "automatonSelf") : 0));
    const f = m.golden ? 2 : 1;
    const attack = value * (a.attack || 0) * f, health = value * (a.health || 0) * f;
    addStats(m, attack - mcount(m, key + "Attack"), health - mcount(m, key + "Health"));
    (m.counters ??= {})[key + "Attack"] = attack;
    m.counters[key + "Health"] = health;
  }
  if (has(m, "shieldAtSix") && m.attack >= 6 && !mcount(m, "thresholdShield")) {
    keyword(m, "圣盾"); mbump(m, "thresholdShield");
  }
}
function syncStats(s: Game, board = s.board) {
  for (const m of new Set([...board, ...s.board, ...s.hand, ...s.shop])) syncCardStats(s, m, board === s.board || board.includes(m) ? board : s.board);
}
function gain(ctx: Context, m: Minion, attack: number, health: number) {
  if ((ctx.depth || 0) > 20) return;
  if (ctx.source && getDef(ctx.source.id).kind !== "spell" && tribe(ctx.source, "元素") && (attack > 0 || health > 0)) {
    const bonus = trinketCopies(ctx.s, "380") * (1 + Math.floor(count(ctx.s, "trinketElementals") / 5)) + ctx.board.filter((x) => has(x, "elementalGrantAura")).reduce((sum, x) => sum + 3 * (x.golden ? 2 : 1), 0);
    attack += bonus; health += bonus;
  }
  if (tribe(m, "元素")) {
    const bonus = delta(ctx.s, "elementalGrant");
    attack += bonus.attack; health += bonus.health;
  }
  addStats(m, attack, health);
  if (!ctx.combat && mcount(m, "deityMirrorTurn") === ctx.s.turn) deityGain(ctx.s, attack * mcount(m, "deityMirrorCopies"), health * mcount(m, "deityMirrorCopies"));
  if (ctx.board.includes(m) && attack > 0) for (const source of ctx.board.filter((x) => has(x, "healthOnAttackGain")))
    addStats(m, 0, 3 * (source.golden ? 2 : 1));
  if (ctx.board.includes(m) && has(m, "handEchoStats")) for (const card of ctx.s.hand.filter((x) => getDef(x.id).kind !== "spell").slice(0, 2))
    gain({ ...ctx, source: undefined, depth: (ctx.depth || 0) + 1 }, card, attack * (m.golden ? 2 : 1), health * (m.golden ? 2 : 1));
  syncCardStats(ctx.s, m, ctx.board);
  if (ctx.source === m && itemCount(ctx.s, "BG35_MagicItem_156") && m.id === PREFIX + "BG34_500") {
    const index = ctx.board.indexOf(m);
    for (const adjacent of [ctx.board[index - 1], ctx.board[index + 1]].filter(Boolean)) gain({ ...ctx, source: undefined, depth: (ctx.depth || 0) + 1 }, adjacent, attack, health);
  }
  if (ctx.source === m && itemCount(ctx.s, "BG35_MagicItem_924") && m.id === PREFIX + "BG31_035") {
    const left = ctx.board[ctx.board.indexOf(m) - 1];
    if (left) gain({ ...ctx, source: undefined, depth: (ctx.depth || 0) + 1 }, left, attack, health);
  }
  if (m.id === PREFIX + "TB_BaconShop_HP_033t") for (const buddy of ctx.board.filter((x) => x.id === PREFIX + "TB_BaconShop_HERO_33_Buddy"))
    gain({ ...ctx, source: undefined, depth: (ctx.depth || 0) + 1 }, buddy, attack * (buddy.golden ? 2 : 1), health * (buddy.golden ? 2 : 1));
}
function applyShop(s: Game, m: Minion) {
  if (hasPower(s, "saurfang")) addStats(m, 1 + Math.floor(powerCount(s, "saurfang", "boughtMinions") / 3), 1 + Math.floor(powerCount(s, "saurfang", "boughtMinions") / 3));
  for (const k of [
    "shop",
    ...(tribe(m, "元素") ? ["elementalShop"] : []),
    ...(getDef(m.id).tier <= 3 ? ["lowShop"] : []),
  ]) {
    const b = delta(s, k);
    addStats(m, b.attack, b.health);
  }
  for (const t of ALL_TRIBES) if (tribe(m, t)) {
    const bonus = delta(s, "shopType:" + t);
    addStats(m, bonus.attack, bonus.health);
  }
}
function refreshSources(s: Game) {
  return s.board.filter((m) => has(m, "healthRefresh"));
}
function refreshUses(s: Game) {
  if (ss(s).healthRefreshUses) return ss(s).healthRefreshUses!;
  // Old saves stored one shared counter. Distribute spent charges once, without
  // granting those charges again when migrating a running game.
  let spent = ss(s).healthRefreshes || 0;
  return Object.fromEntries(refreshSources(s).map((m) => {
    const used = Math.min(spent, m.golden ? 4 : 2);
    spent -= used;
    return [m.uid, used];
  }));
}
export function refreshPayment(s: Game) {
  if (!s.season) return { gold: 1, health: 0, remaining: 0, source: undefined as string | undefined };
  const uses = refreshUses(s), sources = refreshSources(s);
  const left = (m: Minion) => Math.max(0, (m.golden ? 4 : 2) - (uses[m.uid] || 0));
  const remaining = sources.reduce((sum, m) => sum + left(m), 0);
  const source = sources.find((m) => left(m) > 0)?.uid;
  if (ss(s).freeRefresh > 0) return { gold: 0, health: 0, remaining, source: undefined };
  if (hasPower(s, "nozdormu") && (ss(s).nozdormuRefreshTurn ?? s.turn) !== s.turn)
    return { gold: 0, health: 0, remaining, source: undefined };
  if (source) return { gold: 0, health: 1, remaining, source };
  return { gold: hasPower(s, "millhouse") ? 2 : 1, health: 0, remaining, source: undefined };
}
export function refreshCost(s: Game) {
  return refreshPayment(s).gold;
}
export function minionCost(s: Game, m: Minion) {
  if (tribe(m, "海盗") && itemCount(s, "BG32_MagicItem_957") && !count(s, "pirateBought:" + s.turn)) return 0;
  if (m.counters?.shopCost !== undefined) return m.counters.shopCost;
  if (getDef(m.id).magnetic && itemCount(s, "BG35_MagicItem_743")) return 2;
  if (hasPower(s, "aranna") && powerCount(s, "aranna", "attacks") >= 14 && !(ss(s).boughtTurn || []).length) return 0;
  if (hasPower(s, "sindragosa") || count(s, "prizeMinionCost")) return 2;
  return trinket(s, "202") &&
    ss(s).trinketBuys < 2 &&
    ability(m, "battlecry").length
    ? 0
    : hasPower(s, "millhouse") ? 2 : 3;
}
export function spellCost(s: Game, m: Minion) {
  if (hasPower(s, "taethelan") && powerCount(s, "taethelan", "boughtSpells") % 3 === 2) return 0;
  const discount = s.board.filter((x) => has(x, "timewarpSpellDiscount") && mcount(x, "spellDiscount:" + s.turn) < (x.golden ? 4 : 2)).length * 2;
  return Math.max(0, (getDef(m.id).cost || 0) - ss(s).spellDiscount - count(s, "prizeDiscount:" + s.turn) - discount);
}
export function minionUsesHealth(s: Game, m: Minion) {
  return !!mcount(m, "healthPurchase") || (itemCount(s, "BG30_MagicItem_701") > 0 && count(s, "eyePurchases") % 4 === 3) ||
    (tribe(m, "恶魔") && count(s, "demonHealth:" + s.turn) < itemCount(s, "BG32_MagicItem_821"));
}
export const spellUsesHealth = (m: Minion, s?: Game) => has(m, "healthCost") || !!s && (
  (itemCount(s, "BG30_MagicItem_701") > 0 && count(s, "eyePurchases") % 4 === 3) ||
  count(s, "spellHealth:" + s.turn) < itemCount(s, "BG32_MagicItem_822"));
function recordPurchasePayment(s: Game, m: Minion, paidHealth: boolean) {
  if (itemCount(s, "BG30_MagicItem_701")) bump(s, "eyePurchases");
  if (getDef(m.id).kind === "spell") for (const x of s.board.filter((x) => has(x, "timewarpSpellDiscount"))) mbump(x, "spellDiscount:" + s.turn);
  if (paidHealth) bump(s, (getDef(m.id).kind === "spell" ? "spellHealth:" : "demonHealth:") + s.turn);
  if (getDef(m.id).kind !== "spell" && tribe(m, "海盗")) bump(s, "pirateBought:" + s.turn);
}
export function seasonPowerState(s: Game, id = equippedPowers(s)[0]) {
  const h = powerDefinition(s, id) || powerDefinition(s);
  const key = h.id.slice(4), progress = powerProgress(s, h.id);
  const limit = (["blackthorn", "inge", "malygos"].includes(key) ? 2 : 1) + itemCount(s, "BG35_MagicItem_801");
  const spent = progress.turnUses;
  const exhausted = (["reno", "zerek", "kragg"].includes(key) && progress.uses > 0) || (key === "zephrys" && progress.uses >= 3);
  const remaining = exhausted ? 0 : Math.max(0, limit - spent);
  const cost = Math.max(0, h.cost + (key === "elise" ? progress.uses : 0) -
    (["togwaggle", "nobundo"].includes(key) ? count(s, key + "Discount") : key === "patches" ? count(s, "patchesDiscount") : 0));
  const needsTarget = ["drestagath", "lich", "george", "xyrella", "reno", "inge"].includes(key) || boardPowerTargets.has(key) || shopPowerTargets.has(key) || mixedPowerTargets.has(key);
  let targets = key === "xyrella" ? s.shop : key === "reno" ? s.board : [...s.board, ...s.shop];
  if (key === "drestagath") targets = s.hand;
  if (boardPowerTargets.has(key)) targets = s.board;
  if (shopPowerTargets.has(key)) targets = ["bazhial", "maiev"].includes(key) ? [...s.shop, ...ss(s).spellShop] : s.shop;
  if (key === "malygos") targets = [...s.board, ...s.shop, ...s.hand.filter((m) => getDef(m.id).kind === "spell"), ...ss(s).spellShop];
  if (key === "reno") targets = targets.filter((m) => !m.golden);
  if (key === "george") targets = targets.filter((m) => !m.keywords.includes("圣盾"));
  if (key === "jailer") targets = targets.filter((m) => tribe(m, "亡灵"));
  if (key === "shudderwock") targets = targets.filter((m) => ability(m, "battlecry").length);
  if (key === "jandice") targets = targets.filter((m) => !m.golden);
  if (key === "galakrond") targets = targets.filter((m) => getDef(m.id).tier < 6);
  if (key === "mutanus") targets = targets.filter((m) => s.board.some((x) => x.uid !== m.uid));
  const locked = (["millificent", "alexstrasza"].includes(key) && s.tier < 4) ||
    (["shudderwock", "sylvanas", "akazamzarakScholar"].includes(key) && s.turn < 3) || (key === "jailer" && s.tier < 2) || (key === "snakeEyes" && count(s, "snakeUnlock") > s.turn);
  const used = remaining === 0;
  const status = key === "genn" ? `第4回合选择两个技能 · 还剩${Math.max(0, 4 - s.turn)}回合` : exhausted ? "本局已使用" : used ? "本回合已使用"
    : locked ? key === "snakeEyes" ? `第${count(s, "snakeUnlock")}回合可用` : ["millificent", "alexstrasza"].includes(key) ? "酒馆4星解锁" : key === "jailer" ? "酒馆2星解锁" : "第3回合解锁"
    : key === "inge" ? `${s.turn % 2 ? "攻击力" : "生命值"} +${s.tier} · 剩余${remaining}次`
    : limit === 2 ? `本回合剩余${remaining}次`
    : key === "elise" ? `当前费用 ${cost} 金币`
    : key === "reno" ? "本局剩余1次"
    : key === "chenvaala" ? `再使用${3 - progress.elementalsPlayed % 3}张元素减费`
    : h.passive ? "被动技能" : "";
  const reason = !equippedPowers(s).includes(id) ? "你没有这个英雄技能。"
    : ss(s).powerChoice ? "请先选择英雄技能。" : h.passive ? "这是被动技能，持续生效。"
    : used ? status + "英雄技能。"
    : locked ? status + "。"
    : s.gold < cost ? `英雄技能需要${cost}枚金币。`
    : needsTarget && !targets.length ? "没有可用的英雄技能目标。"
    : ["xyrella", "pyramid", "elise", "alexstrasza", "blackthorn", "hollidae", "millificent"].includes(key) && !room(s)
      ? "请先腾出一个手牌位置。" : undefined;
  return { definition: h, id: h.id, cost, remaining, used, status, needsTarget, targets, reason };
}
function refill(s: Game, rng: () => number, keep = false, keepSelected = false, refreshed = true) {
  const ctx = { s, board: s.board, rng };
  const seer = refreshed && itemCount(s, "BG32_MagicItem_366") && bump(s, "seerRefresh:" + s.turn) <= 2 * itemCount(s, "BG32_MagicItem_366");
  const allowed = (d: CardDef) => (seer ? d.tier === 6 : d.tier <= s.tier) && (!itemCount(s, "BG30_MagicItem_998") || d.tier > 2);
  if (!keep) {
    const frozen = keepSelected ? ss(s).frozenMinions || [] : [];
    s.shop.filter((m) => !frozen.includes(m.uid)).forEach((m) => release(s, m));
    s.shop = s.shop.filter((m) => frozen.includes(m.uid));
    ss(s).spellShop = [];
  }
  ss(s).frozenMinions = [];
  if (refreshed && count(s, "warbandRefresh")) {
    ss(s).counters!.warbandRefresh = 0;
    for (const m of s.board.slice(0, 7)) { const card = makeMinion(m.id, m.golden); applyShop(s, card); s.shop.push(card); }
  }
  const size = Math.min(7, (itemCount(s, "BG30_MagicItem_841") ? 6 : SHOP_SIZE[s.tier] - (hasPower(s, "sindragosa") ? 1 : 0)) + count(s, "prizeExtraShop"));
  while (s.shop.length < size) {
    const m = draw(s, rng, allowed);
    if (!m) break;
    applyShop(s, m);
    if (count(s, "prizeExtraShop") && s.shop.length >= size - count(s, "prizeExtraShop")) addStats(m, 2, 2);
    s.shop.push(m);
  }
  if (!ss(s).spellShop.length) {
    const m = drawSpell(s, rng, allowed);
    if (m) ss(s).spellShop = [m];
  }
  if (ss(s).fodder > 0) {
    ss(s).fodder--;
    const d = pick(
      s.board.filter((m) => tribe(m, "恶魔")),
      rng,
    );
    if (d) {
      const extra = 4 * itemCount(s, "BG35_MagicItem_151") + 15 * itemCount(s, "BG35_MagicItem_151t");
      gain(ctx, d, 2 + extra, 2 + extra);
      log(s, `${getDef(d.id).name}吞食恶魔饲料，获得+2/+2。`);
    }
  }
  const growth = delta(s, "refresh");
  const t = pick(s.shop, rng);
  if (t) addStats(t, growth.attack, growth.health);
  if (refreshed) {
    s.upgrade = Math.max(0, s.upgrade - trinketCopies(s, "300"));
    legacyTrinketEvent(ctx, "refresh");
    for (const m of [...s.board]) run(ctx, m, "refresh");
  }
  const barrage = delta(s, "gemBarrage").attack;
  if (barrage) for (const m of s.shop) effect({ s, board: s.board, rng, target: m }, makeMinion(PREFIX + "BG20_GEM"), { event: "cast", op: "gem", target: "selected", amount: barrage });
  if (hasPower(s, "varden")) {
    const highest = [...s.shop].sort((a, b) => getDef(b.id).tier - getDef(a.id).tier)[0];
    if (highest && s.shop.length < 7) {
      const copy = clone(highest); copy.uid = makeMinion(highest.id).uid; copy.copies = {};
      s.shop.push(copy); ss(s).frozenMinions = [highest.uid, copy.uid];
    }
  }
  if (hasPower(s, "enhance")) for (let i = 0; i < 2; i++) {
    const m = pick(s.shop, rng); if (m) keyword(m, pick(["嘲讽", "圣盾", "风怒", "复生"] as Keyword[], rng)!);
  }
  if (hasPower(s, "ysera") && s.shop.length < 7) {
    const dragon = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("龙") === true || d.tribe === "全部"));
    if (dragon) { applyShop(s, dragon); s.shop.push(dragon); }
  }
}
function queueDiscover(
  s: Game,
  kind: string,
  opts: Omit<DiscoveryRequest, "kind"> = {},
) {
  ss(s).pendingDiscoveries.push({ kind, ...opts });
}
function choiceCards(s: Game) {
  return [...poolCards(s).filter((d) => s.pool[d.id] > 0), ...SEASON_SPELLS]
    .filter((d) => d.tier <= s.tier && d.abilities?.some((a) => a.op === "choose"));
}
function nextDiscovery(s: Game, rng: () => number) {
  if (s.discovery.length) return;
  const request = ss(s).pendingDiscoveries.shift();
  if (!request) return;
  ss(s).discoveryKind = request.kind;
  ss(s).activeDiscovery = request;
  if (request.darkGift) {
    const ids = request.options || (request.tiers?.includes(7)
      ? tierSevenPool.map((id) => PREFIX + id)
      : poolCards(s).filter((d) => (!request.tiers || request.tiers.includes(d.tier)) &&
          (!request.tribe || d.races?.includes(request.tribe as Tribe) || d.tribe === "全部") && s.pool[d.id] > 0).map((d) => d.id));
    for (const id of shuffled([...new Set(ids)], rng)) {
      const preview = makeMinion(id);
      const gift = pick(eligibleGifts(s, preview), rng);
      if (!gift) continue;
      const card = request.options || getDef(id).tier === 7 ? preview : draw(s, rng, (d) => d.id === id);
      if (!card) continue;
      attachDarkGift(s, card, gift.id);
      s.discovery.push(card);
      if (s.discovery.length === 3) break;
    }
    if (!s.discovery.length) { ss(s).activeDiscovery = undefined; nextDiscovery(s, rng); }
    return;
  }
  if (request.kind === "chooseCard") {
    s.discovery = shuffled(choiceCards(s), rng).slice(0, 3).flatMap((d) => {
      const card = d.kind === "spell" ? makeMinion(d.id) : draw(s, rng, (x) => x.id === d.id);
      return card ? [card] : [];
    });
    if (!s.discovery.length) { ss(s).activeDiscovery = undefined; nextDiscovery(s, rng); }
    return;
  }
  if (request.options) {
    s.discovery = request.options.filter((id) => getDef(id) && (request.kind !== "cookie" || s.pool[id] > 0)).map((id) => {
      const card = makeMinion(id, request.golden || request.source?.golden, request.kind === "cookie");
      if (request.kind === "cookie") s.pool[id]--;
      if (request.both) card.extraAbilities = request.options!.filter((x) => x !== id).flatMap((x) => ability(makeMinion(x), "cast"));
      return card;
    });
    return;
  }
  for (let i = 0; i < 3; i++) {
    const m =
      request.kind === "spell"
        ? drawSpell(
            s,
            rng,
            (d) => (request.tiers ? request.tiers.includes(d.tier) : d.tier <= s.tier) && !s.discovery.some((m) => m.id === d.id),
          )
        : draw(
            s,
            rng,
            (d) =>
              (request.tiers
                ? request.tiers.includes(d.tier)
                : d.tier <= s.tier) &&
              (!request.tribe ||
                d.races?.includes(request.tribe as Tribe) ||
                d.tribe === "全部") &&
              (!request.typed || !!d.races?.length) &&
              (!request.magnetic || !!d.magnetic) &&
              (!request.mechanic || !!d.mechanics?.includes(request.mechanic)) &&
              !s.discovery.some((m) => m.id === d.id),
          );
    if (m) s.discovery.push(m);
  }
  if (!s.discovery.length) {
    ss(s).activeDiscovery = undefined;
    log(s, "可用候选不足，跳过本次发现。");
    nextDiscovery(s, rng);
  }
}
export function createSeason(
  heroId = PREFIX + "lich",
  rng: () => number = Math.random,
  shared?: { tribes: Tribe[]; pool?: Record<string, number>; deity?: string },
): Game {
  const hero = SEASON_HEROES.find((h) => h.id === heroId) || SEASON_HEROES[0];
  const types = shared
    ? [...shared.tribes]
    : ["畸变怪" as Tribe, ...shuffled(ALL_TRIBES.filter(t => t !== "畸变怪"), rng).slice(0, 4)];
  const required = HERO_TRIBES[hero.id];
  if (!shared && required && !types.includes(required)) types[1] = required;
  const paradoxes = SEASON_CARDS.filter(d => d.sourceId?.startsWith('BG36_360t') && !(types.includes('亡灵') && d.sourceId === 'BG36_360t4'));
  const paradox = shared?.pool ? paradoxes.find(d => d.id in shared.pool!) : pick(paradoxes, rng);
  const defs = SEASON_CARDS.filter((d) => available(d, types) && (!d.sourceId?.startsWith('BG36_360t') || d === paradox));
  const initialPool = Object.fromEntries(
    defs.map((d) => [d.id, POOL_COPIES[d.tier]]),
  );
  const pool = { ...(shared?.pool || initialPool) };
  const opponents = shuffled(
    (shared ? SEASON_HEROES : AI_SEASON_HEROES).filter((h) => h.id !== hero.id),
    rng,
  )
    .slice(0, 7)
    .map((h) => ({
      name: h.name,
      hero: h.id,
      health: h.health,
      armor: h.armor || 0,
      tier: 1,
      board: [] as Minion[],
    }));
  const s: Game = {
    version: 1,
    hero: hero.id,
    turn: 1,
    gold: 3,
    tier: 1,
    upgrade: hero.id === PREFIX + "millhouse" ? 6 : 5,
    health: hero.health,
    frozen: false,
    powerUsed: false,
    shop: [],
    hand: [],
    board: [],
    pool,
    opponents,
    nextOpponent: 0,
    logs: [`第${SEASON_META.season}赛季 · ${SEASON_META.patch}练习场。每局随机开放5个随从类型。`],
    battles: [],
    discovery: [],
    rewards: [],
    pogo: 0,
    triples: 0,
    purchases: 0,
    refreshes: 0,
    phase: "recruit",
    battle: null,
    season: {
      patch: SEASON_META.patch,
      deity: { id: shared?.deity || (currentRules.deityRestrictedHeroes.includes(hero.id) || rng() < .5 ? "BGFYM_000" : "BGFYM_011"), attack: 1, health: 1, golden: false },
      armor: hero.armor || 0,
      tribes: types,
      spellShop: [],
      initialPool: { ...initialPool },
      freeRefresh: 0,
      nozdormuRefreshTurn: 0,
      nextGold: 0,
      maxGold: 10,
      giftsUsed: 0,
      giftUsedTurn: 0,
      discoveryKind: "",
      pendingDiscoveries: [],
      trinkets: [],
      trinketOffers: [],
      trinketDone: [],
      buffs: {},
      fodder: 0,
      spellDiscount: 0,
      healthRefreshes: 0,
      healthRefreshUses: {},
      playedTurn: 0,
      goldenPlayed: 0,
      spellsCast: 0,
      battlecries: 0,
      deaths: 0,
      trinketBuys: 0,
      heroPowerUses: 0,
      heroPowerUsesTurn: 0,
      elementalsPlayed: 0,
    },
  };
  refill(s, rng, false, false, false);
  if (hasPower(s, "afk")) s.gold = 0;
  if (hasPower(s, "curator")) s.board.push(makeMinion(PREFIX + "TB_BaconShop_HP_033t"));
  if (hasPower(s, "nzoth")) s.board.push(makeMinion(PREFIX + "TB_BaconShop_HP_105t"));
  heroStart({ s, board: s.board, rng });
  if (hero.id === PREFIX + "finley") offerPowers(s, "finley", rng);
  if (hero.id === PREFIX + "nguyen") { ss(s).powerCycle = true; offerPowers(s, "nguyen", rng); }
  return s;
}
function triples(s: Game) {
  let guard = 0;
  while (guard++ < 50) {
    const all = [...s.board, ...s.hand].filter(
      (m) => getDef(m.id).kind !== "spell" && !m.golden && !m.learnedSpell,
    );
    const wildcards = all.filter((m) => has(m, "elementalWildcard"));
    const needed = (m: Minion) => hasPower(s, "clockwork") || itemCount(s, "BG30_MagicItem_439") && tribe(m, "海盗") ? 2 : 3;
    const group = all.find((m) => all.filter((n) => n.id === m.id).length >= needed(m)) ||
      all.find((m) => !has(m, "elementalWildcard") && tribe(m, "元素") && all.filter((n) => n.id === m.id).length + wildcards.length >= needed(m));
    if (!group) break;
    const copiesNeeded = needed(group);
    const same = all.filter((m) => m.id === group.id);
    const parts = [...same, ...(tribe(group, "元素") ? wildcards.filter((m) => m.id !== group.id) : [])].slice(0, copiesNeeded);
    const ids = new Set(parts.map((m) => m.uid));
    s.board = s.board.filter((m) => !ids.has(m.uid));
    s.hand = s.hand.filter((m) => !ids.has(m.uid));
    const d = getDef(group.id),
      g = makeMinion(group.id, true);
    g.attack += parts.reduce((n, m) => n + m.attack - getDef(m.id).attack, 0);
    g.health += parts.reduce((n, m) => n + m.health - getDef(m.id).health, 0);
    g.magneticCount = parts.reduce((n, m) => n + (m.magneticCount || 0), 0);
    for (const a of ability(g).filter((a) => a.op === "globalStats")) for (const suffix of ["Attack", "Health"]) {
      (g.counters ??= {})[a.key! + suffix] = parts.reduce((n, m) => n + mcount(m, a.key! + suffix), 0);
    }
    if (g.id === PREFIX + "BG25_008") for (const key of ["eternalPortraitAttack", "eternalPortraitHealth"]) (g.counters ??= {})[key] = parts.reduce((sum, m) => sum + mcount(m, key), 0);
    for (const key of ['hammerAttack', 'hammerHealth', 'volumizerAttack', 'volumizerHealth', 'discardGift']) (g.counters ??= {})[key] = parts.reduce((sum, m) => sum + mcount(m, key), 0);
    if (has(g, "lowHeroHealth")) for (const key of ["lowHeroHealthAttack", "lowHeroHealthHealth"]) (g.counters ??= {})[key] = parts.reduce((sum, m) => sum + mcount(m, key), 0);
    g.keywords = [...new Set(parts.flatMap((m) => m.keywords))];
    g.extraTribes = [...new Set(parts.flatMap((m) => m.extraTribes || []))];
    g.gift = parts.find((m) => m.gift)?.gift;
    g.giftTurn = parts.find((m) => m.gift)?.giftTurn;
    g.rebornNext = parts.some((m) => m.rebornNext);
    g.extraAbilities = parts.flatMap((m) => m.extraAbilities || []);
    const temps = parts.filter((m) => m.temporary);
    if (temps.length)
      g.temporary = {
        attack: temps.reduce((n, m) => n + m.temporary!.attack, 0),
        health: temps.reduce((n, m) => n + m.temporary!.health, 0),
        keywords: [...new Set(temps.flatMap((m) => m.temporary!.keywords))],
      };
    for (const m of parts)
      for (const [id, n] of Object.entries(m.copies))
        g.copies[id] = (g.copies[id] || 0) + n;
    g.reward = !hasPower(s, "clockwork");
    putHand(s, g);
    s.triples++;
    log(s, `${d.name}三连！金色随从保留已有增益。`);
  }
}
export function seasonTargets(
  s: Game,
  m: Minion,
  event = "battlecry",
): Minion[] {
  const d = getDef(m.id);
  if (d.magnetic && event === "battlecry")
    return s.board.filter(
      (x) =>
        tribe(x, "机械") || (d.sourceId === "BG_DEEP_015" && tribe(x, "亡灵")),
    );
  const a = ability(m, event).find((a) => a.target === "selected" || a.target === "selectedShop" || a.target === "selectedHand");
  if (!a) return [];
  if (a.target === "selectedHand") return s.hand;
  if (a.target === "selectedShop") return [...s.shop, ...ss(s).spellShop];
  let ts = [
    ...s.board,
    ...(event === "cast" && !["consume", "butchering", "sellTransfer"].includes(a.op) ? [...s.shop] : []),
  ].filter((x) => x.uid !== m.uid);
  if (a.tribe) ts = ts.filter((x) => tribe(x, a.tribe!));
  if (["battlecry", "rally"].includes(a.op))
    ts = ts.filter((x) => ability(x, a.op).length > 0);
  if (m.id === PREFIX + "BG35_911") ts = ts.filter(x => s.board.includes(x));
  if (a.op === "golden") ts = ts.filter((x) => s.board.includes(x) && !x.golden && getDef(x.id).tier <= (a.tier || 6));
  if (a.op === "deathrattle") ts = ts.filter((x) => s.board.includes(x) && ability(x, "death").length > 0);
  if (a.op === "trinketCopy") ts = ts.filter((x) => getDef(x.id).tier <= (a.tier || 3));
  if (["destroyUndead", "trinketDestroyUndead"].includes(a.op)) ts = ts.filter((x) => s.board.includes(x));
  if (a.op === "darkmoonPrize") { ts = ts.filter((x) => s.board.includes(x)); if (m.id.endsWith("034")) ts = ts.filter((x) => !x.golden); }
  if (a.op === "copyShop") ts = ts.filter((x) => s.shop.includes(x) && mcount(x, "zarjiraTurn") !== s.turn);
  if (a.op === "buffType") ts = ts.filter((x) => ALL_TRIBES.some((t) => tribe(x, t)));
  if (["tribeShop", "tribeRefresh"].includes(a.op)) ts = ts.filter((x) => ALL_TRIBES.some((t) => tribe(x, t)));
  if (a.op === "evolve") ts = ts.filter((x) => getDef(x.id).tier < 6);
  if (a.op === "sellTransfer") ts = ts.filter((x) => s.board.some((other) => other.uid !== x.uid && (a.key !== "elemental" || tribe(other, "元素"))));
  return ts;
}
interface Context {
  trinket?: boolean;
  source?: Minion;
  trinketCast?: boolean;
  trinketCombat?: Record<string, number>;
  opponentBoard?: Minion[];
  s: Game;
  board: Minion[];
  rng: () => number;
  combat?: boolean;
  enemy?: Minion[];
  sourcePos?: number;
  target?: Minion;
  eventMinion?: Minion;
  depth?: number;
  summon?: (m: Minion, pos: number) => void;
  permanent?: (m: Minion, a: number, h: number) => void;
  permanentKeyword?: (m: Minion, keyword: Keyword) => void;
  damage?: (target: Minion, amount: number, source?: Minion) => void;
  killer?: Minion;
  amount?: number;
  fromHand?: boolean;
  permanentSpell?: boolean;
  pendingSummons?: Minion[];
  deadAberrations?: Minion[];
  deadMechs?: { id: string; golden: boolean }[];
  remember?: (m: Minion, key: string, amount: number) => void;
}
function summonCount(m: Minion, a: Ability) {
  return m.golden && !a.noScale ? a.goldenAmount ?? a.amount ?? 1 : a.amount ?? 1;
}
function summonIsGolden(m: Minion, a: Ability) {
  return a.summonGolden ?? (m.golden && !a.noScale);
}
function copiedAbility(m: Minion, a: Ability): Ability {
  const factor = m.golden && !a.noScale ? 2 : 1;
  return {
    ...a,
    attack: a.attack === undefined ? undefined : a.attack * factor,
    health: a.health === undefined ? undefined : a.health * factor,
    amount: a.op === "summon" ? summonCount(m, a) : (a.amount ?? 1) * factor,
    ...(a.op === "summon" ? { summonGolden: summonIsGolden(m, a) } : {}),
    noScale: true,
  };
}
function combatCopy(m: Minion): Minion {
  const copy = clone(m);
  copy.uid = makeMinion(m.id).uid;
  copy.copies = {};
  copy.reward = false;
  return copy;
}
function handSummonTargets(s: Game, tribeName?: string) {
  return s.hand.filter((m) => getDef(m.id).kind !== "spell" &&
    (!tribeName || tribe(m, tribeName)) &&
    (m.lockedUntil || 0) <= s.turn && (m.lockedTier || 0) <= s.tier)
    .sort((a, b) => b.attack - a.attack);
}
function buffTargets(ctx: Context, m: Minion, a: Ability): Minion[] {
  const b = ctx.board;
  let ts: Minion[] = [];
  switch (a.target || "self") {
    case "self":
      ts = [m];
      break;
    case "event":
      ts = ctx.eventMinion ? [ctx.eventMinion] : [];
      break;
    case "selected":
      ts = ctx.target ? [ctx.target] : [];
      break;
    case "all":
      ts = [...b];
      break;
    case "others":
      ts = b.filter((x) => x.uid !== m.uid);
      break;
    case "boardAndHand":
      ts = [...b, ...ctx.s.hand.filter((x) => getDef(x.id).kind !== "spell")];
      break;
    case "shop":
      ts = [...ctx.s.shop];
      break;
    case "handLeft":
      ts = ctx.s.hand.filter((x) => getDef(x.id).kind !== "spell").slice(0, 1);
      break;
    case "randomHand":
      ts = shuffled(ctx.s.hand.filter((x) => getDef(x.id).kind !== "spell"), ctx.rng).slice(0, 1);
      break;
    case "adjacent": {
      const i = b.indexOf(m);
      ts = i >= 0 ? [b[i - 1], b[i + 1]].filter(Boolean) : [];
      break;
    }
    case "golden":
      ts = b.filter((x) => x.golden);
      break;
    case "shielded":
      ts = b.filter((x) => x.keywords.includes("圣盾"));
      break;
    case "left":
      ts = [...b];
      break;
    case "random":
    case "randomFour":
      ts = b.filter((x) => x.uid !== m.uid);
      break;
    case "menagerie": {
      const used = new Set<string>();
      for (const t of ALL_TRIBES) {
        const c = pick(
          b.filter((x) => tribe(x, t) && !used.has(x.uid)),
          ctx.rng,
        );
        if (c) {
          ts.push(c);
          used.add(c.uid);
        }
      }
      break;
    }
  }
  if (a.tribe) ts = ts.filter((x) => tribe(x, a.tribe!));
  if (a.target === "random") ts = shuffled(ts, ctx.rng).slice(0, 1);
  if (a.target === "randomFour") ts = shuffled(ts, ctx.rng).slice(0, 4);
  if (a.target === "left") ts = ts.slice(0, 1);
  return ts;
}
function scale(s: Game, key: string, a: number, h: number, board = s.board) {
  const old = delta(s, key);
  ss(s).buffs[key] = { attack: old.attack + a, health: old.health + h };
  if (key === "undead" || key === "beast")
    for (const m of [
      ...new Set([
        ...board,
        ...(board !== s.board ? s.board : []),
        ...s.hand,
        ...s.shop,
      ]),
    ])
      if (tribe(m, key === "undead" ? "亡灵" : "野兽")) addStats(m, a, h);
  if (key === "beastCombat")
    for (const m of board) if (tribe(m, "野兽")) addStats(m, a, h);
  if (["shop", "elementalShop", "lowShop"].includes(key))
    for (const m of s.shop)
      if (
        key === "shop" ||
        (key === "elementalShop" && tribe(m, "元素")) ||
        (key === "lowShop" && getDef(m.id).tier <= 3)
      )
        addStats(m, a, h);
}
function heroDamage(s: Game, n: number, ctx: Context) {
  const rewind = ctx.board.some((m) => has(m, "rewind"));
  if (!rewind) {
    damageSeasonHero(s, n);
  }
  for (const m of [...ctx.board]) run({ ...ctx, amount: n }, m, "heroDamage");
  legacyTrinketEvent({ ...ctx, amount: n }, "heroDamage");
  syncStats(s, ctx.board);
}
function run(ctx: Context, m: Minion, event: string) {
  if ((ctx.depth || 0) > 12) return;
  const repeats = event === "rally" ? Math.max(1, ...ctx.board.filter((x) => has(x, "repeatAllTriggers")).map((x) => x.golden ? 3 : 2)) : 1;
  for (let i = 0; i < repeats; i++) for (const a of ability(m, event))
    effect({ ...ctx, depth: (ctx.depth || 0) + 1 }, m, a);
}
function makeGolden(m: Minion) {
  if (m.golden) return;
  const d = getDef(m.id);
  addStats(m, (d.goldenAttack ?? d.attack * 2) - d.attack, (d.goldenHealth ?? d.health * 2) - d.health);
  m.golden = true;
  // A transformation retains its original pool copies. The caller handles rewards.
}
function bonusKeyword(m: Minion, rng: () => number) {
  const k = pick((['嘲讽', '圣盾', '复生', '风怒', '烈毒'] as Keyword[]).filter(k => !m.keywords.includes(k)), rng);
  if (k) keyword(m, k);
}
const VOLUMIZERS = ['BG34_170t', 'BG34_170t2', 'BG34_170t3'];
function deityGain(s: Game, attack: number, health: number, board = s.board) {
  const deity = ss(s).deity;
  if (!deity) return;
  deity.attack += attack; deity.health += health;
  for (const m of board.filter(m => mcount(m, 'awakenedDeity'))) addStats(m, attack, health);
}
function discardCard(ctx: Context, card: Minion) {
  const index = ctx.s.hand.indexOf(card);
  if (index < 0) return false;
  ctx.s.hand.splice(index, 1); release(ctx.s, card);
  bump(ctx.s, 'discarded');
  log(ctx.s, `弃掉${getDef(card.id).name}。`);
  run(ctx, card, 'discarded');
  for (const m of [...ctx.board]) run({ ...ctx, eventMinion: card }, m, 'discard');
  legacyTrinketEvent({ ...ctx, eventMinion: card }, 'discard');
  syncStats(ctx.s, ctx.board);
  return true;
}
function discardPartner(ctx: Context, card: Minion) {
  if (card.discardGroup) for (const other of [...ctx.s.hand])
    if (other.discardGroup === card.discardGroup) discardCard(ctx, other);
}
function linkedCards(ctx: Context, spells: boolean, aberrations = false) {
  const cards: Minion[] = [];
  for (let i = 0; i < 2; i++) {
    const m = spells ? drawSpell(ctx.s, ctx.rng) : draw(ctx.s, ctx.rng, d => d.tier <= ctx.s.tier && (!aberrations || d.races?.includes('畸变怪') === true || d.tribe === '全部'));
    if (m) cards.push(m);
  }
  for (const m of cards) { m.discardGroup = cards[0].uid; giveCard(ctx, m); }
}
function previewEffect(ctx: Context, m: Minion, a: Ability) {
  const { s, rng } = ctx, f = a.noScale ? a.amount ?? 1 : m.golden ? 2 : 1, id = a.key || getDef(m.id).sourceId;
  const deity = (attack: number, health = attack) => deityGain(s, attack * f, health * f, ctx.board);
  const grant = (id: string, amount = f) => { for (let i = 0; i < amount; i++) giveCard(ctx, makeMinion(PREFIX + id)); };
  const drawAberration = () => { const card = draw(s, rng, d => d.tier <= s.tier && (d.races?.includes('畸变怪') === true || d.tribe === '全部')); if (card) giveCard(ctx, card); };
  const volumizer = () => pick(VOLUMIZERS, rng)!;
  if (a.target === 'selectedHand' && (!ctx.target || !discardCard(ctx, ctx.target))) return;
  switch (id) {
    case 'BG32_337': if (ctx.target) for (let i = 0; i < 1 + new Set(ctx.board.flatMap(x => x.keywords)).size; i++) effect(ctx, m, { event: 'cast', op: 'buff', target: 'selected', attack: 1, health: 1 }); break;
    case 'BG35_910': { const n = 4 + count(s, 'elementalsPlayed:' + s.turn); effect(ctx, m, { event: 'cast', op: 'buff', target: 'selected', attack: n, health: n }); break; }
    case 'BG35_911': { const target = [...s.shop].sort((a, b) => b.health - a.health)[0]; if (target && ctx.target) effect(ctx, m, { event: 'cast', op: 'buff', target: 'selected', attack: Math.ceil(target.attack / 2), health: Math.ceil(target.health / 2) }); break; }
    case 'BG34_272': for (let i = 0; i < 1 + boardTypes(ctx.board).length; i++) effect(ctx, m, { event: 'cast', op: 'buff', target: 'all', attack: 3, health: 3 }); break;
    case 'BG32_MagicItem_892t': if (ctx.target) bonusKeyword(ctx.target, rng); break;
    case 'BG36_099': deity(2); break;
    case 'BG36_300': scale(s, 'spell', f, f, ctx.board); break;
    case 'BG36_311': for (let i = 0; i < f; i++) { const card = drawSpell(s, rng); if (card) giveCard(ctx, card); } break;
    case 'BG36_312': for (let i = 0; i < f; i++) drawAberration(); break;
    case 'BG28_582': grant('BG20_GEM', 3 * f); break;
    case 'BG36_100': case 'BG36_308': for (let i = 0; i < f; i++) linkedCards(ctx, id === 'BG36_100', true); break;
    case 'BG36_102': if (ctx.eventMinion === m) for (let i = 0; i < f; i++) { const target = [...(ctx.enemy || [])].filter(x => x.health > 0).sort((x, y) => y.health - x.health)[0]; if (target) ctx.damage?.(target, m.attack, m); } break;
    case 'BG36_106': gain(ctx, m, 4 * f, 4 * f); deity(4); break;
    case 'BG36_108': {
      gain(ctx, m, f, 3 * f); deity(1, 3);
      if (trinket(s, '402')) { const index = ctx.board.indexOf(m); for (const x of [ctx.board[index - 1], ctx.board[index + 1]].filter(Boolean)) gain(ctx, x, f, 3 * f); }
      break;
    }
    case 'BG36_110': deity(2); break;
    case 'BG36_111': for (const x of ctx.board) gain(ctx, x, 4 * f, 3 * f); deity(4, 3); break;
    case 'BG36_113': deity(2, 1); break;
    case 'BG36_114': if (ctx.board[0]) { const n = (2 + count(s, 'discarded')) * f; gain(ctx, ctx.board[0], n, n); } break;
    case 'BG36_318': deity(1 + ss(s).spellsCast); break;
    case 'BG36_320': for (const card of s.hand.filter(x => tavernSpellIds.has(x.id)).slice(0, 3)) if (discardCard(ctx, card)) gain(ctx, m, 8 * f, 8 * f); break;
    case 'BGFYM_005': deity(mbump(m, 'harbinger')); break;
    case 'BG36_301t': for (let i = 0; i < 2; i++) castSpell({ ...ctx, fromHand: false }, m); break;
    case 'BG36_371': if (a.event === 'cast') deity(7); else for (let i = 0; i < 2; i++) castSpell({ ...ctx, fromHand: false }, m); break;
    case 'BG36_MagicItem_417t': if (ctx.target) { (ctx.target.counters ??= {}).deityMirrorTurn = s.turn; mbump(ctx.target, 'deityMirrorCopies'); } break;
    case 'BG36_360t5': { const type = majorityTribe(s); for (let i = 0; i < f; i++) { const card = draw(s, rng, d => d.tier <= s.tier && (!type || d.races?.includes(type) === true || d.tribe === '全部')); if (card) giveCard(ctx, card); } break; }
    case 'BG36_360t9': for (let i = 0; i < 1; i++) { const card = makeMinion(PREFIX + 'BG36_360t9'); card.extraAbilities = []; card.attack = m.attack * f; card.health = (mcount(m, 'deathStatsHealth') || getDef(m.id).health) * f; card.id = PREFIX + 'BG29_864t'; ctx.summon?.(card, ctx.sourcePos ?? ctx.board.length); } break;
    case 'BG36_362': if (a.event === 'activate') mbump(m, 'wrathguard'); else { const n = 2 * (1 + mcount(m, 'wrathguard')) * f; scale(s, 'shop', n, n, ctx.board); } break;
    case 'BG36_364': if (a.event === 'shieldLost') { mbump(m, 'hope'); ctx.remember?.(m, 'hope', 1); } else { const n = (3 + mcount(m, 'hope')) * f; for (const x of ctx.board) gain(ctx, x, n, n); } break;
    case 'BG36_366': for (let i = 0; i < f; i++) { const id = volumizer(); const card = makeMinion(PREFIX + id); syncCardStats(s, card); magnetize(ctx, m, card); grant(id, 1); } break;
    case 'BG36_367': if (mbump(m, 'autoPurchases') % 3 === 0) for (let i = 0; i < f; i++) grant(volumizer(), 1); break;
    case 'BG36_369': if (m.golden) queueDiscover(s, 'minion', { tiers: [7] }); break;
    case 'BG36_370': for (let i = 0; i < 6 * f; i++) if (room(s)) grant('BG20_GEM', 1); else if (ctx.board[0]) effect({ ...ctx, target: ctx.board[0] }, m, { event: 'activate', op: 'gem', target: 'selected', noScale: true }); break;
    case 'BG36_700': if (ctx.target) { gain(ctx, ctx.target, 7 * f, 7 * f); for (let i = 0; i < f; i++) bonusKeyword(ctx.target, rng); } break;
    case 'BG36_848': { const card = pick(s.board, rng); if (card) grant(getDef(card.id).sourceId!, f); break; }
    case 'BG36_849': if (a.event === 'rally') keyword(m, '圣盾'); else (m.counters ??= {}).immediateAttack = f; break;
    case 'BGFYM_000': {
      const targets = ctx.board.filter(x => x !== m && x.health > 0);
      if (!targets.length) break;
      const allocations = targets.map(() => ({ attack: 0, health: 0 }));
      for (const [stat, total] of [['attack', m.attack * f], ['health', m.health * f]] as const)
        for (let i = 0; i < total; i++) allocations[Math.floor(rng() * targets.length)][stat]++;
      targets.forEach((target, i) => gain(ctx, target, allocations[i].attack, allocations[i].health));
      break;
    }
    case 'BGFYM_011': for (const dead of (ctx.deadAberrations || []).slice(0, 2 * f)) { const card = combatCopy(dead); card.health = mcount(dead, 'deathStatsHealth') || getDef(dead.id).health; ctx.summon?.(card, ctx.sourcePos ?? ctx.board.length); } break;
    case 'BG34_170': case 'BG34_171': for (let i = 0; i < f; i++) grant(volumizer(), 1); break;
    case 'BG34_170t': case 'BG34_170t2': case 'BG34_170t3': if (!mcount(m, 'volumizerUsed')) { mbump(m, 'volumizerUsed'); scale(s, 'volumizer', (id === 'BG34_170t' ? 3 : id === 'BG34_170t3' ? 1 : 0) * f, (id === 'BG34_170t2' ? 3 : id === 'BG34_170t3' ? 1 : 0) * f, ctx.board); syncStats(s, ctx.board); syncCardStats(s, m); } break;
    case 'BG31_149': for (let i = 0; i < f; i++) bonusKeyword(m, rng); break;
    case 'BG32_231': for (const x of shuffled(ctx.board.filter(x => tribe(x, '海盗') && !x.golden && getDef(x.id).tier <= 4), rng).slice(0, f)) makeGolden(x); break;
    case 'BG35_882': grant('BG35_910'); break;
    case 'BGS_008': for (let i = 0; i < 2 * f; i++) { const d = pick(poolCards(s).filter(d => d.abilities?.some(a => a.event === 'death')), rng); if (d) ctx.summon?.(makeMinion(d.id), ctx.sourcePos ?? ctx.board.length); } break;
    case 'BG31_148': { const n = 1 + new Set(ctx.board.flatMap(x => x.keywords)).size; for (const x of ctx.board.filter(x => x !== m)) gain(ctx, x, 3 * f * n, 2 * f * n); break; }
    case 'BG31_812': if (ctx.eventMinion) { const x = ctx.eventMinion, had = x.keywords.includes('圣盾'); keyword(x, '圣盾'); if (!m.golden && !had) (x.temporary ??= { attack: 0, health: 0, keywords: [] }).keywords.push('圣盾'); } break;
    case 'BGS_040': for (const x of shuffled(ctx.board.filter(x => tribe(x, '龙')), rng).slice(0, 3 * f)) keyword(x, '圣盾'); break;
    case 'BG34_405': keyword(m, '圣盾'); break;
    case 'BG31_810': if (a.event === 'playElemental') mbump(m, 'ultraviolet'); else for (const x of ctx.board.filter(x => x !== m && tribe(x, '元素'))) gain(ctx, x, 3 * f * (1 + mcount(m, 'ultraviolet')), 2 * f * (1 + mcount(m, 'ultraviolet'))); break;
    case 'BG22_403': { const i = ctx.board.indexOf(m), adjacent = [ctx.board[i - 1], ctx.board[i + 1]].filter(Boolean); for (const x of m.golden ? adjacent : [pick(adjacent, rng)].filter(Boolean) as Minion[]) triggerBattlecry(ctx, x); break; }
  }
}

function effect(ctx: Context, m: Minion, a: Ability) {
  ctx = { ...ctx, source: m };
  if (a.trinket) ctx = { ...ctx, trinket: true };
  const { s, rng } = ctx,
    f = m.golden && !a.noScale ? 2 : 1,
    n = (a.amount ?? 1) * f;
  const targets = () => buffTargets(ctx, m, a);
  switch (a.op) {
    case "preview": previewEffect(ctx, m, a); break;
    case "roogug": {
      const target = pick(ctx.board.filter((x) => x.id !== m.id), rng);
      if (target && ctx.board.includes(m)) effect({ ...ctx, target }, m, { event: "gemPlayed", op: "gem", target: "selected" });
      break;
    }
    case "deathStats":
      for (const x of targets()) gain(ctx, x, m.attack, mcount(m, "deathStatsHealth"));
      break;
    case "buff": {
      let attack = (a.attack || 0) * f,
        health = (a.health || 0) * f;
      if (a.event === "cast" && tavernSpellIds.has(m.id) && !m.tempSpell) {
        if (tavernSpellIds.has(m.id)) {
          for (const source of ctx.board) for (const aura of ability(source).filter((a) => a.op === "spellAura")) {
            attack += (aura.attack || 0) * (source.golden && !aura.noScale ? 2 : 1);
            health += (aura.health || 0) * (source.golden && !aura.noScale ? 2 : 1);
          }
        }
        const b = delta(s, "spell");
        attack += b.attack;
        health += b.health;
        if (hasPower(s, "rakanishu")) { attack += 1 + Math.floor((s.turn - 1) / 3); health += 1 + Math.floor((s.turn - 1) / 3); }
        if (trinket(s, "373")) {
          const count = (1 + boardTypes(ctx.board).length) * trinketCopies(s, "373");
          attack += count;
          health += count * 2;
        }
        const honey = trinketCopies(s, "371") * (1 + count(s, "honeycomb:" + s.turn));
        attack += honey;
        health += honey;
        const forest = itemCount(s, "BG32_MagicItem_801t") * (1 + Math.floor(count(s, "forestSpells") / 6));
        attack += forest; health += forest;
      }
      if (m.id === PREFIX + "BG28_741" && itemCount(s, "BG32_MagicItem_283")) health += attack;
      for (const t of targets()) {
        const hadKeyword = a.keyword ? t.keywords.includes(a.keyword) : false;
        const hadWindfury = t.keywords.includes("风怒");
        gain(ctx, t, attack, health);
        if (a.keyword) {
          if (a.toggle && t.keywords.includes(a.keyword))
            t.keywords = t.keywords.filter((k) => k !== a.keyword);
          else keyword(t, a.keyword);
        }
        if (a.key === "nagaWindfury" && tribe(t, "纳迦")) keyword(t, "风怒");
        if (a.permanent && ctx.combat) ctx.permanent?.(t, attack, health);
        if (!ctx.permanentSpell && (m.tempSpell || a.key === "nagaWindfury")) {
          const prior = t.temporary || { attack: 0, health: 0, keywords: [] };
          prior.attack += m.tempSpell ? attack : 0;
          prior.health += m.tempSpell ? health : 0;
          if (a.keyword && !hadKeyword && !prior.keywords.includes(a.keyword))
            prior.keywords.push(a.keyword);
          if (a.key === "nagaWindfury" && tribe(t, "纳迦") && !hadWindfury && !prior.keywords.includes("风怒")) prior.keywords.push("风怒");
          t.temporary = prior;
        }
      }
      break;
    }
    case "gem": {
      const b = delta(s, "gem"), surveyor = ctx.fromHand ? 6 * itemCount(s, "BG30_MagicItem_943") + ctx.board.filter(x => x.id === PREFIX + "BG30_121").reduce((sum, x) => sum + (x.golden ? 2 : 1), 0) : 0,
        attack = (1 + b.attack + surveyor) * n,
        health = (1 + b.health + surveyor) * n;
      for (const t of targets()) {
        gain(ctx, t, attack, health);
        t.gems = {
          attack: (t.gems?.attack || 0) + attack,
          health: (t.gems?.health || 0) + health,
        };
        if (ctx.combat && a.permanent) ctx.permanent?.(t, attack, health);
        for (let i = 0; i < n; i++) run({ ...ctx, eventMinion: m }, t, "gemPlayed");
      }
      break;
    }
    case "setStats":
      for (const t of targets()) {
        t.attack = a.attack || 0;
        t.health = a.health || 1;
      }
      break;
    case "doubleAttack":
      for (const t of targets()) addStats(t, t.attack * f, 0);
      break;
    case "scale":
      if (m.id === PREFIX + "BG28_707" && itemCount(s, "BG30_MagicItem_431")) for (const x of ctx.board.filter(x => tribe(x, "元素"))) gain(ctx, x, 3 * f, 2 * f);
      scale(s, a.key!, (a.attack || 0) * f, (a.health || 0) * f, ctx.board);
      break;
    case "goldNext":
      ss(s).nextGold += n;
      break;
    case "gold":
      if (ctx.trinket) trinketGold(s, n); else gold(s, n);
      break;
    case "goldCap":
      ss(s).maxGold += n;
      break;
    case "armor":
      ss(s).spellArmor = Math.max(0, n - (ss(s).armor - (ss(s).spellArmor || 0)));
      ss(s).armor = n;
      break;
    case "freeRefresh":
      ss(s).freeRefresh += n;
      break;
    case "discountSpell":
      ss(s).spellDiscount += n;
      break;
    case "fodder":
      ss(s).fodder += n;
      break;
    case "spell":
      for (let i = 0; i < n; i++) {
        const d = getDef(PREFIX + a.id);
        if (d) {
          const card = makeMinion(d.id);
          if (eventCombat(a.event) && ctx.combat)
            castSpell({ ...ctx, target: undefined }, card);
          else giveCard(ctx, card);
        }
      }
      break;
    case "randomSpell":
      for (let i = 0; i < n; i++) {
        const card = drawSpell(s, rng, (d) =>
          a.cost !== undefined ? d.cost === a.cost : d.tier <= s.tier,
        );
        if (card) giveCard(ctx, card);
      }
      break;
    case "generate":
      for (let i = 0; i < n; i++) {
        if (getDef(PREFIX + a.id)) giveCard(ctx, makeMinion(PREFIX + a.id));
      }
      break;
    case "draw":
    case "drawType":
      for (let i = 0; i < n; i++) {
        const t =
          a.op === "drawType" ? getDef(ctx.target?.id || m.id).tribe : a.tribe;
        const c = draw(
          s,
          rng,
          (d) =>
            (a.tier ? d.tier === a.tier : d.tier <= s.tier) &&
            (!t || d.races?.includes(t as Tribe) || d.tribe === "全部") &&
            (!a.magnetic || !!d.magnetic),
        );
        if (c) giveCard(ctx, c);
      }
      break;
    case "replacePower":
      offerPowers(s, "replace", rng);
      break;
    case "discoverMinion":
      for (let i = 0; i < n; i++) queueEffectDiscover(ctx, "minion", {
        ...(a.tier || a.key === "currentTier" ? { tiers: [a.tier || s.tier] } : {}), mechanic: a.key === "currentTier" ? undefined : a.key, tribe: a.tribe,
      });
      break;
    case "majorityDiscover":
    case "majorityDraw": {
      const counts = ALL_TRIBES.map((t) => ({ t, count: ctx.board.filter((x) => tribe(x, t)).length }));
      const max = Math.max(...counts.map((x) => x.count));
      const t = max ? pick(counts.filter((x) => x.count === max), rng)?.t : undefined;
      if (a.op === "majorityDiscover") queueEffectDiscover(ctx, "minion", { tribe: t });
      else {
        const card = draw(s, rng, (d) => d.tier <= s.tier && (!t || d.races?.includes(t) || d.tribe === "全部"));
        if (card) giveCard(ctx, card);
      }
      break;
    }
    case "drawId": {
      const card = draw(s, rng, (d) => d.id === PREFIX + a.id);
      if (card) giveCard(ctx, card);
      break;
    }
    case "handStats":
      for (const card of s.hand.filter((x) => getDef(x.id).kind !== "spell")) addStats(m, card.attack * f, card.health * f);
      break;
    case "castTavern":
      for (let i = 0; i < n; i++) castSpell({ ...ctx, target: undefined, fromHand: false }, makeMinion(PREFIX + a.id));
      break;
    case "buffType": {
      const races = ALL_TRIBES.filter((t) => ctx.target && tribe(ctx.target, t));
      for (const t of [...ctx.board, ...s.shop].filter((x) => races.some((r) => tribe(x, r))))
        effect({ ...ctx, target: t }, m, { ...a, op: "buff", target: "selected" });
      break;
    }
    case "golden": {
      const target = a.target === "selected" ? ctx.target : pick(s.shop.filter((m) => !m.golden), rng);
      if (target && !target.golden) {
        makeGolden(target);
        if (s.shop.includes(target)) target.reward = true;
        if (m.id === PREFIX + "BG25_034" && m.golden) {
          const other = pick(ctx.board.filter((x) => x !== target && !x.golden && getDef(x.id).tier <= 6), rng);
          if (other) makeGolden(other);
        }
      }
      break;
    }
    case "deathrattle":
      if (ctx.target) for (let i = 0; i < n; i++) death(ctx, ctx.target);
      break;
    case "discoverSpell":
      for (let i = 0; i < n; i++) queueEffectDiscover(ctx, "spell", a.key === "currentTier" ? { tiers: [s.tier] } : {});
      break;
    case "steal":
    case "stealHighest": {
      const t =
        a.op === "stealHighest"
          ? [...s.shop].sort((a, b) => b.attack - a.attack)[0]
          : pick(s.shop, rng);
      if (t) {
        s.shop = s.shop.filter((x) => x.uid !== t.uid);
        giveCard(ctx, t);
      }
      break;
    }
    case "consume":
      for (const eater of targets())
        for (let i = 0; i < (a.amount || 1) * f; i++) {
          const t = a.highest
            ? [...s.shop].sort((a, b) => b.health - a.health)[0]
            : pick(s.shop, rng);
          if (t) consumeMinion(ctx, eater, t, 1, !!a.keywords);
        }
      break;
    case "weaver":
      heroDamage(s, 1, ctx);
      addStats(m, (a.attack || 0) * f, (a.health || 0) * f);
      break;
    case "rewind":
      if (a.target === "shop")
        ctx.s.shop.forEach((x) =>
          addStats(x, (a.attack || 0) * f, (a.health || 0) * f),
        );
      else gain(ctx, m, itemCount(s, "BG30_MagicItem_868") ? (a.health || 0) * f : 0, (a.health || 0) * f);
      break;
    case "baller": {
      const prior = delta(s, "baller");
      for (const t of ctx.board)
        addStats(
          t,
          ((a.attack || 0) + prior.attack) * f,
          ((a.health || 0) + prior.health) * f,
        );
      scale(s, "baller", 1, 1);
      break;
    }
    case "lobster": {
      const prior = delta(s, "lobster");
      const t = pick(
        ctx.board.filter((x) => tribe(x, "野兽") && x.uid !== m.uid),
        rng,
      );
      if (t) addStats(t, (2 + prior.attack) * f, (1 + prior.health) * f);
      scale(s, "lobster", 2, 1);
      break;
    }
    case "summon":
      for (let i = 0; i < summonCount(m, a); i++) {
        const d = getDef(PREFIX + a.id);
        if (d) {
          const c = makeMinion(d.id, summonIsGolden(m, a));
          applyGlobal(s, c);
          const beast = delta(s, "beastCombat");
          if (tribe(c, "野兽")) addStats(c, beast.attack, beast.health);
          if (ctx.summon)
            ctx.summon(c, (ctx.sourcePos ?? ctx.board.indexOf(m)) + 1 + i);
          else if (ctx.board.length < 7) {
            const pos = (ctx.sourcePos ?? ctx.board.indexOf(m)) + 1 + i;
            ctx.board.splice(Math.max(0, Math.min(pos, ctx.board.length)), 0, c);
            notifySummon(ctx, c);
          }
        }
      }
      break;
    case "rally":
      if (ctx.target) for (let i = 0; i < n; i++) run(ctx, ctx.target, "rally");
      break;
    case "battlecry":
      for (const t of targets())
        triggerBattlecry({ ...ctx, target: undefined }, t);
      break;
    case "craft":
    case "craftScale": {
      const raw = getDef(m.id).sourceId!;
      const spellId = raw + "t";
      if (getDef(PREFIX + spellId)) {
        const c = makeMinion(PREFIX + spellId);
        c.golden = m.golden;
        c.expires = true;
        c.tempSpell = a.op === "craft" && a.key !== "nagaWindfury";
        c.extraAbilities = [
          {
            ...a,
            event: "cast",
            op: a.op === "craft" ? "buff" : "scale",
            target: a.op === "craft" ? "selected" : undefined,
          },
        ];
        giveCard(ctx, c);
      }
      break;
    }
    case "damageAll":
      for (const t of [...ctx.board, ...(ctx.enemy || [])])
        if (t.uid !== m.uid) {
          if (ctx.damage) ctx.damage(t, n, m);
          else if (t.keywords.includes("圣盾"))
            t.keywords = t.keywords.filter((k) => k !== "圣盾");
          else t.health -= n;
        }
      break;
    default:
      expandedEffect(ctx, m, a);
  }
}
const eventCombat = (event: string) => event === "combat";
function spend(ctx: Context, amount: number) {
  ctx.s.gold -= amount;
  ss(ctx.s).goldSpentTurn = (ss(ctx.s).goldSpentTurn || 0) + amount;
  if (amount > 0) legacyTrinketEvent({ ...ctx, amount }, "spend");
  bump(ctx.s, "goldSpent", amount);
  countPowerEvent(ctx.s, "goldSpent", amount);
  for (let i = 0; i < amount; i++) for (const x of [...ctx.board]) run({ ...ctx, amount: 1 }, x, "spentGold");
}
function heroPurchased(ctx: Context, m: Minion) {
  const { s, rng } = ctx, st = ss(s), spell = getDef(m.id).kind === "spell";
  bump(s, "boughtCards");
  countPowerEvent(s, "boughtCards");
  const previousTiers = powerCount(s, "guff", "boughtTiers");
  countPowerEvent(s, "boughtTiers", getDef(m.id).tier);
  const tiers = powerCount(s, "guff", "boughtTiers");
  if (hasPower(s, "guff") && Math.floor(tiers / 20) > Math.floor(previousTiers / 20)) reward(s);
  if (spell) { bump(s, "boughtSpells"); countPowerEvent(s, "boughtSpells"); }
  else {
    (st.boughtTurn ??= []).push(m.id); bump(s, "boughtMinions"); countPowerEvent(s, "boughtMinions"); countPowerEvent(s, "boughtMinionsTurn");
    if (hasPower(s, "saurfang") && powerCount(s, "saurfang", "boughtMinions") % 3 === 0) for (const x of s.shop) gain(ctx, x, 1, 1);
    if (hasPower(s, "kaelthas") && powerCount(s, "kaelthas", "boughtMinions") % 3 === 0) putHand(s, makeMinion(PREFIX + "BG28_810"));
    if (hasPower(s, "kurtrus") && powerCount(s, "kurtrus", "boughtMinionsTurn") === 3) putHand(s, makeMinion(pick(st.boughtTurn.slice(-3), rng)!));
    if (hasPower(s, "patches") && tribe(m, "海盗")) bump(s, "patchesDiscount");
    if (hasPower(s, "brann") && ability(m, "battlecry").length && bump(s, "brannBuys") === 4) putHand(s, makeMinion(PREFIX + "BG_LOE_077"));
  }
}
function heroStart(ctx: Context) {
  const { s, rng } = ctx, st = ss(s);
  st.boughtTurn = [];
  for (const key of Object.keys(st.counters || {})) if (key.endsWith(":boughtMinionsTurn")) st.counters![key] = 0;
  if (hasPower(s, "togwaggle")) bump(s, "togwaggleDiscount");
  if (hasPower(s, "nobundo")) bump(s, "nobundoDiscount");
  if (hasPower(s, "afk")) {
    if (s.turn <= 2) s.gold = 0;
    if (s.turn === 3) { queueDiscover(s, "minion", { tiers: [3] }); queueDiscover(s, "minion", { tiers: [4] }); }
  }
  if (hasPower(s, "vashj")) expandedEffect(ctx, makeMinion(PREFIX + "BG25_001"), { event: "start", op: "randomSpellcraft" });
  if (hasPower(s, "yogg") && s.turn >= 3) {
    const spell = drawSpell(s, rng); if (spell) castSpell({ ...ctx, fromHand: false }, spell);
  }
}
function heroEnd(ctx: Context) {
  const { s, rng } = ctx, st = ss(s);
  if (hasPower(s, "sindragosa")) s.frozen = true;
  if (hasPower(s, "voone") && s.turn % 3 === 0 && s.hand[0]) {
    const source = s.hand[0], copy = getDef(source.id).kind === "spell" ? clone(source) : makeMinion(source.id);
    copy.uid = makeMinion(source.id).uid; copy.copies = {};
    if (copy.id === PREFIX + "BG36_520t") copy.lockedUntil = s.turn + 5;
    putHand(s, copy);
  }
  if (hasPower(s, "cthun") && count(s, "cthunTurn") === s.turn) for (let i = 0; i < s.turn; i++) {
    const target = pick(s.board, rng); if (target) gain(ctx, target, 1, 1);
  }
  if (hasPower(s, "ragnaros") && powerCount(s, "ragnaros", "boughtCards") >= 12) for (const x of new Set([s.board[0], s.board.at(-1)].filter(Boolean))) gain(ctx, x!, 4, 4);
}
function reward(s: Game, tier = Math.min(6, s.tier + 1)) {
  if (itemCount(s, "BG35_MagicItem_812")) { trinketCard(s, makeMinion(PREFIX + "BG35_MagicItem_812t")); return; }
  if (room(s)) s.rewards.push(tier);
  else log(s, "手牌已满，无法获得三连奖励。");
}
function copyDiscovery(s: Game, ids: string[], rng: () => number) {
  const options = shuffled([...new Set(ids)], rng).slice(0, 3);
  if (options.length) queueDiscover(s, "copy", { options });
}
function expandedHeroAction(ctx: Context, key: string, target?: Minion): string | undefined {
  const { s, rng } = ctx, st = ss(s), dummy = makeMinion(PREFIX + "BG25_001");
  const c = { ...ctx, target };
  switch (key) {
    case "edwin": if (target) gain(ctx, target, 2 + 2 * Math.floor(powerCount(s, "edwin", "boughtCards") / 4), 2 + 2 * Math.floor(powerCount(s, "edwin", "boughtCards") / 4)); break;
    case "mutanus": expandedEffect(c, dummy, { event: "power", op: "sellTransfer", target: "selected" }); break;
    case "cookie": if (target) {
      st.cookieTribes = [...(st.cookieTribes || []), ...ALL_TRIBES.filter((t) => tribe(target, t))];
      if (s.board.includes(target)) { s.board.splice(s.board.indexOf(target), 1); release(s, target); }
      else { s.shop = s.shop.filter((m) => m.uid !== target.uid); release(s, target); }
      if (bump(s, "cookieCount") % 3 === 0) {
        const eligible = new Set(st.cookieTribes); st.cookieTribes = [];
        const candidates = poolCards(s).filter((d) => s.pool[d.id] > 0 && d.tier <= s.tier && (d.tribe === "全部" || d.races?.some((t) => eligible.has(t))));
        const options = shuffled(candidates, rng).slice(0, 3).map((d) => d.id);
        // Reserve the actual finite-pool copies when opening this discovery.
        queueDiscover(s, "cookie", { options });
      }
    } break;
    case "scabbs": {
      const board = ctx.opponentBoard || s.opponents[s.nextOpponent]?.board || [];
      if (!board.length) return "下一个对手没有可供发现的随从。";
      copyDiscovery(s, board.map((m) => m.id), rng); break;
    }
    case "sylvanas": if (!st.lastDead?.length) return "上一场战斗没有死亡随从。"; else copyDiscovery(s, st.lastDead, rng); break;
    case "galakrond": if (target) queueDiscover(s, "minion", { tiers: [Math.min(6, getDef(target.id).tier + 1)], replaceShop: target.uid }); break;
    case "tavish": if (target) {
      (st.heroMarks ??= {}).tavishId = target.id;
      (st.counters ??= {}).tavishAttack = target.attack;
      s.shop = s.shop.filter((m) => m.uid !== target.uid); release(s, target);
    } break;
    case "togwaggle":
      for (const m of [...s.shop, ...st.spellShop]) putHand(s, m);
      s.shop = []; st.spellShop = []; (st.counters ??= {}).togwaggleDiscount = 0; break;
    case "teron": if (target) (st.heroMarks ??= {}).teron = target.uid; break;
    case "zerek": if (target) {
      if (s.board.length >= 7) return "战场已满。";
      const copy = clone(target); copy.uid = makeMinion(target.id).uid; copy.copies = {}; copy.reward = false;
      s.board.push(copy); notifySummon(ctx, copy);
    } break;
    case "snakeEyes": {
      const roll = Math.min(6, Math.floor(rng() * 6) + 1);
      gold(s, roll); (st.counters ??= {}).snakeUnlock = s.turn + roll;
      log(s, `骰子点数：${roll}。`); break;
    }
    case "nobundo": if (!st.lastSpell) return "还没有施放过酒馆法术。"; else { putHand(s, makeMinion(st.lastSpell)); (st.counters ??= {}).nobundoDiscount = 0; } break;
    case "akazamzarakScholar": st.spellDiscount++; break;
    case "cenarius": st.maxGold++; break;
    case "chromie": expandedEffect(ctx, dummy, { event: "power", op: "spellShop" }); break;
    case "ratKing": queueDiscover(s, "minion", { tribe: st.tribes[(s.turn - 1) % st.tribes.length] }); break;
    case "patches": {
      const m = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("海盗") === true || d.tribe === "全部"));
      if (m) putHand(s, m); (st.counters ??= {}).patchesDiscount = 0; break;
    }
    case "shudderwock": if (target) triggerBattlecry({ ...ctx, target: undefined }, target); break;
    case "bazhial": case "maiev": if (target) {
      s.shop = s.shop.filter((m) => m.uid !== target.uid); st.spellShop = st.spellShop.filter((m) => m.uid !== target.uid);
      if (key === "maiev") target.lockedUntil = s.turn + 2;
      putHand(s, target); if (key === "bazhial") heroDamage(s, 2, ctx);
    } break;
    case "toki":
      refill(s, rng);
      for (let i = 0; i < 2; i++) {
        const card = draw(s, rng, (d) => d.tier === Math.min(6, s.tier + 1));
        if (card) { const old = s.shop.pop(); if (old) release(s, old); applyShop(s, card); s.shop.unshift(card); }
      }
      break;
    case "cthun": (st.counters ??= {}).cthunTurn = s.turn; break;
    case "rafaam": (st.counters ??= {}).rafaamTurn = s.turn; break;
    case "tess":
      if (!st.lastEnemy?.length) return "还没有上一场对手的战队记录。";
      s.shop.forEach((m) => release(s, m)); s.shop = st.lastEnemy.map((m) => makeMinion(m.id));
      st.spellShop = []; { const spell = drawSpell(s, rng); if (spell) st.spellShop.push(spell); }
      s.frozen = false; break;
    case "malygos": if (target) {
      const spell = getDef(target.id).kind === "spell";
      const replacement = spell ? drawSpell(s, rng, (d) => d.tier === getDef(target.id).tier) : draw(s, rng, (d) => d.tier === getDef(target.id).tier);
      if (replacement) {
        const zone = [s.board, s.shop, s.hand, st.spellShop].find((z) => z.includes(target))!;
        zone[zone.indexOf(target)] = replacement; release(s, target);
      }
    } break;
    case "eudora": if (bump(s, "eudoraDigs") % 4 === 0) {
      const d = pick(poolCards(s).filter((d) => d.tier <= s.tier), rng);
      if (d) { const card = makeMinion(d.id, true); card.reward = true; putHand(s, card); }
    } break;
    case "hooktusk": if (target) {
      s.board.splice(s.board.indexOf(target), 1); release(s, target);
      queueDiscover(s, "minion", { tiers: [Math.max(1, getDef(target.id).tier - 1)] });
    } break;
    case "kragg": gold(s, s.turn + 1); break;
    case "jailer": if (target && destroyRecruit(ctx, target)) {
      const card = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("亡灵") === true || d.tribe === "全部")); if (card) putHand(s, card);
    } break;
    case "jandice": if (target) {
      const other = pick(s.shop, rng); if (!other) return "酒馆没有可交换的随从。";
      const index = s.board.indexOf(target); s.board[index] = other;
      s.shop[s.shop.indexOf(other)] = target;
    } break;
    case "zephrys": {
      const cards = [...s.board, ...s.hand].filter((m) => !m.golden && getDef(m.id).kind !== "spell");
      const matches = cards.filter((m) => cards.filter((x) => x.id === m.id).length >= 2 && s.pool[m.id] > 0);
      const m = pick(matches, rng); if (!m) return "没有可补齐三连的随从对子。";
      const card = draw(s, rng, (d) => d.id === m.id); if (card) putHand(s, card); break;
    }
    case "yshaarj": (st.counters ??= {}).yshaarjTurn = s.turn; break;
  }
}
function openLockboxes(ctx: Context) {
  for (const chest of [...ctx.s.hand]) if (chest.id === PREFIX + "BG36_520t" && (chest.lockedUntil || Infinity) <= ctx.s.turn) {
    ctx.s.hand.splice(ctx.s.hand.indexOf(chest), 1);
    const d = pick(poolCards(ctx.s).filter((d) => d.tier <= ctx.s.tier && !!d.races?.length), ctx.rng);
    if (d) putHand(ctx.s, makeMinion(d.id, true));
    log(ctx.s, "上锁宝箱已打开，获得金色随从。");
  }
}
function fishbait(ctx: Context, source: Minion, target: Minion | undefined, factor: number) {
  if (!target) return;
  const zone = ctx.s.shop.includes(target) ? ctx.s.shop : ss(ctx.s).spellShop;
  const index = zone.indexOf(target);
  if (index < 0) return;
  release(ctx.s, target);
  const bait = makeMinion(PREFIX + "BG36_205", factor === 2);
  zone.splice(index, 1);
  ctx.s.shop.splice(Math.min(index, ctx.s.shop.length), 0, bait);
  const attacker = ctx.board.find((x) => tribe(x, "野兽"));
  if (!attacker || attacker.attack <= 0) return;
  if (trinket(ctx.s, "201")) gain(ctx, attacker, 4 * trinketCopies(ctx.s, "201"), 2 * trinketCopies(ctx.s, "201"));
  if (ability(attacker, "rally").length) ss(ctx.s).freeRefresh += trinketCopies(ctx.s, "200");
  const attackCtx = { ...ctx, target: bait, eventMinion: attacker, enemy: [bait], sourcePos: ctx.board.indexOf(attacker) };
  run(attackCtx, attacker, "rally"); giftEvent(attackCtx, attacker, "rally");
  for (const x of [...ctx.board]) {
    run(attackCtx, x, "attackBeast");
    if (x.uid !== attacker.uid) run(attackCtx, x, "otherAttack");
  }
  bait.health -= attacker.attack;
  if (bait.health <= 0) {
    ctx.s.shop.splice(ctx.s.shop.indexOf(bait), 1);
    gain(ctx, attacker, 5 * factor, 5 * factor);
    legacyTrinketEvent({ ...ctx, eventMinion: bait }, "death");
    run({ ...ctx, amount: Math.min(attacker.attack, getDef(bait.id).health), target: bait }, attacker, "dealtDamage");
  }
  for (const x of [...ctx.board]) run(attackCtx, x, "afterAttack");
  log(ctx.s, `${getDef(source.id).name}放置鱼饵，${getDef(attacker.id).name}发起攻击。`);
}
function destroyRecruit(ctx: Context, target: Minion) {
  const pos = ctx.board.indexOf(target);
  if (pos < 0) return false;
  if (ctx.combat) { target.health = 0; return true; }
  ctx.board.splice(pos, 1);
  let insertion = pos;
  const summon = (m: Minion) => {
    if (ctx.board.length >= 7) return;
    ctx.board.splice(insertion++, 0, m);
    notifySummon(ctx, m);
  };
  death({ ...ctx, sourcePos: pos, summon }, target);
  legacyTrinketEvent({ ...ctx, eventMinion: target }, "destroy");
  if (target.id === PREFIX + "BG34_690") for (let i = 0; i < trinketCopies(ctx.s, "204"); i++) trinketCard(ctx.s, makeMinion(target.id));
  if (target.keywords.includes("复生") && ctx.board.length < 7) {
    const revived = makeMinion(target.id, target.golden);
    applyGlobal(ctx.s, revived); revived.health = 1;
    revived.keywords = revived.keywords.filter((k) => k !== "复生");
    summon(revived);
    for (const x of [...ctx.board]) run({ ...ctx, eventMinion: revived }, x, "reborn");
  }
  release(ctx.s, target);
  return true;
}
function sellOwned(ctx: Context, m: Minion) {
  const i = ctx.board.indexOf(m);
  if (i < 0) return false;
  ctx.board.splice(i, 1); release(ctx.s, m); gold(ctx.s, 1);
  run(ctx, m, "sell");
  legacyTrinketEvent({ ...ctx, eventMinion: m }, "sell");
  bump(ctx.s, "soldMinions");
  if (["BG31_816", "BG31_818"].includes(getDef(m.id).sourceId!)) bump(ctx.s, "soldBaller");
  countPowerEvent(ctx.s, "soldMinions");
  if (hasPower(ctx.s, "gallywix")) ss(ctx.s).nextGold++;
  if (hasPower(ctx.s, "flurgl") && powerCount(ctx.s, "flurgl", "soldMinions") % 5 === 0) {
    const card = draw(ctx.s, ctx.rng, (d) => d.tier <= ctx.s.tier && (d.races?.includes("鱼人") === true || d.tribe === "全部")); if (card) putHand(ctx.s, card);
  }
  if (mcount(m, "hats")) {
    const next = pick(ctx.board, ctx.rng);
    if (next) { const hats = mcount(m, "hats"); gain(ctx, next, hats, hats); mbump(next, "hats", hats); }
  }
  for (const x of [...ctx.board]) {
    if (tribe(m, "元素")) run({ ...ctx, eventMinion: m }, x, "sellElemental");
    run({ ...ctx, eventMinion: m }, x, "sellMinion");
  }
  return true;
}
function darkmoonPrize(ctx: Context, m: Minion) {
  const { s, rng, target } = ctx, id = getDef(m.id).sourceId!.slice(-3);
  const grant = (id: string) => giveCard(ctx, makeMinion(PREFIX + id));
  const act = (op: string, rest: Partial<Ability> = {}) => effect(ctx, m, { event: "cast", op, ...rest });
  switch (id) {
    case "000": act("buff", { target: "selected", attack: 2, health: 2 }); break;
    case "001": grant("BG28_810"); grant("BG28_810"); break;
    case "004": queueEffectDiscover(ctx, "minion", { tiers: [1] }); break;
    case "006": {
      for (const old of [...s.shop]) { const next = draw(s, rng, (d) => d.tier === Math.min(6, getDef(old.id).tier + 1)); if (next) { s.shop[s.shop.indexOf(old)] = next; release(s, old); applyShop(s, next); } }
      ss(s).spellShop = ss(s).spellShop.flatMap((old) => { const next = drawSpell(s, rng, (d) => d.tier === Math.min(6, getDef(old.id).tier + 1)); return next ? [next] : [old]; }); break;
    }
    case "007": act("buff", { target: "all", attack: s.tier }); break;
    case "009": if (target) (target.extraAbilities ??= []).push({ event: "end", op: "buff", attack: 4, health: 4, noScale: true }); break;
    case "010": queueEffectDiscover(ctx, "minion", { options: shuffled([...new Set((ss(s).lastEnemy || []).map((m) => m.id))], rng).slice(0, 3) }); break;
    case "011": offerPowers(s, "replace", rng); break;
    case "012": queueEffectDiscover(ctx, "minion", { tiers: [s.tier] }); break;
    case "013": scale(s, "shop", 1, 1); break;
    case "014": gold(s, 1); bump(s, "unlimitedCoins:" + s.turn); break;
    case "015": act("buff", { target: "selected", attack: 10, keyword: "圣盾" }); break;
    case "016": if (target) { makeGolden(target); target.reward = true; s.board.splice(s.board.indexOf(target), 1); giveCard(ctx, target); } break;
    case "018": if (target) { gain(ctx, target, 2, 0); gain(ctx, target, target.attack, 0); } break;
    case "019": while (room(s)) grant("BG28_897"); break;
    case "020": queueEffectDiscover(ctx, "minion", s.tier >= 6 ? { options: shuffled(tierSevenPool, rng).slice(0, 3).map((id) => PREFIX + id) } : { tiers: [s.tier + 1] }); break;
    case "022": bump(s, "prizeMinionCost"); break;
    case "023": ss(s).freeRefresh += 5; bump(s, "prizeRefresh", 5); break;
    case "025": gold(s, 12); break;
    case "026": if (target) { keyword(target, "嘲讽"); gain(ctx, target, 0, target.health); } break;
    case "028": act("buff", { target: "selected", attack: 15, health: 15, keyword: "圣盾" }); if (target) keyword(target, "风怒"); break;
    case "029": bump(s, "prizeRefresh"); break;
    case "030": bump(s, "prizeBattlecry:" + s.turn); break;
    case "032": for (let tier = 1; tier <= 3; tier++) queueEffectDiscover(ctx, "prize", { options: darkmoonPrizes(s, tier, rng) }); break;
    case "033": bump(s, "prizeExtraShop"); break;
    case "034": if (target) { gain(ctx, target, 6, 6); s.board.splice(s.board.indexOf(target), 1); giveCard(ctx, target); } break;
    case "037": { const m = pick(s.shop.filter((m) => !m.golden), rng); if (m) { makeGolden(m); m.reward = true; } break; }
    case "039": { const cards = [...s.shop, ...ss(s).spellShop]; s.shop = []; ss(s).spellShop = []; for (const m of cards) giveCard(ctx, m); refill(s, rng); break; }
    case "040": grant("BG28_897"); grant("BG28_897"); break;
    case "100": { const spell = drawSpell(s, rng, (d) => d.tier <= s.tier && (d.cost || 0) >= 2); if (spell) giveCard(ctx, spell); break; }
    case "101": queueEffectDiscover(ctx, "spell", { tiers: [s.tier] }); break;
    case "104": bump(s, "prizeDiscount:" + s.turn); break;
    case "106": while (room(s)) { const spell = drawSpell(s, rng); if (!spell) break; giveCard(ctx, spell); } break;
    case "110": scale(s, "spell", 1, 1); break;
  }
}
function timewarpEffect(ctx: Context, m: Minion, event: string) {
  const { s, rng, eventMinion: subject } = ctx, f = m.golden ? 2 : 1, id = getDef(m.id).sourceId!;
  const act = (op: string, rest: Partial<Ability> = {}) => effect(ctx, m, { event, op, ...rest });
  const adjacent = () => { const index = ctx.board.indexOf(m); return [ctx.board[index - 1], ctx.board[index + 1]].filter(Boolean); };
  const each = (cards: Minion[], attack: number, health: number) => { for (const card of cards) gain(ctx, card, attack * f, health * f); };
  switch (id) {
    case "BG34_Giant_021": for (let i = 0; i <= ctx.board.filter((m) => m.golden).length; i++) each(adjacent(), 8, 8); break;
    case "BG34_Giant_038": if (mbump(m, "refreshes") % 5 === 0) for (const card of [...s.shop].filter((m) => !m.golden).sort((a, b) => getDef(b.id).tier - getDef(a.id).tier).slice(0, f)) { makeGolden(card); card.reward = true; } break;
    case "BG34_Giant_042": { const left = ctx.board[ctx.board.indexOf(m) - 1]; if (left) { const uid = m.uid, copy = combatCopy(left); if (m.golden) makeGolden(copy); Object.assign(m, copy, { uid }); } break; }
    case "BG34_Giant_065": { const attack = m.attack, health = m.health; each(ctx.board.filter((x) => x.attack < attack), 2, 0); each(ctx.board.filter((x) => x.health < health), 0, 2); break; }
    case "BG34_Giant_068": for (const card of shuffled(ctx.board.filter((x) => x !== m && !x.keywords.includes("圣盾")), rng).slice(0, f)) { keyword(card, "圣盾"); ctx.permanentKeyword?.(card, "圣盾"); } break;
    case "BG34_Giant_069": if (mbump(m, "piperDamage") <= 3) scale(s, "gem", f, 0); break;
    case "BG34_Giant_072": if (subject && getDef(subject.id).tier === 2) act("draw", { tier: 1 }); break;
    case "BG34_Giant_088": if (event === "end") mbump(m, "promoGrowth", 5); else each(ctx.board, 5 + mcount(m, "promoGrowth"), 5 + mcount(m, "promoGrowth")); break;
    case "BG34_Giant_105": act("castTavern", { id: "BG34_689" }); break;
    case "BG34_Giant_208": if (mbump(m, "pagleKill") === 1) for (let i = 0; i < f; i++) reward(s); break;
    case "BG34_Giant_210": { const spell = makeMinion(PREFIX + "BG23_000t", m.golden); spell.tempSpell = true; spell.expires = true; spell.extraAbilities = [{ event: "cast", op: "buff", target: "selected", attack: 2 * ctx.board.filter((x) => tribe(x, "纳迦")).length, health: 2 * ctx.board.filter((x) => tribe(x, "纳迦")).length }]; giveCard(ctx, spell); break; }
    case "BG34_Giant_313": if (event === "start") mbump(m, "demonShopGrowth", 7); else for (let i = 0; i < 2 && s.shop.length < 7; i++) { const card = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("恶魔") === true || d.tribe === "全部")); if (card) { applyShop(s, card); gain(ctx, card, f * (7 + mcount(m, "demonShopGrowth")), f * (7 + mcount(m, "demonShopGrowth"))); s.shop.push(card); } } break;
    case "BG34_Giant_319": if (event === "cardPlayed") { if (subject && getDef(subject.id).tier <= 3) mbump(m, "painterGrowth"); } else each(adjacent(), 3 * (1 + mcount(m, "painterGrowth")), 2 * (1 + mcount(m, "painterGrowth"))); break;
    case "BG34_Giant_321": for (const card of s.hand.filter((x) => getDef(x.id).kind !== "spell")) each(adjacent().filter((x) => tribe(x, "鱼人")), card.attack, card.health); break;
    case "BG34_Giant_323": if (mbump(m, "crafts") % 2 === 0) act("randomSpell"); break;
    case "BG34_Giant_332": if (subject && mbump(m, "embalmer:" + s.turn) <= f) keyword(subject, "复生"); break;
    case "BG34_Giant_335": if (subject && !boardTypes([subject]).length) act("buff", { attack: 6, health: 6, target: "menagerie" }); break;
    case "BG34_Giant_336": if (subject) for (const t of boardTypes([subject])) { scale(s, "shopType:" + t, 4 * f, 4 * f); each(s.shop.filter((x) => tribe(x, t)), 4, 4); } break;
    case "BG34_Giant_370": for (let i = 0; i < f; i++) for (const other of [...ctx.board]) if (ability(other, "death").length) death(ctx, other); break;
    case "BG34_Giant_590": for (let i = 0; i < f; i++) { const parts = shuffled(poolCards(s).filter((d) => d.tier <= s.tier && (d.races?.includes("亡灵") || d.tribe === "全部")), rng).slice(0, 2).map((d) => makeMinion(d.id)); if (parts.length === 2) { const card = makeMinion(PREFIX + "BG25_HERO_100pt"); card.attack = parts[0].attack + parts[1].attack; card.health = parts[0].health + parts[1].health; card.keywords = [...new Set(parts.flatMap((m) => m.keywords))]; card.extraAbilities = parts.flatMap((m) => ability(m).map((a) => copiedAbility(m, a))); ctx.summon?.(combatCopy(card), ctx.sourcePos || 0); giveCard(ctx, card); } } break;
    case "BG34_Giant_599": { const deaths = ctx.board.filter((x) => x !== m && x.id !== m.id && ability(x, "death").length).slice(0, 2); for (let i = 0; i < f; i++) (m.extraAbilities ??= []).push(...deaths.flatMap((x) => ability(x, "death").map((a) => copiedAbility(x, a)))); break; }
    case "BG34_Giant_602": if (hasPower(s, "curator")) for (let i = 0; i < f; i++) giveCard(ctx, makeMinion(PREFIX + "TB_BaconShop_HERO_33_Buddy")); break;
    case "BG34_Giant_610": if (mbump(m, "electronSpells") % 2 === 0) for (let i = 0; i < f; i++) for (const mech of ctx.board.filter((x) => tribe(x, "机械"))) { const card = makeMinion(PREFIX + "BG31_171t"); card.attack = card.health = 4; magnetize(ctx, mech, card); } break;
    case "BG34_Giant_618": for (let i = 0; i < 5 * f; i++) { if (ctx.board.length < 7) ctx.summon?.(makeMinion(PREFIX + "BG_ICC_026t"), ctx.sourcePos || 0); else scale(s, "undead", 1, 0, ctx.board); } break;
    case "BG34_Giant_619": for (let i = 0; i < f; i++) { const opponent = pick(s.opponents.filter((o) => o.health > 0 && o.board.length), rng); const source = opponent && pick(opponent.board, rng); if (source) { const card = makeMinion(source.id, source.golden); ctx.summon?.(combatCopy(card), ctx.sourcePos || 0); giveCard(ctx, card); } } break;
    case "BG34_Giant_678": if (ctx.fromHand && subject && ctx.target && mbump(m, "lurker:" + s.turn) <= 2) for (let i = 0; i < f; i++) { const spell = clone(subject); spell.tempSpell = false; (spell.counters ??= {}).permanentCraft = 1; castSpell({ ...ctx, target: m, fromHand: false }, spell); } break;
    case "BG34_Giant_777": if (subject && tribe(subject, "元素")) gain(ctx, m, subject.attack * f, subject.health * f); break;
    case "BG34_PreMadeChamp_004": if (event === "anySpell") mbump(m, "jungleGrowth"); else if (subject) each([subject], 4 * (1 + mcount(m, "jungleGrowth")), 3 * (1 + mcount(m, "jungleGrowth"))); break;
    case "BG34_PreMadeChamp_013": if (mbump(m, "impGold") % 8 === 0) scale(s, "shop", 3 * f, 3 * f); break;
    case "BG34_PreMadeChamp_065": if (subject && getDef(subject.id).tier >= 4) each(ctx.board.filter((x) => tribe(x, "海盗")), 3, 2); break;
    case "BG34_PreMadeChamp_200": if (ss(s).lastSpell && mbump(m, "centurion:" + s.turn) <= 3) for (let i = 0; i < f; i++) giveCard(ctx, makeMinion(ss(s).lastSpell!)); break;
  }
}

function spellcraftCard(ctx: Context, source: Minion, a: Ability) {
  const id = PREFIX + getDef(source.id).sourceId + "t";
  if (!getDef(id)) return;
  const card = makeMinion(id, source.golden);
  card.expires = true;
  if (source.id === PREFIX + "BG31_924" && itemCount(ctx.s, "BG32_MagicItem_920")) (card.counters ??= {}).permanentCraft = 1;
  const progress = Math.floor(count(ctx.s, "allSpells") / 3);
  if (a.op === "craftProgress") {
    card.tempSpell = true;
    card.extraAbilities = [{ event: "cast", op: "buff", target: "selected", attack: (a.attack || 0) + progress, health: (a.health || 0) + progress }];
  } else if (a.op === "craftNaga") {
    const tier = Math.min(6, Math.max(1, ctx.s.turn - mcount(source, "enteredTurn") + 1));
    card.extraAbilities = [{ event: "cast", op: "draw", tribe: "纳迦", tier }];
  } else card.extraAbilities = [{ event: "cast", op: "randomStatsSpell" }];
  return card;
}
function expandedEffect(ctx: Context, m: Minion, a: Ability) {
  const { s, rng } = ctx, st = ss(s), f = m.golden && !a.noScale ? 2 : 1, n = (a.amount ?? 1) * f;
  const target = ctx.target;
  switch (a.op) {
    case "timewarp": timewarpEffect(ctx, m, a.event); break;
    case "darkmoonPrize": darkmoonPrize(ctx, m); break;
    case "trinketPrize": queueEffectDiscover(ctx, "prize", { options: darkmoonPrizes(s, a.amount || 3, rng) }); break;
    case "trinketCopy": if (target) giveCard(ctx, makeMinion(target.id, target.golden)); break;
    case "trinketEvolve": if (target) queueEffectDiscover(ctx, "minion", { tiers: [Math.min(6, getDef(target.id).tier + 1)], ...(ctx.board.includes(target) ? { replaceBoard: target.uid } : { replaceShop: target.uid }) }); break;
    case "trinketDestroyUndead": if (target && destroyRecruit(ctx, target)) for (let i = 0; i < n; i++) { const card = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("亡灵") || d.tribe === "全部")); if (card) giveCard(ctx, card); } break;
    case "battlecryShop": {
      for (const card of s.shop) release(s, card);
      s.shop = [];
      for (let i = 0; i < SHOP_SIZE[s.tier]; i++) { const card = draw(s, rng, (d) => d.tier <= s.tier && !!d.abilities?.some((a) => a.event === "battlecry")); if (card) { applyShop(s, card); (card.counters ??= {}).shopCost = 1; s.shop.push(card); } }
      legacyTrinketEvent(ctx, "refresh"); break;
    }
    case "ownStatsHand": {
      const card = s.hand.find((x) => getDef(x.id).kind !== "spell");
      if (card) gain(ctx, card, m.attack * f, m.health * f);
      break;
    }
    case "zarjiraCraft": {
      const card = makeMinion(PREFIX + "BG27_514t", m.golden);
      card.expires = true; giveCard(ctx, card); break;
    }
    case "copyShop": if (target) {
      (target.counters ??= {}).zarjiraTurn = s.turn;
      for (let i = 0; i < f; i++) giveCard(ctx, makeMinion(target.id, target.golden));
    } break;
    case "salvage": {
      const index = ctx.board.indexOf(m);
      const neighbors = [ctx.board[index - 1], ...(m.golden ? [ctx.board[index + 1]] : [])].filter((x) => x && x.id !== m.id);
      m.storedMinions = neighbors.map(combatCopy);
      for (const x of neighbors) x.health = 0;
      break;
    }
    case "salvageSummon": for (const card of m.storedMinions || []) ctx.summon?.(combatCopy(card), ctx.sourcePos ?? ctx.board.length); break;
    case "kodoStats": if (ctx.eventMinion && mbump(m, "kodoSummons") <= 3) {
      gain(ctx, ctx.eventMinion, m.attack * f, (m.counters?.deathStatsHealth ?? m.health) * f);
    } break;
    case "stoneSlab": if (ctx.eventMinion && mcount(m, "stoneSlabTurn") !== s.turn) {
      (m.counters ??= {}).stoneSlabTurn = s.turn;
      gain(ctx, ctx.eventMinion, 20, 20);
      gain(ctx, ctx.eventMinion, ctx.eventMinion.attack * f, ctx.eventMinion.health * f);
    } break;
    case "ravager": if (target && ctx.enemy) {
      const index = ctx.enemy.indexOf(target);
      const neighbors = [ctx.enemy[index - 1], ctx.enemy[index + 1]].filter(Boolean);
      const victims = m.golden ? neighbors : [pick(neighbors, rng)].filter(Boolean);
      ctx.damage?.(target, m.attack, m);
      for (const victim of victims) ctx.damage?.(victim!, m.attack, m);
    } break;
    case "jailbird": if (target && ctx.board.length < 7) {
      const golem = makeMinion(PREFIX + "BG30_MagicItem_442t");
      golem.attack = m.attack * f; golem.health = m.health * f;
      ctx.summon?.(golem, ctx.board.indexOf(m) + 1);
      const counterattack = target.attack;
      ctx.damage?.(target, golem.attack, golem);
      ctx.damage?.(golem, counterattack, target);
    } break;
    case "randomBeastSix": {
      const d = pick(poolCards(s).filter((d) => d.races?.includes("野兽") || d.tribe === "全部"), rng);
      if (d) {
        const card = makeMinion(d.id); card.attack = card.health = 6 * f;
        if (ctx.summon) ctx.summon(card, ctx.sourcePos ?? ctx.board.length);
        else if (ctx.board.length < 7) { ctx.board.push(card); notifySummon(ctx, card); }
      }
      break;
    }
    case "pendingHandMurloc": {
      for (const card of handSummonTargets(s, "鱼人").slice(0, f))
        ctx.pendingSummons?.push(combatCopy(card));
      break;
    }
    case "destroyUndead": if (target && destroyRecruit(ctx, target)) for (let i = 0; i < f; i++) {
      if (a.key === "copy") giveCard(ctx, makeMinion(target.id)); else queueEffectDiscover(ctx, "minion", { tribe: "亡灵" });
    } break;
    case "discoverMagnetize": if (target) for (let i = 0; i < f; i++) queueEffectDiscover(ctx, "minion", { tribe: "机械", magnetizeTarget: target.uid }); break;
    case "summonRemembered": if (ctx.combat) for (const uid of m.remembered || []) {
      const card = s.hand.find((x) => x.uid === uid);
      if (card) { const copy = clone(card); copy.uid = makeMinion(card.id).uid; copy.copies = {}; ctx.summon?.(copy, ctx.sourcePos ?? ctx.board.length); }
    } break;
    case "growDragonBuff": mbump(m, "dragonBuff", f); break;
    case "dragonCombatBuff": for (const x of ctx.board.filter((x) => tribe(x, "龙"))) gain(ctx, x, 2 * f + mcount(m, "dragonBuff"), 2 * f + mcount(m, "dragonBuff")); break;
    case "bounty": for (let i = 0; i < n; i++) giveCard(ctx, makeMinion(PREFIX + pick(["BG33_811", "BG33_812", "BG33_813", "BG33_814", "BG33_815"], rng))); break;
    case "chromadrake": for (let i = 0; i < n; i++) giveCard(ctx, makeMinion(PREFIX + pick(["BG34_634t", "BG34_635t", "BG34_636t", "BG34_637t", "BG34_638t"], rng))); break;
    case "learnSpell": if (ctx.eventMinion && mcount(m, "learn:" + s.turn) < f) {
      mbump(m, "learn:" + s.turn);
      const c = makeMinion(PREFIX + "BG33_890t"); c.attack = c.health = 1; c.learnedSpell = ctx.eventMinion.id;
      c.extraAbilities = [{ event: "battlecry", op: "castTavern", id: ctx.eventMinion.id.slice(4) }]; giveCard(ctx, c);
    } break;
    case "growingBeast": if (ctx.eventMinion) {
      const amount = 3 * f + mcount(m, "beastGrowth");
      gain(ctx, ctx.eventMinion, amount, 0); mbump(m, "beastGrowth", f); ctx.remember?.(m, "beastGrowth", f);
    } break;
    case "lockbox": for (let i = 0; i < f; i++) {
      const chest = s.hand.find((x) => x.id === PREFIX + "BG36_520t");
      if (chest) { chest.lockedUntil = (chest.lockedUntil || s.turn + 5) - 1; openLockboxes(ctx); }
      else { const c = makeMinion(PREFIX + "BG36_520t"); c.lockedUntil = s.turn + 5 - trinketCopies(s, "363"); giveCard(ctx, c); }
    } break;
    case "fishbaitRefresh": refill(s, rng); fishbait(ctx, m, s.shop[0], f); break;
    case "fishbait": fishbait(ctx, m, target, f); break;
    case "kangor": for (const dead of (ctx.deadMechs || []).slice(0, 2 * f)) {
      const c = makeMinion(dead.id, dead.golden); applyGlobal(s, c); ctx.summon?.(c, ctx.sourcePos ?? ctx.board.length);
    } break;
    case "choose": {
      const source = clone(m); source.copies = {};
      const provider = ctx.board.find((x) => has(x, "bothChoices") && mcount(x, "choiceTurn") !== s.turn);
      const both = !!(m.bothChoices || provider || trinket(s, "308"));
      if (provider) (provider.counters ??= {}).choiceTurn = s.turn;
      queueEffectDiscover(ctx, "choose", { options: [PREFIX + a.id + "t", PREFIX + a.id + "t2"], source, both });
      break;
    }
    case "combatEffect": (st.combatEffects ??= {})[a.key!] = (st.combatEffects?.[a.key!] || 0) + n; break;
    case "delayedBuff": (st.delayed ??= []).push({ turn: s.turn + 1, attack: (a.attack || 0) * f, health: (a.health || 0) * f, amount: a.amount || 1 }); break;
    case "winnerBuff": if (target) (st.delayed ??= []).push({ turn: s.turn + 1, uid: target.uid, win: true, attack: 4, health: 6, amount: 1 }); break;
    case "murlocPair": {
      const card = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("鱼人") === true || d.tribe === "全部"));
      if (card) { giveCard(ctx, card); giveCard(ctx, makeMinion(card.id)); }
      break;
    }
    case "butchering": if (target && destroyRecruit(ctx, target)) scale(s, "undead", 5, 0, ctx.board); break;
    case "confiscateGems": {
      if (!target) break;
      const zone = ctx.board.includes(target) ? ctx.board : s.shop;
      const index = zone.indexOf(target);
      if (index < 0) break;
      effect(ctx, m, { event: "cast", op: "gem", target: "selected", amount: 2 });
      for (const other of [zone[index - 1], zone[index + 1]].filter(Boolean)) {
        const gems = other.gems;
        if (!gems) continue;
        addStats(other, -gems.attack, -gems.health);
        gain(ctx, target, gems.attack, gems.health);
        target.gems = { attack: (target.gems?.attack || 0) + gems.attack, health: (target.gems?.health || 0) + gems.health };
        other.gems = undefined;
      }
      break;
    }
    case "spellShop":
      s.shop.forEach((x) => release(s, x)); s.shop = []; st.spellShop = [];
      for (let i = 0; i < SHOP_SIZE[s.tier] + 1; i++) { const card = drawSpell(s, rng); if (card) st.spellShop.push(card); }
      s.frozen = false;
      break;
    case "evolve": {
      if (!target) break;
      const zone = ctx.board.includes(target) ? ctx.board : s.shop;
      const i = zone.indexOf(target);
      const card = draw(s, rng, (d) => d.tier === getDef(target.id).tier + 1);
      if (i < 0 || !card) break;
      // Transformation keeps the old enchantments, adding them to the new base body.
      const old = getDef(target.id), baseAttack = target.golden ? old.goldenAttack! : old.attack, baseHealth = target.golden ? old.goldenHealth! : old.health;
      addStats(card, target.attack - baseAttack, target.health - baseHealth);
      card.temporary = clone(target.temporary); card.gems = clone(target.gems);
      card.uid = target.uid; release(s, target); zone[i] = card;
      break;
    }
    case "nagaRepeatedBuff": for (let i = 0; i < (target && tribe(target, "纳迦") ? 4 : 2); i++) effect(ctx, m, { event: "cast", op: "buff", target: "selected", attack: 1, health: 1 }); break;
    case "sellTransfer": {
      if (!target) break;
      const recipients = ctx.board.filter((x) => x.uid !== target.uid && (a.key !== "elemental" || tribe(x, "元素")));
      const recipient = a.key === "elemental" ? recipients[0] : pick(recipients, rng);
      const attack = target.attack, health = target.health;
      if (recipient && sellOwned(ctx, target)) gain(ctx, recipient, attack, health);
      break;
    }
    case "lockedDiscover": queueEffectDiscover(ctx, "minion", { tiers: [s.tier], lockedUntil: s.turn + 1 }); break;
    case "doomedDiscover": queueEffectDiscover(ctx, "minion", { tribe: "亡灵", doomedTurn: s.turn }); break;
    case "discoverDemonDamage": for (let i = 0; i < n; i++) queueEffectDiscover(ctx, "minion", { tribe: "恶魔", damage: true }); break;
    case "discoverChoice": queueEffectDiscover(ctx, "chooseCard", { bothChoices: true }); break;
    case "tribeShop":
      if (target) for (const t of ALL_TRIBES.filter((t) => tribe(target, t))) {
        scale(s, "shopType:" + t, 3, 3);
        for (const x of s.shop.filter((x) => tribe(x, t))) gain(ctx, x, 3, 3);
      }
      break;
    case "tribeRefresh": {
      if (!target) break;
      const types = ALL_TRIBES.filter((t) => tribe(target, t));
      s.shop.forEach((x) => release(s, x)); s.shop = []; st.spellShop = [];
      for (let i = 0; i < SHOP_SIZE[s.tier]; i++) {
        const card = draw(s, rng, (d) => d.tier <= s.tier && (d.tribe === "全部" || d.races?.some((t) => types.includes(t)) === true));
        if (card) { applyShop(s, card); s.shop.push(card); }
      }
      const spell = drawSpell(s, rng); if (spell) st.spellShop.push(spell);
      s.frozen = false; break;
    }
    case "randomSpellcraft": {
      const canCraft = (d: CardDef) => d.abilities?.some((a) => a.event === "spellcraft");
      const lobbySources = poolCards(s).filter(canCraft);
      // Old saves can already contain Spitescale Special in a lobby without Naga.
      const sources = lobbySources.length ? lobbySources : SEASON_RELATED.filter(canCraft);
      for (let i = 0; i < n; i++) {
        const d = pick(sources, rng);
        if (d) run({ ...ctx, fromHand: false }, makeMinion(d.id), "spellcraft");
      }
      break;
    }
    case "randomStatsSpell":
      for (let i = 0; i < n; i++) { const c = drawSpell(s, rng, (d) => d.tier <= s.tier && d.abilities?.some((a) => ["buff", "buffType", "nagaRepeatedBuff"].includes(a.op)) === true); if (c) giveCard(ctx, c); }
      break;
    case "craftProgress": case "craftNaga": case "craftStatsSpell": {
      if (!mcount(m, "enteredTurn")) (m.counters ??= {}).enteredTurn = s.turn;
      const card = spellcraftCard(ctx, m, a); if (card) giveCard(ctx, card); break;
    }
    case "randomChoice":
      for (let i = 0; i < n; i++) {
        const d = pick(choiceCards(s), rng);
        const card = d && (d.kind === "spell" ? makeMinion(d.id) : draw(s, rng, (x) => x.id === d.id));
        if (card) giveCard(ctx, card);
      } break;
    case "lossGold": if (s.battles[0]?.result === "loss") gold(s, a.amount || 4); break;
    case "scoutDiscover": for (let i = 0; i < f; i++) queueEffectDiscover(ctx, "minion", { tiers: [Math.min(6, 1 + s.turn - (mcount(m, "enteredTurn") || s.turn))] }); break;
    case "stripDefenses": if (target) target.keywords = target.keywords.filter((k) => k !== "嘲讽" && k !== "复生"); break;
    case "killKiller": if (ctx.killer && (ctx.enemy || []).includes(ctx.killer)) ctx.killer.health = 0; break;
    case "goldHealth": for (const x of buffTargets(ctx, m, a)) gain(ctx, x, 0, (1 + (st.goldSpentTurn || 0)) * f); break;
    case "periodic": {
      const step = a.event === "heroDamage" ? ctx.amount || 0 : 1;
      const before = mcount(m, a.key!), after = mbump(m, a.key!, step);
      const procs = Math.floor(after / (a.amount || 1)) - Math.floor(before / (a.amount || 1));
      for (let i = 0; i < procs; i++) {
        if (a.key === "pirateAttack") for (const x of ctx.board.filter((x) => tribe(x, "海盗"))) gain(ctx, x, 2 * f, 0);
        if (a.key === "piratePair") for (const x of shuffled(ctx.board.filter((x) => tribe(x, "海盗")), rng).slice(0, 2)) gain(ctx, x, 4 * f, 5 * f);
        if (a.key === "consume" || a.key === "consumeHighest") effect(ctx, m, { event: a.event, op: "consume", target: "self", highest: a.key === "consumeHighest" });
        if (a.key === "butchering" || a.key === "pastry") for (let j = 0; j < f; j++) giveCard(ctx, makeMinion(PREFIX + (a.key === "butchering" ? "BG28_604" : "BG28_607")));
        if (a.key === "rideWinds") for (let j = 0; j < f; j++) castSpell({ ...ctx, target: undefined, fromHand: false }, makeMinion(PREFIX + "BG34_444"));
        if (a.key === "bounty" || a.key === "lockbox") expandedEffect(ctx, m, { event: a.event, op: a.key });
        if (a.key === "undeadHand") for (let j = 0; j < f; j++) {
          const c = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("亡灵") === true || d.tribe === "全部"));
          if (c) { giveCard(ctx, c); (m.remembered ??= []).push(c.uid); }
        }
      }
      break;
    }
    case "spellProgressBuff": {
      const progress = Math.floor(count(s, "allSpells") / 3);
      for (const x of buffTargets(ctx, m, a)) {
        const before = { attack: x.attack, health: x.health };
        gain(ctx, x, ((a.attack || 0) + progress) * f, ((a.health || 0) + progress) * f);
        if (ctx.combat && m.id === PREFIX + "BG31_925" && trinket(s, "362")) ctx.permanent?.(x, x.attack - before.attack, x.health - before.health);
      }
      break;
    }
    case "goldenNeighbors": for (const x of buffTargets(ctx, m, { ...a, target: "adjacent" })) gain(ctx, x, f * (1 + ctx.board.filter((x) => x.golden).length), 0); break;
    case "summonSelfCopy": {
      if (!ctx.combat || !s.hand.includes(m)) break;
      const copy = combatCopy(m);
      copy.attack *= f;
      copy.health *= f;
      ctx.summon?.(copy, ctx.board.length);
      break;
    }
    case "adjacentSpell": case "rightSpell": {
      const ts = a.op === "rightSpell" ? [ctx.board[ctx.board.indexOf(m) + 1]].filter(Boolean) : buffTargets(ctx, m, { ...a, target: "adjacent" });
      for (const x of ts) for (let i = 0; i < f; i++) castSpell({ ...ctx, target: x, fromHand: false }, makeMinion(PREFIX + a.id)); break;
    }
    case "lowTierMurlocs": if (ctx.eventMinion && getDef(ctx.eventMinion.id).tier <= 3) for (const x of ctx.board.filter((x) => tribe(x, "鱼人"))) gain(ctx, x, 3 * f, 3 * f); break;
    case "summonHand": {
      if (!ctx.combat) break;
      const cards = handSummonTargets(s).slice(0, f);
      for (const [i, card] of cards.entries()) {
        ctx.summon?.(combatCopy(card), (ctx.sourcePos ?? ctx.board.indexOf(m)) + 1 + i);
      }
      break;
    }
    case "handAttack": gain(ctx, m, Math.max(0, ...s.hand.filter((x) => getDef(x.id).kind !== "spell").map((x) => x.attack)) * f, 0); break;
    case "targetAttack": if (target) gain(ctx, m, target.attack * f, 0); break;
    case "undeadPlague": scale(s, "undead", (ctx.combat ? 2 : 4) * f, 0, ctx.board); break;
    case "lastSpell": if (st.lastSpell) for (let i = 0; i < f; i++) giveCard(ctx, makeMinion(st.lastSpell)); break;
    case "morglton": {
      const value = 3 + count(s, "morglton");
      for (const x of buffTargets(ctx, m, a)) gain(ctx, x, a.attack ? value * f : 0, a.health ? value * f : 0); break;
    }
    case "morgltonParent": for (let i = 0; i < f; i++) giveCard(ctx, makeMinion(PREFIX + (rng() < 0.5 ? "BG35_140" : "BG35_141"))); break;
    case "armPurchase": (m.counters ??= {}).purchaseArmed = f; break;
    case "armMagnetic": (m.counters ??= {}).magneticArmed = m.golden ? 3 : 2; break;
    case "rallyDeathrattle": {
      if (!ctx.eventMinion || !ability(ctx.eventMinion, "rally").length) break;
      const left = ctx.board.find((x) => x.health > 0 && ability(x, "death").length);
      if (left) for (let i = 0; i < f; i++) death({ ...ctx, sourcePos: ctx.board.indexOf(left) }, left); break;
    }
    case "goldenFour": for (let i = 0; i < f; i++) {
      const d = pick(poolCards(s).filter((d) => d.tier === 4), rng); if (d) giveCard(ctx, makeMinion(d.id, true));
    } break;
    case "pirateDiscover": for (const x of ctx.board.filter((x) => x.uid !== m.uid && tribe(x, "海盗"))) gain(ctx, x, (1 + st.goldenPlayed) * f, (1 + st.goldenPlayed) * f); break;
    case "castRandom": for (let i = 0; i < n; i++) {
      const card = drawSpell(s, rng); if (!card) continue;
      const ts = seasonTargets(s, card, "cast"), chosen = ts.includes(m) ? m : pick(ts, rng);
      if (ability(card, "cast").some((a) => a.target === "selected") && !chosen) continue;
      castSpell({ ...ctx, target: chosen, fromHand: false }, card);
    } break;
    case "rebornDestroy": if (target) { keyword(target, "复生"); if (destroyRecruit(ctx, target)) gain(ctx, m, 4 * f, 4 * f); } break;
    case "shieldReborn": if (ctx.eventMinion) { keyword(ctx.eventMinion, "圣盾"); gain(ctx, m, 7 * f, 7 * f); } break;
    case "inheritReborn": {
      const right = [...ctx.board].reverse().find((x) => tribe(x, "亡灵"));
      if (right && ctx.eventMinion) gain(ctx, right, ctx.eventMinion.attack * f, ctx.eventMinion.attack * f); break;
    }
    case "randomShopUpgrade": for (const x of s.shop) {
      const choice = Math.floor(rng() * 4);
      if (choice === 0) gain(ctx, x, 8 * f, 8 * f);
      else keyword(x, (["嘲讽", "圣盾", "风怒"] as Keyword[])[choice - 1]);
    } break;
    case "parrotGold": {
      const amount = ctx.amount || 0;
      if (mcount(m, "parrotDamage") >= 35 || amount <= 0) break;
      const total = mbump(m, "parrotDamage", amount);
      ctx.remember?.(m, "parrotDamage", amount);
      if (total >= 35) for (let i = 0; i < f; i++) giveCard(ctx, makeMinion(PREFIX + "BG28_830"));
      break;
    }
    case "satelliteGrowing": {
      const value = 2 + mcount(m, "satelliteSize");
      if (ctx.eventMinion) { gain(ctx, ctx.eventMinion, value * f, value * f); ctx.eventMinion.magneticCount = (ctx.eventMinion.magneticCount || 0) + 1; }
      mbump(m, "satelliteSize"); break;
    }
    case "satellite": for (const x of buffTargets(ctx, m, a)) { gain(ctx, x, (a.attack || 0) * f, (a.health || 0) * f); x.magneticCount = (x.magneticCount || 0) + 1; } break;
    case "magneticGrowth": for (const x of ctx.board) for (let i = 0; i < (x.magneticCount || 0); i++) gain(ctx, x, (a.attack || 0) * f, (a.health || 0) * f); break;
    case "murlocDiscover": if (ctx.board.some((x) => x.uid !== m.uid && tribe(x, "鱼人"))) for (let i = 0; i < f; i++) queueEffectDiscover(ctx, "minion", { tribe: "鱼人" }); break;
  }
}
function triggerBattlecry(ctx: Context, m: Minion) {
  const selected = ability(m, "battlecry").find((a) => a.target === "selected");
  if (selected && !ctx.target) {
    const candidates = ctx.board.filter(
      (x) => x.uid !== m.uid && (!selected.tribe || tribe(x, selected.tribe)),
    );
    ctx = { ...ctx, target: pick(candidates, ctx.rng) };
  }
  const count =
    Math.max(
      1,
      ...ctx.board
        .filter((x) => x.uid !== m.uid && (has(x, "brann") || has(x, "repeatAllTriggers")))
        .map((x) => (x.golden ? 3 : 2)),
    ) + (tribe(m, "龙") ? trinketCopies(ctx.s, "215") : 0) +
      (ability(m, "battlecry").length && bump(ctx.s, "warDrum:" + ctx.s.turn) === 1 ? 2 * itemCount(ctx.s, "BG32_MagicItem_416") : 0) + (ss(ctx.s).counters?.["prizeBattlecry:" + ctx.s.turn] || 0);
  for (let i = 0; i < count; i++) {
    run(ctx, m, "battlecry");
    if (ability(m, "battlecry").length) {
      ss(ctx.s).battlecries++;
      for (const other of [...ctx.board])
        run({ ...ctx, eventMinion: m }, other, "battlecryTriggered");
      if (trinket(ctx.s, "203"))
        for (const t of new Set(
          [ctx.board[0], ctx.board.at(-1)].filter(Boolean),
        ))
          addStats(t!, 5 * trinketCopies(ctx.s, "203"), 5 * trinketCopies(ctx.s, "203"));
    }
  }
}
function notifySummon(ctx: Context, m: Minion) {
  for (const source of [...ctx.board]) run({ ...ctx, eventMinion: m }, source, "summonAny");
  legacyTrinketEvent({ ...ctx, eventMinion: m }, "summon");
  if (ctx.combat && hasPower(ctx.s, "greybough")) { gain(ctx, m, 1, 2); keyword(m, "嘲讽"); }
  if (m.id === PREFIX + "BG_TTN_401") {
    bump(ctx.s, "automatonSummons"); mbump(m, "automatonSelf"); syncStats(ctx.s, ctx.board);
  }
  for (const x of [...ctx.board])
    if (x.uid !== m.uid) {
      if (ctx.combat) run({ ...ctx, eventMinion: m }, x, "summonCombat");
      if (tribe(m, "野兽")) run({ ...ctx, eventMinion: m }, x, "summonBeast");
      if (tribe(m, "机械")) {
        if (!ctx.combat) run({ ...ctx, eventMinion: m }, x, "summonMech");
        else run({ ...ctx, eventMinion: m }, x, "summonMechCombat");
      }
      if (ctx.combat && tribe(m, "野兽"))
        run({ ...ctx, eventMinion: m }, x, "summonBeastCombat");
    }
}
function played(ctx: Context, m: Minion, magneticHost?: Minion) {
  run(ctx, m, "volumizer");
  if (m.id === PREFIX + "BG31_812") run({ ...ctx, eventMinion: m }, m, "playElemental");
  discardPartner(ctx, m);
  if (tribe(m, "元素")) { bump(ctx.s, "elementalsPlayed"); bump(ctx.s, "elementalsPlayed:" + ctx.s.turn); }
  legacyTrinketEvent({ ...ctx, eventMinion: m }, "play");
  legacyTrinketEvent({ ...ctx, eventMinion: m }, "cardPlayed");
  if (ability(m, "battlecry").length) legacyTrinketEvent({ ...ctx, eventMinion: m }, "battlecryPlayed");
  if (hasPower(ctx.s, "daryl")) { gain(ctx, m, 1, 1); mbump(m, "hats"); }
  if (hasPower(ctx.s, "clockwork") && m.golden) putHand(ctx.s, makeMinion(PREFIX + "BG28_810"));
  if (["BG35_140", "BG35_141", "BG35_142"].includes(getDef(m.id).sourceId!)) bump(ctx.s, "morglton");
  for (const x of [...ctx.board]) {
    run({ ...ctx, eventMinion: m }, x, "playAnyMinion");
    if (x.uid !== m.uid) {
      if (tribe(m, "鱼人")) run({ ...ctx, eventMinion: m }, x, "playMurloc");
      if (tribe(m, "亡灵")) run({ ...ctx, eventMinion: m }, x, "playUndead");
      if (tribe(m, "恶魔")) run({ ...ctx, eventMinion: m }, x, "playDemon");
      if (tribe(m, "元素")) run({ ...ctx, eventMinion: m }, x, "playElemental");
      if (tribe(m, "纳迦")) run({ ...ctx, eventMinion: m }, x, "playNaga");
      if (tribe(m, "机械")) run({ ...ctx, eventMinion: magneticHost || m }, x, "playMech");
    }
    giftEvent(ctx, x, "play");
  }
  if (tribe(m, "鱼人")) for (const x of [...ctx.s.hand]) run({ ...ctx, eventMinion: m }, x, "handPlayMurloc");
  if (hasPower(ctx.s, "chenvaala") && tribe(m, "元素")) {
    const progress = powerProgress(ctx.s, PREFIX + "chenvaala");
    const count = progress.elementalsPlayed + 1;
    savePowerProgress(ctx.s, PREFIX + "chenvaala", { ...progress, elementalsPlayed: count });
    if (count % 3 === 0) ctx.s.upgrade = Math.max(0, ctx.s.upgrade - 3);
  }
  ss(ctx.s).playedTurn++;
  if (m.golden) ss(ctx.s).goldenPlayed++;
  if (!ability(m, "choice").length) for (const x of [...ctx.board]) run({ ...ctx, eventMinion: m }, x, "cardPlayed");
  syncStats(ctx.s, ctx.board);
  if (trinket(ctx.s, "811") && ss(ctx.s).playedTurn === 1) keyword(m, "圣盾");
  if (tribe(m, "元素") && trinket(ctx.s, "380")) bump(ctx.s, "trinketElementals");
  if (tribe(m, "鱼人") && trinket(ctx.s, "850") && bump(ctx.s, "trinketMurlocs") % 5 === 0)
    for (let i = 0; i < 2 * trinketCopies(ctx.s, "850"); i++) {
      const card = drawSpell(ctx.s, ctx.rng); if (card) trinketCard(ctx.s, card);
    }
}
function castSpell(ctx: Context, m: Minion) {
  const { s } = ctx;
  if ((ctx.depth || 0) > 12) return;
  // Choose One resolves only after a player selects an option, including repeats.
  if (ability(m, "cast").some((a) => a.op === "choose")) { run(ctx, m, "cast"); if (ctx.fromHand) discardPartner(ctx, m); return; }
  const targeted = ability(m, "cast").some((a) => a.target === "selected");
  if (targeted && !ctx.target) ctx = { ...ctx, target: pick(seasonTargets(s, m, "cast"), ctx.rng) };
  if (targeted && !ctx.target) return;
  const friendly = !!ctx.target && ctx.board.includes(ctx.target);
  const bounty = /^s14_BG33_81[1-5]$/.test(m.id);
  let repeats = Math.max(1,
    ...(friendly ? ctx.board.filter((x) => has(x, "repeatFriendlySpell")) : []).map((x) => x.golden ? 3 : 2),
    ...(bounty ? ctx.board.filter((x) => has(x, "repeatBounty")) : []).map((x) => x.golden ? 3 : 2));
  {
    if (bump(s, "trinketFirstSpell:" + s.turn) === 1) repeats += itemCount(s, "BG30_MagicItem_434");
    if (m.expires && bump(s, "trinketFirstCraft:" + s.turn) <= 2) repeats += itemCount(s, "BG30_MagicItem_920");
  }
  const targetUid = ctx.target?.uid;
  const craft = !!m.expires && getDef(m.id).kind === "spell";
  let permanent = !!mcount(m, "permanentCraft");
  if (ctx.fromHand && craft && ctx.target && has(ctx.target, "permanentSpellcraft")) {
    const key = "permanentCraft:" + s.turn;
    if (mcount(ctx.target, key) < (ctx.target.golden ? 2 : 1)) { mbump(ctx.target, key); permanent = true; }
  }
  if (ctx.fromHand && craft && ctx.target && has(ctx.target, "copySpellcraft")) {
    const key = "copyCraft:" + s.turn;
    if (mcount(ctx.target, key) < 1) {
      mbump(ctx.target, key);
      for (let i = 0; i < (ctx.target.golden ? 2 : 1); i++) { const copy = clone(m); copy.uid = makeMinion(m.id).uid; copy.copies = {}; putHand(s, copy); }
    }
  }
  for (let i = 0; i < repeats; i++) {
    const target = targetUid ? [...ctx.board, ...s.shop].find((x) => x.uid === targetUid && x.health > 0) : undefined;
    if (targeted && (!target || !seasonTargets({ ...s, board: ctx.board }, m, "cast").some((x) => x.uid === target.uid))) break;
    castSpellOnce({ ...ctx, target, permanentSpell: permanent, fromHand: ctx.fromHand && i === 0 }, permanent ? { ...m, tempSpell: false } : m);
  }
  if (craft) for (const x of [...ctx.board]) run({ ...ctx, eventMinion: m }, x, "spellcraftCast");
  if (ctx.fromHand) {
    discardPartner(ctx, m);
    for (const x of [...ctx.board]) run({ ...ctx, eventMinion: m }, x, "cardPlayed");
    legacyTrinketEvent({ ...ctx, eventMinion: m }, "cardPlayed");
  }
}
function castChosenSpell(ctx: Context, m: Minion) {
  (m.counters ??= {}).chosenSpell = 1;
  castSpell(ctx, m);
}
function castSpellOnce(ctx: Context, m: Minion) {
  const { s } = ctx;
  run(ctx, m, "cast");
  bump(s, "allSpells");
  legacyTrinketEvent({ ...ctx, eventMinion: m }, "spell");
  if (!m.tempSpell && tavernSpellIds.has(m.id)) {
    ss(s).spellsCast++;
    ss(s).lastSpell = m.id;
    legacyTrinketEvent({ ...ctx, eventMinion: m }, "tavernSpell");
    if (ctx.fromHand) { bump(s, "handTavernSpells:" + s.turn);
      if (itemCount(s, "BG32_MagicItem_801t")) bump(s, "forestSpells");
    }
    for (const x of [...ctx.board])
      run(
        { ...ctx, depth: (ctx.depth || 0) + 1, eventMinion: ctx.target },
        x,
        "tavernSpell",
      );
    if (trinket(s, "800")) scale(s, "shop", trinketCopies(s, "800"), trinketCopies(s, "800"));
    if (trinket(s, "830")) ss(s).fodder += trinketCopies(s, "830");
  }
  for (const x of [...ctx.board]) run({ ...ctx, depth: (ctx.depth || 0) + 1 }, x, "anySpell");
  if (ctx.target) {
    legacyTrinketEvent({ ...ctx, eventMinion: m }, "targetSpell");
    run({ ...ctx, depth: (ctx.depth || 0) + 1 }, ctx.target, "targetSpell");
    for (const x of [...ctx.board]) {
      if (tribe(ctx.target, "机械")) run({ ...ctx, depth: (ctx.depth || 0) + 1, eventMinion: ctx.target }, x, "spellMech");
      if (tribe(ctx.target, "鱼人"))
        run(
          { ...ctx, depth: (ctx.depth || 0) + 1, eventMinion: ctx.target },
          x,
          "spellMurloc",
        );
      if (tribe(ctx.target, "纳迦"))
        run(
          { ...ctx, depth: (ctx.depth || 0) + 1, eventMinion: ctx.target },
          x,
          "spellNaga",
        );
    }
    if (trinket(s, "307")) {
      const n = delta(s, "wand").attack + 1;
      ss(s).buffs.wand = { attack: n, health: 0 };
      if (n % 3 === 0) trinketGold(s, trinketCopies(s, "307"));
    }
  }
  for (const x of [...ctx.board]) giftEvent(ctx, x, "play");
  trinketSpell(ctx, m);
  syncStats(s, ctx.board);
}
export function giftTierRange(turn: number) {
  return turn <= 3
    ? [2]
    : turn === 4
      ? [2, 3]
      : turn === 5
        ? [3]
        : turn === 6
          ? [3, 4]
          : turn === 7
            ? [4]
            : turn === 8
              ? [4, 5]
              : turn === 9
                ? [4, 5, 6]
                : [5, 6];
}
const GIFT_WINDOW: Record<string, [number, number]> = {
  "13": [3, 99],
  "73": [3, 3],
  "74": [3, 5],
  "75": [3, 5],
  "51": [3, 5],
  "11": [5, 99],
  "18": [4, 6],
  "7": [7, 10],
  "71": [7, 10],
  "69": [7, 99],
  "72": [11, 99],
  "60": [12, 99],
  "82": [3, 4],
  "10": [6, 99],
  "16": [3, 99],
  "52": [4, 5],
  "5": [5, 8],
  "80": [4, 5],
  "22": [5, 99],
  "14": [4, 8],
  "4": [6, 8],
};
function giftNumber(id: string) {
  return id.replace("BG36_MidGameEffect_000t", "");
}
export function eligibleGifts(s: Game, m: Minion) {
  return GIFTS.filter((g) => {
    const n = giftNumber(g.id),
      [min, max] = GIFT_WINDOW[n] || [3, 99];
    if (s.turn < min || s.turn > max) return false;
    const battlecry = ability(m, "battlecry").length > 0,
      death = ability(m, "death").length > 0;
    if (battlecry && !["11", "18", "14", "10"].includes(n)) return false;
    if (death && ["73", "75", "51", "7", "71", "72", "4"].includes(n))
      return false;
    if (n === "16" && !death) return false;
    if (n === "10" && !battlecry) return false;
    if (n === "80" && !tribe(m, "野猪人")) return false;
    if (
      n === "69" &&
      (!tribe(m, "鱼人") ||
        m.keywords.some((k) => k === "烈毒" || k === "剧毒"))
    )
      return false;
    if (
      n === "75" &&
      (ss(s).tribes.includes("野猪人") || ss(s).tribes.includes("纳迦"))
    )
      return false;
    if (
      n === "7" &&
      (ss(s).tribes.includes("龙") ||
        tribe(m, "野兽") ||
        tribe(m, "亡灵") ||
        getDef(m.id).tribe === "无")
    )
      return false;
    if (
      n === "71" &&
      (getDef(m.id).tribe === "无" ||
        m.keywords.some((k) => k === "烈毒" || k === "剧毒"))
    )
      return false;
    if (n === "72" && tribe(m, "龙")) return false;
    if (
      n === "60" &&
      (m.keywords.includes("嘲讽") || getDef(m.id).tribe === "无")
    )
      return false;
    if (n === "22" && getDef(m.id).tribe !== "无") return false;
    if (["82", "4"].includes(n) && getDef(m.id).tribe === "无") return false;
    if (
      n === "14" &&
      (getDef(m.id).activateCost ||
        getDef(m.id).tier !== Math.min(...giftTierRange(s.turn)))
    )
      return false;
    return true;
  });
}
function attachDarkGift(s: Game, m: Minion, id: string) {
  m.gift = id;
  m.giftTurn = s.turn;
  const n = giftNumber(id);
  if (n === "73") addStats(m, 5, 5);
  if (n === "4") addStats(m, 4, 4);
  if (n === "72") m.attack += 1000;
  if (n === "13") { keyword(m, "圣盾"); keyword(m, "风怒"); }
  if (n === "69") keyword(m, "烈毒");
  if (n === "14") makeGolden(m);
}
function darkDiscover(s: Game, rng: () => number) {
  const tiers = giftTierRange(s.turn),
    offered = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const majority = majorityTribe(s);
    const m = draw(
      s,
      rng,
      (d) =>
        tiers.includes(d.tier) &&
        !d.magnetic &&
        !s.discovery.some((m) => m.id === d.id) &&
        !(d.abilities || []).some((a) => a.event === "sell") &&
        !(
          s.turn < 5 &&
          (d.mechanics || []).some(
            (k) => k === "BATTLECRY" || k === "CHOOSE_ONE",
          )
        ) &&
        d.sourceId !== "BGS_131" &&
        !(i === 0 && s.turn >= 6 && majority && !d.races?.includes(majority)) &&
        eligibleGifts(s, makeMinion(d.id)).some((g) => !offered.has(g.id)),
    );
    if (!m) continue;
    const gift = pick(
      eligibleGifts(s, m).filter((g) => !offered.has(g.id)),
      rng,
    );
    if (!gift) {
      release(s, m);
      continue;
    }
    offered.add(gift.id);
    attachDarkGift(s, m, gift.id);
    s.discovery.push(m);
  }
  ss(s).discoveryKind = "darkGift";
}
function majorityTribe(s: Game): Tribe | undefined {
  return ALL_TRIBES.map((t) => ({
    t,
    n: [...s.board, ...s.hand].filter((m) => tribe(m, t)).length,
  }))
    .sort((a, b) => b.n - a.n)
    .find((x) => x.n > 0)?.t;
}
function giftEvent(ctx: Context, m: Minion, event: string) {
  if (!m.gift) return;
  const n = giftNumber(m.gift);
  if (event === "play") {
    if (n === "74") m.attack += 3;
    if (n === "75") m.health += 3;
  }
  if (event === "combat") {
    if (n === '89' && ss(ctx.s).deity) addStats(m, ss(ctx.s).deity!.attack, ss(ctx.s).deity!.health);
    if (n === '90') ctx.summon?.(combatCopy(m), ctx.board.indexOf(m) + 1);
    if (n === "7") addStats(m, 0, m.health);
    if (n === "71") addStats(m, m.attack, 0);
    if (n === "16") death(ctx, m);
  }
  if (event === "rally" && n === "80")
    effect(ctx, m, { event: "rally", op: "spell", id: "BG20_GEM", amount: 2 });
  if (event === "death") {
    if (n === "52") ss(ctx.s).freeRefresh += 2;
    if (n === "5") {
      const spell = drawSpell(ctx.s, ctx.rng);
      if (spell) putHand(ctx.s, spell);
    }
  }
  if (event === "end") {
    if (n === "51") {
      const t = m.giftTurn || 3;
      addStats(m, t === 3 ? 1 : t - 2, t === 3 ? 2 : t - 2);
    }
    if (n === "4" && ctx.s.turn === (m.giftTurn || 0) + 2) {
      m.attack *= 2;
      m.health *= 2;
    }
    if (n === "10") triggerBattlecry({ ...ctx, target: undefined }, m);
    if (
      ["18", "82"].includes(n) &&
      (ctx.s.turn - (m.giftTurn || ctx.s.turn) + 1) % 2 === 0
    ) {
      const card =
        n === "18"
          ? draw(ctx.s, ctx.rng, (d) => d.id === m.id)
          : draw(
              ctx.s,
              ctx.rng,
              (d) =>
                d.tier <= ctx.s.tier &&
                d.races?.some((t) => tribe(m, t)) === true,
            );
      if (card) putHand(ctx.s, card);
    }
  }
}
function death(ctx: Context, m: Minion) {
  const repeats =
    (ctx.combat && ability(m, "death").length && !ctx.trinketCombat!.firstDeathrattle ? itemCount(ctx.s, "BG30_MagicItem_700") : 0) + Math.max(1, ...ctx.board.filter((x) => has(x, "repeatAllTriggers")).map((x) => x.golden ? 3 : 2)) +
    ctx.board
      .filter((x) => x.health > 0 && has(x, "titus"))
      .reduce((n, x) => n + (x.golden ? 2 : 1), 0);
  if (ctx.combat && ability(m, "death").length) ctx.trinketCombat!.firstDeathrattle = 1;
  for (let i = 0; i < repeats; i++) {
    run(ctx, m, "death");
    giftEvent(ctx, m, "death");
    if (ability(m, "death").length) { bump(ctx.s, "deathrattles"); syncStats(ctx.s, ctx.board); for (const other of [...ctx.board]) run({ ...ctx, eventMinion: m }, other, "deathTriggered"); }
  }
}
function magnetize(ctx: Context, host: Minion, attachment: Minion) {
  run(ctx, attachment, "volumizer");
  const factor = mcount(host, "magneticArmed") || 1;
  (host.counters ??= {}).magneticArmed = 0;
  const attach = (target: Minion, repeats: number, poolCopies = false) => {
    gain({ ...ctx, source: attachment }, target, attachment.attack * repeats, attachment.health * repeats);
    target.magneticCount = (target.magneticCount || 0) + repeats;
    attachment.keywords.forEach((k) => keyword(target, k));
    target.extraAbilities = [...(target.extraAbilities || []), ...Array.from({ length: repeats }, () => ability(attachment).map((a) => copiedAbility(attachment, a))).flat()];
    if (poolCopies) for (const [id, n] of Object.entries(attachment.copies)) target.copies[id] = (target.copies[id] || 0) + n;
  };
  attach(host, factor, true);
  for (const boxer of ctx.board.filter((m) => m !== host && has(m, "repeatMagnetize"))) attach(boxer, factor * (boxer.golden ? 2 : 1));
}
function settleTrinkets(s: Game, rng: () => number) {
  for (let i = 0; i < 60; i++) {
    const before = `${s.hand.length}:${s.triples}:${ss(s).pendingTrinketCards?.length || 0}`;
    flushTrinketCards(s); triples(s);
    if (before === `${s.hand.length}:${s.triples}:${ss(s).pendingTrinketCards?.length || 0}`) break;
  }
  syncStats(s);
  legacyTrinketEvent({ s, board: s.board, rng }, "sync");
  if (s.phase !== "recruit") return;
  nextDiscovery(s, rng);
  if (s.discovery.length || ss(s).trinketOffers.length) return;
  const choice = ss(s).pendingTrinketChoices?.shift();
  if (!choice) return;
  offerTrinkets(s, choice.school, rng);
  ss(s).replacingTrinket = choice.slot;
  if (ss(s).kiriSlot === choice.slot) {
    ss(s).trinketOffers = TRINKETS.filter(t => t.school === choice.school && t.cost <= 4 && !['BG36_MagicItem_412', 'BG36_MagicItem_412t2'].includes(t.id) && canOfferTrinket(s, t.id) && trinketRaces(t.id).every(t => ss(s).tribes.includes(t))).map(t => t.id);
    ss(s).trinketOffers = shuffled(ss(s).trinketOffers, rng).slice(0, 4);
    ss(s).trinketOfferCosts = Object.fromEntries(ss(s).trinketOffers.map(id => [id, TRINKETS.find(t => t.id === id)!.cost]));
  }
  if (choice.free) {
    ss(s).trinketOffers = ss(s).trinketOffers.slice(0, 2);
    ss(s).trinketOfferCosts = Object.fromEntries(ss(s).trinketOffers.map((id) => [id, 0]));
  }
}
const PRIZES: Record<number, string[]> = {
  1: ["004", "013", "029", "033", "040", "100", "110"],
  2: ["006", "009", "010", "012", "014", "018", "026", "030", "101"],
  3: ["011", "015", "019", "020", "034", "037", "039", "104"],
  4: ["016", "022", "023", "025", "028", "032", "106"],
};
function darkmoonPrizes(_s: Game, tier: number, rng: () => number) {
  return shuffled(PRIZES[tier].map((id) => PREFIX + "BGS_Treasures_" + id), rng).slice(0, 3);
}
function queueUndeadCreation(s: Game, _rng: () => number, part?: Minion) {
  queueDiscover(s, part ? "undeadCreationFinish" : "undeadCreation", { tribe: "亡灵", creationPart: part, trinket: true });
}
function queueTimewarp(s: Game, rng: () => number, greater: boolean) {
  const cards = trinketDependencies.timewarp.map((id) => getDef(PREFIX + id)).filter((d) => d && available(d, ss(s).tribes) && d.tier === (greater ? 5 : 3) && (d.sourceId !== "BG34_Giant_602" || hasPower(s, "curator")));
  queueDiscover(s, "timewarp", { options: shuffled(cards, rng).slice(0, 3).map((d) => d.id), trinket: true });
}
function heroWheel(ctx: Context) {
  const { s, rng } = ctx;
  const roll = rng();
  // Six wheel outcomes: five equal 19% segments and the 5% Pyrobuff segment.
  if (roll < .19) { const m = pick(s.shop.filter((m) => !m.golden), rng); if (m) { makeGolden(m); m.reward = true; } }
  else if (roll < .38) for (let i = 0; i < 2; i++) {
    const id = pick(darkmoonPrizes(s, Math.min(4, Math.max(1, Math.floor(s.turn / 4))), rng), rng);
    if (id) giveCard(ctx, makeMinion(id));
  }
  else if (roll < .57) { const [m, other] = shuffled(ctx.board, rng); if (m && other) gain(ctx, m, other.attack, other.health); }
  else if (roll < .76) {
    for (const food of [...s.shop]) { const eater = pick(ctx.board, rng); if (eater) consumeMinion(ctx, eater, food); }
    refill(s, rng);
  } else if (roll < .95) for (let i = 0; i < 4; i++) { const spell = drawSpell(s, rng); if (spell) castSpell({ ...ctx, fromHand: false }, spell); }
  else for (let i = 0; i < 100; i++) {
    const targets = [...ctx.board, ...s.shop];
    const index = Math.floor(rng() * (targets.length + 2));
    if (index >= targets.length) break;
    gain(ctx, targets[index], 10, 10);
  }
}

function trinketStart(ctx: Context, id: string, purchased = false, slot = ss(ctx.s).trinkets.lastIndexOf(id)) {
  const { s, rng } = ctx;
  const n = id.replace("BG36_MagicItem_", "");
  if (purchased) (ss(s).trinketData ??= {})[`trinket:${slot}:${id}`] = { turn: s.turn, type: ss(s).trinketOfferTypes?.[id] || majorityTribe(s) || pick(ss(s).tribes, rng) };
  const grant = (id: string, golden = false) => trinketCard(s, makeMinion(PREFIX + id, golden));
  if (purchased) {
    const portraits: Record<string, string> = { "201": "BG36_201", "204": "BG34_690", "216": "BG25_008", "362": "BG31_925", "363": "BG36_523", "820": "BG32_330" };
    if (portraits[n]) grant(portraits[n], ["216", "363"].includes(n));
    if (n === "206") queueDiscover(s, "darkGift", { tiers: [4], tribe: majorityTribe(s), darkGift: true, trinket: true });
    if (n === "309") queueDiscover(s, "darkGift", { tiers: [7], darkGift: true, trinket: true });
    if (n === "363") {
      for (const chest of s.hand.filter((m) => m.id === PREFIX + "BG36_520t")) chest.lockedUntil = (chest.lockedUntil || s.turn + 5) - 1;
      openLockboxes(ctx);
    }
  }
  if (n === "208") {
    const spell = makeMinion(PREFIX + "BG36_MagicItem_208t");
    spell.expires = true;
    trinketCard(s, spell);
  }
  if (n === "301") {
    const chest = [...s.hand, ...(ss(s).pendingTrinketCards || [])].find((m) => m.id === PREFIX + "BG36_520t");
    if (chest) { chest.lockedUntil = (chest.lockedUntil || s.turn + 5) - 2; openLockboxes(ctx); }
    else {
      const card = makeMinion(PREFIX + "BG36_520t");
      card.lockedUntil = s.turn + 5 - trinketCopies(s, "363");
      trinketCard(s, card);
    }
  }
  if (n === "303" || n === "303t") for (let i = 0; i < (n === "303t" ? 2 : 1); i++) {
    const d = pick(choiceCards(s), rng);
    const card = d && (d.kind === "spell" ? makeMinion(d.id) : draw(s, rng, (x) => x.id === d.id));
    if (card) trinketCard(s, card);
  }
  if (n === "370") queueDiscover(s, "darkGift", { options: s.board.map((m) => m.id), darkGift: true, trinket: true });
  if (n === "390") grant(rng() < 0.5 ? "BG31_816" : "BG31_818");
  if (n === "220" && !purchased) trinketGold(s, boardTypes(ctx.board).length);
  if (purchased) legacyTrinketEvent(ctx, "purchase", slot);
}
function legacyTrinketEvent(ctx: Context, event: string, onlySlot?: number) {
  if ((ctx.depth || 0) > 12) return;
  const { s } = ctx;
  for (const [slot, id] of [...ss(s).trinkets].entries()) {
    if (onlySlot !== undefined && slot !== onlySlot) continue;
    const rules = returningTrinkets[id];
    if (!rules) continue;
    const key = `trinket:${slot}:${id}`;
    const data = (ss(s).trinketData ??= {})[key] ??= { turn: s.turn, type: majorityTribe(s) || pick(ss(s).tribes, ctx.rng) };
    for (const [index, rule] of rules.entries()) {
      if (rule.event !== event || rule.combatOnly && !ctx.combat ||
        rule.subjectTribe && (!ctx.eventMinion || !tribe(ctx.eventMinion, rule.subjectTribe))) continue;
      const progressKey = `${key}:${index}${rule.perTurn ? ":" + s.turn : ""}`;
      const counters = rule.combatOnly ? (ctx.trinketCombat ??= {}) : (ss(s).counters ??= {});
      const before = counters[progressKey] || 0;
      const amount = event === "spend" && rule.every ? ctx.amount || 0 : 1;
      const after = counters[progressKey] = before + amount;
      const every = rule.every || 1;
      const triggers = Math.floor(Math.min(after, rule.limit ?? Infinity) / every) - Math.floor(Math.min(before, rule.limit ?? Infinity) / every);
      for (let i = 0; i < triggers; i++) {
        const next = { ...ctx, trinket: true, depth: (ctx.depth || 0) + 1 };
        if (rule.op === "trinketCustom") legacyTrinketEffect(next, id, event, slot, key, data);
        else if (rule.op === "trinketDraw") {
          const card = draw(s, ctx.rng, (d) => d.tier <= s.tier && (!rule.key || !!d.mechanics?.includes(rule.key)));
          if (card) trinketCard(s, card);
        } else effect(next, makeMinion(PREFIX + "BG20_GEM"), rule);
      }
    }
  }
}
function legacyTrinketEffect(ctx: Context, id: string, event: string, slot: number, key: string, data: { turn: number; type?: Tribe; card?: string; stored?: Minion[] }) {
  const { s, rng } = ctx, st = ss(s), subject = ctx.eventMinion;
  const grant = (id: string, golden = false) => { const card = makeMinion(PREFIX + id, golden); trinketCard(s, card); return card; };
  const plain = (m: Minion) => grant(getDef(m.id).sourceId!, m.golden);
  const get = (filter: (d: CardDef) => boolean, amount = 1) => { for (let i = 0; i < amount; i++) { const card = draw(s, rng, filter); if (card) trinketCard(s, card); } };
  const ends = (type?: string) => { const ms = ctx.board.filter((m) => !type || tribe(m, type)); return [...new Set([ms[0], ms.at(-1)].filter(Boolean))] as Minion[]; };
  const cast = (id: string, target?: Minion) => castSpell({ ...ctx, target, fromHand: false, trinketCast: true }, makeMinion(PREFIX + id));
  const craft = (id: string) => { const card = makeMinion(PREFIX + id); card.expires = true; trinketCard(s, card); };
  const discover = (opts: Omit<DiscoveryRequest, "kind">, kind = "minion") => queueDiscover(s, kind, { ...opts, trinket: true });
  switch (id) {
    case 'BG32_MagicItem_892': craft('BG32_MagicItem_892t'); break;
    case 'BG32_MagicItem_925': for (const m of [...ctx.board].filter(m => m.id === PREFIX + 'BG31_148')) triggerBattlecry(ctx, m); break;
    case 'BG36_MagicItem_404': case 'BG36_MagicItem_404t': { const n = id.endsWith('t') ? 10 : 4; deityGain(s, n, n, ctx.board); break; }
    case 'BG36_MagicItem_406': if (subject && getDef(subject.id).kind === 'spell') get(d => d.tier <= s.tier && (d.races?.includes('畸变怪') === true || d.tribe === '全部')); break;
    case 'BG36_MagicItem_407': case 'BG36_MagicItem_408': case 'BG36_MagicItem_409': case 'BG36_MagicItem_410': {
      if (id.endsWith('409') && (!subject || subject.id !== PREFIX + 'BG20_GEM' || bump(s, key + ':gems') % 10)) break;
      const type = ({ BG36_MagicItem_407: '龙', BG36_MagicItem_408: '海盗', BG36_MagicItem_409: '野猪人', BG36_MagicItem_410: '亡灵' } as Record<string, Tribe>)[id];
      const item = pick(TRINKETS.filter(t => t.school === 'GREATER_TRINKET' && trinketRaces(t.id).includes(type) && canOfferTrinket(s, t.id)), rng);
      if (item) { st.trinkets[slot] = item.id; trinketStart(ctx, item.id, true, slot); }
      break;
    }
    case 'BG36_MagicItem_411': trinketGold(s, 3); offerPowers(s, 'additional', rng); break;
    case 'BG36_MagicItem_412': case 'BG36_MagicItem_412t2': st.kiriSlot = slot; (st.pendingTrinketChoices ??= []).push({ slot, school: id.endsWith('t2') ? 'GREATER_TRINKET' : 'LESSER_TRINKET' }); break;
    case 'BG36_MagicItem_414': { const n = 2 ** Math.max(0, s.turn - data.turn); for (const m of ctx.board) gain(ctx, m, n, n); break; }
    case 'BG36_MagicItem_417': craft('BG36_MagicItem_417t'); break;
    case 'BG36_MagicItem_423': case 'BG36_MagicItem_423t': for (let i = 0; i < (id.endsWith('t') ? 2 : 1); i++) grant(pick(VOLUMIZERS, rng)!); break;
    case 'BG36_MagicItem_424': trinketGold(s, ctx.board.filter(m => m.golden).length); break;
    case 'BG36_MagicItem_450': if (subject?.id === PREFIX + 'BG36_205') { const n = 4 * bump(s, key + ':bait'); for (const m of ctx.board.filter(m => tribe(m, '野兽'))) gain(ctx, m, n, n); } break;
    case 'BG36_MagicItem_600': for (const m of ctx.board.filter(m => m.id === PREFIX + 'BG36_318')) keyword(m, '复生'); break;
    case 'BG36_MagicItem_602': if (st.deity && !st.deity.golden) { st.deity.golden = true; st.deity.attack++; st.deity.health++; } break;
    case 'BG36_MagicItem_606': if (subject && getDef(subject.id).kind !== 'spell' && bump(s, key + ':discard:' + s.turn) === 1) { const copy = combatCopy(subject); copy.attack *= 2; copy.health *= 2; trinketCard(s, copy); } break;
    case 'BG36_MagicItem_609': if ((count(s, key + ':mode') % 2 === 0) === (event === 'buy')) { bump(s, key + ':mode'); trinketGold(s, 1); } break;
    case 'BG36_MagicItem_610': discover({ tribe: majorityTribe(s), golden: true, darkGift: true }, 'darkGift'); break;
    case 'BG36_MagicItem_852': linkedCards({ ...ctx, trinket: true }, true); break;
    case "BG30_MagicItem_301": for (const m of ctx.board.filter((m) => m.id === PREFIX + "BG25_008")) { keyword(m, "嘲讽"); keyword(m, "复生"); } break;
    case "BG30_MagicItem_303": {
      const card = makeMinion(PREFIX + "BG_TTN_401"); applyGlobal(s, card); ctx.pendingSummons?.push(card); break;
    }
    case "BG30_MagicItem_310": for (const m of ctx.board.filter((m) => m.id === PREFIX + "BG25_354")) gain(ctx, m, 0, m.health); break;
    case "BG30_MagicItem_403": for (const m of ctx.board.filter((m) => !boardTypes([m]).length)) gain(ctx, m, m.attack * 2, m.health * 2); break;
    case "BG30_MagicItem_411": for (const m of ctx.board.filter((m) => tribe(m, "野猪人"))) (m.extraAbilities ??= []).push({ event: "death", op: "generate", id: "BG20_GEM", amount: 2, trinket: true }); break;
    case "BG30_MagicItem_416": craft("BG30_MagicItem_416t"); break;
    case "BG30_MagicItem_418": for (const m of [...s.board, ...s.hand, ...s.shop].filter((m) => m.id === PREFIX + "BG_LOE_077")) m.extraTribes = ["鱼人", "龙"]; break;
    case "BG30_MagicItem_423": {
      const card = draw(s, rng, (d) => d.tier === Math.min(6, s.tier + 1));
      if (card) { if (s.shop.length < 7) { applyShop(s, card); s.shop.push(card); } else release(s, card); }
      break;
    }
    case "BG30_MagicItem_425": trinketGold(s, 2); discover({ tiers: [6] }); break;
    case "BG30_MagicItem_426": case "BG30_MagicItem_426t": get((d) => d.tier <= s.tier && (!data.type || d.races?.includes(data.type) === true || d.tribe === "全部"), id.endsWith("t") ? 2 : 1); break;
    case "BG30_MagicItem_442": if (subject?.gems) { const card = makeMinion(PREFIX + "BG30_MagicItem_442t"); card.attack = subject.gems.attack; card.health = subject.gems.health; ctx.summon?.(card, ctx.sourcePos ?? ctx.board.length); } break;
    case "BG30_MagicItem_703": if (!(st.mysteryCubeSlots ??= []).includes(slot)) st.mysteryCubeSlots.push(slot); (st.pendingTrinketChoices ??= []).push({ slot, school: "LESSER_TRINKET", free: true }); break;
    case "BG30_MagicItem_705": s.upgrade = Math.max(0, s.upgrade - 3); break;
    case "BG30_MagicItem_706": { const m = pick(ctx.board, rng); if (m) plain(m); break; }
    case "BG30_MagicItem_707": if (event === "purchase" || (s.turn - data.turn) % 3 === 0) discover({ options: darkmoonPrizes(s, 3, rng) }); break;
    case "BG30_MagicItem_801": if (subject && bump(s, key + ":discover:" + s.turn) <= 2) plain(subject); break;
    case "BG30_MagicItem_891": if (s.turn === data.turn + 2) (st.pendingTrinketChoices ??= []).push({ slot, school: "GREATER_TRINKET" }); break;
    case "BG30_MagicItem_902": for (const m of ends()) keyword(m, "圣盾"); break;
    case "BG30_MagicItem_917": for (const m of ctx.board.filter((m) => tribe(m, "纳迦"))) (m.extraAbilities ??= []).push({ event: "death", op: "randomSpellcraft", trinket: true }); break;
    case "BG30_MagicItem_924": case "BG30_MagicItem_924t": for (const m of shuffled(ctx.board.filter((m) => tribe(m, "海盗")), rng).slice(0, 2)) gain(ctx, m, id.endsWith("t") ? 6 : 3, id.endsWith("t") ? 6 : 3); break;
    case "BG30_MagicItem_942": {
      const cards = SEASON_RELATED.filter((d) => d.magnetic && d.races?.includes("机械") && d.races.includes("恶魔"));
      for (let i = 0; i < 2; i++) { const card = pick(cards, rng); if (card) grant(card.sourceId!); } break;
    }
    case "BG30_MagicItem_952": for (const m of shuffled(ctx.board.filter((m) => tribe(m, "元素")), rng).slice(0, 2)) (m.extraAbilities ??= []).push({ event: "death", op: "summon", id: "BG26_537", noScale: true }); break;
    case "BG30_MagicItem_962": for (const m of [...ctx.board].sort((a, b) => a.attack - b.attack).slice(0, 2)) gain(ctx, m, m.attack, m.health); break;
    case "BG30_MagicItem_973": for (let i = 0; i < 2 && s.shop.length < 7; i++) { const card = draw(s, rng, (d) => d.tier <= s.tier && !!data.type && (d.races?.includes(data.type) === true || d.tribe === "全部")); if (card) { applyShop(s, card); s.shop.push(card); } } break;
    case "BG30_MagicItem_981": if (subject && !boardTypes([subject]).length) { const card = drawSpell(s, rng); if (card) trinketCard(s, card); } break;
    case "BG30_MagicItem_993": grant(pick(tierSevenPool, rng)!); break;
    case "BG30_MagicItem_994": heroWheel(ctx); break;
    case "BG30_MagicItem_995": for (const m of ctx.board) gain(ctx, m, 0, Math.ceil(m.attack / 2)); break;
    case "BG32_MagicItem_170": if (subject && getDef(subject.id).magnetic) { const m = pick(ctx.board.filter((m) => tribe(m, "机械")), rng); if (m) cast("BG36_624", m); } break;
    case "BG32_MagicItem_200": if (subject && tribe(subject, "野兽")) { gain(ctx, subject, 2 + bump(s, key + ":growth"), 0); } break;
    case "BG32_MagicItem_232": { const n = bump(s, key + ":growth"); for (const m of ctx.board.filter((m) => tribe(m, "海盗"))) gain(ctx, m, n, n); break; }
    case "BG32_MagicItem_271": if (event === "purchase") (st.counters ??= {}).earlyGreater = s.turn + 1; break;
    case "BG32_MagicItem_278": if (subject) { const card = makeMinion(PREFIX + "BG31_171t"); card.attack = subject.attack; card.health = subject.health; trinketCard(s, card); } break;
    case "BG32_MagicItem_300": if (event === "purchase" || (s.turn - data.turn) % 2 === 0) queueUndeadCreation(s, rng); break;
    case "BG32_MagicItem_306": for (const m of [...ctx.board]) if (ability(m, "death").length) death(ctx, m); break;
    case "BG32_MagicItem_350": if (s.gold >= 15 && !count(s, key + ":done")) { bump(s, key + ":done"); const d = pick(poolCards(s).filter((d) => d.tier === 5), rng); if (d) { const card = grant(d.sourceId!, true); card.reward = true; } } break;
    case "BG32_MagicItem_360": for (const m of ends("亡灵")) keyword(m, "复生"); break;
    case "BG32_MagicItem_361": case "BG32_MagicItem_361t": if (event === "purchase") discover({ tiers: [id.endsWith("t") ? 5 : 4], typed: true, trinketKey: key }); else if (data.card) grant(data.card); break;
    case "BG32_MagicItem_362t": for (let i = 0; i < 2; i++) discover({ tiers: [6], stats: { attack: 30, health: 30 } }); break;
    case "BG32_MagicItem_400": for (const m of [...ctx.board]) { const replacement = draw(s, rng, (d) => d.tier === 4); if (replacement) { const index = ctx.board.indexOf(m); release(s, m); ctx.board[index] = replacement; } } break;
    case "BG32_MagicItem_428": if (s.turn === data.turn + 2) trinketGold(s, 10); break;
    case "BG32_MagicItem_807": { grant("TB_BaconShop_HERO_33_Buddy", true); const m = grant("TB_BaconShop_HP_033t"); m.attack = m.health = 10; keyword(m, "烈毒"); break; }
    case "BG32_MagicItem_817": { const m = [...s.shop, ...st.spellShop].sort((a, b) => getDef(b.id).tier - getDef(a.id).tier)[0]; if (m) { s.shop = s.shop.filter((x) => x !== m); st.spellShop = st.spellShop.filter((x) => x !== m); trinketCard(s, m); } break; }
    case "BG32_MagicItem_860": case "BG32_MagicItem_860t": for (let i = 0; i < (id.endsWith("t") ? 2 : 1); i++) { const m = makeMinion(PREFIX + "BG28_603t"); applyGlobal(s, m); keyword(m, "嘲讽"); ctx.summon?.(m, ctx.sourcePos ?? ctx.board.length); } break;
    case "BG32_MagicItem_901": if (subject && data.type && tribe(subject, data.type) && !count(s, key + ":done")) { bump(s, key + ":done"); makeGolden(subject); subject.reward = true; } break;
    case "BG32_MagicItem_922": if (event === "spell") bump(s, key + ":growth"); else if (ctx.board[0]) { const n = 3 + count(s, key + ":growth"); gain(ctx, ctx.board[0], n, n); } break;
    case "BG32_MagicItem_951": { const m = pick(ctx.board.filter((m) => getDef(m.id).tier <= 4 && !m.golden), rng); if (m) makeGolden(m); break; }
    case "BG35_MagicItem_150": for (const m of s.shop) { gain(ctx, m, 3, 3); const temp = m.temporary ??= { attack: 0, health: 0, keywords: [] }; temp.attack += 3; temp.health += 3; } break;
    case "BG35_MagicItem_152": { const m = [...s.shop].sort((a, b) => getDef(b.id).tier - getDef(a.id).tier)[0]; if (m) (m.counters ??= {}).healthPurchase = 1; break; }
    case "BG35_MagicItem_154": if (subject && tribe(subject, "恶魔")) { const eater = pick(ctx.board.filter((m) => m !== subject && tribe(m, "恶魔")), rng); const food = pick(s.shop, rng); if (eater && food) consumeMinion(ctx, eater, food); } break;
    case "BG35_MagicItem_309": grant(rng() < .5 ? "BG35_140" : "BG35_141"); break;
    case "BG35_MagicItem_306": case "BG35_MagicItem_733": craft(id + "t"); break;
    case "BG35_MagicItem_434": { const gem = makeMinion(PREFIX + "BG20_GEM"); gem.extraAbilities = [{ event: "cast", op: "buff", target: "selected", tribe: "野猪人", keyword: pick(["嘲讽", "圣盾", "复生"] as Keyword[], rng)! }]; trinketCard(s, gem); break; }
    case "BG35_MagicItem_701": if (event === "combat") { const n = 1 + count(s, key + ":growth"); ctx.trinketCombat![key + ":aura"] = n; for (const m of ctx.board.filter((m) => tribe(m, "野兽"))) gain(ctx, m, n, n); } else if (subject && tribe(subject, "野兽")) { const n = ctx.trinketCombat?.[key + ":aura"] || 0; if (n) gain(ctx, subject, n, n); bump(s, key + ":growth"); } break;
    case "BG35_MagicItem_732": if (event === "combat") { data.stored = ctx.board.slice(0, 3).map(combatCopy); for (const m of ctx.board.slice(0, 3)) m.health = 0; } else if (!ctx.board.length && data.stored?.length) { const cards = data.stored; data.stored = []; for (const m of cards) ctx.summon?.(combatCopy(m), ctx.board.length); } break;
    case "BG35_MagicItem_740": for (const m of ctx.board) (m.extraAbilities ??= []).push({ event: "death", op: "buff", target: "all", attack: 2, health: 2, permanent: true, noScale: true }); break;
    case "BG35_MagicItem_742": for (const m of ends("机械")) magnetize(ctx, m, makeMinion(PREFIX + "BG26_147")); break;
    case "BG35_MagicItem_743": if (event === "refresh" && s.shop.length < 7) { const card = draw(s, rng, (d) => d.tier <= s.tier && d.magnetic === true); if (card) { applyShop(s, card); s.shop.push(card); } } break;
    case "BG35_MagicItem_752": for (const m of ends()) triggerBattlecry({ ...ctx, target: undefined }, m); break;
    case "BG35_MagicItem_754": { const n = Math.max(0, ...s.hand.filter((m) => getDef(m.id).kind !== "spell").map((m) => m.attack)); for (const m of ctx.board.filter((m) => tribe(m, "鱼人"))) gain(ctx, m, n, 0); break; }
    case "BG35_MagicItem_755": craft("BG35_MagicItem_755t"); break;
    case "BG35_MagicItem_812": if (event === "purchase") grant("BG35_MagicItem_812t"); break;
    case "BG35_MagicItem_814": if (s.tier === 6) trinketGold(s, 12); break;
    case "BG35_MagicItem_816": case "BG35_MagicItem_816t": {
      const next = pick(TRINKETS.filter((t) => t.school === (id.endsWith("t") ? "GREATER_TRINKET" : "LESSER_TRINKET") && !st.trinkets.includes(t.id) && !t.id.startsWith("BG35_MagicItem_816")), rng);
      if (next) { st.trinkets[slot] = next.id; trinketStart(ctx, next.id, true); } if (id.endsWith("t")) trinketGold(s, 4); break;
    }
    case "BG35_MagicItem_820": (st.counters ??= {}).iceBlock = 1; break;
    case "BG35_MagicItem_821": case "BG35_MagicItem_821t": discover({ options: shuffled(tierSevenPool, rng).slice(0, 3).map((id) => PREFIX + id), golden: id.endsWith("t"), lockedUntil: s.turn + 2 }); break;
    case "BG35_MagicItem_823": case "BG35_MagicItem_823t": queueTimewarp(s, rng, id.endsWith("t")); break;
    case "BG35_MagicItem_862": { const m = [...s.shop].sort((a, b) => b.health - a.health)[0]; if (m) gain(ctx, m, m.attack, m.health); break; }
    case "BG35_MagicItem_872": craft("BG35_MagicItem_872t"); break;
    case "BG35_MagicItem_923": for (const m of ctx.board) { const n = ctx.combat ? 2 : 1; gain(ctx, m, n, n); if (ctx.combat) ctx.permanent?.(m, n, n); } break;
    case "BG35_MagicItem_930": (st.counters ??= {}).warbandRefresh = 1; break;
    case "BG35_MagicItem_931": case "BG35_MagicItem_931t": if (subject) plain(subject); break;
  }
}
function trinketSpell(ctx: Context, spell: Minion) {
  const { s, rng, target } = ctx;
  const tavern = !spell.tempSpell && tavernSpellIds.has(spell.id);
  if (tavern) {
    bump(s, "trinketSpells:" + s.turn);
    for (let i = 0; i < trinketCopies(s, "820"); i++)
      for (const m of [...ctx.board, ...s.hand].filter((m) => m.id === PREFIX + "BG32_330")) gain(ctx, m, 3, 3);
  }
  if (target) {
    if (trinket(s, "371")) bump(s, "honeycomb:" + s.turn);
    if (ctx.board.includes(target) && !ctx.trinketCast) {
      for (let i = 0; i < trinketCopies(s, "211"); i++) {
        const candidates = seasonTargets({ ...s, board: ctx.board }, spell, "cast").filter((m) => ctx.board.includes(m) && m.uid !== target.uid);
        const next = pick(candidates, rng);
        if (next) castSpell({ ...ctx, target: next, fromHand: false, trinketCast: true, depth: (ctx.depth || 0) + 1 }, spell);
      }
    }
    if (s.shop.includes(target) && trinket(s, "831")) {
      const eater = pick(ctx.board, rng);
      if (eater) consumeMinion(ctx, eater, target);
    }
  }
  // Count each equipped rune separately; replacements can grant their purchase effect.
  for (const [index, id] of [...ss(s).trinkets].entries()) if (id === "BG36_MagicItem_305") {
    if (bump(s, "rune:" + index) >= 18) {
      const choices = TRINKETS.filter((t) => t.school === "GREATER_TRINKET" &&
        (trinketTypes as Record<string, { types: string[] }>)[t.id]?.types.includes("纳迦") && !ss(s).trinkets.includes(t.id));
      const replacement = pick(choices, rng);
      if (replacement) { ss(s).trinkets[index] = replacement.id; trinketStart(ctx, replacement.id, true); }
    }
  }
}
function consumeMinion(ctx: Context, eater: Minion, food: Minion, factor = 1, keywords = false) {
  const { s } = ctx;
  if (!s.shop.includes(food)) return;
  gain(ctx, eater, food.attack * factor, food.health * factor);
  for (const watcher of ctx.board.filter((m) => has(m, "copyConsumedStats"))) gain({ ...ctx, source: watcher }, watcher, food.attack * (watcher.golden ? 2 : 1), food.health * (watcher.golden ? 2 : 1));
  const claws = tribe(eater, "恶魔") ? trinketCopies(s, "801") : 0;
  if (keywords || claws) for (const k of food.keywords) keyword(eater, k);
  if (claws) gain(ctx, eater, 5 * claws, 5 * claws);
  s.shop.splice(s.shop.indexOf(food), 1);
  release(s, food);
}
export function endEffects(s: Game, rng: () => number) {
  const ctx = { s, board: s.board, rng };
  const repeats = Math.max(
    1,
    ...s.board.filter((m) => has(m, "drakkari")).map((m) => (m.golden ? 3 : 2)),
  ) + itemCount(s, "BG32_MagicItem_367");
  for (let i = 0; i < repeats; i++) {
    heroEnd(ctx);
    legacyTrinketEvent(ctx, "end");
    for (const m of [...s.board]) {
      run(ctx, m, "end");
      giftEvent(ctx, m, "end");
    }
    for (const id of ss(s).trinkets) {
      if (["BG36_MagicItem_302", "BG36_MagicItem_302t"].includes(id))
        for (const m of s.board) addStats(m, (id.endsWith("302t") ? 4 : 1) + ss(s).goldenPlayed, (id.endsWith("302t") ? 2 : 1) + ss(s).goldenPlayed);
      if (["BG36_MagicItem_810", "BG36_MagicItem_810t"].includes(id)) {
        const satellite = makeMinion(PREFIX + "BG31_171t");
        satellite.attack = satellite.health = (id.endsWith("810t") ? 12 : 4) + count(s, "trinketSpells:" + s.turn);
        trinketCard(s, satellite);
      }
    }
    for (let j = 0; j < trinketCopies(s, "212"); j++)
      for (const m of s.board
        .filter((m) => ability(m, "death").length)
        .slice(0, 2))
        death(ctx, m);
    for (let j = 0; j < trinketCopies(s, "214"); j++) for (const m of [...s.board]) run(ctx, m, "rally");
    for (let j = 0; j < trinketCopies(s, "812"); j++) {
      const m = s.board.find((m) => tribe(m, "机械"));
      if (m) castSpell({ ...ctx, target: m }, makeMinion(PREFIX + "BG36_624"));
    }
    if (trinket(s, "372") && ss(s).lastSpell)
      for (let j = 0; j < 3 * trinketCopies(s, "372"); j++) trinketCard(s, makeMinion(ss(s).lastSpell!));
  }
  for (let i = 0; i < count(s, "unlimitedCoins:" + s.turn); i++) putHand(s, makeMinion(PREFIX + "BGS_Treasures_014"));
  s.hand = s.hand.filter((m) => {
    if (m.expires) {
      release(s, m);
      return false;
    }
    return true;
  });
  ss(s).pendingTrinketCards = ss(s).pendingTrinketCards?.filter((m) => !m.expires);
  flushTrinketCards(s);
}
function startPowerEffects(s: Game, rng: () => number) {
  if (hasPower(s, "xavius") && s.turn % 4 === 0 && !s.discovery.length) darkDiscover(s, rng);
}
function offerPowers(s: Game, mode: PowerChoice["mode"], rng: () => number, selected: string[] = []) {
  const excluded = new Set([...equippedPowers(s), ...selected, ...["finley", "nguyen", "genn", "patchwerk"].map((k) => PREFIX + k)]);
  const offers = shuffled(SEASON_HEROES.filter((h) => !excluded.has(h.id) &&
    (mode !== "nguyen" || nguyenPowerEligible(s, h.id)) &&
    (!HERO_TRIBES[h.id] || ss(s).tribes.includes(HERO_TRIBES[h.id]))), rng)
    .slice(0, mode === "nguyen" ? 2 : 3).map((h) => h.id);
  ss(s).powerChoice = { mode, offers, selected };
}
function startEffects(s: Game, rng: () => number) {
  const ctx = { s, board: s.board, rng };
  openLockboxes(ctx);
  ss(s).freeRefresh += count(s, "prizeRefresh");
  ss(s).playedTurn = 0;
  ss(s).trinketBuys = 0;
  ss(s).healthRefreshes = 0;
  ss(s).healthRefreshUses = {};
  ss(s).goldSpentTurn = 0;
  [...s.board, ...s.hand, ...s.shop].forEach((m) => {
    m.activated = false;
    if (m.counters) { m.counters.magneticArmed = 0; m.counters.purchaseArmed = 0; }
    if (m.lockedUntil && m.lockedUntil <= s.turn) m.lockedUntil = undefined;
    if (m.lockedTier && m.lockedTier <= s.tier) m.lockedTier = undefined;
    m.rebornNext = false;
    if (m.temporary) {
      m.attack = Math.max(0, m.attack - m.temporary.attack);
      m.health = Math.max(1, m.health - m.temporary.health);
      m.keywords = m.keywords.filter((k) => !m.temporary!.keywords.includes(k));
      m.temporary = undefined;
    }
  });
  for (const delayed of ss(s).delayed || []) if (delayed.turn === s.turn && (!delayed.win || s.battles[0]?.result === "win")) {
    for (const m of s.board.filter((m) => !delayed.uid || m.uid === delayed.uid))
      for (let i = 0; i < delayed.amount; i++) gain(ctx, m, delayed.attack, delayed.health);
  }
  ss(s).delayed = ss(s).delayed?.filter((d) => d.turn > s.turn);
  for (const m of [...s.board]) {
    run(ctx, m, "start");
    run(ctx, m, "spellcraft");
  }
  if (!ss(s).powerChoice) startPowerEffects(s, rng);
  if (ss(s).powerChoice?.mode !== "nguyen") heroStart(ctx);
  for (const slot of ss(s).mysteryCubeSlots || []) if (ss(s).trinkets[slot] !== "BG30_MagicItem_703") (ss(s).pendingTrinketChoices ??= []).push({ slot, school: "LESSER_TRINKET", free: true });
  legacyTrinketEvent(ctx, "start");
  for (const id of [...ss(s).trinkets]) trinketStart(ctx, id);
  const greaterTurn = count(s, "earlyGreater") || (hasPower(s, "buttons") ? 8 : 9);
  if ((s.turn === 6 || s.turn === greaterTurn || hasPower(s, "marin") && s.turn === 5) && !ss(s).trinketDone.includes(s.turn)) {
    const school = s.turn <= 6 || itemCount(s, "BG35_MagicItem_818") && !count(s, "orbNextDone") ? "LESSER_TRINKET" : "GREATER_TRINKET";
    if (s.turn === greaterTurn) bump(s, "orbNextDone");
    offerTrinkets(s, school, rng);
    ss(s).trinketDone.push(s.turn);
  }
}
export function seasonCombat(
  s: Game,
  enemies: Minion[],
  enemyTier: number,
  rng: () => number = Math.random,
  other?: Game,
): Battle {
  syncStats(s);
  if (other) syncStats(other);
  const boards = [clone(s.board), clone(enemies)],
    enemyGame = other || clone(s);
  if (!other) {
    enemyGame.hand = [];
    enemyGame.shop = [];
    enemyGame.season!.buffs = {};
    enemyGame.season!.trinkets = [];
    enemyGame.season!.powers = [];
    enemyGame.season!.counters = {};
    enemyGame.season!.combatEffects = {};
  }
  ss(s).lastDead = []; ss(s).lastEnemy = clone(enemies);
  if (other) { ss(other).lastDead = []; ss(other).lastEnemy = clone(s.board); }
  const frames: BattleFrame[] = [];
  const killers = new Map<string, Minion>();
  const originals = [
    new Map(s.board.map((m) => [m.uid, m])),
    new Map((other?.board || []).map((m) => [m.uid, m])),
  ];
  const contexts: Context[] = [];
  let deathPositions: { side: number; pos: number }[] = [];
  const frame = (text: string, attacker?: string, target?: string) =>
    recordsFrames() && frames.push({
      allies: clone(boards[0]),
      enemies: clone(boards[1]),
      text,
      attacker,
      target,
    });
  const summon = (side: number, m: Minion, pos: number) => {
    if (boards[side].length >= 7) return;
    const awakening = mcount(m, 'pendingDeityAwaken');
    if (awakening) { const deity = ss(contexts[side].s).deity!; m.attack = deity.attack; m.health = deity.health; (m.counters ??= {}).pendingDeityAwaken = 0; }
    const insertion = Math.max(0, Math.min(pos, boards[side].length));
    boards[side].splice(insertion, 0, m);
    // Keep removed minions' slots aligned as earlier deathrattles fill spaces.
    for (const slot of deathPositions)
      if (slot.side === side && slot.pos >= insertion) slot.pos++;
    (m.counters ??= {}).deathStatsHealth = m.health;
    notifySummon(contexts[side], m);
    if (awakening) { run(contexts[side], m, "awaken"); frame(`${getDef(m.id).name}被唤醒。`); }
  };
  for (let side = 0; side < 2; side++)
    contexts.push({
      s: side === 0 ? s : enemyGame,
      board: boards[side],
      enemy: boards[1 - side],
      rng,
      combat: true,
      pendingSummons: [],
      deadMechs: [],
      deadAberrations: [],
      trinketCombat: {},
      remember: (m, key, amount) => { const orig = originals[side].get(m.uid); if (orig) mbump(orig, key, amount); },
      summon: (m, pos) => summon(side, m, pos),
      permanentKeyword: (m, k) => { const orig = originals[side].get(m.uid); if (orig) keyword(orig, k); },
      permanent: (m, a, h) => {
        if (side === 0 || other) {
          const orig = originals[side].get(m.uid);
          if (orig && !retained.has(m)) addStats(orig, a, h);
        }
      },
    });
  for (let side = 0; side < 2; side++)
    for (const m of boards[side]) {
      (m.counters ??= {}).deathStatsHealth = m.health;
      if (has(m, "kodoStats")) { (m.counters ??= {}).kodoSummons = 0; m.counters.deathStatsHealth = m.health; }
      for (const key of ["piperDamage", "pagleKill", "avengeDeaths"]) if (m.counters) m.counters[key] = 0;
      if (m.rebornNext) keyword(m, "复生");
      const original = originals[side].get(m.uid);
      if (has(m, "keep") && original)
        retained.set(m, { original, factor: m.golden ? 2 : 1 });
      if (original && tribe(m, "龙")) {
        const i = boards[side].indexOf(m);
        const poets = [...boards[side].filter((x) => has(x, "keepAllDragons")), ...[boards[side][i - 1], boards[side][i + 1]].filter((x) => x && has(x, "keepAdjacentDragons"))];
        if (poets.length) retained.set(m, { original, factor: Math.max(retained.get(m)?.factor || 1, ...poets.map((x) => x.golden ? 2 : 1)) });
      }
    }
  const damage = (target: Minion, amount: number, source?: Minion) => {
    if (amount <= 0) return;
    if (target.keywords.includes("圣盾")) {
      if (has(target, "tripleShield") && mbump(target, "shieldHits") < (target.golden ? 4 : 3)) return;
      if (target.counters) target.counters.shieldHits = 0;
      target.keywords = target.keywords.filter((k) => k !== "圣盾");
      const side = boards.findIndex((b) => b.includes(target));
      if (side >= 0) for (const m of [...boards[side]]) run({ ...contexts[side], eventMinion: target }, m, "shieldLost");
      return;
    }
    target.health -= amount;
    if (
      source?.keywords.includes("剧毒") ||
      source?.keywords.includes("烈毒")
    ) {
      target.health = 0;
      source.keywords = source.keywords.filter((k) => k !== "烈毒");
    }
    const side = boards.findIndex((b) => b.includes(target));
    if (side >= 0) run({ ...contexts[side], amount, eventMinion: source }, target, "damaged");
    if (source) {
      const side = boards.findIndex((b) => b.includes(source));
      if (side >= 0) {
        run({ ...contexts[side], amount, target }, source, "dealtDamage");
        if (tribe(source, "恶魔")) for (const x of boards[side].filter((x) => x.uid !== source.uid && x.health > 0)) run({ ...contexts[side], eventMinion: source }, x, "demonDamage");
      }
      if (target.health <= 0) killers.set(target.uid, source);
      if (target.health <= 0 && side >= 0 && hasPower(contexts[side].s, "rokara")) {
        addStats(source, 1, 0); contexts[side].permanent?.(source, 1, 0);
      }
    }
  };
  for (const ctx of contexts) ctx.damage = damage;
  const resolve = () => {
    let guard = 0;
    while (boards.some((b) => b.some((m) => m.health <= 0)) && guard++ < 100) {
      const dead = boards.flatMap((b, side) => {
        let pos = 0;
        return b.flatMap((m) => m.health <= 0 ? [{ m, side, pos }] : (pos++, []));
      });
      deathPositions = dead;
      for (const b of boards)
        for (let i = b.length - 1; i >= 0; i--)
          if (b[i].health <= 0) b.splice(i, 1);
      for (const slot of dead) {
        const { m, side } = slot;
        const ctx = contexts[side];
        for (const game of other ? [s, other] : [s]) if ((ss(game).lastDead?.length || 0) < 100) ss(game).lastDead!.push(m.id);
        if (tribe(m, "机械")) ctx.deadMechs!.push({ id: m.id, golden: m.golden });
        if (tribe(m, '畸变怪') && !['BGFYM_000', 'BGFYM_011'].includes(getDef(m.id).sourceId!)) ctx.deadAberrations!.push(clone(m));
        ss(ctx.s).deaths++;
        if (ctx.deadAberrations!.length >= 3 && !ctx.trinketCombat!.deityAwakened && ss(ctx.s).deity) {
          ctx.trinketCombat!.deityAwakened = 1;
          const deity = ss(ctx.s).deity!, card = makeMinion(PREFIX + deity.id, deity.golden);
          card.attack = deity.attack; card.health = deity.health;
          (card.counters ??= {}).awakenedDeity = 1; card.counters.pendingDeityAwaken = 1;
          if (trinket(ctx.s, '416')) keyword(card, '复生');
          if (boards[side].length < 7) summon(side, card, boards[side].length); else ctx.pendingSummons!.unshift(card);
        }
        legacyTrinketEvent({ ...ctx, eventMinion: m, sourcePos: slot.pos }, "death");
        if (hasPower(ctx.s, "ini") && ss(ctx.s).deaths % 9 === 0) {
          const card = draw(ctx.s, rng, (d) => d.tier <= ctx.s.tier && (d.races?.includes("机械") === true || d.tribe === "全部")); if (card) putHand(ctx.s, card);
        }
        const opposing = contexts[1 - side].s;
        if (hasPower(opposing, "rafaam") && count(opposing, "rafaamTurn") === opposing.turn && count(opposing, "rafaamClaim") !== opposing.turn) {
          putHand(opposing, makeMinion(m.id)); (ss(opposing).counters ??= {}).rafaamClaim = opposing.turn;
        }
        for (const fish of ctx.board.filter((x) => x.id === PREFIX + "TB_BaconShop_HP_105t" && x.uid !== m.uid)) {
          for (let i = 0; i < (fish.golden ? 2 : 1); i++) fish.extraAbilities = [...(fish.extraAbilities || []), ...ability(m, "death").map((a) => copiedAbility(m, a))];
        }
        if (m.id === PREFIX + "BG25_008") { bump(ctx.s, "knightDeaths"); syncStats(ctx.s, ctx.board); }
        if (tribe(m, "亡灵") && trinket(ctx.s, "216")) {
          scale(ctx.s, "eternalPortrait", 4 * trinketCopies(ctx.s, "216"), 2 * trinketCopies(ctx.s, "216"));
          syncStats(ctx.s, ctx.board);
        }
        death({
          ...ctx,
          sourcePos: slot.pos,
          killer: killers.get(m.uid),
          // The source has left the board: insert at its slot, then advance
          // through its summons, including additional deathrattle triggers.
          summon: (card) => summon(side, card, slot.pos),
        }, m);
        for (const x of [...boards[side]].filter((x) => x.health > 0)) {
          run({ ...ctx, eventMinion: m }, x, "friendlyDeath");
          const n = mbump(x, "avengeDeaths");
          for (const a of ability(x, "avenge")) if (n % (a.threshold || 1) === 0) effect({ ...ctx, eventMinion: m }, x, a);
        }
        if (m.keywords.includes("复生")) {
          const revived = makeMinion(m.id, m.golden);
          applyGlobal(contexts[side].s, revived);
          revived.health = 1;
          revived.keywords = revived.keywords.filter((k) => k !== "复生");
          summon(side, revived, slot.pos);
          if (!boards[side].includes(revived)) continue;
          for (const x of [...boards[side]].filter((x) => x.health > 0)) run({ ...ctx, eventMinion: revived }, x, "reborn");
          if ((side === 0 || other) && trinket(contexts[side].s, "205"))
            boards[side].forEach((t) => addStats(t, 2 * trinketCopies(ctx.s, "205"), 2 * trinketCopies(ctx.s, "205")));
          if (trinket(ctx.s, "217") && (ctx.trinketCombat!.rebornCopies || 0) < 3) {
            ctx.trinketCombat!.rebornCopies = (ctx.trinketCombat!.rebornCopies || 0) + 1;
            for (let i = 0; i < trinketCopies(ctx.s, "217"); i++) trinketCard(ctx.s, makeMinion(m.id, m.golden));
          }
        }
      }
      deathPositions = [];
      fillSpaces();
    }
  };
  const fillSpaces = () => {
    for (let side = 0; side < 2; side++) {
      const ctx = contexts[side];
      if (!ctx.board.length) legacyTrinketEvent(ctx, "empty");
      if (boards[side].length < 7 && ss(ctx.s).heroMarks?.tavishId) {
        delete ss(ctx.s).heroMarks!.tavishId;
        const target = pick(boards[1 - side], rng); if (target) damage(target, count(ctx.s, "tavishAttack"));
      }
      while (ctx.pendingSummons!.length && boards[side].length < 7) summon(side, ctx.pendingSummons!.shift()!, boards[side].length);
      const effects = ss(contexts[side].s).combatEffects;
      for (const key of ["drekthar", "vanndar"]) if (effects?.[key] && boards[side].length < 7 && boards[side].length) {
        effects[key] = 0;
        const target = [...boards[side]].sort((a, b) => key === "drekthar" ? b.attack - a.attack : b.health - a.health)[0];
        const copy = clone(target); copy.uid = makeMinion(target.id).uid; copy.copies = {}; summon(side, copy, boards[side].length);
      }
      while (effects?.beetles && boards[side].length < 7) {
        effects.beetles--;
        const beetle = makeMinion(PREFIX + "BG28_603t");
        applyGlobal(contexts[side].s, beetle); keyword(beetle, "嘲讽");
        summon(side, beetle, boards[side].length);
      }
    }
  };
  frame("战斗开始");
  for (let side = 0; side < 2; side++) {
    const ctx = contexts[side];
    const st = ss(ctx.s);
    legacyTrinketEvent(ctx, "combat");
    if (hasPower(ctx.s, "ozumat")) {
      const token = makeMinion(PREFIX + "BG23_HERO_201pt"); addStats(token, powerCount(ctx.s, "ozumat", "soldMinions"), powerCount(ctx.s, "ozumat", "soldMinions")); ctx.pendingSummons!.push(token);
    }
    for (const key of ["drekthar", "vanndar"]) if (hasPower(ctx.s, key) && ctx.s.turn >= 7) (st.combatEffects ??= {})[key] = 1;
    if (hasPower(ctx.s, "yshaarj") && count(ctx.s, "yshaarjTurn") === ctx.s.turn && ctx.board.length < 7) {
      const card = draw(ctx.s, rng, (d) => d.tier === ctx.s.tier);
      if (card) { putHand(ctx.s, card); const copy = clone(card); copy.uid = makeMinion(card.id).uid; copy.copies = {}; summon(side, copy, ctx.board.length); }
    }
    if (hasPower(ctx.s, "tamsin")) {
      const target = [...ctx.board].sort((a, b) => a.attack - b.attack)[0];
      if (target) { (target.extraAbilities ??= []).push({ event: "death", op: "deathStats", target: "others" }); (target.counters ??= {}).deathStatsHealth = target.health; }
    }
    if (hasPower(ctx.s, "teron") && st.heroMarks?.teron) {
      const target = ctx.board.find((m) => m.uid === st.heroMarks?.teron);
      if (target) { const copy = clone(target); copy.uid = makeMinion(target.id).uid; copy.copies = {}; ctx.pendingSummons!.push(copy); target.health = 0; }
      delete st.heroMarks.teron;
    }
    if (hasPower(ctx.s, "waggtoggle")) {
      const bonus = 1 + Math.floor(powerCount(ctx.s, "waggtoggle", "goldSpent") / 10);
      for (const m of buffTargets(ctx, makeMinion(PREFIX + "BG25_001"), { event: "combat", op: "buff", target: "menagerie" })) gain(ctx, m, bonus, bonus);
    }
    if (hasPower(ctx.s, "deathwing")) for (const team of contexts) for (const m of team.board) { addStats(m, 2, 0); team.permanent?.(m, 2, 0); }
    for (const m of [...ctx.s.hand]) run(ctx, m, "handCombat");
    const effects = ss(ctx.s).combatEffects || {};
    for (let i = 0; i < (effects.enemyOne || 0); i++) { const t = pick(boards[1 - side], rng); if (t) t.health = 1; }
    if (effects.doubleLeft && boards[side][0]) boards[side][0].attack *= 2 ** effects.doubleLeft;
    for (const m of [...boards[side]]) {
      run(ctx, m, "combat");
      giftEvent(ctx, m, "combat");
    }
    if (
      (side === 0 || other) &&
      hasPower(ctx.s, "alakir") &&
      boards[side][0]
    )
      ["风怒", "圣盾", "嘲讽"].forEach((k) =>
        keyword(boards[side][0], k as Keyword),
      );
    if ((side === 0 || other) && trinket(ctx.s, "213"))
      boards[side]
        .filter((m) => ability(m, "rally").length)
        .forEach((m) => keyword(m, "圣盾"));
    if ((side === 0 || other) && trinket(ctx.s, "361")) {
      const ns = boards[side].filter((m) => tribe(m, "纳迦"));
      for (const m of new Set([ns[0], ns.at(-1)].filter(Boolean))) {
        addStats(m!, m!.attack, m!.health);
      }
    }
    for (let i = 0; i < trinketCopies(ctx.s, "841"); i++) for (const m of ctx.board.filter((m) => tribe(m, "机械"))) {
      magnetize(ctx, m, makeMinion(PREFIX + "BG32_172"));
    }
  }
  fillSpaces();
  resolve();
  frame("战斗开始技能结算");
  let side =
    boards[0].length === boards[1].length
      ? rng() < 0.5
        ? 0
        : 1
      : boards[0].length > boards[1].length
        ? 0
        : 1;
  const last = ["", ""];
  const index = [0, 0];
  for (
    let step = 0;
    step < 180 && boards[0].length && boards[1].length;
    step++
  ) {
    const normalSide = side;
    const immediateSide = [side, 1 - side].find(i => boards[i].some(m => m.health > 0 && m.attack > 0 && mcount(m, 'immediateAttack')));
    if (immediateSide !== undefined) side = immediateSide;
    const immediate = boards[side].find(m => m.health > 0 && m.attack > 0 && mcount(m, 'immediateAttack'));
    if (immediate) mbump(immediate, 'immediateAttack', -1);
    const board = boards[side],
      ctx = contexts[side];
    const prev = board.findIndex((m) => m.uid === last[side]);
    const start =
      prev >= 0 ? (prev + 1) % board.length : index[side] % board.length;
    let attacker: Minion | undefined;
    for (let i = 0; i < board.length; i++) {
      const m = board[(start + i) % board.length];
      if (m.attack > 0) {
        attacker = m;
        break;
      }
    }
    if (!attacker) {
      if (!boards[1 - side].some((m) => m.attack > 0)) break;
      side = 1 - side;
      continue;
    }
    if (immediate) attacker = immediate;
    else { last[side] = attacker.uid; index[side] = board.indexOf(attacker); }
    const swings = !immediate && attacker.keywords.includes("风怒") ? 2 : 1;
    for (
      let hit = 0;
      hit < swings && attacker.health > 0 && boards[1 - side].length;
      hit++
    ) {
      const attack = attacker;
      legacyTrinketEvent({ ...ctx, eventMinion: attack }, "attack");
      if (tribe(attack, "野兽") && trinket(ctx.s, "201")) gain(ctx, attack, 4 * trinketCopies(ctx.s, "201"), 2 * trinketCopies(ctx.s, "201"));
      bump(ctx.s, "heroAttacks"); countPowerEvent(ctx.s, "attacks");
      if (hasPower(ctx.s, "lo") && powerCount(ctx.s, "lo", "attacks") % 15 === 0) reward(ctx.s);
      let enemy = boards[1 - side].filter((m) => !m.keywords.includes("潜行"));
      if (!enemy.length) enemy = boards[1 - side];
      const taunts = enemy.filter((m) => m.id === PREFIX + "BG34_405" ? m.keywords.includes("圣盾") : m.keywords.includes("嘲讽"));
      const target = pick(taunts.length ? taunts : enemy, rng)!;
      run(
        { ...ctx, target, sourcePos: board.indexOf(attack) },
        attack,
        "rally",
      );
      if (target.health <= 0) { resolve(); frame("进击、伤害与亡语结算"); continue; }
      giftEvent(ctx, attack, "rally");
      for (const other of [...board]) {
        if (other.uid !== attack.uid) run({ ...ctx, eventMinion: attack }, other, "otherAttack");
        if (tribe(attack, "野兽"))
          run({ ...ctx, eventMinion: attack }, other, "attackBeast");
        if (other.uid !== attack.uid && tribe(attack, "龙"))
          run({ ...ctx, eventMinion: attack }, other, "attackDragon");
      }
      if (
        (side === 0 || other) &&
        trinket(ctx.s, "200") &&
        ability(attack, "rally").length
      )
        ss(ctx.s).freeRefresh += trinketCopies(ctx.s, "200");
      const neighbors = has(attack, "cleave")
        ? [
            boards[1 - side][boards[1 - side].indexOf(target) - 1],
            boards[1 - side][boards[1 - side].indexOf(target) + 1],
          ].filter(Boolean)
        : [];
      for (const other of [...boards[1 - side]]) run({ ...contexts[1 - side], eventMinion: target }, other, "attacked");
      const a = attack.attack,
        t = target.attack;
      const targetHealth = target.health, shielded = target.keywords.includes("圣盾");
      damage(target, a, attack);
      if (target.health <= 0) run({ ...ctx, eventMinion: target }, attack, "kill");
      if (has(attack, "overkillAdjacent") && !shielded && target.health <= 0 && a > targetHealth) {
        const adjacent = [boards[1 - side][boards[1 - side].indexOf(target) - 1], boards[1 - side][boards[1 - side].indexOf(target) + 1]].filter(Boolean);
        const victims = attack.golden ? adjacent : [pick(adjacent, rng)].filter(Boolean);
        for (const victim of victims) damage(victim!, a - targetHealth, attack);
      }
      if (
        !has(attack, "immuneAttack") &&
        giftNumber(attack.gift || "") !== "60"
      )
        damage(attack, t, target);
      for (const n of neighbors) damage(n, a, attack);
      for (const x of [...board].filter((x) => x.health > 0)) run({ ...ctx, eventMinion: attack }, x, "afterAttack");
      attack.keywords = attack.keywords.filter((k) => k !== "潜行");
      frame(
        `${getDef(attack.id).name} 攻击 ${getDef(target.id).name}`,
        attack.uid,
        target.uid,
      );
      resolve();
      frame("进击、伤害与亡语结算");
    }
    side = immediate ? normalSide : 1 - side;
  }
  const result =
    boards[0].length && !boards[1].length
      ? "win"
      : boards[1].length && !boards[0].length
        ? "loss"
        : "tie";
  const raw =
    result === "tie"
      ? 0
      : (result === "win" ? s.tier : enemyTier) +
        boards[result === "win" ? 0 : 1].reduce(
          (n, m) => n + getDef(m.id).tier,
          0,
        );
  const living = s.opponents.filter((o) => o.health > 0).length + 1;
  const cap = living <= 4 ? Infinity : s.turn < 4 ? 5 : s.turn < 8 ? 10 : 15;
  const amount = Math.min(raw, cap);
  for (let side = 0; side < 2; side++) {
    const game = contexts[side].s, effects = ss(game).combatEffects || {};
    const won = side === 0 ? result === "win" : result === "loss";
    if (effects.confidence) ss(game).nextGold += effects.confidence * (won ? 3 : result === "tie" ? 1 : 0);
    ss(game).combatEffects = {};
  }
  ss(s).buffs.beastCombat = { attack: 0, health: 0 };
  if (other) ss(other).buffs.beastCombat = { attack: 0, health: 0 };
  frame(
    `${result === "win" ? "胜利" : result === "loss" ? "失利" : "平局"} · ${amount}点伤害${raw > cap ? "，已应用伤害上限" : ""}`,
  );
  return { frames, result, damage: amount, opponent: "" };
}
function recruitAI(s: Game, rng: () => number) {
  for (const o of s.opponents) {
    if (o.health <= 0) continue;
    o.tier = Math.min(6, Math.ceil(s.turn / 2));
    for (let i = 0; i < Math.min(3, Math.floor((s.turn + 2) / 3)); i++) {
      if (o.board.length >= 7) {
        const weakest = [...o.board].sort(
          (a, b) => a.attack + a.health - (b.attack + b.health),
        )[0];
        if (getDef(weakest.id).tier >= o.tier) break;
        o.board = o.board.filter((m) => m.uid !== weakest.uid);
        release(s, weakest);
      }
      const m = draw(s, rng, (d) => d.tier <= o.tier);
      if (m) o.board.push(m);
    }
  }
}
function practiceCombatState(s: Game, opponent: Opponent): Game {
  // Practice bots have a board, not a full economy or hero-power state. Keep their
  // combat context independent of the human's buffs, hand, trinkets and powers.
  const state = createSeason(PREFIX + "lich", () => 0.5, { tribes: ss(s).tribes, pool: {} });
  state.hero = opponent.hero;
  state.turn = s.turn;
  state.tier = opponent.tier;
  state.health = opponent.health;
  state.board = opponent.board;
  state.season!.powers = [];
  state.season!.armor = opponent.armor || 0;
  state.opponents = s.opponents.map(o => o === opponent
    ? { name: "你", hero: s.hero, health: s.health, tier: s.tier, board: [] }
    : { ...o, board: [] });
  return state;
}
export function actSeason(
  state: Game,
  action: Action,
  rng: () => number = Math.random,
  privateContext?: { opponentBoard?: Minion[] },
): { state: Game; error?: string } {
  const s = clone(state),
    st = ss(s),
    ctx: Context = { s, board: s.board, rng, opponentBoard: privateContext?.opponentBoard };
  st.healthRefreshUses ??= refreshUses(s);
  syncStats(s);
  if (st.nozdormuRefreshTurn === undefined) {
    const oldFree = hasPower(s, "nozdormu") && st.freeRefresh > 0;
    st.nozdormuRefreshTurn = hasPower(s, "nozdormu") && !oldFree ? s.turn : 0;
    if (oldFree) st.freeRefresh--;
  }
  const fail = (error: string) => ({ state, error });
  const aiLimitError = aiActionError(state, action);
  if (aiLimitError) return fail(aiLimitError);
  if (s.phase === "over") return fail("本局已结束，请开始新对局。");
  if (s.phase === "combat" && action.type !== "continue")
    return fail("请先完成当前战斗。");
  if (st.powerChoice && action.type !== "choosePower") return fail("请先选择英雄技能。");
  if (!st.powerChoice && s.discovery.length && action.type !== "discover")
    return fail("请先选择发现的卡牌。");
  if (
    !st.powerChoice && st.trinketOffers.length &&
    action.type !== "buyTrinket" &&
    !s.discovery.length
  )
    return fail("请先选择本回合的饰品。");
  switch (action.type) {
    case "choosePower": {
      const choice = st.powerChoice;
      if (!choice || !choice.offers.includes(action.uid)) return fail("请选择候选中的英雄技能。");
      choice.selected.push(action.uid);
      if (choice.mode === "genn" && choice.selected.length < 2) {
        offerPowers(s, "genn", rng, choice.selected);
        break;
      }
      const ids = choice.mode === "additional" ? [...equippedPowers(s), action.uid] : choice.mode === "replace"
        ? [action.uid, ...equippedPowers(s).slice(1)] : choice.selected;
      equipPowers(s, ids);
      st.powerChoice = undefined;
      if (choice.mode === "nguyen") heroStart({ s, board: s.board, rng });
      if (choice.mode === "replace") st.powerCycle = false;
      if (!["replace", "additional"].includes(choice.mode)) startPowerEffects(s, rng);
      s.powerUsed = seasonPowerState(s).used;
      log(s, `获得英雄技能：${ids.map((id) => powerDefinition(s, id).power).join("、")}。`);
      break;
    }
    case "freeze":
      s.frozen = !s.frozen;
      log(s, s.frozen ? "已冻结随从和酒馆法术。" : "已解除冻结。");
      break;
    case "refresh": {
      const payment = refreshPayment(s);
      if (s.gold < payment.gold)
        return fail(`金币不足，刷新需要${payment.gold}金币。`);
      if (payment.source) {
        st.healthRefreshUses![payment.source] = (st.healthRefreshUses![payment.source] || 0) + 1;
        st.healthRefreshes++;
        heroDamage(s, payment.health, ctx);
      } else if (st.freeRefresh > 0) st.freeRefresh--;
      else if (payment.gold === 0 && hasPower(s, "nozdormu")) st.nozdormuRefreshTurn = s.turn;
      else spend(ctx, payment.gold);
      s.frozen = false;
      refill(s, rng);
      s.refreshes++;
      log(
        s,
        `刷新酒馆${payment.health ? `，以${payment.health}点生命支付` : payment.gold === 0 ? "，消耗免费次数" : ""}。`,
      );
      break;
    }
    case "buy": {
      const m = s.shop.find((x) => x.uid === action.uid);
      if (!m) return fail("该随从已离开酒馆。");
      const cost = minionCost(s, m);
      const healthPayment = minionUsesHealth(s, m);
      if (!healthPayment && s.gold < cost) return fail(`招募需要${cost}枚金币。`);
      if (!room(s)) return fail("手牌已满。");
      if (trinket(s, "202") && ability(m, "battlecry").length && st.trinketBuys < 2) st.trinketBuys++;
      s.shop = s.shop.filter((x) => x.uid !== m.uid);
      putHand(s, m, false);
      if (healthPayment) heroDamage(s, cost, ctx); else spend(ctx, cost);
      recordPurchasePayment(s, m, healthPayment);
      s.purchases++;
      heroPurchased(ctx, m);
      legacyTrinketEvent({ ...ctx, eventMinion: m }, "buy");
      for (const x of [...s.board]) run({ ...ctx, eventMinion: m }, x, "buyMinion");
      for (const x of [...s.board]) if (mcount(x, "purchaseArmed")) {
        const copies = mcount(x, "purchaseArmed");
        gain(ctx, x, m.attack * copies, m.health * copies);
        x.counters!.purchaseArmed = 0;
      }
      if (hasPower(s, "hoggarr") && tribe(m, "海盗")) gold(s, 1);
      if (trinket(s, "840") && tribe(m, "机械")) {
        for (let i = 0; i < trinketCopies(s, "840"); i++) {
          const spell = drawSpell(s, rng);
          if (spell) trinketCard(s, spell);
        }
      }
      log(s, `招募了${getDef(m.id).name}。`);
      break;
    }
    case "buySpell": {
      const m = st.spellShop.find((x) => x.uid === action.uid);
      if (!m) return fail("该法术已不在酒馆。");
      const cost = spellCost(s, m);
      const healthPayment = spellUsesHealth(m, s);
      if (!healthPayment && s.gold < cost) return fail(`购买法术需要${cost}枚金币。`);
      if (!room(s)) return fail("手牌已满。");
      st.spellDiscount = 0;
      st.spellShop = st.spellShop.filter((x) => x.uid !== m.uid);
      putHand(s, m);
      if (healthPayment) heroDamage(s, cost, ctx); else spend(ctx, cost);
      recordPurchasePayment(s, m, healthPayment);
      for (const x of [...s.board]) { run({ ...ctx, eventMinion: m }, x, "buySpell"); if (x.id === PREFIX + "BG36_367") run({ ...ctx, eventMinion: m }, x, "buy"); }
      legacyTrinketEvent({ ...ctx, eventMinion: m }, "buySpell");
      heroPurchased(ctx, m);
      log(s, `购买酒馆法术：${getDef(m.id).name}。`);
      break;
    }
    case "play": {
      const m = s.hand.find((x) => x.uid === action.uid);
      if (!m) return fail("未找到这张手牌。");
      if ((m.lockedUntil || 0) > s.turn || (m.lockedTier || 0) > s.tier) return fail("这张手牌尚未解锁。");
      if (getDef(m.id).kind === "spell")
        return actSeason(
          state,
          { type: "cast", uid: m.uid, target: action.target },
          rng,
        );
      const ts = seasonTargets(s, m),
        d = getDef(m.id),
        target = [...s.board, ...s.hand, ...s.shop, ...st.spellShop].find((x) => x.uid === action.target);
      if (action.target && !ts.some((x) => x.uid === action.target))
        return fail("请选择有效的友方目标。");
      if (ts.length && !action.target && !d.magnetic)
        return fail("请选择战吼目标。");
      if (s.board.length >= 7 && !(d.magnetic && target))
        return fail("战場已满，最多7个随从。");
      s.hand = s.hand.filter((x) => x.uid !== m.uid);
      if (m.reward) {
        reward(s);
        m.reward = false;
      }
      if (d.magnetic && target) {
        magnetize(ctx, target, m);
      } else {
        if (!mcount(m, "enteredTurn")) (m.counters ??= {}).enteredTurn = s.turn;
        s.board.splice(action.position ?? s.board.length, 0, m);
        notifySummon(ctx, m);
        triggerBattlecry({ ...ctx, target }, m);
        run(ctx, m, "spellcraft");
        run(ctx, m, "choice");
      }
      played(ctx, m, d.magnetic ? target : undefined);
      if (mcount(m, "doomedTurn") === s.turn) destroyRecruit(ctx, m);
      log(s, `打出了${m.golden ? "金色" : ""}${d.name}。`);
      break;
    }
    case "cast": {
      const m = s.hand.find((x) => x.uid === action.uid);
      if (!m || getDef(m.id).kind !== "spell")
        return fail("请选择一张法术手牌。");
      if ((m.lockedUntil || 0) > s.turn) return fail("这张手牌尚未解锁。");
      if (!ability(m, "cast").length) return fail("这张法术牌无法使用。");
      const ts = seasonTargets(s, m, "cast"),
        target = [...s.board, ...s.shop].find((x) => x.uid === action.target);
      if (
        ability(m, "cast").some((a) => a.target === "selected") &&
        (!target || !ts.some((x) => x.uid === target.uid))
      )
        return fail("请选择有效的法术目标。");
      s.hand = s.hand.filter((x) => x.uid !== m.uid);
      castSpell({ ...ctx, target, fromHand: true }, m);
      log(s, `施放了${getDef(m.id).name}。`);
      break;
    }
    case "activate": {
      const m = s.board.find((x) => x.uid === action.uid);
      if (!m || !ability(m, "activate").length)
        return fail("该随从没有发动技能。");
      if (m.activated) return fail("这个随从本回合已经发动。");
      const cost = getDef(m.id).activateCost || 0;
      if (s.gold < cost) return fail(`发动需要${cost}枚金币。`);
      const ts = seasonTargets(s, m, "activate"),
        target = [...s.board, ...s.hand, ...s.shop, ...st.spellShop].find((x) => x.uid === action.target);
      if (
        ability(m, "activate").some((a) => a.target === "selected" || a.target === "selectedShop" || a.target === "selectedHand") &&
        (!target || !ts.some((x) => x.uid === target.uid))
      )
        return fail("请选择发动技能的目标。");
      if (has(m, "stealHighest") && (!s.shop.length || !room(s)))
        return fail("酒馆需要随从，且手牌需要空位。");
      spend(ctx, cost);
      m.activated = true;
      for (let i = 0; i < (m.gift === "BG36_MidGameEffect_000t78" ? 2 : 1); i++) run({ ...ctx, target }, m, "activate");
      log(s, `${getDef(m.id).name}发动技能。`);
      break;
    }
    case "sell": {
      const m = s.board.find((x) => x.uid === action.uid);
      if (!m) return fail("只能出售战场上的随从。");
      sellOwned(ctx, m);
      log(s, `出售${getDef(m.id).name}。`);
      break;
    }
    case "move": {
      const i = s.board.findIndex((m) => m.uid === action.uid);
      if (i < 0) return fail("找不到该随从。");
      const [m] = s.board.splice(i, 1);
      s.board.splice(Math.max(0, Math.min(s.board.length, action.to)), 0, m);
      break;
    }
    case "upgrade":
      if (s.tier >= 6) return fail("酒馆已满级。");
      if (s.gold < s.upgrade) return fail(`升级需要${s.upgrade}金币。`);
      spend(ctx, s.upgrade);
      s.tier++;
      s.upgrade = UPGRADE_COST[s.tier] + (hasPower(s, "millhouse") ? 1 : 0);
      if (hasPower(s, "omu")) gold(s, 2);
      legacyTrinketEvent(ctx, "upgrade");
      log(s, `酒馆升至${s.tier}星。`);
      break;
    case "power": {
      const info = seasonPowerState(s, action.powerId);
      const h = info.definition;
      if (info.reason) return fail(info.reason);
      const key = h.id.slice(4),
        target = info.targets.find((m) => m.uid === action.target);
      if (info.needsTarget && !target) return fail("请选择有效的英雄技能目标。");
      if (key === "pyramid" && (!s.shop.length || !room(s)))
        return fail("酒馆需要随从，且手牌需要空位。");
      if (["elise", "alexstrasza"].includes(key) && !poolCards(s).some((d) =>
        s.pool[d.id] > 0 && (key === "elise" ? d.tier === s.tier : d.races?.includes("龙") || d.tribe === "全部")))
        return fail("随从池中没有符合条件的发现候选。");
      spend(ctx, info.cost);
      const repeats = 1 + itemCount(s, "BG30_MagicItem_804") + count(s, "wheelPowerRepeats");
      for (let repetition = 0; repetition < repeats; repetition++) {
      if (repetition && info.needsTarget && target && ![...s.board, ...s.shop, ...st.spellShop].includes(target)) break;
      if (key === 'drestagath' && target && discardCard(ctx, target)) { const card = draw(s, rng, d => d.tier <= s.tier && (d.races?.includes('畸变怪') === true || d.tribe === '全部')); if (card) putHand(s, card); }
      if (key === 'kithix') linkedCards(ctx, false);
      if (key === "lich") target!.rebornNext = true;
      if (key === "george") keyword(target!, "圣盾");
      if (key === "pyramid") {
        const m = pick(s.shop, rng)!;
        s.shop = s.shop.filter((x) => x.uid !== m.uid);
        m.health *= 2;
        putHand(s, m);
      }
      if (key === "millificent") queueDiscover(s, "minion", { magnetic: true });
      if (key === "hollidae") {
        const m = drawSpell(s, rng);
        if (m) putHand(s, m);
      }
      if (key === "xyrella") {
        s.shop = s.shop.filter((m) => m.uid !== target!.uid);
        target!.attack = target!.health = 2;
        // Existing temporary stats must not reappear when they expire next turn.
        if (target!.temporary) {
          target!.temporary.attack = 0;
          target!.temporary.health = 0;
        }
        putHand(s, target!);
      }
      if (key === "reno") makeGolden(target!);
      if (key === "elise") queueDiscover(s, "minion", { tiers: [s.tier] });
      if (key === "alexstrasza") queueDiscover(s, "minion", { tribe: "龙", tiers: [1, 2, 3, 4, 5, 6] });
      if (key === "blackthorn") {
        putHand(s, makeMinion(PREFIX + "BG20_GEM"));
        putHand(s, makeMinion(PREFIX + "BG20_GEM"));
      }
      if (key === "inge") addStats(target!, s.turn % 2 ? s.tier : 0, s.turn % 2 ? 0 : s.tier);
      const heroError = expandedHeroAction(ctx, key, target);
      if (heroError) return fail(heroError);
      }
      const progress = powerProgress(s, h.id);
      savePowerProgress(s, h.id, { ...progress, uses: progress.uses + 1, turnUses: progress.turnUses + 1 });
      s.powerUsed = seasonPowerState(s).used;
      legacyTrinketEvent(ctx, "heroPower");
      log(s, `使用英雄技能：${h.power}。`);
      break;
    }
    case "darkGift":
      if (s.turn < 3) return fail("黑暗发现于第3回合解锁。");
      if (st.giftsUsed >= 3) return fail("本局3次黑暗发现已用完。");
      if (st.giftUsedTurn === s.turn)
        return fail("每回合只能进行一次黑暗发现。");
      if (s.gold < 3) return fail("黑暗发现需要3金币。");
      if (!room(s)) return fail("先腾出一个手牌位置。");
      darkDiscover(s, rng);
      if (!s.discovery.length)
        return fail("当前池中没有符合条件的黑暗之赐组合。");
      spend(ctx, 3);
      st.giftsUsed++;
      st.giftUsedTurn = s.turn;
      log(s, "黑暗发现：挑选一位带有黑暗之赐的随从。");
      break;
    case "reward": {
      if (!s.rewards.length) return fail("没有三连奖励。");
      const tier = s.rewards.shift()!;
      queueDiscover(s, "triple", { tiers: [tier] });
      break;
    }
    case "discover": {
      const m = s.discovery.find((x) => x.uid === action.uid);
      if (!m) return fail("请选择候选卡牌。");
      const request = st.activeDiscovery;
      const target = [...s.board, ...s.shop].find((x) => x.uid === action.target);
      if (request?.kind === "choose") {
        const needsTarget = ability(m, "cast").some((a) => a.target === "selected");
        const ts = seasonTargets(s, m, "cast");
        if (needsTarget && ts.length && (!target || !ts.includes(target))) return fail("请选择抉择效果的目标。");
      }
      s.discovery.filter((x) => x.uid !== m.uid).forEach((x) => release(s, x));
      s.discovery = [];
      st.discoveryKind = "";
      st.activeDiscovery = undefined;
      if (request?.kind === "choose" && request.source) {
        const source = request.source;
        if (getDef(source.id).kind === "spell") {
          // Keep the original card ID for tavern-spell counters and last-spell effects.
          const chosen = { ...source, extraAbilities: ability(m, "cast") };
          const selectedCtx = { ...ctx, target, fromHand: true };
          castChosenSpell(selectedCtx, chosen);
        } else run({ ...ctx, target }, { ...source, extraAbilities: ability(m, "cast") }, "cast");
        for (const x of [...ctx.board]) {
          run({ ...ctx, eventMinion: source }, x, "choosePlayed");
          if (getDef(source.id).kind !== "spell") run({ ...ctx, eventMinion: source }, x, "cardPlayed");
        }
        log(s, `选择了${getDef(m.id).name}${request.both ? "，同时获得两项效果" : ""}。`);
      } else if (request?.kind === "undeadCreation") {
        queueUndeadCreation(s, rng, m);
      } else if (request?.kind === "undeadCreationFinish" && request.creationPart) {
        const part = request.creationPart;
        const creation = makeMinion(PREFIX + "BG25_HERO_100pt");
        creation.attack = part.attack + m.attack; creation.health = part.health + m.health;
        creation.keywords = [...new Set([...part.keywords, ...m.keywords])];
        creation.extraAbilities = [...ability(part).map((a) => copiedAbility(part, a)), ...ability(m).map((a) => copiedAbility(m, a))];
        for (const card of [part, m]) for (const [id, n] of Object.entries(card.copies)) creation.copies[id] = (creation.copies[id] || 0) + n;
        trinketCard(s, creation);
      } else {
        m.lockedUntil = request?.lockedUntil;
        m.bothChoices = request?.bothChoices;
        if (request?.stats) { m.attack = request.stats.attack; m.health = request.stats.health; }
        if (request?.trinketKey) ss(s).trinketData![request.trinketKey].card = getDef(m.id).sourceId;
        if (request?.doomedTurn) (m.counters ??= {}).doomedTurn = request.doomedTurn;
        const magnet = s.board.find((x) => x.uid === request?.magnetizeTarget);
        if (request?.replaceBoard) {
          const index = s.board.findIndex((x) => x.uid === request.replaceBoard);
          if (index >= 0) { release(s, s.board[index]); s.board[index] = m; } else release(s, m);
        } else if (request?.replaceShop) {
          const index = s.shop.findIndex((x) => x.uid === request.replaceShop);
          if (index >= 0) { release(s, s.shop[index]); s.shop[index] = m; }
          else release(s, m);
        } else if (request?.magnetizeTarget && magnet) {
          magnetize(ctx, magnet, m);
        } else if (request?.trinket) trinketCard(s, m);
        else putHand(s, m);
        if (request?.damage) heroDamage(s, getDef(m.id).tier, ctx);
        if (giftNumber(m.gift || "") === "11") putHand(s, makeMinion(m.id));
        for (const x of [...ctx.board]) run({ ...ctx, eventMinion: m }, x, "discovered");
        legacyTrinketEvent({ ...ctx, eventMinion: m }, "discover");
        log(s, `发现了${getDef(m.id).name}${m.gift ? "，附带黑暗之赐" : ""}。`);
      }
      break;
    }
    case "buyTrinket": {
      if (!action.uid || !st.trinketOffers.includes(action.uid))
        return fail("请选择本回合的一件饰品。");
      const item = TRINKETS.find((t) => t.id === action.uid);
      if (!item) return fail("该饰品尚未开放。");
      const cost = trinketCost(s, item.id);
      if (s.gold < cost) return fail(`购买饰品需要${cost}金币。`);
      spend(ctx, cost);
      const slot = st.replacingTrinket ?? st.trinkets.length;
      st.trinkets[slot] = item.id;
      st.replacingTrinket = undefined;
      st.trinketOffers = [];
      st.trinketOfferCosts = {};
      trinketStart(ctx, item.id, true, slot);
      if (st.kiriSlot === slot && !["BG36_MagicItem_412", "BG36_MagicItem_412t2"].includes(item.id)) {
        st.kiriSlot = undefined; st.trinketPower = item.id;
        st.trinkets.push(item.id); trinketStart(ctx, item.id, true, st.trinkets.length - 1);
        equipPowers(s, ['s14_trinket']); st.powerCycle = false;
      }
      if (item.school === "GREATER_TRINKET") for (const [index, id] of [...st.trinkets].entries()) if (id === "BG30_MagicItem_888") {
        st.trinkets[index] = item.id; trinketStart(ctx, item.id, true, index);
      }
      log(s, `购入饰品：${item.name}。`);
      break;
    }
    case "end": {
      endEffects(s, rng);
      recruitAI(s, rng);
      const battle = practiceBattles(s, (ally, enemy) => {
        if (!ally) return seasonCombat(s, enemy.board, enemy.tier, rng);
        return seasonCombat(practiceCombatState(s, ally), enemy.board, enemy.tier, rng, practiceCombatState(s, enemy));
      }, m => release(s, m));
      if (!battle) {
        s.phase = "over";
        break;
      }
      s.battle = battle;
      s.battles.unshift({
        turn: s.turn,
        result: battle.result,
        damage: battle.damage,
        name: battle.opponent,
      });
      s.phase = "combat";
      log(
        s,
        `第${s.turn}回合${battle.result === "win" ? "胜利" : battle.result === "loss" ? "失利" : "平局"}，${battle.damage}点伤害。`,
      );
      break;
    }
    case "continue": {
      if (s.phase !== "combat") return fail("当前没有待结束的战斗。");
      if (s.health <= 0 || s.opponents.every((o) => o.health <= 0)) {
        s.phase = "over";
        break;
      }
      advanceRecruit(s, rng);
      const living = s.opponents
        .map((o, i) => ({ o, i }))
        .filter((x) => x.o.health > 0);
      s.nextOpponent = (
        living.find((x) => x.i > s.nextOpponent) || living[0]
      ).i;
      log(s, `第${s.turn}回合开始。`);
      break;
    }
  }
  settleTrinkets(s, rng);
  if (s.health <= 0 && s.phase === "recruit") s.phase = "over";
  recordAIAction(state, s, action);
  return { state: s };
}
export function assertSeasonPool(s: Game) {
  const held = [
    ...s.shop,
    ...s.hand,
    ...s.board,
    ...s.discovery,
    ...(ss(s).pendingTrinketCards || []),
    ...[ss(s).activeDiscovery?.creationPart, ...ss(s).pendingDiscoveries.map((r) => r.creationPart)].filter((m): m is Minion => !!m),
    ...s.opponents.flatMap((o) => o.board),
  ];
  for (const [id, total] of Object.entries(ss(s).initialPool)) {
    const current =
      (s.pool[id] || 0) + held.reduce((n, m) => n + (m.copies[id] || 0), 0);
    if (current !== total || s.pool[id] < 0)
      throw Error(`Season pool mismatch ${id}: ${current}/${total}`);
  }
  if (s.hand.length + s.rewards.length > 10)
    throw Error("Season hand overflow");
}

export function advanceRecruit(s: Game, rng: () => number = Math.random) {
  const st = ss(s);
  if (st.nozdormuRefreshTurn === undefined) {
    if (hasPower(s, "nozdormu") && st.freeRefresh > 0) st.freeRefresh--;
    st.nozdormuRefreshTurn = s.turn;
  }
  s.turn++;
  // Permanent increases also raise income before the normal ten-gold turn.
  const income = Math.min(10, s.turn + 2) + (st.maxGold - 10);
  s.gold = Math.min(st.maxGold, income + st.nextGold);
  st.nextGold = 0;
  st.temporaryGoldCap = undefined;
  s.upgrade = Math.max(0, s.upgrade - 1);
  s.powerUsed = false;
  st.heroPowerUsesTurn = 0;
  for (const progress of Object.values(st.powerProgress || {})) progress.turnUses = 0;
  s.powerUsed = seasonPowerState(s).used;
  s.phase = "recruit";
  s.battle = null;
  if (st.powerCycle) offerPowers(s, "nguyen", rng);
  else if (hasPower(s, "genn") && s.turn >= 4) offerPowers(s, "genn", rng);
  startEffects(s, rng);
  refill(s, rng, s.frozen, true, false);
  s.frozen = false;
  settleTrinkets(s, rng);
}
export function releasePlayerCards(s: Game) {
  for (const m of [...s.board, ...s.hand, ...s.shop, ...s.discovery, ...(ss(s).pendingTrinketCards || []), ...[ss(s).activeDiscovery?.creationPart, ...ss(s).pendingDiscoveries.map((r) => r.creationPart)].filter((m): m is Minion => !!m)])
    release(s, m);
  s.board = [];
  s.hand = [];
  s.shop = [];
  s.discovery = [];
  s.rewards = [];
  ss(s).spellShop = [];
  ss(s).pendingTrinketCards = [];
  ss(s).activeDiscovery = undefined;
  ss(s).pendingDiscoveries = [];
}
