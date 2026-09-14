import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ACTIONS, candidates } from '../rl/actions';
import { actSeason } from '../src/season/engine';
import { getDef } from '../src/data';
import { seasonPowerState } from '../src/season/engine';
import { withSimulation } from '../src/simulation';
import type { Action } from '../src/engine';
import type { Guest, Room, Rooms, Seat } from './rooms';
import { inferenceProfile } from './neural-profile';

type Episode = { id: string; gameId: string; room: Room; seat: Seat; steps: number; turn: number;
  decisions: number; previous: number; endedTurn: number; invalid: Set<string>; finished: boolean };
/** Append-only, pseudonymous human demonstrations. No online learning or bot trajectories. */
export class Demonstrations {
  readonly profile = inferenceProfile('scouting-v4');
  readonly stats = { enabled: true, episodes: 0, decisions: 0, completed: 0, rejected: 0, errors: 0, bytes: 0 };
  private episodes = new Map<Seat, Episode>();
  private games = new WeakMap<Room, string>();
  private seen = new WeakSet<Seat>();
  private pending = Promise.resolve();
  private queued = 0;
  private directory: string;
  constructor(directory: string, private buildId: string, private source: 'human' | 'synthetic' = 'human', private maxBytes = 1024 ** 3) {
    this.directory = join(directory, this.profile.contract);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Count all contract directories so upgrading the schema cannot reset the quota.
    const size = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((sum, entry) =>
      sum + (entry.isDirectory() ? size(join(path, entry.name)) : entry.isFile() ? statSync(join(path, entry.name)).size : 0), 0);
    this.stats.bytes = size(directory);
    const manifest = { format: 1, contract: this.profile.contract, schema: this.profile.schema };
    writeFileSync(join(this.directory, 'schema.json'), JSON.stringify(manifest), { mode: 0o600 });
  }
  private emit(e: Episode, row: object) {
    const payload = gzipSync(JSON.stringify(row) + '\n', { level: 1 });
    if (this.queued + payload.length > 4 * 1024 ** 2 || this.stats.bytes + this.queued + payload.length > this.maxBytes) {
      e.invalid.add('storage_limit'); this.stats.errors++; return;
    }
    this.queued += payload.length;
    this.pending = this.pending.then(async () => {
      try { await appendFile(join(this.directory, e.id + '.jsonl.gz'), payload, { mode: 0o600 }); this.stats.bytes += payload.length; }
      catch { e.invalid.add('storage_error'); this.stats.errors++; }
      finally { this.queued -= payload.length; }
    });
  }
  observe(store: Rooms, fresh = true) {
    for (const r of store.rooms.values()) {
      if (r.stage === 'waiting') this.games.delete(r);
      if (!r.recordTraining || r.kind !== 'ai' || r.stage === 'waiting') continue;
      for (const p of r.seats) {
        if (p.bot || !p.game || this.seen.has(p)) continue;
        this.seen.add(p);
        let gameId = this.games.get(r);
        if (!gameId) { gameId = randomUUID(); this.games.set(r, gameId); }
        const e: Episode = { id: randomUUID(), gameId, room: r, seat: p, steps: 0, turn: r.turn,
          decisions: 0, previous: ACTIONS.length, endedTurn: 0, invalid: new Set(), finished: false };
        if (!fresh || r.turn !== 1 || r.stage !== 'recruit') e.invalid.add('partial_start');
        this.episodes.set(p, e); this.stats.episodes++;
        this.emit(e, { type: 'start', format: 1, episode: e.id, gameId, source: this.source,
          contract: this.profile.contract, buildId: this.buildId, hero: p.hero, mode: r.mode,
          model: r.aiModel, completeStart: !e.invalid.size });
      }
    }
    for (const [p, e] of this.episodes) {
      const r = e.room;
      if (r.aiStatus === 'fallback') e.invalid.add('script_fallback');
      if ((r.turn > e.turn || r.stage === 'combat' || r.stage === 'finished') && e.endedTurn < e.turn)
        e.invalid.add('automatic_end');
      if (r.turn > e.turn) { e.turn = r.turn; e.decisions = 0; }
      if (p.left || p.bot) e.invalid.add('left_or_takeover');
      const gone = store.rooms.get(r.code) !== r || !r.seats.includes(p);
      if (gone && !p.place) e.invalid.add('room_closed');
      if (p.place || p.left || p.bot || gone || r.stage === 'finished') this.finish(e, p.place);
    }
  }
  private finish(e: Episode, place?: number) {
    if (e.finished) return;
    e.finished = true;
    if (!place) e.invalid.add('missing_result');
    if (!e.steps) e.invalid.add('empty');
    this.emit(e, { type: 'end', episode: e.id, steps: e.steps, place, turn: e.room.turn,
      complete: e.invalid.size === 0, reasons: [...e.invalid] });
    if (e.invalid.size) this.stats.rejected++; else this.stats.completed++;
    this.episodes.delete(e.seat);
  }
  action(store: Rooms, guest: Guest, action: Action, requestId: string, turn: number) {
    this.observe(store);
    const { r, p } = store.member(guest), e = this.episodes.get(p);
    if (!e || p.requests.includes(requestId) || action.type === 'continue') {
      store.action(guest, action, requestId, turn); this.observe(store); return;
    }
    let sample: object | undefined;
    let captureError = false;
    try {
      if (!p.game || r.stage !== 'recruit' || p.ended || turn !== r.turn) throw Error('Inactive decision');
      const s = { ...p.game, pool: r.pool }, decisions = e.turn === r.turn ? e.decisions : 0;
      const pair = r.pairings?.find(pair => pair.includes(p.id));
      const enemy = r.seats.find(seat => seat.id === pair?.find(id => id !== p.id));
      const valid = new Map<number, Action>();
      for (const [id, candidate] of candidates(s)) {
        let uid = 0;
        const error = ['end', 'move', 'freeze'].includes(candidate.type) ? undefined : withSimulation(
          { uid: () => `demo-preview-${uid++}`, recordLogs: false, recordFrames: false },
          () => actSeason(s, candidate, () => .5, { opponentBoard: enemy?.game?.board || r.grave?.board || [] }).error);
        if (!error) valid.set(id, candidate);
      }
      let normalized: Record<string, unknown> = { ...action };
      if (normalized.type === 'play' && getDef(s.hand.find(m => m.uid === normalized.uid)!.id).kind === 'spell')
        normalized = { type: 'cast', uid: normalized.uid, target: normalized.target };
      if (normalized.type === 'play') {
        const card = s.hand.find(m => m.uid === normalized.uid)!;
        normalized.position = getDef(card.id).magnetic && normalized.target ? 0 :
          Math.min(s.board.length, Number(normalized.position ?? s.board.length));
      }
      const chosen = [...valid].find(([, a]) => a.type === normalized.type &&
        ['uid', 'target', 'position', 'to'].every(k => (a as any)[k] === (normalized as any)[k]) &&
        (normalized.type !== 'power' || a.type === 'power' && a.powerId === (normalized.powerId || seasonPowerState(s).id)));
      if (!chosen || e.steps >= 4096) throw Error('Unsupported demonstration action');
      sample = JSON.parse(JSON.stringify({ type: 'decision', episode: e.id, step: e.steps, turn,
        entities: this.profile.observe(s, decisions, 64), legal: [...valid.keys()], action: chosen[0],
        previous: e.previous, goldBefore: s.gold, unusedGold: action.type === 'end' ? s.gold : undefined }));
    } catch { captureError = true; }
    // Rejected/retried requests never become demonstrations; recording cannot reject a valid move.
    store.action(guest, action, requestId, turn);
    if (captureError) e.invalid.add('capture_gap');
    if (sample) {
      this.emit(e, sample); e.steps++; this.stats.decisions++;
      e.previous = (sample as { action: number }).action;
    }
    e.decisions = (e.turn === turn ? e.decisions : 0) + 1; e.turn = turn;
    if (action.type === 'end') e.endedTurn = turn;
    this.observe(store);
  }
  async flush() { await this.pending; }
  async close() {
    for (const e of this.episodes.values()) { e.invalid.add('server_restart'); this.finish(e); }
    await this.flush();
  }
}
