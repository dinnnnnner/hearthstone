import { preloadSampledSounds, sampledSound } from "./sampledSounds";
import originalGains from "./originalSoundGains.json";

export type TableSound =
  | "select" | "pickup" | "move" | "buy" | "refresh" | "play" | "sell"
  | "spell" | "power" | "freeze" | "thaw" | "upgrade" | "discover"
  | "attack" | "shield" | "hit" | "heroHit" | "death" | "triple"
  | "combat" | "round" | "win" | "lose" | "tie" | "error" | "tick"
  | "heroSelect" | "bloodGem" | "matchFirst" | "matchTopFour" | "matchDefeat";

const gains: Partial<Record<TableSound, number>> = originalGains;
const active = new Map<AudioScheduledSourceNode, TableSound>();
const lastPlayed = new Map<TableSound, number>();
let context: AudioContext | undefined;
let master: GainNode | undefined;
let enabled = true;
let volume = 0.65;

export function stopTableSounds() {
  for (const source of active.keys()) {
    try { source.stop(); } catch { /* Already ended. */ }
  }
  active.clear();
  lastPlayed.clear();
}

export function configureTableSound(on: boolean, level: number) {
  enabled = on;
  volume = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0.65;
  if (!enabled || !volume) stopTableSounds();
  if (context && master) master.gain.setTargetAtTime(enabled ? volume * 0.7 : 0, context.currentTime, 0.015);
}

// Call inside a user gesture. Never queue stale combat sounds while audio is locked.
export function unlockTableSound(kinds?: readonly TableSound[]) {
  if (!enabled || !volume) return;
  try {
    if (!context || context.state === "closed") {
      context = new AudioContext();
      master = context.createGain();
      master.gain.value = volume * 0.7;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.knee.value = 14;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.12;
      master.connect(compressor);
      compressor.connect(context.destination);
    }
    void preloadSampledSounds(context, kinds);
    if (context.state === "suspended") void context.resume().catch(() => {});
  } catch { /* Audio support must never block a game action. */ }
}

export function playTableSound(kind: TableSound, on = true) {
  if (!on || !enabled || !volume || (typeof document !== "undefined" && document.hidden)) return;
  unlockTableSound([kind]);
  const ctx = context, output = master;
  if (!ctx || !output || ctx.state !== "running") return;
  const now = ctx.currentTime;
  // Batch simultaneous deaths/shields and tame fast repeated clicks at 2× speed.
  const cooldown = kind === "select" || kind === "tick" ? 0.09 : 0.045;
  if (now - (lastPlayed.get(kind) ?? -Infinity) < cooldown || active.size > 100) return;
  lastPlayed.set(kind, now);
  try {
    const sample = sampledSound(ctx, kind, true);
    if (sample) {
      if (kind === "heroSelect") for (const [source, playing] of active)
        if (playing === kind) { try { source.stop(); } catch { /* Already ended. */ } }
      const source = ctx.createBufferSource();
      source.buffer = sample;
      source.playbackRate.value = 1;
      const level = ctx.createGain();
      level.gain.value = gains[kind] ?? 1;
      source.connect(level);
      level.connect(output);
      active.set(source, kind);
      source.onended = () => { source.disconnect(); level.disconnect(); active.delete(source); };
      // The original hero-selection file starts with half a second of silence.
      source.start(now, kind === "heroSelect" ? 0.532 : 0);
      return;
    }
  } catch { /* Audio is optional. */ }
}
