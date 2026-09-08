import { useEffect, useRef } from "react";
import type { Game } from "../engine";
import { frameDuration } from "./motion";
export function useBattlePlayback(
  game: Game,
  frame: number,
  playing: boolean,
  speed: number,
  setFrame: (n: number) => void,
) {
  const remaining = useRef(0);
  useEffect(() => {
    remaining.current = frameDuration(game.battle?.frames[frame], frame);
  }, [game.battle, frame]);
  useEffect(() => {
    if (
      game.phase !== "combat" ||
      !playing ||
      !game.battle ||
      frame >= game.battle.frames.length - 1
    )
      return;
    let start = performance.now(),
      id = 0;
    const tick = (now: number) => {
      remaining.current -= Math.min(now - start, 100) * speed;
      start = now;
      if (remaining.current <= 0) setFrame(frame + 1);
      else id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [game.phase, game.battle, frame, playing, speed, setFrame]);
}
