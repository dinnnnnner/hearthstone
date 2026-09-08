test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    () => (
      localStorage.setItem("bobs-tavern-entry", "practice"),
      localStorage.setItem("bobs-tavern-presentation", "panels")
    ),
  );
});
import { test, expect } from "@playwright/test";
import { createGame, makeMinion, type Game } from "../src/engine";
import { SEASON_CARDS } from "../src/season/catalog";
import { POOL_COPIES } from "../src/data";
const key = "bobs-tavern-season14-v1";
function fixture() {
  const s = createGame("s14_lich", () => 0.37);
  for (const d of SEASON_CARDS)
    if (s.pool[d.id] === undefined) {
      s.pool[d.id] = POOL_COPIES[d.tier];
      s.season!.initialPool[d.id] = POOL_COPIES[d.tier];
    }
  return s;
}
function add(s: Game, id: string, zone: "hand" | "board" = "board") {
  const m = makeMinion("s14_" + id, false, true);
  s.pool[m.id]--;
  s[zone].push(m);
  return m;
}
async function setGame(page: import("@playwright/test").Page, s: Game) {
  await page.addInitScript(
    ({ key, s }) => {
      if (!sessionStorage.getItem("fixture")) {
        localStorage.setItem(key, JSON.stringify(s));
        sessionStorage.setItem("fixture", "yes");
      }
    },
    { key, s },
  );
  await page.goto("/");
}
test("current mode, original card art, catalogue coverage, and persistence", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".version-pill")).toContainText("36.4.2");
  await expect(page.locator(".armor-badge")).toContainText("14");
  await expect(page.locator(".season-bar")).toContainText("黑暗发现");
  await expect(page.locator(".spell-offer")).toHaveCount(1);
  await page.locator(".shop-cards .minion-card").first().click();
  await page.getByRole("button", { name: /招募随从/ }).click();
  await page.locator(".hand-cards .minion-card").first().click();
  await page.getByRole("button", { name: /打出随从/ }).click();
  await page.getByRole("button", { name: /使用英雄技能/ }).click();
  await page.locator(".occupied .minion-card").first().click();
  await expect(page.locator(".power-button")).toContainText("本回合已使用");
  await page.reload();
  await expect(page.locator(".power-button")).toContainText("本回合已使用");
  await page.getByRole("button", { name: "随从图鉴", exact: true }).click();
  await expect(page.locator(".coverage-note")).toContainText("234");
  await page.getByPlaceholder("搜索随从或技能").fill("美味龙虾");
  await expect(page.locator(".collection-item")).toHaveCount(2);
  await page.getByRole("button", { name: /^美味龙虾，/ }).click();
  await page.getByText("查看网上卡面与素材来源").click();
  await expect(page.locator(".card-source img")).toBeVisible();
  expect(
    await page
      .locator(".card-source img")
      .evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
  ).toBe(true);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByPlaceholder("搜索随从或技能").fill("");
  await page.getByRole("button", { name: /酒馆法术 ·/ }).click();
  await expect(page.locator(".collection-item")).toHaveCount(67);
  expect(errors).toEqual([]);
});
test("Activate skill targeting changes stats and disables repeat use", async ({
  page,
}) => {
  const s = fixture();
  add(s, "BG36_345");
  add(s, "BG25_001");
  await setGame(page, s);
  await page.locator(".occupied .minion-card").first().click();
  await page.getByRole("button", { name: /发动技能/ }).click();
  await page.locator(".occupied .minion-card").nth(1).click();
  await expect(page.locator(".occupied .attack").nth(1)).toHaveText("5");
  await page.locator(".occupied .minion-card").first().click();
  await expect(
    page.getByRole("button", { name: /本回合已发动/ }),
  ).toBeDisabled();
});
test("Tavern spell can be bought and cast on a minion", async ({ page }) => {
  const s = fixture();
  add(s, "BG25_001");
  s.season!.spellShop = [makeMinion("s14_BG28_897")];
  await setGame(page, s);
  await page
    .locator(".spell-offer")
    .getByRole("button", { name: /购买/ })
    .click();
  await page.locator(".hand-cards .spell-card").click();
  await page.getByRole("button", { name: /施放法术/ }).click();
  await page.locator(".occupied .minion-card").click();
  await expect(page.locator(".occupied .attack")).toHaveText("4");
  await expect(page.locator(".hand-cards .spell-card")).toHaveCount(0);
});
test("Dark Gift discovery uses three gold and persists the chosen gift", async ({
  page,
}) => {
  const s = fixture();
  s.turn = 3;
  s.gold = 5;
  await setGame(page, s);
  await page
    .locator(".dark-gift-control")
    .getByRole("button", { name: /黑暗发现/ })
    .click();
  await expect(page.getByRole("dialog")).toContainText("接受这份馈赠");
  await expect(
    page.locator(".discovery-cards .gift-note").first(),
  ).toBeVisible();
  await page.locator(".discovery-cards .button").first().click();
  await expect(page.locator(".hand-cards .gifted-card")).toHaveCount(1);
  await expect(page.locator(".dark-gift-control")).toContainText("1 / 3");
  await expect(page.locator(".game-meta .gold-text")).toContainText("2");
});
test("Trinket selection gates play and equipped trinket appears", async ({
  page,
}) => {
  const s = fixture();
  s.turn = 6;
  s.gold = 8;
  s.season!.trinketOffers = [
    "BG36_MagicItem_200",
    "BG36_MagicItem_202",
    "BG36_MagicItem_300",
    "BG36_MagicItem_811",
  ];
  await setGame(page, s);
  await expect(page.locator(".trinket-options")).toBeVisible();
  await page.locator(".trinket-option").filter({ hasText: "冰寒之花" }).click();
  await expect(page.locator(".trinket-options")).not.toBeVisible();
  await expect(page.locator(".trinket-slot.filled")).toContainText("冰寒之花");
});
test("mobile current-season UI has no overflow and can switch back to classic", async ({
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
    .locator(".ruleset-picker")
    .getByRole("button", { name: "经典精选", exact: true })
    .click();
  await page.getByRole("button", { name: /进入酒馆/ }).click();
  await expect(page.locator(".season-bar")).toHaveCount(0);
  await expect(page.locator(".version-pill")).toContainText("经典精选");
});
