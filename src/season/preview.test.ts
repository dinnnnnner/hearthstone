import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMinion, type Game, type Action } from '../engine';
import { getDef } from '../data';
import { ALL_TRIBES, SEASON_HEROES, SEASON_CARDS, SEASON_SPELLS } from './catalog';
import { actSeason, advanceRecruit, assertSeasonPool, createSeason, endEffects, seasonCombat, seasonTargets, TRINKETS } from './engine';
import { observeEntities } from '../../rl/entities';
import { equippedPowers, powerDefinition } from './powers';
const rng = () => .31;
const fixture = (deity = 'BGFYM_000', hero = 's14_reno') => createSeason(hero, rng, { tribes: [...ALL_TRIBES], deity });
function add(s: Game, id: string, zone: 'board' | 'hand' = 'board', golden = false) { const card = makeMinion('s14_' + id, golden); s[zone].push(card); return card; }
function step(s: Game, action: Action) { const out = actSeason(s, action, rng); assert.equal(out.error, undefined); assertSeasonPool(out.state); return out.state; }
function buy(s: Game, id: string) { s.season!.trinketOffers = [id]; s.season!.trinketOfferCosts = { [id]: 0 }; return step(s, { type: 'buyTrinket', uid: id }); }

test('preview offers only implemented cards, replaces Naga, shares one Paradox variant', () => {
  assert.equal(SEASON_CARDS.length, 242); assert.equal(SEASON_SPELLS.length, 66); assert.equal(TRINKETS.length, 237);
  for (const hero of ['s14_drestagath', 's14_kithix']) assert.ok(SEASON_HEROES.some(h => h.id === hero));
  for (const hero of ['s14_vashj', 's14_azshara', 's14_sylvanas', 's14_morchie', 's14_murozond']) assert.ok(!SEASON_HEROES.some(h => h.id === hero));
  for (const random of [() => .1, () => .9]) {
    const s = createSeason('s14_reno', random);
    assert.equal(s.season!.tribes.length, 5); assert.ok(s.season!.tribes.includes('畸变怪'));
    const paradoxes = Object.keys(s.pool).filter(id => id.startsWith('s14_BG36_360t'));
    assert.equal(paradoxes.length, 1);
    if (s.season!.tribes.includes('亡灵')) assert.notEqual(paradoxes[0], 's14_BG36_360t4');
    const other = createSeason('s14_george', random, { tribes: s.season!.tribes, pool: s.pool, deity: s.season!.deity!.id });
    assert.deepEqual(Object.keys(other.pool), Object.keys(s.pool)); assert.equal(other.season!.deity!.id, s.season!.deity!.id);
  }
});
test('discard targets hand cards, triggers Sludge twice, and buffs the deity', () => {
  let s = fixture(); const source = add(s, 'BG36_099'); const card = add(s, 'BG36_301t', 'hand');
  assert.deepEqual(seasonTargets(s, source, 'activate').map(x => x.uid), [card.uid]);
  s = step(s, { type: 'activate', uid: source.uid, target: card.uid });
  assert.equal(s.hand.length, 0); assert.equal(s.season!.spellsCast, 2); assert.equal(s.season!.counters!.discarded, 1);
  assert.deepEqual([s.board[0].attack, s.board[0].health], [5, 6]);
  assert.deepEqual([s.season!.deity!.attack, s.season!.deity!.health], [3, 3]);
});
test('Corrupted Coin discard raises the permanent cap and next-turn income', () => {
  let s = fixture(); const source = add(s, 'BG36_099'), coin = add(s, 'BG36_303', 'hand');
  s = step(s, { type: 'activate', uid: source.uid, target: coin.uid });
  assert.equal(s.season!.maxGold, 12); assert.equal(s.gold, 3); advanceRecruit(s, rng); assert.equal(s.gold, 6);
});
test('paired cards survive save restore and playing either discards its partner', () => {
  let s = fixture(); const source = add(s, 'BG36_100'); s = step(s, { type: 'sell', uid: source.uid });
  assert.equal(s.hand.length, 2); assert.equal(s.hand[0].discardGroup, s.hand[1].discardGroup);
  s = JSON.parse(JSON.stringify(s)); const card = s.hand[0], partner = s.hand[1];
  s = step(s, { type: 'cast', uid: card.uid }); assert.ok(!s.hand.some(m => m.uid === partner.uid)); assert.equal(s.season!.counters!.discarded, 1);
});
test('new hero powers discard a selected card and produce a linked minion pair', () => {
  let s = fixture('BGFYM_000', 's14_drestagath'); const card = add(s, 'BG36_303', 'hand');
  s = step(s, { type: 'power', target: card.uid }); assert.equal(s.gold, 2); assert.equal(s.hand.length, 1);
  assert.ok(getDef(s.hand[0].id).races?.includes('畸变怪') || getDef(s.hand[0].id).tribe === '全部');
  s = fixture('BGFYM_000', 's14_kithix'); s = step(s, { type: 'power' }); assert.equal(s.hand.length, 2);
  s = step(s, { type: 'play', uid: s.hand[0].uid }); assert.equal(s.season!.counters!.discarded, 1);
});
test('deity awakens after the third friendly Aberration death, once per combat', () => {
  for (const id of ['BGFYM_000', 'BGFYM_011']) {
    const s = fixture(id); s.season!.deity!.attack = 20; s.season!.deity!.health = 20;
    for (let i = 0; i < 3; i++) add(s, 'BG36_110');
    const enemy = makeMinion('s14_BG25_001'); enemy.attack = 100; enemy.health = 100;
    const battle = seasonCombat(s, [enemy], 1, rng);
    assert.equal(battle.frames.filter(f => f.text.includes('被唤醒')).length, 1);
    assert.equal(s.board.length, 3); assert.equal(s.season!.deity!.attack, 20);
    assert.ok(battle.frames.some(f => f.allies.some(m => m.id === 's14_' + id)));
    if (id === 'BGFYM_011') assert.ok(battle.frames.some(f => f.allies.filter(m => m.id === 's14_BG36_110').length === 2 && !f.allies.some(m => m.id === 's14_BGFYM_011')));
  }
});
test('Cthun splits exactly its stats and never leaks combat buffs into recruit', () => {
  const s = fixture(); s.season!.deity!.attack = 10; s.season!.deity!.health = 12;
  for (let i = 0; i < 3; i++) { const m = add(s, 'BG36_110'); m.keywords = ['嘲讽']; }
  const survivor = add(s, 'BG25_001'); survivor.attack = 0; survivor.health = 1000;
  const enemy = makeMinion('s14_BG25_001'); enemy.attack = 100; enemy.health = 1000;
  const battle = seasonCombat(s, [enemy], 1, rng), awakening = battle.frames.find(f => f.text.includes('被唤醒'))!;
  const copy = awakening.allies.find(m => m.uid === survivor.uid)!;
  assert.deepEqual([copy.attack, copy.health], [10, 1012]); assert.deepEqual([survivor.attack, survivor.health], [0, 1000]);
});
test('Volumizer first-use bonuses apply across zones and magnetization does not repeat them', () => {
  let s = fixture(); const host = add(s, 'BG_BOT_911'), red = add(s, 'BG34_170t', 'hand'), blue = add(s, 'BG34_170t2', 'hand');
  const base = getDef(blue.id).attack;
  s = step(s, { type: 'play', uid: red.uid, target: host.uid });
  assert.equal(s.hand.find(m => m.uid === blue.uid)!.attack, base + 3);
  s = step(s, { type: 'freeze' }); assert.equal(s.hand.find(m => m.uid === blue.uid)!.attack, base + 3);
});
test('discard trinkets trigger once, preserve the cap and produce doubled copies', () => {
  let s = fixture(); s.season!.trinkets = ['BG36_MagicItem_606', 'BG36_MagicItem_430', 'BG36_MagicItem_418'];
  const source = add(s, 'BG36_099'), card = add(s, 'BG36_110', 'hand');
  s = step(s, { type: 'activate', uid: source.uid, target: card.uid });
  const copy = s.hand.find(m => m.id === card.id)!; assert.deepEqual([copy.attack, copy.health], [4, 6]);
  assert.ok(s.hand.some(m => m.id === 's14_BG36_301t')); observeEntities(s, 0, 60);
});
test('Kiri replaces the chosen trinket and hero power and resolves both copies', () => {
  let s = fixture(); s.gold = 10; s = buy(s, 'BG36_MagicItem_412');
  assert.ok(s.season!.trinketOffers.every(id => TRINKETS.find(t => t.id === id)!.cost <= 4));
  s.season!.trinketOffers = ['BG36_MagicItem_400']; s.season!.trinketOfferCosts = { BG36_MagicItem_400: 0 };
  s = step(s, { type: 'buyTrinket', uid: 'BG36_MagicItem_400' });
  assert.deepEqual(s.season!.trinkets, ['BG36_MagicItem_400', 'BG36_MagicItem_400']);
  assert.equal(s.hand.length, 4); assert.deepEqual(equippedPowers(s), ['s14_trinket']); assert.ok(powerDefinition(s).passive);
  observeEntities(s, 0, 60);
});
test('Reinvigorating Light adds a power without replacing the existing one', () => {
  let s = buy(fixture(), 'BG36_MagicItem_411'); const selected = s.season!.powerChoice!.offers[0];
  s = step(s, { type: 'choosePower', uid: selected }); assert.deepEqual(equippedPowers(s), ['s14_reno', selected]);
});
test('Heroic Broodmother attacks immediately and golden makes two attacks', () => {
  const s = fixture(); const first = add(s, 'BG25_001'); first.attack = 0; first.health = 1000;
  const dragon = add(s, 'BG36_849', 'board', true); const enemy = makeMinion('s14_BG25_001'); enemy.attack = 1; enemy.health = 1000;
  const attacks = seasonCombat(s, [enemy], 1, rng).frames.filter(f => f.attacker);
  assert.equal(attacks[0].attacker, dragon.uid); assert.equal(attacks[1].attacker, dragon.uid);
});

test('retired hero saves retain their power definition without reopening the draft pool', () => {
  const s = fixture(); s.hero = 's14_vashj';
  assert.equal(powerDefinition(s).id, 's14_vashj');
  assert.ok(!SEASON_HEROES.some(h => h.id === s.hero));
  assert.equal(actSeason(s, { type: 'freeze' }, rng).error, undefined);
});

test('copied trinkets beyond four slots remain visible to current AI observations', () => {
  const s = fixture(); s.turn = 10;
  s.season!.trinkets = ['BG36_MagicItem_400', 'BG36_MagicItem_400', 'BG36_MagicItem_400', 'BG36_MagicItem_400', 'BG36_MagicItem_414'];
  s.season!.trinketData = { 'trinket:4:BG36_MagicItem_414': { turn: 6 } };
  const observation = observeEntities(s, 0, 60);
  assert.deepEqual(observation[0]!.details.extraTrinkets, ['BG36_MagicItem_414']);
  assert.deepEqual(JSON.parse(JSON.stringify(observation[0]!.details.trinketData)), s.season!.trinketData);
});
