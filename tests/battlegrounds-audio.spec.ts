import { test, expect } from "@playwright/test";
import { createGame, makeMinion } from "../src/engine";
import { readFileSync } from "node:fs";
const originals = JSON.parse(readFileSync(new URL("../docs/battlegrounds-audio-active.json", import.meta.url), "utf8"));
const path = process.env.TAVERN_TEST_PATH || "/";
const fileCount = new Set(Object.values(JSON.parse(readFileSync(new URL("../src/table/soundAssets.json", import.meta.url), "utf8"))).flat()).size;

test("placement sounds occur only at final results, once, including delayed online placement", async ({ page }) => {
  await page.goto(path);
  const sounds = await page.evaluate(async (initial) => {
    const Original = window.AudioContext;
    let ctx: AudioContext;
    window.AudioContext = class extends Original { constructor() { super(); ctx = this; } };
    const audio = await import(/* @vite-ignore */ `${location.pathname}src/table/sound.ts`);
    const bank = await import(/* @vite-ignore */ `${location.pathname}src/table/sampledSounds.ts`);
    const { soundHarness } = await import(/* @vite-ignore */ `${location.pathname}tests/fixtures/game-sound.tsx`);
    audio.configureTableSound(true, .65);
    audio.unlockTableSound();
    await ctx!.resume();
    await bank.preloadSampledSounds(ctx!);
    const played: string[] = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      played.push(bank.SAMPLED_SOUNDS.find((kind: string) => bank.sampledSound(ctx!, kind) === this.buffer));
      start.apply(this, args);
    };
    const harness = soundHarness();
    harness.update(initial);
    const combat = { ...initial, phase: "combat", battle: { result: "win", damage: 0, opponent: "test", frames: [
      { allies: [], enemies: [] }, { allies: [], enemies: [] },
    ] } };
    harness.update(combat);
    harness.update(combat, 1);
    harness.update({ ...combat, phase: "over" }, 1, 3);
    harness.update({ ...combat, phase: "over" }, 1, 3);
    harness.update(initial);
    harness.update({ ...initial, phase: "over" });
    harness.update({ ...initial, phase: "over" }, 0, 6);
    harness.update(initial);
    harness.update({ ...initial, phase: "over" }, 0, 1);
    harness.close(); audio.stopTableSounds(); await ctx!.close();
    return played;
  }, createGame("s14_lich", () => .37));
  expect(sounds).toEqual(["combat", "win", "matchTopFour", "round", "matchDefeat", "round", "matchFirst"]);
});

test("casting a Blood Gem uses its original effect and finishing practice uses the first-place cue", async ({ page }) => {
  test.setTimeout(60000);
  const game = createGame("s14_lich", () => .37);
  game.board = [makeMinion("s14_BG25_001")];
  game.hand = [makeMinion("s14_BG20_GEM")];
  game.opponents.forEach((opponent) => { opponent.health = 0; });
  await page.addInitScript((game) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
    localStorage.setItem("bobs-tavern-sound", "on");
    const audit = { decoded: 0, durations: [] as number[] };
    Object.assign(window, { bgAudioAudit: audit });
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (bytes) {
      return decode.call(this, bytes).then((buffer) => { audit.decoded++; return buffer; });
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      audit.durations.push(this.buffer?.duration || 0); start.apply(this, args);
    };
  }, game);
  await page.goto(path);
  await page.locator(".friendly-row .table-piece").click();
  await expect.poll(() => page.evaluate(() => (window as any).bgAudioAudit.decoded), { timeout: 45000 }).toBe(fileCount);
  await page.locator(".table-hand .hand-card-button").dblclick();
  await page.locator(".friendly-row .table-piece").click();
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(0);
  await expect.poll(() => page.evaluate((seconds) => (window as any).bgAudioAudit.durations.some((n: number) => Math.abs(n - seconds) < .001), originals.bloodGem.seconds)).toBe(true);
  await page.getByRole("button", { name: "结束招募", exact: true }).click();
  await expect(page.locator(".game-over")).toBeVisible();
  await expect.poll(() => page.evaluate((seconds) => (window as any).bgAudioAudit.durations.some((n: number) => Math.abs(n - seconds) < .001), originals.matchFirst.seconds)).toBe(true);
});
