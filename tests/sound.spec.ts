import { test, expect } from "@playwright/test";
import { createGame, makeMinion } from "../src/engine";

const path = process.env.TAVERN_TEST_PATH || "/";
test("real audio renders every cue, limits bursts, and cancels future notes on mute", async ({ page }) => {
  await page.goto(path);
  // Use the actual browser audio graph and sample its output, without a sound device.
  const result = await page.evaluate(async () => {
    const Original = window.AudioContext;
    let analyser: AnalyserNode;
    let ctx: AudioContext;
    let started = 0;
    let alive = 0;
    let oscillators = 0;
    window.AudioContext = class extends Original {
      constructor() {
        super();
        ctx = this;
        analyser = this.createAnalyser();
        analyser.fftSize = 2048;
      }
      createDynamicsCompressor() {
        const node = super.createDynamicsCompressor();
        node.connect(analyser);
        return node;
      }
      createOscillator() {
        const node = super.createOscillator();
        oscillators++;
        started++; alive++;
        node.addEventListener("ended", () => alive--);
        return node;
      }
      createBufferSource() {
        const node = super.createBufferSource();
        started++; alive++;
        node.addEventListener("ended", () => alive--);
        return node;
      }
    };
    // Vite serves this module directly; keep the import in the browser.
    const audio = await import(/* @vite-ignore */ `${location.pathname}src/table/sound.ts`);
    audio.configureTableSound(true, 0.65);
    audio.unlockTableSound();
    await ctx!.resume();
    const bank = await import(/* @vite-ignore */ `${location.pathname}src/table/sampledSounds.ts`);
    await bank.preloadSampledSounds(ctx!);
    const sampled: string[] = [];
    const sampleDurations = bank.SAMPLED_SOUNDS.map((kind: string) => bank.sampledSound(ctx!, kind)?.duration || 0);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const peak = () => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    };
    const peaks: Record<string, number> = {};
    for (const kind of bank.SAMPLED_SOUNDS) {
      audio.stopTableSounds();
      await wait(80);
      const beforeOscillators = oscillators;
      audio.playTableSound(kind);
      if (bank.sampledSound(ctx!, kind) && oscillators === beforeOscillators) sampled.push(kind);
      await wait(40);
      peaks[kind] = peak();
      // Original cues retain their quiet attack and natural envelope.
      for (let i = 0; peaks[kind] <= 0.00001 && i < 5; i++) {
        await wait(40); peaks[kind] = peak();
      }
    }
    audio.stopTableSounds();
    await wait(100);
    const baseline = started;
    for (let i = 0; i < 30; i++) audio.playTableSound("shield");
    const burstVoices = started - baseline;
    audio.stopTableSounds();
    audio.playTableSound("triple");
    audio.configureTableSound(false, 0.65);
    const mutedStart = started;
    audio.playTableSound("buy");
    await wait(950);
    const mutedPeak = peak();
    const silent = started === mutedStart && alive === 0;
    audio.configureTableSound(true, 0);
    audio.playTableSound("hit");
    const zeroVolumeSilent = started === mutedStart;
    await ctx!.close();
    return { peaks, burstVoices, mutedPeak, silent, zeroVolumeSilent, sampled, sampleDurations };
  });
  for (const [kind, peak] of Object.entries(result.peaks)) {
    expect(peak, kind).toBeGreaterThan(0.00001);
    expect(peak, kind).toBeLessThan(1);
  }
  expect(result.sampled).toHaveLength(31);
  expect(result.sampleDurations.every((duration: number) => duration > 0.05 && duration < 5)).toBe(true);
  expect(result.burstVoices).toBeLessThan(10);
  expect(result.mutedPeak).toBe(0);
  expect(result.silent).toBe(true);
  expect(result.zeroVolumeSilent).toBe(true);
});

