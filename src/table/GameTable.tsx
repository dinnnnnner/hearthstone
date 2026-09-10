import { equippedPowers } from "../season/powers";
import { KeywordEffects } from "./KeywordEffects";
import { RefreshPrice } from "./RefreshPrice";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Coins,
  Crown,
  Gem,
  Heart,
  HelpCircle,
  LayoutGrid,
  Maximize,
  Pause,
  Play,
  Plus,
  RotateCw,
  Settings,
  Shield,
  SkipForward,
  Snowflake,
  Skull,
  FlaskConical,
  Wind,
  Sparkles,
  Swords,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { art, cardText, getDef, HEROES } from "../data";
import {
  heroOf,
  heroPowerState,
  targetsFor,
  type Action,
  type Game,
  type Minion,
} from "../engine";
import {
  minionCost,
  refreshCost,
  refreshPayment,
  seasonTargets,
  spellCost,
  TRINKETS,
} from "../season/engine";
import { GiftNote, CardSource } from "../season/Panels";
import { basePath } from "../paths";
import { BoardDecoration } from "./BoardDecoration";
import { Effects, type EffectsHandle } from "./Effects";
import { shortStat } from "./presentation";
import { useSceneMotion } from "./useSceneMotion";
import { playTableSound } from "./sound";
export type Zone = "shop" | "hand" | "board" | "spellshop";
type Selection = { m: Minion; zone: Zone };
type Drag = {
  m: Minion;
  zone: Zone;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moving: boolean;
  pointer: number;
};
type Props = {
  rope?: import("react").ReactNode;
  lobby?: () => void;
  roomStatus?: import("react").ReactNode;
  locked?: boolean;
  game: Game;
  dispatch: (a: Action) => boolean;
  selection: Selection | null;
  choose: (m: Minion, zone: Zone) => void;
  close: () => void;
  play: (m: Minion, position?: number) => void;
  activate: (m: Minion) => void;
  power: (id?: string) => void;
  targeting: boolean;
  frame: number;
  setFrame: (n: number) => void;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  speed: number;
  setSpeed: (v: number) => void;
  sound: boolean;
  toggleSound: () => void;
  newGame: () => void;
  settings: () => void;
  help: () => void;
  collection: () => void;
  heroes: () => void;
  season: () => void;
  pool: () => void;
  notify: (s: string) => void;
  card: (m: Minion) => ReactNode;
};
function Piece({
  m,
  selected = false,
  combat = false,
  ...events
}: {
  m: Minion;
  selected?: boolean;
  combat?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove?: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (e: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: () => void;
}) {
  const d = getDef(m.id),
    activate = d.abilities?.some((a) => a.event === "activate");
  return (
    <button
      {...events}
      className={`table-piece ${m.golden ? "golden-piece" : ""} ${m.keywords.includes("圣盾") ? "shield-piece" : ""} ${m.keywords.includes("嘲讽") ? "taunt-piece" : ""} ${selected ? "chosen-piece" : ""} ${m.health <= 0 ? "fallen-piece" : ""}`}
      data-piece-id={m.uid}
      data-target={m.uid}
      aria-label={`${d.name}，${m.attack}攻击，${m.health}生命，${cardText(m)}，当前关键词：${[...m.keywords, ...(m.rebornNext ? ["复生"] : [])].join("、") || "无"}`}
    >
      <KeywordEffects m={m} />
      <span className="piece-frame">
        <img src={art(m.id)} alt="" draggable={false} />
        <span className="piece-vignette" />
      </span>
      <span className="piece-tier">{"★".repeat(d.tier)}</span>
      <span className="piece-attack" title={`${m.attack}攻击`}>
        {shortStat(m.attack)}
      </span>
      <span className="piece-health" title={`${m.health}生命`}>
        {shortStat(m.health)}
      </span>
      <span className="piece-abilities">
        {m.rebornNext || m.keywords.includes("复生") ? (
          <span className="keyword-badge reborn-badge" title="复生"><RotateCw size={12} /></span>
        ) : null}
        {m.keywords.includes("烈毒") || m.keywords.includes("剧毒") ? (
          <span className="keyword-badge poison-badge" title={m.keywords.includes("烈毒") ? "烈毒" : "剧毒"}><FlaskConical size={12} /></span>
        ) : null}
        {[...(d.abilities || []), ...(m.extraAbilities || [])].some((a) => a.event === "death") ? <span className="keyword-badge deathrattle-badge" title="亡语"><Skull size={12} /></span> : null}
        {m.keywords.includes("风怒") && <span className="keyword-badge windfury-badge" title="风怒"><Wind size={12} /></span>}
        {m.gift ? <Gem size={12} /> : null}
        {activate && !combat ? (
          <span className={m.activated ? "spent-activate" : "ready-activate"}>
            ϟ
          </span>
        ) : null}
      </span>
      <span className="piece-name">{d.name}</span>
    </button>
  );
}
export function GameTable(p: Props) {
  const { game, dispatch, selection, choose, close, targeting, frame } = p;
  const payment = refreshPayment(game);
  const hero = heroOf(game),
    combat = game.phase === "combat",
    finished = combat && frame === (game.battle?.frames.length || 0) - 1,
    recruit = game.phase === "recruit";
  const current = combat ? game.battle?.frames[frame] : undefined;
  const allies = current?.allies || game.board,
    enemies = current?.enemies || game.shop,
    opponent = game.opponents[game.nextOpponent];
  const table = useRef<HTMLDivElement>(null),
    effects = useRef<EffectsHandle>(null),
    flightLayer = useRef<HTMLDivElement>(null),
    lastTriples = useRef(game.triples),
    lastPhase = useRef(game.phase);
  const [drag, setDrag] = useState<Drag | null>(null),
    dragRef = useRef<Drag | null>(null),
    suppressClick = useRef(false);
  const [phaseBanner, setPhaseBanner] = useState(
      game.phase === "combat" ? "战斗开始" : "欢迎来到酒馆",
    ),
    [tripleBanner, setTripleBanner] = useState(false),
    [rival, setRival] = useState<number | null>(null),
    [hudText, setHudText] = useState("");
  const [motionReset, setMotionReset] = useState(0);
  const { overrides: displayed, heroStruck } = useSceneMotion({
    reset: motionReset,
    game,
    current,
    frame,
    speed: p.speed,
    playing: p.playing,
    sound: p.sound,
    root: table,
    layer: flightLayer,
    effects,
  });
  const previousStats = useRef({
    health: game.health,
    armor: game.season?.armor || 0,
    enemyHealth: opponent?.health || 0,
  });
  useEffect(() => {
    if (recruit)
      previousStats.current = {
        health: game.health,
        armor: game.season?.armor || 0,
        enemyHealth: opponent?.health || 0,
      };
  }, [game.health, game.season?.armor, opponent?.health, recruit]);
  useEffect(() => {
    const id = setTimeout(() => setPhaseBanner(""), 1600);
    return () => clearTimeout(id);
  }, [phaseBanner]);
  useEffect(() => {
    if (lastPhase.current !== game.phase) {
      setPhaseBanner(
        combat ? "战斗开始" : recruit ? `第 ${game.turn} 回合` : "对局结束",
      );
      lastPhase.current = game.phase;
      if (combat) playTableSound("round", p.sound);
    }
  }, [game.phase, game.turn, combat, recruit, p.sound]);
  useEffect(() => {
    if (lastTriples.current < game.triples) {
      setTripleBanner(true);

      const r = table.current?.getBoundingClientRect();
      if (r)
        effects.current?.burst(
          r.x + r.width / 2,
          r.y + r.height * 0.76,
          "gold",
        );
    }
    lastTriples.current = game.triples;
    const id = setTimeout(() => setTripleBanner(false), 1900);
    return () => clearTimeout(id);
  }, [game.triples, p.sound]);
  useEffect(() => {
    if (hudText) {
      const id = setTimeout(() => setHudText(""), 2000);
      return () => clearTimeout(id);
    }
  }, [hudText]);
  function rivalHealth(index: number) {
    return combat && index === game.nextOpponent && (!finished || !heroStruck)
      ? previousStats.current.enemyHealth
      : game.opponents[index].health;
  }
  function startDrag(
    e: PointerEvent<HTMLButtonElement>,
    m: Minion,
    zone: Zone,
  ) {
    if (!recruit || targeting || e.button !== 0) return;
    dragRef.current = {
      m,
      zone,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moving: false,
      pointer: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveDrag(e: PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d) return;
    const moving =
      d.moving || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 9;
    if (moving) {
      const next = { ...d, x: e.clientX, y: e.clientY, moving };
      dragRef.current = next;
      setDrag(next);
      close();
    }
  }
  function stopDrag(e: PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d?.moving) return;
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    const hit = document.elementFromPoint(e.clientX, e.clientY),
      zone = hit?.closest<HTMLElement>("[data-dropzone]")?.dataset.dropzone,
      target = hit?.closest<HTMLElement>("[data-target]")?.dataset.target;
    if (
      d.zone === "shop" &&
      (zone === "hand" || zone === "board" || zone === "hero")
    ) {
      dispatch({ type: "buy", uid: d.m.uid });
      return;
    }
    if (d.zone === "board" && zone === "sell") {
      dispatch({ type: "sell", uid: d.m.uid });
      return;
    }
    if (d.zone === "board" && zone === "board") {
      const cells = [
        ...table.current!.querySelectorAll<HTMLElement>(
          ".friendly-row [data-slot]",
        ),
      ];
      const i = cells.findIndex(
        (el) => e.clientX < el.getBoundingClientRect().right,
      );
      dispatch({
        type: "move",
        uid: d.m.uid,
        to: i < 0 ? game.board.length - 1 : i,
      });
      return;
    }
    if (
      d.zone === "hand" &&
      (zone === "board" || zone === "shop" || zone === "hero")
    ) {
      const spell = getDef(d.m.id).kind === "spell",
        targets =
          spell && game.season
            ? seasonTargets(game, d.m, "cast")
            : targetsFor(game, d.m);
      if (target && targets.some((m) => m.uid === target)) {
        dispatch({ type: spell ? "cast" : "play", uid: d.m.uid, target });
        return;
      }
      if (zone !== "board" && zone !== "hero") {
        p.notify("把随从拖到自己的战场，或选择有效法术目标。");
        return;
      }
      const cells = [
        ...table.current!.querySelectorAll<HTMLElement>(
          ".friendly-row [data-slot]",
        ),
      ];
      const i = cells.findIndex(
        (el) =>
          e.clientX <
          el.getBoundingClientRect().left +
            el.getBoundingClientRect().width / 2,
      );
      p.play(d.m, i < 0 ? game.board.length : Math.min(i, game.board.length));
      return;
    }
    if (d.zone === "spellshop" && (zone === "hand" || zone === "hero"))
      dispatch({ type: "buySpell", uid: d.m.uid });
  }
  const cancelDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };
  function choosePiece(m: Minion, zone: Zone) {
    if (!suppressClick.current) choose(m, zone);
  }
  function piece(m: Minion, zone: Zone) {
    return (
      <Piece
        key={m.uid}
        m={displayed.get(m.uid) || m}
        combat={combat}
        selected={selection?.m.uid === m.uid || (targeting && zone === "board")}
        onClick={() => choosePiece(m, zone)}
        onDoubleClick={() => {
          if (!recruit || targeting) return;
          if (zone === "shop") dispatch({ type: "buy", uid: m.uid });
          else if (zone === "hand") p.play(m);
        }}
        onPointerDown={(e) => startDrag(e, m, zone)}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={cancelDrag}
      />
    );
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen)
        await document.documentElement.requestFullscreen();
      else p.notify("当前浏览器不支持网页全屏，可以横屏游玩。");
    } catch {
      p.notify("浏览器未允许全屏，仍可正常游玩。");
    }
  }
  const cost = selection
    ? selection.zone === "shop"
      ? game.season
        ? minionCost(game, selection.m)
        : 3
      : selection.zone === "spellshop"
        ? spellCost(game, selection.m)
        : 0
    : 0;
  const primary = () => {
    if (!selection) return;
    if (selection.zone === "shop")
      dispatch({ type: "buy", uid: selection.m.uid });
    else if (selection.zone === "spellshop")
      dispatch({ type: "buySpell", uid: selection.m.uid });
    else if (selection.zone === "hand") p.play(selection.m);
  };
  return (
    <div
      data-playing={p.playing}
      style={{ "--motion-speed": p.speed } as CSSProperties}
      className={`game-table ${combat ? "combat-table" : ""} ${drag?.moving ? "dragging-table" : ""}`}
    >
      <header className="table-header">
        <div className="table-brand">
          {basePath !== "/" ? (
            <a href="/" aria-label="返回游戏大厅">
              <LayoutGrid size={17} />
            </a>
          ) : (
            <Crown size={18} />
          )}
          <span>
            鲍勃的酒馆
            <small>{game.season ? "第14赛季 · 36.4.2" : "经典精选"}</small>
          </span>
        </div>
        <div className="table-header-center">
          {p.roomStatus || game.season?.tribes.join(" · ") || "经典随从练习"}
        </div>
        <nav>
          {p.lobby && (
            <button onClick={p.lobby} aria-label="对战大厅" title="对战大厅">
              <LayoutGrid size={17} />
            </button>
          )}
          <button onClick={p.collection} aria-label="随从图鉴" title="随从图鉴">
            <BookOpen size={17} />
          </button>
          <button onClick={p.heroes} aria-label="英雄图鉴" title="英雄图鉴">
            <Users size={17} />
          </button>
          <button
            onClick={p.toggleSound}
            aria-label={p.sound ? "关闭音效" : "开启音效"}
          >
            {p.sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
          </button>
          <button onClick={fullscreen} aria-label="切换全屏">
            <Maximize size={17} />
          </button>
          <button onClick={p.settings} aria-label="偏好设置">
            <Settings size={17} />
          </button>
          <button onClick={p.help} aria-label="查看玩法指南">
            <HelpCircle size={17} />
          </button>
          <button className="table-new" onClick={p.newGame}>
            <Plus size={14} />
            <span>新对局</span>
          </button>
        </nav>
      </header>
      <div className="table-game">
        <aside className="opponent-rail" aria-label="对局英雄">
          <span className="rail-caption">本局英雄</span>
          {game.opponents.map((o, i) => (
            <button
              key={o.hero}
              className={`rival-token ${i === game.nextOpponent ? "next-rival" : ""} ${rivalHealth(i) <= 0 ? "eliminated" : ""}`}
              onClick={() => setRival(rival === i ? null : i)}
              aria-label={`${o.name}，${rivalHealth(i) <= 0 ? "已淘汰" : rivalHealth(i) + "生命"}${i === game.nextOpponent ? "，下一位对手" : ""}`}
            >
              <img
                src={art(HEROES.find((h) => h.id === o.hero)!.art)}
                alt=""
                fetchPriority="low"
                decoding="async"
              />
              <span className="rival-tier">{"★".repeat(o.tier)}</span>
              <span className="rival-hp">
                {rivalHealth(i) <= 0 ? "☠" : rivalHealth(i)}
              </span>
              {i === game.nextOpponent && <i />}
            </button>
          ))}
          <div className="rail-self">
            <img src={art(hero.art)} alt="" />
            <span>你</span>
          </div>
        </aside>
        <div className="table-arena" ref={table}>
          <div className="table-ambience">
            <i />
            <i />
            <i />
          </div>
          <div
            className={`wooden-table ${game.frozen && !combat ? "frozen-table" : ""}`}
          >
            {p.rope}
            <BoardDecoration />
            <div className="board-corner top-left">✦</div>
            <div className="board-corner top-right">✦</div>
            <div
              className={`bartender ${drag?.zone === "board" ? "sell-ready" : ""}`}
              data-dropzone="sell"
            >
              <div className="portrait-frame">
                <img
                  src={art(
                    combat
                      ? HEROES.find((h) => h.id === opponent?.hero)!.art
                      : "TB_BaconShopBob",
                  )}
                  alt={combat ? opponent?.name : "鲍勃"}
                />
              </div>
              <span>
                {combat
                  ? opponent?.name
                  : drag?.zone === "board"
                    ? "拖到这里出售 +1"
                    : "鲍勃"}
              </span>
              {combat && (
                <b className="enemy-life">
                  <Heart size={11} />
                  {!finished || !heroStruck
                    ? previousStats.current.enemyHealth
                    : Math.max(0, opponent?.health || 0)}
                </b>
              )}
            </div>
            {!combat && (
              <div className="bob-controls">
                <button
                  className="tavern-control upgrade-control"
                  onClick={() => dispatch({ type: "upgrade" })}
                  disabled={
                    !recruit || game.tier === 6 || game.gold < game.upgrade
                  }
                  aria-label={`升级酒馆，${game.upgrade}金币`}
                >
                  <span className="control-cost">
                    {game.tier === 6 ? "★" : game.upgrade}
                  </span>
                  <Crown />
                  <span>{game.tier === 6 ? "满级酒馆" : "升级"}</span>
                </button>
                <div className="right-bob-controls">
                  <button
                    className={`tavern-control ${payment.health ? "health-refresh-control" : ""}`}
                    onClick={() => dispatch({ type: "refresh" })}
                    disabled={
                      !recruit ||
                      game.gold < (game.season ? refreshCost(game) : 1)
                    }
                    aria-label="刷新酒馆"
                    title={payment.health ? `消耗${payment.health}点生命，剩余${payment.remaining}次` : `消耗${payment.gold}金币`}
                  >
                    <span className="control-cost">
                      <RefreshPrice game={game} compact />
                    </span>
                    <RotateCw />
                    <span>{payment.health ? `刷新 · ${payment.remaining}次` : "刷新"}</span>
                  </button>
                  <button
                    className={`tavern-control freeze-control ${game.frozen ? "active" : ""}`}
                    onClick={() => dispatch({ type: "freeze" })}
                    disabled={!recruit}
                    aria-label={game.frozen ? "解冻酒馆" : "冻结酒馆"}
                  >
                    <span className="control-cost">0</span>
                    <Snowflake />
                    <span>{game.frozen ? "解冻" : "冻结"}</span>
                  </button>
                </div>
              </div>
            )}
            <div className="table-level">
              <span>{"★".repeat(game.tier)}</span>
              <small>{game.tier} 星酒馆</small>
            </div>
            <div
              className={`table-row tavern-row ${combat ? "enemy-row" : ""}`}
              data-dropzone="shop"
              aria-label={combat ? "对手战场" : "酒馆随从"}
            >
              {enemies.map((m) => piece(m, "shop"))}
              {!enemies.length && (
                <span className="empty-table-row">
                  {combat ? "对手随从已退场" : "酒馆已售空，刷新寻找新伙伴"}
                </span>
              )}
              {!combat &&
                game.season?.spellShop.map((m) => (
                  <button
                    className="table-shop-spell"
                    key={m.uid}
                    onClick={() => choose(m, "spellshop")}
                    onPointerDown={(e) => startDrag(e, m, "spellshop")}
                    onPointerMove={moveDrag}
                    onPointerUp={stopDrag}
                    onPointerCancel={cancelDrag}
                    aria-label={`酒馆法术：${getDef(m.id).name}`}
                  >
                    <img src={art(m.id)} alt="" />
                    <b>{spellCost(game, m)}</b>
                    <span>{getDef(m.id).name}</span>
                    <small>酒馆法术</small>
                  </button>
                ))}
            </div>
            <div className="board-divider">
              <span />
              {combat ? (
                <Swords size={16} />
              ) : (
                <span className="divider-diamond">◆</span>
              )}
              <span />
            </div>
            <div
              className={`table-row friendly-row ${targeting ? "targeting-row" : ""}`}
              data-dropzone="board"
              aria-label="我的战场"
            >
              {Array.from(
                { length: Math.max(allies.length, recruit ? 7 : 0) },
                (_, i) => {
                  const m = allies[i];
                  return (
                    <div
                      className="table-slot"
                      data-slot={i}
                      key={m?.uid || `slot-${i}`}
                      data-target={m?.uid}
                    >
                      {m ? (
                        piece(m, "board")
                      ) : recruit ? (
                        <span
                          className={`empty-table-slot ${drag?.zone === "hand" ? "drop-ready" : ""}`}
                        >
                          <Plus size={14} />
                          <small>{i + 1}</small>
                        </span>
                      ) : null}
                    </div>
                  );
                },
              )}
              {combat && !allies.length && (
                <span className="empty-table-row">己方随从已退场</span>
              )}
            </div>
            {recruit && !game.board.length && (
              <p className="table-onboarding">
                把手牌拖上战场，开始组建你的阵容。
                <small>也可以点选随从操作</small>
              </p>
            )}
            <div className="player-hero-area" data-dropzone="hero">
              <div className="trinket-coins">
                {[0, 1].map((i) => {
                  const t = TRINKETS.find(
                    (t) => t.id === game.season?.trinkets[i],
                  );
                  return (
                    <button
                      key={i}
                      onClick={p.season}
                      title={
                        t
                          ? `${t.name}：${t.text}`
                          : `第${i === 0 ? 6 : 9}回合选择饰品`
                      }
                      aria-label={t?.name || `${i === 0 ? "小型" : "大型"}饰品`}
                      className={t ? "equipped" : ""}
                    >
                      {t ? <img src={art(t.id)} alt="" /> : <Gem size={18} />}
                    </button>
                  );
                })}
              </div>
              <button
                className="player-hero-token"
                onClick={() => setHudText(`${hero.name} · ${hero.text}`)}
                aria-label={`${hero.name}，${game.health}生命`}
              >
                <div className="portrait-frame">
                  <img src={art(hero.art)} alt={hero.name} />
                </div>
                <span className="hero-name-ribbon">{hero.name}</span>
                <span className="table-hero-armor">
                  <Shield size={14} />
                  {combat && (!finished || !heroStruck)
                    ? previousStats.current.armor
                    : game.season?.armor || 0}
                </span>
                <span className="table-hero-health">
                  {combat && (!finished || !heroStruck)
                    ? previousStats.current.health
                    : Math.max(0, game.health)}
                </span>
              </button>
          <div className={`hero-power-group ${equippedPowers(game).length > 1 ? "dual" : ""}`}>
            {equippedPowers(game).map((id) => { const powerState = heroPowerState(game, id), powerHero = powerState.definition; return (
              <button key={id}
                className={`hero-power-orb ${powerState.used ? "used" : ""}`}
                onClick={() => p.power(id)}
                disabled={!recruit || powerState.used}
                aria-label={
                  powerState.used
                    ? `${powerState.status}英雄技能`
                    : `使用英雄技能：${powerHero.power}`
                }
                title={[powerHero.text, powerState.status].filter(Boolean).join("\n")}
              >
                <span className="orb-core">
                  <Sparkles size={30} />
                </span>
                <b>{powerHero.passive ? "∞" : powerState.cost}</b>
                <small>{powerState.used ? powerState.status : powerHero.power}</small>
                {!powerState.used && powerState.status && !powerHero.passive && <span className="hero-power-status">{powerState.status}</span>}
              </button>
            ); })}
          </div>
            </div>
            <div className="round-medallion">
              <span>第 {game.turn} 回合</span>
              <strong>
                {combat
                  ? "战斗阶段"
                  : game.phase === "over"
                    ? "对局结束"
                    : "招募阶段"}
              </strong>
              <small>
                {recruit
                  ? p.roomStatus
                    ? "限时招募"
                    : "不限时练习"
                  : finished
                    ? "战斗已结束"
                    : "自动交战"}
              </small>
            </div>
            <button
              className="table-end-turn"
              onClick={() => dispatch({ type: combat ? "continue" : "end" })}
              disabled={p.locked || (combat ? !finished : !recruit)}
            >
              {p.locked
                ? "等待其他玩家"
                : combat
                  ? finished
                    ? "返回酒馆"
                    : "交战中"
                  : "结束招募"}
              {combat ? <Swords size={17} /> : <ArrowRight size={17} />}
            </button>
            {game.season && !combat && (
              <button
                className="dark-discovery-orb"
                onClick={() => dispatch({ type: "darkGift" })}
                disabled={
                  !recruit ||
                  game.turn < 3 ||
                  game.gold < 3 ||
                  game.season.giftsUsed >= 3 ||
                  game.season.giftUsedTurn === game.turn
                }
                aria-label="黑暗发现，3金币"
              >
                <span>
                  <Gem size={26} />
                </span>
                <b>3</b>
                <small>黑暗发现</small>
                <em>
                  {game.turn < 3
                    ? "第3回合解锁"
                    : `${game.season.giftsUsed} / 3`}
                </em>
              </button>
            )}
            <div className="board-gold">
              <div className="coin-pips">
                {Array.from(
                  { length: Math.min(game.season?.maxGold || 10, 15) },
                  (_, i) => (
                    <i key={i} className={i < game.gold ? "filled" : ""} />
                  ),
                )}
              </div>
              <strong>
                <Coins size={16} />
                {game.gold}
                <small>
                  {" "}
                  / {game.season?.maxGold || Math.min(10, game.turn + 2)}
                </small>
              </strong>
            </div>
          </div>
          <div
            className="table-hand"
            data-dropzone="hand"
            aria-label="我的手牌"
          >
            <span className="hand-counter">
              <BookOpen size={12} />
              {game.hand.length + game.rewards.length}/10
            </span>
            <div className="hand-fan">
              {game.hand.map((m, i) => (
                <div
                  key={m.uid}
                  className="table-hand-card"
                  style={
                    {
                      "--fan-angle": `${(i - (game.hand.length - 1) / 2) * 2}deg`,
                    } as CSSProperties
                  }
                >
                  <button
                    data-hand-id={m.uid}
                    className={`hand-card-button ${m.golden ? "golden-hand" : ""}`}
                    onPointerDown={(e) => startDrag(e, m, "hand")}
                    onPointerMove={moveDrag}
                    onPointerUp={stopDrag}
                    onPointerCancel={cancelDrag}
                    onClick={() => choosePiece(m, "hand")}
                    onDoubleClick={() => p.play(m)}
                    aria-label={`手牌：${getDef(m.id).name}`}
                  >
                    <img src={art(m.id)} alt="" draggable={false} />
                    <span className="hand-card-tier">
                      {"★".repeat(getDef(m.id).tier)}
                    </span>
                    <strong>{getDef(m.id).name}</strong>
                    <p>{cardText(m)}</p>
                    <span className="hand-card-stats">
                      {getDef(m.id).kind === "spell" ? (
                        <Sparkles size={15} />
                      ) : (
                        <>
                          <b>{shortStat(m.attack)}</b>
                          <b>{shortStat(m.health)}</b>
                        </>
                      )}
                    </span>
                  </button>
                </div>
              ))}
              {game.rewards.map((tier, i) => (
                <button
                  key={`reward-${i}`}
                  className="table-reward"
                  onClick={() => dispatch({ type: "reward" })}
                >
                  <Sparkles size={24} />
                  <strong>三连奖励</strong>
                  <span>{tier} 星发现</span>
                </button>
              ))}
              {!game.hand.length && !game.rewards.length && (
                <div className="hand-rest">
                  <span>你的手牌</span>
                  <small>从酒馆拖到这里，或双击随从购买</small>
                </div>
              )}
            </div>
          </div>
          <div
            ref={flightLayer}
            className="scene-flight-layer"
            aria-hidden="true"
          />
          <Effects
            ref={effects}
            playing={!combat || p.playing}
            speed={combat ? p.speed : 1}
          />
          {finished && heroStruck && (
            <div className={`battle-verdict ${game.battle!.result}`}>
              <Swords size={24} />
              <strong>
                {game.battle!.result === "win"
                  ? "战斗胜利"
                  : game.battle!.result === "loss"
                    ? "战斗失利"
                    : "势均力敌"}
              </strong>
              <span>
                {game.battle!.damage
                  ? `${game.battle!.result === "win" ? "造成" : "受到"} ${game.battle!.damage} 点伤害`
                  : "双方英雄未受伤害"}
              </span>
            </div>
          )}
          {phaseBanner && (
            <div className="phase-ribbon" key={phaseBanner}>
              <Swords size={23} />
              {phaseBanner}
            </div>
          )}
          {tripleBanner && (
            <div className="triple-ribbon">
              <Sparkles size={30} />
              <strong>金色传说！</strong>
              <span>三连合成，金色随从已加入手牌</span>
            </div>
          )}
          {hudText && <div className="table-hud-message">{hudText}</div>}
          {rival !== null && (
            <div className="rival-detail">
              <button onClick={() => setRival(null)} aria-label="关闭对手信息">
                <X size={16} />
              </button>
              <strong>{game.opponents[rival].name}</strong>
              <span>
                {game.opponents[rival].tier}星 ·{" "}
                {Math.max(0, game.opponents[rival].health)}生命 ·{" "}
                {game.opponents[rival].armor || 0}护甲
              </span>
              <p>
                {rival === game.nextOpponent
                  ? "下一轮将与你交战"
                  : "本局练习对手"}
              </p>
            </div>
          )}
          {selection && !targeting && (
            <aside className="table-inspector" aria-label="随从操作">
              <button
                className="inspect-close"
                onClick={close}
                aria-label="关闭卡牌详情"
              >
                <X size={18} />
              </button>
              <div className="inspect-card">{p.card(selection.m)}</div>
              <h2>{getDef(selection.m.id).name}</h2>
              <p>{cardText(selection.m)}</p>
              <GiftNote m={selection.m} />
              <div className="inspector-actions">
                {recruit &&
                  (selection.zone === "shop" ||
                    selection.zone === "spellshop" ||
                    selection.zone === "hand") && (
                    <button
                      className="inspect-primary"
                      onClick={primary}
                      disabled={
                        selection.zone !== "hand" &&
                        (game.gold < cost ||
                          game.hand.length + game.rewards.length >= 10)
                      }
                    >
                      {selection.zone === "hand"
                        ? getDef(selection.m.id).kind === "spell"
                          ? "施放法术"
                          : "打出随从"
                        : selection.zone === "spellshop"
                          ? "购买法术"
                          : "招募随从"}
                      {cost > 0 && (
                        <>
                          <Coins size={13} />
                          {cost}
                        </>
                      )}
                      <ArrowUp size={14} />
                    </button>
                  )}
                {recruit && selection.zone === "board" && (
                  <>
                    {getDef(selection.m.id).abilities?.some(
                      (a) => a.event === "activate",
                    ) && (
                      <button
                        className="inspect-primary"
                        onClick={() => p.activate(selection.m)}
                        disabled={
                          selection.m.activated ||
                          game.gold < (getDef(selection.m.id).activateCost || 0)
                        }
                      >
                        {selection.m.activated ? "本回合已发动" : "发动技能"}
                        <Coins size={12} />
                        {getDef(selection.m.id).activateCost || 0}
                      </button>
                    )}
                    <div className="inspect-move">
                      <button
                        onClick={() =>
                          dispatch({
                            type: "move",
                            uid: selection.m.uid,
                            to:
                              game.board.findIndex(
                                (m) => m.uid === selection.m.uid,
                              ) - 1,
                          })
                        }
                        disabled={game.board[0]?.uid === selection.m.uid}
                      >
                        <ArrowLeft size={14} />
                        左移
                      </button>
                      <button
                        onClick={() =>
                          dispatch({
                            type: "move",
                            uid: selection.m.uid,
                            to:
                              game.board.findIndex(
                                (m) => m.uid === selection.m.uid,
                              ) + 1,
                          })
                        }
                        disabled={game.board.at(-1)?.uid === selection.m.uid}
                      >
                        右移
                        <ArrowRight size={14} />
                      </button>
                    </div>
                    <button
                      className="inspect-sell"
                      onClick={() =>
                        dispatch({ type: "sell", uid: selection.m.uid })
                      }
                    >
                      出售随从 <Coins size={12} />
                      +1
                    </button>
                  </>
                )}
              </div>
              <details className="inspect-source">
                <summary>卡面与资料</summary>
                <CardSource m={selection.m} />
              </details>
            </aside>
          )}
        </div>
      </div>
      <footer className="table-footer">
        <span>
          {p.roomStatus ||
            (recruit
              ? drag?.moving
                ? "松开以完成操作"
                : "拖动购买 / 打出 · 拖向鲍勃出售"
              : current?.text || "准备下一轮")}
          <span className="table-footer-scope">当前赛季部分复刻</span>
        </span>
        {combat ? (
          <div className="table-playback">
            <button
              onClick={() => p.setPlaying(!p.playing)}
              aria-label={p.playing ? "暂停战斗" : "继续播放"}
            >
              {p.playing ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <select
              value={p.speed}
              onChange={(e) => p.setSpeed(Number(e.target.value))}
              aria-label="战斗速度"
            >
              <option value={0.75}>0.75×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
            </select>
            <button
              onClick={() => {
                setMotionReset((n) => n + 1);
                p.setFrame(game.battle!.frames.length - 1);
              }}
            >
              <SkipForward size={13} />
              跳过动画
            </button>
            {finished && (
              <strong>
                {game.battle!.result === "win"
                  ? "胜利"
                  : game.battle!.result === "loss"
                    ? "失利"
                    : "平局"}{" "}
                · {game.battle!.damage}点伤害
              </strong>
            )}
          </div>
        ) : (
          <div>
            <button onClick={p.pool}>
              <BookOpen size={12} />
              随从池
            </button>
            {game.season && (
              <button onClick={p.season}>
                <Gem size={12} />
                赛季玩法
              </button>
            )}
          </div>
        )}
      </footer>
      {drag?.moving && (
        <div className="table-drag-ghost" style={{ left: drag.x, top: drag.y }}>
          <Piece m={drag.m} />
        </div>
      )}
    </div>
  );
}
