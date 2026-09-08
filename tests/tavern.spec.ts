import { test, expect } from "@playwright/test";
import { createGame, makeMinion } from "../src/engine";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (s) => {
      if (!sessionStorage.getItem("classic-fixture")) {
        localStorage.setItem("bobs-tavern-play-mode", "desktop");
        localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(s));
        sessionStorage.setItem("classic-fixture", "yes");
      }
    },
    createGame("lich", () => 0.15),
  );
});

test("buy, play, freeze, combat, hero power, and saved progress", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page).toHaveTitle(/鲍勃的酒馆/);
  await expect(page.locator(".shop-cards .minion-card")).toHaveCount(3);
  await page.locator(".shop-cards .minion-card").first().click();
  await page.getByRole("button", { name: "招募随从", exact: false }).click();
  await expect(page.locator(".hand-cards .minion-card")).toHaveCount(1);
  await page.locator(".hand-cards .minion-card").click();
  await page.getByRole("button", { name: "打出随从", exact: false }).click();
  await expect(page.locator(".hand-cards .minion-card")).toHaveCount(0);
  await expect(page.locator(".occupied")).not.toHaveCount(0);
  await page.getByRole("button", { name: "冻结", exact: false }).click();
  const ids = await page.locator(".shop-cards .minion-card").allTextContents();
  await page.getByRole("button", { name: "结束招募", exact: false }).click();
  await expect(page.locator(".combat-stage")).toBeVisible();
  await page.getByRole("button", { name: "跳过动画", exact: false }).click();
  await page.getByRole("button", { name: "返回酒馆", exact: false }).click();
  await expect(page.locator(".game-meta")).toContainText("第 2 回合");
  expect(
    await page.locator(".shop-cards .minion-card").allTextContents(),
  ).toEqual(expect.arrayContaining(ids));
  await page
    .getByRole("button", { name: "使用英雄技能", exact: false })
    .click();
  await page.locator(".occupied .minion-card").first().click();
  await expect(
    page.getByRole("button", { name: "本回合已使用", exact: false }),
  ).toBeDisabled();
  const before = await page.evaluate(() =>
    localStorage.getItem("bobs-tavern-season14-v1"),
  );
  await page.reload();
  expect(
    await page.evaluate(() => localStorage.getItem("bobs-tavern-season14-v1")),
  ).toBe(before);
  await page.getByRole("button", { name: "随从图鉴", exact: true }).click();
  await page.getByPlaceholder("搜索随从或技能").fill("铜须");
  await expect(page.locator(".collection-item")).toHaveCount(1);
  await expect(page.locator(".collection-item")).toContainText("布莱恩·铜须");
  await page.getByRole("button", { name: "英雄图鉴", exact: true }).click();
  await expect(page.locator(".hero-collection-card")).toHaveCount(8);
  await page.getByRole("button", { name: "对局记录", exact: true }).click();
  await expect(page.locator(".history-table tbody tr")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("triple through the UI preserves buffs and allows discovery", async ({
  page,
}) => {
  const s = createGame("lich", () => 0.3);
  s.shop.forEach((m) => s.pool[m.id]++);
  s.shop = [];
  const a = makeMinion("BOT_445", false, true);
  a.attack += 4;
  s.board.push(a);
  s.pool[a.id]--;
  const b = makeMinion("BOT_445", false, true);
  s.hand.push(b);
  s.pool[b.id]--;
  const c = makeMinion("BOT_445", false, true);
  s.shop.push(c);
  s.pool[c.id]--;
  await page.addInitScript(
    (s) => localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(s)),
    s,
  );
  await page.goto("/");
  await page.locator(".shop-cards .minion-card").click();
  await page.getByRole("button", { name: "招募随从", exact: false }).click();
  await expect(page.locator(".hand-cards .golden")).toHaveCount(1);
  await expect(page.locator(".hand-cards .attack")).toHaveText("6");
  await page.locator(".hand-cards .golden").click();
  await page.getByRole("button", { name: "打出随从", exact: false }).click();
  await page.getByRole("button", { name: "三连奖励", exact: false }).click();
  await expect(page.locator(".discovery-cards .minion-card")).toHaveCount(3);
  await page.locator(".discovery-cards .button").first().click();
  await expect(page.locator(".discovery-cards")).not.toBeVisible();
  await expect(page.locator(".hand-cards .minion-card")).toHaveCount(1);
});

test("mobile has no page overflow, navigation and hero selection work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "新对局", exact: true }).click();
  await page
    .locator(".hero-picker button")
    .filter({ hasText: "帕奇维克" })
    .click();
  await page.getByRole("button", { name: "进入酒馆", exact: false }).click();
  await expect(page.locator(".hero-panel>h3")).toHaveText("帕奇维克");
  await expect(page.locator(".hero-health")).toContainText("60");
  await page.getByRole("button", { name: "随从图鉴", exact: true }).click();
  await page.getByRole("button", { name: "6 星", exact: true }).click();
  await expect(page.locator(".collection-item")).toHaveCount(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
