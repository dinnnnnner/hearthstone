import type { Game } from "../engine";
import "./match-tribes.css";

export function MatchTribes({ game }: { game: Game }) {
  if (!game.season) return null;
  return (
    <section className="match-tribes" aria-label="本局种族">
      <span className="match-tribes-label">本局种族</span>
      <ul>
        {game.season.tribes.map((tribe) => <li key={tribe}>{tribe}</li>)}
      </ul>
    </section>
  );
}
