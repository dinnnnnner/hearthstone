import { test, expect, chromium, type Page } from "@playwright/test";
const base = process.env.TEST_BASE_URL || "http://localhost:5174";
const route = process.env.TAVERN_TEST_PATH || "/";
async function api(page: Page, path: string, data?: unknown) {
  return page.evaluate(async ({ path, data }) => {
    const guest = JSON.parse(localStorage.getItem("bobs-tavern-guest-v1")!);
    const response = await fetch("/tavern-api" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + guest.token, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
      priority: "high", signal: AbortSignal.timeout(12000),
    });
    return { status: response.status, data: await response.json() };
  }, { path, data });
}
async function waitResources(page: Page, guest: number) {
  const ready = page.getByText("对战资源已就绪", { exact: true });
  const retry = page.getByRole("button", { name: "重试下载", exact: true });
  await expect.poll(async () => await ready.isVisible() || await retry.isVisible(), { timeout: 300000 }).toBe(true);
  if (await retry.isVisible()) {
    console.log(`resource retry for guest ${guest}`);
    await retry.click();
  }
  await expect(ready).toBeVisible({ timeout: 90000 });
}
// Separate runs avoid using sixteen browsers to test an eight-player room.
test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15000 });
for (const sound of ["off", "on"]) {
  test(`eight independent browsers complete two rounds with sound ${sound}`, async () => {
    test.setTimeout(600000);
    const start = Date.now(), errors: string[] = [], audioRequests: string[] = [], events: unknown[] = [];
    const browsers = await Promise.all(Array.from({ length: 8 }, () => chromium.launch()));
    const contexts = await Promise.all(browsers.map(browser => browser.newContext({ baseURL: base })));
    const pages = await Promise.all(contexts.map(c => c.newPage()));
    const heroes = ["s14_lich", "s14_george", "s14_reno", "s14_brann", "s14_nozdormu", "s14_ysera", "s14_patchwerk", "s14_greybough"];
    try {
      // Warm each independent client before the next arrives; gameplay actions below remain concurrent.
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        p.setDefaultTimeout(15000);
        p.setDefaultNavigationTimeout(90000);
        p.on("pageerror", e => errors.push(`${i}: ${e.message}`));
        p.on("response", async r => {
          if (r.url().endsWith("/tavern-api/action")) events.push({ i, time: Date.now() - start, status: r.status(),
            state: await r.json().then(s => ({ error: s.error, phase: s.game?.phase, turn: s.game?.turn,
              ended: s.room?.seats.filter((p: { ended: boolean }) => p.ended).length })).catch(() => null) });
        });
        p.on("request", r => { if (r.url().includes("/audio/")) audioRequests.push(r.url()); });
        await p.addInitScript(value => localStorage.setItem("bobs-tavern-sound", value), sound);
        await p.goto(route, { waitUntil: "domcontentloaded" });
        await p.getByLabel("你的酒馆昵称").fill("满房验证" + i);
        await p.getByRole("button", { name: "游客进入", exact: true }).click();
        await expect(p.getByRole("heading", { name: "人机匹配" })).toBeVisible({ timeout: 20000 });
        await waitResources(p, i);
        console.log(`guest ${i} resources ready after ${Date.now() - start}ms`);
      }
      console.log(`sound ${sound}: all eight logged in after ${Date.now() - start}ms`);
      await waitResources(pages[0], 0);
      await pages[0].getByRole("radio", { name: /训练模式/ }).check();
      await pages[0].getByRole("button", { name: /创建好友房/ }).click({ timeout: 180000 });
      const code = await pages[0].locator(".room-code strong").innerText();
      for (let i = 1; i < 8; i++) {
        const p = pages[i];
        await waitResources(p, i);
        await p.getByLabel("已有房间码？").fill(code);
        await p.getByRole("button", { name: "加入房间", exact: false }).click({ timeout: 180000 });
        await p.getByLabel("房间英雄").selectOption(heroes[i]);
        await p.getByRole("button", { name: "准备好了", exact: false }).click({ timeout: 90000 });
        console.log(`guest ${i} ready after ${Date.now() - start}ms`);
        await expect(p.getByRole("button", { name: "取消准备", exact: false })).toBeEnabled();
      }
      await expect(pages[0].getByRole("button", { name: /开局 ·/ })).toBeEnabled({ timeout: 15000 });
      await pages[0].getByRole("button", { name: /开局 ·/ }).click();
      await Promise.all(pages.map(p => expect(p.locator(".game-table")).toBeVisible({ timeout: 15000 })));
      console.log(`sound ${sound}: all eight entered in ${Date.now() - start}ms`);
      // Reconnect from the hall without having observed the waiting-room snapshot.
      await pages[7].evaluate(() => sessionStorage.setItem("tavern-online-view", "hall"));
      await pages[7].reload();
      await expect(pages[7].locator(".game-table")).toBeVisible({ timeout: 15000 });
      // An intentional hall visit in an active game must remain available.
      await pages[7].getByRole("button", { name: "对战大厅", exact: true }).click();
      await expect(pages[7].getByRole("heading", { name: "对局进行中" })).toBeVisible();
      await pages[7].getByRole("button", { name: "返回对局", exact: false }).click();
      await Promise.all(pages.map(async p => {
        await p.locator(".tavern-row .table-piece").first().click();
        await p.getByRole("button", { name: /招募随从/ }).click();
        await expect(p.locator(".table-hand .hand-card-button")).toHaveCount(1);
        await p.locator(".table-hand .hand-card-button").click();
        await p.getByRole("button", { name: /打出随从/ }).click();
        if (await p.locator(".target-banner").isVisible())
          await p.locator(".friendly-row .table-piece").first().click();
        await expect(p.locator(".friendly-row .table-piece").first()).toBeVisible();
      }));
      const downloadsBeforeCombat = audioRequests.length;
      for (let turn = 1; turn <= 2; turn++) {
        const roundStart = Date.now();
        await Promise.all(pages.map(p => p.getByRole("button", { name: "结束招募", exact: true }).click()));
        await Promise.all(pages.map(p => expect(p.locator(".combat-table")).toBeVisible({ timeout: 10000 })));
        const states = await Promise.all(pages.map(p => api(p, "/state")));
        for (const state of states) {
          expect(state.status).toBe(200);
          expect(state.data.room.seats.filter((s: { bot: boolean }) => s.bot)).toHaveLength(0);
          expect(state.data.game.phase).toBe("combat");
          expect(state.data.game.battle.frames[0].allies.length).toBeGreaterThan(0);
          const enemy = states.find(s => s.data.guest.name === state.data.game.battle.opponent)!;
          expect(state.data.game.battle.frames[0].allies).toEqual(enemy.data.game.battle.frames[0].enemies);
        }
        await Promise.all(pages.map(async p => {
          await p.getByRole("button", { name: /跳过动画/ }).click();
          await p.getByRole("button", { name: /返回酒馆/ }).click();
        }));
        await Promise.all(pages.map(p => expect(p.locator(".round-medallion")).toContainText(`第 ${turn + 1} 回合`, { timeout: 10000 })));
        console.log(`sound ${sound}: round ${turn} combat and return ${Date.now() - roundStart}ms`);
      }
      expect(errors).toEqual([]);
      for (const p of pages) await expect(p.getByRole("alert")).toHaveCount(0);
      expect(audioRequests.length).toBeGreaterThan(0);
      expect(audioRequests.length).toBe(downloadsBeforeCombat);
    } catch (error) {
      console.log("errors", errors);
      console.log("events", JSON.stringify(events));
      console.log("diagnostics", JSON.stringify(await Promise.all(pages.map(async p => ({
        state: await api(p, "/state").then(r => ({ phase: r.data.game?.phase, turn: r.data.game?.turn,
          seats: r.data.room?.seats.map((s: { name: string; ended: boolean; continued: boolean }) => ({ name: s.name, ended: s.ended, continued: s.continued })) })).catch(() => null),
        text: await p.locator("body").innerText().then(s => s.slice(-800)).catch(() => "closed"),
      })))));
      throw error;
    } finally {
      await Promise.all(pages.map(p => api(p, "/leave", {}).catch(() => {})));
      await Promise.all(contexts.map(c => c.close()));
      await Promise.all(browsers.map(browser => browser.close()));
    }
  });
}
