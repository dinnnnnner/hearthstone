import { test, expect } from "@playwright/test";
import { createGame, makeMinion } from "../src/engine";

test("combat calculates and displays deathrattle summons between the original neighbors", async ({ page }) => {
  const game = createGame("s14_lich", () => .37);
  const left = makeMinion("s14_BG25_001");
  const skull = makeMinion("s14_BG28_300");
  const right = makeMinion("s14_BG25_001");
  for (const m of [left, right]) { m.attack = 0; m.health = 1000; m.keywords = []; }
  skull.attack = 0; skull.keywords = ["嘲讽"];
  game.board = [left, skull, right];
  game.opponents[game.nextOpponent].board = Array.from({ length: 7 }, (_, i) => {
    const m = makeMinion("s14_BG25_001");
    m.attack = i === 0 ? 10 : 0; m.health = 1000; m.keywords = [];
    return m;
  });
  await page.addInitScript(game => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
  }, game);
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  await page.getByRole("button", { name: "结束招募", exact: true }).click();
  const units = await page.evaluate(() => {
    const game = JSON.parse(localStorage.getItem("bobs-tavern-season14-v1")!);
    return game.battle.frames.find((f: { text: string }) => f.text === "进击、伤害与亡语结算").allies as { uid: string; id: string }[];
  });
  expect(units.map(m => [left.uid, right.uid].includes(m.uid) ? m.uid : m.id))
    .toEqual([left.uid, "s14_BG_ICC_026t", "s14_BG_ICC_026t", right.uid]);
  await expect.poll(() => page.locator(".friendly-row .table-piece").evaluateAll(
    elements => elements.map(el => el.getAttribute("data-piece-id")),
  ), { timeout: 15000, intervals: [100] }).toEqual(units.map(m => m.uid));
  await page.getByRole("button", { name: "暂停战斗", exact: true }).click();
  const positions = await page.locator(".friendly-row .table-piece").evaluateAll(
    elements => elements.map(el => el.getBoundingClientRect().x),
  );
  expect(positions).toHaveLength(4);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});
