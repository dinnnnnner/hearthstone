import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NeuralRooms, type Infer } from './neural';
import { ACTIONS } from '../rl/actions';
import { OFFLINE_GRACE_MS } from './rooms';

async function until(check: () => boolean) {
  for (let i=0;i<500 && !check();i++) await delay(5);
  assert.ok(check(), 'expected watch state reached');
}
function fixture(infer?: Infer) {
  let now = 100000, seed=71;
  const calls: any[] = [];
  const policy: Infer = infer || (async (body: any) => {
    calls.push(structuredClone(body));
    return { rows: body.rows.map((r: any) => {
      const action = body.probabilities ? r.legal.find((a: number) => ACTIONS[a].type === 'buy') ?? r.legal[0] : r.legal.includes(0) ? 0 : r.legal[0];
      return { action, memory: r.memory.map((x: number) => x+1), ...(body.probabilities ? {
        probabilities: r.legal.map((a: number) => [a, 1/r.legal.length]), selectionMode: 'sample' as const,
      } : {}) };
    }) };
  });
  const store = new NeuralRooms(policy,()=>now,()=>((seed=(seed*1664525+1013904223)>>>0)/2**32), "trinkets-v5");
  const identity=store.guest('观众'), guest=store.auth(identity.token);
  const room=store.create(guest,'spectate','s14_lich');
  return {store,room,guest,calls,token:identity.token,advance:(ms:number)=>{now+=ms;}};
}
test('watch previews legal probabilities before acting, single-steps once, and rejects manual or stale actions', async () => {
  const {store,room,guest,calls}=fixture();
  try {
    assert.equal(room.mode,'training');assert.equal(room.seats.filter(p=>p.bot).length,8);
    const gold=room.seats[0].game!.gold;
    await until(()=>!!room.watch!.decision);
    const first=structuredClone(room.watch!.decision!);
    assert.equal(store.ai.decisions,0);assert.equal(room.seats[0].game!.gold,gold);assert.equal(calls.length,1);
    assert.equal(first.choices.filter(c=>c.selected).length,1);
    assert.ok(Math.abs(first.choices.reduce((n,c)=>n+c.probability,0)-1)<1e-6);
    assert.throws(()=>store.action(guest,{type:'refresh'},'manual',1),/观战/);
    store.watchControl(guest,'step',first.id);
    await until(()=>!!room.watch!.decision && room.watch!.decision.id!==first.id);
    assert.equal(store.ai.decisions,1);assert.equal(room.seats[0].game!.gold,gold-3);
    assert.ok(calls[1].rows[0].memory.every((v:number)=>v===1),'memory advanced exactly once');
    assert.throws(()=>store.watchControl(guest,'step',first.id),/已更新/);
    assert.equal(room.watch!.paused,true);assert.equal(store.view(guest).room!.watch!.decision!.id,room.watch!.decision!.id);
    assert.ok(store.view(guest).game!.opponents.every(o=>o.board.length===0));
  } finally {store.stop();}
});
test('autoplay paces previews, pause keeps them stable, and the viewer heartbeat retains an all-bot room', async () => {
  const {store,room,guest,advance,token}=fixture();
  try {
    await until(()=>!!room.watch!.decision);
    const first=room.watch!.decision!.id;
    store.watchControl(guest,'play'); store.tick();await delay(15);
    assert.equal(room.watch!.decision!.id,first);assert.equal(room.seats[0].game!.gold,3);
    store.watchControl(guest,'pause');advance(3000);store.tick();await delay(15);
    assert.equal(room.watch!.decision!.id,first);
    advance(OFFLINE_GRACE_MS+1);store.auth(token);store.tick();assert.equal(store.rooms.size,1);
    store.watchControl(guest,'play');advance(2100);store.tick();
    await until(()=>!!room.watch!.decision && room.watch!.decision.id!==first);
    store.watchControl(guest,'pause');
    const restored=new NeuralRooms(async()=>({rows:[]}), Date.now, Math.random, "trinkets-v5");
    try {restored.restore(store.dump());const r=restored.member(restored.auth(token)).r;
      assert.equal(r.watch!.paused,true);assert.equal(r.watch!.decision,undefined);
    } finally {restored.stop();}
    store.leave(guest);assert.equal(store.rooms.size,0);assert.equal(guest.room,undefined);
  } finally {store.stop();}
});
test('ending recruitment lets the other seven AIs finish; watch controls advance combat exactly once', async () => {
  const infer: Infer=async (body:any)=>({rows:body.rows.map((r:any)=>({action:r.legal.includes(0)?0:r.legal[0],memory:r.memory,
    ...(body.probabilities?{probabilities:r.legal.map((a:number)=>[a,a===(r.legal.includes(0)?0:r.legal[0])?1:0]),selectionMode:'greedy' as const}:{})}))});
  const {store,room,guest}=fixture(infer);
  try {
    await until(()=>!!room.watch!.decision);
    store.watchControl(guest,'step',room.watch!.decision!.id);
    await until(()=>room.stage==='combat');assert.equal(room.watch!.decision,undefined);
    assert.equal(room.seats.filter(s=>s.ended).length,8);
    store.watchControl(guest,'next',undefined,1);assert.equal(room.turn,2);
    assert.throws(()=>store.watchControl(guest,'next',undefined,1),/已更新/);
    await until(()=>!!room.watch!.decision);assert.equal(room.watch!.decision!.turn,2);
    const stranger=store.auth(store.guest('无关游客').token);
    assert.throws(()=>store.join(stranger,room.code),/房间码/);
    assert.throws(()=>store.watchControl(stranger,'play'),/不在房间/);
  } finally {store.stop();}
});
for (const malformed of ['missing','unnormalized','duplicate']) test(`watch rejects ${malformed} probabilities without scripting a move`,async()=>{
  const infer: Infer=async(body:any)=>{const r=body.rows[0];return {rows:[{action:r.legal[0],memory:r.memory,selectionMode:'sample',
    ...(malformed==='missing'?{}:{probabilities:malformed==='duplicate'?[[r.legal[0],.5],[r.legal[0],.5]]:r.legal.map((a:number)=>[a,1])})}]};};
  const {store,room}=fixture(infer);
  try {await until(()=>!!room.watch!.error);assert.equal(store.ai.decisions,0);assert.equal(store.ai.fallbackRounds,0);
    assert.equal(room.watch!.decision,undefined);assert.equal(room.watch!.paused,true);
  } finally {store.stop();}
});
test('paused spectator does not block normal AI games sharing the inference queue',async()=>{
  const {store,room,guest}=fixture();
  try {
    await until(()=>!!room.watch!.decision);
    const other=store.auth(store.guest('玩家').token),r=store.create(other,'ai','s14_lich','training');
    await until(()=>r.seats.filter(s=>s.bot).every(s=>s.ended));
    assert.equal(room.seats[0].game!.gold,3);assert.ok(room.watch!.decision);
    assert.throws(()=>store.watchControl(other,'pause'),/观战/);
    store.leave(guest);
  } finally {store.stop();}
});
