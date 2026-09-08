import type { NetworkGame } from "./online/OnlineApp";
import { useBattlePlayback } from "./table/useBattlePlayback";
import { GameTable } from "./table/GameTable";
import { playTableSound, type TableSound } from "./table/sound";
import { basePath } from "./paths";
import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutGrid,
  Smartphone,
  Monitor,
  Beer,
  Swords,
  BookOpen,
  Users,
  History,
  Settings,
  ChevronRight,
  ChevronLeft,
  ArrowUp,
  RotateCw,
  Snowflake,
  Coins,
  Heart,
  Shield,
  Sparkles,
  Plus,
  X,
  Check,
  ArrowRight,
  Search,
  Volume2,
  VolumeX,
  HelpCircle,
  Flame,
  Crown,
  GripVertical,
  Trophy,
  ExternalLink,
  CheckCircle2,
  WandSparkles,
  Play,
  SkipForward,
  ArrowUpRight,
} from "lucide-react";
import {
  CARDS,
  HEROES,
  CLASSIC_HEROES,
  POOL_COPIES,
  art,
  getDef,
  cardText,
} from "./data";
import {
  SEASON_CATALOG,
  SEASON_CARDS,
  SEASON_HEROES,
  SEASON_SPELL_CATALOG,
  ALL_TRIBES,
} from "./season/catalog";
import {
  seasonTargets,
  refreshCost,
  minionCost,
  spellCost,
} from "./season/engine";
import {
  SeasonBar,
  SpellShelf,
  GiftNote,
  SeasonTrinkets,
  CardSource,
  CoverageNote,
} from "./season/Panels";
import {
  act,
  createGame,
  heroOf,
  targetsFor,
  poolTotal,
  type Game,
  type Minion,
  type Action,
} from "./engine";
import { MobileArena, usePlayMode } from "./mobile/MobileArena";
const SAVE_KEY = "bobs-tavern-season14-v1";
const load = (): Game => {
  try {
    const x = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
    if (
      x?.version === 1 &&
      (x.season?.patch === "36.4.2" ||
        CARDS.every((c) => typeof x.pool?.[c.id] === "number"))
    )
      return x;
  } catch {}
  return createGame("s14_lich");
};
type Page = "tavern" | "cards" | "heroes" | "history";
type Selection = { m: Minion; zone: "shop" | "board" | "hand" | "spellshop" };
function Coin({ small = false }: { small?: boolean }) {
  return <span className={`coin-icon ${small ? "small" : ""}`}>●</span>;
}
function Stars({ tier }: { tier: number }) {
  return <span className="stars">{"★".repeat(tier)}</span>;
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose?: () => void;
  wide?: boolean;
}) {
  return (
    <div className="modal-shade" onClick={onClose}>
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {onClose && (
            <button className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={20} />
            </button>
          )}
        </div>
        {children}
      </section>
    </div>
  );
}
function MinionCard({
  m,
  onClick,
  compact = false,
  selected = false,
  draggable = false,
  onDragStart,
  disabled = false,
}: {
  m: Minion;
  onClick?: () => void;
  compact?: boolean;
  selected?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  disabled?: boolean;
}) {
  const d = getDef(m.id);
  if (d.kind === "spell")
    return (
      <button
        className={`minion-card spell-card ${compact ? "compact" : ""}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={`${d.name}，${d.text}`}
      >
        <div
          className="card-art"
          style={{ backgroundImage: `url(${art(m.id)})` }}
        >
          <div className="tier-badge">★{d.tier}</div>
        </div>
        <div className="card-name">{d.name}</div>
        {!compact && <div className="card-description">{d.text}</div>}
        <div className="spell-card-type">
          {m.tempSpell
            ? "塑造法术"
            : d.sourceId === "BG20_GEM"
              ? "鲜血宝石"
              : "酒馆法术"}
        </div>
      </button>
    );
  return (
    <button
      className={`minion-card ${compact ? "compact" : ""} ${m.golden ? "golden" : ""} ${selected ? "selected" : ""} ${m.keywords.includes("圣盾") ? "divine" : ""} ${m.gift ? "gifted-card" : ""}`}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      disabled={disabled}
      aria-label={`${m.golden ? "金色" : ""}${d.name}，${m.attack}攻击，${m.health}生命，${cardText(m)}`}
    >
      <div
        className="card-art"
        style={{ backgroundImage: `url(${art(m.id)})` }}
      >
        <div className="tier-badge">
          <span>★</span>
          {d.tier}
        </div>
        {m.golden && <span className="golden-label">金色</span>}
        {m.gift && (
          <span className="gifted-label">
            <Sparkles size={11} />
          </span>
        )}
        <div className="card-art-shade" />
        <div className="keyword-icons">
          {m.keywords.includes("嘲讽") && (
            <span title="嘲讽">
              <Shield size={12} />
            </span>
          )}
          {m.keywords.includes("圣盾") && (
            <span title="圣盾">
              <Sparkles size={12} />
            </span>
          )}
          {m.keywords.includes("剧毒") && <span title="剧毒">☠</span>}
          {m.keywords.includes("烈毒") && (
            <span title="烈毒：伤害消灭一个随从后消失">☠</span>
          )}
          {(m.rebornNext || m.keywords.includes("复生")) && (
            <span title="复生">
              <RotateCw size={12} />
            </span>
          )}
        </div>
      </div>
      <div className="card-name">{d.name}</div>
      {!compact && <div className="card-description">{cardText(m)}</div>}
      <div className="card-bottom">
        <span className="stat attack">{m.attack}</span>
        <span className="tribe-label">
          {d.tribe === "无" ? "随从" : d.tribe}
        </span>
        <span className="stat health">{m.health}</span>
      </div>
    </button>
  );
}
function App({
  network,
  onLobby,
}: {
  network?: NetworkGame;
  onLobby?: () => void;
}) {
  const { mode, setMode, mobile } = usePlayMode();
  const [tableMode, setTableMode] = useState(() => {
    try {
      return localStorage.getItem("bobs-tavern-presentation") !== "panels";
    } catch {
      return true;
    }
  });
  const [battleSpeed, setBattleSpeed] = useState(1);
  useEffect(() => {
    try {
      localStorage.setItem(
        "bobs-tavern-presentation",
        tableMode ? "table" : "panels",
      );
    } catch {}
  }, [tableMode]);
  const [mobileSeason, setMobileSeason] = useState(false);
  const [localGame, setGame] = useState<Game>(load);
  const game = network?.game || localGame;
  const [page, setPage] = useState<Page>("tavern");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<"help" | "settings" | "new" | null>(null);
  const [newHero, setNewHero] = useState(game.hero);
  const [newSeason, setNewSeason] = useState(!!game.season);
  const [collectionType, setCollectionType] = useState("minions");
  const [onlyPlayable, setOnlyPlayable] = useState(false);
  const [targeting, setTargeting] = useState<
    | { type: "play" | "cast" | "activate"; uid: string; position?: number }
    | { type: "power" }
    | null
  >(null);
  const [dragged, setDragged] = useState<{ uid: string; zone: string } | null>(
    null,
  );
  const [tierFilter, setTierFilter] = useState(0);
  const [tribeFilter, setTribeFilter] = useState("全部");
  const [search, setSearch] = useState("");
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem("bobs-tavern-sound") !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("bobs-tavern-sound", sound ? "on" : "off");
    } catch {}
  }, [sound]);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [poolOpen, setPoolOpen] = useState(false);
  const hero = heroOf(game);
  const catalog = game.season
    ? collectionType === "spells"
      ? SEASON_SPELL_CATALOG
      : SEASON_CATALOG
    : CARDS;
  const visibleHeroes = game.season ? SEASON_HEROES : CLASSIC_HEROES;
  const newHeroes = newSeason ? SEASON_HEROES : CLASSIC_HEROES;
  const opponent = game.opponents[game.nextOpponent];
  const recruiting = game.phase === "recruit";
  useEffect(() => {
    if (network) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(game));
    } catch {}
  }, [game]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 3200);
      return () => clearTimeout(id);
    }
  }, [toast]);
  useBattlePlayback(game, frame, playing, battleSpeed, setFrame);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelection(null);
        setTargeting(null);
        setModal(null);
        setPoolOpen(false);
        setMobileSeason(false);
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  useEffect(() => {
    if (network) {
      setFrame(0);
      setPlaying(true);
      setSelection(null);
      setTargeting(null);
    }
  }, [!!network, game.phase, game.turn]);
  function beep(action: Action) {
    const sounds: Partial<Record<Action["type"], TableSound>> = {
      buy: "buy",
      buySpell: "buy",
      refresh: "refresh",
      play: "play",
      sell: "sell",
      cast: "spell",
      activate: "spell",
      power: "spell",
      discover: "spell",
      darkGift: "spell",
      upgrade: "round",
      freeze: "spell",
    };
    const kind = sounds[action.type];
    if (kind) playTableSound(kind, sound);
  }
  function dispatch(action: Action) {
    if (network) {
      if (network.locked) {
        setToast("已提交，正在等待其他玩家。");
        return false;
      }
      const sent = network.send(action);
      if (sent) {
        setSelection(null);
        setTargeting(null);
        beep(action);
      }
      return sent;
    }
    const result = act(game, action);
    if (result.error) {
      setToast(result.error);
      return false;
    }
    setGame(result.state);
    setSelection(null);
    setTargeting(null);
    beep(action);
    if (action.type === "end") {
      setFrame(0);
      setPlaying(true);
    }
    return true;
  }
  function choose(m: Minion, zone: Selection["zone"]) {
    if (targeting) {
      if (
        zone !== "board" &&
        !(
          game.season &&
          zone === "shop" &&
          ["cast", "power"].includes(targeting.type)
        )
      ) {
        setToast("请选择战场上的友方随从。");
        return;
      }
      dispatch({ ...targeting, target: m.uid });
      return;
    }
    setSelection({ m, zone });
  }
  function play(m: Minion, position?: number) {
    if (game.season && getDef(m.id).kind === "spell") {
      const ts = seasonTargets(game, m, "cast");
      if (ts.length) {
        setTargeting({ type: "cast", uid: m.uid });
        setSelection(null);
        setToast("选择法术目标，可以选择适用的酒馆随从。");
      } else dispatch({ type: "cast", uid: m.uid });
      return;
    }
    const ts = targetsFor(game, m);
    if (ts.length) {
      setTargeting({ type: "play", uid: m.uid, position });
      setSelection(null);
      setToast("点击战场上的随从，选择技能目标。");
    } else dispatch({ type: "play", uid: m.uid, position });
  }
  function activate(m: Minion) {
    const ts = seasonTargets(game, m, "activate");
    if (ts.length) {
      setTargeting({ type: "activate", uid: m.uid });
      setSelection(null);
      setToast("选择发动技能的友方目标。");
    } else dispatch({ type: "activate", uid: m.uid });
  }
  function power() {
    if (hero.passive) {
      setToast(hero.text);
      return;
    }
    if (game.powerUsed) {
      setToast("本回合已使用英雄技能。");
      return;
    }
    if (game.gold < hero.cost) {
      setToast(`英雄技能需要${hero.cost}枚金币。`);
      return;
    }
    if (["lich", "george", "s14_lich", "s14_george"].includes(hero.id)) {
      if (!game.board.length && !(game.season && game.shop.length)) {
        setToast("先在战场上放置一个随从。");
        return;
      }
      setTargeting({ type: "power" });
      setToast("点击一个友方随从，施放英雄技能。");
    } else dispatch({ type: "power" });
  }
  function start() {
    setGame(createGame(newHero));
    setModal(null);
    setSelection(null);
    setTargeting(null);
    setPage("tavern");
    setToast("新对局开始，祝你好运！");
  }
  const filtered = catalog.filter(
    (c) =>
      (!tierFilter || c.tier === tierFilter) &&
      (!onlyPlayable || !game.season || c.playable) &&
      (tribeFilter === "全部" ||
        c.tribe === tribeFilter ||
        c.races?.includes(tribeFilter as never)) &&
      `${c.name}${c.text}`.includes(search),
  );
  const navs: { id: Page; label: string; icon: typeof Beer }[] = [
    { id: "tavern", label: "酒馆战场", icon: Beer },
    { id: "cards", label: "随从图鉴", icon: BookOpen },
    { id: "heroes", label: "英雄图鉴", icon: Users },
    { id: "history", label: "对局记录", icon: History },
  ];
  return (
    <div
      className={`app-shell ${mobile ? "touch-mode" : ""} ${tableMode && page === "tavern" ? "table-active" : ""} ${basePath !== "/" ? "has-lobby" : ""} ${page === "tavern" ? "is-tavern" : ""}`}
    >
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("tavern");
          }}
        >
          <span className="brand-mark">
            <Beer size={25} strokeWidth={1.7} />
          </span>
          <span>
            <strong>鲍勃的酒馆</strong>
            <small>BOB’S TAVERN</small>
          </span>
        </a>
        <div className="sidebar-line" />
        <div className="nav-caption">你的酒馆，你的策略</div>
        <nav>
          {navs.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${page === n.id ? "active" : ""}`}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={19} />
              <span>{n.label}</span>
              {n.id === "tavern" && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="tiny-label">
            <Flame size={13} /> 酒馆小贴士
          </span>
          <p>
            三张相同随从，
            <br />
            一份金色惊喜。
          </p>
          <span>
            金色随从保留全部额外属性，
            <br />
            打出后可发现更高星级随从。
          </span>
          <div className="mini-cards">
            <i>✦</i>
            <i>✦</i>
            <i>✦</i>
            <ArrowRight size={16} />
            <i className="gold">✦</i>
          </div>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setModal("help")}>
            <HelpCircle size={18} />
            玩法指南
            <ArrowUpRight size={14} className="push" />
          </button>
          <button className="nav-item" onClick={() => setModal("settings")}>
            <Settings size={18} />
            偏好设置
          </button>
          <div className="local-status">
            <span className="status-dot" />
            <div>
              {network ? "在线对局" : "单人练习模式"}
              <small>{network ? "进度由酒馆保存" : "对局自动保存在本地"}</small>
            </div>
            <Shield size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            练习场 <ChevronRight size={13} />
            <span>{navs.find((n) => n.id === page)?.label}</span>
          </div>
          <div className="topbar-right">
            {onLobby && (
              <button
                className="icon-button"
                onClick={onLobby}
                aria-label="对战大厅"
                title="对战大厅"
              >
                <LayoutGrid size={18} />
              </button>
            )}
            {basePath !== "/" && (
              <a
                href="/"
                className="icon-button lobby-link"
                aria-label="返回游戏大厅"
                title="返回游戏大厅"
              >
                <LayoutGrid size={18} />
              </a>
            )}
            <button
              className="icon-button play-mode-toggle"
              onClick={() => setMode(mobile ? "desktop" : "touch")}
              aria-label={mobile ? "退出手游模式" : "开启手游模式"}
              aria-pressed={mobile}
              title={mobile ? "退出手游模式" : "开启手游模式"}
            >
              {mobile ? <Monitor size={18} /> : <Smartphone size={18} />}
            </button>
            <button
              className="icon-button mobile-settings"
              onClick={() => setModal("settings")}
              aria-label="偏好设置"
            >
              <Settings size={18} />
            </button>
            <span className="version-pill">
              <span />
              {game.season ? "S14 · 36.4.2" : "经典精选"}
            </span>
            <button
              className="icon-button"
              onClick={() => setModal("help")}
              aria-label="查看玩法指南"
            >
              <HelpCircle size={18} />
            </button>
            <button
              className="icon-button sound-toggle"
              onClick={() => {
                setSound(!sound);
                setToast(sound ? "音效已关闭" : "操作音效已开启");
              }}
              aria-label={sound ? "关闭音效" : "开启音效"}
            >
              {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <span className="header-divider" />
            <span className="player-avatar">旅</span>
            <span className="player-name">酒馆旅人</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">PULL UP A CHAIR.</div>
              <h1>
                {page === "tavern"
                  ? "欢迎来到鲍勃的酒馆"
                  : page === "cards"
                    ? "每个随从，都有可能"
                    : page === "heroes"
                      ? "选择你的酒馆英雄"
                      : "每一步，都算数"}
              </h1>
              <p>
                {page === "tavern"
                  ? "招募随从，打造阵容。下一场胜利，从这里开始。"
                  : page === "cards"
                    ? `${catalog.length}张卡牌，查看当前技能、原始插画与共享池数量。`
                    : page === "heroes"
                      ? "熟悉英雄技能，找到属于你的打法。"
                      : "回顾本局的战斗结果，调整下一轮的策略。"}
              </p>
            </div>
            <button
              className="button new-game"
              onClick={() => {
                setNewHero(game.hero);
                setNewSeason(!!game.season);
                setModal("new");
              }}
            >
              <Plus size={17} /> 新对局
            </button>
          </div>
          {page === "tavern" ? (
            tableMode ? (
              <GameTable
                lobby={onLobby}
                roomStatus={network?.status}
                locked={network?.locked}
                game={game}
                dispatch={dispatch}
                selection={selection}
                choose={choose}
                close={() => setSelection(null)}
                play={play}
                activate={activate}
                power={power}
                targeting={!!targeting}
                frame={frame}
                setFrame={setFrame}
                playing={playing}
                setPlaying={setPlaying}
                speed={battleSpeed}
                setSpeed={setBattleSpeed}
                sound={sound}
                toggleSound={() => setSound(!sound)}
                newGame={() => {
                  if (network) {
                    onLobby?.();
                    return;
                  }
                  setNewHero(game.hero);
                  setNewSeason(!!game.season);
                  setModal("new");
                }}
                settings={() => setModal("settings")}
                help={() => setModal("help")}
                collection={() => {
                  setSelection(null);
                  setPage("cards");
                }}
                heroes={() => {
                  setSelection(null);
                  setPage("heroes");
                }}
                season={() => setMobileSeason(true)}
                pool={() => setPoolOpen(true)}
                notify={setToast}
                card={(m) => <MinionCard m={m} />}
              />
            ) : mobile ? (
              <MobileArena
                game={game}
                dispatch={dispatch}
                choose={choose}
                power={power}
                newGame={() => {
                  if (network) {
                    onLobby?.();
                    return;
                  }
                  setNewHero(game.hero);
                  setNewSeason(!!game.season);
                  setModal("new");
                }}
                season={() => setMobileSeason(true)}
                pool={() => setPoolOpen(true)}
                targeting={!!targeting}
                notify={setToast}
                card={(m, zone) => (
                  <MinionCard
                    compact
                    m={m}
                    onClick={() => choose(m, zone)}
                    selected={
                      selection?.m.uid === m.uid ||
                      (!!targeting && zone === "board")
                    }
                  />
                )}
              />
            ) : (
              <>
                <SeasonBar game={game} dispatch={dispatch} />
                <div className="game-meta">
                  <div className="meta-item">
                    <span className="meta-icon">
                      <Swords size={17} />
                    </span>
                    <span>
                      当前回合<strong>第 {game.turn} 回合</strong>
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-icon gold">
                      <Crown size={18} />
                    </span>
                    <span>
                      酒馆等级
                      <strong>
                        <Stars tier={game.tier} />
                        <small>{game.tier} 星酒馆</small>
                      </strong>
                    </span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-icon gold">
                      <Coins size={18} />
                    </span>
                    <span>
                      可用金币
                      <strong className="gold-text">
                        {game.gold}
                        <small>
                          /{" "}
                          {game.season?.maxGold ?? Math.min(10, game.turn + 2)}
                        </small>
                      </strong>
                    </span>
                  </div>
                  <div className="phase-pill">
                    <span className="status-dot" />
                    {game.phase === "combat"
                      ? "战斗阶段"
                      : game.phase === "over"
                        ? "对局结束"
                        : "招募阶段"}
                    <span className="phase-caption">
                      {game.phase === "recruit"
                        ? "从容思考，不限时间"
                        : "自动战斗"}
                    </span>
                  </div>
                </div>
                <div className="game-layout">
                  <div className="board-column">
                    <section
                      className={`tavern-panel panel ${game.frozen ? "frozen" : ""}`}
                    >
                      <div className="panel-header">
                        <div className="panel-title">
                          <span className="section-icon">
                            <Beer size={19} />
                          </span>
                          <h2>鲍勃的酒馆</h2>
                          <span className="sub-label">
                            每位随从 <Coin small /> 3
                          </span>
                        </div>
                        <div className="tavern-actions">
                          <button
                            className="small-button upgrade-button"
                            onClick={() => dispatch({ type: "upgrade" })}
                            disabled={
                              !recruiting ||
                              game.tier === 6 ||
                              game.gold < game.upgrade
                            }
                          >
                            <ArrowUp size={14} />
                            <span>{game.tier === 6 ? "已满级" : "升级"}</span>
                            {game.tier < 6 && (
                              <>
                                <Coin small />
                                {game.upgrade}
                              </>
                            )}
                          </button>
                          <button
                            className="small-button"
                            onClick={() => dispatch({ type: "refresh" })}
                            disabled={
                              !recruiting ||
                              (game.gold < 1 && !game.season?.freeRefresh)
                            }
                          >
                            <RotateCw size={14} />
                            <span>刷新</span>
                            <Coin small />
                            {game.season ? refreshCost(game) : 1}
                          </button>
                          <button
                            className={`small-button freeze-button ${game.frozen ? "is-frozen" : ""}`}
                            onClick={() => dispatch({ type: "freeze" })}
                            disabled={!recruiting}
                          >
                            <Snowflake size={14} />
                            <span>{game.frozen ? "解冻" : "冻结"}</span>
                            <small>0</small>
                          </button>
                        </div>
                      </div>
                      <div className="bob-message">
                        <img src={art("TB_BaconShopBob")} alt="酒馆老板鲍勃" />
                        <span>
                          “
                          {game.frozen
                            ? "给你留着，明天见。"
                            : game.shop.length === 0
                              ? "好眼光！再看看新来的随从吧。"
                              : "别着急，我觉得你能赢！"}
                          ”
                        </span>
                        <span className="bob-sign">鲍勃</span>
                      </div>
                      <div className="shop-cards">
                        {game.shop.map((m) => (
                          <div className="shop-card-wrap" key={m.uid}>
                            <MinionCard
                              m={m}
                              onClick={() => choose(m, "shop")}
                              selected={selection?.m.uid === m.uid}
                              draggable={recruiting}
                              onDragStart={() =>
                                setDragged({ uid: m.uid, zone: "shop" })
                              }
                            />
                            <span className="buy-hint">
                              <Coin small />3 <span>点击招募</span>
                            </span>
                          </div>
                        ))}
                        {game.shop.length === 0 && (
                          <div className="empty-shop">
                            <Beer size={32} />
                            <p>好随从都被你挑走了</p>
                            <button
                              className="text-button"
                              onClick={() => dispatch({ type: "refresh" })}
                              disabled={game.gold < 1}
                            >
                              刷新酒馆 <ArrowRight size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                      <SpellShelf
                        game={game}
                        select={(m) => choose(m, "spellshop")}
                        dispatch={dispatch}
                      />
                      <div className="tavern-footer">
                        <span>
                          {game.frozen ? (
                            <>
                              <Snowflake size={13} />
                              已冻结，下回合保留酒馆随从
                            </>
                          ) : (
                            <>
                              <CheckCircle2 size={13} />
                              共享随从池 · 按剩余数量抽取
                            </>
                          )}
                        </span>
                        <button onClick={() => setPoolOpen(true)}>
                          查看随从池 <ArrowUpRight size={13} />
                        </button>
                      </div>
                    </section>
                    <section
                      className={`battlefield-panel panel ${targeting ? "targeting" : ""}`}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragged?.zone === "hand") {
                          const m = game.hand.find(
                            (x) => x.uid === dragged.uid,
                          );
                          if (m) play(m);
                        }
                        setDragged(null);
                      }}
                    >
                      <div className="panel-header">
                        <div className="panel-title">
                          <span className="section-icon">
                            <Swords size={18} />
                          </span>
                          <h2>我的战场</h2>
                          <span className="count-label">
                            {game.board.length} / 7
                          </span>
                        </div>
                        <span className="section-hint">
                          {targeting ? (
                            "选择技能目标"
                          ) : (
                            <>
                              <GripVertical size={13} />
                              拖动调整攻击顺序
                            </>
                          )}
                        </span>
                      </div>
                      <div className="battlefield-slots">
                        {Array.from({ length: 7 }, (_, i) => {
                          const m = game.board[i];
                          return (
                            <div
                              className={`board-slot ${m ? "occupied" : ""}`}
                              key={i}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => {
                                if (dragged?.zone === "board") {
                                  e.stopPropagation();
                                  dispatch({
                                    type: "move",
                                    uid: dragged.uid,
                                    to: i,
                                  });
                                  setDragged(null);
                                }
                              }}
                            >
                              {m ? (
                                <MinionCard
                                  compact
                                  m={m}
                                  onClick={() => choose(m, "board")}
                                  draggable={recruiting}
                                  onDragStart={() =>
                                    setDragged({ uid: m.uid, zone: "board" })
                                  }
                                  selected={
                                    selection?.m.uid === m.uid || !!targeting
                                  }
                                />
                              ) : (
                                <>
                                  <Plus size={19} />
                                  <span>{i + 1}</span>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="battlefield-footer">
                        <span>
                          <ArrowRight size={12} /> 从左至右依次攻击
                        </span>
                        <span>
                          出售随从可获得 <Coin small /> 1
                        </span>
                      </div>
                    </section>
                    <section
                      className="hand-panel"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragged?.zone === "shop")
                          dispatch({ type: "buy", uid: dragged.uid });
                        setDragged(null);
                      }}
                    >
                      <div className="hand-header">
                        <div>
                          <span className="hand-icon">
                            <BookOpen size={17} />
                          </span>
                          <h2>我的手牌</h2>
                          <span className="count-label">
                            {game.hand.length + game.rewards.length} / 10
                          </span>
                        </div>
                        <span>点击手牌打出，或拖入战场</span>
                      </div>
                      <div className="hand-cards">
                        {game.hand.map((m) => (
                          <MinionCard
                            key={m.uid}
                            compact
                            m={m}
                            onClick={() => choose(m, "hand")}
                            draggable={recruiting}
                            onDragStart={() =>
                              setDragged({ uid: m.uid, zone: "hand" })
                            }
                          />
                        ))}
                        {game.rewards.map((tier, i) => (
                          <button
                            className="reward-card"
                            key={`reward-${i}`}
                            onClick={() => dispatch({ type: "reward" })}
                          >
                            <Sparkles size={27} />
                            <strong>三连奖励</strong>
                            <Stars tier={tier} />
                            <span>点击发现随从</span>
                          </button>
                        ))}
                        {!game.hand.length && !game.rewards.length && (
                          <div className="empty-hand">
                            <span className="empty-hand-icon">
                              <BookOpen size={26} />
                            </span>
                            <div>
                              <strong>你的下一位伙伴，正在酒馆等你</strong>
                              <span>
                                招募的随从将放入手牌，打出后加入战场。
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </section>
                    <div className="round-bar">
                      <div className="round-gold">
                        <Coins size={20} />
                        <strong>{game.gold}</strong>
                        <span>枚金币剩余</span>
                        {game.gold > 0 && (
                          <small>剩余金币不会保留到下一回合</small>
                        )}
                      </div>
                      <button
                        className="button primary end-turn"
                        onClick={() => dispatch({ type: "end" })}
                        disabled={!recruiting}
                      >
                        结束招募 <ArrowRight size={17} />
                      </button>
                    </div>
                  </div>
                  <aside className="game-right">
                    <section className="hero-panel panel">
                      <div className="right-heading">
                        <h2>我的英雄</h2>
                        <span>本局英雄</span>
                      </div>
                      <div className="hero-portrait-wrap">
                        <div
                          className="hero-portrait"
                          style={{ backgroundImage: `url(${art(hero.art)})` }}
                        />
                        <span className="hero-health">
                          <Heart size={13} fill="currentColor" />
                          {Math.max(0, game.health)}
                        </span>
                      </div>
                      {game.season && (
                        <span className="armor-badge">
                          <Shield size={12} />
                          {game.season.armor} 护甲
                        </span>
                      )}
                      <h3>{hero.name}</h3>
                      <p className="hero-subtitle">{hero.title}</p>
                      <div className="hero-power">
                        <div className="power-heading">
                          <span className="power-icon">
                            <WandSparkles size={18} />
                          </span>
                          <strong>{hero.power}</strong>
                          <span>
                            {hero.passive ? (
                              "被动"
                            ) : (
                              <>
                                <Coin small />
                                {hero.cost}
                              </>
                            )}
                          </span>
                        </div>
                        <p>{hero.text}</p>
                        <button
                          className={`power-button ${game.powerUsed ? "used" : ""}`}
                          onClick={power}
                          disabled={!recruiting || game.powerUsed}
                        >
                          {hero.passive ? (
                            <>
                              <Check size={13} />
                              被动技能已生效
                            </>
                          ) : game.powerUsed ? (
                            <>
                              <Check size={13} />
                              本回合已使用
                            </>
                          ) : (
                            <>
                              使用英雄技能 <ArrowUpRight size={13} />
                            </>
                          )}
                        </button>
                      </div>
                    </section>
                    <section className="opponent-panel panel">
                      <div className="right-heading">
                        <h2>下一位对手</h2>
                        <span className="ai-label">AI 练习</span>
                      </div>
                      <div className="opponent-info">
                        <img
                          src={art(
                            HEROES.find((h) => h.id === opponent?.hero)?.art ||
                              HEROES[1].art,
                          )}
                          alt="对手英雄"
                        />
                        <div>
                          <strong>{opponent?.name}</strong>
                          <span>
                            <Stars tier={opponent?.tier || 1} />
                          </span>
                        </div>
                        <span className="opponent-health">
                          <Heart size={12} />
                          {Math.max(0, opponent?.health || 0)}
                        </span>
                      </div>
                      <div className="opponent-footer">
                        <Users size={13} />
                        {game.opponents.filter((o) => o.health > 0).length +
                          (game.health > 0 ? 1 : 0)}{" "}
                        位英雄仍在场上
                      </div>
                    </section>
                    <section className="log-panel panel">
                      <div className="right-heading">
                        <h2>酒馆动态</h2>
                        <span className="live-dot" />
                      </div>
                      <div className="activity-list">
                        {game.logs.slice(0, 4).map((l, i) => (
                          <div className="activity" key={`${l}-${i}`}>
                            <span className={i === 0 ? "current" : ""} />
                            <div>
                              <p>{l}</p>
                              <small>{i === 0 ? "刚刚" : "本局对战"}</small>
                            </div>
                          </div>
                        ))}
                      </div>
                      <button
                        className="text-button"
                        onClick={() => setPage("history")}
                      >
                        查看对局记录 <ChevronRight size={13} />
                      </button>
                    </section>
                  </aside>
                </div>
                <div className="page-footer">
                  <span>
                    <Shield size={12} />
                    单人策略练习 ·{" "}
                    {game.season ? "第14赛季复刻中" : "经典精选规则"} ·
                    非官方作品
                  </span>
                  <span>好好享受，酒馆的时光。</span>
                </div>
              </>
            )
          ) : page === "cards" ? (
            <section className="collection panel">
              {game.season && (
                <>
                  <CoverageNote />
                  <div className="catalog-modes">
                    <button
                      className={collectionType === "minions" ? "active" : ""}
                      onClick={() => setCollectionType("minions")}
                    >
                      随从 · {SEASON_CATALOG.length}
                    </button>
                    <button
                      className={collectionType === "spells" ? "active" : ""}
                      onClick={() => setCollectionType("spells")}
                    >
                      酒馆法术 · {SEASON_SPELL_CATALOG.length}
                    </button>
                    <label>
                      <input
                        type="checkbox"
                        checked={onlyPlayable}
                        onChange={(e) => setOnlyPlayable(e.target.checked)}
                      />
                      仅看已实现
                    </label>
                  </div>
                </>
              )}
              <div className="collection-toolbar">
                <div className="filter-tabs">
                  {[0, 1, 2, 3, 4, 5, 6].map((t) => (
                    <button
                      className={tierFilter === t ? "active" : ""}
                      key={t}
                      onClick={() => setTierFilter(t)}
                    >
                      {t === 0 ? "全部星级" : `${t} 星`}
                    </button>
                  ))}
                </div>
                <label className="search-box">
                  <Search size={16} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索随从或技能"
                  />
                </label>
              </div>
              <div className="tribe-tabs">
                {(game.season
                  ? ["全部", ...ALL_TRIBES, "无"]
                  : ["全部", "野兽", "机械", "鱼人", "恶魔", "无"]
                ).map((t) => (
                  <button
                    key={t}
                    className={tribeFilter === t ? "active" : ""}
                    onClick={() => setTribeFilter(t)}
                  >
                    {t === "无" ? "无种族" : t}
                  </button>
                ))}
                <span>{filtered.length} 种随从</span>
              </div>
              <div className="collection-grid">
                {filtered.map((d) => (
                  <div className="collection-item" key={d.id}>
                    <MinionCard
                      m={{
                        uid: d.id,
                        id: d.id,
                        attack: d.attack,
                        health: d.health,
                        golden: false,
                        keywords: d.keywords || [],
                        copies: {},
                      }}
                      onClick={() =>
                        setSelection({
                          m: {
                            uid: d.id,
                            id: d.id,
                            attack: d.attack,
                            health: d.health,
                            golden: false,
                            keywords: d.keywords || [],
                            copies: {},
                          },
                          zone: "shop",
                        })
                      }
                    />
                    <div className="pool-count">
                      <span>
                        {game.season
                          ? d.playable
                            ? d.kind === "spell"
                              ? "技能已实现"
                              : game.pool[d.id] !== undefined
                                ? "本局池剩余"
                                : "本局未开放种族"
                            : "仅图鉴 · 待实现"
                          : "共享池剩余"}
                      </span>
                      <strong>
                        {game.pool[d.id] ?? "—"}{" "}
                        {game.pool[d.id] !== undefined && (
                          <small>/ {POOL_COPIES[d.tier]}</small>
                        )}
                      </strong>
                    </div>
                  </div>
                ))}
              </div>
              {!filtered.length && (
                <div className="no-results">
                  <Search size={30} />
                  <p>没有找到匹配的随从，换个关键词试试。</p>
                  <button
                    className="button"
                    onClick={() => {
                      setSearch("");
                      setTierFilter(0);
                      setTribeFilter("全部");
                    }}
                  >
                    重置筛选
                  </button>
                </div>
              )}
            </section>
          ) : page === "heroes" ? (
            <div className="hero-grid">
              {visibleHeroes.map((h) => (
                <section className="hero-collection-card panel" key={h.id}>
                  <div
                    className="hero-collection-art"
                    style={{ backgroundImage: `url(${art(h.art)})` }}
                  />
                  <div className="hero-collection-content">
                    <h2>
                      {h.name}
                      {game.hero === h.id && (
                        <span className="current-tag">使用中</span>
                      )}
                    </h2>
                    <span className="hero-subtitle">
                      {h.title} · {h.health}生命
                    </span>
                    <h3>
                      <Sparkles size={15} />
                      {h.power}
                      <span>{h.passive ? "被动" : `${h.cost} 金币`}</span>
                    </h3>
                    <p>{h.text}</p>
                    <button
                      className="button"
                      onClick={() => {
                        setNewHero(h.id);
                        setModal("new");
                      }}
                    >
                      使用此英雄开始新对局 <ArrowRight size={15} />
                    </button>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <section className="history-view">
              <div className="history-stats">
                {[
                  { n: game.battles.length, l: "已完成战斗", icon: Swords },
                  {
                    n: game.battles.filter((b) => b.result === "win").length,
                    l: "战斗胜利",
                    icon: Trophy,
                  },
                  { n: game.triples, l: "金色三连", icon: Sparkles },
                  { n: game.purchases, l: "招募随从", icon: Users },
                ].map((x) => (
                  <div className="panel" key={x.l}>
                    <x.icon size={22} />
                    <strong>{x.n}</strong>
                    <span>{x.l}</span>
                  </div>
                ))}
              </div>
              <div className="panel history-table">
                <div className="panel-header">
                  <h2>本局战斗记录</h2>
                  <span className="sub-label">
                    {hero.name} · 第{game.turn}回合
                  </span>
                </div>
                {game.battles.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>回合</th>
                        <th>对手</th>
                        <th>结果</th>
                        <th>伤害</th>
                      </tr>
                    </thead>
                    <tbody>
                      {game.battles.map((b) => (
                        <tr key={b.turn}>
                          <td>第{b.turn}回合</td>
                          <td>{b.name}</td>
                          <td>
                            <span className={`result-tag ${b.result}`}>
                              {b.result === "win"
                                ? "胜利"
                                : b.result === "loss"
                                  ? "失利"
                                  : "平局"}
                            </span>
                          </td>
                          <td>{b.damage} 点</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="no-results">
                    <History size={32} />
                    <p>还没有战斗记录。招募你的第一个随从吧。</p>
                    <button
                      className="button primary"
                      onClick={() => setPage("tavern")}
                    >
                      回到酒馆 <ArrowRight size={15} />
                    </button>
                  </div>
                )}
              </div>
              <div className="panel full-log">
                <h2>操作记录</h2>
                {game.logs.map((l, i) => (
                  <p key={i}>
                    <span />
                    {l}
                  </p>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span className="toast-icon">
            <Beer size={16} />
          </span>
          {toast}
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {targeting && (
        <div className="target-banner">
          <WandSparkles size={18} />
          <span>
            选择友方随从作为
            {targeting.type === "power" ? "英雄技能" : "随从技能"}目标
          </span>
          {targeting.type === "play" &&
            (getDef(game.hand.find((m) => m.uid === targeting.uid)!.id)
              .effect === "magnetic" ||
              getDef(game.hand.find((m) => m.uid === targeting.uid)!.id)
                .magnetic) && (
              <button
                onClick={() =>
                  dispatch({
                    type: "play",
                    uid: targeting.uid,
                    position: targeting.position,
                  })
                }
              >
                单独打出
              </button>
            )}
          <button onClick={() => setTargeting(null)}>
            取消 <X size={14} />
          </button>
        </div>
      )}
      {selection && !targeting && !(tableMode && page === "tavern") && (
        <Modal
          title={getDef(selection.m.id).name}
          subtitle={`${selection.m.golden ? "金色 · " : ""}${getDef(selection.m.id).tier}星 · ${getDef(selection.m.id).tribe}`}
          onClose={() => setSelection(null)}
        >
          <div className="card-detail">
            <MinionCard m={selection.m} />
            <div>
              <p>{cardText(selection.m)}</p>
              <GiftNote m={selection.m} />
              <CardSource m={selection.m} />
              {selection.m.golden && !game.season && (
                <p className="gold-note">
                  金色版本：基础属性翻倍；数值型技能效果翻倍，铜须及瑞文的效果为触发三次。
                </p>
              )}
              <div className="detail-stats">
                <span>
                  <Swords size={16} />
                  {selection.m.attack} 攻击
                </span>
                <span>
                  <Heart size={16} />
                  {selection.m.health} 生命
                </span>
              </div>
              {selection.m.keywords.length > 0 && (
                <div className="detail-keywords">
                  {selection.m.keywords.map((k) => (
                    <span key={k}>{k}</span>
                  ))}
                </div>
              )}
              {page === "tavern" && recruiting && (
                <div className="detail-actions">
                  {selection.zone === "spellshop" ? (
                    <button
                      className="button primary"
                      onClick={() =>
                        dispatch({ type: "buySpell", uid: selection.m.uid })
                      }
                    >
                      购买法术 <Coin small />
                      {spellCost(game, selection.m)}
                    </button>
                  ) : selection.zone === "shop" ? (
                    <button
                      className="button primary"
                      disabled={
                        game.gold <
                          (game.season ? minionCost(game, selection.m) : 3) ||
                        game.hand.length + game.rewards.length >= 10
                      }
                      onClick={() =>
                        dispatch({ type: "buy", uid: selection.m.uid })
                      }
                    >
                      招募随从 <Coin small />
                      {game.season ? minionCost(game, selection.m) : 3}
                    </button>
                  ) : selection.zone === "hand" ? (
                    <button
                      className="button primary"
                      onClick={() => play(selection.m)}
                    >
                      {getDef(selection.m.id).kind === "spell"
                        ? "施放法术"
                        : "打出随从"}{" "}
                      <ArrowUp size={16} />
                    </button>
                  ) : (
                    <>
                      {game.season &&
                        getDef(selection.m.id).abilities?.some(
                          (a) => a.event === "activate",
                        ) && (
                          <button
                            className="button gift-button"
                            disabled={
                              selection.m.activated ||
                              game.gold <
                                (getDef(selection.m.id).activateCost || 0)
                            }
                            onClick={() => activate(selection.m)}
                          >
                            {selection.m.activated
                              ? "本回合已发动"
                              : "发动技能"}
                            <Coin small />
                            {getDef(selection.m.id).activateCost}
                          </button>
                        )}
                      <div className="move-buttons">
                        <button
                          className="button"
                          disabled={game.board[0]?.uid === selection.m.uid}
                          onClick={() =>
                            dispatch({
                              type: "move",
                              uid: selection.m.uid,
                              to:
                                game.board.findIndex(
                                  (x) => x.uid === selection.m.uid,
                                ) - 1,
                            })
                          }
                        >
                          <ChevronLeft size={16} />
                          左移
                        </button>
                        <button
                          className="button"
                          disabled={game.board.at(-1)?.uid === selection.m.uid}
                          onClick={() =>
                            dispatch({
                              type: "move",
                              uid: selection.m.uid,
                              to:
                                game.board.findIndex(
                                  (x) => x.uid === selection.m.uid,
                                ) + 1,
                            })
                          }
                        >
                          右移
                          <ChevronRight size={16} />
                        </button>
                      </div>
                      <button
                        className="button sell-button"
                        onClick={() =>
                          dispatch({ type: "sell", uid: selection.m.uid })
                        }
                      >
                        出售随从 <Coin small />
                        +1
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
      {modal === "new" && (
        <Modal
          title="新的故事，从一位英雄开始"
          subtitle="选择英雄开启新对局，当前对局进度将被替换。"
          onClose={() => setModal(null)}
          wide
        >
          <div className="ruleset-picker">
            <button
              className={newSeason ? "active" : ""}
              onClick={() => {
                setNewSeason(true);
                setNewHero("s14_lich");
              }}
            >
              第14赛季 · 36.4.2
            </button>
            <button
              className={!newSeason ? "active" : ""}
              onClick={() => {
                setNewSeason(false);
                setNewHero("lich");
              }}
            >
              经典精选
            </button>
          </div>
          <div className="hero-picker">
            {newHeroes.map((h) => (
              <button
                className={newHero === h.id ? "chosen" : ""}
                key={h.id}
                onClick={() => setNewHero(h.id)}
              >
                <img src={art(h.art)} alt="" />
                <strong>{h.name}</strong>
                <small>{h.power}</small>
                {newHero === h.id && <CheckCircle2 size={18} />}
              </button>
            ))}
          </div>
          <div className="chosen-hero-note">
            <Sparkles size={17} />
            <p>{HEROES.find((h) => h.id === newHero)?.text}</p>
          </div>
          <div className="modal-bottom">
            <span>
              {newSeason ? "第14赛季 · 36.4.2" : "经典精选"} · 7位AI对手 ·
              无回合时限
            </span>
            <button className="button primary" onClick={start}>
              进入酒馆 <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      {mobileSeason && (
        <Modal
          title="赛季玩法"
          subtitle="黑暗发现与本局饰品"
          onClose={() => setMobileSeason(false)}
        >
          <SeasonBar
            game={game}
            dispatch={(a) => {
              if (dispatch(a)) setMobileSeason(false);
            }}
          />
          <p className="settings-note">
            点击黑暗发现选取带有黑暗之赐的随从。饰品会在第6、9回合自动提供选择。
          </p>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal
          title="偏好设置"
          subtitle="让这间酒馆更适合你。"
          onClose={() => setModal(null)}
        >
          <div className="setting-row">
            <div>
              <strong>实战棋盘</strong>
              <p>同屏招募与交战，支持拖牌和攻击动画。关闭可回到旧版面板。</p>
            </div>
            <button
              className={`toggle ${tableMode ? "on" : ""}`}
              aria-label="切换实战棋盘"
              aria-pressed={tableMode}
              onClick={() => setTableMode(!tableMode)}
            >
              <span />
            </button>
          </div>
          <div className="setting-row play-mode-setting">
            <div>
              <strong>手游模式</strong>
              <p>横屏同屏操作，竖屏也可游玩。切换不会重开对局。</p>
            </div>
            <select
              aria-label="界面模式"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="auto">跟随屏幕</option>
              <option value="touch">手游模式</option>
              <option value="desktop">标准模式</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <strong>操作音效</strong>
              <p>购买、刷新和技能的轻提示音。</p>
            </div>
            <button
              className={`toggle ${sound ? "on" : ""}`}
              onClick={() => setSound(!sound)}
              aria-label="切换操作音效"
              aria-pressed={sound}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <div>
              <strong>本地自动保存</strong>
              <p>关闭页面后，可继续当前对局。</p>
            </div>
            <span className="green-text">
              <CheckCircle2 size={15} />
              已开启
            </span>
          </div>
          <div className="settings-note">
            规则档案：
            {game.season
              ? `第14赛季36.4.2，${SEASON_CARDS.length}种可玩随从、${SEASON_HEROES.length}名可玩英雄。`
              : "经典精选，32种随从、8名英雄。"}
            <br />
            对手使用简化招募策略。当前赛季已接入黑暗之赐、部分饰品、发动与酒馆法术。
          </div>
          <button
            className="button"
            onClick={() => {
              setNewHero(game.hero);
              setModal("new");
            }}
          >
            重新开始对局 <RotateCw size={15} />
          </button>
        </Modal>
      )}
      {modal === "help" && (
        <Modal
          title="坐下来，先来一局"
          subtitle="把金币花在好随从上，让它们替你赢下战斗。"
          onClose={() => setModal(null)}
          wide
        >
          <div className="help-grid">
            {[
              {
                icon: Coins,
                t: "招募与经济",
                p: "购买随从需要3金币，刷新需要1金币，出售场上的随从获得1金币。首回合3金币，此后每回合增加1，最多10金币。剩余金币不保留。",
              },
              {
                icon: Snowflake,
                t: "冻结与升级",
                p: "免费冻结酒馆，保留到下一回合。升级后可刷新出更高星级随从，酒馆最高6星。每经过一回合，升级费用降低1金币。",
              },
              {
                icon: Sparkles,
                t: "三连与发现",
                p: "手牌与战场上的三个相同普通随从自动合成金色，保留额外属性。打出金色随从后获得奖励，发现高于当前酒馆1星的随从，最高6星。",
              },
              {
                icon: Swords,
                t: "战斗与技能",
                p: "随从从左到右攻击，优先攻击嘲讽。圣盾挡一次伤害，剧毒消灭受到伤害的随从，复生以1点生命复活。战斗中的临时变化不会带回酒馆。",
              },
            ].map((x) => (
              <div key={x.t}>
                <x.icon size={22} />
                <h3>{x.t}</h3>
                <p>{x.p}</p>
              </div>
            ))}
          </div>
          <div className="help-note">
            <strong>关于这个练习场</strong>
            <p>
              当前赛季模式锁定36.4.2数据。已实现的随从、法术、饰品与黑暗之赐参与练习，其他当前卡牌在图鉴中标记为待实现。10种族每局随机开放5种。AI共用有限随从池，但仍采用简化招募，未实现AI之间对战、完整AI技能、上锁宝箱与鱼饵机制。经典模式仍可在新对局中选择。
            </p>
            <a
              href="https://hearthstone.blizzard.com/en-gb/news/23156373/introducing-hearthstone-battlegrounds"
              target="_blank"
              rel="noreferrer"
            >
              阅读暴雪酒馆战棋基础规则 <ExternalLink size={12} />
            </a>
          </div>
        </Modal>
      )}
      {poolOpen && (
        <Modal
          title="每一个随从，都来自同一个池子"
          subtitle={`当前共享池剩余 ${poolTotal(game)} 张，酒馆、手牌与战场中的随从均已扣除。`}
          onClose={() => setPoolOpen(false)}
          wide
        >
          <div className="pool-summary">
            {[1, 2, 3, 4, 5, 6].map((t) => (
              <div key={t}>
                <Stars tier={t} />
                <strong>{POOL_COPIES[t]}</strong>
                <span>每种随从初始数量</span>
                <small>
                  {
                    (game.season ? SEASON_CARDS : CARDS).filter(
                      (c) => c.tier === t,
                    ).length
                  }
                  种 · 剩余
                  {(game.season ? SEASON_CARDS : CARDS)
                    .filter((c) => c.tier === t)
                    .reduce((n, c) => n + (game.pool[c.id] || 0), 0)}
                  张
                </small>
              </div>
            ))}
          </div>
          <div className="help-note">
            <p>
              刷新时，未购买的随从放回池中，再根据每张卡的剩余数量加权抽取。金色随从占用三张原始卡，出售时归还；衍生随从不占池。磁力融合会保留材料的池归属，出售时一并归还。
            </p>
          </div>
          <button
            className="button primary"
            onClick={() => {
              setPoolOpen(false);
              setPage("cards");
            }}
          >
            查看每张卡的剩余数量 <ArrowRight size={15} />
          </button>
        </Modal>
      )}
      {!!game.season?.trinketOffers.length && !game.discovery.length && (
        <Modal
          title={`${game.turn === 6 ? "小型" : "大型"}饰品，选一件带走`}
          subtitle={`第${game.turn}回合 · 当前${game.gold}金币 · 选择后持续生效`}
          wide
        >
          <SeasonTrinkets game={game} dispatch={dispatch} />
        </Modal>
      )}
      {game.discovery.length > 0 && (
        <Modal
          title={
            game.season?.discoveryKind === "darkGift"
              ? "黑暗发现，接受这份馈赠"
              : game.season?.discoveryKind === "spell"
                ? "发现一张酒馆法术"
                : "发现奖励，选一位新伙伴"
          }
          subtitle="选择一个随从加入手牌，未选择的随从将放回共享池。"
          wide
        >
          <div className="discovery-cards">
            {game.discovery.map((m) => (
              <div key={m.uid}>
                <MinionCard
                  m={m}
                  onClick={() => dispatch({ type: "discover", uid: m.uid })}
                />
                <GiftNote m={m} />
                <button
                  className="button primary"
                  onClick={() => dispatch({ type: "discover", uid: m.uid })}
                >
                  选择随从
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {game.phase === "combat" &&
        game.battle &&
        !(tableMode && page === "tavern") && (
          <Modal
            title={
              frame === game.battle.frames.length - 1
                ? game.battle.result === "win"
                  ? "漂亮，这一轮赢了！"
                  : game.battle.result === "loss"
                    ? "下一轮，找回节奏"
                    : "势均力敌！"
                : "让随从们一决高下"
            }
            subtitle={`第${game.turn}回合 · ${hero.name} vs ${game.battle.opponent}`}
            wide
          >
            <div className="combat-stage">
              <div className="combat-side-label">
                {game.battle.opponent}
                <span>对手战场</span>
              </div>
              <div className="combat-cards">
                {game.battle.frames[frame]?.enemies.map((m) => (
                  <div
                    className={
                      game.battle?.frames[frame]?.attacker === m.uid
                        ? "attacking"
                        : game.battle?.frames[frame]?.target === m.uid
                          ? "damaged"
                          : ""
                    }
                    key={m.uid}
                  >
                    <MinionCard m={m} compact />
                  </div>
                ))}
                {!game.battle.frames[frame]?.enemies.length && (
                  <span className="combat-empty">对方随从已全部退场</span>
                )}
              </div>
              <div className="combat-divider">
                <Swords size={18} />
                <span>{game.battle.frames[frame]?.text}</span>
              </div>
              <div className="combat-cards">
                {game.battle.frames[frame]?.allies.map((m) => (
                  <div
                    className={
                      game.battle?.frames[frame]?.attacker === m.uid
                        ? "attacking"
                        : game.battle?.frames[frame]?.target === m.uid
                          ? "damaged"
                          : ""
                    }
                    key={m.uid}
                  >
                    <MinionCard m={m} compact />
                  </div>
                ))}
                {!game.battle.frames[frame]?.allies.length && (
                  <span className="combat-empty">己方随从已全部退场</span>
                )}
              </div>
              <div className="combat-side-label">
                {hero.name}
                <span>我的战场</span>
              </div>
            </div>
            <div className="modal-bottom">
              <div className="playback-controls">
                <button
                  className="icon-button"
                  onClick={() => setPlaying(!playing)}
                  aria-label={playing ? "暂停战斗" : "继续播放"}
                >
                  {playing ? <span>Ⅱ</span> : <Play size={16} />}
                </button>
                <span>
                  {frame + 1} / {game.battle.frames.length}
                </span>
                <button
                  className="small-button"
                  onClick={() => setFrame(game.battle!.frames.length - 1)}
                >
                  <SkipForward size={14} />
                  跳过动画
                </button>
              </div>
              <button
                className="button primary"
                disabled={frame < game.battle.frames.length - 1}
                onClick={() => dispatch({ type: "continue" })}
              >
                {game.health <= 0 || game.opponents.every((o) => o.health <= 0)
                  ? "查看结果"
                  : "返回酒馆"}
                <ArrowRight size={15} />
              </button>
            </div>
          </Modal>
        )}
      {game.phase === "over" && (
        <Modal
          title={
            network
              ? `本局第 ${network.place || "—"} 名`
              : game.health > 0
                ? "酒馆之王，就是你！"
                : "这局结束，再来一杯？"
          }
          subtitle={
            network
              ? network.place === 1
                ? "你赢得了本场对局。"
                : "回到大厅，可以继续和朋友再来一局。"
              : game.health > 0
                ? "你击败了所有练习对手。"
                : `你在第${game.turn}回合结束了本次练习。`
          }
        >
          <div className="game-over">
            <Trophy size={56} />
            <h3>
              {network
                ? network.place === 1
                  ? "酒馆之王"
                  : `本局第 ${network.place || "—"} 名`
                : game.health > 0
                  ? "练习胜利"
                  : "继续磨练你的策略"}
            </h3>
            <p>
              招募{game.purchases}次 · 三连{game.triples}次 · 获胜
              {game.battles.filter((b) => b.result === "win").length}场
            </p>
          </div>
          <button
            className="button primary full-width"
            onClick={() => {
              if (network) {
                onLobby?.();
                return;
              }
              setGame(createGame(game.hero));
              setPage("tavern");
            }}
          >
            {network ? "返回对战大厅" : "再来一局"} <RotateCw size={16} />
          </button>
        </Modal>
      )}
    </div>
  );
}
export default App;
