import { previewMinions, previewSpells } from "./preview-catalog";
import snapshot from "./snapshot.json" with { type: "json" };
import aiHeroPool from "./ai-hero-pool.json" with { type: "json" };
import type { CardDef, Hero, Tribe, Keyword, Ability } from "../data";
import { expandedMinions, expandedSpells } from "./expanded-catalog";
import { expandedHeroKeys, expandedPassiveHeroes } from "./expanded-heroes";
import { trinketMinions, trinketSpells } from "./trinket-card-effects";
import trinketDependencies from "./trinket-dependencies.json" with { type: "json" };
import currentRules from "./current-rules.json" with { type: "json" };
export const SEASON_META = snapshot.meta;
export const PREFIX = "s14_";
const races: Record<string, Tribe> = {
  BEAST: "野兽",
  DEMON: "恶魔",
  DRAGON: "龙",
  ELEMENTAL: "元素",
  MECHANICAL: "机械",
  MURLOC: "鱼人",
  NAGA: "纳迦",
  PIRATE: "海盗",
  QUILBOAR: "野猪人",
  UNDEAD: "亡灵",
  ABERRATION: "畸变怪",
  ALL: "全部",
};
const keywords: Record<string, Keyword> = {
  TAUNT: "嘲讽",
  DIVINE_SHIELD: "圣盾",
  REBORN: "复生",
  WINDFURY: "风怒",
  POISONOUS: "剧毒",
  VENOMOUS: "烈毒",
  STEALTH: "潜行",
};
const A = (
  event: string,
  op: string,
  rest: Partial<Ability> = {},
): Ability => ({ event, op, ...rest });
const b = (
  event: string,
  attack: number,
  health: number,
  target = "self",
  tribe?: string,
) => A(event, "buff", { attack, health, target, tribe });
const spell = (event: string, id: string, amount = 1) =>
  A(event, "spell", { id, amount });
const summon = (event: string, id: string, amount = 1) =>
  A(event, "summon", { id, amount });
const summonMore = (event: string, id: string, amount = 1) =>
  A(event, "summon", { id, amount, goldenAmount: amount * 2, summonGolden: false });
const stat = (event: string, key: string, attack: number, health: number) =>
  A(event, "scale", { key, attack, health });
