import { test, expect } from "@playwright/test";
import { act, createGame, makeMinion } from "../src/engine";
const path = process.env.TAVERN_TEST_PATH || "/";
const saveKey = "bobs-tavern-season14-v1";

for (const [width, height] of [[1440, 1000], [390, 844]]) {
  test(`Choose One resolves Balinda's golden repeats and survives reload at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    const game = createGame("s14_lich", () => .37);
    const balinda = makeMinion("s14_BG35_883", true), target = makeMinion("s14_BG25_001"), spell = makeMinion("s14_BG31_880");
    game.board = [balinda, target]; game.hand = [spell];
    const pending = act(game, { type: "cast", uid: spell.uid }, () => .37).state;
    await page.addInitScript(({ pending, saveKey }) => {
      localStorage.setItem("bobs-tavern-entry", "practice");
      localStorage.setItem("bobs-tavern-sound", "off");
      if (!sessionStorage.getItem("expanded-fixture")) {
        localStorage.setItem(saveKey, JSON.stringify(pending)); sessionStorage.setItem("expanded-fixture", "yes");
      }
    }, { pending, saveKey });
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "抉择，选择一项效果" })).toBeVisible();
    await page.getByRole("button", { name: "选择效果：联盟重锤" }).click();
    await expect(page.locator(".choice-targets")).toBeVisible();
    await expect(page.locator("#boot-screen")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/tavern-choose-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".choice-targets").getByRole("button", { name: /复活的骑兵/ }).click();
    await expect(page.locator(".card-choices")).toHaveCount(0);
    const state = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), saveKey);
    await expect.poll(async () => (await state()).board.find((m: any) => m.uid === target.uid).attack).toBe(11);
    expect((await state()).season.spellsCast).toBe(3);
    await page.reload();
    await expect(page.locator("#boot-screen")).toHaveCount(0);
    expect((await state()).board.find((m: any) => m.uid === target.uid).attack).toBe(11);
    await page.screenshot({ path: `/tmp/tavern-expanded-${width}.png` });
    expect(errors).toEqual([]);
  });
}

test("Lockbox shows its unlock turn and its downloaded artwork", async ({ page }) => {
  const game = createGame("s14_lich", () => .37), chest = makeMinion("s14_BG36_520t"); chest.lockedUntil = 6; game.hand = [chest];
  await page.addInitScript(({ game, saveKey }) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-presentation", "table");
    localStorage.setItem(saveKey, JSON.stringify(game));
  }, { game, saveKey });
  await page.goto(path);
  const card = page.locator(".hand-card-button");
  await expect(card).toContainText("第6回合解锁");
  await expect.poll(() => card.locator("img").evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await card.click();
  await expect(page.getByRole("button", { name: /施放法术/ })).toBeDisabled();
});
