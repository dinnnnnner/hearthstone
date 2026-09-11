import { useEffect, useRef } from "react";
import type { Game } from "../engine";
import { playTableSound, stopTableSounds } from "./sound";
import { changesBetween } from "./presentation";

// Phase cues also work in the panel/mobile layouts. The table owns contact sounds.
export function useGameSound(game: Game, frame: number, playing: boolean,
  sound: boolean, table: boolean, ready: boolean, place?: number) {
  const previous = useRef({ game, frame, place });
  const resultPlayed = useRef(false);
  useEffect(() => {
    if (!playing) stopTableSounds();
  }, [playing]);
  useEffect(() => {
    const before = previous.current;
    previous.current = { game, frame, place };
    if (game.phase !== "over") resultPlayed.current = false;
    if (!ready) return;
    if (before.game.phase !== game.phase) {
      stopTableSounds();
      if (game.phase === "combat") playTableSound("combat", sound);
      else if (game.phase === "recruit") playTableSound("round", sound);
    }
    if (game.phase === "over" && !resultPlayed.current && place &&
        (before.game.phase !== "over" || before.place !== place)) {
      resultPlayed.current = true;
      playTableSound(place === 1 ? "matchFirst" : place <= 4 ? "matchTopFour" : "matchDefeat", sound);
    }
    if (!table && game.triples > before.game.triples) playTableSound("triple", sound);
    if (game.phase !== "combat" || !game.battle || !playing) return;
    // A skipped replay must not emit the sounds of the frames it bypassed.
    if (frame !== before.frame + 1 || before.game.battle !== game.battle) return;
    const current = game.battle.frames[frame];
    if (!table && current) {
      const old = game.battle.frames[before.frame];
      const changes = changesBetween([...(old?.allies || []), ...(old?.enemies || [])],
        [...current.allies, ...current.enemies]);
      if (current.attacker) playTableSound("hit", sound);
      if (changes.some((c) => c.shieldBroken)) playTableSound("shield", sound);
      if (changes.some((c) => c.dead)) playTableSound("death", sound);
    }
    if (!table && frame === game.battle.frames.length - 1)
      playTableSound(game.battle.result === "win" ? "win" : game.battle.result === "loss" ? "lose" : "tie", sound);
  }, [game, frame, playing, sound, table, ready, place]);
}