// Only explicitly implemented cards can enter the playable pool. The complete snapshot remains browsable.
const effects: Record<string, Ability[]> = {
  ...expandedMinions,
  ...trinketMinions,
  BG26_146: [b("end", 0, 1)],
  BG20_104: [A("rally", "gem", { target: "others" })],
  BG27_002: [spell("battlecry", "BG27_002t", 2)],
  BG27_080: [A("death", "buff", { attack: 3, health: 3, target: "menagerie", permanent: true })],
  BG28_550: [A("battlecry", "discoverSpell")],
  BG32_111: [A("battlecry", "generate", { id: "BG28_888" }), A("death", "generate", { id: "BG28_888" })],
  BG36_241: [A("rally", "castTavern", { id: "BG36_246" })],
  BG36_243: [A("activate", "rally", { target: "selected" })],
  BG26_354: [A("combat", "handStats")],
  BG32_341: [A("aura", "spellAura", { attack: 1, health: 2 })],
  BG20_100: [spell("battlecry", "BG20_GEM", 2)],
  BG23_000: [A("spellcraft", "craft", { attack: 2, health: 0 })],
  BG25_001: [],
  BG28_300: [summonMore("death", "BG_ICC_026t", 2)],
  BG29_611: [summon("death", "BG_BOT_312t")],
  BG29_888: [b("rally", 2, 0)],
  BG31_330: [A("battlecry", "discountSpell", { amount: 1 })],
  BG31_803: [summonMore("death", "BG28_603t")],
  BG33_140: [A("sell", "draw", { tier: 1 })],
  BG33_886: [A("rally", "gem", { target: "self" })],
  BG36_200: [summonMore("rally", "BG36_200t")],
  BG36_345: [b("activate", 3, 3, "selected")],
  BG36_921: [b("targetSpell", 0, 1)],
  BGS_004: [A("playDemon", "weaver", { attack: 2, health: 2 })],
  BGS_119: [],
  BGS_127: [b("playElemental", 0, 1)],
  BG26_135: [A("battlecry", "goldNext", { amount: 1 })],
  BG20_101: [spell("rally", "BG20_GEM")],
  BG21_015: [A("combat", "keep")],
  BG22_202: [A("sell", "draw", { tribe: "鱼人" })],
  BG23_002: [spell("battlecry", "BG28_810")],
  BG23_357: [
    A("battlecry", "consume", { target: "selected", tribe: "恶魔", amount: 1 }),
  ],
  BG25_011: [stat("battlecry", "undead", 1, 0)],
  BG25_022: [b("death", 1, 2, "random", "亡灵")],
  BG26_174: [A("heroDamage", "rewind", { health: 2 })],
  BG26_805: [stat("combat", "beastCombat", 1, 0)],
  BG26_963: [
    b("battlecry", 1, 1, "others", "龙"),
    b("combat", 1, 1, "others", "龙"),
  ],
  BG29_810: [
    A("combat", "buff", {
      attack: 1,
      health: 2,
      target: "left",
      tribe: "龙",
      keyword: "风怒",
    }),
  ],
  BG31_177: [b("summonMech", 3, 1, "event")],
  BG31_801: [stat("battlecry", "beetle", 2, 1), summonMore("death", "BG28_603t")],
  BG31_816: [A("sell", "baller", { attack: 1, health: 0 })],
  BG31_818: [A("sell", "baller", { attack: 0, health: 1 })],
  BG32_170: [spell("death", "EBG_Spell_014")],
  BG36_354: [A("activate", "stealHighest")],
  BG36_342: [A("activate", "discoverSpell")],
  BGS_115: [A("sell", "generate", { id: "BGS_115t" })],
  BG23_004: [
    A("spellcraft", "craft", { attack: 2, health: 6, keyword: "嘲讽" }),
  ],
  BG23_008: [
    A("spellcraft", "craft", { attack: 0, health: 0, keyword: "圣盾" }),
  ],
  BG24_500: [
    A("combat", "buff", {
      attack: 2,
      health: 2,
      target: "random",
      tribe: "龙",
      keyword: "圣盾",
    }),
  ],
  BG25_010: [summonMore("death", "BG25_010t")],
  BG26_147: [A("start", "gold", { amount: 1 })],
  BG26_524: [A("refresh", "healthRefresh", { amount: 2 })],
  BG27_005: [b("tavernSpell", 1, 0, "all")],
  BG28_309: [
    A("death", "buff", {
      target: "random",
      tribe: "亡灵",
      keyword: "复生",
      attack: 0,
      health: 0,
    }),
  ],
  BG29_816: [b("attackDragon", 3, 1, "event")],
  BG30_125: [summonMore("death", "BG_ICC_026t", 3)],
  BG31_326: [spell("end", "BG31_893")],
  BG31_843: [b("sellElemental", 4, 4)],
  BG33_323: [stat("rally", "undead", 1, 0)],
  BG33_830: [stat("battlecry", "spell", 1, 0)],
  BG33_924: [stat("rally", "spell", 0, 1)],
  BG34_865: [stat("battlecry", "refresh", 10, 10)],
  BG34_856: [stat("death", "refresh", 4, 4)],
  BG36_202: [A("death", "lobster")],
  BG36_207: [b("rally", 4, 1, "others")],
  BG36_346: [spell("activate", "BG28_897", 2)],
  BG36_507: [A("activate", "draw", { tribe: "鱼人" })],
  BG36_509: [A("activate", "goldNext", { amount: 2 })],
  BG36_730: [A("death", "fodder", { amount: 3 })],
  BG35_150: [A("battlecry", "fodder", { amount: 3 })],
  BG36_854: [spell("death", "BG36_624")],
  BG_BOT_911: [],
  BG_DEEP_015: [],
  BGS_071: [
    A("summonMechCombat", "buff", { attack: 2, health: 0, keyword: "圣盾" }),
  ],
  BGS_131: [],
  BG26_817: [A("combat", "cleave")],
  BG26_802: [A("summonBeastCombat", "doubleAttack", { target: "event" })],
  BG32_880: [stat("death", "spell", 1, 0)],
  BG32_873: [
    A("heroDamage", "rewind", { attack: 2, health: 2, target: "shop" }),
  ],
  BG34_500: [A("end", "consume", { amount: 1, target: "self", highest: true })],
  BG36_181: [A("sell", "baller", { attack: 2, health: 2 })],
  BG36_204: [A("rally", "draw", { tribe: "野兽" })],
  BG36_210: [summon("rally", "BG36_202")],
  BG36_211: [b("attackBeast", 2, 1, "all", "野兽")],
  BG36_245: [spell("combat", "BG28_168", 2)],
  BG36_503: [
    A("activate", "consume", { target: "all", tribe: "恶魔", amount: 1 }),
  ],
  BG36_620: [A("combat", "damageAll", { amount: 3 })],
  BG36_701: [A("activate", "battlecry", { target: "selected" })],
  BG36_703: [b("targetSpell", 8, 8, "handLeft")],
  BG36_731: [spell("death", "BG36_880")],
  BG36_760: [spell("death", "BG28_518")],
  BG36_764: [A("end", "randomSpell", { amount: 2, cost: 1 })],
  BGS_116: [A("battlecry", "freeRefresh", { amount: 2 })],
  BGS_123: [A("battlecry", "draw", { tribe: "元素" })],
  BG21_004: [A("playDemon", "consume", { target: "self", amount: 1 })],
  BG25_354: [A("aura", "titus")],
  BG26_148: [A("death", "draw", { magnetic: true })],
  BG26_162: [
    stat("battlecry", "elementalShop", 8, 8),
    stat("death", "elementalShop", 8, 8),
  ],
  BG26_523: [b("heroDamage", 4, 4, "all", "恶魔")],
  BG26_ICC_901: [A("aura", "drakkari")],
  BG28_741: [b("tavernSpell", 4, 0, "shielded")],
  BG31_809: [stat("death", "beetle", 5, 5), summonMore("death", "BG28_603t")],
  BG32_820: [spell("battlecry", "BG28_168"), spell("death", "BG28_168")],
  BG32_821: [stat("end", "spell", 1, 1)],
  BG32_835: [
    A("spellcraft", "craftScale", { key: "spell", attack: 1, health: 1 }),
  ],
  BG33_318: [
    A("rally", "buff", {
      target: "random",
      tribe: "鱼人",
      attack: 0,
      health: 0,
      keyword: "烈毒",
    }),
  ],
  BG33_883: [A("rally", "gem", { target: "self", amount: 3, permanent: true })],
  BG33_885: [stat("rally", "gem", 1, 2)],
  BG35_152: [stat("battlecry", "lowShop", 3, 3)],
  BG36_704: [b("spellMurloc", 3, 3, "boardAndHand", "鱼人")],
  BG36_762: [stat("targetSpell", "shop", 2, 2)],
  BG_LOE_077: [A("aura", "brann")],
  BGS_018: [stat("death", "beastCombat", 7, 7)],
  BGS_041: [b("battlecryTriggered", 2, 2, "all", "龙")],
  BGS_104: [stat("playElemental", "elementalShop", 4, 4)],
  BG23_017: [stat("battlecry", "gem", 2, 1), stat("death", "gem", 2, 1)],
  BG24_004: [A("combat", "immuneAttack")],
  BG28_595: [A("end", "randomSpell", { amount: 2 })],
  BG32_846: [b("playElemental", 2, 3, "all", "元素")],
  BG34_692: [stat("tavernSpell", "undead", 3, 0)],
  BG35_155: [A("sellMinion", "fodder", { amount: 1 })],
  BG36_356: [
    A("activate", "setStats", {
      target: "selected",
      attack: 50,
      health: 50,
      noScale: true,
    }),
  ],
  BG36_622: [b("spellNaga", 2, 3, "all")],
  BG36_640: [spell("targetSpell", "BG28_888")],
};
const spellEffects: Record<string, Ability[]> = {
  ...expandedSpells,
  ...trinketSpells,
  EBG_Spell_037: [A("cast", "replacePower")],
  BG33_101: [A("cast", "discoverMinion", { tier: 1 })],
  BG28_882: [A("cast", "discoverMinion", { key: "DEATHRATTLE" })],
  BG28_GIL_836: [A("cast", "discoverMinion", { key: "BATTLECRY" })],
  BG28_521: [A("cast", "majorityDiscover")],
  BG33_814: [A("cast", "majorityDraw")],
  BG31_819: [A("cast", "drawId", { id: "BG31_816" }), A("cast", "drawId", { id: "BG31_818" })],
  BG28_845: [A("cast", "buffType", { attack: 2, health: 1, target: "selected" })],
  BG28_830: [A("cast", "golden")],
  EBG_Spell_017: [A("cast", "golden", { target: "selected", tier: 4 })],
  BG27_002t: [A("cast", "buff", { attack: 1, health: 1, target: "selected", keyword: "嘲讽" })],
  BG28_168: [b("cast", 1, 1, "all")],
  BG28_169: [b("cast", 2, 2, "all"), b("cast", 2, 2, "all")],
  BG28_500: [A("cast", "armor", { amount: 5 })],
  BG28_503: [
    A("cast", "buff", {
      attack: 0,
      health: 3,
      target: "selected",
      keyword: "嘲讽",
    }),
  ],
  BG28_504: [A("cast", "draw", { tier: 1 })],
  BG28_512: [A("cast", "steal")],
  BG28_518: [A("cast", "drawType", { target: "selected" })],
  BG28_520: [
    A("cast", "buff", {
      attack: 1,
      health: 2,
      target: "selected",
      keyword: "嘲讽",
      toggle: true,
    }),
  ],
  BG28_800: [A("cast", "goldNext", { amount: 2 })],
  BG28_805: [A("cast", "goldCap", { amount: 1 })],
  BG28_810: [A("cast", "gold", { amount: 1 })],
  BG28_825: [
    A("cast", "buff", {
      attack: 7,
      health: 7,
      target: "selected",
      keyword: "嘲讽",
    }),
  ],
  BG28_827: [A("cast", "freeRefresh", { amount: 2 })],
  BG28_838: [
    A("cast", "setStats", {
      target: "selected",
      attack: 20,
      health: 20,
      noScale: true,
    }),
  ],
  BG28_886: [stat("cast", "shop", 2, 2)],
  BG28_888: [b("cast", 4, 4, "menagerie")],
  BG28_897: [b("cast", 2, 2, "selected")],
  BG28_966: [b("cast", 1, 2, "shop")],
  BG33_811: [A("cast", "buff", { attack: 0, health: 4, target: "randomFour" })],
  BG33_812: [A("cast", "buff", { attack: 4, health: 0, target: "randomFour" })],
  BG33_813: [b("cast", 6, 6, "left")],
  BG33_815: [A("cast", "gold", { amount: 2 })],
  BG34_444: [stat("cast", "refresh", 8, 8)],
  BG34_990: [b("cast", 3, 2, "all"), b("cast", 3, 2, "golden")],
  BG35_149: [b("cast", 2, 2, "selected"), b("cast", 2, 2, "all", "鱼人")],
  BG35_922: [b("cast", 2, 2, "all"), b("cast", 2, 2, "all", "纳迦")],
  BG35_951: [A("cast", "buff", { attack: 1, health: 2, target: "randomFour" })],
  BG36_246: [
    b("cast", 3, 2, "all"),
    b("cast", 3, 2, "all", "龙"),
    b("cast", 3, 2, "shielded"),
  ],
  BG36_624: [b("cast", 4, 8, "selected")],
  BG36_880: [
    A("cast", "consume", {
      target: "selected",
      tribe: "恶魔",
      amount: 2,
      keywords: true,
    }),
  ],
  BG28_607: [
    A("cast", "consume", { target: "selected", tribe: "恶魔", amount: 3 }),
  ],
  BG36_884: [spell("cast", "EBG_Spell_014", 3)],
  BG20_GEM: [A("cast", "gem", { target: "selected" })],
  EBG_Spell_014: [b("cast", 4, 0, "selected")],
  BG31_320t2: [A("cast", "generate", { id: "BG31_893" })],
};
type RawCard = {
  id: string;
  name: string;
  tier: number;
  attack: number;
  health: number;
  cost: number;
  text: string;
  races: string[];
  mechanics: string[];
  goldenText?: string;
  goldenAttack?: number;
  goldenHealth?: number;
  school?: string;
};
const relatedById = new Map(snapshot.related.map((c) => [c.id, c]));
function convert(
  c: RawCard,
  kind: CardDef["kind"] = "minion",
  token = false,
): CardDef {
  const abilities = kind === "spell" ? (previewSpells[c.id] ?? spellEffects[c.id]) : (previewMinions[c.id] ?? effects[c.id]);
  const ks = (c.mechanics || []).map((k) => keywords[k]).filter(Boolean);
  const goldenChoice = kind === "spell" ? relatedById.get(c.id.replace(/t(\d*)$/, "_Gt$1")) : undefined;
  return {
    id: PREFIX + c.id,
    sourceId: c.id,
    name: c.name,
    tier: c.tier,
    attack: c.attack,
    health: c.health,
    cost: c.cost,
    tribe: races[c.races[0]] || "无",
    races: c.races.map((r) => races[r]).filter(Boolean),
    text: c.text,
    goldenText: c.goldenText || goldenChoice?.text || c.text,
    goldenAttack: c.goldenAttack ?? c.attack * 2,
    goldenHealth: c.goldenHealth ?? c.health * 2,
    keywords: ks,
    mechanics: c.mechanics,
    token,
    kind,
    spellSchool: c.school,
    season: true,
    playable: abilities !== undefined,
    abilities: abilities || [],
    magnetic: c.mechanics.includes("MAGNETIC"),
    activateCost: Number(c.text.match(/发动（(\d+)）/)?.[1] ?? 0),
  };
}
export const SEASON_CATALOG: CardDef[] = snapshot.minions.map((c) =>
  convert(c),
);
export const SEASON_CARDS = SEASON_CATALOG.filter((c) => c.playable);
export const SEASON_SPELL_CATALOG: CardDef[] = snapshot.spells.map((c) =>
  convert(c, "spell"),
);
export const SEASON_SPELLS = SEASON_SPELL_CATALOG.filter((c) => c.playable);
export const SEASON_RELATED: CardDef[] = [...snapshot.related, ...trinketDependencies.cards].map((c) =>
  convert(c, c.attack || c.health ? "minion" : "spell", true),
);
const heroKeys: Record<string, string> = {
  ...expandedHeroKeys,
  BG36_HERO_000: "drestagath",
  BG36_HERO_002: "kithix",
  TB_BaconShop_HERO_40: "finley",
  BG20_HERO_202: "nguyen",
  BG35_HERO_001: "genn",
  TB_BaconShop_HERO_22: "lich",
  TB_BaconShop_HERO_15: "george",
  TB_BaconShop_HERO_34: "patchwerk",
  TB_BaconShop_HERO_39: "pyramid",
  TB_BaconShop_HERO_17: "millificent",
  TB_BaconShop_HERO_57: "nozdormu",
  TB_BaconShop_HERO_74: "omu",
  TB_BaconShop_HERO_76: "alakir",
  BG26_HERO_101: "hoggarr",
  BG28_HERO_801: "hollidae",
  BG36_HERO_105: "xavius",
  BG20_HERO_101: "xyrella",
  TB_BaconShop_HERO_41: "reno",
  TB_BaconShop_HERO_42: "elise",
  TB_BaconShop_HERO_56: "alexstrasza",
  BG20_HERO_103: "blackthorn",
  BG26_HERO_102: "inge",
  TB_BaconShop_HERO_49: "millhouse",
  TB_BaconShop_HERO_78: "chenvaala",
};
export const SEASON_HERO_DEFINITIONS: Hero[] = [...snapshot.heroes, ...snapshot.retiredHeroes]
  .filter((h) => heroKeys[h.id])
  .map((h) => ({
    id: PREFIX + heroKeys[h.id],
    name: h.name,
    title: "第14赛季 · " + h.armor + "护甲",
    power: h.power.name!,
    text: h.power.text!,
    cost: h.power.cost,
    health: h.health,
    armor: h.armor,
    art: h.id,
    passive: expandedPassiveHeroes.has(heroKeys[h.id]) || [
      "finley", "nguyen", "genn",
      "patchwerk",
      "nozdormu",
      "omu",
      "alakir",
      "hoggarr",
      "xavius",
      "millhouse",
      "chenvaala",
    ].includes(heroKeys[h.id]),
  }));
