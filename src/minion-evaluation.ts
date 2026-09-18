/** Shared rule points for shop, hand and board; never a price or win probability. */
import { getDef } from './data';

export const DEFAULT_WEIGHTS = Object.freeze({
  attack: 1, health: 1, shieldAttack: 1, windfuryAttack: .5, rebornBody: .5,
  handPotential: .25, gold: 1, minionAsset: 1, nextIncome: .8,
  freeRefresh: .5, spellDiscount: .5, tier: 3,
});
export type BasicWeights = { [Key in keyof typeof DEFAULT_WEIGHTS]: number };

export function evaluateMinion(id: string, details: Record<string, unknown>, w: BasicWeights = DEFAULT_WEIGHTS) {
  const def = getDef(id), minion = !def.kind || def.kind === 'minion';
  const stat = (key: string) => {
    const value = details[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error(`Invalid nonnegative card ${key}`);
    return value;
  };
  const attack = minion ? stat('attack') : 0, health = minion ? stat('health') : 0;
  const keywords = Array.isArray(details.keywords) ? details.keywords as string[] : [];
  // Current stats already include applied buffs. Do not award them again to their source.
  const body = attack * w.attack + health * w.health;
  const shield = minion && keywords.includes('圣盾') ? attack * w.shieldAttack : 0;
  const windfury = minion && keywords.includes('风怒') ? attack * w.windfuryAttack : 0;
  const printedAttack = details.golden ? def.goldenAttack ?? def.attack * 2 : def.attack;
  const reborn = minion && (keywords.includes('复生') || details.rebornNext)
    ? (printedAttack * w.attack + w.health) * w.rebornBody : 0;
  const keywordBonus = shield + windfury + reborn;
  const abilities = [...(def.abilities || []), ...(Array.isArray(details.extraAbilities) ? details.extraAbilities : [])];
  const unpricedAbilities = abilities.map(a => `${a.event}:${a.op}`);
  const unpricedKeywords = keywords.filter(k => ['剧毒', '烈毒', '潜行', '嘲讽'].includes(k));
  return { id, name: def.name, golden: !!details.golden, minion, attack, health, keywords, body, keywordBonus,
    score: body + keywordBonus, parts: { attack: attack * w.attack, health: health * w.health, shield, windfury, reborn },
    unpricedAbilities, unpricedKeywords };
}
