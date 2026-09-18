import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Rooms, judgmentVersion } from "./rooms";
import { NeuralRooms, httpInference } from "./neural";
import { evaluateTavern } from './judgment';
import { multiModelRooms } from "./model-registry";
import { SnapshotWriter } from "./persistence";
import { Demonstrations } from "./demonstrations";
import { createHash } from "node:crypto";
import type { Action } from "../src/engine";
const store = process.env.TAVERN_INFERENCE_MODELS
    ? multiModelRooms(process.env.TAVERN_INFERENCE_MODELS, Number(process.env.TAVERN_INFERENCE_MAX_KBPS || 512))
    : process.env.TAVERN_INFERENCE_URL
    ? new NeuralRooms(httpInference(process.env.TAVERN_INFERENCE_URL, {
      compress: process.env.TAVERN_INFERENCE_COMPRESS === '1',
      maxKbps: Number(process.env.TAVERN_INFERENCE_MAX_KBPS || 0),
    }), Date.now, Math.random,
      process.env.TAVERN_INFERENCE_PROFILE || 'legacy-v3') : new Rooms(),
  saveFile = process.env.TAVERN_STATE || "/tmp/tavern-online-state.json";
if (existsSync(saveFile)) store.restore(readFileSync(saveFile, "utf8"));
const writer = new SnapshotWriter(store, saveFile);
const demonstrations = process.env.TAVERN_DEMONSTRATIONS
  ? new Demonstrations(process.env.TAVERN_DEMONSTRATIONS, createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))
  : undefined;
