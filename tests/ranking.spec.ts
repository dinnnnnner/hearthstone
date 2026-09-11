import { test, expect } from "@playwright/test";
import { createGame, makeMinion } from "../src/engine";

for (const mobile of [false, true]) test(`health ranking includes self and initial armor but does not rebound after armor spells (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const game = createGame("s14_lich", () => .37);
  game.turn = 4; game.health = 20; game.season!.armor = 0;
  game.board = []; game.hand = [makeMinion("s14_BG28_500")];
  for (const [i, o] of game.opponents.entries()) { o.name = "对手" + i; o.health = 10; o.armor = 0; o.board = []; }
  Object.assign(game.opponents[0], { name: "法术护甲", health: 19, armor: 5, spellArmor: 5, tier: 6 });
  Object.assign(game.opponents[1], { name: "初始护甲", health: 18, armor: 4 });
  Object.assign(game.opponents[2], { name: "高血量", health: 25 });
  Object.assign(game.opponents[6], { name: "已淘汰", health: 0, armor: 100 });
  game.opponents[0].board = Array.from({ length: 7 }, () => makeMinion("s14_BG25_001"));
  game.nextOpponent = 0;
  await page.addInitScript(game => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    if (!sessionStorage.getItem("ranking-fixture")) {
      localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
      sessionStorage.setItem("ranking-fixture", "yes");
    }
  }, game);
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  const rail = page.getByLabel("对局英雄");
  const self = rail.locator(".rail-self");
  const names = () => rail.locator("[data-rank]").evaluateAll(els => els.map(el => el.getAttribute("aria-label")!.split("，")[0]));
  await expect.poll(names).toEqual(["高血量", "初始护甲", "你", "法术护甲", "对手3", "对手4", "对手5", "已淘汰"]);
  await expect(self).toHaveAttribute("data-rank", "3");
  await rail.getByRole("button", { name: /^法术护甲，/ }).click();
  await expect(page.getByRole("region", { name: "对手战绩" })).toContainText("法术护甲");
  await page.getByRole("button", { name: "关闭对手信息" }).click();
  await page.locator(".table-hand .hand-card-button").click();
  await page.getByRole("button", { name: /施放法术/ }).click();
  await expect(self).toHaveAttribute("data-rank", "3");
  await page.reload();
  await expect(self).toHaveAttribute("data-rank", "3");
  await expect(page.locator("#boot-screen")).toHaveCount(0);
  await page.screenshot({ path: `/tmp/ranking-${mobile ? "mobile" : "desktop"}.png` });
  await page.getByRole("button", { name: "结束招募", exact: true }).click();
  await page.getByRole("button", { name: /跳过动画/ }).click();
  await page.getByRole("button", { name: /返回酒馆/ }).click();
  await expect(self).toHaveAttribute("data-rank", "4");
});
