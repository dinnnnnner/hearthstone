import { test, expect } from "@playwright/test";
const path = process.env.TAVERN_TEST_PATH || "/";
const entry = /\/(?:src\/main\.tsx|assets\/index-[^/]+\.js)(?:\?|$)/;
test("loading artwork is visible before JavaScript arrives and hands off to the guest screen", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route(entry, async (r) => {
    await gate;
    await r.continue().catch(() => {});
  });
  try {
    await page.goto(path, { waitUntil: "commit" });
    await expect(page.locator("#boot-screen")).toBeVisible();
    await expect(page.getByText("正在打开酒馆的大门…")).toBeVisible();
    await expect(page.locator(".online-lobby")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/tavern-loading-desktop.png" });
    for (const [width, height] of [
      [390, 844],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(page.locator("#boot-screen h1")).toBeInViewport();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/tavern-loading-phone.png" });
    release();
    await expect(page.getByLabel("你的酒馆昵称")).toBeVisible();
    await expect(page.locator("#boot-screen")).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
test("a failed entry script shows a working reload action", async ({
  page,
}) => {
  let fail = true;
  await page.route(entry, (r) => (fail ? r.abort() : r.continue()));
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#boot-message")).toContainText("未能加载");
  fail = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByLabel("你的酒馆昵称")).toBeVisible();
  await expect(page.locator("#boot-screen")).toHaveCount(0);
});
test("scene preparation limits image concurrency and slow images never trap the player", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("bobs-tavern-entry", "practice"),
  );
  let release!: () => void,
    requests = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/thumbs/*.webp", async (r) => {
    requests++;
    await gate;
    await r.abort().catch(() => {});
  });
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "正在布置酒馆" }),
    ).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "准备游戏素材" }),
    ).toHaveAttribute("aria-valuenow", "0");
    await expect.poll(() => requests).toBe(3);
    await page.screenshot({ path: "/tmp/tavern-scene-loading.png" });
    await page.getByRole("button", { name: "先进入，卡面稍后加载" }).click();
    await expect(page.locator(".game-table")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "正在布置酒馆" }),
    ).toHaveCount(0);
    release();
    await page.getByRole("button", { name: "冻结酒馆", exact: true }).click();
    await expect(page.locator(".wooden-table")).toHaveClass(/frozen-table/);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("stalled artwork automatically releases the entrance after eight seconds with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.addInitScript(() =>
    localStorage.setItem("bobs-tavern-entry", "practice"),
  );
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/thumbs/*.webp", async (r) => {
    await gate;
    await r.abort().catch(() => {});
  });
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "正在布置酒馆" }),
    ).toBeVisible();
    await page.clock.fastForward(8100);
    await expect(page.locator(".game-table")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "正在布置酒馆" }),
    ).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
