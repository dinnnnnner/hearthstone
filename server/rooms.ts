import { equippedPowers } from "../src/season/powers";
import { recordScoutRound, warbandLabel, previousScoutRounds } from "../src/scouting";
import { gameRankingHealth, absorbArmor } from "../src/ranking";
import { createPairingCycle, cyclePairings, type PairingCycle } from "./pairing";
import { randomBytes, createHash, randomInt } from "node:crypto";
import {
  createSeason,
  actSeason,
  endEffects,
  advanceRecruit,
  seasonCombat,
  releasePlayerCards,
  seasonTargets,
  minionCost,
  refreshCost,
  TRINKETS,
} from "../src/season/engine";
import { SEASON_HEROES, ALL_TRIBES, HERO_TRIBES } from "../src/season/catalog";
import { getDef, type Tribe } from "../src/data";
import {
  heroOf,
  heroPowerState,
  targetsFor,
  type Action,
  type Game,
  type Minion,
  type Battle,
} from "../src/engine";
export type Guest = {
  id: string;
  name: string;
  hash: string;
  seen: number;
  room?: string;
};
export type Seat = {
  id: string;
  name: string;
  hero: string;
  heroOffers?: string[];
  bot: boolean;
  left?: boolean;
  ready: boolean;
  ended: boolean;
  continued: boolean;
  rev: number;
  game?: Game;
  place?: number;
  requests: string[];
  battleId?: string;
};
export type Room = {
  code: string;
  host: string;
  kind: "friends" | "ai";
  mode: "timed" | "training";
  heroSelection: "free" | "draft";
  stage: "waiting" | "recruit" | "combat" | "finished";
  seats: Seat[];
  pool: Record<string, number>;
  initial: Record<string, number>;
  tribes: Tribe[];
  turn: number;
  rev: number;
  deadline: number;
  updated: number;
  grave?: { hero: string; name: string; board: Minion[]; tier: number };
  online?: string;
  pairings?: [string, string | null][];
  pairingCycle?: PairingCycle;
  lastPairings?: { turn: number; pairs: [string, string | null][] };
  lastEliminations?: { turn: number; victims: string[]; killers: Record<string, string> };
  gameRev?: number;
  storageRev?: number;
};
export const OFFLINE_GRACE_MS = 5 * 60 * 1000;
const score = (m: Minion) =>
  m.attack + m.health + getDef(m.id).tier * 2 + m.keywords.length * 3;
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class Rooms {
  guests = new Map<string, Guest>();
  rooms = new Map<string, Room>();
  seq = 0;
  private roomSnapshots = new WeakMap<Room, { rev: number; json: string }>();
  constructor(
    public now: () => number = Date.now,
    public random: () => number = Math.random,
    private identity = {
      hex: (bytes: number) => randomBytes(bytes).toString("hex"),
      int: (max: number) => randomInt(max),
    },
  ) {}
  touch(r?: Room, publicChange = true) {
    this.seq++;
    if (r) {
      r.storageRev = this.seq;
      r.updated = this.now();
      if (publicChange) r.rev++;
    }
  }
  guest(name: unknown) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      [...name.trim()].length > 16
    )
      throw Error("昵称请填写 1 至 16 个字");
    if (this.guests.size >= 2000) throw Error("游客名额暂满，请稍后再试");
    const token = this.identity.hex(32);
    const g: Guest = {
      id: this.identity.hex(10),
      name: name.trim(),
      hash: tokenHash(token),
      seen: this.now(),
    };
    this.guests.set(g.hash, g);
    this.touch();
    return { token, id: g.id, name: g.name };
  }
  auth(token: string) {
    const g = this.guests.get(tokenHash(token));
    if (!g) throw Error("请重新游客登录");
    const now = this.now();
    if (Math.floor(now / 60000) !== Math.floor(g.seen / 60000)) this.touch();
    g.seen = now;
    return g;
  }
  member(g: Guest) {
    const r = this.rooms.get(g.room || ""),
      p = r?.seats.find((s) => s.id === g.id && !s.left);
    if (!r || !p) throw Error("你当前不在房间中");
    return { r, p };
  }
  seat(g: Guest, hero = "s14_lich"): Seat {
    return {
      id: g.id,
      name: g.name,
      hero,
      bot: false,
      ready: false,
      ended: false,
      continued: false,
      rev: 0,
      requests: [],
    };
  }
  create(g: Guest, kind: "friends" | "ai", hero: string, mode: Room["mode"] = "timed", heroSelection: Room["heroSelection"] = "free") {
    if (mode !== "timed" && mode !== "training") throw Error("无效对局模式");
    if (heroSelection !== "free" && heroSelection !== "draft") throw Error("无效英雄选择方式");
    if (g.room && this.rooms.has(g.room)) throw Error("请先离开当前房间");
    if (this.rooms.size >= 24) throw Error("房间已满，请稍后再试");
    this.validHero(hero);
    let code = "";
    do {
      code = Array.from(
        { length: 6 },
        () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[this.identity.int(32)],
      ).join("");
    } while (this.rooms.has(code));
    const r: Room = {
      code,
      host: g.id,
      kind,
      mode,
      heroSelection,
      stage: "waiting",
      seats: [this.seat(g, heroSelection === "draft" ? "" : hero)],
      pool: {},
      initial: {},
      tribes: [],
      turn: 1,
      rev: 0,
      deadline: 0,
      updated: this.now(),
    };
    if (heroSelection === "draft") this.dealHeroes(r, r.seats[0]);
    this.rooms.set(code, r);
    g.room = code;
    this.touch(r);
    if (kind === "ai" && heroSelection === "free") this.start(g);
    return r;
  }
  availableHeroes(r: Room) {
    const reserved = new Set(r.seats.flatMap((s) => [s.hero, ...(s.heroOffers || [])]));
    return SEASON_HEROES.filter((h) => !reserved.has(h.id));
  }
  dealHeroes(r: Room, p: Seat) {
    const available = this.availableHeroes(r);
    if (available.length < 4) throw Error("英雄池不足，请稍后重试");
    p.heroOffers = Array.from({ length: 4 }, () =>
      available.splice(Math.floor(this.random() * available.length), 1)[0].id);
  }
  refreshHero(g: Guest, slot: number, expectedHero: string) {
    const { r, p } = this.member(g);
    if (r.stage !== "waiting" || r.heroSelection !== "draft") throw Error("当前不能刷新候选英雄");
    if (!Number.isInteger(slot) || slot < 0 || slot >= 4 || !p.heroOffers || p.heroOffers[slot] !== expectedHero)
      throw Error("候选英雄已更新，请重试");
    // Draw before returning the old offer, so refreshing always changes this slot.
    const available = this.availableHeroes(r);
    if (!available.length) throw Error("英雄池暂时没有可用英雄");
    const replacement = available[Math.floor(this.random() * available.length)].id;
    p.heroOffers[slot] = replacement;
    if (p.hero === expectedHero) p.hero = "";
    p.ready = false;
    this.touch(r);
  }
  validHero(hero: string) {
    if (!SEASON_HEROES.some((h) => h.id === hero))
      throw Error("请选择可用英雄");
  }
  join(g: Guest, code: string) {
    if (g.room && this.rooms.has(g.room)) throw Error("请先离开当前房间");
    const r = this.rooms.get(code.toUpperCase());
    if (!r || r.kind !== "friends") throw Error("房间码无效或房间已关闭");
    if (r.stage !== "waiting") throw Error("这局已经开始，暂时不能加入");
    if (r.seats.length >= 8) throw Error("房间已有 8 人");
    const p = this.seat(g, r.heroSelection === "draft" ? "" : this.availableHeroes(r)[0].id);
    if (r.heroSelection === "draft") this.dealHeroes(r, p);
    r.seats.push(p);
    g.room = r.code;
    this.touch(r);
  }
  hero(g: Guest, hero: string) {
    const { r, p } = this.member(g);
    if (r.stage !== "waiting") throw Error("对局中不能换英雄");
    this.validHero(hero);
    if (r.heroSelection === "draft" && !p.heroOffers?.includes(hero)) throw Error("请选择四个候选中的英雄");
    if (r.seats.some((s) => s.id !== p.id && s.hero === hero))
      throw Error("该英雄已被选择");
    p.hero = hero;
    p.ready = false;
    this.touch(r);
  }
  ready(g: Guest, ready: boolean) {
    const { r, p } = this.member(g);
    if (r.stage !== "waiting") throw Error("对局已经开始");
    if (ready && !p.hero) throw Error("请先选择英雄");
    p.ready = ready;
    this.touch(r);
  }
  start(g: Guest) {
    const { r } = this.member(g);
    if (r.host !== g.id) throw Error("只有房主可以开局");
    if (r.stage !== "waiting") throw Error("对局已经开始");
    if (r.seats.some((s) => !s.hero)) throw Error("请等待所有玩家选择英雄");
    if (r.seats.some((s) => s.id !== g.id && !s.ready))
      throw Error("请等待朋友准备");
    if (
      [...this.rooms.values()].filter((x) =>
        ["recruit", "combat"].includes(x.stage),
      ).length >= 6
    )
      throw Error("当前对局较多，请稍后开局");
    const unused = SEASON_HEROES.filter(
      (h) => !r.seats.some((s) => s.hero === h.id),
    );
    for (const p of r.seats) p.heroOffers = undefined;
    while (r.seats.length < 8) {
      const h = unused.splice(Math.floor(this.random() * unused.length), 1)[0];
      r.seats.push({
        id: "bot-" + this.identity.hex(6),
        name: `酒馆人机 ${r.seats.length + 1}`,
        hero: h.id,
        bot: true,
        ready: true,
        ended: false,
        continued: false,
        rev: 0,
        requests: [],
      });
    }
    // Include the selected heroes' required races, then fill to five randomly.
    const required = [...new Set(r.seats.map((s) => HERO_TRIBES[s.hero]).filter(Boolean))];
    const rest = ALL_TRIBES.filter((t) => !required.includes(t));
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    r.tribes = [...required, ...rest.slice(0, 5 - required.length)];
    for (const [seatIndex, p] of r.seats.entries()) {
      p.game = createSeason(p.hero, this.random, {
        tribes: r.tribes,
        pool: Object.keys(r.pool).length ? r.pool : undefined,
      });
      p.game.seatIndex = seatIndex;
      r.pool = p.game.pool;
      r.initial = { ...p.game.season!.initialPool };
      p.rev++;
    }
    r.stage = "recruit";
    r.deadline = r.mode === "training" ? 0 : this.now() + 90000;
    this.opponents(r);
    this.bots(r);
    this.planPairings(r);
    this.touch(r);
  }
  planPairings(r: Room) {
    const alive = this.living(r), members = alive.map(p => p.id);
    if (!r.pairingCycle || JSON.stringify(r.pairingCycle.members) !== JSON.stringify(members))
      r.pairingCycle = createPairingCycle(members, !r.pairingCycle && members.length % 2 === 0 ? 1 : r.turn);
    const bottom = [...alive].sort((a, b) => gameRankingHealth(b.game!) - gameRankingHealth(a.game!)).slice(-3);
    const deaths = r.lastEliminations;
    const soleVictim = deaths?.turn === r.turn - 1 && deaths.victims.length === 1 ? deaths.victims[0] : undefined;
    const killer = soleVictim && r.seats.find(p => p.id === soleVictim)?.hero === r.grave?.hero ? deaths!.killers[soleVictim] : undefined;
    r.pairings = cyclePairings(r.pairingCycle, r.turn, bottom.filter(p => p.id !== killer).map(p => p.id), this.random,
      r.lastPairings?.turn === r.turn - 1 ? r.lastPairings.pairs : []);
    this.opponents(r);
  }
  opponents(r: Room) {
    r.gameRev = (r.gameRev || 0) + 1;
    for (const p of r.seats) {
      if (!p.game) continue;
      const old = p.game.opponents[p.game.nextOpponent]?.hero;
      p.game.opponents = r.seats
        .filter((x) => x.id !== p.id)
        .map((x) => ({
          seatIndex: r.seats.indexOf(x),
          hero: x.hero,
          name: x.name,
          health: x.game?.health || 0,
          armor: x.game?.season?.armor || 0,
          spellArmor: x.game?.season?.spellArmor || 0,
          tier: x.game?.tier || 1,
          scouting: previousScoutRounds(x.game?.scouting, r.turn),
          board: [],
        }));
      p.game.nextOpponent = Math.max(
        0,
        p.game.opponents.findIndex((o) => o.hero === old),
      );
      if (r.stage === "recruit" && r.pairings) {
        const pair = r.pairings.find((pair) => pair.includes(p.id));
        if (pair) {
          const enemyId = pair[0] === p.id ? pair[1] : pair[0];
          const enemy = r.seats.find(
            (x) => x.id === enemyId && x.game!.health > 0 && !x.left,
          );
          if (enemy)
            p.game.nextOpponent = p.game.opponents.findIndex(
              (o) => o.hero === enemy.hero,
            );
          else {
            p.game.nextOpponent = Math.max(
              0,
              p.game.opponents.findIndex(
                (o) => o.hero === r.grave?.hero && o.health <= 0,
              ),
            );
            const ghostIndex = p.game.nextOpponent;
            p.game.opponents[ghostIndex] = {
              hero: r.grave?.hero || p.game.opponents[ghostIndex].hero,
              name: "幽灵阵容",
              health: 0,
              armor: 0,
              tier: r.grave?.tier || 1,
              board: [],
            };
          }
        }
      }
    }
  }
  apply(r: Room, p: Seat, a: Action) {
    p.game!.pool = r.pool;
    const pair = r.pairings?.find((pair) => pair.includes(p.id));
    const opponentId = pair?.find((id) => id !== p.id);
    const opponent = r.seats.find((seat) => seat.id === opponentId);
    // Hero powers may inspect the paired warband inside the rules engine; it must
    // never become part of the player's serialized state or polling response.
    const result = actSeason(p.game!, a, this.random, { opponentBoard: opponent?.game?.board || r.grave?.board || [] });
    if (result.error) return result.error;
    p.game = result.state;
    r.pool = result.state.pool;
    r.gameRev = (r.gameRev || 0) + 1;
    p.rev++;
    if (p.game.health <= 0) {
      this.eliminate(r, p);
      this.opponents(r);
      this.checkFinish(r);
      if (r.stage === "recruit") this.planPairings(r);
      this.touch(r);
    }
    this.touch(r, false);
  }
  autoChoices(r: Room, p: Seat) {
    for (let i = 0; i < 24; i++) {
      const s = p.game!;
      let a: Action | undefined;
      if (s.season!.powerChoice)
        a = { type: "choosePower", uid: s.season!.powerChoice.offers[0] };
      else if (s.discovery.length)
        a = {
          type: "discover",
          uid: [...s.discovery].sort((a, b) => score(b) - score(a))[0].uid,
          ...(s.season?.discoveryKind === "choose" ? { target: seasonTargets(s, [...s.discovery].sort((a, b) => score(b) - score(a))[0], "cast")[0]?.uid } : {}),
        };
      else if (s.season!.trinketOffers.length) {
        const t = s
          .season!.trinketOffers.map((id) => TRINKETS.find((t) => t.id === id)!)
          .filter((t) => t.cost <= s.gold)
          .sort((a, b) => a.cost - b.cost)[0];
        if (t) a = { type: "buyTrinket", uid: t.id };
      }
      if (!a || this.apply(r, p, a)) break;
    }
  }
  bots(r: Room) {
    for (const p of r.seats.filter(
      (x) => x.bot && !x.ended && x.game!.health > 0,
    )) {
      let refreshed = false,
        upgraded = false,
        powered = false;
      for (let n = 0; n < 36; n++) {
        this.autoChoices(r, p);
        const s = p.game!;
        const power = equippedPowers(s).map((id) => heroPowerState(s, id)).find((p) => !p.reason);
        if (s.phase === "over") break;
        let a: Action | undefined;
        const hand = s.hand.find(
          (m) => (m.lockedUntil || 0) <= s.turn && (m.lockedTier || 0) <= s.tier &&
            (getDef(m.id).kind === "spell" ? !![...(getDef(m.id).abilities || []), ...(m.extraAbilities || [])].some((a) => a.event === "cast") : s.board.length < 7),
        );
        if (hand) {
          const spell = getDef(hand.id).kind === "spell";
          const ts = spell
            ? seasonTargets(s, hand, "cast")
            : targetsFor(s, hand);
          a = {
            type: spell ? "cast" : "play",
            uid: hand.uid,
            ...(ts[0] ? { target: ts[0].uid } : {}),
          };
        } else if (
          !powered &&
          power &&
          (s.board.length > 0 || power.id === "s14_xyrella")
        ) {
          a = { type: "power", powerId: power.id, ...(power.needsTarget ? { target: power.targets[0].uid } : {}) };
        } else if (
          !upgraded &&
          s.turn >= 3 &&
          s.tier < 6 &&
          s.gold >= s.upgrade &&
          s.board.length >= Math.min(4, s.turn)
        ) {
          upgraded = true;
          a = { type: "upgrade" };
        } else {
          const offer = [...s.shop]
            .filter((m) => minionCost(s, m) <= s.gold)
            .sort((a, b) => score(b) - score(a))[0];
          if (offer && s.hand.length + s.rewards.length < 10) {
            if (s.board.length < 7) a = { type: "buy", uid: offer.uid };
            else {
              const weak = [...s.board].sort((a, b) => score(a) - score(b))[0];
              if (score(offer) > score(weak) + 3)
                a = { type: "sell", uid: weak.uid };
            }
          }
          if (!a && s.rewards.length) a = { type: "reward" };
          if (!a && !refreshed && s.gold >= refreshCost(s)) {
            refreshed = true;
            a = { type: "refresh" };
          }
        }
        if (!a) break;
        const error = this.apply(r, p, a);
        if (error && a.type === "power") powered = true;
        if (error && a.type !== "power") break;
      }
      p.ended = true;
    }
  }
  action(g: Guest, action: Action, requestId: string, turn: number) {
    const { r, p } = this.member(g);
    if (p.requests.includes(requestId)) return;
    if (!p.game || p.left || p.game.health <= 0)
      throw Error("你已淘汰或对局尚未开始");
    if (turn !== r.turn) throw Error("回合已更新，请重试");
    if (action.type === "end") {
      if (r.stage !== "recruit" || p.ended) throw Error("正在等待其他玩家");
      if (p.game.discovery.length || p.game.season!.trinketOffers.length || p.game.season!.powerChoice)
        throw Error("请先完成英雄技能、发现或饰品选择");
      p.ended = true;
      this.touch(r);
      if (this.living(r).every((x) => x.ended)) this.fight(r);
    } else if (action.type === "continue") {
      if (r.stage !== "combat") throw Error("当前不是战斗阶段");
      p.continued = true;
      this.touch(r);
      if (this.living(r).every((x) => x.bot || x.continued || x.left))
        this.next(r);
    } else {
      if (r.stage !== "recruit" || p.ended)
        throw Error("已结束招募，请等待下一回合");
      const error = this.apply(r, p, action);
      if (error) throw Error(error);
      if (r.stage === "recruit" && this.living(r).every((x) => x.ended))
        this.fight(r);
    }
    p.requests.push(requestId);
    if (p.requests.length > 32) p.requests.shift();
  }
  living(r: Room) {
    return r.seats.filter((p) => p.game && p.game.health > 0 && !p.left);
  }
  eliminate(r: Room, p: Seat) {
    if (p.place) return;
    p.place = this.living(r).length + 1;
    r.grave = {
      hero: p.hero,
      name: p.name,
      board: structuredClone(p.game!.board),
      tier: p.game!.tier,
    };
    p.game!.pool = r.pool;
    releasePlayerCards(p.game!);
    r.pool = p.game!.pool;
    p.ended = true;
    p.continued = true;
    p.rev++;
  }
  checkFinish(r: Room) {
    const alive = this.living(r);
    if (alive.length > 1) return false;
    r.stage = "finished";
    r.deadline = 0;
    for (const p of r.seats) {
      if (p.game) {
        p.game.phase = "over";
        p.rev++;
      }
      if (alive.includes(p)) p.place = 1;
    }
    return true;
  }
  fight(r: Room) {
    const aliveBefore = this.living(r).map(p => p.id);
    const killers: Record<string, string> = {};
    // Apply each player's end effects once, before taking either side's combat snapshots.
    for (const p of this.living(r)) {
      this.autoChoices(r, p);
      p.game!.pool = r.pool;
      endEffects(p.game!, this.random);
      r.pool = p.game!.pool;
      if (p.game!.health <= 0) this.eliminate(r, p);
    }
    this.opponents(r);
    if (this.checkFinish(r)) {
      this.touch(r);
      return;
    }
    if (!r.pairings) this.planPairings(r);
    const dead: Seat[] = [];
    for (const pair of r.pairings!) {
      const players = pair
        .map((id) =>
          r.seats.find((p) => p.id === id && p.game!.health > 0 && !p.left),
        )
        .filter((p): p is Seat => !!p);
      const [a, b] = players;
      if (!a) continue;
      let enemy: Game;
      if (b) enemy = b.game!;
      else {
        enemy = createSeason(
          r.grave?.hero || SEASON_HEROES.find((h) => h.id !== a.hero)!.id,
          this.random,
          { tribes: r.tribes, pool: {} },
        );
        enemy.board = structuredClone(r.grave?.board || []).map((m) => ({
          ...m,
          copies: {},
        }));
        enemy.tier = r.grave?.tier || 1;
        enemy.pool = {};
      }
      a.game!.pool = r.pool;
      if (b) enemy.pool = r.pool;
      const aWarband = warbandLabel(a.game!.board), bWarband = warbandLabel(enemy.board);
      const battle = seasonCombat(
        a.game!,
        enemy.board,
        enemy.tier,
        this.random,
        enemy,
      );
      r.pool = a.game!.pool;
      // Bound the replay payload while preserving the authoritative final result.
      if (battle.frames.length > 180)
        battle.frames = [...battle.frames.slice(0, 179), battle.frames.at(-1)!];
      const enemyName = b?.name || "幽灵阵容";
      recordScoutRound(a.game!, { turn: r.turn, warband: aWarband,
        battle: { opponent: enemyName, result: battle.result, damage: battle.damage } });
      if (b) recordScoutRound(b.game!, { turn: r.turn, warband: bWarband,
        battle: { opponent: a.name, result: battle.result === "win" ? "loss" : battle.result === "loss" ? "win" : "tie", damage: battle.damage } });
      battle.opponent = enemyName;
      a.game!.battle = battle;
      a.battleId = this.identity.hex(12);
      a.game!.phase = "combat";
      a.game!.nextOpponent = b
        ? Math.max(
            0,
            a.game!.opponents.findIndex((o) => o.hero === b.hero),
          )
        : Math.max(
            0,
            a.game!.opponents.findIndex(
              (o) => o.hero === enemy.hero && o.health <= 0,
            ),
          );
      if (!b)
        a.game!.opponents[a.game!.nextOpponent] = {
          name: enemyName,
          hero: enemy.hero,
          health: 0,
          armor: 0,
          tier: enemy.tier,
          board: [],
        };
      a.game!.battles.unshift({
        turn: r.turn,
        result: battle.result,
        damage: battle.damage,
        name: enemyName,
      });
      a.rev++;
      if (b) {
        const mirror: Battle = {
          ...battle,
          result:
            battle.result === "win"
              ? "loss"
              : battle.result === "loss"
                ? "win"
                : "tie",
          opponent: a.name,
          frames: battle.frames.map((f) => ({
            ...f,
            allies: f.enemies,
            enemies: f.allies,
          })),
        };
        b.game!.battle = mirror;
        b.battleId = this.identity.hex(12);
        b.game!.phase = "combat";
        b.game!.nextOpponent = Math.max(
          0,
          b.game!.opponents.findIndex((o) => o.hero === a.hero),
        );
        b.game!.battles.unshift({
          turn: r.turn,
          result: mirror.result,
          damage: mirror.damage,
          name: a.name,
        });
        b.rev++;
      }
      const loser =
        battle.result === "loss" ? a : battle.result === "win" ? b : undefined;
      if (loser) {
        loser.game!.health -= absorbArmor(loser.game!.season!, battle.damage);
        if (loser.game!.health <= 0) {
          dead.push(loser);
          const winner = loser === a ? b : a;
          if (winner) killers[loser.id] = winner.id;
        }
      }
    }
    r.lastPairings = { turn: r.turn, pairs: structuredClone(r.pairings!) };
    // Rank simultaneous eliminations by health after damage, with stable seat order for ties.
    dead.sort((a, b) => a.game!.health - b.game!.health);
    let place = this.living(r).length + dead.length;
    for (const p of dead) {
      this.eliminate(r, p);
      p.place = place--;
    }
    r.lastEliminations = { turn: r.turn, victims: aliveBefore.filter(id => !this.living(r).some(p => p.id === id)), killers };
    r.stage = "combat";
    for (const p of r.seats) {
      p.continued = p.bot || p.game!.health <= 0;
      p.rev++;
      if (p.game!.battles.length > 60) p.game!.battles.length = 60;
    }
    this.opponents(r);
    for (const p of r.seats)
      if (p.game?.battle?.opponent === "幽灵阵容")
        p.game.opponents[p.game.nextOpponent].name = "幽灵阵容";
    const frames = Math.max(
      ...r.seats.map((p) => p.game?.battle?.frames.length || 0),
    );
    r.deadline = r.mode === "training" ? 0 :
      this.now() + Math.max(15000, Math.min(120000, frames * 820 + 5000));
    this.touch(r);
    if (!this.living(r).length) this.next(r);
  }
  next(r: Room) {
    if (this.checkFinish(r)) {
      this.touch(r);
      return;
    }
    r.turn++;
    if (r.turn > 50) {
      const ranking = this.living(r).sort(
        (a, b) =>
          b.game!.health +
          b.game!.season!.armor -
          a.game!.health -
          a.game!.season!.armor,
      );
      ranking.forEach((p, i) => {
        p.place = i + 1;
        p.game!.phase = "over";
      });
      r.stage = "finished";
      for (const p of r.seats) {
        p.game!.phase = "over";
        p.rev++;
      }
      this.touch(r);
      return;
    }
    this.opponents(r);
    for (const p of this.living(r)) {
      p.game!.pool = r.pool;
      advanceRecruit(p.game!, this.random);
      p.battleId = undefined;
      r.pool = p.game!.pool;
      p.ended = false;
      p.continued = false;
      p.rev++;
    }
    for (const p of r.seats.filter((x) => x.game!.health <= 0)) {
      p.game!.phase = "over";
      p.rev++;
    }
    r.stage = "recruit";
    r.deadline = r.mode === "training" ? 0 : this.now() + 90000;
    this.bots(r);
    this.planPairings(r);
    this.touch(r);
  }
  leave(g: Guest) {
    const { r, p } = this.member(g);
    g.room = undefined;
    if (r.stage === "waiting") {
      r.seats = r.seats.filter((s) => s.id !== p.id);
    } else {
      p.left = true;
      if (p.game && p.game.health > 0) {
        p.game.health = 0;
        this.eliminate(r, p);
      }
      if (r.stage === "recruit" && this.living(r).length > 1) this.planPairings(r);
      this.opponents(r);
      this.checkFinish(r);
    }
    const people = r.seats.filter((s) => !s.bot && !s.left);
    if (!people.length) {
      this.rooms.delete(r.code);
      this.touch();
      return;
    }
    if (r.host === g.id) r.host = people[0].id;
    this.touch(r);
    if (r.stage === "recruit" && this.living(r).every((s) => s.ended))
      this.fight(r);
    if (
      r.stage === "combat" &&
      this.living(r).every((s) => s.bot || s.continued)
    )
      this.next(r);
  }
  rematch(g: Guest) {
    const { r } = this.member(g);
    if (r.host !== g.id || r.stage !== "finished")
      throw Error("请等待房主在对局结束后再开");
    r.seats = r.seats
      .filter((s) => !s.bot && !s.left)
      .map((s) => ({
        ...s,
        game: undefined,
        place: undefined,
        ready: false,
        ended: false,
        continued: false,
        requests: [],
        battleId: undefined,
        rev: s.rev + 1,
      }));
    r.pool = {};
    r.initial = {};
    r.turn = 1;
    r.stage = "waiting";
    r.deadline = 0;
    if (r.heroSelection === "draft") {
      for (const p of r.seats) { p.hero = ""; p.heroOffers = undefined; }
      for (const p of r.seats) this.dealHeroes(r, p);
    }
    r.grave = undefined;
    r.pairings = undefined;
    r.pairingCycle = undefined;
    r.lastPairings = undefined;
    r.lastEliminations = undefined;
    this.touch(r);
  }
  tick() {
    const guestsById = new Map([...this.guests.values()].map((g) => [g.id, g]));
    for (const r of this.rooms.values()) {
      const lastHumanSeen = Math.max(
        0,
        ...r.seats
          .filter((s) => !s.bot && !s.left)
          .map((s) => guestsById.get(s.id)?.seen || 0),
      );
      if (
        this.now() - lastHumanSeen >= OFFLINE_GRACE_MS ||
        ((r.mode !== "training" || r.stage === "finished" || r.stage === "waiting") &&
          this.now() - r.updated > (r.stage === "finished" ? 600000 : 7200000))
      ) {
        for (const g of this.guests.values())
          if (g.room === r.code) g.room = undefined;
        this.rooms.delete(r.code);
        this.touch();
        continue;
      }
      if (r.deadline > 0 && r.mode !== "training") {
        if (r.stage === "recruit" && this.now() >= r.deadline) this.fight(r);
        else if (r.stage === "combat" && this.now() >= r.deadline) this.next(r);
      }
      const online = r.seats
        .filter(
          (s) =>
            !s.bot && this.now() - (guestsById.get(s.id)?.seen || 0) < 20000,
        )
        .map((s) => s.id)
        .join(",");
      if (online !== r.online) {
        r.online = online;
        this.touch(r);
      }
    }
    for (const [k, g] of this.guests)
      if (!g.room && this.now() - g.seen > 30 * 86400000) {
        this.guests.delete(k);
        this.touch();
      }
  }
  view(g: Guest, knownBattle = "") {
    const r = this.rooms.get(g.room || ""),
      p = r?.seats.find((s) => s.id === g.id);
    if (!r || !p) {
      g.room = undefined;
      return {
        seq: this.seq,
        version: "none",
        guest: { id: g.id, name: g.name },
        room: null,
        game: null,
        gameVersion: "none",
        battleId: undefined as string | undefined,
      };
    }
    const game = p.game
      ? {
          ...p.game,
          pool: r.pool,
          opponents: p.game.opponents.map((o) => ({ ...o, board: [] })),
          battle:
            p.game.battle && p.battleId && knownBattle === p.battleId
              ? { ...p.game.battle, frames: [] }
              : p.game.battle,
        }
      : null;
    return {
      seq: this.seq,
      version: `${r.code}:${r.rev}:${p.rev}`,
      gameVersion: `${r.code}:${p.rev}:${r.gameRev || 0}`,
      battleId: p.battleId,
      guest: { id: g.id, name: g.name },
      room: {
        code: r.code,
        host: r.host,
        kind: r.kind,
        mode: r.mode,
        heroSelection: r.heroSelection,
        heroOffers: r.stage === "waiting" ? p.heroOffers : undefined,
        stage: r.stage,
        turn: r.turn,
        deadline: r.deadline,
        serverNow: this.now(),
        seats: r.seats.map((s) => ({
          id: s.id,
          name: s.name,
          hero: s.hero,
          bot: s.bot,
          left: !!s.left,
          ready: s.ready,
          ended: s.ended,
          continued: s.continued,
          health: s.game?.health,
          armor: s.game?.season?.armor,
          place: s.place,
          online: s.bot || !!r.online?.split(",").includes(s.id),
        })),
      },
      game,
    };
  }
  dump() {
    const rooms = [...this.rooms.values()].map((r) => {
      const rev = r.storageRev || 0,
        cached = this.roomSnapshots.get(r);
      if (cached?.rev === rev) return cached.json;
      const json = JSON.stringify(r);
      this.roomSnapshots.set(r, { rev, json });
      return json;
    });
    return `{"schema":1,"seq":${this.seq},"guests":${JSON.stringify([...this.guests.values()])},"rooms":[${rooms.join(",")}]}`;
  }
  restore(raw: string) {
    const data = JSON.parse(raw);
    if (data.schema !== 1) throw Error("Unsupported room save");
    this.seq = data.seq || 0;
    this.guests = new Map(data.guests.map((g: Guest) => [g.hash, g]));
    this.rooms = new Map(data.rooms.map((r: Room) => [r.code, r]));
    this.roomSnapshots = new WeakMap();
    for (const r of this.rooms.values()) {
      r.mode = r.mode === "training" ? "training" : "timed";
      r.heroSelection = r.heroSelection === "draft" ? "draft" : "free";
      if (r.mode === "training") r.deadline = 0;
      // The previous server did not persist idle heartbeats. Give its rooms
      // one grace period on migration instead of evicting connected guests.
      if (r.storageRev === undefined) {
        for (const g of this.guests.values())
          if (g.room === r.code) g.seen = this.now();
      }
      for (const [seatIndex, p] of r.seats.entries()) {
        if (p.game) p.game.seatIndex = seatIndex;
        if (p.game && p.game.health <= 0 && !p.place) this.eliminate(r, p);
        if (p.game?.battle && !p.battleId)
          p.battleId = this.identity.hex(12);
      }
      if (r.stage === "recruit" && !r.pairings) this.planPairings(r);
      this.touch(r);
    }
  }
}
export type OnlineState = ReturnType<Rooms["view"]>;
