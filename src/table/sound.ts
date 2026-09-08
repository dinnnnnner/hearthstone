export type TableSound =
  | "buy"
  | "refresh"
  | "play"
  | "sell"
  | "spell"
  | "hit"
  | "death"
  | "triple"
  | "round";
let context: AudioContext | undefined;
// One reusable context; short synthesized sounds need no audio downloads.
export function playTableSound(kind: TableSound, enabled: boolean) {
  if (!enabled) return;
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume().catch(() => {});
    const ctx = context,
      now = ctx.currentTime;
    const tones: Record<TableSound, number[]> = {
      buy: [880, 1320, 1760],
      refresh: [220, 160],
      play: [196, 392],
      sell: [660, 990],
      spell: [523, 659, 784],
      hit: [95, 48],
      death: [100, 55],
      triple: [392, 494, 587, 784, 988],
      round: [196, 294, 392],
    };
    tones[kind].forEach((frequency, i) => {
      const osc = ctx.createOscillator(),
        gain = ctx.createGain(),
        start = now + i * (kind === "triple" ? 0.1 : 0.045);
      osc.type = kind === "hit" || kind === "death" ? "triangle" : "sine";
      osc.frequency.setValueAtTime(frequency, start);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(30, frequency * 0.75),
        start + 0.15,
      );
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(
        kind === "hit" ? 0.06 : 0.025,
        start + 0.01,
      );
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.23);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.25);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    });
  } catch {
    /* Audio is optional; browser policies never prevent a game action. */
  }
}
