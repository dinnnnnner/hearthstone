import { test, expect } from '@playwright/test';
import { createGame, makeMinion } from '../src/engine';
import { readFileSync } from 'node:fs';
const path = process.env.TAVERN_TEST_PATH || '/';
const assets = JSON.parse(readFileSync(new URL('../src/table/soundAssets.json', import.meta.url), 'utf8'));
const delivery = JSON.parse(readFileSync(new URL('../src/table/soundDelivery.json', import.meta.url), 'utf8'));
const cues = JSON.parse(readFileSync(new URL('../docs/battlegrounds-shop-audio-active.json', import.meta.url), 'utf8')).cues;
const count = new Set(Object.values(assets).flat()).size;

test('shop variants play while one download is stalled and avoid immediate repetition', async ({ page }) => {
  await page.route(`**/${delivery[assets.refresh[0]]}`, () => {});
  await page.goto(path);
  const result = await page.evaluate(async () => {
    const audio = await import(/* @vite-ignore */ `${location.pathname}src/table/sampledSounds.ts`);
    const ctx = new AudioContext();
    void audio.preloadSampledSounds(ctx, ['refresh']);
    const deadline = performance.now() + 5000;
    while (!audio.sampledSound(ctx, 'refresh') && performance.now() < deadline)
      await new Promise(r => setTimeout(r, 20));
    // Wait only for the remaining known variants, never the stalled first file.
    await new Promise(r => setTimeout(r, 300));
    const selected = Array.from({ length: 30 }, () => audio.sampledSound(ctx, 'refresh', true));
    const ready = selected.every(Boolean);
    const unique = new Set(selected).size;
    const repeats = selected.some((s, i) => i > 0 && s === selected[i - 1]);
    await ctx.close();
    return { ready, unique, repeats };
  });
  expect(result.ready).toBe(true);
  expect(result.unique).toBeGreaterThan(1);
  expect(result.repeats).toBe(false);
});

test('published shop plays original freeze, thaw, buy, triple, sell and refresh cues', async ({ page }) => {
  test.setTimeout(90000);
  const game = createGame('s14_lich', () => .37);
  game.gold = 10;
  game.hand = [makeMinion('s14_BG25_001'), makeMinion('s14_BG25_001')];
  game.shop = [makeMinion('s14_BG25_001')];
  game.board = [makeMinion('s14_BG20_100')];
  await page.addInitScript(game => {
    localStorage.setItem('bobs-tavern-entry', 'practice');
    localStorage.setItem('bobs-tavern-season14-v1', JSON.stringify(game));
    localStorage.setItem('bobs-tavern-sound', 'on');
    const audit = { decoded: 0, durations: [] as number[] };
    Object.assign(window, { shopAudioAudit: audit });
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (bytes) {
      return decode.call(this, bytes).then(buffer => { audit.decoded++; return buffer; });
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      audit.durations.push(this.buffer?.duration || 0); start.apply(this, args);
    };
  }, game);
  await page.goto(path);
  await page.locator('.friendly-row .table-piece').click();
  await expect.poll(() => page.evaluate(() => (window as any).shopAudioAudit.decoded), { timeout: 60000 }).toBe(count);
  const heard = async (kind: string) => {
    await expect.poll(() => page.evaluate(seconds => {
      const played = (window as any).shopAudioAudit.durations as number[];
      return seconds.some((seconds: number) => played.some(n => Math.abs(n - seconds) < .001));
    }, cues[kind].variants.map((v: any) => v.seconds))).toBe(true);
  };
  await page.getByRole('button', { name: '冻结酒馆', exact: true }).click();
  await heard('freeze');
  await page.getByRole('button', { name: '解冻酒馆', exact: true }).click();
  await heard('thaw');
  await page.locator('.tavern-row .table-piece').dblclick();
  await expect(page.locator('.golden-hand')).toHaveCount(1);
  await heard('buy'); await heard('triple');
  await page.locator('.friendly-row .table-piece').click();
  await page.getByRole('button', { name: /出售/ }).click();
  await heard('sell');
  await page.getByRole('button', { name: /刷新酒馆/ }).click();
  await heard('refresh');
});
