import type { Game, Opponent } from "./engine";

export function rankingHealth(health: number, armor = 0, spellArmor = 0) {
  return health + Math.max(0, armor - spellArmor);
}
export function gameRankingHealth(game: Game) {
  return rankingHealth(game.health, game.season?.armor, game.season?.spellArmor);
}
export function opponentRankingHealth(opponent: Opponent, health = opponent.health) {
  return rankingHealth(health, opponent.armor, opponent.spellArmor);
}
export function absorbArmor(state: { armor: number; spellArmor?: number }, damage: number) {
  const absorbed = Math.min(state.armor, damage);
  state.armor -= absorbed;
  state.spellArmor = Math.max(0, (state.spellArmor || 0) - absorbed);
  return damage - absorbed;
}

export function damageSeasonHero(game: Game, damage: number) {
  const season = game.season;
  if (!season) { game.health -= damage; return; }
  if (season.counters?.iceBlock && damage >= game.health + season.armor) {
    season.counters.iceBlock = 0;
    return;
  }
  game.health -= absorbArmor(season, damage);
}