export const SEASON_HEROES = SEASON_HERO_DEFINITIONS.filter(h => !currentRules.heroBans.includes(h.art));
export const AI_HERO_POOL = aiHeroPool;
const aiHeroIds = new Set(aiHeroPool.heroes.map(h => h.id));
export const AI_SEASON_HEROES = SEASON_HEROES.filter(h => aiHeroIds.has(h.id));
if (aiHeroIds.size !== aiHeroPool.heroes.length || AI_SEASON_HEROES.length !== aiHeroIds.size || aiHeroIds.size < 8)
  throw new Error("AI hero pool must contain at least eight distinct implemented heroes");
export const HERO_TRIBES: Record<string, Tribe> = {
  s14_drestagath: "畸变怪",
  s14_millificent: "机械",
  s14_hoggarr: "海盗",
  s14_alexstrasza: "龙",
  s14_blackthorn: "野猪人",
  s14_chenvaala: "元素",
  s14_patches: "海盗", s14_ysera: "龙", s14_flurgl: "鱼人", s14_jailer: "亡灵",
};
export const SEASON_HERO_CATALOG = snapshot.heroes;
export const RAW_GIFTS = snapshot.gifts;
export const RAW_TRINKETS = snapshot.trinkets;
export const SUPPORTED_COUNT = SEASON_CARDS.length;
export const ALL_TRIBES: Tribe[] = [
  "野兽",
  "恶魔",
  "龙",
  "元素",
  "机械",
  "鱼人",
  "畸变怪",
  "海盗",
  "野猪人",
  "亡灵",
];
export const GIFT_IDS = [
  "78", "88", "89", "90",
  "13",
  "73",
  "74",
  "75",
  "51",
  "11",
  "18",
  "7",
  "71",
  "69",
  "72",
  "60",
  "82",
  "10",
  "16",
  "52",
  "5",
  "80",
  "22",
  "14",
  "4",
];
export const GIFTS = RAW_GIFTS.filter((g) =>
  GIFT_IDS.some((n) => g.id === "BG36_MidGameEffect_000t" + n) && !currentRules.bannedGifts.includes(g.id),
);
