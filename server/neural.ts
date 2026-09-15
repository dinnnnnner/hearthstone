import { setImmediate as yieldLoop } from 'node:timers/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Rooms, type Room, type Seat, type AIModel, type AIModelOption } from './rooms';
import { ACTIONS, candidates } from '../rl/actions';
import { inferenceProfile } from './neural-profile';
import { actSeason } from '../src/season/engine';
import { withSimulation } from '../src/simulation';
import type { Action } from '../src/engine';

export const runtimeSchema = inferenceProfile().schema;
export const contract = inferenceProfile().contract;
type Memory = { memory: number[]; previous: number; turn: number; decisions: number; positions?: Set<string> };
type Prediction = { rows: { action: number; memory: number[] }[] };
type Traffic = { requests: number; rawRequestBytes: number; requestBytes: number; responseBytes: number; maxKbps: number };
export type Infer = { (body: unknown): Promise<Prediction>; traffic?: Traffic };

export function inferenceBudget(maxKbps = 0) {
  if (!Number.isFinite(maxKbps) || maxKbps < 0) throw Error('Invalid inference bandwidth limit');
  return { nextRequest: 0, traffic: { requests: 0, rawRequestBytes: 0, requestBytes: 0, responseBytes: 0, maxKbps } as Traffic };
}
export function httpInference(url: string, options: { compress?: boolean; maxKbps?: number; budget?: ReturnType<typeof inferenceBudget> } = {}): Infer {
  const endpoint = new URL(url);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.protocol !== 'http:')
    throw Error('Inference must use loopback HTTP; use an SSH tunnel for remote inference');
  const budget = options.budget ?? inferenceBudget(options.maxKbps ?? 0);
  const traffic = budget.traffic, maxKbps = traffic.maxKbps;
  const infer: Infer = async body => {
    const raw = Buffer.from(JSON.stringify(body));
    const payload = options.compress ? gzipSync(raw) : raw;
    if (maxKbps) {
      const now = performance.now(), sendAt = Math.max(now, budget.nextRequest);
      // Include a conservative allowance for HTTP, SSH and transport headers.
      budget.nextRequest = sendAt + (payload.length + 512) * 8 / maxKbps;
      if (sendAt > now) await delay(sendAt - now);
    }
    traffic.requests++; traffic.rawRequestBytes += raw.length; traffic.requestBytes += payload.length;
    const response = await fetch(new URL('/predict', endpoint), {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(options.compress ? { 'Content-Encoding': 'gzip', 'Accept-Encoding': 'gzip' } : {}) },
      body: payload, signal: AbortSignal.timeout(5000),
    });
    traffic.responseBytes += Number(response.headers.get('Content-Length')) || 0;
    if (!response.ok) throw Error(`Inference HTTP ${response.status}`);
    return await response.json() as Prediction;
  };
  infer.traffic = traffic;
  return infer;
}

export type NeuralModel = AIModel & { infer: Infer; profile: string; search?: boolean; health?: () => Promise<boolean> };

/** Reserve time for remaining actions and other bots; never extend the game clock. */
export function recruitSearchBudget(deadline: number, now: number, pendingBots: number) {
  if (!deadline) return 1000;
  const remaining = deadline - now - 2000;
  return remaining <= 0 ? 0 : Math.min(1000, Math.max(0, Math.floor(remaining / Math.max(1, pendingBots) / 20)));
}
type ModelRuntime = NeuralModel & { observation: ReturnType<typeof inferenceProfile>; available: boolean;
  retryAt: number; decisions: number; errors: number; fallbackRounds: number };

