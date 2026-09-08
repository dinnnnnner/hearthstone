import { test, expect, type Page, type Locator } from "@playwright/test";
import { createGame, makeMinion, type Game } from "../src/engine";
import { SEASON_CARDS } from "../src/season/catalog";
import { POOL_COPIES } from "../src/data";
const key = "bobs-tavern-season14-v1";
function fixture() {
  const s = createGame("s14_lich", () => 0.37);
  for (const d of SEASON_CARDS)
    if (s.pool[d.id] === undefined) {
      s.pool[d.id] = POOL_COPIES[d.tier];
      s.season!.initialPool[d.id] = POOL_COPIES[d.tier];
    }
  s.shop.forEach((m) => s.pool[m.id]++);
  s.shop = [];
  return s;
}
function add(s: Game, id: string, zone: "shop" | "board" | "hand") {
  const m = makeMinion(id, false, true);
  s.pool[id]--;
  s[zone].push(m);
  return m;
}
async function open(page: Page, s: Game) {
  await page.addInitScript(
    ({ s, key }) => {
      localStorage.setItem("bobs-tavern-entry", "practice");
      if (!sessionStorage.getItem("table-fixture")) {
        localStorage.setItem(key, JSON.stringify(s));
        localStorage.setItem("bobs-tavern-sound", "off");
        sessionStorage.setItem("table-fixture", "yes");
      }
    },
    { s, key },
  );
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
}
async function saved(page: Page): Promise<Game> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}
async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox(),
    b = await to.boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}
