/** A disposable, own-turn simulator reconstructed only from the policy's public input. */
import { type Game, type Minion, type Opponent } from '../src/engine';
import { actSeason, endEffects, type SeasonState } from '../src/season/engine';
import { SEASON_CARDS, SEASON_META } from '../src/season/catalog';
import { POOL_COPIES } from '../src/data';
import { withSimulation } from '../src/simulation';
import { ACTIONS, candidates } from './actions';
import { ENTITY_SCHEMA, IDS, OFFSETS, SIZES, observeEntities, type Entity } from './entities';
import type { ScoutRound } from '../src/scouting';
import { AI_ACTION_LIMITS, enableAIActionLimits } from '../src/ai-action-limits';

export const SEARCH_VERSION = 'own-recruit-freeze-close-v3';
type Details = Record<string, any>;
const take = (source: Details, keys: string[]) => Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, structuredClone(source[k])]));
const cardFields = ['discardGroup', 'attack', 'health', 'golden', 'keywords', 'lockedUntil', 'lockedTier', 'bothChoices', 'magneticCount',
  'learnedSpell', 'gift', 'giftTurn', 'activated', 'temporary', 'extraAbilities', 'expires', 'tempSpell', 'gems', 'reward', 'rebornNext', 'counters'];
const gameFields = ['turn', 'tier', 'gold', 'health', 'upgrade', 'frozen', 'powerUsed', 'triples', 'purchases', 'refreshes', 'rewards', 'pogo', 'seatIndex'];
const seasonFields = ['trinketData', 'deity', 'trinketPower', 'kiriSlot', 'armor', 'spellArmor', 'tribes', 'freeRefresh', 'nextGold', 'maxGold', 'giftsUsed', 'giftUsedTurn',
  'discoveryKind', 'trinketDone', 'buffs', 'fodder', 'spellDiscount', 'healthRefreshes', 'healthRefreshUses', 'playedTurn',
  'goldenPlayed', 'spellsCast', 'lastSpell', 'battlecries', 'deaths', 'trinketBuys', 'counters', 'combatEffects',
  'goldSpentTurn', 'boughtTurn', 'lastDead', 'cookieTribes', 'powerCycle', 'nozdormuRefreshTurn'];

export class UnsupportedSearch extends Error {}

