import { test, expect } from "@playwright/test";
import { createGame, type Game } from "../src/engine";
import { nguyenPowerEligible } from "../src/season/powers";

test("Nguyen triggers the selected start power now and filters next-turn choices after reload", async ({ page }) => {
  let seed = 22;
  const game = createGame("s14_nguyen", () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  });
  game.season!.powerChoice!.offers = ["s14_vashj", "s14_george"];
  const saveKey = "bobs-tavern-season14-v1";
  await page.addInitScript(({ game, saveKey }) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    if (!sessionStorage.getItem("nguyen-fixture")) {
      localStorage.setItem(saveKey, JSON.stringify(game));
      sessionStorage.setItem("nguyen-fixture", "yes");
    }
  }, { game, saveKey });
  const saved = (): Promise<Game> => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), saveKey);
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  await page.locator(".power-choice-card").first().click();
  await expect(page.locator(".power-choice-modal")).toBeHidden();
  await expect.poll(async () => (await saved()).hand.length).toBe(1);
  await page.getByRole("button", { name: "结束招募", exact: true }).click();
  await page.getByRole("button", { name: /跳过动画/ }).click();
  const handBeforeNextTurn = (await saved()).hand.length;
  await page.getByRole("button", { name: /返回酒馆/ }).click();
  await expect(page.locator(".power-choice-card")).toHaveCount(2);
  const next = await saved();
  expect(next.hand.length).toBe(handBeforeNextTurn);
  const offers = next.season!.powerChoice!.offers;
  expect(offers).not.toContain("s14_vashj");
  expect(offers.every(id => nguyenPowerEligible(next, id))).toBe(true);
  await page.reload();
  await expect(page.locator(".power-choice-card")).toHaveCount(2);
  expect((await saved()).season!.powerChoice!.offers).toEqual(offers);
  await page.locator(".power-choice-card").first().click();
  await expect(page.locator(".power-choice-modal")).toBeHidden();
  expect((await saved()).season!.powers).toEqual([offers[0]]);
});