test("drag buy, summon, reorder, sell, freeze and inline combat; save survives reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const s = fixture();
  s.gold = 10;
  add(s, "s14_BG25_001", "shop");
  add(s, "s14_BG25_001", "board");
  await open(page, s);
  await drag(
    page,
    page.locator(".tavern-row .table-piece"),
    page.locator(".table-hand"),
  );
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(1);
  await drag(
    page,
    page.locator(".table-hand .hand-card-button"),
    page.locator('[data-slot="1"]'),
  );
  await expect(page.locator(".friendly-row .table-piece")).toHaveCount(2);
  const first = s.board[0].uid;
  await drag(
    page,
    page.locator(".friendly-row .table-piece").first(),
    page.locator('[data-slot="1"]'),
  );
  expect((await saved(page)).board[1].uid).toBe(first);
  await drag(
    page,
    page.locator(".friendly-row .table-piece").first(),
    page.locator(".bartender"),
  );
  await expect(page.locator(".friendly-row .table-piece")).toHaveCount(1);
  await page.getByRole("button", { name: "冻结酒馆", exact: true }).click();
  await expect(page.locator(".wooden-table")).toHaveClass(/frozen-table/);
  await page.getByRole("button", { name: "结束招募", exact: false }).click();
  await expect(page.locator(".combat-table")).toBeVisible();
  await expect(page.locator(".combat-stage")).toHaveCount(0);
  await expect(page.locator(".enemy-row .table-piece").first()).toBeVisible();
  await expect
    .poll(async () => page.locator(".scene-number").count(), {
      timeout: 7000,
      intervals: [50],
    })
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "暂停战斗" }).click();
  await page.getByLabel("战斗速度").selectOption("2");
  await page.getByRole("button", { name: "继续播放" }).click();
  await page.getByRole("button", { name: /跳过动画/ }).click();
  await expect(page.locator(".battle-verdict")).toBeVisible();
  await page.getByRole("button", { name: /返回酒馆/ }).click();
  await expect(page.locator(".round-medallion")).toContainText("第 2 回合");
  const before = await saved(page);
  await page.reload();
  expect(await saved(page)).toEqual(before);
  expect(errors).toEqual([]);
});
test("targeted activation, spell drag, and hero power work on board pieces", async ({
  page,
}) => {
  const s = fixture();
  s.gold = 10;
  add(s, "s14_BG36_345", "board");
  add(s, "s14_BG25_001", "board");
  s.hand.push(makeMinion("s14_BG28_897"));
  await open(page, s);
  await page.locator(".friendly-row .table-piece").first().click();
  await page.getByRole("button", { name: /发动技能/ }).click();
  await page.locator(".friendly-row .table-piece").nth(1).click();
  await expect(page.locator(".friendly-row .piece-attack").nth(1)).toHaveText(
    "5",
  );
  await drag(
    page,
    page.locator(".table-hand .hand-card-button"),
    page.locator(".friendly-row .table-piece").nth(1),
  );
  await expect(page.locator(".friendly-row .piece-attack").nth(1)).toHaveText(
    "7",
  );
  await page.getByRole("button", { name: /使用英雄技能/ }).click();
  await page.locator(".friendly-row .table-piece").nth(1).click();
  await expect(page.locator(".hero-power-orb")).toBeDisabled();
  expect((await saved(page)).board[1].rebornNext).toBeTruthy();
});
test("triple celebration and reward discovery; panel fallback preserves the game", async ({
  page,
}) => {
  const s = fixture();
  s.gold = 10;
  for (const zone of ["board", "hand", "shop"] as const)
    add(s, "s14_BG25_001", zone);
  await open(page, s);
  await page.locator(".tavern-row .table-piece").dblclick();
  await expect(page.locator(".triple-ribbon")).toBeVisible();
  await expect(page.locator(".golden-hand")).toHaveCount(1);
  await page.locator(".table-hand .hand-card-button").dblclick();
  await expect(page.locator(".friendly-row .golden-piece")).toHaveCount(1);
  await page.locator(".table-reward").click();
  await page.locator(".discovery-cards .button").first().click();
  const before = await saved(page);
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await page.getByRole("button", { name: "切换实战棋盘" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".shop-cards")).toBeVisible();
  expect(await saved(page)).toEqual(before);
});
test("phone touch and full ten-card hand remain usable in both orientations", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const s = fixture();
  s.gold = 10;
  s.tier = 6;
  for (const d of SEASON_CARDS.slice(0, 7)) add(s, d.id, "board");
  for (const d of SEASON_CARDS.slice(7, 17)) add(s, d.id, "hand");
  for (const d of SEASON_CARDS.slice(17, 23)) add(s, d.id, "shop");
  await open(page, s);
  for (const [w, h] of [
    [844, 390],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const selector of [
      ".table-end-turn",
      ".friendly-row",
      ".table-hand",
      ".table-footer",
    ]) {
      const b = await page.locator(selector).boundingBox();
      expect(b!.y).toBeGreaterThanOrEqual(0);
      expect(b!.y + b!.height).toBeLessThanOrEqual(h);
    }
  }
  const health = await page.locator(".table-hero-health").boundingBox();
  const hand = await page
    .locator(".table-hand .hand-card-button")
    .first()
    .boundingBox();
  expect(health!.y + health!.height).toBeLessThan(hand!.y);
  const strip = page.locator(".hand-fan");
  await strip.evaluate((e) => e.scrollTo(e.scrollWidth, 0));
  await expect(
    page.locator(".table-hand .hand-card-button").last(),
  ).toBeInViewport();
  await page.locator(".table-hand .hand-card-button").last().tap();
  await expect(page.locator(".table-inspector")).toBeVisible();
  await page.getByRole("button", { name: "关闭卡牌详情" }).tap();
  await page.locator(".friendly-row .table-piece").first().tap();
  await page.getByRole("button", { name: "右移", exact: true }).tap();
  expect((await saved(page)).board[1].uid).toBe(s.board[0].uid);
  await page.screenshot({ path: "/tmp/table-full-portrait.png" });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.screenshot({ path: "/tmp/table-full-landscape.png" });
  await context.close();
});
test("native touch drag buys and plays; horizontal hand swipe scrolls without playing", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const s = fixture();
  add(s, "s14_BG25_001", "shop");
  await open(page, s);
  const client = await context.newCDPSession(page);
  async function swipe(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [a],
    });
    for (let i = 1; i <= 12; i++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12 },
        ],
      });
      await page.waitForTimeout(18);
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  async function center(l: Locator) {
    const r = (await l.boundingBox())!;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  await swipe(
    await center(page.locator(".tavern-row .table-piece")),
    await center(page.locator(".table-hand")),
  );
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(1);
  await swipe(
    await center(page.locator(".table-hand .hand-card-button")),
    await center(page.locator('[data-slot="0"]')),
  );
  await expect(page.locator(".friendly-row .table-piece")).toHaveCount(1);
  const filled = await saved(page);
  for (const d of SEASON_CARDS.slice(7, 17)) add(filled, d.id, "hand");
  await page.evaluate(
    ({ key, filled }) => localStorage.setItem(key, JSON.stringify(filled)),
    { key, filled },
  );
  await page.reload();
  const strip = page.locator(".hand-fan");
  const r = (await strip.boundingBox())!;
  await swipe(
    { x: r.x + r.width - 35, y: r.y + r.height / 2 },
    { x: r.x + 30, y: r.y + r.height / 2 },
  );
  await expect
    .poll(() => strip.evaluate((e) => e.scrollLeft))
    .toBeGreaterThan(30);
  expect((await saved(page)).hand).toHaveLength(10);
  expect((await saved(page)).board).toHaveLength(1);
  await context.close();
});
test("combat contact controls damage and shields; pause freezes motion and skip clears every transient", async ({
  page,
}) => {
  const s = fixture(),
    a = makeMinion("s14_BG25_001"),
    b = makeMinion("s14_BG25_001");
  a.attack = 8;
  a.health = 12;
  b.attack = 2;
  b.health = 8;
  b.keywords = ["圣盾"];
  const aHit = { ...a, health: 10 },
    bOpen = { ...b, keywords: [] },
    bDead = { ...bOpen, health: 0 };
  s.board = [a];
  s.phase = "combat";
  s.battle = {
    result: "win",
    damage: 3,
    opponent: "动画测试",
    frames: [
      { text: "准备接触", allies: [a], enemies: [b] },
      {
        text: "contact-test-1",
        allies: [aHit],
        enemies: [bOpen],
        attacker: a.uid,
        target: b.uid,
      },
      {
        text: "contact-test-2",
        allies: [aHit],
        enemies: [bDead],
        attacker: a.uid,
        target: b.uid,
      },
      { text: "亡语退场", allies: [aHit], enemies: [] },
      { text: "胜利", allies: [aHit], enemies: [] },
    ],
  };
  await open(page, s);
  const savedBefore = await saved(page);
  await page.waitForFunction(() =>
    document
      .querySelector(".table-footer")
      ?.textContent?.includes("contact-test-1"),
  );
  await page.getByRole("button", { name: "暂停战斗" }).click();
  await expect(page.locator(".friendly-row .piece-health")).toHaveText("12");
  await expect(page.locator(".enemy-row .shield-piece")).toHaveCount(1);
  await expect(page.locator(".scene-number.damage")).toHaveCount(0);
  await page.waitForTimeout(350);
  await expect(page.locator(".friendly-row .piece-health")).toHaveText("12");
  await page.getByRole("button", { name: "继续播放" }).click();
  await expect(page.locator(".friendly-row .piece-health")).toHaveText("10");
  await expect(page.locator(".enemy-row .shield-piece")).toHaveCount(0);
  await expect(page.locator(".scene-number.damage")).toHaveCount(1);
  await page.getByRole("button", { name: "暂停战斗" }).click();
  const transform = await page
    .locator(".friendly-row .table-piece")
    .evaluate((e) => getComputedStyle(e).transform);
  await page.waitForTimeout(250);
  expect(
    await page
      .locator(".friendly-row .table-piece")
      .evaluate((e) => getComputedStyle(e).transform),
  ).toBe(transform);
  await page.getByLabel("战斗速度").selectOption("2");
  await page.getByRole("button", { name: "继续播放" }).click();
  await page.getByRole("button", { name: /跳过动画/ }).click();
  await expect(page.locator(".scene-ghost")).toHaveCount(0);
  await expect(page.locator(".scene-number")).toHaveCount(0);
  await expect(page.locator(".battle-verdict")).toBeVisible();
  expect(await saved(page)).toEqual(savedBefore);
});
