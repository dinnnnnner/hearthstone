import { test, expect } from "@playwright/test";
const path = process.env.TAVERN_TEST_PATH || "/";
test("live AI and friend rooms use the selected training mode", async ({ page, request }) => {
  let token = "", friendToken = "";
  const api = async (endpoint: string, data?: unknown, auth = token) => {
    const response = await request.fetch("/tavern-api" + endpoint, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${auth}` },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  try {
    await page.goto(path);
    await page.getByLabel("你的酒馆昵称").fill("训练联机验证");
    await page.getByRole("button", { name: "游客进入", exact: true }).click();
    await page.getByRole("radio", { name: /训练模式/ }).check();
    token = await page.evaluate(() => JSON.parse(localStorage.getItem("bobs-tavern-guest-v1")!).token);
    await page.getByRole("button", { name: /人机匹配/ }).click();
    await expect(page.locator(".game-table")).toBeVisible();
    let state = await api("/state");
    expect(state.room.mode).toBe("training");
    expect(state.room.deadline).toBe(0);
    expect(state.room.seats.filter((s: { bot: boolean }) => s.bot)).toHaveLength(7);
    await page.getByRole("button", { name: "结束招募", exact: true }).click();
    await expect(page.locator(".combat-table")).toBeVisible();
    expect((await api("/state")).room.deadline).toBe(0);
    await page.getByRole("button", { name: /跳过动画/ }).click();
    await page.getByRole("button", { name: /返回酒馆/ }).click();
    await expect(page.locator(".combat-table")).toHaveCount(0);
    state = await api("/state");
    expect(state.room.turn).toBe(2);
    expect(state.room.deadline).toBe(0);
    await api("/leave", {});
    await page.reload();
    await page.getByRole("button", { name: /创建好友房/ }).click();
    await expect(page.locator(".room-heading")).toContainText("训练模式 · 不限时");
    state = await api("/state");
    friendToken = (await api("/guest", { name: "训练好友验证" }, "")).token;
    const friend = await api("/join", { code: state.room.code }, friendToken);
    expect(friend.room.mode).toBe("training");
    await api("/ready", { ready: true }, friendToken);
    await page.getByRole("button", { name: /开局 · 空位补人机/ }).click();
    await expect(page.locator(".game-table")).toBeVisible();
    await page.getByRole("button", { name: "结束招募", exact: true }).click();
    await expect(page.locator(".table-footer")).toContainText("等待其他玩家");
    state = await api("/state");
    expect(state.room.stage).toBe("recruit");
    await api("/action", { action: { type: "end" }, turn: 1, requestId: "friend-training-end" }, friendToken);
    await expect(page.locator(".combat-table")).toBeVisible();
    expect((await api("/state")).room.deadline).toBe(0);
  } finally {
    for (const auth of [token, friendToken]) if (auth) {
      const response = await request.get("/tavern-api/state", { headers: { Authorization: `Bearer ${auth}` } });
      if (response.ok() && (await response.json()).room) await api("/leave", {}, auth);
    }
  }
});
