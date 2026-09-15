import { test, expect } from "@playwright/test";
import { makeMinion, type Game } from "../src/engine";
import { createSeason } from "../src/season/engine";
import { getDef } from "../src/data";

test("an existing Spitescale Special in a lobby without Naga visibly gives three Spellcraft cards", async ({ page }) => {
  const key = "bobs-tavern-season14-v1";
  const game = createSeason("s14_lich", () => .37, { tribes: ["野兽", "恶魔", "龙", "机械", "亡灵"] });
  game.hand = [makeMinion("s14_BG28_606")];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ game, key }) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    localStorage.setItem(key, JSON.stringify(game));
  }, { game, key });
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  await page.locator(".table-hand .hand-card-button").filter({ hasText: "恶鳞套餐" }).click();
  await page.getByRole("button", { name: "施放法术", exact: true }).click();
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(3);
  const state: Game = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
  expect(state.hand).toHaveLength(3);
  for (const card of state.hand) expect(getDef(card.id).spellSchool).toBe("SPELLCRAFT");
  expect(errors).toEqual([]);
});
