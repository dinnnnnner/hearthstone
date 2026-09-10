import { useState } from "react";
import type { Action, Game } from "../engine";
import { art, getDef } from "../data";
import { seasonTargets } from "./engine";
import "./powers.css";

export function CardChoices({ game, dispatch }: { game: Game; dispatch: (a: Action) => unknown }) {
  const [selected, setSelected] = useState<string>();
  const card = game.discovery.find((m) => m.uid === selected);
  const targets = card ? seasonTargets(game, card, "cast") : [];
  const choose = (uid: string) => {
    const m = game.discovery.find((m) => m.uid === uid)!;
    if (seasonTargets(game, m, "cast").length) setSelected(uid);
    else dispatch({ type: "discover", uid });
  };
  return <div className="card-choices">
    <div className="power-choice-grid">
      {game.discovery.map((m) => {
        const d = getDef(m.id);
        return <button key={m.uid} className={`power-choice-card ${selected === m.uid ? "selected" : ""}`}
          aria-pressed={selected === m.uid} onClick={() => choose(m.uid)} aria-label={`选择效果：${d.name}`}>
          <img src={art(d.sourceId || d.id)} alt="" /><strong>{d.name}</strong><p>{m.golden ? d.goldenText : d.text}</p>
          <span className="power-choice-confirm">{game.season?.activeDiscovery?.both ? "同时获得两项效果" : "选择效果"}</span>
        </button>;
      })}
    </div>
    {card && targets.length > 0 && <div className="choice-targets"><p>为{getDef(card.id).name}选择目标</p>
      {targets.map((m) => <button key={m.uid} className="button" onClick={() => dispatch({ type: "discover", uid: card.uid, target: m.uid })}>
        {game.shop.some((x) => x.uid === m.uid) ? `酒馆${game.shop.findIndex((x) => x.uid === m.uid) + 1} · ` : `战队${game.board.findIndex((x) => x.uid === m.uid) + 1} · `}{getDef(m.id).name} {m.attack}/{m.health}
      </button>)}
    </div>}
  </div>;
}
