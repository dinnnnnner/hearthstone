import type { Game } from "../engine";
import { PREFIX, SEASON_HEROES } from "./catalog";

export interface PowerProgress { uses: number; turnUses: number; elementalsPlayed: number }
export interface PowerChoice {
  mode: "finley" | "nguyen" | "genn" | "replace";
  offers: string[];
  selected: string[];
}
export const equippedPowers = (s: Game): string[] => s.season?.powers || [s.hero];
export const hasPower = (s: Game, key: string) => equippedPowers(s).includes(PREFIX + key);
export const powerDefinition = (s: Game, id = equippedPowers(s)[0]) =>
  SEASON_HEROES.find((h) => h.id === id)!;
export function powerProgress(s: Game, id = equippedPowers(s)[0]): PowerProgress {
  const st = s.season!;
  if (st.powers) return st.powerProgress?.[id] || { uses: 0, turnUses: 0, elementalsPlayed: 0 };
  const limit = ["s14_blackthorn", "s14_inge"].includes(id) ? 2 : 1;
  return { uses: st.heroPowerUses || 0,
    turnUses: st.heroPowerUsesTurn ?? (s.powerUsed ? limit : 0),
    elementalsPlayed: st.elementalsPlayed || 0 };
}
export function savePowerProgress(s: Game, id: string, progress: PowerProgress) {
  const st = s.season!;
  if (st.powers) (st.powerProgress ??= {})[id] = progress;
  if (id === equippedPowers(s)[0]) {
    st.heroPowerUses = progress.uses;
    st.heroPowerUsesTurn = progress.turnUses;
    st.elementalsPlayed = progress.elementalsPlayed;
  }
}
// Preserve counters when migrating a save or replacing an already-used power.
export function equipPowers(s: Game, ids: string[]) {
  const st = s.season!;
  if (!st.powers) st.powerProgress = { [s.hero]: powerProgress(s) };
  const wasMillhouse = hasPower(s, "millhouse");
  st.powers = ids;
  if (s.tier < 6 && wasMillhouse !== hasPower(s, "millhouse"))
    s.upgrade = Math.max(0, s.upgrade + (wasMillhouse ? -1 : 1));
  savePowerProgress(s, ids[0], powerProgress(s, ids[0]));
}
