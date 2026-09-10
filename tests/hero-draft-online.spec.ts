import { test, expect } from "@playwright/test";
const path = process.env.TAVERN_TEST_PATH || "/";
test("two live players refresh a shared hero pool concurrently and cannot replay stale refreshes", async ({ page, browser, request }) => {
  const context = await browser.newContext({ baseURL: process.env.TEST_BASE_URL || "http://localhost:5174" });
  const friend = await context.newPage();
  const tokens: string[] = [];
  const api = async (token: string, endpoint: string, data?: unknown) => {
    const res = await request.fetch("/tavern-api" + endpoint, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}` },
      ...(data === undefined ? {} : { data }),
    });
    return { status: res.status(), data: await res.json() };
  };
  try {
    for (const [i, p] of [page, friend].entries()) {
      await p.goto(path);
      await p.getByLabel("你的酒馆昵称").fill(`选将联机${i}`);
      await p.getByRole("button", { name: "游客进入", exact: true }).click();
      await expect(p.getByRole("heading", { name: "人机匹配" })).toBeVisible();
      tokens.push(await p.evaluate(() => JSON.parse(localStorage.getItem("bobs-tavern-guest-v1")!).token));
    }
    await page.getByRole("radio", { name: /随机四选一/ }).check();
    await page.getByRole("button", { name: /创建好友房/ }).click();
    await expect(page.locator(".hero-draft-card")).toHaveCount(4);
    const initial = (await api(tokens[0], "/state")).data;
    await friend.getByLabel("已有房间码？").fill(initial.room.code);
    await friend.getByRole("button", { name: "加入房间", exact: true }).click();
    await expect(friend.locator(".hero-draft-card")).toHaveCount(4);
    for (let round = 0; round < 8; round++) {
      const before = await Promise.all(tokens.map(t => api(t, "/state")));
      const all = before.flatMap(s => s.data.room.heroOffers);
      expect(new Set(all).size).toBe(8);
      const results = await Promise.all(tokens.map((t, i) => api(t, "/refresh-hero", { slot: round % 4, expectedHero: before[i].data.room.heroOffers[round % 4] })));
      expect(results.map(r => r.status)).toEqual([200, 200]);
      const after = await Promise.all(tokens.map(t => api(t, "/state")));
      expect(new Set(after.flatMap(s => s.data.room.heroOffers)).size).toBe(8);
    }
    const before = (await api(tokens[0], "/state")).data.room.heroOffers;
    const retries = await Promise.all([0, 1].map(() => api(tokens[0], "/refresh-hero", { slot: 0, expectedHero: before[0] })));
    expect(retries.map(r => r.status).sort()).toEqual([200, 400]);
    const first = (await api(tokens[0], "/state")).data.room.heroOffers;
    const second = (await api(tokens[1], "/state")).data.room.heroOffers;
    expect((await api(tokens[1], "/hero", { hero: first[0] })).status).toBe(400);
    await page.reload(); await friend.reload();
    expect(await page.locator(".hero-draft-card").evaluateAll(els => els.map(el => el.getAttribute("data-hero")))).toEqual(first);
    await page.locator(".hero-draft-choose").first().click();
    await friend.locator(".hero-draft-choose").first().click();
    await friend.getByRole("button", { name: "准备好了", exact: true }).click();
    await page.getByRole("button", { name: /开局 · 空位补人机/ }).click();
    await expect(page.locator(".game-table")).toBeVisible();
    await expect(friend.locator(".game-table")).toBeVisible();
    const started = (await api(tokens[0], "/state")).data;
    expect(new Set(started.room.seats.map((s: { hero: string }) => s.hero)).size).toBe(8);
    expect(started.room.seats.slice(0, 2).map((s: { hero: string }) => s.hero)).toEqual([first[0], second[0]]);
  } finally {
    for (const token of tokens) {
      const current = await api(token, "/state");
      if (current.status === 200 && current.data.room) await api(token, "/leave", {});
    }
    await context.close();
  }
});