/** One global asynchronous queue; weak seat keys release memory with recycled rooms. */
export class NeuralRooms extends Rooms {
  private memories = new WeakMap<Seat, Memory>();
  private running = false;
  private stopped = false;
  private models = new Map<string, ModelRuntime>();
  private healthAt = 0;
  private checkingHealth = false;
  readonly ai;
  constructor(infer: Infer, now = Date.now, random = Math.random, profile = 'legacy-v3', models?: NeuralModel[]) {
    super(now, random);
    for (const model of models ?? [{ id: 'default', label: '训练模型', infer, profile }]) {
      if (!model.id || this.models.has(model.id)) throw Error('Duplicate or empty inference model ID');
      this.models.set(model.id, { ...model, observation: inferenceProfile(model.profile),
        available: !model.health, retryAt: 0, decisions: 0, errors: 0, fallbackRounds: 0 });
    }
    if (!this.models.size) throw Error('No inference models configured');
    const first = [...this.models.values()][0];
    this.ai = { mode: 'neural', decisions: 0, errors: 0, fallbackRounds: 0, lastError: '',
      contract: first.observation.contract, profile: first.profile, traffic: first.infer.traffic };
  }
  override bots(_r: Room) { this.schedule(); }
  override modelOptions(): AIModelOption[] {
    return [...this.models.values()].map(({ id, label, episodes, checkpointSha256, available }) =>
      ({ id, label, episodes, checkpointSha256, available }));
  }
  modelStats() {
    return [...this.models.values()].map(({ id, decisions, errors, fallbackRounds, available }) =>
      ({ id, decisions, errors, fallbackRounds, available }));
  }
  async checkModels() {
    if (this.checkingHealth || this.stopped) return;
    this.checkingHealth = true;
    try {
      await Promise.all([...this.models.values()].map(async model => {
        if (model.health) model.available = await model.health().catch(() => false);
      }));
    } finally { this.checkingHealth = false; this.healthAt = this.now() + 10000; }
  }
  private model(r: Room) {
    const model = this.models.get(r.aiModel?.id ?? this.modelOptions()[0].id);
    if (!model || (r.aiModel?.checkpointSha256 && r.aiModel.checkpointSha256 !== model.checkpointSha256))
      throw Error('Saved room model version is unavailable');
    return model;
  }
  override tick() {
    super.tick(); this.schedule();
    if (this.now() >= this.healthAt) void this.checkModels();
  }
  stop() { this.stopped = true; }
  private active(r: Room, p: Seat, turn: number) {
    return !this.stopped && this.rooms.get(r.code) === r && r.turn === turn &&
      r.stage === 'recruit' && p.bot && !p.left && !p.ended && !!p.game && p.game.health > 0;
  }
  private schedule() {
    if (this.running || this.stopped) return;
    this.running = true;
    // Pairings and recruit setup finish before observations are collected.
    setImmediate(() => { void this.run().catch(error => {
      this.ai.errors++; this.ai.lastError = String(error); this.ai.mode = 'fallback';
      console.error('Neural queue failed:', error);
    }).finally(() => { this.running = false; }); });
  }
  private heuristic(r: Room) {
    this.ai.fallbackRounds++;
    const model = this.models.get(r.aiModel?.id ?? this.modelOptions()[0].id);
    if (model) model.fallbackRounds++;
    r.aiStatus = 'fallback';
    for (const p of r.seats) if (p.bot) this.memories.delete(p);
    super.bots(r);
    this.touch(r);
    if (r.stage === 'recruit' && this.living(r).every(p => p.ended)) this.fight(r);
  }
  private fallback(r: Room, error: unknown) {
    this.ai.errors++;
    this.ai.lastError = error instanceof Error ? error.message : String(error);
    this.ai.mode = 'fallback';
    const model = this.models.get(r.aiModel?.id ?? this.modelOptions()[0].id);
    if (model) { model.retryAt = this.now() + 10000; model.errors++; model.available = false; }
    console.error('Neural inference unavailable:', this.ai.lastError);
    if (this.rooms.get(r.code) !== r || r.stage !== 'recruit' || this.stopped) return;
    this.heuristic(r);
  }
  private async decision(r: Room, p: Seat) {
    const model = this.model(r);
    const turn = r.turn, rev = p.rev, pairings = r.pairings;
    const fresh = () => this.active(r, p, turn) && p.rev === rev && r.pairings === pairings;
    let state = this.memories.get(p);
    if (!state) {
      state = { memory: Array(128).fill(0), previous: ACTIONS.length, turn, decisions: 0 };
      this.memories.set(p, state);
    }
    if (state.turn !== turn) { state.turn = turn; state.decisions = 0; state.positions = undefined; }
    // The model gets the same public projection as training. Private enemy boards
    // are supplied only to the authoritative rule validator, never to inference.
    const s = { ...p.game!, pool: r.pool };
    const position = (game: typeof s) => createHash('sha256').update(JSON.stringify(model.observation.observe(game, 0, 64))).digest('hex');
    if (model.search) {
      state.positions ??= new Set();
      state.positions.add(position(s));
      if (state.positions.size > 128) state.positions.delete(state.positions.values().next().value!);
    }
    const pair = r.pairings?.find(pair => pair.includes(p.id));
    const enemy = r.seats.find(seat => seat.id === pair?.find(id => id !== p.id));
    const valid = new Map<number, Action>();
    let checked = 0;
    for (const [id, action] of candidates(s, !model.search && state.decisions >= 64)) {
      let uid = 0;
      if (model.search && ['move', 'freeze'].includes(action.type)) {
        const preview = withSimulation({ uid: () => `preview-${uid++}`, recordLogs: false, recordFrames: false },
          () => actSeason(s, action, () => .5));
        // Prune reversible cycles in the AI's choices, not productive operations
        // or the rules' action count. Only public observations enter this cache.
        if (!preview.error && state.positions!.has(position(preview.state))) continue;
      }
      const error = ['end', 'move', 'freeze'].includes(action.type) ? undefined : withSimulation(
        { uid: () => `preview-${uid++}`, recordLogs: false, recordFrames: false },
        () => actSeason(s, action, () => 0.5, { opponentBoard: enemy?.game?.board || r.grave?.board || [] }).error,
      );
      if (!error) valid.set(id, action);
      if (++checked % 16 === 0) await yieldLoop();
      if (!fresh()) return;
    }
    if (!valid.size || !model.search && state.decisions >= 96) throw Error('Neural action limit or unresolved mandatory choice');
    const result = await model.infer({ checkpointSha256: model.checkpointSha256, contract: model.observation.contract,
      ...(model.search ? { search: true, searchTimeMs: recruitSearchBudget(r.mode === 'training' ? 0 : r.deadline,
        this.now(), this.living(r).filter(seat => seat.bot && !seat.ended).length) } : {}), rows: [{ entities: model.observation.observe(s, state.decisions, 64),
      legal: [...valid.keys()], memory: state.memory, previous: state.previous }] });
    if (!fresh()) return;
    const chosen = result.rows?.[0];
    if (!chosen || !Number.isInteger(chosen.action) || !valid.has(chosen.action) ||
        chosen.memory?.length !== 128 || !chosen.memory.every(Number.isFinite)) throw Error('Invalid neural response');
    const action = valid.get(chosen.action)!;
    if (action.type === 'end') { p.ended = true; this.touch(r); }
    else {
      const error = this.apply(r, p, action);
      // The shared pool can change while awaiting inference. Retry with a fresh mask.
      if (error) { state.decisions++; return; }
      if (!['move', 'freeze'].includes(action.type)) state.positions?.clear();
    }
    state.memory = chosen.memory; state.previous = chosen.action; state.decisions++;
    this.ai.decisions++; this.ai.mode = 'neural';
    model.decisions++; model.available = true;
    if (r.aiStatus !== 'neural') { r.aiStatus = 'neural'; this.touch(r); }
    if (r.stage === 'recruit' && this.living(r).every(seat => seat.ended)) this.fight(r);
  }
  private async run() {
    let pending = true;
    while (pending && !this.stopped) {
      pending = false;
      for (const r of this.rooms.values()) for (const p of r.seats) {
        if (!this.active(r, p, r.turn)) continue;
        pending = true;
        try {
          if (this.now() < this.model(r).retryAt) {
            this.heuristic(r);
          } else await this.decision(r, p);
        } catch (error) { this.fallback(r, error); }
        await yieldLoop();
      }
    }
  }
}
