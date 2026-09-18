import { evaluateTavern, readLearnedLedger, type Judgment } from './judgment';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { Rooms, judgmentVersion, type Room, type Seat, type Guest, type AIModel, type AIModelOption } from './rooms';
import { ACTIONS, candidates } from '../rl/actions';
import { inferenceProfile } from './neural-profile';
import { actSeason } from '../src/season/engine';
import { withSimulation } from '../src/simulation';
import type { Action } from '../src/engine';

export const runtimeSchema = inferenceProfile().schema;
export const contract = inferenceProfile().contract;
type Memory = { memory: number[]; previous: number; turn: number; decisions: number };
type Choice = { action: number; memory: number[]; probabilities?: [number, number][]; selectionMode?: 'sample' | 'greedy' | 'search'; ledger?: unknown };
type Prediction = { rows: Choice[] };
type PendingDecision = { turn: number; rev: number; pairings: Room['pairings']; chosen: Choice; action: Action };
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
  private previews = new WeakMap<Seat, PendingDecision>();
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
  private judgments = new WeakMap<Seat, { version: string; result: Promise<Judgment> }>();
  async judgment(guest: Guest, version: string): Promise<Judgment> {
    const { r, p } = this.member(guest);
    const current = () => judgmentVersion(r, p);
    const fresh = () => this.rooms.get(r.code) === r && guest.room === r.code && !p.left &&
      !p.bot && !p.ended && r.stage === 'recruit' && !!p.game && p.game.health > 0 && current() === version;
    if (r.kind !== 'ai' || !fresh()) throw Error('局面已更新或不在人机招募阶段');
    const cached = this.judgments.get(p);
    if (cached?.version === version) return cached.result;
    // Only one request per player can be in flight, including across changed positions.
    if (cached) await cached.result.catch(() => undefined);
    if (!fresh()) throw Error('局面已更新，请重新分析');
    const latest = this.judgments.get(p);
    if (latest?.version === version) return latest.result;
    const result = this.calculateJudgment(r, p, version, fresh);
    this.judgments.set(p, { version, result });
    const clear = () => { if (this.judgments.get(p)?.result === result) this.judgments.delete(p); };
    void result.then(response => { if (response.policyError) clear(); }, clear);
    return result;
  }
  private async calculateJudgment(r: Room, p: Seat, version: string, fresh: () => boolean): Promise<Judgment> {
    const game = structuredClone({ ...p.game!, pool: r.pool });
    const evaluation = evaluateTavern(game);
    const response: Judgment = { version, evaluation };
    try {
      const model = this.model(r);
      const valid = new Map<number, Action>();
      const pair = r.pairings?.find(pair => pair.includes(p.id));
      const enemy = r.seats.find(seat => seat.id === pair?.find(id => id !== p.id));
      const opponentBoard = structuredClone(enemy?.game?.board || r.grave?.board || []);
      let checked = 0;
      for (const [id, action] of candidates(game, false)) {
        let uid = 0;
        const error = ['end', 'move', 'freeze'].includes(action.type) ? undefined : withSimulation(
          { uid: () => `advisor-${uid++}`, recordLogs: false, recordFrames: false },
          () => actSeason(game, action, () => .5, { opponentBoard }).error);
        if (!error) valid.set(id, action);
        if (++checked % 16 === 0) await yieldLoop();
        if (!fresh()) throw Error('stale');
      }
      if (!valid.size) throw Error('No legal actions');
      // A current-position advisor. It has no bot memory and never applies an action.
      const result = await model.infer({ probabilities: true, judgment: true, search: false,
        checkpointSha256: model.checkpointSha256, contract: model.observation.contract,
        rows: [{ entities: model.observation.observe(game, 0, 64), legal: [...valid.keys()],
          memory: Array(128).fill(0), previous: ACTIONS.length }] });
      const rows = result.rows?.[0]?.probabilities;
      const probabilities = new Map<number, number>();
      if (!Array.isArray(rows)) throw Error('Missing probabilities');
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || !valid.has(row[0]) || probabilities.has(row[0]) ||
          !Number.isFinite(row[1]) || row[1] < 0 || row[1] > 1) throw Error('Invalid probabilities');
        probabilities.set(row[0], row[1]);
      }
      if (probabilities.size !== valid.size || Math.abs([...probabilities.values()].reduce((a,b) => a+b, 0)-1) > .0001)
        throw Error('Invalid distribution');
      response.decision = { id: version, turn: r.turn, mode: 'greedy',
        choices: [...valid].map(([id, action]) => ({ action, probability: probabilities.get(id)!, selected: false })) };
      if (result.rows[0].ledger !== undefined) {
        try { response.learned = readLearnedLedger(result.rows[0].ledger,evaluation); }
        catch { response.learnedError = '模型逐牌估值校验未通过，暂时只显示规则分。'; }
      }
    } catch {
      response.policyError = '模型动作概率暂不可用，仍可查看逐牌规则估值。';
    }
    if (!fresh()) throw Error('局面已更新，请重新分析');
    return response;
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
    if (r.watch) {
      const watched = r.seats.find(seat => seat.id === r.host)!;
      if (this.now() < (this.models.get(r.aiModel?.id || '')?.retryAt || 0)) return false;
      if (r.watch.error || watched.game && watched.game.health <= 0) return false;
      if (p.id === r.host) {
        if (this.previews.has(p) && !r.watch.step && (r.watch.paused || this.now() < r.watch.nextAt)) return false;
      } else if (r.watch.paused && !watched.ended) return false;
    }
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
    if (r.watch) {
      r.watch.error = error instanceof Error && error.message === 'Missing policy probabilities'
        ? '推理服务尚未提供策略概率，请更新推理服务后重试。'
        : '模型推理暂时不可用，已暂停观战。可以点击播放重试。';
      r.watch.paused = true; r.watch.step = false; r.watch.decision = undefined;
      for (const p of r.seats) this.previews.delete(p);
      this.touch(r);
    } else this.heuristic(r);
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
    if (state.turn !== turn) { state.turn = turn; state.decisions = 0; }
    const preview = this.previews.get(p);
    if (preview) {
      this.previews.delete(p);
      if (r.watch) { r.watch.decision = undefined; r.watch.step = false; this.touch(r); }
      if (preview.turn === turn && preview.rev === rev && preview.pairings === pairings) {
        this.execute(r, p, model, state, preview.chosen, preview.action);
        return;
      }
    }
    // The model gets the same public projection as training. Private enemy boards
    // are supplied only to the authoritative rule validator, never to inference.
    const s = { ...p.game!, pool: r.pool };
    const pair = r.pairings?.find(pair => pair.includes(p.id));
    const enemy = r.seats.find(seat => seat.id === pair?.find(id => id !== p.id));
    const valid = new Map<number, Action>();
    let checked = 0;
    for (const [id, action] of candidates(s, !model.search && state.decisions >= 64)) {
      let uid = 0;
      const error = ['end', 'move', 'freeze'].includes(action.type) ? undefined : withSimulation(
        { uid: () => `preview-${uid++}`, recordLogs: false, recordFrames: false },
        () => actSeason(s, action, () => 0.5, { opponentBoard: enemy?.game?.board || r.grave?.board || [] }).error,
      );
      if (!error) valid.set(id, action);
      if (++checked % 16 === 0) await yieldLoop();
      if (!fresh()) return;
    }
    if (!valid.size || !model.search && state.decisions >= 96) throw Error('Neural action limit or unresolved mandatory choice');
    const result = await model.infer({ ...(r.watch && p.id === r.host ? { probabilities: true } : {}), checkpointSha256: model.checkpointSha256, contract: model.observation.contract,
      ...(model.search ? { search: true, searchTimeMs: recruitSearchBudget(r.mode === 'training' ? 0 : r.deadline,
        this.now(), this.living(r).filter(seat => seat.bot && !seat.ended).length) } : {}), rows: [{ entities: model.observation.observe(s, state.decisions, 64),
      legal: [...valid.keys()], memory: state.memory, previous: state.previous }] });
    if (!fresh()) return;
    const chosen = result.rows?.[0];
    if (!chosen || !Number.isInteger(chosen.action) || !valid.has(chosen.action) ||
        chosen.memory?.length !== 128 || !chosen.memory.every(Number.isFinite)) throw Error('Invalid neural response');
    const action = valid.get(chosen.action)!;
    if (r.watch && p.id === r.host) {
      if (!chosen.probabilities) throw Error('Missing policy probabilities');
      const probabilities = new Map<number, number>();
      for (const row of chosen.probabilities) {
        if (!Array.isArray(row) || row.length !== 2 || !valid.has(row[0]) || probabilities.has(row[0]) ||
            !Number.isFinite(row[1]) || row[1] < 0 || row[1] > 1) throw Error('Invalid policy probabilities');
        probabilities.set(row[0], row[1]);
      }
      if (probabilities.size !== valid.size || Math.abs([...probabilities.values()].reduce((a,b) => a+b, 0) - 1) > .0001 ||
          !['sample', 'greedy', 'search'].includes(chosen.selectionMode || '')) throw Error('Invalid policy distribution');
      r.watch.decision = { id: `${turn}:${rev}:${state.decisions}`, turn, mode: chosen.selectionMode!,
        choices: [...valid].map(([id, action]) => ({ action, probability: probabilities.get(id)!, selected: id === chosen.action })) };
      r.watch.nextAt = this.now() + 2000;
      this.previews.set(p, { turn, rev, pairings, chosen, action });
      this.touch(r);
      return;
    }
    this.execute(r, p, model, state, chosen, action);
  }
  private execute(r: Room, p: Seat, model: ModelRuntime, state: Memory, chosen: Choice, action: Action) {
    if (action.type === 'end') { p.ended = true; this.touch(r); }
    else {
      const error = this.apply(r, p, action);
      // The shared pool can change while awaiting inference. Retry with a fresh mask.
      if (error) { state.decisions++; return; }
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
            if (r.watch) continue;
            this.heuristic(r);
          } else await this.decision(r, p);
        } catch (error) { this.fallback(r, error); }
        await yieldLoop();
      }
    }
  }
}
