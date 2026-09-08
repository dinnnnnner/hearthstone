import { useEffect, useState } from "react";
import { art, HEROES } from "../data";
import type { Game } from "../engine";
const prepared = new Set<string>();
function sceneAssets(game: Game) {
  const hero = HEROES.find((h) => h.id === game.hero);
  const ids = [
    hero?.art,
    "TB_BaconShopBob",
    ...[
      ...game.board,
      ...game.shop,
      ...game.hand,
      ...(game.season?.spellShop || []),
      ...(game.battle?.frames[0]?.enemies || []),
    ].map((m) => m.id),
    ...game.opponents.map((p) => HEROES.find((h) => h.id === p.hero)?.art),
    ...(game.season?.trinkets || []),
  ].filter((id): id is string => !!id);
  return [...new Set(ids.map(art))].filter((url) => !prepared.has(url));
}
export function useSceneReady(game: Game) {
  // Only the entrance waits for assets; subsequent gameplay never waits for artwork.
  const [urls] = useState(() => sceneAssets(game));
  const [ready, setReady] = useState(!urls.length);
  const [completed, setCompleted] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (ready) return;
    let cancelled = false,
      cursor = 0,
      settled = 0;
    const pending = new Set<() => void>();
    const load = (url: string) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        const cancel = () => {
          img.onload = img.onerror = null;
          img.src = "";
          resolve();
        };
        pending.add(cancel);
        const finish = (ok: boolean) => {
          pending.delete(cancel);
          img.onload = img.onerror = null;
          if (ok) prepared.add(url);
          if (!cancelled) setCompleted(++settled);
          resolve();
        };
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        img.src = url;
      });
    const worker = async () => {
      while (!cancelled && cursor < urls.length) await load(urls[cursor++]);
    };
    void Promise.all(
      Array.from({ length: Math.min(3, urls.length) }, worker),
    ).then(() => {
      if (!cancelled) setReady(true);
    });
    const slowTimer = setTimeout(() => setSlow(true), 3000);
    const limit = setTimeout(() => setReady(true), 8000);
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      clearTimeout(limit);
      pending.forEach((cancel) => cancel());
    };
  }, [urls, ready]);
  return {
    ready,
    completed,
    total: urls.length,
    slow,
    enter: () => setReady(true),
  };
}
