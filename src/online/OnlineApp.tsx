import { JudgmentPanel } from './JudgmentPanel';
import { WatchPanel } from "./WatchPanel";
import type { AIWatch } from "../ai-watch";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Countdown, type RoomClock } from "./Countdown";
import { HeroDraft } from "./HeroDraft";
import { configureTableSound, playTableSound, unlockTableSound } from "../table/sound";
import { LoadingScreen } from "../loading/LoadingScreen";
import { useMatchResources } from "../loading/useMatchResources";
import { pauseResourceDownloads } from "../loading/resourceTraffic";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Crown,
  LogOut,
  Plus,
  Users,
  Swords,
  Wifi,
  UserRound,
} from "lucide-react";
import App from "../App";
import { SEASON_HEROES } from "../season/catalog";
import { art } from "../data";
import type { Action, Game } from "../engine";
import type { OnlineState, Room, AIModelOption } from "../../server/rooms";
import "./online.css";
type Identity = { token: string; id: string; name: string };
const key = "bobs-tavern-guest-v1";
function readIdentity(): Identity | null {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
export interface NetworkGame {
  game: Game;
  locked: boolean;
  watch?: AIWatch;
  watchControls?: ReactNode;
  judgmentPanel?: ReactNode;
  status: ReactNode;
  clock?: RoomClock;
  place?: number;
  send: (action: Action) => boolean;
  lobby: () => void;
}
export default function OnlineApp() {
  const [identity, setIdentity] = useState(readIdentity),
    [state, setState] = useState<OnlineState | null>(null),
    [name, setName] = useState(
      () =>
        readIdentity()?.name ||
        `旅人${Math.floor(1000 + Math.random() * 9000)}`,
    ),
    [hero, setHero] = useState("s14_lich"),
    [heroSelection, setHeroSelection] = useState<Room["heroSelection"]>(() => {
      try { return localStorage.getItem("bobs-tavern-hero-selection") === "draft" ? "draft" : "free"; }
      catch { return "free"; }
    }),
    [mode, setMode] = useState<Room["mode"]>(() => {
      try { return localStorage.getItem("bobs-tavern-room-mode") === "training" ? "training" : "timed"; }
      catch { return "timed"; }
    }),
    [models, setModels] = useState<AIModelOption[]>([]),
    [modelsError, setModelsError] = useState(""),
    [recordingAvailable, setRecordingAvailable] = useState(false),
    [recordTraining, setRecordTraining] = useState(() => {
      try { return localStorage.getItem('bobs-tavern-record-training') === 'yes'; } catch { return false; }
    }),
    [modelId, setModelId] = useState(() => {
      try { return localStorage.getItem("bobs-tavern-ai-model") || ""; } catch { return ""; }
    }),
    [code, setCode] = useState(
      () => new URLSearchParams(location.search).get("room") || "",
    ),
    [error, setError] = useState(""),
    [connectionError, setConnectionError] = useState(""),
    [pending, setPending] = useState(false),
    [connected, setConnected] = useState(false),
    [view, setView] = useState<"hall" | "game" | "practice">(() =>
      localStorage.getItem("bobs-tavern-entry") === "practice"
        ? "practice"
        : sessionStorage.getItem("tavern-online-view") === "game"
          ? "game"
          : "hall",
    );
  const receivedAt = useRef(performance.now());
  const resources = useMatchResources(view !== "practice");
  const visibleError = error || connectionError;
  function prepareHeroSound() {
    try {
      const level = localStorage.getItem("bobs-tavern-volume");
      configureTableSound(localStorage.getItem("bobs-tavern-sound") !== "off", level === null ? 0.65 : Number(level));
    } catch { /* Use the current audio preferences. */ }
    unlockTableSound(["heroSelect"]);
  }
  function heroSound() { prepareHeroSound(); playTableSound("heroSelect"); }
  useEffect(() => {
    try { localStorage.setItem("bobs-tavern-hero-selection", heroSelection); } catch {}
  }, [heroSelection]);
  useEffect(() => {
    try { localStorage.setItem("bobs-tavern-room-mode", mode); } catch {}
  }, [mode]);
  useEffect(() => {
    try { if (modelId) localStorage.setItem("bobs-tavern-ai-model", modelId); } catch {}
  }, [modelId]);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch("/tavern-api/models", { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error("暂时无法获取人机模型，正在重试…");
        const result = await response.json() as { models: AIModelOption[]; recordingAvailable?: boolean };
        if (stopped) return;
        setModels(result.models); setModelsError("");
        setRecordingAvailable(!!result.recordingAvailable);
        setModelId(previous => result.models.some(m => m.id === previous) ? previous :
          (result.models.find(m => m.available)?.id ?? result.models[0]?.id ?? ""));
      } catch {
        if (!stopped) setModelsError("暂时无法获取人机模型，正在重试…");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const selectedModel = models.find(m => m.id === modelId);
  useEffect(() => {
    try { localStorage.setItem('bobs-tavern-record-training', recordTraining ? 'yes' : 'no'); } catch {}
  }, [recordTraining]);
  const busy = useRef(false),
    last = useRef<OnlineState | null>(null);
  const room = state?.room,
    me = room?.seats.find((s) => s.id === identity?.id);
  function changeView(v: typeof view) {
    setView(v);
    sessionStorage.setItem("tavern-online-view", v);
    if (v === "practice") localStorage.setItem("bobs-tavern-entry", "practice");
    else localStorage.removeItem("bobs-tavern-entry");
  }
  function accept(next: OnlineState) {
    if (last.current && next.seq < last.current.seq) return;
    const previous = last.current;
    if (
      next.game?.battle &&
      next.battleId &&
      next.battleId === previous?.battleId &&
      previous.game?.battle
    ) {
      next.game.battle = previous.game.battle;
    }
    if (
      previous?.game &&
      next.game &&
      next.gameVersion !== undefined &&
      previous.gameVersion === next.gameVersion
    )
      next.game = previous.game;
    last.current = next;
    receivedAt.current = performance.now();
    setState(next);
    setConnected(true);
    setConnectionError("");
    // A reconnect can miss the waiting snapshot entirely. Enter on the first
    // active snapshot, but preserve an intentional visit to the same game's hall.
    if (next.game && next.room && next.room.stage !== "waiting" &&
      (!previous?.game || previous.room?.code !== next.room.code))
      changeView("game");
  }
  async function fetchApi(
    path: string,
    data?: unknown,
    token = identity?.token,
  ) {
    const resumeDownloads = pauseResourceDownloads();
    try {
    const res = await fetch("/tavern-api" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(last.current?.battleId
          ? { "X-Tavern-Battle": last.current.battleId }
          : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(12000),
      priority: "high",
    });
    if (res.status === 204) return null;
    const result = await res.json().catch(() => {
      throw Error("房间服务暂时不可用，请稍后再试");
    });
    if (!res.ok) {
      if (res.status === 401) {
        setIdentity(null);
        setState(null);
        last.current = null;
        localStorage.removeItem(key);
      }
      throw Error(result.error || "服务暂时不可用");
    }
    return result;
    } finally { resumeDownloads(); }
  }
  async function command(path: string, data: unknown = {}) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const next = await fetchApi(path, data);
      accept(next);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接失败，请重试");
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function login() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const next: Identity = await fetchApi("/guest", { name });
      localStorage.setItem(key, JSON.stringify(next));
      last.current = null;
      setIdentity(next);
      changeView("hall");
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  useEffect(() => {
    if (!identity) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!busy.current) {
          const data = await fetchApi(
            "/state?version=" + encodeURIComponent(last.current?.version || ""),
          );
          if (!cancelled) {
            if (data) accept(data);
            setConnected(true);
            setConnectionError("");
          }
        }
      } catch (e) {
        if (!cancelled) {
          setConnected(false);
          setConnectionError("连接中断，正在重连。房间进度保留。");
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, last.current?.room?.watch ? 500 : 1000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [identity?.token]);
  function send(action: Action) {
    if (room?.watch) return false;
    if (action.type === "continue" && state?.game && state.game.health <= 0) {
      changeView("hall");
      return true;
    }
    if (busy.current) {
      setError("上一项操作正在处理");
      return false;
    }
    void command("/action", {
      action,
      turn: room!.turn,
      requestId: crypto.randomUUID(),
    });
    return true;
  }
  const status = room ? (
    <>
      {`${room.kind === "spectate" ? "AI 观战" : room.kind === "ai" ? "人机对局" : `好友房 ${room.code}`} · 第 ${room.turn} 回合${me?.ended && room.stage === "recruit" ? " · 等待其他玩家" : me?.continued && room.stage === "combat" ? " · 等待下一回合" : ""}`}
      <span>{room.watch ? room.watch.paused ? " · 已暂停" : " · 自动播放" : room.mode === "training" ? " · 训练模式 · 不限时" : " · 烧绳模式"}</span>
      {room.recordTraining && <span> · 本局操作录制已开启</span>}
      <span>{room.aiModel ? ` · ${room.aiModel.label}` : ""}{room.aiStatus === "fallback" ? " · 本轮使用脚本人机，模型恢复后重试" : ""}</span>
      <Countdown
        deadline={room.deadline}
        serverNow={room.serverNow}
        receivedAt={receivedAt.current}
      />
    </>
  ) : (
    ""
  );
  if (view === "practice") return <App onLobby={() => changeView("hall")} />;
  if (view === "game" && state?.game && room && !resources.ready)
    return <LoadingScreen title="正在下载对战资源" detail={resources.failed
      ? `${resources.failed} 个资源下载失败，请重试。` : "准备卡面与音效，完成后进入对局。"}
      completed={resources.completed} total={resources.total}
      onContinue={resources.phase === "error" ? resources.retry : undefined} continueLabel="重试下载" />;
  if (view === "game" && state?.game && room)
    return (
      <>
        <App
          network={{
            game: state.game,
            judgmentPanel: room.kind === 'ai' && <JudgmentPanel key={room.code} game={state.game}
              version={state.judgmentVersion} token={identity!.token}
              active={room.stage === 'recruit' && !me?.ended && state.game.health > 0} />,
            watch: room.watch,
            watchControls: room.watch && <WatchPanel watch={room.watch} game={state.game} stage={room.stage} pending={pending}
              command={name => void command("/watch", { command: name, decisionId: room.watch?.decision?.id, turn: room.turn })} />,
            locked: room.watch ? true :
              room.stage === "recruit"
                ? !!me?.ended
                : room.stage === "combat"
                  ? !!me?.continued && state.game.health > 0
                  : false,
            status,
            clock: room.stage === "recruit" && room.deadline > 0 && room.mode !== "training" && !me?.ended && state.game.health > 0
              ? { deadline: room.deadline, serverNow: room.serverNow, receivedAt: receivedAt.current } : undefined,
            place: me?.place,
            send,
            lobby: () => changeView("hall"),
          }}
          onLobby={() => changeView("hall")}
        />
        {visibleError && (
          <div className="online-game-error" role="alert">
            {visibleError}
            <button onClick={() => { setError(""); setConnectionError(""); }}>关闭</button>
          </div>
        )}
        {!connected && (
          <div className="online-reconnect">
            连接中断，正在重连。房间进度保留。
          </div>
        )}
      </>
    );
  return (
    <div className="online-lobby" onPointerDownCapture={prepareHeroSound} onKeyDownCapture={prepareHeroSound}>
      <header className="online-top">
        <a href="/" className="online-wordmark">
          <Crown size={24} />
          <span>
            鲍勃的酒馆<small>BATTLEGROUNDS · PLAYROOM</small>
          </span>
        </a>
        <span className="online-identity">
          <UserRound size={16} />
          {identity ? identity.name : "游客入口"}
          {identity && <i className={connected ? "connected" : ""} />}
        </span>
      </header>
      <main className="online-main">
        {<section className="room-resources" aria-label="对战资源">
          <div role="status">{resources.ready ? "对战资源已就绪" : resources.phase === "error"
            ? `${resources.failed} 个资源下载失败` : `正在下载对战资源 · ${resources.completed} / ${resources.total}`}</div>
          {!resources.ready && <>
            <progress aria-label="对战资源下载进度" value={resources.completed} max={resources.total} />
            <small>登录、选英雄时会继续下载，完成后即可创建或加入房间。下次进入会使用缓存。</small>
          </>}
          {resources.phase === "error" && <button className="online-secondary" onClick={() => void resources.retry()}>重试下载</button>}
        </section>}
        {!identity ? (
          <section className="guest-entry">
            <div className="online-eyebrow">旅人，欢迎来到酒馆</div>
            <h1>
              今晚，和谁
              <br />
              <em>来一局？</em>
            </h1>
            <p>以游客身份进入，挑战人机，或邀朋友同桌。</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void login();
              }}
            >
              <label htmlFor="guest-name">你的酒馆昵称</label>
              <input
                id="guest-name"
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
                autoComplete="nickname"
              />
              <button
                className="online-primary"
                disabled={pending || !name.trim()}
              >
                {pending ? "正在进入…" : "游客进入"}
                <ArrowRight size={18} />
              </button>
            </form>
            <small>免注册。游客身份保存在此浏览器中。</small>
            <button
              className="online-text-button"
              onClick={() => changeView("practice")}
            >
              继续本地练习 <ArrowRight size={13} />
            </button>
          </section>
        ) : !state ? (
          <LoadingScreen
            embedded
            title="正在连接酒馆"
            detail="找回你的座位与对局进度…"
            continueLabel="先玩本地练习"
            onContinue={() => changeView("practice")}
          />
        ) : room ? (
          <section className="room-panel">
            <div className="room-heading">
              <div>
                <div className="online-eyebrow">
                  {room.kind === "ai" ? "人机对局" : "好友酒馆"}
                  {room.mode === "training" ? " · 训练模式 · 不限时" : " · 烧绳模式 · 招募 90 秒"}
                  {room.heroSelection === "draft" ? " · 随机四选一" : " · 自选英雄"}
                  {room.aiModel ? ` · ${room.aiModel.label}` : ""}
                </div>
                <h1>
                  {room.stage === "waiting"
                    ? room.heroSelection === "draft" ? "选好英雄，再开局" : "等朋友坐下"
                    : room.stage === "finished"
                      ? "本局已结束"
                      : "对局进行中"}
                </h1>
                <p>
                  {room.stage === "waiting"
                    ? `${room.kind === "ai" ? "选好英雄后开局，与 7 名人机对战。" : "最多 8 人，空位自动补人机。所有朋友准备后由房主开局。"}${room.mode === "training" ? "手动结束招募，战斗后手动返回酒馆。" : "招募倒计时结束自动开战。"}`
                    : status}
                </p>
              </div>
              {room.kind === "friends" && <button
                className="room-code"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(room.code);
                    setError("房间码已复制");
                  } catch {
                    setError(`房间码：${room.code}`);
                  }
                }}
                aria-label="复制房间码"
              >
                <small>房间码</small>
                <strong>{room.code}</strong>
                <Copy size={16} />
              </button>}
            </div>
            {room.stage === "waiting" && room.heroSelection === "draft" && (
              <HeroDraft offers={room.heroOffers || []} selected={me?.hero} pending={pending}
                choose={async (hero) => { if (await command("/hero", { hero })) heroSound(); }}
                refresh={(slot, expectedHero) => void command("/refresh-hero", { slot, expectedHero })} />
            )}
            {!(room.kind === "ai" && room.stage === "waiting") && <div className="room-seats">
              {Array.from({ length: 8 }, (_, i) => {
                const p = room.seats[i],
                  h = SEASON_HEROES.find((h) => h.id === p?.hero);
                return p ? (
                  <article
                    className={`room-seat ${p.id === identity.id ? "self" : ""}`}
                    key={p.id}
                  >
                    {h ? <img src={art(h.art)} alt="" /> : <span className="room-hero-placeholder"><UserRound size={25} /></span>}
                    <div>
                      <strong>
                        {p.name}
                        {p.id === room.host && <Crown size={13} />}
                      </strong>
                      <span>
                        {h?.name || "正在选择英雄"} ·{" "}
                        {p.bot
                          ? "人机"
                          : p.id === identity.id
                            ? "你"
                            : p.online
                              ? "在线"
                              : "重连中"}
                      </span>
                    </div>
                    <b className={p.ready ? "ready" : ""}>
                      {room.stage === "waiting"
                        ? p.id === room.host
                          ? "房主"
                          : p.ready
                            ? "已准备"
                            : "未准备"
                        : p.place
                          ? `第 ${p.place} 名`
                          : p.left
                            ? "已离开"
                            : `${Math.max(0, p.health || 0)} 生命`}
                    </b>
                  </article>
                ) : (
                  <article className="room-seat empty" key={i}>
                    <Plus size={24} />
                    <span>
                      等待朋友<small>开局时补入人机</small>
                    </span>
                  </article>
                );
              })}
            </div>}
            {room.stage === "waiting" && room.heroSelection !== "draft" && (
              <label className="online-hero-picker">
                选择英雄
                <select
                  aria-label="房间英雄"
                  value={me?.hero}
                  disabled={pending}
                  onChange={(e) =>
                    void command("/hero", { hero: e.target.value }).then((ok) => { if (ok) heroSound(); })
                  }
                >
                  {SEASON_HEROES.map((h) => (
                    <option
                      key={h.id}
                      value={h.id}
                      disabled={room.seats.some(
                        (p) => p.id !== identity.id && p.hero === h.id,
                      )}
                    >
                      {h.name} · {h.power}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="room-actions">
              {room.stage === "waiting" ? (
                room.host === identity.id ? (
                  <button
                    className="online-primary"
                    disabled={
                      pending || !resources.ready ||
                      room.seats.some((p) => !p.hero) ||
                      room.seats.some((p) => p.id !== identity.id && !p.ready)
                    }
                    onClick={() => void command("/start")}
                  >
                    {room.kind === "ai" ? "确认英雄并开局" : "开局 · 空位补人机"}
                    <Swords size={18} />
                  </button>
                ) : (
                  <button
                    className="online-primary"
                    disabled={pending || !me?.hero || (!me?.ready && !resources.ready)}
                    onClick={() =>
                      void command("/ready", { ready: !me?.ready })
                    }
                  >
                    {me?.ready ? "取消准备" : "准备好了"}
                    <Check size={18} />
                  </button>
                )
              ) : (
                <>
                  <button
                    className="online-primary"
                    onClick={() => changeView("game")}
                  >
                    {room.stage === "finished" ? "查看本局结果" : "返回对局"}
                    <ArrowRight size={18} />
                  </button>
                  {room.stage === "finished" && !room.watch && room.host === identity.id && (
                    <button
                      className="online-secondary"
                      disabled={pending}
                      onClick={() => void command("/rematch")}
                    >
                      再开一局
                    </button>
                  )}
                </>
              )}
              <button
                className="online-text-button"
                disabled={pending}
                onClick={() => {
                  if (
                    room.stage === "waiting" ||
                    room.stage === "finished" ||
                    window.confirm("离开进行中的房间将退出本局，是否继续？")
                  )
                    void command("/leave");
                }}
              >
                <LogOut size={15} />
                {room.stage === "waiting" || room.stage === "finished"
                  ? "离开房间"
                  : "退出本局"}
              </button>
            </div>
          </section>
        ) : (
          <section className="match-selection">
            <div className="online-eyebrow">欢迎回来，{identity.name}</div>
            <h1>
              找张椅子，<em>坐下来吧。</em>
            </h1>
            <fieldset className="recruit-mode-picker" disabled={pending}>
              <legend>英雄选择方式</legend>
              <label>
                <input type="radio" name="hero-selection" checked={heroSelection === "free"} onChange={() => setHeroSelection("free")} />
                <span><strong>自选英雄</strong><small>从已实现的英雄中自由选择。</small></span>
              </label>
              <label>
                <input type="radio" name="hero-selection" checked={heroSelection === "draft"} onChange={() => setHeroSelection("draft")} />
                <span><strong>随机四选一</strong><small>开局前抽取四位英雄，每位都能单独刷新。</small></span>
              </label>
              <p>创建好友房时由房主决定，所有玩家使用同一种选择方式。</p>
            </fieldset>
            {heroSelection === "free" && <label className="online-hero-picker">
              本局英雄
              <select
                aria-label="匹配英雄"
                value={hero}
                onChange={(e) => { setHero(e.target.value); heroSound(); }}
              >
                {SEASON_HEROES.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} · {h.power}
                  </option>
                ))}
              </select>
            </label>}
            <fieldset className="recruit-mode-picker" disabled={pending}>
              <legend>对局模式</legend>
              <label>
                <input type="radio" name="room-mode" value="timed" checked={mode === "timed"} onChange={() => setMode("timed")} />
                <span><strong>烧绳模式</strong><small>招募 90 秒，最后 20 秒烧绳，到时自动开战。</small></span>
              </label>
              <label>
                <input type="radio" name="room-mode" value="training" checked={mode === "training"} onChange={() => setMode("training")} />
                <span><strong>训练模式</strong><small>不限时，手动结束招募、返回酒馆。好友房等所有玩家确认。</small></span>
              </label>
              <p>用于下方的人机匹配和新建好友房；加入好友房时沿用房主的选择。</p>
            </fieldset>
            <fieldset className="recruit-mode-picker ai-model-picker" disabled={pending}>
              <legend>人机对手模型</legend>
              {models.map(model => <label key={model.id}>
                <input type="radio" name="ai-model" value={model.id} checked={modelId === model.id}
                  disabled={!model.available} onChange={() => setModelId(model.id)} />
                <span><strong>{model.label}</strong><small>
                  {model.episodes === undefined ? "基础策略" : `${model.episodes} 局训练`}
                  {!model.available ? " · 暂不可用" : ""}
                </small></span>
              </label>)}
              {!models.length && <p>{modelsError || "正在获取可用模型…"}</p>}
              {!!models.length && <p>{modelsError || "同桌人机使用所选模型，好友房空位也适用。层数不代表难度。"}</p>}
            </fieldset>
            <fieldset className="recruit-mode-picker" disabled={pending || !recordingAvailable}>
              <legend>实战样本</legend>
              <label><input type="checkbox" checked={recordTraining} onChange={e => setRecordTraining(e.target.checked)} />
                <span><strong>记录我的操作，用于模型训练</strong><small>仅用于新建人机对局。保存可见局面、操作和结果，完整对局用于后续训练。</small></span>
              </label>
            </fieldset>
            <div className="match-modes">
              <button className="match-tile" disabled={pending || !resources.ready || !selectedModel?.available || selectedModel.id === "script" || !!modelsError}
                onClick={async () => { if (await command("/create", { kind: "spectate", hero, modelId })) changeView("game"); }}>
                <span className="match-icon"><UserRound size={35} /></span>
                <small>AI VIEW</small><h2>AI 观战</h2>
                <p>看所选模型完成一局。<br />查看 AI 对每项操作的偏好，支持暂停和逐步观看。</p>
                <strong>开始观战<ArrowRight size={18} /></strong>
              </button>
              <button
                className="match-tile"
                disabled={pending || !resources.ready || !selectedModel?.available || !!modelsError}
                onClick={async () => {
                  if (await command("/create", { kind: "ai", hero, mode, heroSelection, modelId, recordTraining: recordTraining && recordingAvailable }))
                    changeView(heroSelection === "draft" ? "hall" : "game");
                }}
              >
                <span className="match-icon">
                  <Swords size={35} />
                </span>
                <small>SOLO</small>
                <h2>人机匹配</h2>
                <p>
                  与你同桌的 7 名人机，
                  <br />
                  从招募一路战至最后。
                </p>
                <strong>
                  {pending ? "正在安排对局…" : "开始匹配"}
                  <ArrowRight size={18} />
                </strong>
              </button>
              <button
                className="match-tile friends"
                disabled={pending || !resources.ready || !selectedModel?.available || !!modelsError}
                onClick={() =>
                  void command("/create", { kind: "friends", hero, mode, heroSelection, modelId })
                }
              >
                <span className="match-icon">
                  <Users size={35} />
                </span>
                <small>WITH FRIENDS</small>
                <h2>创建好友房</h2>
                <p>
                  房间码邀请，最多 8 人。
                  <br />
                  没坐满的位置由人机加入。
                </p>
                <strong>
                  开一间酒馆
                  <Plus size={18} />
                </strong>
              </button>
            </div>
            <form
              className="join-room"
              onSubmit={(e) => {
                e.preventDefault();
                void command("/join", { code: code.trim().toUpperCase() });
              }}
            >
              <label htmlFor="room-code">已有房间码？</label>
              <input
                id="room-code"
                placeholder="输入 6 位房间码"
                value={code}
                maxLength={6}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <button
                className="online-secondary"
                disabled={pending || !resources.ready || code.trim().length !== 6}
              >
                加入房间
                <ArrowRight size={16} />
              </button>
            </form>
            <button
              className="online-text-button"
              onClick={() => changeView("practice")}
            >
              继续本地练习存档
              <ArrowRight size={14} />
            </button>
          </section>
        )}
        {visibleError && (
          <div className="online-error" role="alert">
            {visibleError}
            <button onClick={() => { setError(""); setConnectionError(""); }}>关闭</button>
          </div>
        )}
      </main>
      <footer className="online-footer">
        <span>第14赛季 · 部分复刻</span>
        <span>
          <Wifi size={12} />
          {identity ? (connected ? "已连接酒馆" : "正在连接") : "游客免注册"}
        </span>
      </footer>
    </div>
  );
}
