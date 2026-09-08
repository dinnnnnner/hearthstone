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
  let token = "";
  const call = (path: string, data?: unknown, auth = token) =>
    fetch(`http://127.0.0.1:${port}/tavern-api` + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    await start();
    assert.equal((await call("/state", undefined, "invalid")).status, 401);
    const guest = (await (
      await call("/guest", { name: "重连验证" })
    ).json()) as { token: string };
    token = guest.token;
    const created = (await (
      await call("/create", { kind: "friends", hero: "s14_lich" })
    ).json()) as { room: { code: string } };
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
    await stop();
    await start();
    const restored = (await (await call("/state")).json()) as {
      room: { code: string };
      guest: { name: string };
    };
    assert.equal(restored.room.code, created.room.code);
    assert.equal(restored.guest.name, "重连验证");
    assert.equal((await call("/leave", {})).status, 200);
  } finally {
    await stop();
    rmSync(temp, { recursive: true, force: true });
  }
});
