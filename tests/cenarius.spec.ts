import { test, expect } from "@playwright/test";
import { createGame } from "../src/engine";

test("Wisdom of Ancients pays extra gold next turn and keeps the bonus after reload", async ({ page }) => {
  const key = "bobs-tavern-season14-v1";
  await page.addInitScript(({ game, key }) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    if (!sessionStorage.getItem("cenarius-fixture")) {
      localStorage.setItem(key, JSON.stringify(game));
      sessionStorage.setItem("cenarius-fixture", "yes");
    }
  }, { game: createGame("s14_cenarius", () => .37), key });
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  const power = page.locator(".hero-power-orb");
  await expect(power).toContainText("古树的智慧");
  await power.click();
  await expect(power).toBeDisabled();
  await expect(page.locator(".board-gold strong")).toHaveText(/0\s*\/\s*11/);
  await page.reload();
  await expect(power).toBeDisabled();
  for (const [turn, coins] of [[2, 5], [3, 7]]) {
    await page.getByRole("button", { name: "结束招募", exact: true }).click();
    await expect(page.locator(".combat-table")).toBeVisible();
    await page.getByRole("button", { name: /跳过动画/ }).click();
    await page.getByRole("button", { name: /返回酒馆/ }).click();
    await expect(page.locator(".round-medallion")).toContainText(`第 ${turn} 回合`);
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).gold, key)).toBe(coins);
    if (turn === 2) await power.click();
  }
});
