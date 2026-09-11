import { test, expect } from "@playwright/test";
import { createGame, makeMinion, type Game } from "../src/engine";

for (const golden of [false, true]) test(`Flighty Scout summons a ${golden ? "golden" : "normal"} combat copy and keeps the original in hand`, async ({ page }) => {
  const game = createGame("s14_lich", () => .37);
  const scout = makeMinion("s14_BG32_330", golden);
  scout.attack = 23; scout.health = 31;
  game.hand = [scout]; game.board = [];
  game.opponents[game.nextOpponent].board = [];
  await page.addInitScript(game => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
  }, game);
  const saved = (): Promise<Game> => page.evaluate(() => JSON.parse(localStorage.getItem("bobs-tavern-season14-v1")!));
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  await page.getByRole("button", { name: "结束招募", exact: true }).click();
  const combat = await saved();
  const units = combat.battle!.frames.find(f => f.text === "战斗开始技能结算")!.allies;
  expect(units).toHaveLength(1);
  expect(units[0]).toMatchObject({ id: scout.id, golden, attack: 23 * (golden ? 2 : 1), health: 31 * (golden ? 2 : 1), copies: {} });
  expect(units[0].uid).not.toBe(scout.uid);
  expect(combat.hand).toEqual([scout]);
  await expect.poll(() => page.locator(".friendly-row .table-piece").evaluateAll(
    elements => elements.map(el => el.getAttribute("data-piece-id")),
  )).toEqual([units[0].uid]);
  await page.getByRole("button", { name: /跳过动画/ }).click();
  await page.getByRole("button", { name: /返回酒馆/ }).click();
  const returned = await saved();
  expect(returned.board).toEqual([]);
  expect(returned.hand).toMatchObject([scout]);
});
