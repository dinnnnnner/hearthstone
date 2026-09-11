import { test, expect } from "@playwright/test";
import images from "../src/loading/matchAssets.json" with { type: "json" };
const route = process.env.TAVERN_TEST_PATH || "/";
async function leave(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const guest = JSON.parse(localStorage.getItem("bobs-tavern-guest-v1") || "null");
    if (guest) await fetch("/tavern-api/leave", { method: "POST", headers: { Authorization: `Bearer ${guest.token}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(12000) });
  }).catch(() => {});
}

test("room downloads resources before start and does not fetch audio during battle", async ({ page }) => {
  test.setTimeout(120000);
  let audioRequests = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/audio/**", async request => {
    audioRequests++;
    await held;
    await request.continue().catch(() => {});
  });
  try {
    await page.goto(route);
    await expect(page.getByRole("progressbar", { name: "对战资源下载进度" })).toBeVisible();
    await expect.poll(() => audioRequests).toBeGreaterThan(0);
    await page.getByLabel("你的酒馆昵称").fill("开局资源验证");
    await page.getByRole("button", { name: "游客进入", exact: true }).click();
    await expect(page.getByRole("progressbar", { name: "对战资源下载进度" })).toBeVisible();
    await expect(page.getByRole("button", { name: /人机匹配/ })).toBeDisabled();
    await page.getByRole("radio", { name: /训练模式/ }).check();
    await expect(page.getByRole("button", { name: /创建好友房/ })).toBeDisabled();
    expect(audioRequests).toBeLessThanOrEqual(2);
    release();
    await expect(page.getByText("对战资源已就绪", { exact: true })).toBeVisible({ timeout: 90000 });
    const beforeStart = audioRequests;
    expect(beforeStart).toBe(39);
    await page.getByRole("button", { name: /创建好友房/ }).click();
    await page.getByRole("button", { name: /开局 ·/ }).click();
    await expect(page.locator(".game-table")).toBeVisible();
    await page.getByRole("button", { name: "结束招募", exact: true }).click();
    await expect(page.locator(".combat-table")).toBeVisible();
    await page.getByRole("button", { name: /跳过动画/ }).click();
    await page.getByRole("button", { name: /返回酒馆/ }).click();
    await expect(page.locator(".round-medallion")).toContainText("第 2 回合");
    expect(audioRequests).toBe(beforeStart);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await leave(page);
  }
});

test("a failed resource keeps ready disabled and can be retried", async ({ page }) => {
  test.setTimeout(120000);
  let fail = true;
  await page.route(`**/${images[0]}`, request => fail ? request.fulfill({ status: 503 }) : request.continue());
  try {
    await page.goto(route);
    await page.getByLabel("你的酒馆昵称").fill("资源重试验证");
    await page.getByRole("button", { name: "游客进入", exact: true }).click();
    await expect(page.getByRole("button", { name: "重试下载", exact: true })).toBeVisible({ timeout: 90000 });
    await expect(page.getByRole("button", { name: /创建好友房/ })).toBeDisabled();
    fail = false;
    await page.getByRole("button", { name: "重试下载", exact: true }).click();
    await expect(page.getByText("对战资源已就绪", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /创建好友房/ }).click();
    await expect(page.getByRole("button", { name: /开局 ·/ })).toBeEnabled();
  } finally { await leave(page); }
});