/** No Game/snapshot/pool/private RNG is accepted on the search wire. */
export function gameFromObservation(input: (Entity | null)[]): Game {
  const entities = structuredClone(input);
  if (entities.length !== ENTITY_SCHEMA.count || !entities[0]) throw Error('Invalid search entity count');
  for (const [slot, e] of entities.entries()) if (e && (!Number.isInteger(e.id) || !IDS[e.id - 1] ||
    e.zone < 0 || e.zone >= SIZES.length || e.position < 0 || e.position >= SIZES[e.zone] || OFFSETS[e.zone] + e.position !== slot))
    throw Error('Invalid search entity identity/slot');
  const zone = (z: number) => entities.slice(OFFSETS[z], OFFSETS[z] + SIZES[z]).filter((e): e is Entity => !!e);
  const id = (e: Entity) => IDS[e.id - 1];
  const g = entities[0]!.details as Details;
  // These requests intentionally omit future candidates/source data on the public wire.
  if (g.pendingDiscoveries?.length) throw new UnsupportedSearch('Pending discovery cannot be reconstructed from public input');
  if (g.powerChoiceMode) throw new UnsupportedSearch('Power choice may depend on unobserved inactive power history');
  if (zone(8).some(e => id(e) === 's14_scabbs')) throw new UnsupportedSearch('Scabbs requires an unknown opposing warband');
  const ref = (slot: number) => Number.isInteger(slot) && slot >= OFFSETS[1] && slot < OFFSETS[6] && entities[slot]
    ? `visible-${slot}` : undefined;
  const card = (e: Entity): Minion => ({ ...take(e.details, cardFields), uid: `visible-${OFFSETS[e.zone] + e.position}`,
    id: id(e), copies: {}, ...(e.zone !== 6 && e.details.remembered ? {
      remembered: (e.details.remembered as number[]).map(n => ref(n) || 'unknown-visible-reference'),
    } : {}) } as Minion);
  const cards = (z: number) => zone(z).map(card);
  const name = (seat: number) => seat === 8 ? '幽灵阵容' : `seat-${seat}`;
  const scouts = (rows: any[] = []): ScoutRound[] => rows.filter(r => r.turn < g.turn && r.turn >= g.turn - 2).map(r => ({
    turn: r.turn, warband: `${r.warband.count || ''}${r.warband.type}`,
    ...(r.battle ? { battle: { opponent: name(r.battle.opponentSeat), result: r.battle.result, damage: r.battle.damage } } : {}),
  }));
  const opponents: Opponent[] = zone(7).map((e, i) => ({ ...take(e.details, ['seatIndex', 'health', 'armor', 'spellArmor', 'tier']),
    name: name((e.details as Details).seatIndex ?? i), hero: id(e), board: [], scouting: scouts(e.details.scouting as any[]),
  } as unknown as Opponent));
  const st = { ...take(g, seasonFields), patch: SEASON_META.patch, spellShop: cards(3), initialPool: {}, pendingDiscoveries: [],
    trinkets: [...zone(11).map(id), ...(g.extraTrinkets || [])], trinketOffers: zone(10).map(id), powers: zone(8).map(id),
    powerProgress: Object.fromEntries(zone(8).map(e => [id(e), take(e.details, ['uses', 'turnUses', 'elementalsPlayed'])])),
    lastEnemy: cards(6), frozenMinions: g.frozenMinions?.map(ref).filter(Boolean),
    heroMarks: Object.fromEntries(Object.entries(g.heroMarks || {}).flatMap(([key, value]) => {
      const v = key === 'tavishId' ? value : ref(value as number); return v === undefined ? [] : [[key, v]];
    })),
    delayed: g.delayed?.map((d: Details) => ({ ...take(d, ['turn', 'attack', 'health', 'amount', 'win']), uid: ref(d.target) })),
  } as unknown as SeasonState;
  if (g.powerChoiceMode) st.powerChoice = { mode: g.powerChoiceMode, selected: g.selectedPowers || [], offers: zone(9).map(id) };
  if (g.activeDiscovery) {
    const d = g.activeDiscovery;
    st.activeDiscovery = { ...take(d, ['kind', 'mechanic', 'both', 'damage', 'lockedUntil', 'doomedTurn', 'bothChoices']),
      magnetizeTarget: ref(d.magnetizeTarget), replaceShop: ref(d.replaceShop),
      ...(d.source ? { source: { ...take(d.source, cardFields), id: d.source.id, uid: 'visible-discovery-source', copies: {} } as Minion } : {}),
    } as NonNullable<SeasonState['activeDiscovery']>;
  }
  const s = { ...take(g, gameFields), version: 1, hero: id(entities[0]!), phase: 'recruit', battle: null,
    board: cards(1), shop: cards(2), hand: cards(4), discovery: cards(5), season: st,
    pool: {}, opponents, nextOpponent: Math.max(0, zone(7).findIndex(e => e.details.next)), logs: [],
    battles: g.lastBattle ? [{ ...g.lastBattle, name: '' }] : [], scouting: scouts(g.scouting),
  } as unknown as Game;
  const limits = g.aiActionLimits;
  if (limits !== undefined) {
    if (limits.version !== AI_ACTION_LIMITS.version ||
      !Number.isInteger(limits.freezeRemaining) || limits.freezeRemaining < 0 || limits.freezeRemaining > AI_ACTION_LIMITS.freezes ||
      !Number.isInteger(limits.moveRemaining) || limits.moveRemaining < 0 || limits.moveRemaining > AI_ACTION_LIMITS.moves)
      throw Error('Invalid AI action allowances');
    const undo = limits.undoOrder;
    if (typeof limits.freezeClosing !== 'boolean') throw Error('Invalid AI freeze close state');
    if (undo !== undefined && (!Array.isArray(undo) || undo.length !== s.board.length || new Set(undo).size !== undo.length ||
      undo.some(i => !Number.isInteger(i) || i < 0 || i >= s.board.length))) throw Error('Invalid AI previous move order');
    s.aiActionUsage = { turn: s.turn, freezes: AI_ACTION_LIMITS.freezes - limits.freezeRemaining,
      moves: AI_ACTION_LIMITS.moves - limits.moveRemaining,
      ...(limits.freezeClosing ? { freezeClosing: true } : {}),
      ...(undo ? { previousMoveOrder: undo.map((i: number) => s.board[i].uid) } : {}),
    };
  }
  // Explicit approximation: public tier copy counts minus visible own cards.
  // Other players' holdings, generated-card provenance and magnetic provenance are unknown.
  st.initialPool = Object.fromEntries(SEASON_CARDS.filter(d => !d.races?.length || d.races.includes('全部') ||
    d.races.some(t => st.tribes.includes(t))).map(d => [d.id, POOL_COPIES[d.tier]]));
  s.pool = { ...st.initialPool };
  for (const m of [...s.board, ...s.shop, ...s.hand, ...s.discovery]) if (s.pool[m.id] !== undefined) {
    const n = Math.min(s.pool[m.id], m.golden ? 3 : 1); m.copies = { [m.id]: n }; s.pool[m.id] -= n;
  }
  return s;
}

