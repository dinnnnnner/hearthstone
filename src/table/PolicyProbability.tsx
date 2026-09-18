import { choiceProbability, formatProbability, type PolicyDecision } from '../ai-watch';
import type { Action } from '../engine';

export function PolicyProbability({ decision, type, uid, powerId, label = '' }: {
  decision?: PolicyDecision; type: Action['type']; uid?: string; powerId?: string; label?: string;
}) {
  const value = choiceProbability(decision, type, uid, powerId);
  return <span className={`policy-probability ${value?.selected ? 'policy-selected' : ''}`}
    data-policy-type={type} data-policy-uid={uid}
    title={value ? value.legal ? 'AI 对此操作的偏好；同一卡牌的目标和站位选项合计。' : '当前不能选择此操作。' : '等待当前局面的 AI 偏好。'}>
    {value?.selected && <span aria-label="AI 将选择">● </span>}<span className="probability-label">{label}</span>{value ? value.legal ? formatProbability(value.probability) : '不可选' : '—'}
  </span>;
}
