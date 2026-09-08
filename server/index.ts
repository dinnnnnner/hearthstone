import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { Rooms } from "./rooms";
import type { Action } from "../src/engine";
const store = new Rooms(),
  saveFile = process.env.TAVERN_STATE || "/tmp/tavern-online-state.json";
if (existsSync(saveFile)) store.restore(readFileSync(saveFile, "utf8"));
let saved = -1;
function persist() {
  if (saved === store.seq) return;
  mkdirSync(dirname(saveFile), { recursive: true });
  writeFileSync(saveFile + ".next", store.dump(), { mode: 0o600 });
  renameSync(saveFile + ".next", saveFile);
  saved = store.seq;
}
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
  "move",
]);
function action(input: unknown): Action {
  if (!input || typeof input !== "object") throw Error("无效操作");
  const a = input as Record<string, unknown>;
  if (
    !allowed.has(String(a.type)) ||
    Object.keys(a).some(
      (k) => !["type", "uid", "target", "position", "to"].includes(k),
    )
  )
    throw Error("无效操作");
  for (const k of ["uid", "target"])
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
    ["buy", "sell", "discover", "play", "move"].includes(a.type as string) &&
    !a.uid
  )
    throw Error("缺少随从");
  if (a.type === "move" && a.to === undefined) throw Error("缺少站位");
  return a as unknown as Action;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost"),
      path = url.pathname.replace(/^\/tavern-api/, "");
    if (path === "/health" && req.method === "GET") {
      reply(
        res,
        200,
        { ok: true, service: "tavern", rooms: store.rooms.size },
        req,
      );
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
      const view = store.view(guest);
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
    switch (path) {
      case "/create":
        if (!["friends", "ai"].includes(data.kind)) throw Error("无效房间类型");
        store.create(guest, data.kind, String(data.hero || "s14_lich"));
        break;
      case "/join":
        if (typeof data.code !== "string" || !/^[A-Z2-9]{6}$/i.test(data.code))
          throw Error("请输入 6 位房间码");
        store.join(guest, data.code);
        break;
      case "/hero":
        store.hero(guest, String(data.hero));
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
        store.action(guest, action(data.action), data.requestId, data.turn);
        break;
      default:
        reply(res, 404, { error: "未找到接口" });
        return;
    }
    reply(res, 200, store.view(guest), req);
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
    persist();
    for (const [k, v] of limits)
      if (Date.now() - v.at > 60000) limits.delete(k);
  } catch (e) {
    console.error("Room tick failed", e instanceof Error ? e.message : e);
  }
}, 1000);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(ticker);
    persist();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
server.listen(
  Number(process.env.TAVERN_PORT || 8787),
  process.env.TAVERN_HOST || "127.0.0.1",
  () =>
    console.log(
      "Tavern room service listening on " + (process.env.TAVERN_PORT || 8787),
    ),
);
