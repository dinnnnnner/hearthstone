/** Training-only stage labels. Never feed other seats' private boards to a policy. */
import { type Game } from '../src/engine';
import { seasonCombat } from '../src/season/engine';
import { withSimulation } from '../src/simulation';

export const STAGE_VERSION = 'stage-evaluation-v1';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function evaluateStage(snapshot: { seed: number; room: { turn: number; pool: Game['pool']; seats: { game: Game; left?: boolean }[] } }, completedTurn: number, trials = 4) {
  if (!Number.isInteger(completedTurn) || completedTurn < 1 || !Number.isInteger(trials) || trials < 1 || trials > 12 || snapshot.room.seats.length !== 8)
    throw Error('Invalid stage evaluation request');
  const seats = snapshot.room.seats;
  const alive = seats.map(p => p.game.health > 0 && !p.left);
  const points = Array(8).fill(0), battles = Array(8).fill(0);
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    if (!alive[i] || !alive[j]) continue;
    for (let trial = 0; trial < trials; trial++) {
      // Alternate sides; all effects, summons, hero powers and trinkets use the
      // authoritative combat engine on isolated copies and a separate RNG.
      const left = trial % 2 ? j : i, right = trial % 2 ? i : j;
      const a = structuredClone(seats[left].game), b = structuredClone(seats[right].game);
      a.pool = b.pool = structuredClone(snapshot.room.pool);
      const rng = random((snapshot.seed ^ Math.imul(completedTurn, 0x9e3779b1) ^ Math.imul(i * 8 + j, 0x85ebca6b) ^ trial) >>> 0);
      let uid = 0;
      const result = withSimulation({ uid: () => `stage-${i}-${j}-${trial}-${uid++}`, recordFrames: false, recordLogs: false },
        () => seasonCombat(a, b.board, b.tier, rng, b)).result;
      const win = result === 'win' ? 1 : result === 'tie' ? .5 : 0;
      points[left] += win; points[right] += 1 - win; battles[left]++; battles[right]++;
    }
  }
  return {
    version: STAGE_VERSION, completedTurn, observedTurn: snapshot.room.turn, trials,
    timing: 'after_combat_and_automatic_next_turn_effects',
    seats: seats.map((p, seat) => {
      const g = p.game, st = g.season!;
      const tier = clamp((g.tier - 1) / 5);
      const health = clamp((Math.max(0, g.health) + (st.armor || 0) + (st.spellArmor || 0)) / 40);
      const board = battles[seat] ? points[seat] / battles[seat] : alive[seat] ? 1 : 0;
      // Only opening-turn resources count. Leftover gold from the previous turn
      // is reset by the game; it is neither rewarded nor penalized here.
      const extraIncome = g.turn > completedTurn ? Math.max(0, g.gold - Math.min(10, g.turn + 2)) : 0;
      const freeRefresh = Math.max(0, st.freeRefresh || 0);
      const economy = clamp((extraIncome + freeRefresh + Math.min(3, Math.max(0, st.spellDiscount || 0))) / 5);
      const score = alive[seat] ? 2 * (.2 * tier + .5 * board + .25 * health + .05 * economy) - 1 : -1;
      return { seat, alive: alive[seat], tier: g.tier, health: g.health, armor: st.armor || 0,
        boardWinRate: board, simulatedBattles: battles[seat], extraIncome, freeRefresh,
        components: { tier, board, health, economy }, score };
    }),
  };
}
