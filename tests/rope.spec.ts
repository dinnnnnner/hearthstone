import { test, expect, type Page } from "@playwright/test";
import { Rooms } from "../server/rooms";

const path = process.env.TAVERN_TEST_PATH || "/";
async function openRoom(page: Page, seconds = 25, waitingForFriend = false) {
  let serverNow = 1_000_000, fresh = true;
  const rooms = new Rooms(() => serverNow, () => .37);
  const identity = rooms.guest("烧绳验证"), guest = rooms.auth(identity.token);
  const room = rooms.create(guest, waitingForFriend ? "friends" : "ai", "s14_lich");
  if (waitingForFriend) {
    const friend = rooms.auth(rooms.guest("等待中的好友").token);
    rooms.join(friend, room.code); rooms.ready(friend, true); rooms.start(guest);
  }
  room.deadline = serverNow + seconds * 1000;
  await page.clock.install();
  await page.addInitScript((identity) => {
    localStorage.setItem("bobs-tavern-guest-v1", JSON.stringify(identity));
    localStorage.setItem("bobs-tavern-sound", "off");
    sessionStorage.setItem("tavern-online-view", "game");
  }, identity);
  await page.route("**/tavern-api/**", async (route) => {
    if (route.request().url().includes("/action")) {
      const { action, requestId, turn } = route.request().postDataJSON();
      rooms.action(guest, action, requestId, turn);
      return route.fulfill({ json: rooms.view(guest) });
    }
    if (!fresh && new URL(route.request().url()).searchParams.get("version")) return route.fulfill({ status: 204 });
    fresh = false;
    await route.fulfill({ json: rooms.view(guest) });
  });
  await page.goto(path);
  await expect(page.locator(".game-table")).toBeVisible();
  await expect(page.locator("#boot-screen")).toHaveCount(0);
  return { rooms, room, guest, update: (elapsed: number) => { serverNow += elapsed; fresh = true; } };
}

test("rope starts at twenty seconds, burns toward the end, and expires without sending an early end action", async ({ page }) => {
  const fixture = await openRoom(page);
  const rope = page.locator(".recruitment-rope");
  await expect(rope).toHaveCount(0);
  await page.clock.fastForward(6000);
  await expect(rope).toBeVisible();
  const start = Number(await rope.getAttribute("data-seconds"));
  expect(start).toBeLessThanOrEqual(20); expect(start).toBeGreaterThan(15);
  const before = await page.locator(".rope-fuse").boundingBox();
  await page.clock.fastForward(15000);
  await expect(rope).toHaveClass(/rope-urgent/);
  await expect.poll(async () => (await page.locator(".rope-fuse").boundingBox())!.x).toBeGreaterThan(before!.x);
  await page.screenshot({ path: "/tmp/tavern-rope-desktop.png" });
  await page.clock.fastForward(5000);
  await expect(rope).toHaveClass(/rope-spent/);
  await expect(page.getByRole("timer")).toContainText("等待战斗");
  expect(fixture.room.stage).toBe("recruit");
  fixture.update(90001); fixture.rooms.tick();
  await page.clock.fastForward(1100);
  await expect(page.locator(".combat-table")).toBeVisible();
  await expect(rope).toHaveCount(0);
  fixture.rooms.action(fixture.guest, { type: "continue" }, "next-round", fixture.room.turn);
  fixture.update(0); await page.clock.fastForward(1100);
  await expect(page.locator(".combat-table")).toHaveCount(0);
  await expect(rope).toHaveCount(0);
  expect(fixture.room.turn).toBe(2);
});

test("server resync, reload and background resume preserve the fuse position; rope does not intercept controls", async ({ page }) => {
  const fixture = await openRoom(page, 15, true);
  const rope = page.locator(".recruitment-rope");
  await expect(rope).toBeVisible();
  await page.getByRole("button", { name: "冻结酒馆", exact: true }).click();
  await expect(page.locator(".wooden-table")).toHaveClass(/frozen-table/);
  await page.clock.fastForward(7000);
  fixture.update(7000);
  await page.clock.fastForward(1100);
  const seconds = Number(await rope.getAttribute("data-seconds"));
  expect(seconds).toBeLessThanOrEqual(8);
  fixture.update(0); await page.reload();
  await expect(rope).toBeVisible();
  expect(Number(await rope.getAttribute("data-seconds"))).toBeLessThanOrEqual(8);
  await page.clock.fastForward(4000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(Number(await rope.getAttribute("data-seconds"))).toBeLessThanOrEqual(4);
  fixture.update(4000);
  await page.getByRole("button", { name: "结束招募", exact: true }).click();
  await expect(rope).toHaveCount(0);
  expect(fixture.room.stage).toBe("recruit");
  expect(fixture.room.seats[0].ended).toBe(true);
});

test("rope fits portrait, landscape and mobile panels; reduced motion removes flicker but retains countdown", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openRoom(page, 18);
  const rope = page.locator(".recruitment-rope");
  for (const [width, height] of [[390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await expect(rope).toBeVisible();
    const bounds = await rope.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.locator(".rope-flame").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    await page.screenshot({ path: `/tmp/tavern-rope-${width}.png` });
  }
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await page.getByRole("button", { name: "切换实战棋盘" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".mobile-table .recruitment-rope")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(rope).toBeVisible();
  await page.clock.fastForward(19000);
  await expect(rope).toHaveClass(/rope-spent/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
