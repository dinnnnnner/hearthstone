import { assetUrl } from "../paths";
import type { TableSound } from "./sound";
import soundAssets from "./soundAssets.json";

// Original BG mappings: docs/battlegrounds-audio-active.json; other cues: docs/clean-audio.json.
const files: Record<TableSound, string | string[]> = soundAssets;
export const SAMPLED_SOUNDS = Object.keys(files) as TableSound[];
const variants = (kind: TableSound) => [files[kind]].flat();
export const SAMPLED_FILES = [...new Set(SAMPLED_SOUNDS.flatMap(variants))];

const fetching = new Map<string, Promise<ArrayBuffer | undefined>>();
const decoded = new WeakMap<AudioContext, Map<string, AudioBuffer>>();
const decoding = new WeakMap<AudioContext, Map<string, Promise<void>>>();
const previousVariant = new WeakMap<AudioContext, Map<TableSound, AudioBuffer>>();

// Fetch after the board is ready; decoding may proceed even while audio is suspended.
// Playback never awaits loading, so a late download cannot replay an old action.
export function preloadSampledSounds(ctx?: AudioContext, kinds: readonly TableSound[] = SAMPLED_SOUNDS): Promise<void> {
  const paths = [...new Set(kinds.flatMap(variants))];
  for (const path of paths) {
    if (!fetching.has(path)) fetching.set(path, (async () => {
      try {
        const response = await fetch(assetUrl(path), { priority: "low" });
        if (response.ok) return await response.arrayBuffer();
      } catch { /* Missing samples stay silent; never substitute an unrelated cue. */ }
      return undefined;
    })());
  }
  if (!ctx) return Promise.all(paths.map((path) => fetching.get(path))).then(() => {});
  const bank = decoded.get(ctx) ?? new Map<string, AudioBuffer>();
  const pending = decoding.get(ctx) ?? new Map<string, Promise<void>>();
  decoded.set(ctx, bank);
  decoding.set(ctx, pending);
  // Decode each completed request immediately; one slow file cannot hold up others.
  for (const path of paths) {
    if (!pending.has(path)) pending.set(path, (async () => {
      const bytes = await fetching.get(path);
      if (!bytes) return;
      try { bank.set(path, await ctx.decodeAudioData(bytes.slice(0))); }
      catch { /* Unsupported samples stay silent. */ }
    })());
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
