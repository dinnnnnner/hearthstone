import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Rooms } from './rooms';
import { Demonstrations } from './demonstrations';
import { ACTIONS } from '../rl/actions';

function setup(source: 'human' | 'synthetic' = 'human', root = mkdtempSync(join(tmpdir(), 'tavern-demos-'))) {
  const store = new Rooms();
  const identity = store.guest('private-player'), guest = store.auth(identity.token);
  const room = store.create(guest, 'ai', 's14_lich', 'training', 'free');
  const recorder = new Demonstrations(root, 'test-build', source);
  return { store, identity, guest, room, recorder, root, seat: store.member(guest).p };
}
function rows(root: string, recorder: Demonstrations) {
  const directory = join(root, recorder.profile.contract);
  return readdirSync(directory).filter(f => f.endsWith('.gz')).map(f =>
    gunzipSync(readFileSync(join(directory, f))).toString().trim().split('\n').map(row => JSON.parse(row)));
}

test('opt-in only; accepted actions are captured before mutation, deduplicated, private, and terminated', async () => {
  const { store, identity, guest, room, recorder, root, seat } = setup();
  recorder.observe(store); await recorder.flush(); assert.equal(rows(root, recorder).length, 0);
  room.recordTraining = true; recorder.observe(store);
  const gold = seat.game!.gold;
  recorder.action(store, guest, { type: 'refresh' }, 'first', room.turn);
  recorder.action(store, guest, { type: 'refresh' }, 'first', room.turn);
  assert.throws(() => recorder.action(store, guest, { type: 'buy', uid: 'missing' }, 'bad', room.turn));
  recorder.action(store, guest, { type: 'end' }, 'end', room.turn);
  seat.place = 1; room.stage = 'finished'; recorder.observe(store); await recorder.flush();
  const tape = rows(root, recorder)[0], decisions = tape.filter(r => r.type === 'decision');
  assert.equal(decisions.length, 2); assert.equal(decisions[0].goldBefore, gold);
  assert.equal(decisions[0].entities[0].details.gold, gold);
  assert.equal(decisions[0].previous, ACTIONS.length);
  assert.equal(decisions[1].previous, decisions[0].action);
  assert.ok(decisions.every(r => r.legal.includes(r.action)));
  assert.equal(tape.at(-1).complete, true);
  const text = JSON.stringify(tape);
  for (const secret of [identity.token, guest.hash, guest.id, guest.name, room.code]) assert.ok(!text.includes(secret));
  assert.ok(!text.includes('initialPool'));
});

test('abandonment, partial restart and automatic end never count as complete demonstrations', async () => {
  for (const reason of ['leave', 'restart', 'automatic']) {
    const { store, guest, room, recorder, root, seat } = setup();
    room.recordTraining = true; recorder.observe(store, reason !== 'restart');
    recorder.action(store, guest, { type: 'freeze' }, 'first', room.turn);
    if (reason === 'leave') { store.leave(guest); recorder.observe(store); }
    else if (reason === 'restart') await recorder.close();
    else { seat.place = 8; room.stage = 'finished'; recorder.observe(store); }
    await recorder.flush(); const tape = rows(root, recorder)[0];
    assert.equal(tape.at(-1).complete, false); assert.ok(tape.at(-1).reasons.length);
  }
});

test('two complete synthetic games can be exported through the real action recorder', async () => {
  const root = process.env.TAVERN_DEMO_FIXTURE_DIR || mkdtempSync(join(tmpdir(), 'tavern-demo-games-'));
  for (let game = 0; game < 2; game++) {
    const { store, guest, room, recorder, seat } = setup('synthetic', root);
    room.recordTraining = true; recorder.observe(store);
    let requests = 0;
    while (!seat.place && room.stage !== 'finished') {
      const s = seat.game!;
      const action = room.stage === 'combat' ? { type: 'continue' as const } :
        s.season!.powerChoice ? { type: 'choosePower' as const, uid: s.season!.powerChoice.offers[0] } :
        s.discovery.length ? { type: 'discover' as const, uid: s.discovery[0].uid } :
        s.season!.trinketOffers.length ? { type: 'buyTrinket' as const, uid: s.season!.trinketOffers[0] } :
        requests % 3 === 0 && s.gold > 0 ? { type: 'refresh' as const } : { type: 'end' as const };
      recorder.action(store, guest, action, String(requests++), room.turn);
      assert.ok(requests < 300);
    }
    recorder.observe(store); await recorder.flush();
    const tape = rows(root, recorder).find(t => t[0].gameId && t.at(-1).place === seat.place);
    assert.ok(tape); assert.equal(tape.at(-1).complete, true);
  }
  console.log('Synthetic demonstration directory:', root);
});

test('default minion placement and playing a spell map to the training action vocabulary', async () => {
  const { makeMinion } = await import('../src/engine');
  const { store, guest, room, recorder, root, seat } = setup();
  room.recordTraining = true;
  const minion = makeMinion('s14_BG25_001'), coin = makeMinion('s14_BG28_810');
  seat.game!.hand.push(minion, coin);recorder.observe(store);
  recorder.action(store, guest, { type: 'play', uid: minion.uid }, 'minion', room.turn);
  recorder.action(store, guest, { type: 'play', uid: coin.uid }, 'coin', room.turn);
  recorder.action(store, guest, { type: 'end' }, 'end', room.turn);
  seat.place = 2;room.stage = 'finished';recorder.observe(store);await recorder.flush();
  const tape = rows(root,recorder)[0];
  assert.equal(tape.at(-1).complete,true);
  const actions = tape.filter(r=>r.type==='decision').map(r=>ACTIONS[r.action].type);
  assert.deepEqual(actions,['play','cast','end']);
});
