import type { Battle, Game, Minion, Opponent } from "./engine";
import { absorbArmor } from "./ranking";
import { recordScoutRound, warbandLabel } from "./scouting";
import { roundRobinPairings } from "../server/pairing";

/** Resolve the whole practice table before applying any hero damage or eliminations. */
export function practiceBattles(
  s: Game,
  fight: (ally: Opponent | null, enemy: Opponent) => Battle,
  release: (m: Minion) => void,
): Battle | undefined {
  const living = s.opponents.filter(o => o.health > 0);
  if (!living.length) return;
  const enemy = living.includes(s.opponents[s.nextOpponent]) ? s.opponents[s.nextOpponent] : living[0];
  s.nextOpponent = s.opponents.indexOf(enemy);
  const labels = new Map(living.map(o => [o, warbandLabel(o.board)]));
  const ownLabel = warbandLabel(s.board);
  const others = living.filter(o => o !== enemy);
  const ghost: Opponent = {
    ...(s.practiceGhost || enemy), name: "幽灵阵容", health: 0, armor: 0,
    board: structuredClone(s.practiceGhost?.board || []),
  };
  const pairs: [Opponent | null, Opponent][] = [[null, enemy]];
  for (const [a, b] of roundRobinPairings(others.map((_, i) => String(i)), s.turn - 1))
    pairs.push([others[Number(a)], b === null ? ghost : others[Number(b)]]);
  // One unmatched bot still fights a ghost when it is the only remaining bystander.
  if (others.length === 1) pairs.push([others[0], ghost]);
  const battles = pairs.map(([a, b]) => ({ a, b, battle: fight(a, b) }));
  const hurt = (o: Opponent | null, damage: number) => {
    if (!o) s.health -= s.season ? absorbArmor(s.season, damage) : damage;
    else if (s.season) {
      const armor = { armor: o.armor || 0, spellArmor: o.spellArmor };
      o.health -= absorbArmor(armor, damage);
      Object.assign(o, armor);
    } else o.health -= damage;
  };
  for (const { a, b, battle } of battles) {
    battle.opponent = b.name;
    recordScoutRound(a || s, { turn: s.turn, warband: a ? labels.get(a)! : ownLabel,
      battle: { opponent: b.name, result: battle.result, damage: battle.damage } });
    if (b !== ghost) recordScoutRound(b, { turn: s.turn, warband: labels.get(b)!,
      battle: { opponent: a?.name || "你", result: battle.result === "win" ? "loss" : battle.result === "loss" ? "win" : "tie", damage: battle.damage } });
    if (battle.result === "loss") hurt(a, battle.damage);
    if (battle.result === "win" && b !== ghost) hurt(b, battle.damage);
  }
  for (const o of living.filter(o => o.health <= 0)) {
    s.practiceGhost = { ...structuredClone(o), board: structuredClone(o.board).map(m => ({ ...m, copies: {} })) };
    o.board.forEach(release);
    o.board = [];
  }
  return battles[0].battle;
}