export class RecruitSearchEnv {
  private root: Game;
  state!: Game;
  private entropy = 0;
  private serial = 0;
  private steps = 0;
  private ended = false;
  private legal?: Map<number, Parameters<typeof actSeason>[1]>;
  constructor(entities: (Entity | null)[], readonly decisions: number, readonly featureBudget = 64, source?: RecruitSearchEnv) {
    if (source) {
      this.root = source.root;
      this.state = structuredClone(source.state);
      this.entropy = source.entropy; this.serial = source.serial;
      this.steps = source.steps; this.ended = source.ended;
      return;
    }
    this.root = gameFromObservation(entities);
    enableAIActionLimits(this.root);
    if (!Number.isSafeInteger(decisions) || decisions < 0 || !Number.isFinite(featureBudget) || featureBudget < 1)
      throw Error('Invalid observation decision counter');
  }
  private rng = () => {
    this.entropy = (this.entropy + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.entropy ^ this.entropy >>> 15, 1 | this.entropy);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  private scope<T>(fn: () => T, preview = false): T {
    const entropy = this.entropy, serial = this.serial;
    try { return withSimulation({ uid: () => `search-${++this.serial}`, recordFrames: false, recordLogs: false }, fn); }
    finally { if (preview) { this.entropy = entropy; this.serial = serial; } }
  }
  reset(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('Search seed must be uint32');
    this.entropy = seed; this.serial = 0; this.steps = 0; this.ended = false;
    this.state = structuredClone(this.root); this.legal = undefined;
    return this.view();
  }
  /** Clone the exact simulated state, including the sampled pool and generated IDs. */
  private fork(seed?: number) {
    const branch = new RecruitSearchEnv([], this.decisions, this.featureBudget, this);
    if (seed !== undefined) branch.entropy = seed;
    return branch;
  }
  planningStep(id: number, seeds?: number[]) {
    if (!seeds) return [{ branch: this, view: this.step(id), sampled: false }];
    // Probe once to detect real engine randomness. Deterministic transitions are
    // retained; a stochastic probe is discarded before drawing the paired seeds.
    const probe = this.fork(), entropy = probe.entropy;
    const view = probe.step(id);
    if (probe.entropy === entropy) return [{ branch: probe, view, sampled: false }];
    return seeds.map(seed => {
      const branch = this.fork(seed);
      return { branch, view: branch.step(id), sampled: true };
    });
  }
  legalActions() {
    if (this.ended || this.state.health <= 0) return new Map<number, Parameters<typeof actSeason>[1]>();
    if (this.legal) return this.legal;
    const result = new Map<number, Parameters<typeof actSeason>[1]>();
    for (const [id, a] of candidates(this.state)) {
      if (['end', 'move', 'freeze'].includes(a.type) || !this.scope(() => actSeason(this.state, a, this.rng).error, true)) result.set(id, a);
    }
    this.legal = result; return result;
  }
  view() {
    const boundary = !!this.state.season!.powerChoice || this.state.season!.powers?.includes('s14_scabbs') || false;
    return { entities: observeEntities(this.state, this.decisions + this.steps, this.featureBudget),
      legal: this.ended || boundary ? [] : [...this.legalActions().keys()], ended: this.ended, boundary,
      dead: this.state.health <= 0, turn: this.state.turn, steps: this.steps, gold: this.state.gold };
  }
  step(id: number) {
    const action = this.legalActions().get(id);
    if (!action) throw Error(`Illegal search action ${id}`);
    this.scope(() => {
      if (ACTIONS[id].type === 'end') {
        // actSeason(end) also recruits scripted opponents and fights. Never call it here.
        endEffects(this.state, this.rng); this.ended = true;
      } else {
        const result = actSeason(this.state, action, this.rng);
        if (result.error) throw Error(result.error);
        this.state = result.state;
      }
    });
    this.steps++; this.legal = undefined; return this.view();
  }
}
