import { useEffect } from "react";
import { X } from "lucide-react";
import type { Opponent } from "../engine";
import { previousScoutRounds } from "../scouting";

export function RivalDetails({ opponent, turn, onClose }: { opponent: Opponent; turn: number; onClose: () => void }) {
  const rounds = previousScoutRounds(opponent.scouting, turn);
  const last = rounds.find(r => r.turn === turn - 1);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return <section className="rival-detail" aria-label="对手战绩">
    <button onClick={onClose} aria-label="关闭对手信息"><X size={18} /></button>
    <strong>{opponent.name}</strong>
    <span>{opponent.tier}星 · {Math.max(0, opponent.health)}生命 · {opponent.armor || 0}护甲</span>
    <div className="rival-warband"><span>上回合阵容</span><strong>{last?.warband || "暂无记录"}</strong></div>
    <h3>最近两回合</h3>
    {turn <= 1 ? <p>暂无对局记录</p> : <ol className="rival-results">
      {[turn - 1, turn - 2].filter(t => t > 0).map(t => {
        const battle = rounds.find(r => r.turn === t)?.battle;
        const winner = battle?.result === "win" ? opponent.name : battle?.opponent;
        const loser = battle?.result === "win" ? battle.opponent : opponent.name;
        return <li key={t} className={battle?.result || "unknown"}>
          <span>第 {t} 回合</span>
          {!battle ? <p>暂无对局记录</p> : battle.result === "tie"
            ? <p>{opponent.name} 与 {battle.opponent} 平局，0 点伤害</p>
            : <p>{winner} 对 {loser} 造成 <b>{battle.damage}</b> 点伤害</p>}
        </li>;
      })}
    </ol>}
  </section>;
}
