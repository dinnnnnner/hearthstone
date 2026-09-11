import { recordsFrames, recordsLogs } from "../simulation";
import { recordScoutRound, warbandLabel } from "../scouting";
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
} from "../engine";
import {
  SEASON_CARDS,
  SEASON_HEROES,
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
export interface SeasonState {
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
  patch: "36.4.2";
  armor: number;
  tribes: Tribe[];
  spellShop: Minion[];
  initialPool: Record<string, number>;
  freeRefresh: number;
  nozdormuRefreshTurn?: number;
  nextGold: number;
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
export const TRINKETS = RAW_TRINKETS.filter((t) =>
  [
    "200",
    "202",
    "203",
    "205",
    "212",
    "213",
    "214",
    "215",
    "220",
    "300",
    "302",
    "302t",
    "307",
    "361",
    "372",
    "373",
    "390",
    "800",
    "801",
    "811",
    "812",
    "830",
    "840",
  ].some((n) => t.id === "BG36_MagicItem_" + n),
);
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
  m.gift === "BG36_MidGameEffect_000t22";
const ability = (m: Minion, event?: string) =>
  [...(getDef(m.id).abilities || []).filter((a) => !m.counters?.chosenSpell || a.event !== "cast"), ...(m.extraAbilities || [])].filter(
    (a) => !event || a.event === event,
  );
const has = (m: Minion, op: string) => ability(m).some((a) => a.op === op);
const trinket = (s: Game, n: string) =>
  ss(s).trinkets.includes("BG36_MagicItem_" + n);
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
  s.gold = Math.min(ss(s).maxGold, s.gold + n);
};
function putHand(s: Game, m: Minion) {
  if (!mcount(m, "enteredTurn")) (m.counters ??= {}).enteredTurn = s.turn;
  if (room(s)) s.hand.push(m);
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
    d.id !== PREFIX + "BG31_819" || ss(s).tribes.includes("元素"),
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
function syncCardStats(s: Game, m: Minion) {
  if (has(m, "alwaysGolden")) makeGolden(m);
  for (const a of ability(m).filter((a) => a.op === "globalStats")) {
    const key = a.key!;
    const total = key === "tavernSpells" ? ss(s).spellsCast : key === "goldenPlayed" ? ss(s).goldenPlayed : count(s, key);
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
  for (const m of new Set([...board, ...s.board, ...s.hand, ...s.shop])) syncCardStats(s, m);
}
function gain(ctx: Context, m: Minion, attack: number, health: number) {
  if (tribe(m, "元素")) {
    const bonus = delta(ctx.s, "elementalGrant");
    attack += bonus.attack; health += bonus.health;
  }
  addStats(m, attack, health);
  syncCardStats(ctx.s, m);
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
  if (hasPower(s, "aranna") && powerCount(s, "aranna", "attacks") >= 14 && !(ss(s).boughtTurn || []).length) return 0;
  if (hasPower(s, "sindragosa")) return 2;
  return trinket(s, "202") &&
    ss(s).trinketBuys < 2 &&
    ability(m, "battlecry").length
    ? 0
    : hasPower(s, "millhouse") ? 2 : 3;
}
export function spellCost(s: Game, m: Minion) {
  if (hasPower(s, "taethelan") && powerCount(s, "taethelan", "boughtSpells") % 3 === 2) return 0;
  return Math.max(0, (getDef(m.id).cost || 0) - ss(s).spellDiscount);
}
export const spellUsesHealth = (m: Minion) => has(m, "healthCost");
export function seasonPowerState(s: Game, id = equippedPowers(s)[0]) {
  const h = powerDefinition(s, id) || powerDefinition(s);
  const key = h.id.slice(4), progress = powerProgress(s, h.id);
  const limit = ["blackthorn", "inge", "malygos"].includes(key) ? 2 : 1;
  const spent = progress.turnUses;
  const exhausted = (["reno", "zerek", "kragg"].includes(key) && progress.uses > 0) || (key === "zephrys" && progress.uses >= 3);
  const remaining = exhausted ? 0 : Math.max(0, limit - spent);
  const cost = Math.max(0, h.cost + (key === "elise" ? progress.uses : 0) -
    (["togwaggle", "nobundo"].includes(key) ? count(s, key + "Discount") : key === "patches" ? count(s, "patchesDiscount") : 0));
  const needsTarget = ["lich", "george", "xyrella", "reno", "inge"].includes(key) || boardPowerTargets.has(key) || shopPowerTargets.has(key) || mixedPowerTargets.has(key);
  let targets = key === "xyrella" ? s.shop : key === "reno" ? s.board : [...s.board, ...s.shop];
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
function refill(s: Game, rng: () => number, keep = false, keepSelected = false) {
  if (!keep) {
    const frozen = keepSelected ? ss(s).frozenMinions || [] : [];
    s.shop.filter((m) => !frozen.includes(m.uid)).forEach((m) => release(s, m));
    s.shop = s.shop.filter((m) => frozen.includes(m.uid));
    ss(s).spellShop = [];
  }
  ss(s).frozenMinions = [];
  while (s.shop.length < SHOP_SIZE[s.tier] - (hasPower(s, "sindragosa") ? 1 : 0)) {
    const m = draw(s, rng);
    if (!m) break;
    applyShop(s, m);
    s.shop.push(m);
  }
  if (!ss(s).spellShop.length) {
    const m = drawSpell(s, rng);
    if (m) ss(s).spellShop = [m];
  }
  if (ss(s).fodder > 0) {
    ss(s).fodder--;
    const d = pick(
      s.board.filter((m) => tribe(m, "恶魔")),
      rng,
    );
    if (d) {
      addStats(d, 2, 2);
      log(s, `${getDef(d.id).name}吞食恶魔饲料，获得+2/+2。`);
    }
  }
  const growth = delta(s, "refresh");
  const t = pick(s.shop, rng);
  if (t) addStats(t, growth.attack, growth.health);
  if (trinket(s, "300")) s.upgrade = Math.max(0, s.upgrade - 1);
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
      const card = makeMinion(id, request.source?.golden, request.kind === "cookie");
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
  shared?: { tribes: Tribe[]; pool?: Record<string, number> },
): Game {
  const hero = SEASON_HEROES.find((h) => h.id === heroId) || SEASON_HEROES[0];
  const types = shared
    ? [...shared.tribes]
    : shuffled(ALL_TRIBES, rng).slice(0, 5);
  const required = HERO_TRIBES[hero.id];
  if (!shared && required && !types.includes(required)) types[0] = required;
  const defs = SEASON_CARDS.filter((d) => available(d, types));
  const initialPool = Object.fromEntries(
    defs.map((d) => [d.id, POOL_COPIES[d.tier]]),
  );
  const pool = { ...(shared?.pool || initialPool) };
  const opponents = shuffled(
    SEASON_HEROES.filter((h) => h.id !== hero.id),
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
    logs: ["第14赛季 · 36.4.2练习场。每局随机开放5个随从类型。"],
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
      patch: "36.4.2",
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
  refill(s, rng);
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
    const copiesNeeded = hasPower(s, "clockwork") ? 2 : 3;
    const group = all.find((m) => all.filter((n) => n.id === m.id).length >= copiesNeeded) ||
      all.find((m) => !has(m, "elementalWildcard") && tribe(m, "元素") && all.filter((n) => n.id === m.id).length + wildcards.length >= copiesNeeded);
    if (!group) break;
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
    g.keywords = [...new Set(parts.flatMap((m) => m.keywords))];
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
  const a = ability(m, event).find((a) => a.target === "selected" || a.target === "selectedShop");
  if (!a) return [];
  if (a.target === "selectedShop") return [...s.shop, ...ss(s).spellShop];
  let ts = [
    ...s.board,
    ...(event === "cast" && !["consume", "butchering", "sellTransfer"].includes(a.op) ? [...s.shop] : []),
  ].filter((x) => x.uid !== m.uid);
  if (a.tribe) ts = ts.filter((x) => tribe(x, a.tribe!));
  if (["battlecry", "rally"].includes(a.op))
    ts = ts.filter((x) => ability(x, a.op).length > 0);
  if (a.op === "golden") ts = ts.filter((x) => s.board.includes(x) && !x.golden && getDef(x.id).tier <= (a.tier || 6));
  if (a.op === "buffType") ts = ts.filter((x) => ALL_TRIBES.some((t) => tribe(x, t)));
  if (["tribeShop", "tribeRefresh"].includes(a.op)) ts = ts.filter((x) => ALL_TRIBES.some((t) => tribe(x, t)));
  if (a.op === "evolve") ts = ts.filter((x) => getDef(x.id).tier < 6);
  if (a.op === "sellTransfer") ts = ts.filter((x) => s.board.some((other) => other.uid !== x.uid && (a.key !== "elemental" || tribe(other, "元素"))));
  return ts;
}
interface Context {
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
  damage?: (target: Minion, amount: number, source?: Minion) => void;
  killer?: Minion;
  amount?: number;
  fromHand?: boolean;
  permanentSpell?: boolean;
  pendingSummons?: Minion[];
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
  if (key === "undead")
    for (const m of [
      ...new Set([
        ...board,
        ...(board !== s.board ? s.board : []),
        ...s.hand,
        ...s.shop,
      ]),
    ])
      if (tribe(m, "亡灵")) addStats(m, a, h);
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
    const armor = Math.min(ss(s).armor, n);
    ss(s).armor -= armor;
    s.health -= n - armor;
  }
  for (const m of [...ctx.board]) run({ ...ctx, amount: n }, m, "heroDamage");
}
function run(ctx: Context, m: Minion, event: string) {
  if ((ctx.depth || 0) > 12) return;
  for (const a of ability(m, event))
    effect({ ...ctx, depth: (ctx.depth || 0) + 1 }, m, a);
}
function makeGolden(m: Minion) {
  if (m.golden) return;
  const d = getDef(m.id);
  addStats(m, (d.goldenAttack ?? d.attack * 2) - d.attack, (d.goldenHealth ?? d.health * 2) - d.health);
  m.golden = true;
  // A transformation retains its original pool copies and awards no triple reward.
}
function effect(ctx: Context, m: Minion, a: Ability) {
  const { s, rng } = ctx,
    f = m.golden && !a.noScale ? 2 : 1,
    n = (a.amount ?? 1) * f;
  const targets = () => buffTargets(ctx, m, a);
  switch (a.op) {
    case "deathStats":
      for (const x of targets()) gain(ctx, x, m.attack, mcount(m, "deathStatsHealth"));
      break;
    case "buff": {
      let attack = (a.attack || 0) * f,
        health = (a.health || 0) * f;
      if (a.event === "cast" && tavernSpellIds.has(m.id) && !m.tempSpell && !m.expires) {
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
          const count = new Set(
            ctx.board.flatMap((x) => getDef(x.id).races || []),
          ).size;
          attack += count;
          health += count * 2;
        }
      }
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
      const b = delta(s, "gem"),
        attack = (1 + b.attack) * n,
        health = (1 + b.health) * n;
      for (const t of targets()) {
        gain(ctx, t, attack, health);
        t.gems = {
          attack: (t.gems?.attack || 0) + attack,
          health: (t.gems?.health || 0) + health,
        };
        if (ctx.combat && a.permanent) ctx.permanent?.(t, attack, health);
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
      scale(s, a.key!, (a.attack || 0) * f, (a.health || 0) * f, ctx.board);
      break;
    case "goldNext":
      ss(s).nextGold += n;
      break;
    case "gold":
      gold(s, n);
      break;
    case "goldCap":
      ss(s).maxGold += n;
      break;
    case "armor":
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
          else putHand(s, card);
        }
      }
      break;
    case "randomSpell":
      for (let i = 0; i < n; i++) {
        const card = drawSpell(s, rng, (d) =>
          a.cost !== undefined ? d.cost === a.cost : d.tier <= s.tier,
        );
        if (card) putHand(s, card);
      }
      break;
    case "generate":
      for (let i = 0; i < n; i++) {
        if (getDef(PREFIX + a.id)) putHand(s, makeMinion(PREFIX + a.id));
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
        if (c) putHand(s, c);
      }
      break;
    case "replacePower":
      offerPowers(s, "replace", rng);
      break;
    case "discoverMinion":
      for (let i = 0; i < n; i++) queueDiscover(s, "minion", {
        ...(a.tier || a.key === "currentTier" ? { tiers: [a.tier || s.tier] } : {}), mechanic: a.key === "currentTier" ? undefined : a.key, tribe: a.tribe,
      });
      break;
    case "majorityDiscover":
    case "majorityDraw": {
      const counts = ALL_TRIBES.map((t) => ({ t, count: ctx.board.filter((x) => tribe(x, t)).length }));
      const max = Math.max(...counts.map((x) => x.count));
      const t = max ? pick(counts.filter((x) => x.count === max), rng)?.t : undefined;
      if (a.op === "majorityDiscover") queueDiscover(s, "minion", { tribe: t });
      else {
        const card = draw(s, rng, (d) => d.tier <= s.tier && (!t || d.races?.includes(t) || d.tribe === "全部"));
        if (card) putHand(s, card);
      }
      break;
    }
    case "drawId": {
      const card = draw(s, rng, (d) => d.id === PREFIX + a.id);
      if (card) putHand(s, card);
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
      if (target) makeGolden(target);
      break;
    }
    case "discoverSpell":
      for (let i = 0; i < n; i++) queueDiscover(s, "spell", a.key === "currentTier" ? { tiers: [s.tier] } : {});
      break;
    case "steal":
    case "stealHighest": {
      const t =
        a.op === "stealHighest"
          ? [...s.shop].sort((a, b) => b.attack - a.attack)[0]
          : pick(s.shop, rng);
      if (t) {
        s.shop = s.shop.filter((x) => x.uid !== t.uid);
        putHand(s, t);
      }
      break;
    }
    case "consume":
      for (const eater of targets())
        for (let i = 0; i < (a.amount || 1) * f; i++) {
          const t = a.highest
            ? [...s.shop].sort((a, b) => b.health - a.health)[0]
            : pick(s.shop, rng);
          if (t) {
            s.shop = s.shop.filter((x) => x.uid !== t.uid);
            gain(ctx, eater, t.attack, t.health);
            if (a.keywords || trinket(s, "801"))
              t.keywords.forEach((k) => keyword(eater, k));
            if (trinket(s, "801")) addStats(eater, 5, 5);
            release(s, t);
          }
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
      else addStats(m, 0, (a.health || 0) * f);
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
        putHand(s, c);
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
  bump(ctx.s, "soldMinions");
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
function spellcraftCard(ctx: Context, source: Minion, a: Ability) {
  const id = PREFIX + getDef(source.id).sourceId + "t";
  if (!getDef(id)) return;
  const card = makeMinion(id, source.golden);
  card.expires = true;
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
      if (a.key === "copy") putHand(s, makeMinion(target.id)); else queueDiscover(s, "minion", { tribe: "亡灵" });
    } break;
    case "discoverMagnetize": if (target) for (let i = 0; i < f; i++) queueDiscover(s, "minion", { tribe: "机械", magnetizeTarget: target.uid }); break;
    case "summonRemembered": if (ctx.combat) for (const uid of m.remembered || []) {
      const card = s.hand.find((x) => x.uid === uid);
      if (card) { const copy = clone(card); copy.uid = makeMinion(card.id).uid; copy.copies = {}; ctx.summon?.(copy, ctx.sourcePos ?? ctx.board.length); }
    } break;
    case "growDragonBuff": mbump(m, "dragonBuff", f); break;
    case "dragonCombatBuff": for (const x of ctx.board.filter((x) => tribe(x, "龙"))) gain(ctx, x, 2 * f + mcount(m, "dragonBuff"), 2 * f + mcount(m, "dragonBuff")); break;
    case "bounty": for (let i = 0; i < f; i++) putHand(s, makeMinion(PREFIX + pick(["BG33_811", "BG33_812", "BG33_813", "BG33_814", "BG33_815"], rng))); break;
    case "chromadrake": for (let i = 0; i < f; i++) putHand(s, makeMinion(PREFIX + pick(["BG34_634t", "BG34_635t", "BG34_636t", "BG34_637t", "BG34_638t"], rng))); break;
    case "learnSpell": if (ctx.eventMinion && mcount(m, "learn:" + s.turn) < f) {
      mbump(m, "learn:" + s.turn);
      const c = makeMinion(PREFIX + "BG33_890t"); c.attack = c.health = 1; c.learnedSpell = ctx.eventMinion.id;
      c.extraAbilities = [{ event: "battlecry", op: "castTavern", id: ctx.eventMinion.id.slice(4) }]; putHand(s, c);
    } break;
    case "growingBeast": if (ctx.eventMinion) {
      const amount = 3 * f + mcount(m, "beastGrowth");
      gain(ctx, ctx.eventMinion, amount, 0); mbump(m, "beastGrowth", f); ctx.remember?.(m, "beastGrowth", f);
    } break;
    case "lockbox": for (let i = 0; i < f; i++) {
      const chest = s.hand.find((x) => x.id === PREFIX + "BG36_520t");
      if (chest) { chest.lockedUntil = (chest.lockedUntil || s.turn + 5) - 1; openLockboxes(ctx); }
      else { const c = makeMinion(PREFIX + "BG36_520t"); c.lockedUntil = s.turn + 5; putHand(s, c); }
    } break;
    case "fishbaitRefresh": refill(s, rng); fishbait(ctx, m, s.shop[0], f); break;
    case "fishbait": fishbait(ctx, m, target, f); break;
    case "kangor": for (const dead of (ctx.deadMechs || []).slice(0, 2 * f)) {
      const c = makeMinion(dead.id, dead.golden); applyGlobal(s, c); ctx.summon?.(c, ctx.sourcePos ?? ctx.board.length);
    } break;
    case "choose": {
      const source = clone(m); source.copies = {};
      const provider = ctx.board.find((x) => has(x, "bothChoices") && mcount(x, "choiceTurn") !== s.turn);
      const both = !!(m.bothChoices || provider);
      if (provider) (provider.counters ??= {}).choiceTurn = s.turn;
      queueDiscover(s, "choose", { options: [PREFIX + a.id + "t", PREFIX + a.id + "t2"], source, both });
      break;
    }
    case "combatEffect": (st.combatEffects ??= {})[a.key!] = (st.combatEffects?.[a.key!] || 0) + n; break;
    case "delayedBuff": (st.delayed ??= []).push({ turn: s.turn + 1, attack: (a.attack || 0) * f, health: (a.health || 0) * f, amount: a.amount || 1 }); break;
    case "winnerBuff": if (target) (st.delayed ??= []).push({ turn: s.turn + 1, uid: target.uid, win: true, attack: 4, health: 6, amount: 1 }); break;
    case "murlocPair": {
      const card = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("鱼人") === true || d.tribe === "全部"));
      if (card) { putHand(s, card); putHand(s, makeMinion(card.id)); }
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
    case "lockedDiscover": queueDiscover(s, "minion", { tiers: [s.tier], lockedUntil: s.turn + 1 }); break;
    case "doomedDiscover": queueDiscover(s, "minion", { tribe: "亡灵", doomedTurn: s.turn }); break;
    case "discoverDemonDamage": for (let i = 0; i < n; i++) queueDiscover(s, "minion", { tribe: "恶魔", damage: true }); break;
    case "discoverChoice": queueDiscover(s, "chooseCard", { bothChoices: true }); break;
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
    case "randomSpellcraft":
      for (let i = 0; i < n; i++) {
        const d = pick(poolCards(s).filter((d) => d.abilities?.some((a) => a.event === "spellcraft")), rng);
        if (d) run({ ...ctx, fromHand: false }, makeMinion(d.id), "spellcraft");
      }
      break;
    case "randomStatsSpell":
      for (let i = 0; i < n; i++) { const c = drawSpell(s, rng, (d) => d.tier <= s.tier && d.abilities?.some((a) => ["buff", "buffType", "nagaRepeatedBuff"].includes(a.op)) === true); if (c) putHand(s, c); }
      break;
    case "craftProgress": case "craftNaga": case "craftStatsSpell": {
      if (!mcount(m, "enteredTurn")) (m.counters ??= {}).enteredTurn = s.turn;
      const card = spellcraftCard(ctx, m, a); if (card) putHand(s, card); break;
    }
    case "randomChoice":
      for (let i = 0; i < n; i++) {
        const d = pick(choiceCards(s), rng);
        const card = d && (d.kind === "spell" ? makeMinion(d.id) : draw(s, rng, (x) => x.id === d.id));
        if (card) putHand(s, card);
      } break;
    case "lossGold": if (s.battles[0]?.result === "loss") gold(s, a.amount || 4); break;
    case "scoutDiscover": for (let i = 0; i < f; i++) queueDiscover(s, "minion", { tiers: [Math.min(6, 1 + s.turn - (mcount(m, "enteredTurn") || s.turn))] }); break;
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
        if (a.key === "butchering" || a.key === "pastry") for (let j = 0; j < f; j++) putHand(s, makeMinion(PREFIX + (a.key === "butchering" ? "BG28_604" : "BG28_607")));
        if (a.key === "rideWinds") for (let j = 0; j < f; j++) castSpell({ ...ctx, target: undefined, fromHand: false }, makeMinion(PREFIX + "BG34_444"));
        if (a.key === "bounty" || a.key === "lockbox") expandedEffect(ctx, m, { event: a.event, op: a.key });
        if (a.key === "undeadHand") for (let j = 0; j < f; j++) {
          const c = draw(s, rng, (d) => d.tier <= s.tier && (d.races?.includes("亡灵") === true || d.tribe === "全部"));
          if (c) { putHand(s, c); (m.remembered ??= []).push(c.uid); }
        }
      }
      break;
    }
    case "spellProgressBuff": {
      const progress = Math.floor(count(s, "allSpells") / 3);
      for (const x of buffTargets(ctx, m, a)) gain(ctx, x, ((a.attack || 0) + progress) * f, ((a.health || 0) + progress) * f); break;
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
    case "lastSpell": if (st.lastSpell) for (let i = 0; i < f; i++) putHand(s, makeMinion(st.lastSpell)); break;
    case "morglton": {
      const value = 3 + count(s, "morglton");
      for (const x of buffTargets(ctx, m, a)) gain(ctx, x, a.attack ? value * f : 0, a.health ? value * f : 0); break;
    }
    case "morgltonParent": for (let i = 0; i < f; i++) putHand(s, makeMinion(PREFIX + (rng() < 0.5 ? "BG35_140" : "BG35_141"))); break;
    case "armPurchase": (m.counters ??= {}).purchaseArmed = f; break;
    case "armMagnetic": (m.counters ??= {}).magneticArmed = m.golden ? 3 : 2; break;
    case "rallyDeathrattle": {
      if (!ctx.eventMinion || !ability(ctx.eventMinion, "rally").length) break;
      const left = ctx.board.find((x) => x.health > 0 && ability(x, "death").length);
      if (left) for (let i = 0; i < f; i++) death({ ...ctx, sourcePos: ctx.board.indexOf(left) }, left); break;
    }
    case "goldenFour": for (let i = 0; i < f; i++) {
      const d = pick(poolCards(s).filter((d) => d.tier === 4), rng); if (d) putHand(s, makeMinion(d.id, true));
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
      if (total >= 35) for (let i = 0; i < f; i++) putHand(s, makeMinion(PREFIX + "BG28_830"));
      break;
    }
    case "satelliteGrowing": {
      const value = 2 + mcount(m, "satelliteSize");
      if (ctx.eventMinion) { gain(ctx, ctx.eventMinion, value * f, value * f); ctx.eventMinion.magneticCount = (ctx.eventMinion.magneticCount || 0) + 1; }
      mbump(m, "satelliteSize"); break;
    }
    case "satellite": for (const x of buffTargets(ctx, m, a)) { gain(ctx, x, (a.attack || 0) * f, (a.health || 0) * f); x.magneticCount = (x.magneticCount || 0) + 1; } break;
    case "magneticGrowth": for (const x of ctx.board) for (let i = 0; i < (x.magneticCount || 0); i++) gain(ctx, x, (a.attack || 0) * f, (a.health || 0) * f); break;
    case "murlocDiscover": if (ctx.board.some((x) => x.uid !== m.uid && tribe(x, "鱼人"))) for (let i = 0; i < f; i++) queueDiscover(s, "minion", { tribe: "鱼人" }); break;
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
        .filter((x) => x.uid !== m.uid && has(x, "brann"))
        .map((x) => (x.golden ? 3 : 2)),
    ) + (trinket(ctx.s, "215") && tribe(m, "龙") ? 1 : 0);
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
          addStats(t!, 5, 5);
    }
  }
}
function notifySummon(ctx: Context, m: Minion) {
  if (ctx.combat && hasPower(ctx.s, "greybough")) { gain(ctx, m, 1, 2); keyword(m, "嘲讽"); }
  if (m.id === PREFIX + "BG_TTN_401") {
    bump(ctx.s, "automatonSummons"); mbump(m, "automatonSelf"); syncStats(ctx.s, ctx.board);
  }
  for (const x of [...ctx.board])
    if (x.uid !== m.uid) {
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
  if (hasPower(ctx.s, "daryl")) { gain(ctx, m, 1, 1); mbump(m, "hats"); }
  if (hasPower(ctx.s, "clockwork") && m.golden) putHand(ctx.s, makeMinion(PREFIX + "BG28_810"));
  if (["BG35_140", "BG35_141", "BG35_142"].includes(getDef(m.id).sourceId!)) bump(ctx.s, "morglton");
  for (const x of [...ctx.board]) {
    if (x.uid !== m.uid) {
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
}
function castSpell(ctx: Context, m: Minion) {
  const { s } = ctx;
  if ((ctx.depth || 0) > 12) return;
  // Choose One resolves only after a player selects an option, including repeats.
  if (ability(m, "cast").some((a) => a.op === "choose")) { run(ctx, m, "cast"); return; }
  const targeted = ability(m, "cast").some((a) => a.target === "selected");
  if (targeted && !ctx.target) ctx = { ...ctx, target: pick(seasonTargets(s, m, "cast"), ctx.rng) };
  if (targeted && !ctx.target) return;
  const friendly = !!ctx.target && ctx.board.includes(ctx.target);
  const bounty = /^s14_BG33_81[1-5]$/.test(m.id);
  const repeats = Math.max(1,
    ...(friendly ? ctx.board.filter((x) => has(x, "repeatFriendlySpell")) : []).map((x) => x.golden ? 3 : 2),
    ...(bounty ? ctx.board.filter((x) => has(x, "repeatBounty")) : []).map((x) => x.golden ? 3 : 2));
  const targetUid = ctx.target?.uid;
  const craft = !!m.expires && getDef(m.id).kind === "spell";
  let permanent = false;
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
  if (ctx.fromHand) for (const x of [...ctx.board]) run({ ...ctx, eventMinion: m }, x, "cardPlayed");
}
function castChosenSpell(ctx: Context, m: Minion) {
  (m.counters ??= {}).chosenSpell = 1;
  castSpell(ctx, m);
}
function castSpellOnce(ctx: Context, m: Minion) {
  const { s } = ctx;
  run(ctx, m, "cast");
  bump(s, "allSpells");
  if (!m.tempSpell && tavernSpellIds.has(m.id)) {
    ss(s).spellsCast++;
    ss(s).lastSpell = m.id;
    for (const x of [...ctx.board])
      run(
        { ...ctx, depth: (ctx.depth || 0) + 1, eventMinion: ctx.target },
        x,
        "tavernSpell",
      );
    if (trinket(s, "800")) scale(s, "shop", 1, 1);
    if (trinket(s, "830")) ss(s).fodder++;
  }
  for (const x of [...ctx.board]) run({ ...ctx, depth: (ctx.depth || 0) + 1 }, x, "anySpell");
  if (ctx.target) {
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
      if (n % 3 === 0) gold(s, 1);
    }
  }
  for (const x of [...ctx.board]) giftEvent(ctx, x, "play");
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
    m.gift = gift.id;
    m.giftTurn = s.turn;
    const n = giftNumber(gift.id);
    if (n === "73") addStats(m, 5, 5);
    if (n === "4") addStats(m, 4, 4);
    if (n === "72") m.attack += 1000;
    if (n === "13") {
      keyword(m, "圣盾");
      keyword(m, "风怒");
    }
    if (n === "69") keyword(m, "烈毒");
    if (n === "14") {
      const d = getDef(m.id);
      m.attack += d.attack;
      m.health += d.health;
      m.golden = true;
    }
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
  const count =
    1 +
    ctx.board
      .filter((x) => x.health > 0 && has(x, "titus"))
      .reduce((n, x) => n + (x.golden ? 2 : 1), 0);
  for (let i = 0; i < count; i++) {
    run(ctx, m, "death");
    giftEvent(ctx, m, "death");
    if (ability(m, "death").length) { bump(ctx.s, "deathrattles"); syncStats(ctx.s, ctx.board); }
  }
}
export function endEffects(s: Game, rng: () => number) {
  const ctx = { s, board: s.board, rng };
  const count = Math.max(
    1,
    ...s.board.filter((m) => has(m, "drakkari")).map((m) => (m.golden ? 3 : 2)),
  );
  for (let i = 0; i < count; i++) {
    heroEnd(ctx);
    for (const m of [...s.board]) {
      run(ctx, m, "end");
      giftEvent(ctx, m, "end");
    }
    if (trinket(s, "302") || trinket(s, "302t"))
      for (const m of s.board)
        addStats(
          m,
          (trinket(s, "302t") ? 4 : 1) + ss(s).goldenPlayed,
          (trinket(s, "302t") ? 2 : 1) + ss(s).goldenPlayed,
        );
    if (trinket(s, "212"))
      for (const m of s.board
        .filter((m) => ability(m, "death").length)
        .slice(0, 2))
        death(ctx, m);
    if (trinket(s, "214")) for (const m of [...s.board]) run(ctx, m, "rally");
    if (trinket(s, "812")) {
      const m = s.board.find((m) => tribe(m, "机械"));
      if (m) castSpell({ ...ctx, target: m }, makeMinion(PREFIX + "BG36_624"));
    }
    if (trinket(s, "372") && ss(s).lastSpell)
      for (let j = 0; j < 3; j++) putHand(s, makeMinion(ss(s).lastSpell!));
  }
  s.hand = s.hand.filter((m) => {
    if (m.expires) {
      release(s, m);
      return false;
    }
    return true;
  });
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
  if (trinket(s, "220"))
    gold(s, new Set(s.board.flatMap((m) => getDef(m.id).races || [])).size);
  if (trinket(s, "390"))
    putHand(s, makeMinion(PREFIX + (rng() < 0.5 ? "BG31_816" : "BG31_818")));
  if (([6, 9].includes(s.turn) || hasPower(s, "marin") && s.turn === 5 || hasPower(s, "buttons") && s.turn === 8) && !ss(s).trinketDone.includes(s.turn)) {
    const school = s.turn <= 6 ? "LESSER_TRINKET" : "GREATER_TRINKET";
    ss(s).trinketOffers = shuffled(
      TRINKETS.filter((t) => t.school === school),
      rng,
    )
      .slice(0, 4)
      .map((t) => t.id);
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
    const insertion = Math.max(0, Math.min(pos, boards[side].length));
    boards[side].splice(insertion, 0, m);
    // Keep removed minions' slots aligned as earlier deathrattles fill spaces.
    for (const slot of deathPositions)
      if (slot.side === side && slot.pos >= insertion) slot.pos++;
    notifySummon(contexts[side], m);
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
      remember: (m, key, amount) => { const orig = originals[side].get(m.uid); if (orig) mbump(orig, key, amount); },
      summon: (m, pos) => summon(side, m, pos),
      permanent: (m, a, h) => {
        if (side === 0 || other) {
          const orig = originals[side].get(m.uid);
          if (orig && !retained.has(m)) addStats(orig, a, h);
        }
      },
    });
  for (let side = 0; side < 2; side++)
    for (const m of boards[side]) {
      if (m.rebornNext) keyword(m, "复生");
      const original = originals[side].get(m.uid);
      if (has(m, "keep") && original)
        retained.set(m, { original, factor: m.golden ? 2 : 1 });
      if (original && tribe(m, "龙")) {
        const i = boards[side].indexOf(m);
        const poets = [boards[side][i - 1], boards[side][i + 1]].filter((x) => x && has(x, "keepAdjacentDragons"));
        if (poets.length) retained.set(m, { original, factor: Math.max(retained.get(m)?.factor || 1, ...poets.map((x) => x.golden ? 2 : 1)) });
      }
    }
  const damage = (target: Minion, amount: number, source?: Minion) => {
    if (amount <= 0) return;
    if (target.keywords.includes("圣盾")) {
      target.keywords = target.keywords.filter((k) => k !== "圣盾");
      return;
    }
    const actual = Math.min(Math.max(0, target.health), amount);
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
        run({ ...contexts[side], amount: actual, target }, source, "dealtDamage");
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
        ss(ctx.s).deaths++;
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
        death({
          ...ctx,
          sourcePos: slot.pos,
          killer: killers.get(m.uid),
          // The source has left the board: insert at its slot, then advance
          // through its summons, including additional deathrattle triggers.
          summon: (card) => summon(side, card, slot.pos),
        }, m);
        for (const x of [...boards[side]].filter((x) => x.health > 0)) run({ ...ctx, eventMinion: m }, x, "friendlyDeath");
        if (m.keywords.includes("复生")) {
          const revived = makeMinion(m.id, m.golden);
          applyGlobal(contexts[side].s, revived);
          revived.health = 1;
          revived.keywords = revived.keywords.filter((k) => k !== "复生");
          summon(side, revived, slot.pos);
          for (const x of [...boards[side]].filter((x) => x.health > 0)) run({ ...ctx, eventMinion: revived }, x, "reborn");
          if ((side === 0 || other) && trinket(contexts[side].s, "205"))
            boards[side].forEach((t) => addStats(t, 2, 2));
        }
      }
      deathPositions = [];
      fillSpaces();
    }
  };
  const fillSpaces = () => {
    for (let side = 0; side < 2; side++) {
      const ctx = contexts[side];
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
    last[side] = attacker.uid;
    index[side] = board.indexOf(attacker);
    const swings = attacker.keywords.includes("风怒") ? 2 : 1;
    for (
      let hit = 0;
      hit < swings && attacker.health > 0 && boards[1 - side].length;
      hit++
    ) {
      const attack = attacker;
      bump(ctx.s, "heroAttacks"); countPowerEvent(ctx.s, "attacks");
      if (hasPower(ctx.s, "lo") && powerCount(ctx.s, "lo", "attacks") % 15 === 0) reward(ctx.s);
      let enemy = boards[1 - side].filter((m) => !m.keywords.includes("潜行"));
      if (!enemy.length) enemy = boards[1 - side];
      const taunts = enemy.filter((m) => m.keywords.includes("嘲讽"));
      const target = pick(taunts.length ? taunts : enemy, rng)!;
      run(
        { ...ctx, target, sourcePos: board.indexOf(attack) },
        attack,
        "rally",
      );
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
        ss(ctx.s).freeRefresh++;
      const neighbors = has(attack, "cleave")
        ? [
            boards[1 - side][boards[1 - side].indexOf(target) - 1],
            boards[1 - side][boards[1 - side].indexOf(target) + 1],
          ].filter(Boolean)
        : [];
      const a = attack.attack,
        t = target.attack;
      const targetHealth = target.health, shielded = target.keywords.includes("圣盾");
      damage(target, a, attack);
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
    side = 1 - side;
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
      const ids = choice.mode === "replace"
        ? [action.uid, ...equippedPowers(s).slice(1)] : choice.selected;
      equipPowers(s, ids);
      st.powerChoice = undefined;
      if (choice.mode === "nguyen") heroStart({ s, board: s.board, rng });
      if (choice.mode === "replace") st.powerCycle = false;
      if (choice.mode !== "replace") startPowerEffects(s, rng);
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
      if (s.gold < cost) return fail(`招募需要${cost}枚金币。`);
      if (!room(s)) return fail("手牌已满。");
      if (cost === 0) st.trinketBuys++;
      s.shop = s.shop.filter((x) => x.uid !== m.uid);
      s.hand.push(m);
      spend(ctx, cost);
      s.purchases++;
      heroPurchased(ctx, m);
      for (const x of [...s.board]) if (mcount(x, "purchaseArmed")) {
        const copies = mcount(x, "purchaseArmed");
        gain(ctx, x, m.attack * copies, m.health * copies);
        x.counters!.purchaseArmed = 0;
      }
      if (hasPower(s, "hoggarr") && tribe(m, "海盗")) gold(s, 1);
      if (trinket(s, "840") && tribe(m, "机械")) {
        const spell = drawSpell(s, rng);
        if (spell) putHand(s, spell);
      }
      log(s, `招募了${getDef(m.id).name}。`);
      break;
    }
    case "buySpell": {
      const m = st.spellShop.find((x) => x.uid === action.uid);
      if (!m) return fail("该法术已不在酒馆。");
      const cost = spellCost(s, m);
      if (!has(m, "healthCost") && s.gold < cost) return fail(`购买法术需要${cost}枚金币。`);
      if (!room(s)) return fail("手牌已满。");
      st.spellDiscount = 0;
      st.spellShop = st.spellShop.filter((x) => x.uid !== m.uid);
      putHand(s, m);
      if (has(m, "healthCost")) heroDamage(s, cost, ctx); else spend(ctx, cost);
      for (const x of [...s.board]) run({ ...ctx, eventMinion: m }, x, "buySpell");
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
        target = [...s.board, ...s.shop, ...st.spellShop].find((x) => x.uid === action.target);
      if (action.target && !ts.some((x) => x.uid === action.target))
        return fail("请选择有效的友方目标。");
      if (ts.length && !action.target && !d.magnetic)
        return fail("请选择战吼目标。");
      if (s.board.length >= 7 && !(d.magnetic && target))
        return fail("战場已满，最多7个随从。");
      s.hand = s.hand.filter((x) => x.uid !== m.uid);
      if (m.reward) {
        s.rewards.push(Math.min(6, s.tier + 1));
        m.reward = false;
      }
      if (d.magnetic && target) {
        const magneticFactor = mcount(target, "magneticArmed") || 1;
        gain(ctx, target, m.attack * magneticFactor, m.health * magneticFactor);
        target.magneticCount = (target.magneticCount || 0) + magneticFactor;
        (target.counters ??= {}).magneticArmed = 0;
        m.keywords.forEach((k) => keyword(target, k));
        target.extraAbilities = [
          ...(target.extraAbilities || []),
          ...Array.from({ length: magneticFactor }, () => ability(m)).flat().map((a) => copiedAbility(m, a)),
        ];
        for (const [id, n] of Object.entries(m.copies))
          target.copies[id] = (target.copies[id] || 0) + n;
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
        target = [...s.board, ...s.shop, ...st.spellShop].find((x) => x.uid === action.target);
      if (
        ability(m, "activate").some((a) => a.target === "selected" || a.target === "selectedShop") &&
        (!target || !ts.some((x) => x.uid === target.uid))
      )
        return fail("请选择发动技能的目标。");
      if (has(m, "stealHighest") && (!s.shop.length || !room(s)))
        return fail("酒馆需要随从，且手牌需要空位。");
      spend(ctx, cost);
      m.activated = true;
      run({ ...ctx, target }, m, "activate");
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
      const progress = powerProgress(s, h.id);
      savePowerProgress(s, h.id, { ...progress, uses: progress.uses + 1, turnUses: progress.turnUses + 1 });
      s.powerUsed = seasonPowerState(s).used;
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
      } else {
        m.lockedUntil = request?.lockedUntil;
        m.bothChoices = request?.bothChoices;
        if (request?.doomedTurn) (m.counters ??= {}).doomedTurn = request.doomedTurn;
        const magnet = s.board.find((x) => x.uid === request?.magnetizeTarget);
        if (request?.replaceShop) {
          const index = s.shop.findIndex((x) => x.uid === request.replaceShop);
          if (index >= 0) { release(s, s.shop[index]); s.shop[index] = m; }
          else release(s, m);
        } else if (request?.magnetizeTarget && magnet) {
          gain(ctx, magnet, m.attack, m.health); m.keywords.forEach((k) => keyword(magnet, k));
          magnet.magneticCount = (magnet.magneticCount || 0) + 1;
          magnet.extraAbilities = [...(magnet.extraAbilities || []), ...ability(m).map((a) => copiedAbility(m, a))];
          for (const [id, n] of Object.entries(m.copies)) magnet.copies[id] = (magnet.copies[id] || 0) + n;
        } else putHand(s, m);
        if (request?.damage) heroDamage(s, getDef(m.id).tier, ctx);
        if (giftNumber(m.gift || "") === "11") putHand(s, makeMinion(m.id));
        for (const x of [...ctx.board]) run({ ...ctx, eventMinion: m }, x, "discovered");
        log(s, `发现了${getDef(m.id).name}${m.gift ? "，附带黑暗之赐" : ""}。`);
      }
      break;
    }
    case "buyTrinket": {
      if (!action.uid || !st.trinketOffers.includes(action.uid))
        return fail("请选择本回合的一件饰品。");
      const item = TRINKETS.find((t) => t.id === action.uid)!;
      if (s.gold < item.cost) return fail(`购买饰品需要${item.cost}金币。`);
      spend(ctx, item.cost);
      st.trinkets.push(item.id);
      st.trinketOffers = [];
      if (item.id.endsWith("_390"))
        putHand(
          s,
          makeMinion(PREFIX + (rng() < 0.5 ? "BG31_816" : "BG31_818")),
        );
      log(s, `购入饰品：${item.name}。`);
      break;
    }
    case "end": {
      endEffects(s, rng);
      recruitAI(s, rng);
      for (const rival of s.opponents.filter(o => o.health > 0))
        recordScoutRound(rival, { turn: s.turn, warband: warbandLabel(rival.board) });
      const o = s.opponents[s.nextOpponent];
      if (!o || s.opponents.every((o) => o.health <= 0)) {
        s.phase = "over";
        break;
      }
      const battle = seasonCombat(s, o.board, o.tier, rng);
      recordScoutRound(o, {
        turn: s.turn, warband: o.scouting![0].warband,
        battle: { opponent: "你", result: battle.result === "win" ? "loss" : battle.result === "loss" ? "win" : "tie", damage: battle.damage },
      });
      battle.opponent = o.name;
      s.battle = battle;
      s.battles.unshift({
        turn: s.turn,
        result: battle.result,
        damage: battle.damage,
        name: o.name,
      });
      if (battle.result === "loss") {
        const absorbed = Math.min(st.armor, battle.damage);
        st.armor -= absorbed;
        s.health -= battle.damage - absorbed;
      }
      if (battle.result === "win") {
        const absorbed = Math.min(o.armor || 0, battle.damage);
        o.armor = (o.armor || 0) - absorbed;
        o.health -= battle.damage - absorbed;
        if (o.health <= 0) {
          o.board.forEach((m) => release(s, m));
          o.board = [];
        }
      }
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
  triples(s);
  syncStats(s);
  if (s.phase === "recruit") nextDiscovery(s, rng);
  if (s.health <= 0 && s.phase === "recruit") s.phase = "over";
  return { state: s };
}
export function assertSeasonPool(s: Game) {
  const held = [
    ...s.shop,
    ...s.hand,
    ...s.board,
    ...s.discovery,
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
  refill(s, rng, s.frozen, true);
  s.frozen = false;
  triples(s);
  nextDiscovery(s, rng);
}
export function releasePlayerCards(s: Game) {
  for (const m of [...s.board, ...s.hand, ...s.shop, ...s.discovery])
    release(s, m);
  s.board = [];
  s.hand = [];
  s.shop = [];
  s.discovery = [];
  s.rewards = [];
  ss(s).spellShop = [];
}
