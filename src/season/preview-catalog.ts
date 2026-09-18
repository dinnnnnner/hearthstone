import type { Ability } from '../data';
const a = (event: string, op: string, rest: Partial<Ability> = {}): Ability => ({ event, op, ...rest });
const custom = (...events: string[]) => events.map(e => a(e, 'preview'));
const buff = (event: string, attack: number, health: number, target = 'self', tribe?: string) => a(event, 'buff', { attack, health, target, tribe });
const grant = (event: string, id: string, amount = 1) => a(event, 'generate', { id, amount });
const discard = () => a('activate', 'preview', { target: 'selectedHand' });
export const previewMinions: Record<string, Ability[]> = {
  BG36_097: [buff('discard', 3, 3, 'others')],
  BG36_098: [grant('sell', 'BGFYM_002t')],
  BG36_099: [discard()], BG36_100: custom('sell'),
  BG36_101: [a('death', 'randomSpell', { cost: 1 })],
  BG36_102: custom('afterAttack'),
  BG36_103: [grant('battlecry', 'BG36_371'), grant('death', 'BG36_371')],
  BG36_104: [a('death', 'scale', { key: 'spell', health: 4 })],
  BG36_106: custom('discard'), BG36_108: custom('tavernSpell'), BG36_109: [],
  BG36_110: custom('battlecry'), BG36_111: custom('tavernSpell'),
  BG36_112: [grant('battlecry', 'BG36_301t')], BG36_113: custom('death'),
  BG36_114: custom('end'), BG36_115: [grant('death', 'BG36_301t')],
  BG36_116: [a('death', 'summon', { id: 'BGFYM_002t', goldenAmount: 2, summonGolden: false }), buff('death', 1, 0, 'all')],
  BG36_300: [discard()], BG36_308: custom('sell'), BG36_311: [discard()], BG36_312: [discard()],
  BG36_318: custom('death'), BG36_320: custom('end'),
  BG36_360t3: [buff('cardPlayed', 2, 0)],
  BG36_360t4: [a('aura', 'tripleShield')], BG36_360t5: custom('rally'),
  BG36_360t6: [a('aura', 'globalStats', { key: 'battlecries', attack: 2, health: 2 })], BG36_360t9: custom('death'),
  BG36_362: custom('death', 'activate'), BG36_364: custom('combat', 'shieldLost'),
  BG36_366: custom('end'), BG36_367: custom('buyMinion', 'buy'), BG36_369: custom('sell'),
  BG36_370: custom('activate'), BG36_700: [a('activate', 'preview', { target: 'selected', tribe: '鱼人' })],
  BG36_848: [a('avenge', 'preview', { threshold: 4 })], BG36_849: [buff('rally', 0, 0), ...custom('rally', 'combat')],
  BGFYM_000: custom('awaken'), BGFYM_011: custom('death'), BGFYM_005: custom('discard'), BGFYM_002t: [],
  BG34_170: custom('battlecry'), BG34_171: custom('death'),
  BG34_170t: custom('volumizer'), BG34_170t2: custom('volumizer'), BG34_170t3: custom('volumizer'),
  BGS_034: [], BG31_149: custom('battlecry'),
  BG31_815: [a('battlecry', 'scale', { key: 'elementalShop', attack: 1, health: 1 })],
  BG32_231: custom('battlecry'), BG35_882: custom('battlecry'), BGS_008: custom('death'),
  BG32_336: [grant('battlecry', 'BG32_337'), grant('death', 'BG32_337')],
  BG31_148: custom('battlecry'), BG30_121: [], BG31_812: custom('playElemental'),
  BG27_000: [grant('battlecry', 'BG28_503', 2)],
  BG35_881: [grant('battlecry', 'BG35_911'), grant('death', 'BG35_911')],
  BG28_707: [a('tavernSpell', 'scale', { key: 'elementalShop', attack: 3, health: 2 })],
  BG28_582: [discard()], BGS_040: custom('death'),
  BG34_405: [a('avenge', 'preview', { threshold: 3 })],
  BG32_860: [a('sell', 'scale', { key: 'spell', attack: 1, health: 1 })],
  BG31_810: custom('combat', 'playElemental'), BG22_403: custom('end'),
};
export const previewSpells: Record<string, Ability[]> = {
  BG32_337: [a('cast', 'preview', { target: 'selected' })],
  BG35_910: [a('cast', 'preview', { target: 'selected' })],
  BG35_911: [a('cast', 'preview', { target: 'selected', tribe: '元素' })],
  BG34_272: custom('cast'),
  BG32_MagicItem_892t: [a('cast', 'preview', { target: 'selected', tribe: '鱼人' })],
  BG36_301t: [buff('cast', 1, 1, 'all'), ...custom('discarded')],
  BG36_303: [a('cast', 'gold', { amount: 2 }), a('discarded', 'goldCap', { amount: 2 })],
  BG36_371: custom('cast', 'discarded'),
  BG36_MagicItem_417t: [a('cast', 'preview', { target: 'selected' })],
};

// Preserve source behavior when a Deathrattle is copied onto another minion.
for (const [id, abilities] of Object.entries({ ...previewMinions, ...previewSpells }))
  for (const ability of abilities) if (ability.op === "preview") ability.key = id;
