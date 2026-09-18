import { test, expect } from '@playwright/test';

for (const presentation of ['table', 'panels']) test(`unified AI judgment in ${presentation} view`, async ({page, request}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const identity = await (await request.post('/tavern-api/guest', { data: { name: '逐牌估值测试' } })).json();
  const headers = { Authorization: `Bearer ${identity.token}` };
  const api = async (path:string, data?:unknown) => {
    const res = await request.fetch('/tavern-api'+path, { method:data===undefined?'GET':'POST', headers, ...(data===undefined?{}:{data}) });
    expect(res.ok()).toBeTruthy(); return res.json();
  };
  const created = await api('/create', { kind:'ai', hero:'s14_patchwerk', mode:'training' });
  await page.addInitScript(({identity,presentation}) => {
    localStorage.setItem('bobs-tavern-guest-v1',JSON.stringify(identity));
    localStorage.setItem('bobs-tavern-sound','off');
    localStorage.setItem('bobs-tavern-presentation',presentation);
    sessionStorage.setItem('tavern-online-view','game');
  }, {identity,presentation});
  let judgmentRequests=0;
  page.on('request',r => { if(r.url().endsWith('/judgment')) judgmentRequests++; });
  try {
    await page.goto(process.env.TAVERN_TEST_PATH || '/');
    const panel = page.getByRole('region',{name:'AI 判断',exact:true});
    await expect(panel).toBeVisible({timeout:90000});
    expect(judgmentRequests).toBe(0);
    await panel.getByRole('checkbox').check();
    await expect(panel.locator('.judgment-action-list')).toContainText('60.0%');
    await expect(panel.locator('[data-board-score]')).toHaveAttribute('data-board-score','0');
    await panel.getByText(/酒馆随从估值/).click();
    const card = created.game.shop[0];
    const shopScore = await panel.locator(`[data-card-uid="${card.uid}"]`).getAttribute('data-card-score');
    await api('/action',{ action:{type:'buy',uid:card.uid}, turn:1,requestId:`buy-${presentation}` });
    await expect(panel.getByText(/手牌估值/)).toContainText('1 张');
    await panel.getByText(/手牌估值/).click();
    await expect(panel.locator(`[data-card-uid="${card.uid}"]`)).toHaveAttribute('data-card-score',shopScore!);
    await expect(panel.locator('[data-board-score]')).toHaveAttribute('data-board-score','0');
    const current=await api('/state');
    const analysis=await api('/judgment',{version:current.judgmentVersion});
    const play=analysis.decision.choices.find((c:any)=>c.action.type==='play' && c.action.uid===card.uid);
    await api('/action',{action:play.action,turn:1,requestId:`play-${presentation}`});
    await expect(panel.getByText(/场上逐牌贡献/)).toContainText('1 张');
    const contributions = await panel.locator('[data-board-contribution]').evaluateAll(nodes =>
      nodes.reduce((sum,n) => sum+Number(n.getAttribute('data-board-contribution')),0));
    await expect(panel.locator('[data-board-score]')).toHaveAttribute('data-board-score',String(contributions));
    expect(await page.locator('.watch-table').count()).toBe(0);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`/tmp/tavern-judgment-${presentation}.png`,fullPage:true});
    await panel.getByRole('checkbox').uncheck();
    await expect(panel.locator('.judgment-action-list')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await api('/leave',{}); }
});
