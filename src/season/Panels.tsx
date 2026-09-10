import { assetUrl } from "../paths";
import {
  Sparkles,
  Shield,
  Coins,
  LockKeyhole,
  Gem,
  ArrowUpRight,
  CheckCircle2,
  BookOpen,
} from "lucide-react";
import { art, getDef } from "../data";
import { type Game, type Action, type Minion } from "../engine";
import {
  SEASON_META,
  SEASON_CATALOG,
  SEASON_CARDS,
  SEASON_SPELLS,
  SEASON_HEROES,
  SEASON_HERO_CATALOG,
  RAW_GIFTS,
} from "./catalog";
import { TRINKETS, giftTierRange, spellCost, spellUsesHealth } from "./engine";
import assets from "./assets.json" with { type: "json" };
export function SeasonBar({
  game,
  dispatch,
}: {
  game: Game;
  dispatch: (a: Action) => unknown;
}) {
  const st = game.season;
  if (!st) return null;
  return (
    <section className="season-bar">
      <div className="season-intro">
        <span className="season-symbol">
          <Sparkles size={23} />
        </span>
        <div>
          <span className="season-kicker">
            SEASON 14 · PATCH {SEASON_META.patch}
          </span>
          <h2>达拉然的黑暗之赐</h2>
          <p>本局种族：{st.tribes.join(" · ")}</p>
        </div>
        <span className="season-verified">
          <CheckCircle2 size={12} />
          9月3日平衡补丁
        </span>
      </div>
      <div className="season-tools">
        <div className="dark-gift-control">
          <span className="dark-gift-icon">
            <Gem size={22} />
          </span>
          <div>
            <strong>
              黑暗发现 <small>{st.giftsUsed} / 3</small>
            </strong>
            <p>
              {game.turn < 3
                ? "第3回合解锁，每回合最多使用一次"
                : `当前可发现${giftTierRange(game.turn).join(" / ")}星随从，附带黑暗之赐`}
            </p>
          </div>
          <button
            className="button gift-button"
            onClick={() => dispatch({ type: "darkGift" })}
            disabled={
              game.phase !== "recruit" ||
              game.turn < 3 ||
              st.giftsUsed >= 3 ||
              st.giftUsedTurn === game.turn ||
              game.gold < 3
            }
          >
            {game.turn < 3 ? <LockKeyhole size={13} /> : <Sparkles size={13} />}
            <span>
              {st.giftsUsed >= 3
                ? "次数用完"
                : st.giftUsedTurn === game.turn
                  ? "本轮已用"
                  : "黑暗发现"}
            </span>
            <Coins size={12} />3
          </button>
        </div>
        <div className="trinket-slots">
          {[0, 1].map((i) => {
            const t = TRINKETS.find((t) => t.id === st.trinkets[i]);
            return (
              <div
                className={`trinket-slot ${t ? "filled" : ""}`}
                key={i}
                title={t?.text || `第${i === 0 ? 6 : 9}回合选择饰品`}
              >
                {t ? <img src={art(t.id)} alt="" /> : <Gem size={18} />}
                <div>
                  <strong>
                    {t?.name || `${i === 0 ? "小型" : "大型"}饰品`}
                  </strong>
                  <span>{t ? t.text : `第${i === 0 ? 6 : 9}回合选择`}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
export function SpellShelf({
  game,
  select,
  dispatch,
}: {
  game: Game;
  select: (m: Minion) => void;
  dispatch: (a: Action) => unknown;
}) {
  const st = game.season;
  if (!st) return null;
  return (
    <div className="spell-shelf">
      <span className="spell-shelf-label">
        <BookOpen size={13} />
        酒馆法术
      </span>
      {st.spellShop.length ? (
        st.spellShop.map((m) => {
          const d = getDef(m.id),
            cost = spellCost(game, m);
          return (
            <div className="spell-offer" key={m.uid}>
              <button onClick={() => select(m)} className="spell-art-button">
                <img src={art(m.id)} alt={d.name} />
              </button>
              <button className="spell-offer-detail" onClick={() => select(m)}>
                <strong>
                  {d.name}
                  <small>{d.tier}星</small>
                </strong>
                <span>{d.text}</span>
              </button>
              <button
                className="small-button"
                onClick={() => dispatch({ type: "buySpell", uid: m.uid })}
                disabled={game.phase !== "recruit" || (!spellUsesHealth(m) && game.gold < cost)}
              >
                购买 {spellUsesHealth(m) ? "生命 " : <Coins size={12} />}
                {cost}
              </button>
            </div>
          );
        })
      ) : (
        <span className="spell-sold">本轮法术已售出，刷新酒馆可补充</span>
      )}
    </div>
  );
}
export function GiftNote({ m }: { m: Minion }) {
  if (!m.gift) return null;
  const g = RAW_GIFTS.find((g) => g.id === m.gift);
  return (
    <div className="gift-note">
      <Sparkles size={14} />
      <div>
        <strong>{g?.name || "黑暗之赐"}</strong>
        <p>{g?.text}</p>
      </div>
    </div>
  );
}
export function SeasonTrinkets({
  game,
  dispatch,
}: {
  game: Game;
  dispatch: (a: Action) => unknown;
}) {
  return (
    <div className="trinket-options">
      {game.season!.trinketOffers.map((id) => {
        const t = TRINKETS.find((t) => t.id === id)!;
        return (
          <button
            key={id}
            className="trinket-option"
            onClick={() => dispatch({ type: "buyTrinket", uid: id })}
            disabled={game.gold < t.cost}
          >
            <span
              className="trinket-option-art"
              style={{ backgroundImage: `url(${art(id)})` }}
            />
            <strong>{t.name}</strong>
            <p>{t.text}</p>
            <span className="trinket-price">
              <Coins size={14} />
              {t.cost} 金币
            </span>
          </button>
        );
      })}
    </div>
  );
}
export function CardSource({ m }: { m: Minion }) {
  const d = getDef(m.id);
  if (!d.season) return null;
  const id = d.sourceId!,
    supported = d.playable || !!m.extraAbilities?.length;
  return (
    <div className="card-source">
      <span className={`support-state ${supported ? "supported" : ""}`}>
        {supported ? "技能已接入练习引擎" : "图鉴已收录，技能尚未实现"}
      </span>
      <details>
        <summary>
          查看网上卡面与素材来源 <ArrowUpRight size={12} />
        </summary>
        {assets.renders.includes(id) ? (
          <img
            className="original-card-print"
            src={assetUrl(`cards/${id}.png`)}
            alt={`${d.name}中文原版卡面`}
          />
        ) : (
          <>
            <img
              className="original-card-art"
              src={art(m.id)}
              alt={`${d.name}原始插画`}
            />
            <p>该卡的中文完整渲染暂不可用，使用原始插画与36.4.2数据排版。</p>
          </>
        )}
        <a
          href={`https://art.hearthstonejson.com/v1/orig/${id}.png`}
          target="_blank"
          rel="noreferrer"
        >
          HearthstoneJSON · {id}
        </a>
        <p>玩法数值以锁定补丁为准；素材站的完整卡面可能更新。</p>
      </details>
    </div>
  );
}
export function CoverageNote() {
  return (
    <div className="coverage-note">
      <Shield size={16} />
      <span>
        36.4.2资料已收录{SEASON_CATALOG.length}种随从，其中{SEASON_CARDS.length}
        种已实现技能并可进入练习池。另有{SEASON_SPELLS.length}
        种可购买酒馆法术，以及{SEASON_HEROES.length}/{SEASON_HERO_CATALOG.length}位可用英雄。其余英雄尚未开放；黑暗之赐与饰品仍使用已实现的候选池。
      </span>
    </div>
  );
}
