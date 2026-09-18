import type { Action } from './engine';

export type PolicyChoice = { action: Action; probability: number; selected: boolean };
export type PolicyDecision = {
  id: string;
  turn: number;
  mode: 'sample' | 'greedy' | 'search';
  choices: PolicyChoice[];
};
export type AIWatch = {
  paused: boolean;
  step: boolean;
  nextAt: number;
  decision?: PolicyDecision;
  error?: string;
};
/** Sum mutually exclusive targets/positions for the same card operation. */
export function choiceProbability(decision: PolicyDecision | undefined, type: Action['type'], uid?: string, powerId?: string) {
  if (!decision) return undefined;
  const choices = decision.choices.filter(({ action }) => action.type === type &&
    (uid === undefined || 'uid' in action && action.uid === uid) &&
    (powerId === undefined || action.type === 'power' && action.powerId === powerId));
  return { probability: choices.reduce((sum, c) => sum + c.probability, 0), selected: choices.some(c => c.selected), legal: !!choices.length };
}
export function formatProbability(value: number) {
  return value > 0 && value < .001 ? '<0.1%' : `${(value * 100).toFixed(1)}%`;
}
export const actionNames: Record<Action['type'], string> = {
  buy: '购买', buySpell: '购买法术', sell: '出售', play: '打出', cast: '施放', move: '换位',
  upgrade: '升本', refresh: '刷新', freeze: '冻结 / 解冻', end: '结束招募', continue: '继续',
  power: '英雄技能', discover: '发现', choosePower: '选择技能', buyTrinket: '购买饰品',
  darkGift: '黑暗发现', activate: '发动技能', reward: '领取奖励',
};
