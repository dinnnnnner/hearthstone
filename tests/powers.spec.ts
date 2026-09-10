import { test, expect, type Page } from "@playwright/test";
import { createGame, makeMinion, type Game } from "../src/engine";
import { equipPowers } from "../src/season/powers";
const path = process.env.TAVERN_TEST_PATH || "/", saveKey = "bobs-tavern-season14-v1";
async function open(page: Page, s: Game) {
  await page.addInitScript(({ s, saveKey }) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    if (!sessionStorage.getItem("power-fixture")) {
      localStorage.setItem(saveKey, JSON.stringify(s)); sessionStorage.setItem("power-fixture", "yes");
    }
  }, { s, saveKey });
  await page.goto(path);
  await expect(page.locator(".game-table")).toBeVisible();
  await expect(page.locator("#boot-screen")).toHaveCount(0);
}
const saved = (page: Page): Promise<Game> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), saveKey);

test("Finley discovers a real power on phone, reload keeps the choice, and portrait remains Finley", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, createGame("s14_finley", () => 0.37));
  const dialog = page.getByRole("dialog", { name: "冒险出发！" });
  await expect(dialog.locator(".power-choice-card")).toHaveCount(3);
  await expect(dialog.locator("img").first()).toHaveJSProperty("naturalWidth", 320);
  const choices = (await saved(page)).season!.powerChoice!.offers;
  await page.reload();
  expect((await saved(page)).season!.powerChoice!.offers).toEqual(choices);
  await expect(page.locator("#boot-screen")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/tavern-finley-phone.png" });
  await dialog.locator(".power-choice-card").first().click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".hero-name-ribbon")).toContainText("芬利");
  expect((await saved(page)).season!.powers).toEqual([choices[0]]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Genn uses both powers independently on the board, panel and mobile layouts", async ({ page }) => {
  const s = createGame("s14_genn", () => 0.37); s.gold = 10;
  s.board = [makeMinion("s14_BG25_001")];
  equipPowers(s, ["s14_george", "s14_inge"]);
  await open(page, s);
  const orbs = page.locator(".hero-power-orb");
  await expect(orbs).toHaveCount(2);
  await orbs.nth(0).click(); await page.locator(".friendly-row .table-piece").click();
  await expect(orbs.nth(0)).toBeDisabled(); await expect(orbs.nth(1)).toBeEnabled();
  await page.setViewportSize({ width: 844, height: 390 });
  await orbs.nth(1).click(); await page.locator(".friendly-row .table-piece").click();
  await expect(orbs.nth(1)).toContainText("剩余1次");
  await page.screenshot({ path: "/tmp/tavern-genn-landscape.png" });
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await page.getByRole("button", { name: "切换实战棋盘" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".hero-panel .hero-power")).toHaveCount(2);
  await page.getByRole("button", { name: "开启手游模式", exact: true }).click();
  const mobile = page.locator(".mobile-power");
  await expect(mobile).toHaveCount(2);
  await mobile.nth(1).click(); await page.locator(".mobile-board-slot.occupied .minion-card").click();
  await expect(mobile.nth(1)).toBeDisabled();
  await page.reload(); await expect(page.locator(".mobile-power").nth(1)).toBeDisabled();
  expect((await saved(page)).board[0].attack).toBe(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Identity Reveal discovers a new main power and preserves Genn's second power after reload", async ({ page }) => {
  const s = createGame("s14_genn", () => 0.37);
  equipPowers(s, ["s14_millhouse", "s14_inge"]);
  s.hand = [makeMinion("s14_EBG_Spell_037")];
  await open(page, s);
  await page.locator(".table-hand .hand-card-button").click();
  await page.getByRole("button", { name: /施放法术/ }).click();
  const dialog = page.getByRole("dialog", { name: "身份揭晓" });
  await expect(dialog).toBeVisible();
  const choices = (await saved(page)).season!.powerChoice!.offers;
  await page.reload(); await expect(dialog).toBeVisible();
  await dialog.locator(".power-choice-card").first().click();
  await expect(dialog).toBeHidden();
  expect((await saved(page)).season!.powers).toEqual([choices[0], "s14_inge"]);
  await expect(page.locator(".hero-power-orb")).toHaveCount(2);
});

test("online Finley choice is server validated and survives reconnection", async ({ page }) => {
  await page.goto(path);
  await page.getByLabel("你的酒馆昵称").fill("芬利技能验证");
  await page.getByRole("button", { name: "游客进入", exact: true }).click();
  await page.getByLabel("匹配英雄").selectOption("s14_finley");
  await page.getByRole("button", { name: /人机匹配/ }).click();
  try {
    const dialog = page.getByRole("dialog", { name: "冒险出发！" });
    await expect(dialog).toBeVisible(); await page.reload(); await expect(dialog).toBeVisible();
    await dialog.locator(".power-choice-card").first().click();
    await expect(dialog).toBeHidden();
    await page.reload(); await expect(dialog).toBeHidden();
    await expect(page.locator(".hero-name-ribbon")).toContainText("芬利");
  } finally {
    await page.evaluate(async () => {
      const g = JSON.parse(localStorage.getItem("bobs-tavern-guest-v1")!);
      await fetch("/tavern-api/leave", { method: "POST", headers: { Authorization: "Bearer " + g.token, "Content-Type": "application/json" }, body: "{}" });
    });
  }
});
