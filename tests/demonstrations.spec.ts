import { test, expect } from '@playwright/test';
const path = process.env.TAVERN_TEST_PATH || '/';
test('opt into a recorded game, preserve choice on reload, and end a recruit round', async ({page,request}) => {
  test.setTimeout(120000);
  let token='';
  try {
    await page.goto(path);
    await page.getByLabel('你的酒馆昵称').fill('实战录制验证');
    await page.getByRole('button',{name:'游客进入',exact:true}).click();
    await page.getByRole('radio',{name:/训练模式/}).check();
    const recording=page.getByRole('checkbox',{name:/记录我的操作/});
    await expect(recording).toBeEnabled();await recording.check();
    await page.reload();await expect(recording).toBeChecked();
    await page.getByRole('button',{name:/人机匹配/}).click({timeout:90000});
    await expect(page.locator('.game-table')).toBeVisible();
    token=await page.evaluate(()=>JSON.parse(localStorage.getItem('bobs-tavern-guest-v1')!).token);
    const state=await (await request.get('/tavern-api/state',{headers:{Authorization:`Bearer ${token}`}})).json();
    expect(state.room.recordTraining).toBe(true);
    await page.getByRole('button',{name:'结束招募',exact:true}).click();
    await expect(page.locator('.combat-table')).toBeVisible({timeout:60000});
    await page.reload();await expect(page.locator('.combat-table')).toBeVisible();
    const health=await (await request.get('/tavern-api/health')).json();
    expect(health.recording.enabled).toBe(true);expect(health.recording.decisions).toBeGreaterThan(0);
    expect(health.recording.errors).toBe(0);
  } finally {
    // Deliberately incomplete: this automated browser run must not train the model.
    if(token) await request.post('/tavern-api/leave',{headers:{Authorization:`Bearer ${token}`},data:{}});
  }
});
