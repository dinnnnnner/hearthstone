import type { Action, Game } from './engine';
import { minionCost, spellCost, spellUsesHealth } from './season/engine';

export const AI_ACTION_LIMITS = { version: 2, freezes: 1, moves: 6, freezePolicy: 'unaffordable-at-end' } as const;
export interface AIActionUsage {
  turn: number;
  freezes: number;
  moves: number;
  previousMoveOrder?: string[];
  freezeClosing?: boolean;
}

export function enableAIActionLimits(s: Game) {
  s.aiActionUsage ??= { turn: s.turn, freezes: 0, moves: 0 };
}

function usage(s: Game) {
  return s.aiActionUsage?.turn === s.turn ? s.aiActionUsage : { turn: s.turn, freezes: 0, moves: 0 };
}

/** Candidates to retain, not a claim that these cards are worth buying. */
export function aiFreezeOffers(s: Game) {
  if (!s.season) return { shop: [] as number[], spellShop: [] as number[] };
  return {
    shop: s.shop.flatMap((m, i) => minionCost(s, m) > s.gold ? [i] : []),
    spellShop: s.season.spellShop.flatMap((m, i) => !spellUsesHealth(m) && spellCost(s, m) > s.gold ? [i] : []),
  };
}

export function aiFreezeClosing(s: Game) { return !!s.aiActionUsage && !!usage(s).freezeClosing; }

/** Own public slot indices only; instance IDs never enter model observations. */
export function publicAIActionLimits(s: Game) {
  if (!s.aiActionUsage) return undefined;
  const u = usage(s);
  const order = u.previousMoveOrder?.map(uid => s.board.findIndex(m => m.uid === uid));
  return { version: AI_ACTION_LIMITS.version,
    freezeRemaining: Math.max(0, AI_ACTION_LIMITS.freezes - u.freezes),
    moveRemaining: Math.max(0, AI_ACTION_LIMITS.moves - u.moves),
    freezeClosing: !!u.freezeClosing,
    freezeOffers: aiFreezeOffers(s),
    ...(order && order.length === s.board.length && order.every(i => i >= 0) ? { undoOrder: order } : {}),
  };
}

export function aiActionError(s: Game, a: Action): string | undefined {
  if (!s.aiActionUsage) return;
  const u = usage(s);
  if (u.freezeClosing && a.type !== 'end' && a.type !== 'continue') return '人机已确认冻结收尾，请结束招募。';
  if (a.type === 'freeze') {
    if (u.freezes >= AI_ACTION_LIMITS.freezes) return '人机本回合只能确认一次冻结收尾。';
    if (!s.frozen) {
      const offers = aiFreezeOffers(s);
      if (!offers.shop.length && !offers.spellShop.length) return '没有因金币不足而买不起的商店牌，无需冻结。';
    }
  }
  if (a.type !== 'move') return;
  if (u.moves >= AI_ACTION_LIMITS.moves) return '人机本回合最多换位6次。';
  const order = s.board.map(m => m.uid), from = order.indexOf(a.uid);
  if (from < 0 || !Number.isInteger(a.to)) return '无效的换位目标。';
  const [uid] = order.splice(from, 1);
  order.splice(Math.max(0, Math.min(order.length, a.to)), 0, uid);
  if (order.every((id, i) => id === s.board[i].uid)) return '换位没有改变站位。';
  if (u.previousMoveOrder?.length === order.length && order.every((id, i) => id === u.previousMoveOrder![i]))
    return '人机不能立即撤销上一次换位。';
}

/** Debit only a successful result; cloned feasibility probes never change the live state. */
export function recordAIAction(before: Game, after: Game, a: Action) {
  if (!before.aiActionUsage) return;
  const u = usage(before);
  after.aiActionUsage = { turn: before.turn,
    freezes: u.freezes + +(a.type === 'freeze'), moves: u.moves + +(a.type === 'move'),
    ...(u.freezeClosing || a.type === 'freeze' ? { freezeClosing: true } : {}),
    ...(a.type === 'move' ? { previousMoveOrder: before.board.map(m => m.uid) } : {}),
  };
}
