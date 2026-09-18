import { evaluateBasic } from '../rl/basic-evaluation';
import { observeEntities } from '../rl/entities';
import { OFFSETS } from '../rl/entities';
import { evaluateMinion } from '../src/minion-evaluation';
import { minionCost } from '../src/season/engine';
import type { Game } from '../src/engine';
import type { PolicyDecision } from '../src/ai-watch';

export function evaluateTavern(game: Game) {
  const evaluation = evaluateBasic(observeEntities(game, 0, 64));
  const cards = evaluation.cards.map(card => ({ ...card,
    uid: (card.zone === 'board' ? game.board : game.hand)[card.position].uid,
    buyCost: null as number | null,
  }));
  const shop = game.shop.map((card, position) => ({ ...evaluateMinion(card.id, { ...card }),
    zone: 'shop', position, uid: card.uid, buyCost: minionCost(game, card),
    boardScore: 0, handPotential: 0, minionAssetUnits: 0,
  }));
  return { ...evaluation, cards: [...cards, ...shop] };
}
export type Judgment = {
  version: string;
  evaluation: ReturnType<typeof evaluateTavern>;
  decision?: PolicyDecision;
  policyError?: string;
  learned?: ReturnType<typeof readLearnedLedger>;
  learnedError?: string;
};

/** Bind model slots to the authenticated player's current UIDs and check the sum. */
export function readLearnedLedger(raw: unknown, evaluation: ReturnType<typeof evaluateTavern>) {
  const r = raw as Record<string, any>;
  const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const vector = (v: unknown, length: number): v is number[] => Array.isArray(v) && v.length === length && v.every(nonnegative);
  if (!r || r.version !== 'minion-ledger-v1' || !nonnegative(r.boardStrength) || !Array.isArray(r.cards) ||
    !vector(r.economy,7) || !vector(r.futureEconomy,3) || !vector(r.combat,3) ||
    Math.abs(r.combat.reduce((a:number,b:number)=>a+b,0)-1) > .0001 || typeof r.placementReturn !== 'number' || !Number.isFinite(r.placementReturn))
    throw Error('Invalid learned ledger');
  const expected = new Map(evaluation.cards.filter(c=>c.minion).map(c=>[
    OFFSETS[c.zone==='board'?1:c.zone==='shop'?2:4]+c.position,c]));
  const seen = new Set<number>();
  const cards = r.cards.map((c: any) => {
    const source = c && expected.get(c.slot);
    if (!source || seen.has(c.slot) || !nonnegative(c.body) || !nonnegative(c.strength) || !nonnegative(c.contribution) ||
      Math.abs(c.contribution-(source.zone==='board'?c.strength:0)) > 1e-5*Math.max(1,c.strength)) throw Error('Invalid learned card');
    seen.add(c.slot);
    return { uid: source.uid, slot: c.slot as number, body: c.body as number,
      strength: c.strength as number, contribution: c.contribution as number };
  });
  if (seen.size !== expected.size || Math.abs(cards.reduce((sum:number,c:{contribution:number})=>sum+c.contribution,0)-r.boardStrength) > 1e-5*Math.max(1,r.boardStrength))
    throw Error('Learned board sum differs');
  return { version: 'minion-ledger-v1', boardStrength: r.boardStrength as number, cards,
    economy: r.economy as number[], futureEconomy: r.futureEconomy as number[],
    combat: r.combat as number[], placementReturn: r.placementReturn as number };
}
