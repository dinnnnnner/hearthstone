import { createHash } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { Rooms, type Room, type Seat } from './rooms';
import { ACTIONS, candidates } from '../rl/actions';
import { ENTITY_SCHEMA, observeEntities } from './neural-observation';
import { actSeason } from '../src/season/engine';
import { withSimulation } from '../src/simulation';
import type { Action } from '../src/engine';

export const runtimeSchema = JSON.stringify({ actions: ACTIONS, entity_schema: ENTITY_SCHEMA });
export const contract = createHash('sha256').update(runtimeSchema).digest('hex');
type Memory = { memory: number[]; previous: number; turn: number; decisions: number };
type Prediction = { rows: { action: number; memory: number[] }[] };
export type Infer = (body: unknown) => Promise<Prediction>;

export function httpInference(url: string): Infer {
  const endpoint = new URL(url);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.protocol !== 'http:')
    throw Error('Inference must use loopback HTTP; use an SSH tunnel for remote inference');
  return async body => {
    const response = await fetch(new URL('/predict', endpoint), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error(`Inference HTTP ${response.status}`);
    return await response.json() as Prediction;
  };
}

/** One global asynchronous queue; weak seat keys release memory with recycled rooms. */
export class NeuralRooms extends Rooms {
  private memories = new WeakMap<Seat, Memory>();
  private running = false;
  private stopped = false;
  private retryAt = 0;
  readonly ai = { mode: 'neural', decisions: 0, errors: 0, fallbackRounds: 0, lastError: '', contract };
  constructor(private infer: Infer, now = Date.now, random = Math.random) { super(now, random); }
  override bots(_r: Room) { this.schedule(); }
  override tick() { super.tick(); this.schedule(); }
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
    for (const p of r.seats) if (p.bot) this.memories.delete(p);
    super.bots(r);
    this.touch(r);
    if (r.stage === 'recruit' && this.living(r).every(p => p.ended)) this.fight(r);
  }
  private fallback(r: Room, error: unknown) {
    this.ai.errors++;
    this.ai.lastError = error instanceof Error ? error.message : String(error);
    this.ai.mode = 'fallback';
    this.retryAt = this.now() + 10000;
    console.error('Neural inference unavailable:', this.ai.lastError);
    if (this.rooms.get(r.code) !== r || r.stage !== 'recruit' || this.stopped) return;
    this.heuristic(r);
  }
  private async decision(r: Room, p: Seat) {
    const turn = r.turn, rev = p.rev, pairings = r.pairings;
    const fresh = () => this.active(r, p, turn) && p.rev === rev && r.pairings === pairings;
    let state = this.memories.get(p);
    if (!state) {
      state = { memory: Array(128).fill(0), previous: ACTIONS.length, turn, decisions: 0 };
      this.memories.set(p, state);
    }
    if (state.turn !== turn) { state.turn = turn; state.decisions = 0; }
    // The model gets the same public projection as training. Private enemy boards
    // are supplied only to the authoritative rule validator, never to inference.
    const s = { ...p.game!, pool: r.pool };
    const pair = r.pairings?.find(pair => pair.includes(p.id));
    const enemy = r.seats.find(seat => seat.id === pair?.find(id => id !== p.id));
    const valid = new Map<number, Action>();
    let checked = 0;
    for (const [id, action] of candidates(s, state.decisions >= 64)) {
      let uid = 0;
      const error = ['end', 'move', 'freeze'].includes(action.type) ? undefined : withSimulation(
        { uid: () => `preview-${uid++}`, recordLogs: false, recordFrames: false },
        () => actSeason(s, action, () => 0.5, { opponentBoard: enemy?.game?.board || r.grave?.board || [] }).error,
      );
      if (!error) valid.set(id, action);
      if (++checked % 16 === 0) await yieldLoop();
      if (!fresh()) return;
    }
    if (!valid.size || state.decisions >= 96) throw Error('Neural action limit or unresolved mandatory choice');
    const result = await this.infer({ contract, rows: [{ entities: observeEntities(s, state.decisions, 64),
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
    }
    state.memory = chosen.memory; state.previous = chosen.action; state.decisions++;
    this.ai.decisions++; this.ai.mode = 'neural';
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
          if (this.now() < this.retryAt) {
            this.heuristic(r);
          } else await this.decision(r, p);
        } catch (error) { this.fallback(r, error); }
        await yieldLoop();
      }
    }
  }
}
