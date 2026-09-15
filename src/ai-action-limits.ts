import type { Action, Game } from './engine';

export const AI_ACTION_LIMITS = { version: 1, freezes: 2, moves: 6 } as const;
export interface AIActionUsage {
  turn: number;
  freezes: number;
  moves: number;
  previousMoveOrder?: string[];
}

export function enableAIActionLimits(s: Game) {
  s.aiActionUsage ??= { turn: s.turn, freezes: 0, moves: 0 };
}

function usage(s: Game) {
  return s.aiActionUsage?.turn === s.turn ? s.aiActionUsage : { turn: s.turn, freezes: 0, moves: 0 };
}

/** Own public slot indices only; instance IDs never enter model observations. */
export function publicAIActionLimits(s: Game) {
  if (!s.aiActionUsage) return undefined;
  const u = usage(s);
  const order = u.previousMoveOrder?.map(uid => s.board.findIndex(m => m.uid === uid));
  return { version: AI_ACTION_LIMITS.version,
    freezeRemaining: Math.max(0, AI_ACTION_LIMITS.freezes - u.freezes),
    moveRemaining: Math.max(0, AI_ACTION_LIMITS.moves - u.moves),
    ...(order && order.length === s.board.length && order.every(i => i >= 0) ? { undoOrder: order } : {}),
  };
}

export function aiActionError(s: Game, a: Action): string | undefined {
  if (!s.aiActionUsage) return;
  const u = usage(s);
  if (a.type === 'freeze' && u.freezes >= AI_ACTION_LIMITS.freezes) return '人机本回合最多切换冻结状态2次。';
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
    ...(a.type === 'move' ? { previousMoveOrder: before.board.map(m => m.uid) } : {}),
  };
}
