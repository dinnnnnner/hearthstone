import { test, expect } from "@playwright/test";
import { createGame, makeMinion } from "../src/engine";
import { readFileSync } from "node:fs";
const shopAudio = JSON.parse(readFileSync(new URL("../docs/battlegrounds-shop-audio-active.json", import.meta.url), "utf8"));
const assets = JSON.parse(readFileSync(new URL("../src/table/soundAssets.json", import.meta.url), "utf8"));
const fileCount = new Set(Object.values(assets).flat()).size;

test("published game decodes the sample bank and plays sampled freeze and purchase cues", async ({ page }) => {
  test.setTimeout(60000);
  const game = createGame("s14_lich", () => 0.37);
  game.gold = 10;
  game.shop = [makeMinion("s14_BG25_001")];
  await page.addInitScript((game) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
    localStorage.setItem("bobs-tavern-sound", "on");
    const audit = { decoded: 0, durations: [] as number[], oscillators: 0 };
    Object.assign(window, { sampleAudit: audit });
    const createOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      audit.oscillators++;
      return createOscillator.call(this);
    };
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (bytes) {
      return decode.call(this, bytes).then((buffer) => {
        audit.decoded++;
        return buffer;
      });
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
      if (this.buffer) audit.durations.push(this.buffer.duration);
      start.call(this, when, offset, duration);
    };
  }, game);
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/audio/") && response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(process.env.TAVERN_TEST_PATH || "/");
  await page.locator(".tavern-row .table-piece").click();
  // The full optional bank loads at low priority after the board is usable.
  await expect.poll(() => page.evaluate(() => (window as any).sampleAudit.decoded), {
    timeout: 45000,
  }).toBe(fileCount);
  await page.getByRole("button", { name: "冻结酒馆", exact: true }).click();
  await expect.poll(() => page.evaluate((duration) =>
    (window as any).sampleAudit.durations.some((n: number) => Math.abs(n - duration) < 0.001),
  shopAudio.cues.freeze.variants[0].seconds)).toBe(true);
  await page.locator(".tavern-row .table-piece").dblclick();
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(1);
  await expect.poll(() => page.evaluate((duration) =>
    (window as any).sampleAudit.durations.some((n: number) => Math.abs(n - duration) < 0.001),
  shopAudio.cues.buy.variants[0].seconds)).toBe(true);
  expect(await page.evaluate(() => (window as any).sampleAudit.oscillators)).toBe(0);
  expect(failures).toEqual([]);
});
