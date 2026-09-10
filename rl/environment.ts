import { Rooms, tokenHash, type Guest, type Room } from "../server/rooms";
import { actSeason } from "../src/season/engine";
import { type Action } from "../src/engine";
import { SEASON_HEROES, HERO_TRIBES } from "../src/season/catalog";
import { withSimulation } from "../src/simulation";
import { ACTIONS, candidates } from "./actions";
import { observe, CARD_IDS, HERO_IDS } from "./observation";
import coverage from "../docs/rules-coverage.json";

declare const RL_SOURCE_HASH: string;
export const META = {
  schema: "tavern-selfplay-v2", observationVersion: 2, actionVersion: 2,
  sourceHash: typeof RL_SOURCE_HASH === "undefined" ? "development" : RL_SOURCE_HASH,
  actionCount: ACTIONS.length, cardIds: CARD_IDS, heroIds: HERO_IDS,
  patch: coverage.patch, coverage: { minions: coverage.minions, heroes: coverage.heroes, spells: coverage.tavernSpells, trinkets: coverage.trinkets },
  opponents: "neural self-play only", reward: "(4.5 - placement) / 3.5", seats: 8,
};
export class Random {
  constructor(public state: number) { this.state >>>= 0; }
  next = () => {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
class SelfPlayRooms extends Rooms {
  override bots(r: Room) {
    if (r.seats.length !== 8 || r.seats.some(p => p.bot)) throw Error("Self-play requires eight policy-controlled seats");
  }
  override autoChoices(r: Room, p: Room["seats"][number]) {
    const s = p.game!;
    if (s.discovery.length || s.season!.powerChoice || s.season!.trinketOffers.length)
      throw Error(`Unresolved policy decision before combat, seat ${r.seats.indexOf(p)}`);
  }
}
export interface Options { maxActionsPerTurn: number; maxSteps: number; recordFrames: boolean; heroes?: string[] }
export class SelfPlayEnv {
  options: Options;
  rng = new Random(0);
  seed = 0;
  uidCounter = 0;
  identityCounter = 0;
  now = 100000;
  steps = 0;
  actor = 0;
  actionsInTurn = Array(8).fill(0);
  truncated = false;
  store!: SelfPlayRooms;
  room!: Room;
  guests!: Guest[];
  tape: number[] = [];
  replays: unknown[] = [];
  private legalCache?: Map<number, Action>;
  constructor(options: Partial<Options> = {}) {
    this.options = { maxActionsPerTurn: 64, maxSteps: 30000, recordFrames: false, ...options };
    if (!Number.isInteger(this.options.maxActionsPerTurn) || this.options.maxActionsPerTurn < 1 || !Number.isInteger(this.options.maxSteps) || this.options.maxSteps < 1) throw Error("Invalid decision limits");
  }
  private scoped<T>(run: () => T, preview = false): T {
    const random = this.rng.state, serial = this.uidCounter;
    try {
      return withSimulation({ uid: () => `sim-${++this.uidCounter}`, recordFrames: !preview && this.options.recordFrames, recordLogs: false }, run);
    } finally {
      if (preview) { this.rng.state = random; this.uidCounter = serial; }
    }
  }
  private createStore() {
    return new SelfPlayRooms(() => this.now, this.rng.next, {
      hex: bytes => (++this.identityCounter).toString(16).padStart(bytes * 2, "0"),
      int: max => this.identityCounter++ % max,
    });
  }
  reset(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error("Seed must be uint32");
    this.seed = seed; this.rng = new Random(seed); this.uidCounter = 0; this.identityCounter = 0;
    this.now = 100000; this.steps = 0; this.actor = seed % 8; this.actionsInTurn = Array(8).fill(0);
    this.truncated = false; this.legalCache = undefined; this.tape = []; this.replays = [];
    this.store = this.createStore();
    this.scoped(() => {
      const required = new Set<string>();
      const heroes: string[] = [];
      for (let i = 0; i < 8; i++) {
        const available = SEASON_HEROES.filter(h => !heroes.includes(h.id) && (!HERO_TRIBES[h.id] || required.has(HERO_TRIBES[h.id]) || required.size < 5));
        const id = this.options.heroes?.[i] || available[Math.floor(this.rng.next() * available.length)].id;
        if (!available.some(h => h.id === id)) throw Error("Heroes must be distinct, implemented and compatible with five tribes");
        heroes.push(id);
        if (HERO_TRIBES[id]) required.add(HERO_TRIBES[id]);
      }
      if (this.options.heroes && this.options.heroes.length !== 8) throw Error("Exactly eight heroes required");
      this.guests = Array.from({ length: 8 }, (_, i) => this.store.auth(this.store.guest(`策略 ${i + 1}`).token));
      this.room = this.store.create(this.guests[0], "friends", heroes[0], "training", "free");
      for (const guest of this.guests.slice(1)) this.store.join(guest, this.room.code);
      // Clear default lobby selections together before assigning the random distinct heroes.
      this.room.seats.forEach((p, i) => { p.hero = heroes[i]; p.ready = true; });
      this.store.start(this.guests[0]);
    });
    return this.view();
  }
  get terminated() { return this.room?.stage === "finished"; }
  legalActions() {
    if (this.terminated || this.truncated) return new Map<number, Action>();
    if (this.legalCache) return this.legalCache;
    const s = this.room.seats[this.actor].game!;
    s.pool = this.room.pool;
    const choices = candidates(s, this.actionsInTurn[this.actor] >= this.options.maxActionsPerTurn);
    const pair = this.room.pairings?.find(p => p.includes(this.guests[this.actor].id));
    const enemy = this.room.seats.find(p => p.id === pair?.find(id => id !== this.guests[this.actor].id));
    const valid = new Map<number, Action>();
    for (const [id, action] of choices) {
      // These operations have no additional feasibility rules after the candidate gates.
      if (["end", "move", "freeze"].includes(action.type)) { valid.set(id, action); continue; }
      const check = this.scoped(() => actSeason(s, action, this.rng.next, { opponentBoard: enemy?.game?.board || this.room.grave?.board || [] }), true);
      if (!check.error) valid.set(id, action);
    }
    if (!valid.size) throw Error(`No legal actions for seat ${this.actor}, turn ${this.room.turn}`);
    this.legalCache = valid;
    return valid;
  }
  view() {
    const done = this.terminated || this.truncated;
    const s = this.room.seats[this.actor].game!;
    const observation = this.scoped(() => observe(s, this.actionsInTurn[this.actor], this.options.maxActionsPerTurn), true);
    if (observation.some(n => !Number.isFinite(n))) throw Error("Non-finite observation");
    return {
      actor: done ? null : this.actor, observation,
      legalActions: [...this.legalActions().keys()],
      terminated: this.terminated, truncated: this.truncated,
      info: {
        turn: this.room.turn, steps: this.steps,
        placements: this.room.seats.map(p => p.place ?? null),
        rewards: this.room.seats.map(p => p.place ? (4.5 - p.place) / 3.5 : 0),
        actionLimitReached: !done && this.actionsInTurn[this.actor] >= this.options.maxActionsPerTurn,
      },
    };
  }
  step(id: number) {
    if (this.terminated || this.truncated) throw Error("Episode ended; reset required");
    if (!Number.isInteger(id) || !this.legalActions().has(id)) throw Error(`Illegal action ${id} for seat ${this.actor}`);
    const action = this.legalActions().get(id)!, previousActor = this.actor, previousTurn = this.room.turn;
    this.scoped(() => {
      this.store.action(this.guests[this.actor], action, `rl-${this.steps}`, this.room.turn);
      this.actionsInTurn[this.actor]++;
      this.steps++; this.now++; this.tape.push(id); this.legalCache = undefined;
      if (this.room.stage === "combat") {
        if (this.options.recordFrames) this.replays.push({ turn: previousTurn, battles: this.room.seats.map((p, seat) => ({ seat, battle: p.game!.battle })) });
        // Combat playback is presentation, not a policy decision. Advance every living seat.
        for (const p of this.room.seats) if (this.room.stage === "combat" && p.game!.health > 0 && !p.left)
          this.store.action(this.guests[this.room.seats.indexOf(p)], { type: "continue" }, `continue-${this.steps}`, this.room.turn);
      }
      if (this.room.turn !== previousTurn) this.actionsInTurn.fill(0);
      if (!this.terminated) {
        // Interleave recruit actions instead of letting one policy empty the pool first.
        const start = this.room.turn !== previousTurn ? (this.seed + this.room.turn - 1) % 8 : (previousActor + 1) % 8;
        for (let offset = 0; offset < 8; offset++) {
          const next = (start + offset) % 8, p = this.room.seats[next];
          if (p.game!.health > 0 && !p.ended && !p.left) { this.actor = next; break; }
        }
      }
      this.truncated = !this.terminated && this.steps >= this.options.maxSteps;
    });
    return this.view();
  }
  snapshot() {
    return structuredClone({ schema: META.schema, sourceHash: META.sourceHash, options: this.options, seed: this.seed,
      rng: this.rng.state, uidCounter: this.uidCounter, identityCounter: this.identityCounter,
      now: this.now, steps: this.steps, actor: this.actor, actionsInTurn: this.actionsInTurn,
      truncated: this.truncated, seq: this.store.seq, room: this.room, guests: this.guests, tape: this.tape, replays: this.replays });
  }
  restore(saved: ReturnType<SelfPlayEnv["snapshot"]>) {
    if (saved.schema !== META.schema || saved.sourceHash !== META.sourceHash) throw Error("Incompatible environment snapshot");
    const s = structuredClone(saved);
    this.options = s.options; this.seed = s.seed; this.rng = new Random(s.rng); this.uidCounter = s.uidCounter;
    this.identityCounter = s.identityCounter; this.now = s.now; this.steps = s.steps; this.actor = s.actor;
    this.actionsInTurn = s.actionsInTurn; this.truncated = s.truncated; this.tape = s.tape; this.replays = s.replays;
    this.store = this.createStore(); this.room = s.room; this.guests = s.guests; this.store.seq = s.seq;
    this.store.rooms.set(this.room.code, this.room);
    this.guests.forEach(g => this.store.guests.set(g.hash, g));
    this.legalCache = undefined;
    return this.view();
  }
}
