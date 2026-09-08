import { test, expect } from "@playwright/test";
const site = process.env.SITE_BASE_URL;
test.skip(!site, "Set SITE_BASE_URL to the packaged or deployed site");
test("lobby links to both games, tavern assets use its subpath, and returning home preserves progress", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const failed: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(r.url());
  });
  await page.goto(site!);
  await expect(page).toHaveTitle("游戏大厅 · Playroom");
  await expect(
    page.getByRole("link", { name: "进入 SECTOR 战术竞技场" }),
  ).toHaveAttribute("href", "/sector/");
  await page.getByRole("link", { name: "进入鲍勃的酒馆", exact: true }).click();
  await expect(page).toHaveTitle(/鲍勃/);
  await expect(page.locator(".season-bar")).toBeVisible();
  const image = await page
    .locator(".shop-cards .card-art")
    .first()
    .evaluate((e) => getComputedStyle(e).backgroundImage);
  expect(image).toContain("/tavern/art/");
  await page.locator(".shop-cards .minion-card").first().click();
  await page.getByRole("button", { name: /招募随从/ }).click();
  await expect(page.locator(".hand-cards .minion-card")).toHaveCount(1);
  await page.getByRole("link", { name: "返回游戏大厅" }).click();
  await expect(page).toHaveTitle("游戏大厅 · Playroom");
  await page.getByRole("link", { name: "进入鲍勃的酒馆", exact: true }).click();
  await expect(page.locator(".hand-cards .minion-card")).toHaveCount(1);
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
});
test("lobby and prefixed mobile tavern fit portrait and landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(site!);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/playroom-home-mobile.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "进入鲍勃的酒馆", exact: true }).click();
  await expect(page.locator(".mobile-arena")).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  const end = await page.locator(".mobile-end").boundingBox();
  expect(end!.y + end!.height).toBeLessThanOrEqual(390);
  await page.getByRole("link", { name: "返回游戏大厅" }).click();
  await expect(page).toHaveTitle("游戏大厅 · Playroom");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "/tmp/playroom-home-desktop.png",
    fullPage: true,
  });
});

test('SECTOR opens from the lobby and its WebSocket still replies through Nginx', async ({page}) => {
  test.skip(!process.env.CHECK_SECTOR, 'Enable against the server with SECTOR installed');
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const failures:string[]=[];page.on('response',r=>{if(r.status()>=400)failures.push(r.url());});
  await page.goto(site!);await page.getByRole('link',{name:'进入 SECTOR 战术竞技场'}).click();
  await expect(page).toHaveTitle(/SECTOR/);await expect(page.locator('#lobby')).toBeVisible();
  const reply=await page.evaluate(()=>new Promise<{type:string;at:number}>((resolve,reject)=>{
    const ws=new WebSocket(`wss://${location.host}/ws`);
    const timer=setTimeout(()=>{ws.close();reject(new Error('WebSocket ping timeout'));},8000);
    ws.onopen=()=>ws.send(JSON.stringify({type:'ping',at:12345}));
    ws.onmessage=e=>{clearTimeout(timer);ws.close();resolve(JSON.parse(e.data));};
    ws.onerror=()=>{clearTimeout(timer);ws.close();reject(new Error('WebSocket connection failed'));};
  }));
  expect(reply).toEqual({type:'pong',at:12345});expect(errors).toEqual([]);expect(failures).toEqual([]);
  await page.locator('.brand-symbol').click();await expect(page).toHaveTitle('游戏大厅 · Playroom');
});
