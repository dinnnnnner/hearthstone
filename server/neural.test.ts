import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NeuralRooms, httpInference, inferenceBudget, recruitSearchBudget, type Infer } from './neural';
import { ACTIONS } from '../rl/actions';
import { inferenceProfile } from './neural-profile';
import { createServer } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { makeMinion } from '../src/engine';
import { publicAIActionLimits } from '../src/ai-action-limits';

function setup(infer: Infer) {
  let seed = 42;
  const store = new NeuralRooms(infer, Date.now, () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32));
  const guest = store.auth(store.guest('测试').token);
  const room = store.create(guest, 'friends', 's14_lich', 'training', 'free');
  store.start(guest);
  return { store, room, guest };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await delay(5);
  assert.ok(check(), 'async bots completed');
}
const endPolicy: Infer = async (body: any) => ({ rows: body.rows.map((r: any) => ({
  action: r.legal.includes(0) ? 0 : r.legal[0], memory: r.memory.map((n: number) => n + .01),
})) });

test('search time shrinks with the recruit clock and reserves direct-policy time before the rope ends', () => {
  assert.equal(recruitSearchBudget(0, 100000, 7), 1000);
  assert.equal(recruitSearchBudget(90000, 0, 7), 628);
  assert.equal(recruitSearchBudget(90000, 80000, 7), 57);
  assert.equal(recruitSearchBudget(90000, 88000, 7), 0);
  assert.equal(recruitSearchBudget(90000, 90001, 7), 0);
});

test('rope expiry starts combat and discards a still-pending search response', async () => {
  let now = 100000, calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const infer: Infer = async (body: any) => {
    calls++; await gate;
    return { rows: [{ action: 2, memory: body.rows[0].memory.map((n: number) => n + 1) }] };
  };
  const store = new NeuralRooms(infer, () => now, () => .3, 'scouting-v4', [
    { id: 'search', label: 'search', profile: 'scouting-v4', search: true, infer },
  ]);
  try {
    const guest = store.auth(store.guest('rope-search').token);
    const room = store.create(guest, 'ai', 's14_patchwerk', 'timed', 'free', 'search');
    await until(() => calls === 1);
    now = room.deadline; store.tick();
    assert.equal(room.stage, 'combat');
    const revision = room.storageRev;
    release(); await delay(20);
    assert.equal(store.ai.decisions, 0); assert.equal(room.storageRev, revision);
  } finally { release(); store.stop(); }
});

test('64-layer search mode can act beyond 96 decisions and sends only the public policy input', async () => {
  let calls = 0;
  const infer: Infer = async (body: any) => {
    calls++;
    assert.equal(body.search, true);
    assert.deepEqual(Object.keys(body.rows[0]).sort(), ['entities', 'legal', 'memory', 'previous']);
    const text = JSON.stringify(body);
    for (const key of ['"pool"', '"initialPool"', '"copies"', '"rng"']) assert.ok(!text.includes(key));
    const row = body.rows[0], count = row.entities[0].details.decisions;
    assert.ok(row.legal.includes(1), 'resource-backed refresh stays legal beyond the old action cap');
    return { rows: [{ action: count < 110 ? 1 : 0, memory: row.memory.map((n: number) => n + 1) }] };
  };
  const store = new NeuralRooms(infer, Date.now, () => .3, 'scouting-v4', [
    { id: 'deep64-search', label: '64 搜索', profile: 'scouting-v4', search: true, infer },
  ]);
  try {
    const guest = store.auth(store.guest('search-test').token);
    const room = store.create(guest, 'ai', 's14_patchwerk', 'training', 'free', 'deep64-search');
    // Keep one bot active so the test exercises that seat's entire long turn.
    const bot = room.seats.find(p => p.bot)!;
    for (const p of room.seats) if (p.bot && p !== bot) p.ended = true;
    store.autoChoices(room, bot);
    bot.game!.season!.freeRefresh = 150;
    await until(() => bot.ended);
    assert.equal(calls, 111); assert.equal(store.ai.errors, 0);
    assert.equal(room.turn, 1); assert.equal(room.stage, 'recruit');
  } finally { store.stop(); }
});

