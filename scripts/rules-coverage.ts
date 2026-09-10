import fs from "node:fs";
import { SEASON_META, SEASON_CATALOG, SEASON_CARDS, SEASON_SPELL_CATALOG, SEASON_SPELLS, SEASON_HERO_CATALOG, SEASON_HEROES, GIFTS, RAW_GIFTS } from "../src/season/catalog";
import { TRINKETS } from "../src/season/engine";

const report = {
  patch: SEASON_META.patch,
  build: SEASON_META.build,
  scope: "Solo Tier 1–6 recruit pool; no Duos. Implementation coverage is not proof of exact official event ordering.",
  minions: { implemented: SEASON_CARDS.length, total: SEASON_CATALOG.length },
  tavernSpells: { implemented: SEASON_SPELLS.length, total: SEASON_SPELL_CATALOG.length },
  heroes: { implemented: SEASON_HEROES.length, total: SEASON_HERO_CATALOG.length },
  darkGifts: { implemented: GIFTS.length, snapshotTotal: RAW_GIFTS.length },
  trinkets: { implemented: TRINKETS.length, officialPoolVerified: SEASON_META.trinketPoolVerified },
  missingHeroes: SEASON_HERO_CATALOG.filter((h) => !SEASON_HEROES.some((p) => p.art === h.id)).map((h) => ({ id: h.id, name: h.name, power: h.power.text })),
  missingDarkGifts: RAW_GIFTS.filter((g) => !GIFTS.some((x) => x.id === g.id)).map((g) => ({ id: g.id, name: g.name, text: g.text })),
};
fs.writeFileSync("docs/rules-coverage.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ minions: report.minions, spells: report.tavernSpells, heroes: report.heroes }));
