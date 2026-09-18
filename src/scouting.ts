import { getDef } from "./data";
import type { Minion } from "./engine";

export interface ScoutRound {
  turn: number;
  warband: string;
  battle?: { opponent: string; result: "win" | "loss" | "tie"; damage: number };
}
export function warbandLabel(board: Minion[]): string {
  if (!board.length) return "空场";
  const counts = new Map<string, number>();
  const tribes = ["野兽", "机械", "鱼人", "恶魔", "龙", "元素", "畸变怪", "纳迦", "海盗", "野猪人", "亡灵"];
  for (const m of board) {
    const d = getDef(m.id), races = d.races?.length ? d.races : [d.tribe];
    for (const race of new Set(races.includes("全部") ? tribes : races)) {
      if (tribes.includes(race)) counts.set(race, (counts.get(race) || 0) + 1);
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]);
  if (!top.length) return "无种族";
  return top[1]?.[1] === top[0][1] ? "混合" : `${top[0][1]}${top[0][0]}`;
}
export function recordScoutRound(holder: { scouting?: ScoutRound[] }, round: ScoutRound) {
  holder.scouting = [round, ...(holder.scouting || []).filter(r => r.turn !== round.turn)]
    .sort((a, b) => b.turn - a.turn).slice(0, 3);
}
export function previousScoutRounds(rounds: ScoutRound[] | undefined, turn: number) {
  return (rounds || []).filter(r => r.turn < turn && r.turn >= turn - 2)
    .sort((a, b) => b.turn - a.turn);
}