test('search bots cannot endlessly freeze and unfreeze an unchanged shop', async () => {
  const choices: number[] = [];
  const infer: Infer = async (body: any) => {
    const row = body.rows[0], action = row.legal.includes(2) ? 2 : 0; choices.push(action);
    return { rows: [{ action, memory: row.memory }] };
  };
  const store = new NeuralRooms(infer, Date.now, () => .3, 'scouting-v4', [
    { id: 'search', label: 'search', profile: 'scouting-v4', search: true, infer },
  ]);
  try {
    const guest = store.auth(store.guest('freeze-loop').token);
    const room = store.create(guest, 'ai', 's14_patchwerk', 'training', 'free', 'search');
    const bot = room.seats.find(p => p.bot)!;
    for (const p of room.seats) if (p.bot && p !== bot) p.ended = true;
    store.autoChoices(room, bot);
    await until(() => bot.ended);
    assert.deepEqual(choices, [2, 2, 0]); assert.equal(store.ai.errors, 0);
  } finally { store.stop(); }
});

for (const search of [false, true]) test(`${search ? 'search' : 'ordinary'} bots share persistent freeze/move limits and keep other actions legal`, async () => {
  const observed: { freezes: number; moves: number }[] = [];
  const infer: Infer = async (body: any) => {
    const row = body.rows[0], limits = row.entities[0].details.aiActionLimits;
    assert.ok(limits); observed.push({ freezes: limits.freezeRemaining, moves: limits.moveRemaining });
    const move = row.legal.find((id: number) => ACTIONS[id].type === 'move');
    const action = row.legal.includes(2) ? 2 : move ?? 0;
    return { rows: [{ action, memory: row.memory }] };
  };
  const store = new NeuralRooms(infer, Date.now, () => .3, 'scouting-v4', [
    { id: 'limits', label: 'limits', profile: 'scouting-v4', search, infer },
  ]);
  try {
    const guest = store.auth(store.guest('limits-test').token);
    const room = store.create(guest, 'ai', 's14_patchwerk', 'training', 'free', 'limits');
    const bot = room.seats.find(p => p.bot)!;
    for (const p of room.seats) if (p.bot && p !== bot) p.ended = true;
    store.autoChoices(room, bot);
    bot.game!.board = ['s14_BG25_001', 's14_BG20_100', 's14_BG21_015'].map(id => makeMinion(id));
    await until(() => bot.ended);
    assert.equal(store.ai.errors, 0);
    assert.equal(observed.length, 9); // Two toggles, six moves, then end.
    assert.deepEqual(observed.at(-1), { freezes: 0, moves: 0 });
    assert.equal(publicAIActionLimits(bot.game!)!.freezeRemaining, 0);
    // Reconstruct the actual room save, without a neural-memory cache.
    const restored = new NeuralRooms(endPolicy); restored.restore(store.dump());
    try {
      const loaded = restored.rooms.get(room.code)!.seats.find(p => p.id === bot.id)!;
      assert.equal(publicAIActionLimits(loaded.game!)!.moveRemaining, 0);
      assert.ok(restored.apply(restored.rooms.get(room.code)!, loaded, { type: 'freeze' }));
    } finally { restored.stop(); }
    const human = room.seats.find(p => !p.bot)!;
    for (let i = 0; i < 3; i++) assert.equal(store.apply(room, human, { type: 'freeze' }), undefined);
    assert.equal(human.game!.aiActionUsage, undefined);
  } finally { store.stop(); }
});

test('neural bots await policy without blocking the human; last bot starts combat', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let calls = 0;
  const { store, room, guest } = setup(async body => { calls++; await gate; return endPolicy(body); });
  try {
    await until(() => calls === 1);
    assert.equal(room.seats.filter(p => p.bot && p.ended).length, 0);
    store.action(guest, { type: 'end' }, 'human-end', room.turn);
    assert.equal(room.stage, 'recruit');
    release();
    await until(() => room.stage === 'combat');
    assert.ok(store.ai.decisions >= 7);
    assert.equal(store.ai.errors, 0);
  } finally { release(); store.stop(); }
});

test('late model response cannot mutate a deleted room', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let calls = 0;
  const { store, room } = setup(async body => { calls++; await gate; return endPolicy(body); });
  try {
    await until(() => calls === 1);
    const revision = room.storageRev;
    store.rooms.delete(room.code); release(); await delay(30);
    assert.equal(store.ai.decisions, 0);
    assert.equal(room.storageRev, revision);
  } finally { release(); store.stop(); }
});

test('inference failure falls back and finishes a training round', async () => {
  const { store, room, guest } = setup(async () => { throw Error('test unavailable'); });
  try {
    store.action(guest, { type: 'end' }, 'human-end', room.turn);
    await until(() => room.stage === 'combat');
    assert.equal(store.ai.mode, 'fallback');
    assert.equal(store.ai.errors, 1);
    assert.equal(store.ai.fallbackRounds, 1);
  } finally { store.stop(); }
});

