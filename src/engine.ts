import {
  actSeason,
  createSeason,
  seasonTargets,
  assertSeasonPool,
  type SeasonState,
} from "./season/engine";
import {
  CARDS,
  CLASSIC_HEROES,
  getDef,
  HEROES,
  POOL_COPIES,
  SHOP_SIZE,
  UPGRADE_COST,
  type Keyword,
} from "./data";
export interface Minion {
  gift?: string;
  giftTurn?: number;
  activated?: boolean;
  temporary?: { attack: number; health: number; keywords: Keyword[] };
  extraAbilities?: import("./data").Ability[];
  expires?: boolean;
  tempSpell?: boolean;
  gems?: { attack: number; health: number };
  uid: string;
  id: string;
  attack: number;
  health: number;
  golden: boolean;
  keywords: Keyword[];
  copies: Record<string, number>;
  reward?: boolean;
  rebornNext?: boolean;
}
export interface Opponent {
  armor?: number;
  name: string;
  hero: string;
  health: number;
  tier: number;
  board: Minion[];
}
export interface BattleFrame {
  allies: Minion[];
  enemies: Minion[];
  text: string;
  attacker?: string;
  target?: string;
}
export interface Battle {
  frames: BattleFrame[];
  result: "win" | "loss" | "tie";
  damage: number;
  opponent: string;
}
export interface Game {
  season?: SeasonState;
  version: 1;
  hero: string;
  turn: number;
  gold: number;
  tier: number;
  upgrade: number;
  health: number;
  frozen: boolean;
  powerUsed: boolean;
  shop: Minion[];
  hand: Minion[];
  board: Minion[];
  pool: Record<string, number>;
  opponents: Opponent[];
  nextOpponent: number;
  logs: string[];
  battles: { turn: number; result: string; damage: number; name: string }[];
  discovery: Minion[];
  rewards: number[];
  pogo: number;
  triples: number;
  purchases: number;
  refreshes: number;
  phase: "recruit" | "combat" | "over";
  battle: Battle | null;
}
export type Action =
  | {
      type: "darkGift" | "buyTrinket" | "buySpell" | "cast" | "activate";
      uid?: string;
      target?: string;
    }
  | { type: "refresh" | "freeze" | "upgrade" | "end" | "continue" | "reward" }
  | { type: "buy" | "sell" | "discover"; uid: string }
  | { type: "play"; uid: string; target?: string; position?: number }
  | { type: "power"; target?: string }
  | { type: "move"; uid: string; to: number };
let serial = 0;
const uid = () =>
  `${Date.now().toString(36)}-${++serial}-${Math.random().toString(36).slice(2, 7)}`;
export const clone = <T>(v: T): T => structuredClone(v);
export const heroOf = (s: Game) => HEROES.find((h) => h.id === s.hero)!;
export const isTribe = (m: Minion, t: string) =>
  getDef(m.id).tribe === t ||
  getDef(m.id).tribe === "全部" ||
  !!getDef(m.id).races?.includes(t as import("./data").Tribe) ||
  m.gift === "BG36_MidGameEffect_000t22";
export function makeMinion(
  id: string,
  golden = false,
  fromPool = false,
): Minion {
  const d = getDef(id);
  return {
    uid: uid(),
    id,
    attack: golden ? (d.goldenAttack ?? d.attack * 2) : d.attack,
    health: golden ? (d.goldenHealth ?? d.health * 2) : d.health,
    golden,
    keywords: [...(d.keywords || [])],
    copies: fromPool ? { [id]: golden ? 3 : 1 } : {},
  };
}
const pick = <T>(a: T[], rng: () => number) =>
  a[Math.min(a.length - 1, Math.floor(rng() * a.length))];
