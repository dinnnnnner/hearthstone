import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useGameSound } from "../../src/table/useGameSound";
import type { Game } from "../../src/engine";

export function soundHarness() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness({ game, frame, place }: { game: Game; frame: number; place?: number }) {
    useGameSound(game, frame, true, true, false, true, place);
    return null;
  }
  return {
    update(game: Game, frame = 0, place?: number) {
      flushSync(() => root.render(<Harness game={game} frame={frame} place={place} />));
    },
    close() { root.unmount(); host.remove(); },
  };
}
