import { assetUrl } from "../paths";
import type { TableSound } from "./sound";
import soundAssets from "./soundAssets.json";
import soundDelivery from "./soundDelivery.json";
import { waitForResourceDownloads } from "../loading/resourceTraffic";

// Original BG mappings: docs/battlegrounds-audio-active.json; other cues: docs/clean-audio.json.
const files: Record<TableSound, string | string[]> = soundAssets;
export const SAMPLED_SOUNDS = Object.keys(files) as TableSound[];
const variants = (kind: TableSound) => [files[kind]].flat();
export const SAMPLED_FILES = [...new Set(SAMPLED_SOUNDS.flatMap(variants))];

const fetching = new Map<string, Promise<ArrayBuffer | undefined>>();
const failedDownloads = new Set<string>();
const decoded = new WeakMap<AudioContext, Map<string, AudioBuffer>>();
const decoding = new WeakMap<AudioContext, Map<string, Promise<void>>>();
const previousVariant = new WeakMap<AudioContext, Map<TableSound, AudioBuffer>>();
const downloads: (() => Promise<void>)[] = [];
let downloading = 0;

function pumpDownloads() {
  while (downloading < 2 && downloads.length) {
    const download = downloads.shift()!;
    downloading++;
    void download().finally(() => { downloading--; pumpDownloads(); });
  }
}

function fetchSample(path: string): Promise<ArrayBuffer | undefined> {
  return new Promise(resolve => {
    downloads.push(async () => {
      try {
        await waitForResourceDownloads();
        const response = await fetch(assetUrl((soundDelivery as Record<string, string>)[path] || path), {
          cache: "force-cache", priority: "low", signal: AbortSignal.timeout(20000),
        });
        if (response.ok) { const bytes = await response.arrayBuffer(); failedDownloads.delete(path); resolve(bytes); return; }
      } catch { /* Missing samples stay silent; never substitute an unrelated cue. */ }
      failedDownloads.add(path);
      resolve(undefined);
    });
    pumpDownloads();
  });
}

function ensureDownload(path: string) {
  if (!fetching.has(path) || failedDownloads.delete(path)) fetching.set(path, fetchSample(path));
  return fetching.get(path)!;
}

// The room downloads the bank before players can ready or start.
export async function prepareSampledSounds(progress: (completed: number) => void) {
  let completed = 0;
  const results = await Promise.all(SAMPLED_FILES.map(async path => {
    const bytes = await ensureDownload(path);
    progress(++completed);
    return !!bytes;
  }));
  return results.filter(ok => !ok).length;
}

// Decoding may proceed even while audio is suspended.
// Playback never awaits loading, so a late download cannot replay an old action.
export function preloadSampledSounds(ctx?: AudioContext, kinds: readonly TableSound[] = SAMPLED_SOUNDS): Promise<void> {
  const paths = [...new Set(kinds.flatMap(variants))];
  for (const path of paths) {
    ensureDownload(path);
  }
  if (!ctx) return Promise.all(paths.map((path) => fetching.get(path))).then(() => {});
  const bank = decoded.get(ctx) ?? new Map<string, AudioBuffer>();
  const pending = decoding.get(ctx) ?? new Map<string, Promise<void>>();
  decoded.set(ctx, bank);
  decoding.set(ctx, pending);
  // Decode each completed request immediately; one slow file cannot hold up others.
  for (const path of paths) {
    if (!bank.has(path) && !pending.has(path)) pending.set(path, (async () => {
      const bytes = await fetching.get(path);
      if (!bytes) return;
      try { bank.set(path, await ctx.decodeAudioData(bytes.slice(0))); }
      catch { /* Unsupported samples stay silent. */ }
    })().finally(() => pending.delete(path)));
  }
  return Promise.all(paths.map((path) => pending.get(path))).then(() => {});
}

export function sampledSound(ctx: AudioContext, kind: TableSound, random = false) {
  const ready = variants(kind).map(path => decoded.get(ctx)?.get(path))
    .filter((buffer): buffer is AudioBuffer => !!buffer);
  if (!random || ready.length < 2) return ready[0];
  const last = previousVariant.get(ctx) ?? new Map<TableSound, AudioBuffer>();
  const choices = ready.filter(buffer => buffer !== last.get(kind));
  const choice = choices[Math.floor(Math.random() * choices.length)];
  last.set(kind, choice);
  previousVariant.set(ctx, last);
  return choice;
}
