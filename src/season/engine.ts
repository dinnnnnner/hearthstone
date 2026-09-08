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
  SEASON_SPELLS,
  SEASON_CATALOG,
  ALL_TRIBES,
  GIFTS,
  PREFIX,
  RAW_TRINKETS,
} from "./catalog";
export interface SeasonState {
  patch: "36.4.2";
  armor: number;
  tribes: Tribe[];
  spellShop: Minion[];
  initialPool: Record<string, number>;
  freeRefresh: number;
  nextGold: number;
  maxGold: number;
  giftsUsed: number;
  giftUsedTurn: number;
  discoveryKind: string;
  pendingDiscoveries: {
    kind: string;
    tiers?: number[];
    tribe?: string;
    magnetic?: boolean;
  }[];
  trinkets: string[];
  trinketOffers: string[];
  trinketDone: number[];
  buffs: Record<string, { attack: number; health: number }>;
  fodder: number;
  spellDiscount: number;
  healthRefreshes: number;
  playedTurn: number;
  goldenPlayed: number;
  spellsCast: number;
  lastSpell?: string;
  battlecries: number;
  deaths: number;
  trinketBuys: number;
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
  [...(getDef(m.id).abilities || []), ...(m.extraAbilities || [])].filter(
    (a) => !event || a.event === event,
  );
const has = (m: Minion, op: string) => ability(m).some((a) => a.op === op);
const trinket = (s: Game, n: string) =>
  ss(s).trinkets.includes("BG36_MagicItem_" + n);
const log = (s: Game, text: string) => {
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
  const ds = SEASON_SPELLS.filter(filter);
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
  const kept = retained.get(m);
  const factor = kept?.factor || 1;
  m.attack = Math.max(0, m.attack + a * factor);
  m.health += h * factor;
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
}
function applyShop(s: Game, m: Minion) {
  for (const k of [
    "shop",
    ...(tribe(m, "元素") ? ["elementalShop"] : []),
    ...(getDef(m.id).tier <= 3 ? ["lowShop"] : []),
  ]) {
    const b = delta(s, k);
    addStats(m, b.attack, b.health);
  }
}
export function refreshCost(s: Game) {
  return ss(s).freeRefresh > 0 ? 0 : 1;
}
export function minionCost(s: Game, m: Minion) {
  return trinket(s, "202") &&
    ss(s).trinketBuys < 2 &&
    ability(m, "battlecry").length
    ? 0
    : 3;
}
export function spellCost(s: Game, m: Minion) {
  return Math.max(0, (getDef(m.id).cost || 0) - ss(s).spellDiscount);
}
function refill(s: Game, rng: () => number, keep = false) {
  if (!keep) {
    s.shop.forEach((m) => release(s, m));
    s.shop = [];
    ss(s).spellShop = [];
  }
  while (s.shop.length < SHOP_SIZE[s.tier]) {
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
}
function queueDiscover(
  s: Game,
  kind: string,
  opts: { tiers?: number[]; tribe?: string; magnetic?: boolean } = {},
) {
  ss(s).pendingDiscoveries.push({ kind, ...opts });
}
function nextDiscovery(s: Game, rng: () => number) {
  if (s.discovery.length) return;
  const request = ss(s).pendingDiscoveries.shift();
  if (!request) return;
  ss(s).discoveryKind = request.kind;
  for (let i = 0; i < 3; i++) {
    const m =
      request.kind === "spell"
        ? drawSpell(
            s,
            rng,
            (d) => d.tier <= s.tier && !s.discovery.some((m) => m.id === d.id),
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
              !s.discovery.some((m) => m.id === d.id),
          );
    if (m) s.discovery.push(m);
  }
  if (!s.discovery.length) {
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
  if (!shared && hero.id === PREFIX + "millificent" && !types.includes("机械"))
    types[0] = "机械";
  if (!shared && hero.id === PREFIX + "hoggarr" && !types.includes("海盗"))
    types[0] = "海盗";
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
    upgrade: 5,
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
      freeRefresh: hero.id === PREFIX + "nozdormu" ? 1 : 0,
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
      playedTurn: 0,
      goldenPlayed: 0,
      spellsCast: 0,
      battlecries: 0,
      deaths: 0,
      trinketBuys: 0,
    },
  };
  refill(s, rng);
  return s;
}
function triples(s: Game) {
  let guard = 0;
  while (guard++ < 50) {
    const all = [...s.board, ...s.hand].filter(
      (m) => getDef(m.id).kind !== "spell" && !m.golden,
    );
    const group = all.find((m) => all.filter((n) => n.id === m.id).length >= 3);
    if (!group) break;
    const parts = all.filter((m) => m.id === group.id).slice(0, 3);
    const ids = new Set(parts.map((m) => m.uid));
    s.board = s.board.filter((m) => !ids.has(m.uid));
    s.hand = s.hand.filter((m) => !ids.has(m.uid));
    const d = getDef(group.id),
      g = makeMinion(group.id, true);
    g.attack += parts.reduce((n, m) => n + m.attack - d.attack, 0);
    g.health += parts.reduce((n, m) => n + m.health - d.health, 0);
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
    g.reward = true;
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
  const a = ability(m, event).find((a) => a.target === "selected");
  if (!a) return [];
  let ts = [
    ...s.board,
    ...(event === "cast" && a.op !== "consume" ? [...s.shop] : []),
  ].filter((x) => x.uid !== m.uid);
  if (a.tribe) ts = ts.filter((x) => tribe(x, a.tribe!));
  if (a.op === "battlecry")
    ts = ts.filter((x) => ability(x, "battlecry").length > 0);
  return ts;
}
interface Context {
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
  for (const m of [...ctx.board]) run(ctx, m, "heroDamage");
}
function run(ctx: Context, m: Minion, event: string) {
  if ((ctx.depth || 0) > 12) return;
  for (const a of ability(m, event))
    effect({ ...ctx, depth: (ctx.depth || 0) + 1 }, m, a);
}
function effect(ctx: Context, m: Minion, a: Ability) {
  const { s, rng } = ctx,
    f = m.golden && !a.noScale ? 2 : 1,
    n = (a.amount ?? 1) * f;
  const targets = () => buffTargets(ctx, m, a);
  switch (a.op) {
    case "buff": {
      let attack = (a.attack || 0) * f,
        health = (a.health || 0) * f;
      if (a.event === "cast" && getDef(m.id).kind === "spell" && !m.tempSpell) {
        const b = delta(s, "spell");
        attack += b.attack;
        health += b.health;
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
        addStats(t, attack, health);
        if (a.keyword) {
          if (a.toggle && t.keywords.includes(a.keyword))
            t.keywords = t.keywords.filter((k) => k !== a.keyword);
          else keyword(t, a.keyword);
        }
        if (a.permanent && ctx.combat) ctx.permanent?.(t, attack, health);
        if (m.tempSpell) {
          const prior = t.temporary || { attack: 0, health: 0, keywords: [] };
          prior.attack += attack;
          prior.health += health;
          if (a.keyword && !hadKeyword && !prior.keywords.includes(a.keyword))
            prior.keywords.push(a.keyword);
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
        addStats(t, attack, health);
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
    case "discoverSpell":
      queueDiscover(s, "spell");
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
            addStats(eater, t.attack, t.health);
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
      for (let i = 0; i < (a.amount || 1); i++) {
        const d = getDef(PREFIX + a.id);
        if (d) {
          const c = makeMinion(d.id, m.golden);
          applyGlobal(s, c);
          const beast = delta(s, "beastCombat");
          if (tribe(c, "野兽")) addStats(c, beast.attack, beast.health);
          if (ctx.summon)
            ctx.summon(c, (ctx.sourcePos ?? ctx.board.indexOf(m)) + 1 + i);
          else if (ctx.board.length < 7) {
            ctx.board.push(c);
            notifySummon(ctx, c);
          }
        }
      }
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
        c.tempSpell = a.op === "craft";
        c.extraAbilities = [
          {
            ...a,
            event: "cast",
            op: a.op === "craft" ? "buff" : "scale",
            target: "selected",
          },
        ];
        putHand(s, c);
      }
      break;
    }
    case "damageAll":
      for (const t of [...ctx.board, ...(ctx.enemy || [])])
        if (t.uid !== m.uid) {
          if (t.keywords.includes("圣盾"))
            t.keywords = t.keywords.filter((k) => k !== "圣盾");
          else t.health -= n;
        }
      break;
  }
}
const eventCombat = (event: string) => event === "combat";
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
  for (const x of [...ctx.board])
    if (x.uid !== m.uid) {
      if (tribe(m, "机械")) {
        if (!ctx.combat) run({ ...ctx, eventMinion: m }, x, "summonMech");
        else run({ ...ctx, eventMinion: m }, x, "summonMechCombat");
      }
      if (ctx.combat && tribe(m, "野兽"))
        run({ ...ctx, eventMinion: m }, x, "summonBeastCombat");
    }
}
function played(ctx: Context, m: Minion) {
  for (const x of [...ctx.board]) {
    if (x.uid !== m.uid) {
      if (tribe(m, "恶魔")) run({ ...ctx, eventMinion: m }, x, "playDemon");
      if (tribe(m, "元素")) run({ ...ctx, eventMinion: m }, x, "playElemental");
    }
    giftEvent(ctx, x, "play");
  }
  ss(ctx.s).playedTurn++;
  if (m.golden) ss(ctx.s).goldenPlayed++;
  if (trinket(ctx.s, "811") && ss(ctx.s).playedTurn === 1) keyword(m, "圣盾");
}
function castSpell(ctx: Context, m: Minion) {
  const { s } = ctx;
  if ((ctx.depth || 0) > 12) return;
  run(ctx, m, "cast");
  if (!m.tempSpell && SEASON_SPELLS.some((c) => c.id === m.id)) {
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
  if (ctx.target) {
    run({ ...ctx, depth: (ctx.depth || 0) + 1 }, ctx.target, "targetSpell");
    for (const x of [...ctx.board]) {
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
    ss(ctx.s).deaths++;
  }
}
export function endEffects(s: Game, rng: () => number) {
  const ctx = { s, board: s.board, rng };
  const count = Math.max(
    1,
    ...s.board.filter((m) => has(m, "drakkari")).map((m) => (m.golden ? 3 : 2)),
  );
  for (let i = 0; i < count; i++) {
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
function startEffects(s: Game, rng: () => number) {
  const ctx = { s, board: s.board, rng };
  ss(s).playedTurn = 0;
  ss(s).trinketBuys = 0;
  ss(s).healthRefreshes = 0;
  [...s.board, ...s.hand, ...s.shop].forEach((m) => {
    m.activated = false;
    m.rebornNext = false;
    if (m.temporary) {
      m.attack = Math.max(0, m.attack - m.temporary.attack);
      m.health = Math.max(1, m.health - m.temporary.health);
      m.keywords = m.keywords.filter((k) => !m.temporary!.keywords.includes(k));
      m.temporary = undefined;
    }
  });
  for (const m of [...s.board]) {
    run(ctx, m, "start");
    run(ctx, m, "spellcraft");
  }
  if (s.hero === PREFIX + "nozdormu") ss(s).freeRefresh++;
  if (s.hero === PREFIX + "xavius" && s.turn % 4 === 0) {
    if (!s.discovery.length) darkDiscover(s, rng);
  }
  if (trinket(s, "220"))
    gold(s, new Set(s.board.flatMap((m) => getDef(m.id).races || [])).size);
  if (trinket(s, "390"))
    putHand(s, makeMinion(PREFIX + (rng() < 0.5 ? "BG31_816" : "BG31_818")));
  if ([6, 9].includes(s.turn) && !ss(s).trinketDone.includes(s.turn)) {
    const school = s.turn === 6 ? "LESSER_TRINKET" : "GREATER_TRINKET";
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
  const boards = [clone(s.board), clone(enemies)],
    enemyGame = other || clone(s);
  if (!other) {
    enemyGame.hand = [];
    enemyGame.shop = [];
    enemyGame.season!.buffs = {};
    enemyGame.season!.trinkets = [];
  }
  const frames: BattleFrame[] = [];
  const originals = [
    new Map(s.board.map((m) => [m.uid, m])),
    new Map((other?.board || []).map((m) => [m.uid, m])),
  ];
  const contexts: Context[] = [];
  const frame = (text: string, attacker?: string, target?: string) =>
    frames.push({
      allies: clone(boards[0]),
      enemies: clone(boards[1]),
      text,
      attacker,
      target,
    });
  const summon = (side: number, m: Minion, pos: number) => {
    if (boards[side].length >= 7) return;
    boards[side].splice(Math.max(0, Math.min(pos, boards[side].length)), 0, m);
    notifySummon(contexts[side], m);
  };
  for (let side = 0; side < 2; side++)
    contexts.push({
      s: side === 0 ? s : enemyGame,
      board: boards[side],
      enemy: boards[1 - side],
      rng,
      combat: true,
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
    }
  const damage = (target: Minion, amount: number, source?: Minion) => {
    if (amount <= 0) return;
    if (target.keywords.includes("圣盾")) {
      target.keywords = target.keywords.filter((k) => k !== "圣盾");
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
  };
  const resolve = () => {
    let guard = 0;
    while (boards.some((b) => b.some((m) => m.health <= 0)) && guard++ < 100) {
      const dead = boards.flatMap((b, side) =>
        b.map((m, pos) => ({ m, side, pos })).filter((x) => x.m.health <= 0),
      );
      for (const b of boards)
        for (let i = b.length - 1; i >= 0; i--)
          if (b[i].health <= 0) b.splice(i, 1);
      for (const { m, side, pos } of dead) {
        death({ ...contexts[side], sourcePos: pos }, m);
        if (m.keywords.includes("复生")) {
          const revived = makeMinion(m.id, m.golden);
          applyGlobal(contexts[side].s, revived);
          revived.health = 1;
          revived.keywords = revived.keywords.filter((k) => k !== "复生");
          summon(side, revived, pos);
          if ((side === 0 || other) && trinket(contexts[side].s, "205"))
            boards[side].forEach((t) => addStats(t, 2, 2));
        }
      }
    }
  };
  frame("战斗开始");
  for (let side = 0; side < 2; side++) {
    const ctx = contexts[side];
    for (const m of [...boards[side]]) {
      run(ctx, m, "combat");
      giftEvent(ctx, m, "combat");
    }
    if (
      (side === 0 || other) &&
      ctx.s.hero === PREFIX + "alakir" &&
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
      damage(target, a, attack);
      if (
        !has(attack, "immuneAttack") &&
        giftNumber(attack.gift || "") !== "60"
      )
        damage(attack, t, target);
      for (const n of neighbors) damage(n, a, attack);
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
): { state: Game; error?: string } {
  const s = clone(state),
    st = ss(s),
    ctx: Context = { s, board: s.board, rng };
  const fail = (error: string) => ({ state, error });
  if (s.phase === "over") return fail("本局已结束，请开始新对局。");
  if (s.phase === "combat" && action.type !== "continue")
    return fail("请先完成当前战斗。");
  if (s.discovery.length && action.type !== "discover")
    return fail("请先选择发现的卡牌。");
  if (
    st.trinketOffers.length &&
    action.type !== "buyTrinket" &&
    !s.discovery.length
  )
    return fail("请先选择本回合的饰品。");
  switch (action.type) {
    case "freeze":
      s.frozen = !s.frozen;
      log(s, s.frozen ? "已冻结随从和酒馆法术。" : "已解除冻结。");
      break;
    case "refresh": {
      const healthFree =
        s.board.some((m) => has(m, "healthRefresh")) &&
        st.healthRefreshes <
          Math.max(
            ...s.board
              .filter((m) => has(m, "healthRefresh"))
              .map((m) => (m.golden ? 4 : 2)),
          );
      const cost = refreshCost(s);
      if (s.gold < cost && !healthFree)
        return fail("金币不足，刷新需要1金币。");
      if (st.freeRefresh > 0) st.freeRefresh--;
      else if (healthFree) {
        heroDamage(s, 1, ctx);
        st.healthRefreshes++;
      } else s.gold--;
      s.frozen = false;
      refill(s, rng);
      s.refreshes++;
      log(
        s,
        `刷新酒馆${healthFree ? "，以生命支付" : cost === 0 ? "，消耗免费次数" : ""}。`,
      );
      break;
    }
    case "buy": {
      const m = s.shop.find((x) => x.uid === action.uid);
      if (!m) return fail("该随从已离开酒馆。");
      const cost = minionCost(s, m);
      if (s.gold < cost) return fail(`招募需要${cost}枚金币。`);
      if (!room(s)) return fail("手牌已满。");
      s.gold -= cost;
      if (cost === 0) st.trinketBuys++;
      s.shop = s.shop.filter((x) => x.uid !== m.uid);
      s.hand.push(m);
      s.purchases++;
      if (s.hero === PREFIX + "hoggarr" && tribe(m, "海盗")) gold(s, 1);
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
      if (s.gold < cost) return fail(`购买法术需要${cost}枚金币。`);
      if (!room(s)) return fail("手牌已满。");
      s.gold -= cost;
      st.spellDiscount = 0;
      st.spellShop = st.spellShop.filter((x) => x.uid !== m.uid);
      putHand(s, m);
      log(s, `购买酒馆法术：${getDef(m.id).name}。`);
      break;
    }
    case "play": {
      const m = s.hand.find((x) => x.uid === action.uid);
      if (!m) return fail("未找到这张手牌。");
      if (getDef(m.id).kind === "spell")
        return actSeason(
          state,
          { type: "cast", uid: m.uid, target: action.target },
          rng,
        );
      const ts = seasonTargets(s, m),
        d = getDef(m.id),
        target = s.board.find((x) => x.uid === action.target);
      if (action.target && !ts.some((x) => x.uid === action.target))
        return fail("请选择有效的友方目标。");
      if (ts.length && !action.target && !d.magnetic)
        return fail("请选择战吼目标。");
      if (s.board.length >= 7 && !(d.magnetic && target))
        return fail("战場已满，最多7个随从。");
      s.hand = s.hand.filter((x) => x.uid !== m.uid);
      if (d.magnetic && target) {
        addStats(target, m.attack, m.health);
        m.keywords.forEach((k) => keyword(target, k));
        target.extraAbilities = [
          ...(target.extraAbilities || []),
          ...ability(m).map((a) => ({
            ...a,
            attack:
              a.attack === undefined
                ? undefined
                : a.attack * (m.golden ? 2 : 1),
            health:
              a.health === undefined
                ? undefined
                : a.health * (m.golden ? 2 : 1),
            amount:
              a.amount === undefined
                ? undefined
                : a.amount * (m.golden ? 2 : 1),
            noScale: true,
          })),
        ];
        for (const [id, n] of Object.entries(m.copies))
          target.copies[id] = (target.copies[id] || 0) + n;
        notifySummon({ ...ctx, eventMinion: target }, target);
      } else {
        s.board.splice(action.position ?? s.board.length, 0, m);
        notifySummon(ctx, m);
        triggerBattlecry({ ...ctx, target }, m);
        run(ctx, m, "spellcraft");
      }
      played(ctx, m);
      if (m.reward) {
        s.rewards.push(Math.min(6, s.tier + 1));
        m.reward = false;
      }
      log(s, `打出了${m.golden ? "金色" : ""}${d.name}。`);
      break;
    }
    case "cast": {
      const m = s.hand.find((x) => x.uid === action.uid);
      if (!m || getDef(m.id).kind !== "spell")
        return fail("请选择一张法术手牌。");
      const ts = seasonTargets(s, m, "cast"),
        target = [...s.board, ...s.shop].find((x) => x.uid === action.target);
      if (
        ability(m, "cast").some((a) => a.target === "selected") &&
        (!target || !ts.some((x) => x.uid === target.uid))
      )
        return fail("请选择有效的法术目标。");
      s.hand = s.hand.filter((x) => x.uid !== m.uid);
      castSpell({ ...ctx, target }, m);
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
        target = s.board.find((x) => x.uid === action.target);
      if (
        ability(m, "activate").some((a) => a.target === "selected") &&
        (!target || !ts.some((x) => x.uid === target.uid))
      )
        return fail("请选择发动技能的目标。");
      if (has(m, "stealHighest") && (!s.shop.length || !room(s)))
        return fail("酒馆需要随从，且手牌需要空位。");
      s.gold -= cost;
      m.activated = true;
      run({ ...ctx, target }, m, "activate");
      log(s, `${getDef(m.id).name}发动技能。`);
      break;
    }
    case "sell": {
      const m = s.board.find((x) => x.uid === action.uid);
      if (!m) return fail("只能出售战场上的随从。");
      s.board.splice(s.board.indexOf(m), 1);
      release(s, m);
      gold(s, 1);
      run(ctx, m, "sell");
      for (const other of [...s.board]) {
        if (tribe(m, "元素"))
          run({ ...ctx, eventMinion: m }, other, "sellElemental");
        run({ ...ctx, eventMinion: m }, other, "sellMinion");
      }
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
      s.gold -= s.upgrade;
      s.tier++;
      s.upgrade = UPGRADE_COST[s.tier];
      if (s.hero === PREFIX + "omu") gold(s, 2);
      log(s, `酒馆升至${s.tier}星。`);
      break;
    case "power": {
      const h = SEASON_HEROES.find((h) => h.id === s.hero)!;
      if (h.passive) return fail("这是被动技能，持续生效。");
      if (s.powerUsed) return fail("本回合已使用英雄技能。");
      if (s.gold < h.cost) return fail(`英雄技能需要${h.cost}金币。`);
      const key = s.hero.slice(4),
        target = [...s.board, ...s.shop].find((m) => m.uid === action.target);
      if (["lich", "george"].includes(key) && !target)
        return fail("请选择一个随从。");
      if (key === "george" && target?.keywords.includes("圣盾"))
        return fail("该随从已有圣盾。");
      if (key === "millificent" && s.tier < 4)
        return fail("修补匠在酒馆4星时解锁。");
      if (key === "pyramid" && (!s.shop.length || !room(s)))
        return fail("酒馆需要随从，且手牌需要空位。");
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
      s.gold -= h.cost;
      s.powerUsed = true;
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
      s.gold -= 3;
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
      s.discovery.filter((x) => x.uid !== m.uid).forEach((x) => release(s, x));
      s.discovery = [];
      putHand(s, m);
      if (giftNumber(m.gift || "") === "11") putHand(s, makeMinion(m.id));
      log(s, `发现了${getDef(m.id).name}${m.gift ? "，附带黑暗之赐" : ""}。`);
      st.discoveryKind = "";
      break;
    }
    case "buyTrinket": {
      if (!action.uid || !st.trinketOffers.includes(action.uid))
        return fail("请选择本回合的一件饰品。");
      const item = TRINKETS.find((t) => t.id === action.uid)!;
      if (s.gold < item.cost) return fail(`购买饰品需要${item.cost}金币。`);
      s.gold -= item.cost;
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
      const o = s.opponents[s.nextOpponent];
      if (!o || s.opponents.every((o) => o.health <= 0)) {
        s.phase = "over";
        break;
      }
      const battle = seasonCombat(s, o.board, o.tier, rng);
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
  s.turn++;
  s.gold = Math.min(st.maxGold, Math.min(st.maxGold, s.turn + 2) + st.nextGold);
  st.nextGold = 0;
  s.upgrade = Math.max(0, s.upgrade - 1);
  s.powerUsed = false;
  s.phase = "recruit";
  s.battle = null;
  startEffects(s, rng);
  refill(s, rng, s.frozen);
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