test("volume and mute persist while shop interactions keep working", async ({ page }) => {
  const game = createGame("s14_lich", () => 0.37);
  game.gold = 10;
  game.shop = [makeMinion("s14_BG25_001")];
  await page.addInitScript((game) => {
    localStorage.setItem("bobs-tavern-entry", "practice");
    if (!sessionStorage.getItem("sound-fixture")) {
      localStorage.setItem("bobs-tavern-season14-v1", JSON.stringify(game));
      localStorage.setItem("bobs-tavern-sound", "on");
      sessionStorage.setItem("sound-fixture", "1");
    }
  }, game);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  const volume = page.getByRole("slider", { name: "音效音量" });
  await volume.fill("35");
  await page.getByRole("button", { name: "切换操作音效" }).click();
  await expect(volume).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await expect(volume).toHaveValue("35");
  await expect(volume).toBeDisabled();
  await page.getByRole("button", { name: "切换操作音效" }).click();
  await expect(volume).toBeEnabled();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".tavern-row .table-piece").dblclick();
  await expect(page.locator(".table-hand .hand-card-button")).toHaveCount(1);
  await page.getByRole("button", { name: "冻结酒馆", exact: true }).click();
  await expect(page.locator(".wooden-table")).toHaveClass(/frozen-table/);
  expect(errors).toEqual([]);
});


test("missing samples stay silent instead of changing into electronic cues", async ({ page }) => {
  await page.route("**/audio/shop/*.wav", (route) => route.fulfill({ status: 404 }));
  await page.goto(path);
  const result = await page.evaluate(async () => {
    const Original = window.AudioContext;
    let ctx: AudioContext;
    let oscillators = 0;
    window.AudioContext = class extends Original {
      constructor() { super(); ctx = this; }
      createOscillator() { oscillators++; return super.createOscillator(); }
    };
    const audio = await import(/* @vite-ignore */ `${location.pathname}src/table/sound.ts`);
    const bank = await import(/* @vite-ignore */ `${location.pathname}src/table/sampledSounds.ts`);
    audio.configureTableSound(true, 0.65);
    audio.unlockTableSound();
    await ctx!.resume();
    await bank.preloadSampledSounds(ctx!);
    audio.playTableSound("buy");
    const silent = oscillators === 0 && !bank.sampledSound(ctx!, "buy");
    audio.stopTableSounds();
    await ctx!.close();
    return silent;
  });
  expect(result).toBe(true);
});

test("a stalled sample does not block other cues or replay stale actions", async ({ page }) => {
  await page.route("**/audio/shop/triple-*.wav", () => {});
  await page.goto(path);
  const result = await page.evaluate(async () => {
    const Original = window.AudioContext;
    let ctx: AudioContext;
    const rates: number[] = [];
    let oscillators = 0;
    window.AudioContext = class extends Original {
      constructor() { super(); ctx = this; }
      createOscillator() { oscillators++; return super.createOscillator(); }
      createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        source.start = (...args) => { rates.push(source.playbackRate.value); start(...args); };
        return source;
      }
    };
    const audio = await import(/* @vite-ignore */ `${location.pathname}src/table/sound.ts`);
    const bank = await import(/* @vite-ignore */ `${location.pathname}src/table/sampledSounds.ts`);
    audio.configureTableSound(true, 0.65);
    audio.unlockTableSound();
    await ctx!.resume();
    audio.playTableSound("triple");
    const deadline = performance.now() + 5000;
    while (!bank.sampledSound(ctx!, "buy") && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const stalePlays = rates.length;
    audio.playTableSound("buy");
    const result = { ready: !!bank.sampledSound(ctx!, "buy"),
      blocked: !bank.sampledSound(ctx!, "triple"), stalePlays, rates, oscillators };
    audio.stopTableSounds();
    await ctx!.close();
    return result;
  });
  expect(result.ready).toBe(true);
  expect(result.blocked).toBe(true);
  expect(result.stalePlays).toBe(0);
  expect(result.rates).toEqual([1]);
  expect(result.oscillators).toBe(0);
});
