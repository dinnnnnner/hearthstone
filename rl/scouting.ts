import type { Game } from "../src/engine";
import { previousScoutRounds, type ScoutRound } from "../src/scouting";

export const WARBAND_TYPES = ["野兽", "机械", "鱼人", "恶魔", "龙", "元素", "畸变怪", "海盗", "野猪人", "亡灵", "空场", "无种族", "混合"];

export function publicScouting(s: Game, rounds: ScoutRound[] | undefined) {
  return previousScoutRounds(rounds, s.turn).map(r => {
    const match = /^(\d+)(.+)$/.exec(r.warband);
    const type = match ? match[2] : r.warband;
    if (!WARBAND_TYPES.includes(type) && type !== "纳迦") throw Error(`Unknown public warband: ${r.warband}`);
    const battle = r.battle;
    // Self-play names are unique. A non-ghost name absent from opponents is our own seat.
    const opponent = battle && s.opponents.find(o => o.name === battle.opponent);
    return {
      turn: r.turn,
      warband: { type, count: match ? Number(match[1]) : 0 },
      battle: battle ? {
        opponentSeat: battle.opponent === "幽灵阵容" ? 8 : opponent?.seatIndex ?? s.seatIndex ?? -1,
        result: battle.result, damage: battle.damage,
      } : undefined,
    };
  });
}
