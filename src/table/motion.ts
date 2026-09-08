import type { BattleFrame } from "../engine";
// Milliseconds at 1×. Damage and shield removal share the contact timestamp.
export const COMBAT_MOTION = {
  windup: 130,
  contact: 270,
  recoil: 345,
  return: 610,
  attackFrame: 740,
  resolveFrame: 440,
  openingFrame: 1100,
};
export function frameDuration(frame: BattleFrame | undefined, index: number) {
  return index === 0
    ? COMBAT_MOTION.openingFrame
    : frame?.attacker
      ? COMBAT_MOTION.attackFrame
      : COMBAT_MOTION.resolveFrame;
}
export function attackPath(dx: number, dy: number): Keyframe[] {
  const t = COMBAT_MOTION;
  return [
    { transform: "translate(0,0) scale(1)", offset: 0 },
    {
      transform: `translate(${-dx * 0.045}px,${-dy * 0.07}px) scale(1.07)`,
      offset: t.windup / t.return,
      easing: "cubic-bezier(.7,0,1,.7)",
    },
    {
      transform: `translate(${dx}px,${dy}px) scale(1.12,.96)`,
      offset: t.contact / t.return,
    },
    {
      transform: `translate(${dx * 0.96}px,${dy * 0.95}px) scale(1.03,1.08)`,
      offset: t.recoil / t.return,
      easing: "cubic-bezier(.15,.65,.25,1)",
    },
    { transform: "translate(0,0) scale(1)", offset: 1 },
  ];
}
// Timed effects use the same pausable Web Animations clock as moving pieces.
export class SceneTimeline {
  private animations = new Set<Animation>();
  private cleanups = new Set<() => void>();
  private stopped = false;
  constructor(
    private speed = 1,
    private playing = true,
  ) {}
  animate(
    target: Element | null,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
    onFinish?: () => void,
  ) {
    const a = new Animation(
      new KeyframeEffect(target, frames, options),
      document.timeline,
    );
    this.animations.add(a);
    a.playbackRate = this.speed;
    a.play();
    if (!this.playing) a.pause();
    a.finished
      .then(() => {
        this.animations.delete(a);
        if (!this.stopped) onFinish?.();
      })
      .catch(() => {});
    return a;
  }
  at(delay: number, run: () => void) {
    if (delay <= 0) {
      if (!this.stopped) run();
    } else this.animate(null, [], { duration: delay }, run);
  }
  cleanup(fn: () => void) {
    this.cleanups.add(fn);
  }
  control(speed: number, playing: boolean) {
    this.speed = speed;
    this.playing = playing;
    for (const a of this.animations) {
      a.updatePlaybackRate(speed);
      if (playing) a.play();
      else {
        const time = a.currentTime;
        a.pause();
        if (time !== null) a.currentTime = time;
      }
    }
  }
  dispose() {
    this.stopped = true;
    for (const a of this.animations) a.cancel();
    for (const fn of this.cleanups) fn();
    this.animations.clear();
    this.cleanups.clear();
  }
}
