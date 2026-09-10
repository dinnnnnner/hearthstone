import { test, expect, type Page } from "@playwright/test";
const base = process.env.TEST_BASE_URL || "http://localhost:5174";
const route = process.env.TAVERN_TEST_PATH || "/";
async function login(page: Page, name: string) {
  await page.goto(route);
  await page.getByLabel("你的酒馆昵称").fill(name);
  await page.getByRole("button", { name: "游客进入", exact: true }).click();
  await expect(page.getByRole("heading", { name: "人机匹配" })).toBeVisible();
}
async function api(page: Page, path: string, data?: unknown) {
  return page.evaluate(
    async ({ path, data }) => {
      const guest = JSON.parse(localStorage.getItem("bobs-tavern-guest-v1")!);
      const res = await fetch("/tavern-api" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + guest.token,
          "Content-Type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: res.status, data: await res.json() };
    },
    { path, data },
  );
}
async function choosePower(page: Page) {
  const state = await api(page, "/state");
  if (state.data.game?.season?.powerChoice) {
    await page.locator(".power-choice-card").first().click();
    await expect(page.locator(".power-choice-modal")).toBeHidden();
  }
}
async function buyPlay(page: Page) {
  await choosePower(page);
  await page.locator(".tavern-row .table-piece").first().click();
  await page.getByRole("button", { name: /招募随从/ }).click();
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(1);
  await page.locator(".table-hand .hand-card-button").click();
  await page.getByRole("button", { name: /打出随从/ }).click();
  const target = page.locator(".target-banner");
  if (await target.isVisible())
    await page.locator(".friendly-row .table-piece").first().click();
  await expect(
    page.locator(".friendly-row .table-piece").first(),
  ).toBeVisible();
}
test("guest identity persists and AI matchmaking creates a real eight-seat game without overwriting local practice", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "游客验证");
  const token = await page.evaluate(() =>
    localStorage.getItem("bobs-tavern-guest-v1"),
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "人机匹配" })).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("bobs-tavern-guest-v1")),
  ).toBe(token);
  await page.getByRole("button", { name: /人机匹配/ }).click();
  await expect(page.locator(".game-table")).toBeVisible();
  const state = await api(page, "/state");
  expect(state.data.room.seats).toHaveLength(8);
  expect(state.data.room.seats.filter((x: any) => x.bot)).toHaveLength(7);
  await buyPlay(page);
  await page.getByRole("button", { name: "结束招募", exact: true }).click();
  await expect(page.locator(".combat-table")).toBeVisible();
  await page.getByRole("button", { name: /跳过动画/ }).click();
  await page.getByRole("button", { name: /返回酒馆/ }).click();
  await expect(page.locator(".round-medallion")).toContainText("第 2 回合");
  await page.reload();
  await expect(page.locator(".round-medallion")).toContainText("第 2 回合");
  expect(
    await page.evaluate(() => localStorage.getItem("bobs-tavern-season14-v1")),
  ).toBeNull();
  await page.getByRole("button", { name: "对战大厅", exact: true }).click();
  await expect(page.getByRole("heading", { name: "对局进行中" })).toBeVisible();
  await api(page, "/leave", {});
  expect(errors).toEqual([]);
});
test("two guest browsers join, ready, synchronize rounds, reconnect and cannot operate each other’s cards", async ({
  page,
  browser,
}) => {
  const other = await browser.newContext({ baseURL: base }),
    friend = await other.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  friend.on("pageerror", (e) => errors.push(e.message));
  try {
    await login(page, "房主测试");
    await page.getByRole("button", { name: /创建好友房/ }).click();
    const code = await page.locator(".room-code strong").innerText();
    await login(friend, "好友测试");
    await friend.getByLabel("已有房间码？").fill("ZZZZZZ");
    await friend
      .getByRole("button", { name: "加入房间", exact: false })
      .click();
    await expect(friend.getByRole("alert")).toContainText("房间");
    await friend.getByLabel("已有房间码？").fill(code);
    await friend
      .getByRole("button", { name: "加入房间", exact: false })
      .click();
    await expect(
      friend.locator(".room-seats .room-seat:not(.empty)"),
    ).toHaveCount(2);
    await expect(page.getByRole("button", { name: /开局 ·/ })).toBeDisabled();
    await friend
      .getByRole("button", { name: "准备好了", exact: false })
      .click();
    await expect(page.getByRole("button", { name: /开局 ·/ })).toBeEnabled();
    await page.getByRole("button", { name: /开局 ·/ }).click();
    await expect(page.locator(".game-table")).toBeVisible();
    await expect(friend.locator(".game-table")).toBeVisible();
    const host = await api(page, "/state"),
      guest = await api(friend, "/state");
    expect(guest.data.game.opponents.every((o: any) => !o.board.length)).toBe(
      true,
    );
    const bad = await api(friend, "/action", {
      turn: 1,
      requestId: "foreign-" + Date.now(),
      action: { type: "buy", uid: host.data.game.shop[0].uid },
    });
    expect(bad.status).toBe(400);
    await buyPlay(page);
    await buyPlay(friend);
    await page.getByRole("button", { name: "结束招募", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "等待其他玩家" }),
    ).toBeDisabled();
    await friend.getByRole("button", { name: "结束招募", exact: true }).click();
    await expect(page.locator(".combat-table")).toBeVisible();
    await expect(friend.locator(".combat-table")).toBeVisible();
    await page.getByRole("button", { name: /跳过动画/ }).click();
    await friend.getByRole("button", { name: /跳过动画/ }).click();
    const cachedReply = page.waitForResponse(
      (r) =>
        r.url().endsWith("/tavern-api/action") &&
        !!r.request().headers()["x-tavern-battle"] &&
        r.status() === 200,
    );
    await page.getByRole("button", { name: /返回酒馆/ }).click();
    expect((await (await cachedReply).json()).game.battle.frames).toHaveLength(
      0,
    );
    await friend.getByRole("button", { name: /返回酒馆/ }).click();
    await expect(page.locator(".round-medallion")).toContainText("第 2 回合");
    await expect(friend.locator(".round-medallion")).toContainText("第 2 回合");
    await friend.reload();
    await expect(friend.locator(".round-medallion")).toContainText("第 2 回合");
    expect(errors).toEqual([]);
  } finally {
    await api(page, "/leave", {}).catch(() => {});
    await api(friend, "/leave", {}).catch(() => {});
    await other.close();
  }
});
test("phone lobby fits portrait and landscape and preserves its guest room", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "手机旅人");
  await page.screenshot({
    path: "/tmp/tavern-online-phone.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /创建好友房/ }).click();
  for (const [width, height] of [
    [390, 844],
    [844, 390],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByRole("button", { name: /开局 ·/ })).toBeVisible();
  }
  await api(page, "/leave", {});
});
test("eight guest browsers fill one room and get synchronized combat without bots", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const contexts = await Promise.all(
      Array.from({ length: 8 }, () => browser.newContext({ baseURL: base })),
    ),
    pages = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    for (let i = 0; i < 8; i++) await login(pages[i], "满房验证" + i);
    await pages[0].getByRole("button", { name: /创建好友房/ }).click();
    const code = await pages[0].locator(".room-code strong").innerText();
    for (const p of pages.slice(1)) {
      await p.getByLabel("已有房间码？").fill(code);
      await p.getByRole("button", { name: "加入房间", exact: false }).click();
      await p.getByRole("button", { name: "准备好了", exact: false }).click();
    }
    await expect(pages[0].locator(".room-seat:not(.empty)")).toHaveCount(8);
    await expect(
      pages[0].getByRole("button", { name: /开局 ·/ }),
    ).toBeEnabled();
    await pages[0].getByRole("button", { name: /开局 ·/ }).click();
    for (const p of pages) {
      await expect(p.locator(".game-table")).toBeVisible();
      await choosePower(p);
      await p.getByRole("button", { name: "结束招募", exact: true }).click();
    }
    for (const p of pages)
      await expect(p.locator(".combat-table")).toBeVisible();
    const states = await Promise.all(pages.map((p) => api(p, "/state")));
    expect(states[0].data.room.seats.filter((s: any) => s.bot)).toHaveLength(0);
    const a = states[0].data.game,
      b = states[7].data.game;
    expect(a.battle.frames[0].allies).toEqual(b.battle.frames[0].enemies);
    expect(a.battle.result).toBe("tie");
  } finally {
    for (const p of pages) await api(p, "/leave", {}).catch(() => {});
    await Promise.all(contexts.map((c) => c.close()));
  }
});