demonstrations?.observe(store, false);
let closing = false;
const limits = new Map<string, { at: number; count: number }>();
function rate(key: string, max: number) {
  const t = Date.now(),
    old = limits.get(key);
  if (!old || t - old.at > 60000) {
    limits.set(key, { at: t, count: 1 });
    return true;
  }
  return ++old.count <= max;
}
function reply(
  res: ServerResponse,
  code: number,
  data?: unknown,
  req?: IncomingMessage,
) {
  if (data === undefined) {
    res.writeHead(code, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  let body: Buffer = Buffer.from(JSON.stringify(data));
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept-Encoding",
  };
  if (body.length > 1500 && req?.headers["accept-encoding"]?.includes("gzip")) {
    body = gzipSync(body);
    headers["Content-Encoding"] = "gzip";
  }
  res.writeHead(code, headers);
  res.end(body);
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8192) throw Error("请求内容过长");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw Error("请求格式不正确");
  }
}
const allowed = new Set([
  "darkGift",
  "buyTrinket",
  "buySpell",
  "cast",
  "activate",
  "refresh",
  "freeze",
  "upgrade",
  "end",
  "continue",
  "reward",
  "buy",
  "sell",
  "discover",
  "play",
  "power",
  "choosePower",
  "move",
]);
function action(input: unknown): Action {
  if (!input || typeof input !== "object") throw Error("无效操作");
  const a = input as Record<string, unknown>;
  if (
    !allowed.has(String(a.type)) ||
    Object.keys(a).some(
      (k) => !["type", "uid", "target", "position", "to", "powerId"].includes(k),
    )
  )
    throw Error("无效操作");
  for (const k of ["uid", "target", "powerId"])
    if (
      a[k] !== undefined &&
      (typeof a[k] !== "string" || (a[k] as string).length > 120)
    )
      throw Error("无效随从");
  for (const k of ["position", "to"])
    if (
      a[k] !== undefined &&
      (!Number.isInteger(a[k]) || (a[k] as number) < 0 || (a[k] as number) > 7)
    )
      throw Error("无效站位");
  if (
    ["buy", "sell", "discover", "choosePower", "play", "move"].includes(a.type as string) &&
    !a.uid
  )
    throw Error("缺少随从");
  if (a.type === "move" && a.to === undefined) throw Error("缺少站位");
  return a as unknown as Action;
}
const server = createServer(async (req, res) => {
  try {
    if (closing) {
      reply(res, 503, { error: "服务正在重启，请稍后重试" });
      return;
    }
    const url = new URL(req.url || "/", "http://localhost"),
      path = url.pathname.replace(/^\/tavern-api/, "");
    if (path === "/health" && req.method === "GET") {
      reply(
        res,
        200,
        { ok: true, service: "tavern", rooms: store.rooms.size,
          recording: demonstrations?.stats ?? { enabled: false },
          ...(store instanceof NeuralRooms ? { ai: { ...store.ai, models: store.modelStats() } } : {}) },
        req,
      );
      return;
    }
    if (path === "/models" && req.method === "GET") {
      reply(res, 200, { models: store.modelOptions(), recordingAvailable: !!demonstrations }, req);
      return;
    }
    const ip = String(
      req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown",
    );
    if (!rate("ip:" + ip, 3000)) {
      reply(res, 429, { error: "操作过于频繁，请稍后再试" });
      return;
    }
    if (path === "/guest" && req.method === "POST") {
      if (!rate("guest:" + ip, 30)) {
        reply(res, 429, { error: "请稍后再创建游客" });
        return;
      }
      const data = await body(req);
      const guest = store.guest(data.name);
      reply(res, 201, guest, req);
      return;
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
    let guest;
    try {
      guest = store.auth(token);
    } catch {
      reply(res, 401, { error: "游客登录已失效，请重新进入" });
      return;
    }
    if (req.method === "GET" && path === "/state") {
      const view = store.view(
        guest,
        String(req.headers["x-tavern-battle"] || ""),
      );
      if (url.searchParams.get("version") === view.version) {
        reply(res, 204);
        return;
      }
      reply(res, 200, view, req);
      return;
    }
    if (req.method !== "POST") {
      reply(res, 404, { error: "未找到接口" });
      return;
    }
    if (!rate("action:" + guest.id, 180)) {
      reply(res, 429, { error: "操作过于频繁，请稍后再试" });
      return;
    }
    const data = await body(req);
    if (path === '/judgment') {
      if (typeof data.version !== 'string') throw Error('缺少局面版本');
      if (store instanceof NeuralRooms) reply(res, 200, await store.judgment(guest, data.version), req);
      else {
        const { r, p } = store.member(guest);
        if (r.kind !== 'ai' || r.stage !== 'recruit' || p.bot || p.ended || !p.game || p.game.health <= 0 ||
          data.version !== judgmentVersion(r, p)) throw Error('局面已更新或不在人机招募阶段');
        reply(res, 200, { version: data.version, evaluation: evaluateTavern(p.game),
          policyError: '当前使用脚本人机，没有模型动作概率。' }, req);
      }
      return;
    }
    // Finalize an elimination before leave/rematch mutates its seat or room.
    demonstrations?.observe(store);
    switch (path) {
      case "/create":
        if (!["friends", "ai", "spectate"].includes(data.kind)) throw Error("无效房间类型");
        if (data.recordTraining !== undefined && typeof data.recordTraining !== 'boolean') throw Error('无效录制设置');
        if (data.recordTraining && (!demonstrations || data.kind !== 'ai')) throw Error('实战录制仅适用于已开启录制服务的人机对局');
        store.create(guest, data.kind, String(data.hero || "s14_lich"), data.mode, data.heroSelection, data.modelId);
        if (data.recordTraining) { const { r } = store.member(guest); r.recordTraining = true; store.touch(r); }
        break;
      case "/watch":
        store.watchControl(guest, data.command, data.decisionId, data.turn);
        break;
      case "/join":
        if (typeof data.code !== "string" || !/^[A-Z2-9]{6}$/i.test(data.code))
          throw Error("请输入 6 位房间码");
        store.join(guest, data.code);
        break;
      case "/hero":
        store.hero(guest, String(data.hero));
        break;
      case "/refresh-hero":
        store.refreshHero(guest, data.slot, data.expectedHero);
        break;
      case "/ready":
        if (typeof data.ready !== "boolean") throw Error("无效准备状态");
        store.ready(guest, data.ready);
        break;
      case "/start":
        store.start(guest);
        break;
      case "/leave":
        store.leave(guest);
        break;
      case "/rematch":
        store.rematch(guest);
        break;
      case "/action":
        if (
          typeof data.requestId !== "string" ||
          data.requestId.length > 80 ||
          !Number.isInteger(data.turn)
        )
          throw Error("无效请求");
        if (demonstrations) demonstrations.action(store, guest, action(data.action), data.requestId, data.turn);
        else store.action(guest, action(data.action), data.requestId, data.turn);
        break;
      default:
        reply(res, 404, { error: "未找到接口" });
        return;
    }
    demonstrations?.observe(store);
    reply(
      res,
      200,
      store.view(guest, String(req.headers["x-tavern-battle"] || "")),
      req,
    );
  } catch (e) {
    reply(
      res,
      400,
      { error: e instanceof Error ? e.message : "操作失败，请重试" },
      req,
    );
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
const ticker = setInterval(() => {
  try {
    store.tick();
    demonstrations?.observe(store);
    void writer
      .flush()
      .catch((e) => console.error("Room save failed", e.message));
    for (const [k, v] of limits)
      if (Date.now() - v.at > 60000) limits.delete(k);
  } catch (e) {
    console.error("Room tick failed", e instanceof Error ? e.message : e);
  }
}, 1000);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    clearInterval(ticker);
    if (store instanceof NeuralRooms) store.stop();
    server.close(() => {
      void Promise.all([writer.flush(), demonstrations?.close()]).then(
        () => process.exit(0),
        (e) => {
          console.error("Final room save failed", e.message);
          process.exit(1);
        },
      );
    });
    setTimeout(() => process.exit(1), 7000).unref();
  });
server.listen(
  Number(process.env.TAVERN_PORT || 8787),
  process.env.TAVERN_HOST || "127.0.0.1",
  () =>
    console.log(
      "Tavern room service listening on " + (process.env.TAVERN_PORT || 8787),
    ),
);
