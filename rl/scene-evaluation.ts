/** Training labels only. Benchmarks never become policy observations or rewards. */
import type { Game } from '../src/engine';
import { endEffects, seasonCombat } from '../src/season/engine';
import { absorbArmor } from '../src/ranking';
import { withSimulation } from '../src/simulation';
export const SCENE_VERSION = 'combat-benchmark-v1';
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function evaluateScene(game: Game, opponents: Game[], seed: number, trials = 4) {
  if (!Number.isInteger(trials) || trials < 2 || trials > 12 || trials % 2 || !opponents.length || opponents.length > 7 || !Number.isInteger(seed))
    throw Error('Invalid scene benchmark');
  if (game.health <= 0) return { version: SCENE_VERSION, target: [0, 1, 0, 0, 0, 1], battles: 0, dead: true };
  let wins = 0, losses = 0, ties = 0, dealt = 0, taken = 0, deaths = 0;
  for (let i = 0; i < opponents.length; i++) for (let trial = 0; trial < trials; trial++) {
    const own = structuredClone(game), enemy = structuredClone(opponents[i]);
    // Preserve card references. Both sides use the evaluated position's turn
    // and living-player count, so seat order cannot change damage protection.
    own.pool = enemy.pool = structuredClone(game.pool);
    for (const s of [own, enemy]) {
      s.turn = game.turn;
      s.opponents = structuredClone(game.opponents);
    }
    const rng = random((seed ^ Math.imul(i + 1, 0x85ebca6b) ^ trial) >>> 0);
    let uid = 0;
    const result = withSimulation({ uid: () => `scene-new-${uid++}`, recordFrames: false, recordLogs: false }, () => {
      if (own.phase === 'recruit') endEffects(own, rng);
      enemy.pool = own.pool;
      if (enemy.phase === 'recruit') endEffects(enemy, rng);
      own.pool = enemy.pool;
      if (own.health <= 0 || enemy.health <= 0)
        return { result: own.health <= 0 ? 'loss' : 'win', damage: 0 };
      if (trial % 2) {
        const battle = seasonCombat(enemy, own.board, own.tier, rng, own);
        return { result: battle.result === 'win' ? 'loss' : battle.result === 'loss' ? 'win' : 'tie', damage: battle.damage };
      }
      return seasonCombat(own, enemy.board, enemy.tier, rng, enemy);
    });
    if (result.result === 'win') { wins++; dealt += result.damage; }
    else if (result.result === 'loss') { losses++; taken += result.damage; own.health -= absorbArmor(own.season!, result.damage); }
    else ties++;
    if (own.health <= 0) deaths++;
  }
  const n = opponents.length * trials;
  return { version: SCENE_VERSION, target: [wins / n, losses / n, ties / n,
    Math.log1p(dealt / n) / Math.log(41), Math.log1p(taken / n) / Math.log(41), deaths / n],
    battles: n, dead: false, meanDamageDealt: dealt / n, meanDamageTaken: taken / n };
}
