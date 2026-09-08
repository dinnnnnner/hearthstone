import { test, expect, type Page } from "@playwright/test";
import { createGame, makeMinion, type Game } from "../src/engine";
const path = process.env.TAVERN_TEST_PATH || "/";
const saveKey = "bobs-tavern-season14-v1";
async function open(page: Page, hero: string, turn = 1) {
  const s = createGame("s14_" + hero, () => 0.37);
  s.turn = turn;
  const m = makeMinion("s14_BG25_001");
  s.board = [m];
  await page.addInitScript(({ s, saveKey }) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    if (!sessionStorage.getItem("hero-fixture")) {
      localStorage.setItem(saveKey, JSON.stringify(s));
      sessionStorage.setItem("hero-fixture", "yes");
    }
  }, { s, saveKey });
  await page.goto(path);
  await expect(page.locator(".game-table")).toBeVisible();
  return s;
}
async function saved(page: Page): Promise<Game> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), saveKey);
}
test("Blackthorn button permits a second use after reload and then disables", async ({ page }) => {
  await open(page, "blackthorn");
  const power = page.locator(".hero-power-orb");
  await power.click();
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(2);
  await expect(power).toBeEnabled();
  await expect(power).toContainText("剩余1次");
  await page.reload();
  await power.click();
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(4);
  await expect(power).toBeDisabled();
});
test("Inge can target the shop and the board on mobile with visible charge and stat labels", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const initial = await open(page, "inge", 2);
  const power = page.locator(".hero-power-orb");
  await expect(power).toContainText("生命值 +1");
  await power.click();
  await page.locator(".tavern-row .table-piece").first().click();
  await expect.poll(async () => (await saved(page)).shop[0].health).toBe(initial.shop[0].health + 1);
  await power.click();
  await page.locator(".friendly-row .table-piece").click();
  await expect.poll(async () => (await saved(page)).board[0].health).toBe(initial.board[0].health + 1);
  await expect(power).toBeDisabled();
  await page.screenshot({ path: "/tmp/tavern-heroes-phone.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("Reno rejects shop targets and his golden minion and once-per-game limit survive reload", async ({ page }) => {
  await open(page, "reno");
  const power = page.locator(".hero-power-orb");
  await power.click();
  await page.locator(".tavern-row .table-piece").first().click();
  await expect(page.locator(".target-banner")).toBeVisible();
  expect((await saved(page)).season!.heroPowerUses).toBe(0);
  await page.locator(".friendly-row .table-piece").click();
  await expect(power).toBeDisabled();
  await expect(power).toContainText("本局已使用");
  await page.reload();
  await expect(power).toBeDisabled();
  expect((await saved(page)).board[0].golden).toBe(true);
  expect((await saved(page)).rewards).toHaveLength(0);
});
test("Elise shows her increased actual cost while the once-per-turn action is spent", async ({ page }) => {
  await open(page, "elise");
  const power = page.locator(".hero-power-orb");
  await expect(power.locator("b")).toHaveText("1");
  await power.click();
  await expect.poll(async () => (await saved(page)).discovery.length).toBeGreaterThan(0);
  await expect(power.locator("b")).toHaveText("2");
  await expect(power).toBeDisabled();
});
test("new heroes appear online and Xyrella uses the server skill to acquire a 2/2", async ({ page }) => {
  await page.goto(path);
  await page.getByLabel("你的酒馆昵称").fill("英雄验证");
  await page.getByRole("button", { name: "游客进入", exact: true }).click();
  const select = page.getByLabel("匹配英雄");
  await expect(select.locator("option")).toHaveCount(19);
  await select.selectOption("s14_xyrella");
  await page.getByRole("button", { name: /人机匹配/ }).click();
  await expect(page.locator(".game-table")).toBeVisible();
  try {
    await page.getByRole("button", { name: "使用英雄技能：亲见圣光", exact: true }).click();
    await page.locator(".tavern-row .table-piece").first().click();
    await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(1);
    const state = await page.evaluate(async () => {
      const guest = JSON.parse(localStorage.getItem("bobs-tavern-guest-v1")!);
      return (await fetch("/tavern-api/state", { headers: { Authorization: "Bearer " + guest.token } })).json();
    });
    expect(state.game.hero).toBe("s14_xyrella");
    expect(state.game.hand[0].attack).toBe(2);
    expect(state.game.hand[0].health).toBe(2);
    expect(state.game.gold).toBe(1);
    await page.screenshot({ path: "/tmp/tavern-heroes-online.png" });
  } finally {
    await page.evaluate(async () => {
      const guest = JSON.parse(localStorage.getItem("bobs-tavern-guest-v1")!);
      await fetch("/tavern-api/leave", { method: "POST", headers: { Authorization: "Bearer " + guest.token, "Content-Type": "application/json" }, body: "{}" });
    });
  }
});


test("Millhouse refresh shows two coins and disables at one coin in both legacy layouts", async ({ page }) => {
  await open(page, "millhouse");
  await page.locator(".tavern-row .table-piece").first().dblclick();
  await expect.poll(async () => (await saved(page)).gold).toBe(1);
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await page.getByRole("button", { name: "切换实战棋盘" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: /^刷新.*2$/ })).toBeDisabled();
  await expect(page.locator(".buy-hint").first()).toContainText("2");
  await expect(page.locator(".panel-title .sub-label")).toContainText("2");
  await page.getByRole("button", { name: "开启手游模式", exact: true }).click();
  await expect(page.locator(".mobile-arena")).toBeVisible();
  await expect(page.getByRole("button", { name: /^刷新.*2$/ })).toBeDisabled();
});
