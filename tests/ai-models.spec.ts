import { test, expect } from '@playwright/test';
const path = process.env.TAVERN_TEST_PATH || '/';
test('choose each AI model, keep it on reconnect, and share the choice in friend rooms', async ({ page, request }) => {
  test.setTimeout(360000);
  let token = '', friend = '';
  const api = async (endpoint: string, data?: unknown, auth = token) => {
    const response = await request.fetch('/tavern-api' + endpoint, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${auth}` },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const options = (await api('/models')).models;
  expect(options.slice(0, 3).map((m: { label: string }) => m.label)).toEqual(['64 层模型', '256 层模型', '1024 层模型']);
  expect(new Set(options.map((m: { id: string }) => m.id)).size).toBe(options.length);
  try {
    await page.goto(path);
    await page.getByLabel('你的酒馆昵称').fill('模型选择验证');
    await page.getByRole('button', { name: '游客进入', exact: true }).click();
    await page.getByRole('radio', { name: /训练模式/ }).check();
    token = await page.evaluate(() => JSON.parse(localStorage.getItem('bobs-tavern-guest-v1')!).token);
    for (const model of options) {
      await page.locator(`input[name="ai-model"][value="${model.id}"]`).check();
      await page.getByRole('button', { name: /人机匹配/ }).click({ timeout: 90000 });
      await expect(page.locator('.game-table')).toBeVisible();
      let state = await api('/state');
      expect(state.room.aiModel.id).toBe(model.id);
      expect(state.room.aiModel.checkpointSha256).toBe(model.checkpointSha256);
      await page.reload();
      await expect(page.locator('.game-table')).toBeVisible({ timeout: 20000 });
      expect((await api('/state')).room.aiModel.id).toBe(model.id);
      await page.getByRole('button', { name: '结束招募', exact: true }).click();
      await expect(page.locator('.combat-table')).toBeVisible({ timeout: 120000 });
      state = await api('/state');
      expect(state.room.aiStatus).toBe('neural');
      expect((await api('/health')).ai.models.find((m: { id: string }) => m.id === model.id).decisions).toBeGreaterThan(0);
      await api('/leave', {});
      await page.reload();
      await expect(page.locator(`input[name="ai-model"][value="${model.id}"]`)).toBeChecked();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.ai-model-picker').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/tavern-ai-model-selection-mobile.png', fullPage: true });
    await page.getByRole('button', { name: /创建好友房/ }).click();
    await expect(page.locator('.room-heading')).toContainText(options.at(-1).label);
    const state = await api('/state');
    friend = (await api('/guest', { name: '模型选择好友' }, '')).token;
    const joined = await api('/join', { code: state.room.code }, friend);
    expect(joined.room.aiModel).toEqual(state.room.aiModel);
  } finally {
    for (const auth of [friend, token]) if (auth) await api('/leave', {}, auth);
  }
});
