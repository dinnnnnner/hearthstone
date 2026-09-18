import fs from "node:fs";
import { SEASON_META, SEASON_CATALOG, SEASON_CARDS, SEASON_SPELL_CATALOG, SEASON_SPELLS, SEASON_HERO_CATALOG, SEASON_HEROES, GIFTS, RAW_GIFTS } from "../src/season/catalog";
import { TRINKETS } from "../src/season/engine";
import trinketPool from "../src/season/trinket-pool.json";
import currentRules from "../src/season/current-rules.json";

const report = {
  patch: SEASON_META.patch,
  build: SEASON_META.build,
  preview: currentRules.preview,
  scheduledRelease: currentRules.scheduledRelease,
  verifiedAsOf: currentRules.asOf,
  bannedMinions: currentRules.bannedMinions,
  scope: "Solo Tier 1–6 recruit pool; no Duos. Implementation coverage is not proof of exact official event ordering.",
  minions: { implemented: SEASON_CARDS.length, total: SEASON_CATALOG.length },
  tavernSpells: { implemented: SEASON_SPELLS.length, total: SEASON_SPELL_CATALOG.length },
  heroes: { implemented: SEASON_HEROES.length, total: SEASON_HERO_CATALOG.length },
  darkGifts: { implemented: GIFTS.length, snapshotTotal: RAW_GIFTS.length, banned: currentRules.bannedGifts },
  trinkets: {
    implemented: TRINKETS.length,
    officialPoolVerified: false,
    deferred: trinketPool.deferred,
    dependencyLimitations: ["Timewarped Lei currently generates the Curator's Buddy only and is excluded for other Hero Powers."],
    details: "docs/trinkets.md",
  },
  missingHeroes: SEASON_HERO_CATALOG.filter((h) => !SEASON_HEROES.some((p) => p.art === h.id)).map((h) => ({ id: h.id, name: h.name, power: h.power.text })),
  missingDarkGifts: RAW_GIFTS.filter((g) => !currentRules.bannedGifts.includes(g.id) && !GIFTS.some((x) => x.id === g.id)).map((g) => ({ id: g.id, name: g.name, text: g.text })),
};
fs.writeFileSync("docs/rules-coverage.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ minions: report.minions, spells: report.tavernSpells, heroes: report.heroes }));
