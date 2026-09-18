import { useEffect, useState } from 'react';
import type { Judgment } from '../../server/judgment';
import type { Game } from '../engine';
import { art, cardText, getDef } from '../data';
import { formatProbability } from '../ai-watch';
import { describeAction } from './WatchPanel';
import './judgment.css';

const number = (n: number) => Number(n.toFixed(2)).toString();
const componentNames = { cash: '当前金币', minionAssets: '随从基础出售资产', handPotential: '手牌潜力',
  futureIncome: '下回合收入', freeRefresh: '免费刷新', spellDiscount: '法术折扣', tavernTier: '酒馆等级机会分' };
const partNames = { attack: '攻击', health: '生命', shield: '圣盾', windfury: '风怒', reborn: '复生' };

export function JudgmentPanel({ game, version, token, active }: {
  game: Game; version: string; token: string; active: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [result, setResult] = useState<Judgment>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setResult(undefined); setError('');
    if (!enabled || !active) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch('/tavern-api/judgment', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      }).then(async response => {
        const data = await response.json();
        if (!response.ok) throw Error(data.error || '判断暂不可用');
        if (!controller.signal.aborted && data.version === version) setResult(data);
      }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '判断暂不可用'); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, active, version, token, retry]);
  const current = enabled && active && result?.version === version ? result : undefined;
  const evaluation = current?.evaluation;
  const choices = [...(current?.decision?.choices || [])].sort((a,b) => b.probability - a.probability);
  return <section className="judgment-panel" aria-label="AI 判断">
    <label className="judgment-toggle"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
      <strong>AI 判断</strong><span>动作概率 · 随从估值 · 场面估值</span></label>
    {enabled && <>
      {!active ? <p role="status">招募阶段可分析你的局面。</p> : !current ? <p role="status">
        {error || '正在分析当前局面…'} {error && <button onClick={() => setRetry(n => n+1)}>重试</button>}</p> : <>
        <p className="judgment-note">模型仅分析你当前可见的局面，未接入此前操作记忆。概率表示策略偏好，不代表胜率；搜索模型在这里显示搜索前的策略概率。</p>
        <details className="judgment-actions" open>
          <summary>动作概率{choices.length ? ` · ${choices.length} 项` : ''}</summary>
          {current.policyError && <p role="status">{current.policyError} <button onClick={() => setRetry(n => n+1)}>重试概率</button></p>}
          <div className="judgment-action-list">{choices.map((choice, i) => <div key={i}>
            <span>{describeAction(game, choice.action)}</span><b>{formatProbability(choice.probability)}</b>
          </div>)}</div>
        </details>
        {evaluation && <>
          {current.learnedError && <p role="status">{current.learnedError}</p>}
          {current.learned && <p className="judgment-total">模型场面战力 <strong data-model-board-score={current.learned.boardStrength}>{number(current.learned.boardStrength)}</strong>
            <span> = 场上逐牌模型贡献之和。由真实战斗监督学习，不是金币价格或胜率。</span></p>}
          <p className="judgment-total">场面 <strong data-board-score={evaluation.board}>{number(evaluation.board)}</strong> 分
            <span> = 场上 {evaluation.cards.filter(c => c.zone === 'board').length} 张随从贡献之和</span></p>
          <p className="judgment-note">以下是统一规则分，不是金币价格或模型预测。已生效的加成计入当前攻防，不重复给来源牌加分。酒馆和手牌展示当前身材基础分，实际打出后的效果以新场面为准。</p>
          {(['board', 'shop', 'hand'] as const).map(zone => {
            const cards = evaluation.cards.filter(c => c.zone === zone);
            return <details className="judgment-zone" key={zone} open={zone === 'board' || undefined}>
              <summary>{{ board: '场上逐牌贡献', shop: '酒馆随从估值', hand: '手牌估值' }[zone]} · {cards.length} 张</summary>
              <div className="judgment-cards">{cards.map(card => <article className="judgment-card" key={card.uid} data-card-uid={card.uid}
                data-card-score={card.score} data-board-contribution={card.boardScore}
                data-model-contribution={current.learned?.cards.find(c=>c.uid===card.uid)?.contribution}>
                <img loading="lazy" src={art(getDef(card.id).sourceId || card.id)} alt="" />
                <div><strong>{card.position+1}. {card.name}</strong><span>{card.attack} / {card.health} · {card.keywords.join('、') || '无关键词'}</span>
                  <b>{card.minion ? `${number(card.score)} 分` : '法术未估分'}</b>
                  {current.learned && card.minion && <small>模型{zone === 'board' ? '战力贡献' : '战力参考'}：
                    {number(current.learned.cards.find(c=>c.uid===card.uid)!.strength)} · 规则基础分见上方</small>}
                  <small>{Object.entries(card.parts).filter(([,v]) => v !== 0).map(([k,v]) => `${partNames[k as keyof typeof partNames]} ${number(v)}`).join(' + ') || '无身材分'}</small>
                  {zone === 'shop' && <small>购买费用 {card.buyCost} 金币 · 尚未计入场面</small>}
                  {zone === 'hand' && card.minion && <small>手牌潜力计 {number(card.handPotential)} 分 · 尚未计入场面</small>}
                  {(!!card.unpricedAbilities.length || !!card.unpricedKeywords.length || !!getDef(card.id).effect) &&
                    <details><summary>效果与估值范围</summary><p>{cardText(card)}</p>
                      <p>未额外估算技能触发、亡语或阵容配合。{card.unpricedKeywords.length ? `${card.unpricedKeywords.join('、')}未赋固定分。` : ''}</p></details>}
                </div>
              </article>)}</div>
              {!cards.length && <p>暂无卡牌。</p>}
            </details>;
          })}
          <details className="judgment-economy"><summary>经济与手牌 · {number(evaluation.economy)} 分</summary>
            {Object.entries(componentNames).map(([key, label]) => <div key={key}><span>{label}</span>
              <b>{number(evaluation.components[key as keyof typeof componentNames])}</b></div>)}
            <p>随从基础出售资产按每张 1 金币计，不预支特殊出售效果。手牌潜力为基础分的 25%。酒馆等级每升一级计 3 分，收入、折扣使用训练基线权重；这些固定分尚不能衡量长期收益。</p>
          </details>
        </>}
      </>}
    </>}
  </section>;
}
