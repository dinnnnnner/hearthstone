import { type Action, type Game, type Minion, heroPowerState } from "../src/engine";
import { getDef } from "../src/data";
import { seasonTargets } from "../src/season/engine";
import { equippedPowers } from "../src/season/powers";

// Chromie's full spell tavern contains SHOP_SIZE[tier] + 1 cards, up to seven.
export const LIMITS = { board: 7, shop: 16, spellShop: 7, hand: 10, discovery: 4, powers: 2, choices: 4 } as const;
// Target 0 means no target; remaining slots are board, shop, spell shop, hand.
export const TARGET_COUNT = 1 + LIMITS.board + LIMITS.shop + LIMITS.spellShop + LIMITS.hand;
export interface ActionSpec { type: Action["type"]; source: number; target: number; position: number }
export const ACTIONS: ActionSpec[] = [];
function add(type: Action["type"], sources = 1, targets = 1, positions = 1) {
  for (let source = 0; source < sources; source++) for (let target = 0; target < targets; target++) for (let position = 0; position < positions; position++) ACTIONS.push({ type, source, target, position });
}
for (const type of ["end", "refresh", "freeze", "upgrade", "reward", "darkGift"] as const) add(type);
add("buy", LIMITS.shop); add("buySpell", LIMITS.spellShop); add("sell", LIMITS.board);
add("move", LIMITS.board, 1, LIMITS.board);
add("play", LIMITS.hand, TARGET_COUNT, LIMITS.board + 1);
add("cast", LIMITS.hand, TARGET_COUNT); add("activate", LIMITS.board, TARGET_COUNT);
add("power", LIMITS.powers, TARGET_COUNT); add("discover", LIMITS.discovery, TARGET_COUNT);
add("choosePower", LIMITS.choices); add("buyTrinket", LIMITS.choices);
const key = (s: ActionSpec) => `${s.type}:${s.source}:${s.target}:${s.position}`;
const indices = new Map(ACTIONS.map((s, i) => [key(s), i]));
export function actionId(type: Action["type"], source = 0, target = 0, position = 0) {
  const id = indices.get(key({ type, source, target, position }));
  if (id === undefined) throw Error("Action encoding overflow");
  return id;
}
export function targets(s: Game): (Minion | undefined)[] {
  const pad = (a: Minion[], n: number) => Array.from({ length: n }, (_, i) => a[i]);
  return [undefined, ...pad(s.board, LIMITS.board), ...pad(s.shop, LIMITS.shop), ...pad(s.season!.spellShop, LIMITS.spellShop), ...pad(s.hand, LIMITS.hand)];
}
export function assertActionBounds(s: Game) {
  for (const [name, values, limit] of [
    ["board", s.board, LIMITS.board], ["shop", s.shop, LIMITS.shop], ["hand", s.hand, LIMITS.hand],
    ["spellShop", s.season!.spellShop, LIMITS.spellShop], ["discovery", s.discovery, LIMITS.discovery],
    ["powers", equippedPowers(s), LIMITS.powers], ["powerChoice", s.season!.powerChoice?.offers || [], LIMITS.choices],
    ["trinketOffers", s.season!.trinketOffers, LIMITS.choices],
  ] as const) if (values.length > limit) throw Error(`Unsupported ${name} size ${values.length}; update action schema before training`);
}
/** Enumerate meaningful action arguments; the authoritative engine validates feasibility. */
export function candidates(s: Game, endOnly = false): Map<number, Action> {
  assertActionBounds(s);
  const result = new Map<number, Action>(), targetSlots = targets(s);
  const targetIndex = (m: Minion) => {
    const i = targetSlots.findIndex(x => x?.uid === m.uid);
    if (i < 0) throw Error("Unencoded target zone");
    return i;
  };
  const put = (a: Action, source = 0, target = 0, position = 0) => result.set(actionId(a.type, source, target, position), a);
  if (s.season!.powerChoice) {
    s.season!.powerChoice.offers.forEach((uid, i) => put({ type: "choosePower", uid }, i));
    return result;
  }
  if (s.discovery.length) {
    s.discovery.forEach((m, i) => {
      const ts = s.season!.discoveryKind === "choose" ? seasonTargets(s, m, "cast") : [];
      if (!ts.length) put({ type: "discover", uid: m.uid }, i);
      else ts.forEach(t => put({ type: "discover", uid: m.uid, target: t.uid }, i, targetIndex(t)));
    });
    return result;
  }
  if (s.season!.trinketOffers.length) {
    s.season!.trinketOffers.forEach((uid, i) => put({ type: "buyTrinket", uid }, i));
    return result;
  }
  put({ type: "end" });
  if (endOnly) return result;
  for (const type of ["refresh", "freeze", "upgrade", "reward", "darkGift"] as const) put({ type });
  s.shop.forEach((m, i) => put({ type: "buy", uid: m.uid }, i));
  s.season!.spellShop.forEach((m, i) => put({ type: "buySpell", uid: m.uid }, i));
  s.board.forEach((m, i) => {
    put({ type: "sell", uid: m.uid }, i);
    s.board.forEach((_, j) => { if (i !== j) put({ type: "move", uid: m.uid, to: j }, i, 0, j); });
    const ts = seasonTargets(s, m, "activate");
    if (!ts.length) put({ type: "activate", uid: m.uid }, i);
    else ts.forEach(t => put({ type: "activate", uid: m.uid, target: t.uid }, i, targetIndex(t)));
  });
  s.hand.forEach((m, i) => {
    const spell = getDef(m.id).kind === "spell", ts = seasonTargets(s, m, spell ? "cast" : "battlecry");
    if (spell) {
      if (!ts.length) put({ type: "cast", uid: m.uid }, i);
      else ts.forEach(t => put({ type: "cast", uid: m.uid, target: t.uid }, i, targetIndex(t)));
    } else {
      const choices: (Minion | undefined)[] = getDef(m.id).magnetic ? [undefined, ...ts] : ts.length ? ts : [undefined];
      for (const t of choices) {
        const positions = getDef(m.id).magnetic && t ? [0] : Array.from({ length: Math.min(7, s.board.length) + 1 }, (_, j) => j);
        for (const position of positions) put({ type: "play", uid: m.uid, position, ...(t ? { target: t.uid } : {}) }, i, t ? targetIndex(t) : 0, position);
      }
    }
  });
  equippedPowers(s).forEach((powerId, i) => {
    const power = heroPowerState(s, powerId);
    if (power.reason) return;
    if (!power.needsTarget) put({ type: "power", powerId }, i);
    else power.targets.forEach(t => put({ type: "power", powerId, target: t.uid }, i, targetIndex(t)));
  });
  return result;
}
