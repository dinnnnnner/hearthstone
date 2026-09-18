import { test, expect } from '@playwright/test';

test('real ledger model exposes calibrated per-card sums in human play', async ({page,request}) => {
  test.skip(process.env.TAVERN_LEDGER_E2E !== '1','Requires a local ledger model inference server');
  test.setTimeout(120000);
  const identity=await (await request.post('/tavern-api/guest',{data:{name:'新架构验证'}})).json();
  const headers={Authorization:`Bearer ${identity.token}`};
  const api=async(path:string,data?:unknown)=>{
    const res=await request.fetch('/tavern-api'+path,{method:data===undefined?'GET':'POST',headers,...(data===undefined?{}:{data})});
    expect(res.ok()).toBeTruthy();return res.json();
  };
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(identity=>{
    localStorage.setItem('bobs-tavern-guest-v1',JSON.stringify(identity));
    localStorage.setItem('bobs-tavern-sound','off');sessionStorage.setItem('tavern-online-view','game');
  },identity);
  try {
    let state=await api('/create',{kind:'ai',hero:'s14_patchwerk',mode:'training'});
    const first=await api('/judgment',{version:state.judgmentVersion});
    expect(first.learned.version).toBe('minion-ledger-v1');expect(first.learned.boardStrength).toBe(0);
    const buy=first.decision.choices.find((c:any)=>c.action.type==='buy').action;
    state=await api('/action',{action:buy,turn:1,requestId:'ledger-buy'});
    const hand=await api('/judgment',{version:state.judgmentVersion});
    const play=hand.decision.choices.find((c:any)=>c.action.type==='play' && c.action.uid===buy.uid).action;
    await api('/action',{action:play,turn:1,requestId:'ledger-play'});
    await page.goto(process.env.TAVERN_TEST_PATH || '/');
    const panel=page.getByRole('region',{name:'AI 判断',exact:true});
    await expect(panel).toBeVisible({timeout:90000});await panel.getByRole('checkbox').check();
    await expect(panel.locator('[data-model-board-score]')).toBeVisible();
    const board=Number(await panel.locator('[data-model-board-score]').getAttribute('data-model-board-score'));
    const sum=await panel.locator('[data-model-contribution]').evaluateAll(cards=>cards.reduce((n,c)=>n+Number(c.getAttribute('data-model-contribution')),0));
    expect(sum).toBeCloseTo(board,4);
    await expect(panel).toContainText('模型战力贡献');
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:'/tmp/tavern-ledger-v1-ui.png',fullPage:true});
    expect(errors).toEqual([]);
  } finally { await api('/leave',{}); }
});
