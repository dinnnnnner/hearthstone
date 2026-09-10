import { Check, RotateCw } from "lucide-react";
import { art } from "../data";
import { SEASON_HEROES } from "../season/catalog";

export function HeroDraft({ offers, selected, pending, choose, refresh }: {
  offers: string[];
  selected?: string;
  pending: boolean;
  choose: (hero: string) => void;
  refresh: (slot: number, hero: string) => void;
}) {
  return <section className="hero-draft" aria-label="随机四选一">
    <h2>选择你的英雄</h2>
    <p>从四位英雄中选择一位，也可以单独刷新。候选由本房间共享英雄池分配，不会与其他玩家重复。</p>
    <div className="hero-draft-grid">
      {offers.map((id, slot) => {
        const h = SEASON_HEROES.find((h) => h.id === id)!;
        return <article className={`hero-draft-card ${selected === id ? "selected" : ""}`} key={slot} data-hero={id}>
          <button className="hero-draft-choose" aria-label={`选择英雄 ${h.name}`} aria-pressed={selected === id} disabled={pending} onClick={() => choose(id)}>
            <img src={art(h.art)} alt="" />
            <strong>{h.name}</strong>
            <span>{h.power}</span>
            <p>{h.text}</p>
            <b>{selected === id ? <><Check size={14} /> 已选择</> : "选择英雄"}</b>
          </button>
          <button className="hero-draft-refresh" aria-label={`刷新候选 ${slot + 1}：${h.name}`} disabled={pending} onClick={() => refresh(slot, id)}>
            <RotateCw size={14} />刷新
          </button>
        </article>;
      })}
    </div>
    <small>刷新已选英雄后需要重新选择。芬利发现英雄技能不占用此英雄池，允许与同房英雄重复。</small>
  </section>;
}
