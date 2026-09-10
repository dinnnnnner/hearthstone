import { test, expect, type Page } from "@playwright/test";
import { createGame, makeMinion, type Game } from "../src/engine";
const saveKey = "bobs-tavern-season14-v1";
async function open(page: Page, s: Game) {
  await page.addInitScript(({ s, saveKey }) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    if (!sessionStorage.getItem("refresh-fixture")) {
      localStorage.setItem(saveKey, JSON.stringify(s));
      sessionStorage.setItem("refresh-fixture", "yes");
    }
  }, { s, saveKey });
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  await expect(page.locator(".game-table")).toBeVisible();
}
async function saved(page: Page): Promise<Game> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), saveKey);
}
test("zero-gold health refresh shows the payment and available charges in all layouts and persists", async ({ page }) => {
  const s = createGame("s14_lich", () => 0.37);
  s.gold = 0; s.season!.armor = 0;
  s.board = [makeMinion("s14_BG26_524")];
  await open(page, s);
  const refresh = page.getByRole("button", { name: "刷新酒馆", exact: true });
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveAttribute("title", "消耗1点生命，剩余2次");
  await expect(refresh.locator(".refresh-health-price")).toBeVisible();
  await refresh.click();
  await expect.poll(async () => (await saved(page)).health).toBe(29);
  await expect(refresh).toHaveAttribute("title", "消耗1点生命，剩余1次");
  await page.reload();
  await expect(refresh).toBeEnabled();
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await page.getByRole("button", { name: "切换实战棋盘" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: /^刷新.*余1次$/ })).toBeEnabled();
  await page.getByRole("button", { name: "开启手游模式", exact: true }).click();
  const mobileRefresh = page.getByRole("button", { name: /^刷新.*余1次$/ });
  await expect(mobileRefresh).toBeEnabled();
  await mobileRefresh.click();
  await expect.poll(async () => (await saved(page)).health).toBe(28);
  expect((await saved(page)).gold).toBe(0);
  await expect(page.getByRole("button", { name: /^刷新.*1$/ })).toBeDisabled();
});
test("taunt, shield, reborn, poison and deathrattle remain distinct and do not intercept selection", async ({ page }) => {
  const s = createGame("s14_lich", () => 0.37);
  s.board = Array.from({ length: 7 }, () => makeMinion("s14_BG25_001"));
  s.board[0].keywords = ["嘲讽"];
  s.board[1].keywords = ["圣盾"];
  s.board[2].keywords = ["嘲讽", "圣盾"];
  s.board[3].keywords = ["复生"];
  s.board[4].keywords = ["烈毒"];
  s.board[5].keywords = ["风怒"];
  s.board[6].keywords = ["嘲讽", "圣盾", "复生", "烈毒"];
  s.board[6].extraAbilities = [{ event: "death", op: "summon", id: "BG25_001", amount: 1 }];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, s);
  const board = page.locator(".friendly-row");
  await expect(board.locator(".taunt-guard")).toHaveCount(3);
  await expect(board.locator(".divine-shield")).toHaveCount(3);
  await expect(board.locator(".reborn-badge")).toHaveCount(2);
  await expect(board.locator(".poison-badge")).toHaveCount(2);
  await expect(board.locator(".deathrattle-badge")).toHaveCount(1);
  await expect(board.locator(".windfury-badge")).toHaveCount(1);
  await board.locator(".table-piece").nth(6).click();
  await expect(page.getByRole("button", { name: /出售随从/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/tmp/tavern-keywords-desktop.png" });
  for (const [width, height] of [[390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await board.locator(".table-piece").nth(2).click();
    await expect(page.getByRole("button", { name: /出售随从/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `/tmp/tavern-keywords-${width}.png` });
  }
});
