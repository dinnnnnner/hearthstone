import { test, expect } from "@playwright/test";
import { createGame } from "../src/engine";

for (const mobile of [false, true]) test(`opponent scouting shows past damage and tribe summary on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const game = createGame("s14_lich", () => .37);
  game.turn = 4;
  game.opponents[0].name = "机械玩家";
  game.opponents[0].scouting = [
    { turn: 4, warband: "本回合秘密", battle: { opponent: "秘密对手", result: "win", damage: 99 } },
    { turn: 3, warband: "3机械", battle: { opponent: "鱼人玩家", result: "win", damage: 8 } },
    { turn: 2, warband: "混合", battle: { opponent: "恶魔玩家", result: "loss", damage: 6 } },
  ];
  game.opponents[1].name = "混合玩家";
  game.opponents[1].scouting = [{ turn: 3, warband: "混合", battle: { opponent: "机械玩家", result: "tie", damage: 0 } }];
  await page.addInitScript(game => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-sound", "off");
    if (!sessionStorage.getItem("scouting-fixture")) {
      localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
      sessionStorage.setItem("scouting-fixture", "yes");
    }
  }, game);
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  await page.locator(".rival-token").nth(0).click();
  const panel = page.getByRole("region", { name: "对手战绩" });
  await expect(panel.locator(".rival-warband")).toHaveText("上回合阵容3机械");
  await expect(panel).toContainText("机械玩家 对 鱼人玩家 造成 8 点伤害");
  await expect(panel).toContainText("恶魔玩家 对 机械玩家 造成 6 点伤害");
  await expect(panel).not.toContainText("秘密");
  await expect(panel.locator("li")).toHaveCount(2);
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(mobile ? 390 : 1440);
  await page.screenshot({ path: `/tmp/scouting-${mobile ? "mobile" : "desktop"}.png` });
  await page.getByRole("button", { name: "关闭对手信息" }).click();
  await expect(panel).toBeHidden();
  await page.locator(".rival-token").nth(1).click();
  await expect(panel.locator(".rival-warband")).toHaveText("上回合阵容混合");
  await expect(panel).toContainText("混合玩家 与 机械玩家 平局，0 点伤害");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.reload();
  await page.locator(".rival-token").nth(0).click();
  await expect(panel).toContainText("机械玩家 对 鱼人玩家 造成 8 点伤害");
});
