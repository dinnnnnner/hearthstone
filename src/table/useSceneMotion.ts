import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Game, Minion, BattleFrame } from "../engine";
import type { EffectsHandle, BurstKind } from "./Effects";
import { changesBetween, shortStat } from "./presentation";
import { attackPath, COMBAT_MOTION, SceneTimeline } from "./motion";
import { playTableSound } from "./sound";
type Captured = { rect: DOMRect; node: HTMLElement; m?: Minion };
type Props = {
  reset: number;
  game: Game;
  current?: BattleFrame;
  frame: number;
  speed: number;
  playing: boolean;
  sound: boolean;
  root: RefObject<HTMLDivElement | null>;
  layer: RefObject<HTMLDivElement | null>;
  effects: RefObject<EffectsHandle | null>;
};
export function useSceneMotion(p: Props) {
  const previous = useRef<{
      game: Game;
      pieces: Minion[];
      captures: Map<string, Captured>;
    } | null>(null),
    timeline = useRef<SceneTimeline | null>(null);
  const lastReset = useRef(p.reset);
  const controls = useRef(p);
  controls.current = p;
  const [heroStruck, setHeroStruck] = useState(true);
  const [overrides, setOverrides] = useState<Map<string, Minion>>(new Map());
  useLayoutEffect(() => {
    timeline.current?.control(
      p.game.phase === "combat" ? p.speed : 1,
      p.game.phase !== "combat" || p.playing,
    );
  }, [p.speed, p.playing, p.game.phase]);
  useLayoutEffect(() => {
    const root = p.root.current,
      layer = p.layer.current;
    if (!root || !layer) return;
    timeline.current?.dispose();
    const combat = p.game.phase === "combat",
      reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clock = new SceneTimeline(
      combat ? controls.current.speed : 1,
      !combat || controls.current.playing,
    );
    timeline.current = clock;
    const before = previous.current,
      allies = p.current?.allies || p.game.board,
      enemies = p.current?.enemies || p.game.shop,
      pieces = [...allies, ...enemies];
    const bounds = root.getBoundingClientRect(),
      captures = new Map<string, Captured>();
    const locate = (uid: string) =>
      root.querySelector<HTMLElement>(
        `[data-piece-id="${CSS.escape(uid)}"], [data-hand-id="${CSS.escape(uid)}"]`,
      );
    for (const m of [...pieces, ...p.game.hand]) {
      const el = locate(m.uid);
      if (el)
        captures.set(m.uid, {
          rect: el.getBoundingClientRect(),
          node: el.cloneNode(true) as HTMLElement,
          m,
        });
    }
    previous.current = { game: p.game, pieces, captures };
    setOverrides(new Map());
    setHeroStruck(true);
    const skipped = lastReset.current !== p.reset;
    lastReset.current = p.reset;
    if (skipped || before?.game.phase !== p.game.phase)
      p.effects.current?.clear();
    if (!before || skipped) return () => clock.dispose();
    const point = (r: DOMRect) => ({
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
    });
    const burst = (r: DOMRect, kind: BurstKind) => {
      const c = point(r);
      p.effects.current?.burst(c.x, c.y, kind);
    };
    function animate(
      el: HTMLElement,
      frames: Keyframe[],
      duration: number,
      delay = 0,
      done?: () => void,
    ) {
      if (reduced) {
        done?.();
        return;
      }
      clock.animate(
        el,
        frames,
        { duration, delay, easing: "linear", fill: "backwards" },
        done,
      );
    }
    function ghost(c: Captured) {
      const el = c.node.cloneNode(true) as HTMLElement;
      el.removeAttribute("data-piece-id");
      el.removeAttribute("data-hand-id");
      el.removeAttribute("data-target");
      el.setAttribute("aria-hidden", "true");
      el.inert = true;
      el.classList.add("scene-ghost");
      Object.assign(el.style, {
        left: `${c.rect.x - bounds.x}px`,
        top: `${c.rect.y - bounds.y}px`,
        width: `${c.rect.width}px`,
        height: `${c.rect.height}px`,
        margin: "0",
      });
      layer!.append(el);
      clock.cleanup(() => el.remove());
      return el;
    }
    function label(
      r: DOMRect,
      text: string,
      kind = "damage",
      delay = 0,
      travel = { x: 0, y: 0 },
    ) {
      clock.at(delay, () => {
        const c = point(r),
          el = document.createElement("span");
        el.className = `scene-number ${kind}`;
        el.textContent = text;
        Object.assign(el.style, {
          left: `${c.x - bounds.x}px`,
          top: `${c.y - bounds.y}px`,
        });
        layer!.append(el);
        clock.cleanup(() => el.remove());
        if (reduced) {
          clock.at(500, () => el.remove());
          return;
        }
        animate(
          el,
          [
            {
              transform: `translate(calc(-50% + ${travel.x}px),calc(-50% + ${travel.y}px)) scale(1.8)`,
              opacity: 0,
            },
            {
              transform: `translate(calc(-50% + ${travel.x * 0.8}px),calc(-50% + ${travel.y * 0.8}px)) scale(1)`,
              opacity: 1,
              offset: 0.16,
            },
            {
              transform: "translate(-50%,-58%) scale(1)",
              opacity: 1,
              offset: 0.65,
            },
            { transform: "translate(-50%,-90%) scale(.75)", opacity: 0 },
          ],
          600,
          0,
          () => el.remove(),
        );
      });
    }
    function fly(c: Captured, to: DOMRect, kind: string, duration = 420) {
      if (reduced) return;
      const el = ghost(c),
        a = point(c.rect),
        b = point(to),
        dx = b.x - a.x,
        dy = b.y - a.y;
      el.classList.add(kind);
      animate(
        el,
        [
          { transform: "translate(0,0) scale(1)", opacity: 1 },
          {
            transform: `translate(${dx * 0.45}px,${dy * 0.32 - 24}px) rotate(-9deg) scale(1.08)`,
            opacity: 1,
            offset: 0.45,
          },
          {
            transform: `translate(${dx}px,${dy}px) rotate(0) scale(${kind === "sell-flight" ? ".12" : ".6"})`,
            opacity: 0,
          },
        ],
        duration,
        0,
        () => el.remove(),
      );
    }
    const changed = changesBetween(before.pieces, pieces),
      contact = p.current?.attacker && !reduced ? COMBAT_MOTION.contact : 0;
    // Keep the old values and shield visible during the wind-up. Rules already resolved the attack.
    if (combat && contact) {
      const mask = new Map<string, Minion>();
      for (const m of before.pieces)
        if (pieces.some((n) => n.uid === m.uid)) mask.set(m.uid, m);
      setOverrides(mask);
      clock.at(contact, () => setOverrides(new Map()));
    }
    for (const c of changed) {
      const el = locate(c.uid),
        now = captures.get(c.uid),
        old = before.captures.get(c.uid),
        r = now?.rect || old?.rect;
      if (!r) continue;
      const attackerDestination =
        c.uid === p.current?.attacker
          ? captures.get(p.current?.target || "")?.rect
          : undefined;
      const travel =
        attackerDestination && !reduced
          ? {
              x: (point(attackerDestination).x - point(r).x) * 0.88,
              y: (point(attackerDestination).y - point(r).y) * 0.83,
            }
          : { x: 0, y: 0 };
      if (combat && c.damage) {
        label(r, `−${shortStat(c.damage)}`, "damage", contact, travel);
        clock.at(contact, () => {
          burst(
            new DOMRect(r.x + travel.x, r.y + travel.y, r.width, r.height),
            "hit",
          );
          if (el)
            animate(
              el,
              [{ filter: "brightness(2)" }, { filter: "brightness(1)" }],
              180,
            );
        });
      }
      if (combat && c.shieldBroken) {
        clock.at(contact, () => {
          burst(r, "shield");
          if (old && !reduced) {
            const shell = ghost(old);
            shell.className = "scene-ghost shield-shell";
            shell.replaceChildren();
            animate(
              shell,
              [
                { transform: "scale(1)", opacity: 1 },
                { transform: "scale(1.3,1.15)", opacity: 0.8, offset: 0.25 },
                { transform: "scale(1.6)", opacity: 0 },
              ],
              340,
              0,
              () => shell.remove(),
            );
          }
          playTableSound("shield", controls.current.sound);
        });
      }
      if (
        (c.health || c.attack > 0) &&
        !c.spawned &&
        before.game.phase === p.game.phase
      ) {
        const delay = combat ? contact : 120;
        label(r, `+${Math.max(0, c.attack)}/+${c.health}`, "buff", delay);
        clock.at(delay, () => burst(r, "buff"));
      }
      if (combat && before.game.phase === "combat" && c.dead && !el && old)
        clock.at(contact, () => playTableSound("death", controls.current.sound));
      if (
        combat &&
        before.game.phase === "combat" &&
        c.dead &&
        !el &&
        old &&
        !reduced
      ) {
        const cuts = [
          "polygon(0 0,100% 0,75% 47%,0 60%)",
          "polygon(100% 0,100% 100%,40% 100%,75% 47%)",
          "polygon(0 60%,75% 47%,40% 100%,0 100%)",
        ];
        cuts.forEach((clip, i) => {
          const g = ghost(old);
          g.style.clipPath = clip;
          animate(
            g,
            [
              {
                transform: "translate(0,0) rotate(0)",
                opacity: 1,
                filter: "brightness(.8)",
              },
              {
                transform: `translate(${(i - 1) * 24}px,${28 + i * 12}px) rotate(${(i - 1) * 20}deg) scale(.7)`,
                opacity: 0,
                filter: "brightness(.3)",
              },
            ],
            390,
            0,
            () => g.remove(),
          );
        });
        burst(r, "death");
      }
      if (el && !c.spawned && old && now && (!combat || !p.current?.attacker)) {
        const dx = old.rect.x - now.rect.x,
          dy = old.rect.y - now.rect.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2)
          animate(
            el,
            [
              { transform: `translate(${dx}px,${dy}px)` },
              { transform: "translate(0,0)" },
            ],
            300,
          );
      }
      if (el && c.spawned) {
        const origin = before.captures.get(c.uid);
        if (
          !combat &&
          origin &&
          before.game.hand.some((m) => m.uid === c.uid)
        ) {
          fly(origin, r, "play-flight", 340);
          animate(
            el,
            [
              { opacity: 0, transform: "scale(.2)" },
              { opacity: 1, transform: "scale(1.18)", offset: 0.75 },
              { opacity: 1, transform: "scale(1)" },
            ],
            310,
            150,
          );
          clock.at(330, () => burst(r, "buff"));
        } else
          animate(
            el,
            [
              { opacity: 0, transform: "scale(.2) rotateY(65deg)" },
              { opacity: 1, transform: "scale(1.13)", offset: 0.7 },
              { opacity: 1, transform: "scale(1)" },
            ],
            360,
            combat
              ? 160
              : p.game.refreshes > before.game.refreshes
                ? 130 + enemies.findIndex((m) => m.uid === c.uid) * 55
                : 0,
          );
      }
    }
    if (combat && p.current?.attacker && p.current.target) {
      const a = locate(p.current.attacker),
        t = locate(p.current.target),
        ar = captures.get(p.current.attacker)?.rect,
        tr = captures.get(p.current.target)?.rect;
      if (a && ar && tr) {
        const ap = point(ar),
          tp = point(tr),
          dx = (tp.x - ap.x) * 0.88,
          dy = (tp.y - ap.y) * 0.83;
        clock.at(reduced ? 0 : COMBAT_MOTION.windup, () =>
          playTableSound("attack", controls.current.sound));
        a.style.zIndex = "30";
        clock.cleanup(() => {
          a.style.zIndex = "";
        });
        animate(a, attackPath(dx, dy), COMBAT_MOTION.return, 0, () => {
          a.style.zIndex = "";
        });
        if (t)
          animate(
            t,
            [
              { transform: "translate(0,0)" },
              {
                transform: `translate(${dx * 0.035}px,${dy * 0.055}px) rotate(3deg)`,
                offset: 0.3,
              },
              { transform: "translate(0,0) rotate(-1deg)", offset: 0.7 },
              { transform: "translate(0,0)" },
            ],
            220,
            contact,
          );
        clock.at(contact, () => {
          playTableSound("hit", controls.current.sound);
          if (!reduced)
            animate(
              root,
              [
                { translate: "0 0" },
                { translate: "2px 1px", offset: 0.2 },
                { translate: "-2px -1px", offset: 0.45 },
                { translate: "1px 0", offset: 0.7 },
                { translate: "0 0" },
              ],
              130,
            );
        });
      }
    }
    if (
      combat &&
      p.frame === (p.game.battle?.frames.length || 0) - 1 &&
      p.game.battle?.damage
    ) {
      const won = p.game.battle.result === "win";
      const attacker = root.querySelector<HTMLElement>(
        won ? ".player-hero-token" : ".bartender",
      );
      const victim = root.querySelector<HTMLElement>(
        won ? ".bartender" : ".player-hero-token",
      );
      if (attacker && victim) {
        const ar = point(attacker.getBoundingClientRect()),
          vr = victim.getBoundingClientRect(),
          tr = point(vr),
          delay = reduced ? 0 : COMBAT_MOTION.contact;
        setHeroStruck(false);
        animate(
          attacker,
          attackPath((tr.x - ar.x) * 0.85, (tr.y - ar.y) * 0.8),
          COMBAT_MOTION.return,
        );
        label(vr, `−${p.game.battle.damage}`, "damage", delay);
        clock.at(delay, () => {
          setHeroStruck(true);
          burst(vr, "hit");
          playTableSound("heroHit", controls.current.sound);
        });
      }
    }
    if (combat && p.game.battle && p.frame === p.game.battle.frames.length - 1) {
      const result = p.game.battle.result;
      clock.at(p.game.battle.damage && !reduced ? COMBAT_MOTION.contact + 180 : 1, () =>
        playTableSound(result === "win" ? "win" : result === "loss" ? "lose" : "tie", controls.current.sound));
    }
    if (!combat && before.game.phase === "recruit") {
      const triple = p.game.triples > before.game.triples;
      if (triple) clock.at(reduced ? 0 : 440, () => playTableSound("triple", controls.current.sound));
      for (const m of p.game.hand) {
        if (before.game.hand.some((n) => n.uid === m.uid)) continue;
        const el = locate(m.uid),
          destination = captures.get(m.uid);
        if (!el || !destination) continue;
        const origin = before.captures.get(m.uid);
        if (origin && before.game.shop.some((n) => n.uid === m.uid)) {
          fly(origin, destination.rect, "buy-flight");
          animate(
            el,
            [
              { opacity: 0, transform: "scale(.6)" },
              { opacity: 1, transform: "scale(1)" },
            ],
            170,
            260,
          );
        } else if (triple && m.golden && !reduced) {
          const sources = [
            ...before.game.board,
            ...before.game.hand,
            ...before.game.shop,
          ].filter(
            (n) =>
              n.id === m.id &&
              !p.game.board.some((x) => x.uid === n.uid) &&
              !p.game.hand.some((x) => x.uid === n.uid) &&
              !p.game.shop.some((x) => x.uid === n.uid),
          );
          const dest = point(destination.rect),
            cx = bounds.x + bounds.width * 0.5,
            cy = bounds.y + bounds.height * 0.58;
          for (const source of sources) {
            const cap = before.captures.get(source.uid);
            if (!cap) continue;
            const g = ghost(cap),
              a = point(cap.rect);
            g.classList.add("triple-flight");
            animate(
              g,
              [
                { transform: "translate(0,0) scale(1)", opacity: 1 },
                {
                  transform: `translate(${cx - a.x}px,${cy - a.y}px) rotate(12deg) scale(.85)`,
                  opacity: 1,
                  offset: 0.55,
                },
                {
                  transform: `translate(${cx - a.x}px,${cy - a.y}px) scale(1.3)`,
                  opacity: 1,
                  offset: 0.65,
                },
                {
                  transform: `translate(${dest.x - a.x}px,${dest.y - a.y}px) scale(.3)`,
                  opacity: 0,
                },
              ],
              760,
              0,
              () => g.remove(),
            );
          }
          animate(
            el,
            [
              { opacity: 0, filter: "brightness(3)", transform: "scale(.5)" },
              { opacity: 1, filter: "brightness(1)", transform: "scale(1)" },
            ],
            240,
            600,
          );
          clock.at(440, () => {
            p.effects.current?.burst(cx, cy, "gold");
          });
        } else
          animate(
            el,
            [
              { opacity: 0, transform: "translateY(-30px) scale(.7)" },
              { opacity: 1, transform: "translateY(0) scale(1)" },
            ],
            300,
          );
      }
      if (!triple)
        for (const m of before.game.board) {
          if (
            p.game.board.some((n) => n.uid === m.uid) ||
            p.game.hand.some((n) => n.uid === m.uid)
          )
            continue;
          const c = before.captures.get(m.uid),
            bob = root.querySelector(".bartender")?.getBoundingClientRect();
          if (c && bob) {
            fly(c, bob, "sell-flight");
            clock.at(350, () => {
              burst(bob, "gold");
              label(bob, "+1", "coin");
            });
          }
        }
      // Refresh discards the old offers before the replacement cards settle.
      if (p.game.refreshes > before.game.refreshes)
        for (const m of before.game.shop) {
          const c = before.captures.get(m.uid);
          if (c && !reduced) {
            const g = ghost(c);
            animate(
              g,
              [
                { transform: "scale(1) rotateY(0)", opacity: 1 },
                { transform: "scale(.7) rotateY(85deg)", opacity: 0 },
              ],
              180,
              0,
              () => g.remove(),
            );
          }
        }
      if (p.game.frozen && !before.game.frozen)
        for (const m of p.game.shop) {
          const c = captures.get(m.uid);
          if (c) burst(c.rect, "ice");
        }
    }
    return () => clock.dispose();
  }, [p.game, p.current, p.frame, p.reset, p.root, p.layer, p.effects]);
  return { overrides, heroStruck };
}