function log(s: Game, msg: string) {
  s.logs.unshift(msg);
  s.logs = s.logs.slice(0, 60);
}
function draw(
  s: Game,
  tier: number,
  rng: () => number,
  exact = false,
  exclude: string[] = [],
): Minion | undefined {
  const eligible = CARDS.filter(
    (d) =>
      (exact ? d.tier === tier : d.tier <= tier) &&
      s.pool[d.id] > 0 &&
      !exclude.includes(d.id),
  );
  const total = eligible.reduce((a, d) => a + s.pool[d.id], 0);
  if (!total) return;
  let n = rng() * total;
  for (const d of eligible) {
    n -= s.pool[d.id];
    if (n < 0) {
      s.pool[d.id]--;
      return makeMinion(d.id, false, true);
    }
  }
}
function release(s: Game, m: Minion) {
  for (const [id, n] of Object.entries(m.copies)) s.pool[id] += n;
}
function shopBuff(s: Game, m: Minion) {
  if (s.hero === "millificent" && isTribe(m, "机械")) {
    m.attack++;
    m.health++;
  }
}
function refill(s: Game, rng: () => number, keep = false) {
  if (!keep) {
    s.shop.forEach((m) => release(s, m));
    s.shop = [];
  }
  while (s.shop.length < SHOP_SIZE[s.tier]) {
    const m = draw(s, s.tier, rng);
    if (!m) break;
    shopBuff(s, m);
    s.shop.push(m);
  }
}
export function createGame(
  hero = "lich",
  rng: () => number = Math.random,
): Game {
  if (hero.startsWith("s14_")) return createSeason(hero, rng);
  const h = HEROES.find((h) => h.id === hero) || HEROES[0];
  const s: Game = {
    version: 1,
    hero: h.id,
    turn: 1,
    gold: 3,
    tier: 1,
    upgrade: 5 - (h.id === "bartender" ? 1 : 0),
    health: h.health,
    frozen: false,
    powerUsed: false,
    shop: [],
    hand: [],
    board: [],
    pool: Object.fromEntries(CARDS.map((c) => [c.id, POOL_COPIES[c.tier]])),
    opponents: CLASSIC_HEROES.filter((x) => x.id !== h.id).map((x) => ({
      name: x.name,
      hero: x.id,
      health: x.health,
      tier: 1,
      board: [],
    })),
    nextOpponent: 0,
    logs: ["鲍勃：欢迎光临！挑几个随从，开始吧。"],
    battles: [],
    discovery: [],
    rewards: [],
    pogo: 0,
    triples: 0,
    purchases: 0,
    refreshes: 0,
    phase: "recruit",
    battle: null,
  };
  refill(s, rng);
  return s;
}
function triples(s: Game) {
  let again = true;
  while (again) {
    again = false;
    for (const d of [
      ...CARDS,
      ...s.hand.filter((m) => getDef(m.id).token).map((m) => getDef(m.id)),
    ]) {
      const ms = [...s.hand, ...s.board].filter(
        (m) => m.id === d.id && !m.golden,
      );
      if (ms.length < 3) continue;
      const parts = ms.slice(0, 3),
        ids = new Set(parts.map((m) => m.uid));
      s.hand = s.hand.filter((m) => !ids.has(m.uid));
      s.board = s.board.filter((m) => !ids.has(m.uid));
      const m = makeMinion(d.id, true);
      m.attack += parts.reduce((v, x) => v + x.attack - d.attack, 0);
      m.health += parts.reduce((v, x) => v + x.health - d.health, 0);
      m.keywords = [...new Set(parts.flatMap((x) => x.keywords))];
      m.rebornNext = parts.some((x) => x.rebornNext);
      for (const p of parts)
        for (const [id, n] of Object.entries(p.copies))
          m.copies[id] = (m.copies[id] || 0) + n;
      m.reward = true;
      s.hand.push(m);
      s.triples++;
      log(s, `三连！${d.name}合成为金色，打出后获得三连奖励。`);
      again = true;
      break;
    }
  }
}
const buff = (m: Minion, a: number, h: number) => {
  m.attack += a;
  m.health += h;
};
const addKeyword = (m: Minion, k: Keyword) => {
  if (!m.keywords.includes(k)) m.keywords.push(k);
};
function onSummon(board: Minion[], m: Minion) {
  for (const x of board) {
    if (x.uid === m.uid) continue;
    const f = x.golden ? 2 : 1;
    switch (getDef(x.id).effect) {
      case "tidecaller":
        if (isTribe(m, "鱼人")) x.attack += f;
        break;
      case "cobalt":
        if (isTribe(m, "机械")) addKeyword(x, "圣盾");
        break;
      case "pack":
        if (isTribe(m, "野兽")) m.attack += 3 * f;
        break;
      case "mama":
        if (isTribe(m, "野兽")) buff(m, 4 * f, 4 * f);
        break;
    }
  }
}
export function targetsFor(s: Game, m: Minion) {
  if (s.season) return seasonTargets(s, m, "battlecry");
  const e = getDef(m.id).effect;
  return s.board.filter(
    (x) =>
      x.uid !== m.uid &&
      (e === "rockpool"
        ? isTribe(x, "鱼人")
        : e === "overseer"
          ? isTribe(x, "恶魔")
          : e === "magnetic"
            ? isTribe(x, "机械")
            : false),
  );
}
function battlecry(
  s: Game,
  m: Minion,
  target: string | undefined,
  rng: () => number,
) {
  const e = getDef(m.id).effect,
    f = m.golden ? 2 : 1;
  const brann = Math.max(
    1,
    ...s.board
      .filter((x) => x.uid !== m.uid && getDef(x.id).effect === "brann")
      .map((x) => (x.golden ? 3 : 2)),
  );
  for (let j = 0; j < brann; j++) {
    switch (e) {
      case "cat":
      case "scout":
        if (s.board.length < 7) {
          const token = makeMinion(`${e}-token`, m.golden);
          s.board.splice(s.board.indexOf(m) + 1, 0, token);
          onSummon(s.board, token);
        }
        break;
      case "rockpool":
      case "overseer": {
        const t = s.board.find((x) => x.uid === target);
        if (t && targetsFor(s, m).some((x) => x.uid === t.uid))
          buff(
            t,
            (e === "rockpool" ? 1 : 2) * f,
            (e === "rockpool" ? 1 : 2) * f,
          );
        break;
      }
      case "metaltooth":
        s.board
          .filter((x) => x.uid !== m.uid && isTribe(x, "机械"))
          .forEach((x) => buff(x, 2 * f, 0));
        break;
      case "coldlight":
        s.board
          .filter((x) => x.uid !== m.uid && isTribe(x, "鱼人"))
          .forEach((x) => buff(x, 0, 2 * f));
        break;
      case "pogo":
        buff(m, s.pogo * 2 * f, s.pogo * 2 * f);
        break;
      case "argus": {
        const i = s.board.indexOf(m);
        [s.board[i - 1], s.board[i + 1]].filter(Boolean).forEach((x) => {
          buff(x, f, f);
          addKeyword(x, "嘲讽");
        });
        break;
      }
      case "vulgar":
        s.health -= 2;
        break;
    }
  }
  if (e === "pogo") s.pogo++;
  if (isTribe(m, "恶魔"))
    s.board
      .filter((x) => x.uid !== m.uid && getDef(x.id).effect === "weaver")
      .forEach((x) => {
        s.health--;
        buff(x, x.golden ? 4 : 2, x.golden ? 4 : 2);
      });
  void rng;
}
function endBuffs(board: Minion[], rng: () => number) {
  for (const m of board) {
    if (getDef(m.id).effect === "lightfang") {
      const f = m.golden ? 4 : 2;
      const tribes = [...new Set(board.map((x) => getDef(x.id).tribe))].filter(
        (t) => t !== "无" && t !== "全部",
      );
      const used = new Set<string>();
      for (const t of tribes) {
        const candidates = board.filter(
          (x) => x.uid !== m.uid && isTribe(x, t) && !used.has(x.uid),
        );
        if (candidates.length) {
          const x = pick(candidates, rng);
          buff(x, f, f);
          used.add(x.uid);
        }
      }
    }
  }
}
function recruitAI(s: Game, rng: () => number) {
  for (const o of s.opponents) {
    if (o.health <= 0) continue;
    o.tier = Math.min(6, Math.max(1, Math.floor((s.turn + 1) / 2)));
    for (let j = 0; j < Math.min(3, Math.floor((s.turn + 2) / 3)); j++) {
      if (o.board.length >= 7) {
        const weakest = o.board.reduce((a, b) =>
          a.attack + a.health < b.attack + b.health ? a : b,
        );
        if (getDef(weakest.id).tier >= o.tier) break;
        o.board = o.board.filter((x) => x.uid !== weakest.uid);
        release(s, weakest);
      }
      const m = draw(s, o.tier, rng);
      if (m) {
        o.board.push(m);
        onSummon(o.board, m);
      }
    }
    endBuffs(o.board, rng);
  }
}
const DEATHS = [
  "kangaroo",
  "grandmother",
  "wolf",
  "golem",
  "lion",
  "voidlord",
  "spawn",
  "selfless",
  "coiler",
];
export function combat(
  allies: Minion[],
  enemies: Minion[],
  tier: number,
  enemyTier: number,
  rng: () => number = Math.random,
  breath = false,
): Battle {
  const boards = [clone(allies), clone(enemies)];
  boards[0].forEach((m) => {
    if (m.rebornNext) addKeyword(m, "复生");
  });
  const frames: BattleFrame[] = [];
  const frame = (text: string, attacker?: string, target?: string) =>
    frames.push({
      allies: clone(boards[0]),
      enemies: clone(boards[1]),
      text,
      attacker,
      target,
    });
  frame("战斗开始");
  const summon = (side: number, m: Minion, pos: number) => {
    if (boards[side].length >= 7) return;
    boards[side].splice(Math.min(pos, boards[side].length), 0, m);
    onSummon(boards[side], m);
  };
  const damage = (m: Minion, n: number, poison = false) => {
    if (n <= 0) return;
    if (m.keywords.includes("圣盾"))
      m.keywords = m.keywords.filter((k) => k !== "圣盾");
    else {
      m.health -= n;
      if (poison) m.health = Math.min(0, m.health);
      if (getDef(m.id).effect === "rover") {
        const side = boards[0].includes(m) ? 0 : 1;
        summon(
          side,
          makeMinion("rover-token", m.golden),
          boards[side].indexOf(m) + 1,
        );
      }
    }
  };
  const resolve = () => {
    let guard = 0;
    while (boards.some((b) => b.some((m) => m.health <= 0)) && guard++ < 100) {
      const dead = boards.flatMap((b, side) =>
        b
          .filter((m) => m.health <= 0)
          .map((m) => ({
            m,
            side,
            pos: b.indexOf(m),
            times: Math.max(
              1,
              ...b
                .filter((x) => x.health > 0 && getDef(x.id).effect === "baron")
                .map((x) => (x.golden ? 3 : 2)),
            ),
          })),
      );
      boards.forEach((b, i) => (boards[i] = b.filter((m) => m.health > 0)));
      for (const { m, side, pos, times } of dead) {
        const b = boards[side],
          e = getDef(m.id).effect,
          f = m.golden ? 2 : 1;
        if (isTribe(m, "野兽"))
          b.filter((x) => getDef(x.id).effect === "hyena").forEach((x) =>
            buff(x, x.golden ? 4 : 2, x.golden ? 2 : 1),
          );
        for (let r = 0; r < times; r++) {
          if (e === "spawn") b.forEach((x) => buff(x, f, f));
          if (e === "selfless") {
            for (let n = 0; n < f; n++) {
              const ts = b.filter((x) => !x.keywords.includes("圣盾"));
              if (ts.length) addKeyword(pick(ts, rng), "圣盾");
            }
          }
          if (
            e &&
            [
              "kangaroo",
              "grandmother",
              "wolf",
              "golem",
              "lion",
              "voidlord",
            ].includes(e)
          ) {
            const count =
              e === "wolf" || e === "lion" ? 2 : e === "voidlord" ? 3 : 1;
            for (let n = 0; n < count; n++)
              summon(side, makeMinion(`${e}-token`, m.golden), pos + n);
          }
          if (e === "coiler") {
            for (let n = 0; n < 2 * f; n++) {
              const c = pick(
                CARDS.filter(
                  (d) =>
                    d.effect &&
                    DEATHS.includes(d.effect) &&
                    d.effect !== "coiler",
                ),
                rng,
              );
              summon(side, makeMinion(c.id), pos + n);
            }
          }
        }
        if (m.keywords.includes("复生")) {
          const revived = makeMinion(m.id, m.golden);
          revived.health = 1;
          revived.keywords = revived.keywords.filter((k) => k !== "复生");
          summon(side, revived, pos);
        }
      }
    }
  };
  if (breath) {
    boards[1].slice().forEach((m) => damage(m, 1));
    resolve();
    frame("奈法利安的吐息对所有敌方随从造成1点伤害");
  }
  let side =
    boards[0].length === boards[1].length
      ? rng() < 0.5
        ? 0
        : 1
      : boards[0].length > boards[1].length
        ? 0
        : 1;
  const last: [string | null, string | null] = [null, null];
  const nextIndex = [0, 0];
  for (
    let step = 0;
    step < 160 && boards[0].length && boards[1].length;
    step++
  ) {
    const b = boards[side],
      enemy = boards[1 - side];
    let start = nextIndex[side] % b.length;
    const previous = b.findIndex((m) => m.uid === last[side]);
    if (previous >= 0) start = (previous + 1) % b.length;
    let a: Minion | undefined;
    for (let k = 0; k < b.length; k++) {
      const c = b[(start + k) % b.length];
      if (c.attack > 0) {
        a = c;
        break;
      }
    }
    if (!a) {
      if (!enemy.some((m) => m.attack > 0)) break;
      side = 1 - side;
      continue;
    }
    last[side] = a.uid;
    nextIndex[side] = b.indexOf(a);
    const swings = a.keywords.includes("风怒") ? (a.golden ? 4 : 2) : 1;
    for (
      let swing = 0;
      swing < swings && a.health > 0 && boards[1 - side].length;
      swing++
    ) {
      const targets = boards[1 - side].filter((m) =>
        m.keywords.includes("嘲讽"),
      );
      const t = pick(targets.length ? targets : boards[1 - side], rng);
      const neighbors =
        getDef(a.id).effect === "cleave"
          ? [
              boards[1 - side][boards[1 - side].indexOf(t) - 1],
              boards[1 - side][boards[1 - side].indexOf(t) + 1],
            ].filter(Boolean)
          : [];
      const aa = a.attack,
        ta = t.attack;
      damage(t, aa, a.keywords.includes("剧毒"));
      damage(a, ta, t.keywords.includes("剧毒"));
      neighbors.forEach((n) => damage(n, aa, a!.keywords.includes("剧毒")));
      frame(`${getDef(a.id).name} 攻击 ${getDef(t.id).name}`, a.uid, t.uid);
      resolve();
      frame("结算伤害与亡语");
    }
    side = 1 - side;
  }
  const result =
    boards[0].length && !boards[1].length
      ? "win"
      : boards[1].length && !boards[0].length
        ? "loss"
        : "tie";
  const damageValue =
    result === "tie"
      ? 0
      : (result === "win" ? tier : enemyTier) +
        boards[result === "win" ? 0 : 1].reduce(
          (v, m) => v + getDef(m.id).tier,
          0,
        );
  frame(
    result === "win"
      ? `战斗胜利，造成${damageValue}点伤害`
      : result === "loss"
        ? `战斗失利，受到${damageValue}点伤害`
        : "势均力敌，本轮平局",
  );
  return { frames, result, damage: damageValue, opponent: "" };
}
export function act(
  state: Game,
  action: Action,
  rng: () => number = Math.random,
): { state: Game; error?: string } {
  if (state.season) return actSeason(state, action, rng);
  const s = clone(state);
  const fail = (error: string) => ({ state, error });
  if (s.phase === "over") return fail("本局已结束，请开始新对局。");
  if (s.phase === "combat" && action.type !== "continue")
    return fail("请先完成本轮战斗。");
  if (s.discovery.length && action.type !== "discover")
    return fail("请先选择发现的随从。");
  switch (action.type) {
    case "refresh":
      if (s.gold < 1) return fail("金币不足，刷新需要1枚金币。");
      s.gold--;
      s.frozen = false;
      refill(s, rng);
      s.refreshes++;
      log(s, "花费1金币，刷新酒馆。");
      break;
    case "freeze":
      s.frozen = !s.frozen;
      log(s, s.frozen ? "已冻结酒馆，下回合保留这些随从。" : "已解除冻结。");
      break;
    case "buy": {
      const m = s.shop.find((x) => x.uid === action.uid);
      if (!m) return fail("该随从已离开酒馆。");
      if (s.gold < 3) return fail("金币不足，购买需要3枚金币。");
      if (s.hand.length + s.rewards.length >= 10)
        return fail("手牌已满，先打出一张牌。");
      s.gold -= 3;
      s.shop = s.shop.filter((x) => x.uid !== m.uid);
      s.hand.push(m);
      s.purchases++;
      log(s, `招募了${getDef(m.id).name}。`);
      triples(s);
      break;
    }
    case "play": {
      const m = s.hand.find((x) => x.uid === action.uid);
      if (!m) return fail("手牌中没有该随从。");
      const magnetic = getDef(m.id).effect === "magnetic" && action.target;
      const ts = targetsFor(s, m);
      if (action.target && !ts.some((x) => x.uid === action.target))
        return fail("请选择有效目标。");
      if (!magnetic && s.board.length >= 7)
        return fail("战场已满，最多容纳7个随从。");
      if (
        ["rockpool", "overseer"].includes(getDef(m.id).effect || "") &&
        ts.length &&
        !action.target
      )
        return fail("请选择战吼目标。");
      s.hand = s.hand.filter((x) => x.uid !== m.uid);
      if (magnetic) {
        const t = s.board.find((x) => x.uid === action.target)!;
        buff(t, m.attack, m.health);
        m.keywords.forEach((k) => addKeyword(t, k));
        for (const [id, n] of Object.entries(m.copies))
          t.copies[id] = (t.copies[id] || 0) + n;
      } else {
        s.board.splice(action.position ?? s.board.length, 0, m);
        onSummon(s.board, m);
        battlecry(s, m, action.target, rng);
      }
      if (m.reward) {
        s.rewards.push(Math.min(6, s.tier + 1));
        m.reward = false;
        log(s, `获得${Math.min(6, s.tier + 1)}星三连奖励。`);
      }
      log(s, `打出了${m.golden ? "金色" : ""}${getDef(m.id).name}。`);
      triples(s);
      break;
    }
    case "sell": {
      const m = s.board.find((x) => x.uid === action.uid);
      if (!m) return fail("只能出售战场上的随从。");
      s.board = s.board.filter((x) => x.uid !== m.uid);
      release(s, m);
      s.gold = Math.min(10, s.gold + 1);
      log(s, `出售${getDef(m.id).name}，获得1金币。`);
      break;
    }
    case "upgrade":
      if (s.tier >= 6) return fail("酒馆已达到最高星级。");
      if (s.gold < s.upgrade) return fail(`升级需要${s.upgrade}枚金币。`);
      s.gold -= s.upgrade;
      s.tier++;
      s.upgrade = Math.max(
        0,
        UPGRADE_COST[s.tier] - (s.hero === "bartender" ? 1 : 0),
      );
      log(s, `酒馆升至${s.tier}星！下次刷新可招募更高星级的随从。`);
      break;
    case "move": {
      const i = s.board.findIndex((x) => x.uid === action.uid);
      if (i < 0) return fail("没有找到随从。");
      const [m] = s.board.splice(i, 1);
      s.board.splice(Math.max(0, Math.min(action.to, s.board.length)), 0, m);
      break;
    }
    case "power": {
      const h = heroOf(s);
      if (h.passive) return fail("这是被动技能，始终生效。");
      if (s.powerUsed) return fail("本回合已使用英雄技能。");
      if (s.gold < h.cost) return fail(`英雄技能需要${h.cost}枚金币。`);
      const t = s.board.find((x) => x.uid === action.target);
      if (["lich", "george"].includes(h.id) && !t)
        return fail("请选择一个友方随从。");
      if (h.id === "george" && t?.keywords.includes("圣盾"))
        return fail("该随从已经拥有圣盾。");
      if (h.id === "pyramid" && !s.board.length)
        return fail("战场上需要至少一个随从。");
      if (h.id === "lich") t!.rebornNext = true;
      if (h.id === "george") addKeyword(t!, "圣盾");
      if (h.id === "pyramid") buff(pick(s.board, rng), 0, 2);
      if (h.id === "jaraxxus")
        s.board.filter((x) => isTribe(x, "恶魔")).forEach((x) => buff(x, 1, 1));
      s.gold -= h.cost;
      s.powerUsed = true;
      log(s, `使用英雄技能：${h.power}。`);
      break;
    }
    case "reward": {
      if (!s.rewards.length) return fail("没有可用的三连奖励。");
      const tier = s.rewards.shift()!;
      for (let n = 0; n < 3; n++) {
        const m = draw(
          s,
          tier,
          rng,
          true,
          s.discovery.map((x) => x.id),
        );
        if (m) s.discovery.push(m);
      }
      if (!s.discovery.length) {
        s.rewards.unshift(tier);
        return fail("该星级随从池暂时已空，请稍后再试。");
      }
      break;
    }
    case "discover": {
      const m = s.discovery.find((x) => x.uid === action.uid);
      if (!m) return fail("请选择一张发现的随从。");
      s.discovery.filter((x) => x.uid !== m.uid).forEach((x) => release(s, x));
      s.discovery = [];
      s.hand.push(m);
      log(s, `三连奖励：发现了${getDef(m.id).name}。`);
      triples(s);
      break;
    }
    case "end": {
      endBuffs(s.board, rng);
      recruitAI(s, rng);
      const living = s.opponents
        .map((o, i) => ({ o, i }))
        .filter((x) => x.o.health > 0);
      if (!living.length) {
        s.phase = "over";
        break;
      }
      const entry = living.find((x) => x.i === s.nextOpponent) || living[0];
      s.nextOpponent = entry.i;
      const o = entry.o;
      const battle = combat(
        s.board,
        o.board,
        s.tier,
        o.tier,
        rng,
        s.hero === "nefarian" && s.powerUsed,
      );
      battle.opponent = o.name;
      s.battle = battle;
      s.battles.unshift({
        turn: s.turn,
        result: battle.result,
        damage: battle.damage,
        name: o.name,
      });
      s.phase = "combat";
      if (battle.result === "loss") s.health -= battle.damage;
      if (battle.result === "win") {
        o.health -= battle.damage;
        if (o.health <= 0) {
          o.board.forEach((m) => release(s, m));
          o.board = [];
        }
      }
      log(
        s,
        `第${s.turn}回合：${battle.result === "win" ? "胜利" : battle.result === "loss" ? "失利" : "平局"}${battle.damage ? `，${battle.damage}点伤害` : ""}。`,
      );
      break;
    }
    case "continue": {
      if (s.phase !== "combat") return fail("当前没有待结束的战斗。");
      if (s.health <= 0 || s.opponents.every((o) => o.health <= 0)) {
        s.phase = "over";
        break;
      }
      s.turn++;
      s.gold = Math.min(10, s.turn + 2);
      s.upgrade = Math.max(0, s.upgrade - 1);
      s.powerUsed = false;
      s.board.forEach((m) => (m.rebornNext = false));
      refill(s, rng, s.frozen);
      s.frozen = false;
      s.phase = "recruit";
      s.battle = null;
      const living = s.opponents
        .map((o, i) => ({ o, i }))
        .filter((x) => x.o.health > 0);
      s.nextOpponent = (
        living.find((x) => x.i > s.nextOpponent) || living[0]
      ).i;
      log(s, `第${s.turn}回合开始，获得${s.gold}枚金币。`);
      break;
    }
  }
  if (s.health <= 0 && s.phase === "recruit") s.phase = "over";
  return { state: s };
}
export function poolTotal(s: Game) {
  return Object.values(s.pool).reduce((a, b) => a + b, 0);
}
export function assertPool(s: Game) {
  if (s.season) return assertSeasonPool(s);
  const held = [
    ...s.shop,
    ...s.hand,
    ...s.board,
    ...s.discovery,
    ...s.opponents.flatMap((o) => o.board),
  ];
  for (const d of CARDS) {
    const total =
      s.pool[d.id] + held.reduce((n, m) => n + (m.copies[d.id] || 0), 0);
    if (total !== POOL_COPIES[d.tier] || s.pool[d.id] < 0)
      throw new Error(`Pool invariant: ${d.id}: ${total}`);
  }
}