test('a response for an obsolete pairing is discarded before applying its action or memory', async () => {
  let releaseFirst!: () => void, releaseRest!: () => void;
  const first = new Promise<void>(r => { releaseFirst = r; });
  const rest = new Promise<void>(r => { releaseRest = r; });
  let calls = 0;
  const { store, room } = setup(async body => { await (++calls === 1 ? first : rest); return endPolicy(body); });
  try {
    await until(() => calls === 1);
    // Rebuilding the live-seat cycle replaces this object, even within the same turn.
    room.pairings = structuredClone(room.pairings);
    releaseFirst();
    await until(() => calls === 2);
    assert.equal(store.ai.decisions, 0);
    assert.ok(room.seats.filter(p => p.bot).every(p => !p.ended));
    releaseRest();
    await until(() => room.seats.filter(p => p.bot).every(p => p.ended));
    assert.equal(store.ai.errors, 0);
  } finally { releaseFirst(); releaseRest(); store.stop(); }
});

test('policy memory persists between turns and never crosses seats', async () => {
  const requests: any[] = [];
  const { store, room, guest } = setup(async (body: any) => { requests.push(body.rows[0]); return endPolicy(body); });
  try {
    await until(() => room.seats.filter(p => p.bot).every(p => p.ended));
    assert.ok(requests.filter(r => r.previous === ACTIONS.length).length === 7);
    store.action(guest, { type: 'end' }, 'end-1', room.turn);
    const first = requests.length;
    store.action(guest, { type: 'continue' }, 'continue-1', room.turn);
    await until(() => room.seats.filter(p => p.bot).every(p => p.ended));
    assert.ok(requests.slice(first).every(r => r.previous !== ACTIONS.length));
    assert.ok(requests.slice(first).every(r => r.memory[0] > 0));
  } finally { store.stop(); }
});

test('HTTP inference only permits loopback endpoints', () => {
  assert.throws(() => httpInference('http://example.com:8790'), /loopback/);
  assert.throws(() => httpInference('https://127.0.0.1:8790'), /loopback/);
  for (const maxKbps of [NaN, Infinity, -1])
    assert.throws(() => httpInference('http://127.0.0.1:8790', { maxKbps }), /bandwidth limit/);
});

test('scouting profile preserves the legacy contract and sends completed public battles to the new model', async () => {
  assert.equal(inferenceProfile().contract, '1f3f636a3d358f038c0c7dff22a098c35e5d9c1a753adcb560e8a816dd3179ea');
  assert.notEqual(inferenceProfile('scouting-v4').contract, inferenceProfile().contract);
  assert.throws(() => inferenceProfile('invalid'), /Unknown inference profile/);
  const requests: any[] = [];
  const store = new NeuralRooms(async (body: any) => { requests.push(body); return endPolicy(body); }, Date.now, () => .37, 'scouting-v4');
  const guest = store.auth(store.guest('测试').token);
  const room = store.create(guest, 'ai', 's14_lich', 'training', 'free');
  try {
    store.autoChoices(room, room.seats[0]);
    store.action(guest, { type: 'end' }, 'end', 1);
    await until(() => room.stage === 'combat');
    store.action(guest, { type: 'continue' }, 'continue', 1);
    await until(() => requests.some(r => r.rows[0].entities[0].details.turn === 2));
    const request = requests.find(r => r.rows[0].entities[0].details.turn === 2);
    assert.equal(request.contract, inferenceProfile('scouting-v4').contract);
    const opponents = request.rows[0].entities.filter((e: any) => e?.zone === 7);
    assert.ok(opponents.every((e: any) => e.details.scouting[0].turn === 1));
    assert.ok(opponents.every((e: any) => !('board' in e.details) && !('hand' in e.details)));
  } finally { store.stop(); }
});

