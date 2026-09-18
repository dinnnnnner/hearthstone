import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeuralRooms, type Infer } from './neural';
import { evaluateTavern, readLearnedLedger } from './judgment';
import { createSeason } from '../src/season/engine';
import { makeMinion } from '../src/engine';
import { evaluateBasic } from '../rl/basic-evaluation';
import { observeEntities, OFFSETS } from '../rl/entities';
import { inferenceProfile } from './neural-profile';

test('one card score across shop, hand and board; only owned board cards enter the board sum', () => {
  const game = createSeason('s14_patchwerk', () => .3);
  const card = makeMinion('s14_BG25_013');
  card.attack = 101; card.health = 104; card.keywords = ['圣盾', '风怒', '复生'];
  game.board = [{ ...structuredClone(card), uid: 'board' }];
  game.hand = [{ ...structuredClone(card), uid: 'hand' }];
  game.shop = [{ ...structuredClone(card), uid: 'shop' }];
  const before = structuredClone(game), scored = evaluateTavern(game);
  assert.equal(new Set(scored.cards.map(c => c.score)).size, 1);
  assert.equal(scored.board, 205 + 101 + 50.5 + 1);
  assert.equal(scored.board, scored.cards.reduce((sum,c) => sum+c.boardScore,0));
  assert.equal(scored.components.handPotential, scored.board*.25);
  assert.equal(scored.resources.minionAssetUnits, 2);
  assert.equal(scored.cards.find(c => c.uid === 'shop')!.buyCost, 3);
  assert.equal(scored.total, evaluateBasic(observeEntities(game, 0, 64)).total);
  game.shop[0].attack = 9999;
  assert.equal(evaluateTavern(game).total, scored.total, 'unowned shop cannot inflate position value');
  game.shop[0].attack = before.shop[0].attack;
  assert.deepEqual(game, before);
});

class AdvisorRooms extends NeuralRooms { override bots() {} }
test('learned contributions bind only to current minions and must sum exactly to the learned board', () => {
  const game=createSeason('s14_patchwerk',()=>.3);
  game.board=[makeMinion('s14_BG25_013')];
  const evaluation=evaluateTavern(game);
  const cards=evaluation.cards.filter(c=>c.minion).map(c=>({
    slot:OFFSETS[c.zone==='board'?1:c.zone==='shop'?2:4]+c.position,
    body:c.score,strength:c.score*2,contribution:c.boardScore*2,
  }));
  const raw={version:'minion-ledger-v1',cards,boardStrength:evaluation.board*2,
    economy:[1,2,3,4,5,6,7],futureEconomy:[5,2,0],combat:[.2,.7,.1],placementReturn:-.5};
  const valid=readLearnedLedger(raw,evaluation);
  assert.equal(valid.cards[0].uid,game.board[0].uid);
  assert.throws(()=>readLearnedLedger({...raw,boardStrength:raw.boardStrength+1},evaluation),/sum/);
  assert.throws(()=>readLearnedLedger({...raw,cards:[...cards,cards[0]]},evaluation),/card/);
  assert.throws(()=>readLearnedLedger({...raw,cards:cards.slice(1)},evaluation),/sum/);
  assert.throws(()=>readLearnedLedger({...raw,combat:[1,1,1]},evaluation),/ledger/);
});
function fixture(infer?: Infer) {
  const calls: any[] = [];
  const policy: Infer = async (body: any) => {
    calls.push(structuredClone(body));
    if (infer) return infer(body);
    return { rows: body.rows.map((row: any) => ({ action: row.legal[0], memory: row.memory,
      probabilities: row.legal.map((id: number) => [id, 1/row.legal.length]) })) };
  };
  const store = new AdvisorRooms(policy, Date.now, () => .31, 'trinkets-v5');
  const guest = store.auth(store.guest('玩家').token);
  const room = store.create(guest, 'ai', 's14_patchwerk', 'training');
  const version = () => store.view(guest).judgmentVersion;
  return { store, guest, room, calls, version };
}
test('advice is read-only, authenticated to own seat, cached, and uses public observations with no history', async () => {
  const { store, guest, room, calls, version } = fixture();
  try {
    const before = structuredClone(room);
    const [a,b] = await Promise.all([store.judgment(guest, version()), store.judgment(guest, version())]);
    assert.deepEqual(a,b); assert.equal(calls.length,1);
    assert.ok(a.decision); assert.equal(a.policyError,undefined);
    assert.ok(Math.abs(a.decision.choices.reduce((n,c) => n+c.probability,0)-1)<.0001);
    assert.deepEqual(room,before); assert.equal(store.ai.decisions,0);
    assert.equal(calls[0].search,false); assert.ok(calls[0].rows[0].memory.every((n:number) => n===0));
    const publicGame = structuredClone(room.seats[0].game!);
    publicGame.pool = {};
    for (const enemy of publicGame.opponents) enemy.board = [];
    assert.deepEqual(calls[0].rows[0].entities, inferenceProfile('trinkets-v5').observe(publicGame,0,64),
      'private pool and enemy boards do not enter inference');
  } finally { store.stop(); }
});
test('stale and foreign requests fail; bot-only changes do not recompute advice', async () => {
  const { store, guest, room, calls, version } = fixture();
  try {
    await store.judgment(guest,version());
    room.gameRev = (room.gameRev || 0)+1;
    await store.judgment(guest,version()); assert.equal(calls.length,1);
    const oldVersion = version();
    store.opponents(room);
    assert.notEqual(version(),oldVersion,'public opponent updates invalidate the analysis');
    await store.judgment(guest,version()); assert.equal(calls.length,2);
    const stranger = store.auth(store.guest('旁人').token);
    await assert.rejects(store.judgment(stranger,version()), /房间/);
    await assert.rejects(store.judgment(guest,'wrong'), /局面/);
    room.seats[0].ended = true;
    await assert.rejects(store.judgment(guest,version()), /局面/);
  } finally { store.stop(); }
});
test('late inference cannot annotate a changed position', async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started=resolve; });
  const gate = new Promise<void>(resolve => { release=resolve; });
  const { store, guest, room, version } = fixture(async () => { started(); await gate; return {rows:[]}; });
  try {
    const result = store.judgment(guest,version());
    await ready; room.seats[0].rev++; release();
    await assert.rejects(result, /局面已更新/);
  } finally { release(); store.stop(); }
});
test('malformed probabilities preserve rule valuation and never run a fallback action', async () => {
  const { store, guest, room, calls, version } = fixture(async (body:any) => ({rows:[{
    action:body.rows[0].legal[0],memory:[],probabilities:[[body.rows[0].legal[0],2]],
  }]}));
  try {
    const before=structuredClone(room), result=await store.judgment(guest,version());
    assert.equal(result.decision,undefined); assert.ok(result.policyError); assert.ok(result.evaluation);
    assert.deepEqual(room,before); assert.equal(store.ai.fallbackRounds,0);
    await store.judgment(guest,version()); assert.equal(calls.length,2,'a failed probability request can be retried');
  } finally { store.stop(); }
});
