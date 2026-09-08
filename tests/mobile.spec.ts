import { test, expect, type Page } from "@playwright/test";
import { createGame, makeMinion, type Game } from "../src/engine";
import { SEASON_CARDS } from "../src/season/catalog";
import { POOL_COPIES } from "../src/data";
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
function fixture() {
  const s = createGame("s14_lich", () => 0.37);
  for (const d of SEASON_CARDS)
    if (s.pool[d.id] === undefined) {
      s.pool[d.id] = POOL_COPIES[d.tier];
      s.season!.initialPool[d.id] = POOL_COPIES[d.tier];
    }
  s.shop.forEach((m) => s.pool[m.id]++);
  s.shop = [];
  const m = makeMinion("s14_BG25_001", false, true);
  s.pool[m.id]--;
  s.shop.push(m);
  return s;
}
async function open(page: Page, s: Game) {
  await page.addInitScript((s) => {
    if (!sessionStorage.getItem("mobile-fixture")) {
      localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(s));
      sessionStorage.setItem("mobile-fixture", "1");
    }
  }, s);
  await page.goto("/");
}
test("phone touch recruit, play, hero target, rotate, freeze, and battle", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, fixture());
  await expect(page.locator(".mobile-arena")).toBeVisible();
  await page.locator(".mobile-shop-cards .minion-card").tap();
  await page.getByRole("button", { name: /招募随从/ }).tap();
  await page.locator(".mobile-hand-cards .minion-card").tap();
  await page.getByRole("button", { name: /打出随从/ }).tap();
  await expect(page.locator(".mobile-board-slot.occupied")).toHaveCount(1);
  await page.getByRole("button", { name: /使用英雄技能/ }).tap();
  await page.locator(".mobile-board-slot.occupied .minion-card").tap();
  await expect(page.locator(".mobile-power")).toBeDisabled();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".mobile-arena")).toBeVisible();
  const bounds = await page.locator(".mobile-end").boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "冻结", exact: true }).tap();
  await expect(page.locator(".mobile-shop")).toHaveClass(/is-frozen/);
  await page.getByRole("button", { name: "结束招募", exact: true }).tap();
  await expect(page.locator(".combat-stage")).toBeVisible();
  await page.getByRole("button", { name: /跳过动画/ }).tap();
  await page.getByRole("button", { name: /返回酒馆/ }).tap();
  await expect(page.locator(".mobile-turn")).toContainText("第 2 回合");
  expect(errors).toEqual([]);
});
test("seven board slots and ten-card hand fit landscape; hand swipes and position controls work", async ({
  page,
}) => {
  const s = fixture();
  s.gold = 10;
  s.tier = 6;
  for (const d of SEASON_CARDS.slice(0, 7)) {
    const m = makeMinion(d.id, false, true);
    s.pool[m.id]--;
    s.board.push(m);
  }
  for (const d of SEASON_CARDS.slice(7, 17)) {
    const m = makeMinion(d.id, false, true);
    s.pool[m.id]--;
    s.hand.push(m);
  }
  for (const d of SEASON_CARDS.slice(17, 22)) {
    const m = makeMinion(d.id, false, true);
    s.pool[m.id]--;
    s.shop.push(m);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await open(page, s);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const selector of [
    ".mobile-shop",
    ".mobile-warband",
    ".mobile-hand",
    ".mobile-dock",
  ]) {
    const b = await page.locator(selector).boundingBox();
    expect(b!.y).toBeGreaterThanOrEqual(0);
    expect(b!.y + b!.height).toBeLessThanOrEqual(390);
  }
  const width = await page
    .locator(".mobile-board-slot")
    .first()
    .evaluate((e) => e.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(44);
  const strip = page.locator(".mobile-hand-cards");
  expect(await strip.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await strip.evaluate((e) => e.scrollTo(e.scrollWidth, 0));
  await expect(strip.locator(".minion-card").last()).toBeInViewport();
  const first = s.board[0].uid;
  await page.locator(".mobile-board-slot .minion-card").first().tap();
  await page.getByRole("button", { name: "右移", exact: true }).tap();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("bobs-tavern-season14-v1")!).board[1]
          .uid,
    ),
  ).toBe(first);
  await page.screenshot({
    path: "/tmp/tavern-mobile-landscape.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/tavern-mobile-portrait.png",
    fullPage: true,
  });
});
test("mode preference persists without resetting game; season powers remain accessible", async ({
  page,
}) => {
  const s = fixture();
  s.turn = 3;
  s.gold = 6;
  await open(page, s);
  await page.getByRole("button", { name: /赛季玩法/ }).tap();
  await page.getByRole("button", { name: /黑暗发现/ }).tap();
  await expect(page.getByRole("dialog")).toContainText("接受这份馈赠");
  await page.locator(".discovery-cards .button").first().tap();
  await page.getByRole("button", { name: "偏好设置", exact: true }).tap();
  await page.getByLabel("界面模式").selectOption("desktop");
  await page.getByRole("button", { name: "关闭", exact: true }).tap();
  await expect(page.locator(".mobile-arena")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".mobile-arena")).toHaveCount(0);
  await expect(page.locator(".game-meta")).toContainText("第 3 回合");
  await expect(page.locator(".hand-cards .gifted-card")).toHaveCount(1);
  await page.getByRole("button", { name: "开启手游模式", exact: true }).tap();
  await expect(page.locator(".mobile-hand-cards .gifted-card")).toHaveCount(1);
});
