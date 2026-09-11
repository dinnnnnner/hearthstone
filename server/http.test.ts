import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
test("HTTP authentication, action validation and a graceful server restart preserve the guest room", async () => {
  const temp = mkdtempSync(join(tmpdir(), "tavern-http-")),
    socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  let child: ChildProcess | undefined;
  const start = async () => {
    child = spawn(process.execPath, ["server-dist/server.cjs"], {
      env: {
        ...process.env,
        TAVERN_PORT: String(port),
        TAVERN_STATE: join(temp, "state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/tavern-api/health`)).ok)
          return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("Server failed to start");
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  };
  let token = "",
    knownBattle = "";
  const call = (path: string, data?: unknown, auth = token) =>
    fetch(`http://127.0.0.1:${port}/tavern-api` + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth,
        "X-Tavern-Battle": knownBattle,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    await start();
    assert.deepEqual((await (await call("/models", undefined, "")).json()).models, [{ id: "script", label: "脚本人机", available: true }]);
    assert.equal((await call("/state", undefined, "invalid")).status, 401);
    const guest = (await (
      await call("/guest", { name: "重连验证" })
    ).json()) as { token: string };
    token = guest.token;
    assert.equal((await call("/create", { kind: "ai", mode: "invalid" })).status, 400);
    assert.equal((await call("/create", { kind: "ai", modelId: "missing" })).status, 400);
    const created = (await (
      await call("/create", { kind: "friends", hero: "s14_lich", mode: "training" })
    ).json()) as { room: { code: string; mode: string } };
    assert.equal(created.room.mode, "training");
    assert.equal(
      (
        await call("/action", {
          turn: 1,
          requestId: "bad-action",
          action: { type: "steal", gold: 999 },
        })
      ).status,
      400,
    );
    await call("/start", {});
    const combat = (await (
      await call("/action", {
        turn: 1,
        requestId: "end",
        action: { type: "end" },
      })
    ).json()) as any;
    assert.ok(combat.game.battle.frames.length);
    assert.equal(combat.room.deadline, 0);
    knownBattle = combat.battleId;
    const cached = (await (await call("/state")).json()) as any;
    assert.equal(cached.game.battle.frames.length, 0);
    assert.equal(
      (await call("/state?version=" + encodeURIComponent(cached.version)))
        .status,
      204,
    );
    knownBattle = "";
    await stop();
    await start();
    const restored = (await (await call("/state")).json()) as {
      room: { code: string; mode: string; deadline: number };
      guest: { name: string };
      battleId: string;
      game: { battle: { frames: unknown[] } };
    };
    assert.equal(restored.room.code, created.room.code);
    assert.equal(restored.room.mode, "training");
    assert.equal(restored.room.deadline, 0);
    assert.equal(restored.guest.name, "重连验证");
    assert.equal(restored.battleId, combat.battleId);
    assert.deepEqual(restored.game.battle.frames, combat.game.battle.frames);
    assert.equal((await call("/leave", {})).status, 200);
    assert.equal((await call("/create", { kind: "ai", heroSelection: "invalid" })).status, 400);
    const draft = await (await call("/create", { kind: "ai", heroSelection: "draft", mode: "training" })).json() as any;
    assert.equal(draft.room.stage, "waiting");
    assert.equal(draft.room.heroOffers.length, 4);
    assert.equal((await call("/start", {})).status, 400);
    assert.equal((await call("/refresh-hero", { slot: -1, expectedHero: draft.room.heroOffers[0] })).status, 400);
    const refreshed = await (await call("/refresh-hero", { slot: 1, expectedHero: draft.room.heroOffers[1] })).json() as any;
    assert.notEqual(refreshed.room.heroOffers[1], draft.room.heroOffers[1]);
    assert.equal((await call("/refresh-hero", { slot: 1, expectedHero: draft.room.heroOffers[1] })).status, 400);
    await stop(); await start();
    const resumedDraft = await (await call("/state")).json() as any;
    assert.deepEqual(resumedDraft.room.heroOffers, refreshed.room.heroOffers);
    assert.equal(resumedDraft.room.heroSelection, "draft");
    assert.equal((await call("/hero", { hero: resumedDraft.room.heroOffers[0] })).status, 200);
    const startedDraft = await (await call("/start", {})).json() as any;
    assert.equal(startedDraft.room.stage, "recruit");
    assert.equal(new Set(startedDraft.room.seats.map((p: any) => p.hero)).size, 8);
    assert.equal((await call("/leave", {})).status, 200);
  } finally {
    await stop();
    rmSync(temp, { recursive: true, force: true });
  }
});
