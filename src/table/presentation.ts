import type { Minion } from "../engine";
export type PieceChange = {
  uid: string;
  damage: number;
  attack: number;
  health: number;
  shieldBroken: boolean;
  spawned: boolean;
  dead: boolean;
};
// Presentation reads snapshots. These differences never drive rules or policy state.
export function changesBetween(
  before: Minion[],
  after: Minion[],
): PieceChange[] {
  const old = new Map(before.map((m) => [m.uid, m]));
  const changes = after.map((m) => {
    const p = old.get(m.uid);
    return {
      uid: m.uid,
      damage: p ? Math.max(0, p.health - m.health) : 0,
      attack: p ? m.attack - p.attack : 0,
      health: p ? Math.max(0, m.health - p.health) : 0,
      shieldBroken:
        !!p?.keywords.includes("圣盾") && !m.keywords.includes("圣盾"),
      spawned: !p,
      dead: m.health <= 0,
    };
  });
  for (const m of before)
    if (!after.some((n) => n.uid === m.uid))
      changes.push({
        uid: m.uid,
        damage: 0,
        attack: 0,
        health: 0,
        shieldBroken: false,
        spawned: false,
        dead: true,
      });
  return changes;
}
export const shortStat = (n: number) =>
  Math.abs(n) >= 1000000
    ? `${+(n / 1000000).toFixed(1)}M`
    : Math.abs(n) >= 1000
      ? `${+(n / 1000).toFixed(1)}K`
      : String(Math.max(0, n));
