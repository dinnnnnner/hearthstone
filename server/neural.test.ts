import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NeuralRooms, httpInference, type Infer } from './neural';
import { ACTIONS } from '../rl/actions';
import { inferenceProfile } from './neural-profile';
import { createServer } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';

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
    const infer = httpInference(`http://127.0.0.1:${port}`, { compress: true, maxKbps: 16 });
    assert.deepEqual(await infer(body), reply);
    assert.deepEqual(await infer(body), reply);
    assert.ok(received[1] - received[0] >= 200, 'compressed requests respect the configured pacing');
    assert.equal(infer.traffic!.requests, 2);
    assert.ok(infer.traffic!.requestBytes < infer.traffic!.rawRequestBytes / 10);
    assert.ok(infer.traffic!.responseBytes > 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
