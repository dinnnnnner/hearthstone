import { art } from "../data";
import type { Action, Game } from "../engine";
import { powerDefinition } from "./powers";
import "./powers.css";

export function PowerChoices({ game, dispatch }: { game: Game; dispatch: (a: Action) => unknown }) {
  const choice = game.season?.powerChoice;
  if (!choice || game.phase !== "recruit") return null;
  const title = choice.mode === "genn" ? `选择第${choice.selected.length + 1}个英雄技能`
    : choice.mode === "replace" ? "身份揭晓" : choice.mode === "nguyen" ? "风暴之力" : "冒险出发！";
  return <div className="modal-shade power-choice-shade">
    <section className="modal wide power-choice-modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-heading"><div><h2>{title}</h2><p>
        {choice.mode === "nguyen" ? "选择本回合使用的英雄技能。下回合重新选择。"
          : choice.mode === "genn" ? "两项技能可同时生效，各自计算费用和次数。"
          : choice.mode === "replace" ? "更换主技能，保留原英雄的生命值、护甲及第二技能。" : "选择这局使用的英雄技能。"}
      </p></div></div>
      {choice.selected.length > 0 && <p className="power-chosen">已选：{choice.selected.map((id) => powerDefinition(game, id).power).join("、")}</p>}
      <div className="power-choice-grid">
        {choice.offers.map((id) => { const h = powerDefinition(game, id); return <button key={id}
          className="power-choice-card" onClick={() => dispatch({ type: "choosePower", uid: id })} aria-label={`选择英雄技能：${h.power}`}>
          <img src={art(h.art)} alt="" /><span className="power-choice-cost">{h.passive ? "被动" : `${h.cost} 金币起`}</span>
          <strong>{h.power}</strong><small>{h.name}</small><p>{h.text}</p><span className="power-choice-confirm">选择技能</span>
        </button>; })}
      </div>
    </section>
  </div>;
}
