import { test, expect, type Page } from "@playwright/test";
import { Rooms } from "../server/rooms";
import { createGame } from "../src/engine";

const path = process.env.TAVERN_TEST_PATH || "/";

async function checkTribes(page: Page, tribes: string[]) {
  const strip = page.getByRole("region", { name: "本局种族", exact: true });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("listitem")).toHaveText(tribes);
  for (const item of await strip.getByRole("listitem").all()) {
    await expect(item).toBeInViewport();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const [width, height] of [[1440, 1000], [390, 844], [844, 390]]) {
  test(`online match tribes remain visible beside room status, through combat and reload at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    let now = 1_000_000;
    const rooms = new Rooms(() => now, () => .37);
    const identity = rooms.guest("种族显示验证"), guest = rooms.auth(identity.token);
    const room = rooms.create(guest, "ai", "s14_lich");
    const tribes = [...room.tribes];
    expect(tribes).toHaveLength(5);
    await page.addInitScript((identity) => {
      localStorage.setItem("bobs-tavern-guest-v1", JSON.stringify(identity));
      localStorage.setItem("bobs-tavern-sound", "off");
      sessionStorage.setItem("tavern-online-view", "game");
    }, identity);
    await page.route("**/tavern-api/**", route => route.fulfill({ json: rooms.view(guest) }));
    await page.goto(path);
    await expect(page.locator("#boot-screen")).toHaveCount(0);
    await checkTribes(page, tribes);
    if (width === 1440) await expect(page.locator(".table-header-center")).toContainText("人机对局");
    const strip = await page.locator(".match-tribes").boundingBox();
    const board = await page.locator(".table-game").boundingBox();
    expect(strip!.y + strip!.height).toBeLessThanOrEqual(board!.y + 1);
    await page.screenshot({ path: `/tmp/tavern-tribes-${width}.png` });
    now += 120_000;
    rooms.tick();
    await expect(page.locator(".combat-table")).toBeVisible();
    await checkTribes(page, tribes);
    await page.reload();
    await checkTribes(page, tribes);
  });
}

for (const [width, height] of [[320, 740], [844, 390]]) {
  test(`touch panels show the saved match tribes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const game = createGame("s14_lich", () => .73);
    await page.addInitScript((game) => {
      localStorage.setItem("bobs-tavern-entry", "practice");
      localStorage.setItem("bobs-tavern-presentation", "panels");
      localStorage.setItem("bobs-tavern-play-mode", "touch");
      localStorage.setItem("bobs-tavern-sound", "off");
      if (!localStorage.getItem("bobs-tavern-season14-v1")) {
        localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
      }
    }, game);
    await page.goto(path);
    await expect(page.locator("#boot-screen")).toHaveCount(0);
    await expect(page.locator(".mobile-arena")).toBeVisible();
    await checkTribes(page, game.season!.tribes);
    await page.screenshot({ path: `/tmp/tavern-tribes-panels-${width}.png` });
    await page.reload();
    await checkTribes(page, game.season!.tribes);
  });
}

test("classic practice does not invent a seasonal tribe selection", async ({ page }) => {
  const game = createGame("lich", () => .37);
  expect(game.season).toBeUndefined();
  await page.addInitScript((game) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
    localStorage.setItem("bobs-tavern-sound", "off");
  }, game);
  await page.goto(path);
  await expect(page.locator(".game-table")).toBeVisible();
  await expect(page.getByRole("region", { name: "本局种族", exact: true })).toHaveCount(0);
});
