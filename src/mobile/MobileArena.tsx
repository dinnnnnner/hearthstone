import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUp,
  RotateCw,
  Snowflake,
  Coins,
  Heart,
  Shield,
  Sparkles,
  Plus,
  Swords,
  BookOpen,
  Beer,
  Gem,
  Maximize,
  Minimize,
  Smartphone,
} from "lucide-react";
import { type Game, type Minion, type Action, heroOf } from "../engine";
import { art, getDef } from "../data";
import { refreshCost, spellCost } from "../season/engine";

export type PlayMode = "auto" | "touch" | "desktop";
const MODE_KEY = "bobs-tavern-play-mode";
export function usePlayMode() {
  const [mode, setMode] = useState<PlayMode>(() => {
    try {
      const value = localStorage.getItem(MODE_KEY);
      if (value === "touch" || value === "desktop") return value;
    } catch {}
    return "auto";
  });
  const [small, setSmall] = useState(
    () =>
      matchMedia(
        "(max-width: 600px), (max-width: 1100px) and (pointer: coarse), (max-width: 1000px) and (max-height: 500px)",
      ).matches,
  );
  useEffect(() => {
    const query = matchMedia(
      "(max-width: 600px), (max-width: 1100px) and (pointer: coarse), (max-width: 1000px) and (max-height: 500px)",
    );
    const update = () => setSmall(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
  }, [mode]);
  return {
    mode,
    setMode,
    mobile: mode === "touch" || (mode === "auto" && small),
  };
}
export type CardZone = "shop" | "board" | "hand" | "spellshop";
export function MobileArena({
  game,
  dispatch,
  card,
  choose,
  power,
  newGame,
  season,
  pool,
  targeting,
  notify,
}: {
  game: Game;
  dispatch: (a: Action) => boolean;
  card: (m: Minion, zone: CardZone) => ReactNode;
  choose: (m: Minion, zone: CardZone) => void;
  power: () => void;
  newGame: () => void;
  season: () => void;
  pool: () => void;
  targeting: boolean;
  notify: (text: string) => void;
}) {
  const hero = heroOf(game),
    recruit = game.phase === "recruit";
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const update = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen)
        await document.documentElement.requestFullscreen();
      else notify("此浏览器不支持网页全屏，可以横屏游玩或添加到主屏幕。");
    } catch {
      notify("浏览器未允许全屏，可以直接横屏游玩。");
    }
  }
  return (
    <div className="mobile-arena">
      <div className="mobile-hud">
        <span className="mobile-turn">
          <Swords size={14} />第 {game.turn} 回合
        </span>
        <span className="mobile-tier">
          {"★".repeat(game.tier)}
          <small>{game.tier}星</small>
        </span>
        <strong className="mobile-gold">
          <Coins size={17} />
          {game.gold}
          <small>
            {" "}
            / {game.season?.maxGold ?? Math.min(10, game.turn + 2)}
          </small>
        </strong>
        <button
          aria-label={fullscreen ? "退出全屏" : "进入全屏"}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
        <button onClick={newGame} aria-label="新对局">
          <Plus size={17} />
        </button>
      </div>
      <p className="rotate-hint">
        <Smartphone size={14} />
        横过手机，酒馆、战场和手牌可同屏操作。
      </p>
      <div className="mobile-table">
        <section
          className={`mobile-shop ${game.frozen ? "is-frozen" : ""}`}
          aria-label="酒馆随从"
        >
          <div className="mobile-section-heading">
            <h2>
              <Beer size={14} />
              酒馆
            </h2>
            <div className="mobile-shop-actions">
              <button
                onClick={() => dispatch({ type: "upgrade" })}
                disabled={
                  !recruit || game.tier === 6 || game.gold < game.upgrade
                }
              >
                <ArrowUp size={14} />
                {game.tier === 6 ? "满级" : "升级"}
                {game.tier < 6 && (
                  <>
                    <Coins size={11} />
                    {game.upgrade}
                  </>
                )}
              </button>
              <button
                onClick={() => dispatch({ type: "refresh" })}
                disabled={
                  !recruit || (game.gold < 1 && !game.season?.freeRefresh)
                }
              >
                <RotateCw size={14} />
                刷新
                <Coins size={11} />
                {game.season ? refreshCost(game) : 1}
              </button>
              <button
                className={game.frozen ? "active" : ""}
                onClick={() => dispatch({ type: "freeze" })}
                disabled={!recruit}
              >
                <Snowflake size={14} />
                {game.frozen ? "解冻" : "冻结"}
              </button>
            </div>
          </div>
          <div className="mobile-shop-cards mobile-card-strip">
            {game.shop.map((m) => (
              <div className="mobile-shop-card" key={m.uid}>
                {card(m, "shop")}
              </div>
            ))}
            {game.shop.length === 0 && (
              <p className="mobile-empty">酒馆已售空，刷新寻找新随从。</p>
            )}
            {game.season?.spellShop.map((m) => (
              <button
                className="mobile-spell-offer"
                key={m.uid}
                onClick={() => choose(m, "spellshop")}
                aria-label={`查看酒馆法术 ${getDef(m.id).name}`}
              >
                <img src={art(m.id)} alt="" />
                <strong>{getDef(m.id).name}</strong>
                <span>
                  <Coins size={11} />
                  {spellCost(game, m)}
                </span>
              </button>
            ))}
          </div>
        </section>
        <section
          className={`mobile-warband ${targeting ? "choosing-target" : ""}`}
          aria-label="我的战场"
        >
          <div className="mobile-section-heading">
            <h2>
              <Swords size={14} />
              战场 <small>{game.board.length}/7</small>
            </h2>
            <span>
              {targeting ? "点选技能目标" : "点选随从可出售、调整站位"}
            </span>
          </div>
          <div className="mobile-board-slots">
            {Array.from({ length: 7 }, (_, i) => {
              const m = game.board[i];
              return (
                <div
                  key={m?.uid || `empty-${i}`}
                  className={`mobile-board-slot ${m ? "occupied" : ""}`}
                >
                  {m ? card(m, "board") : <span>{i + 1}</span>}
                </div>
              );
            })}
          </div>
        </section>
        <section className="mobile-hand" aria-label="我的手牌">
          <div className="mobile-section-heading">
            <h2>
              <BookOpen size={14} />
              手牌 <small>{game.hand.length + game.rewards.length}/10</small>
            </h2>
            <span>左右滑动 · 点选打出</span>
          </div>
          <div className="mobile-hand-cards mobile-card-strip">
            {game.hand.map((m) => (
              <div key={m.uid}>{card(m, "hand")}</div>
            ))}
            {game.rewards.map((tier, i) => (
              <button
                className="mobile-reward"
                key={i}
                onClick={() => dispatch({ type: "reward" })}
              >
                <Sparkles size={20} />
                <strong>三连奖励</strong>
                <span>{tier}星发现</span>
              </button>
            ))}
            {!game.hand.length && !game.rewards.length && (
              <p className="mobile-empty">在酒馆选择一位随从，招募到手牌。</p>
            )}
          </div>
        </section>
        <aside className="mobile-dock">
          <div className="mobile-hero">
            <img src={art(hero.art)} alt={hero.name} />
            <div>
              <strong>{hero.name}</strong>
              <span>
                <Heart size={13} />
                {Math.max(0, game.health)}
                {game.season && (
                  <>
                    <Shield size={13} />
                    {game.season.armor}
                  </>
                )}
              </span>
            </div>
          </div>
          <button
            className={`mobile-power ${game.powerUsed ? "used" : ""}`}
            onClick={power}
            disabled={!recruit || game.powerUsed}
            aria-label={
              hero.passive
                ? `被动英雄技能：${hero.text}`
                : game.powerUsed
                  ? "本回合已使用英雄技能"
                  : `使用英雄技能：${hero.power}，${hero.cost}金币`
            }
          >
            <Sparkles size={16} />
            <strong>{game.powerUsed ? "本回合已使用" : hero.power}</strong>
            <span>{hero.passive ? "被动" : `${hero.cost} 金币`}</span>
          </button>
          <div className="mobile-utilities">
            {game.season && (
              <button onClick={season}>
                <Gem size={14} />
                赛季玩法<small>{game.season.giftsUsed}/3</small>
              </button>
            )}
            <button onClick={pool}>
              <BookOpen size={14} />
              随从池
            </button>
          </div>
          <button
            className="mobile-end"
            onClick={() => dispatch({ type: "end" })}
            disabled={!recruit}
          >
            结束招募
            <Swords size={16} />
          </button>
        </aside>
      </div>
    </div>
  );
}