test('compressed inference preserves requests and replies and paces outbound bandwidth', async () => {
  const received: number[] = [];
  const body = { text: '公开战况'.repeat(1000) };
  const reply = { rows: [{ action: 0, memory: Array(128).fill(.25) }], padding: 'x'.repeat(2000) };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()), body);
    received.push(performance.now());
    const payload = gzipSync(JSON.stringify(reply));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': payload.length });
    res.end(payload);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const budget = inferenceBudget(16);
    const infer = httpInference(`http://127.0.0.1:${port}`, { compress: true, budget });
    const otherModel = httpInference(`http://127.0.0.1:${port}`, { compress: true, budget });
    assert.deepEqual(await infer(body), reply);
    assert.deepEqual(await otherModel(body), reply);
    assert.ok(received[1] - received[0] >= 200, 'compressed requests respect the configured pacing');
    assert.equal(infer.traffic!.requests, 2);
    assert.ok(infer.traffic!.requestBytes < infer.traffic!.rawRequestBytes / 10);
    assert.ok(infer.traffic!.responseBytes > 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('rooms route to the selected frozen model and retain it across reload and rematch', async () => {
  const seen = new Map<string, any[]>();
  const models = ['deep64', 'deep256', 'deep1024'].map((id, i) => {
    seen.set(id, []);
    return { id, label: id, episodes: i + 1, profile: 'scouting-v4', checkpointSha256: String(i + 1).repeat(64),
      infer: async (body: any) => { seen.get(id)!.push(body); return endPolicy(body); } };
  });
  const store = new NeuralRooms(endPolicy, Date.now, () => .37, 'scouting-v4', models);
  const restored = new NeuralRooms(endPolicy, Date.now, () => .37, 'scouting-v4', models);
  try {
    for (const model of models) {
      const guest = store.auth(store.guest(model.id).token);
      const room = store.create(guest, 'friends', 's14_lich', 'training', 'free', model.id);
      store.start(guest); store.autoChoices(room, room.seats[0]);
      store.action(guest, { type: 'end' }, 'end', 1);
    }
    await until(() => [...store.rooms.values()].every(r => r.stage === 'combat'));
    for (const model of models) {
      const requests = seen.get(model.id)!;
      assert.equal(requests.length, 7);
      assert.ok(requests.every(r => r.checkpointSha256 === model.checkpointSha256));
      assert.ok(requests.every(r => r.rows[0].memory.every((n: number) => n === 0)));
    }
    restored.restore(store.dump());
    for (const room of restored.rooms.values()) {
      const original = store.rooms.get(room.code)!;
      assert.deepEqual(room.aiModel, original.aiModel);
      const guest = [...restored.guests.values()].find(g => g.id === room.host)!;
      assert.deepEqual(restored.view(guest).room!.aiModel, original.aiModel);
      room.stage = 'finished'; restored.rematch(guest);
      assert.deepEqual(room.aiModel, original.aiModel);
    }
    const guest = store.auth(store.guest('invalid').token);
    assert.throws(() => store.create(guest, 'ai', 's14_lich', 'training', 'free', 'missing'), /无效的人机模型/);
    assert.equal(guest.room, undefined);
  } finally { store.stop(); restored.stop(); }
});

test('one model outage falls back only its rooms and availability is refreshed', async () => {
  let online = true;
  const models = [
    { id: 'offline', label: 'offline', profile: 'scouting-v4', health: async () => online,
      infer: async () => { throw Error('disconnected'); } },
    { id: 'working', label: 'working', profile: 'scouting-v4', infer: endPolicy },
  ];
  const store = new NeuralRooms(endPolicy, Date.now, () => .37, 'scouting-v4', models);
  try {
    await store.checkModels();
    for (const model of models) {
      const guest = store.auth(store.guest(model.id).token);
      const room = store.create(guest, 'ai', 's14_lich', 'training', 'free', model.id);
      store.autoChoices(room, room.seats[0]); store.action(guest, { type: 'end' }, 'end', 1);
    }
    await until(() => [...store.rooms.values()].every(r => r.stage === 'combat'));
    assert.equal(store.modelStats().find(m => m.id === 'working')!.decisions, 7);
    assert.equal(store.modelStats().find(m => m.id === 'working')!.errors, 0);
    assert.deepEqual([...store.rooms.values()].map(r => r.aiStatus), ['fallback', 'neural']);
    online = false; await store.checkModels();
    const guest = store.auth(store.guest('retry').token);
    assert.throws(() => store.create(guest, 'ai', 's14_lich', 'training', 'free', 'offline'), /暂时不可用/);
    online = true; await store.checkModels();
    assert.equal(store.modelOptions()[0].available, true);
  } finally { store.stop(); }
});

test('restoring a room never silently replaces its checkpoint with another version', async () => {
  let calls = 0;
  const model = { id: 'frozen', label: 'frozen', profile: 'scouting-v4', checkpointSha256: 'a'.repeat(64),
    infer: async (body: any) => { calls++; return endPolicy(body); } };
  const store = new NeuralRooms(endPolicy, Date.now, () => .37, 'scouting-v4', [model]);
  try {
    const guest = store.auth(store.guest('frozen').token);
    const room = store.create(guest, 'friends', 's14_lich', 'training', 'free', model.id);
    room.aiModel!.checkpointSha256 = 'b'.repeat(64);
    store.start(guest); store.autoChoices(room, room.seats[0]);
    store.action(guest, { type: 'end' }, 'end', 1);
    await until(() => room.stage === 'combat');
    assert.equal(calls, 0);
    assert.equal(room.aiStatus, 'fallback');
  } finally { store.stop(); }
});
