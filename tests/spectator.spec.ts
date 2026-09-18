import { test, expect } from '@playwright/test';
const path=process.env.TAVERN_TEST_PATH||'/';
test('AI spectator entry, probabilities, stepping, reconnect, and mobile layout',async({page,request})=>{
 test.setTimeout(120000);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('bobs-tavern-sound','off');localStorage.setItem('bobs-tavern-presentation','panels');});
 await page.goto(path);
 await page.getByLabel('你的酒馆昵称').fill('观战界面验证');
 await page.getByRole('button',{name:'游客进入',exact:true}).click();
 await expect(page.getByRole('heading',{name:'AI 观战'})).toBeVisible();
 const token=await page.evaluate(()=>JSON.parse(localStorage.getItem('bobs-tavern-guest-v1')!).token);
 const api=async(endpoint:string,data?:unknown)=>{
  const response=await request.fetch('/tavern-api'+endpoint,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`},...(data===undefined?{}:{data})});
  return {status:response.status(),body:await response.json()};
 };
 try {
  await page.getByRole('button',{name:/开始观战/}).click({timeout:90000});
  await expect(page.getByRole('region',{name:'AI 观战控制'})).toBeVisible();
  await expect(page.locator('.watch-table')).toBeVisible();
  await expect(page.locator('.tavern-row .policy-selected')).toContainText('60.0%');
  await expect(page.getByRole('button',{name:'刷新酒馆',exact:true})).toBeDisabled();
  await expect(page.locator('[data-policy-type="upgrade"]')).toContainText('不可选');
  const first=(await api('/state')).body;
  expect(first.room.kind).toBe('spectate');expect(first.room.seats.every((s:any)=>s.bot)).toBe(true);
  const cards=first.game.shop.length;
  expect((await api('/action',{action:{type:'refresh'},turn:1,requestId:'spectator-attack'})).status).toBe(400);
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await expect(page.locator('.tavern-row .table-piece')).toHaveCount(cards-1);
  await expect(page.locator('.table-hand .hand-card-button')).toHaveCount(1);
  await expect(page.locator('.hand-policy .policy-probability')).toContainText('60.0%');
  await page.locator('.watch-choices summary').click();
  await expect(page.locator('.watch-choice-selected')).toContainText('打出');
  await page.locator('.watch-choices summary').click();
  await page.reload();
  await expect(page.getByRole('button',{name:'播放 AI',exact:true})).toBeVisible({timeout:30000});
  await expect(page.locator('.table-hand .hand-card-button')).toHaveCount(1);
  await page.screenshot({path:'/tmp/tavern-watch-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'下一步',exact:true})).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/tavern-watch-mobile.png'});
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await expect(page.locator('.friendly-row .table-piece')).toHaveCount(1);
  await expect(page.locator('.table-hand .hand-card-button')).toHaveCount(0);
  expect(errors).toEqual([]);
 } finally {await api('/leave',{});}
});
