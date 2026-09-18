import { Eye, Pause, Play, SkipForward } from 'lucide-react';
import { actionNames, formatProbability, type AIWatch } from '../ai-watch';
import { getDef } from '../data';
import { heroOf, type Action, type Game } from '../engine';
import { SEASON_HEROES } from '../season/catalog';
import { TRINKETS } from '../season/engine';
import './watch.css';

export function describeAction(game: Game, action: Action) {
  const cards = [...game.shop, ...game.hand, ...game.board, ...game.discovery, ...(game.season?.spellShop || [])];
  const name = (uid: string) => {
    const card = cards.find(c => c.uid === uid);
    return card ? getDef(card.id).name : TRINKETS.find(t => t.id === uid)?.name || SEASON_HEROES.find(h => h.id === uid)?.power || uid;
  };
  return actionNames[action.type] + ('uid' in action && action.uid ? ` ${name(action.uid)}` : '') +
    ('target' in action && action.target ? ` → ${name(action.target)}` : '') +
    ('position' in action && action.position !== undefined ? ` · 第 ${action.position + 1} 位` : '') +
    (action.type === 'move' ? ` · 第 ${action.to + 1} 位` : '') +
    (action.type === 'power' && action.powerId ? ` · ${name(action.powerId)}` : '');
}
export function WatchPanel({ watch, game, stage, pending, command }: {
  watch: AIWatch; game: Game; stage: string; pending: boolean;
  command: (name: string) => void;
}) {
  const decision = watch.decision, choice = decision?.choices.find(c => c.selected);
  const mandatory = !!(game.discovery.length || game.season?.trinketOffers.length || game.season?.powerChoice);
  const choices = decision ? [...decision.choices].sort((a,b) => Number(b.selected) - Number(a.selected) || b.probability - a.probability) : [];
  return <section className="watch-panel" aria-label="AI 观战控制">
    <div className="watch-controls">
      <strong><Eye size={17} /> AI 视角 · {heroOf(game).name}</strong>
      <button disabled={pending || stage === 'finished' || game.health <= 0} onClick={() => command(watch.paused ? 'play' : 'pause')}>
        {watch.paused ? <Play size={15} /> : <Pause size={15} />}{watch.paused ? '播放 AI' : '暂停 AI'}
      </button>
      <button disabled={pending || !decision || stage !== 'recruit' || watch.step} onClick={() => command('step')}>
        <SkipForward size={15} />下一步
      </button>
      {stage === 'combat' && <button disabled={pending} onClick={() => command('next')}>看完战斗，继续</button>}
      <span className="watch-next" role="status">{watch.error || (choice ? `将选择：${describeAction(game, choice.action)}` : stage === 'combat' ? '正在观看战斗' : stage === 'finished' || game.health <= 0 ? '观战 AI 已结束对局' : '等待 AI 计算下一步…')}</span>
    </div>
    <div className="watch-caption">AI 偏好 · {decision?.mode === 'search' ? '数值显示搜索前的偏好，最终操作由搜索决定。' : decision?.mode === 'greedy' ? '数值显示策略偏好，最终操作按最高估值选择。' : decision ? '数值越高，AI 越倾向选择该操作。' : '正在计算当前局面的偏好。'} ● 标记实际选择；百分比不代表胜率。</div>
    <details className="watch-choices" key={`${mandatory}:${game.turn}`} open={mandatory || undefined}>
      <summary>{mandatory ? 'AI 正在选择奖励 / 技能' : '全部合法操作'}{decision ? ` · ${choices.length} 项` : ''}</summary>
      <div className="watch-choice-list">
        {choices.map((c,i) => <div key={i} className={c.selected ? 'watch-choice-selected' : ''}>
          <span>{c.selected ? '● ' : ''}{describeAction(game,c.action)}</span><b>{formatProbability(c.probability)}</b>
        </div>)}
        {!choices.length && <p>当前没有待执行的决策。</p>}
      </div>
    </details>
  </section>;
}
