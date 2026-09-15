/** Export visible names for video label conversion without rebuilding the RL bridge. */
import { ALL_CARDS } from "../src/data";
import { SEASON_HEROES } from "../src/season/catalog";

process.stdout.write(JSON.stringify({
  cards: ALL_CARDS.map(card => ({ id: card.id, name: card.name })),
  heroes: SEASON_HEROES.map(hero => ({ id: hero.id, name: hero.name })),
}, null, 2) + "\n");
