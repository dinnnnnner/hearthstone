/** Exercise real eight-seat rooms without a browser; never opens public rooms. */
import { NeuralRooms, httpInference } from '../server/neural';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
const endpoint = process.argv[2] || 'http://127.0.0.1:18790';
const rounds = Number(process.argv[3] || 8), count = Number(process.argv[4] || 1);
const profile = process.argv[5] || 'legacy-v3';
const infer = httpInference(endpoint, { compress: profile === 'scouting-v4', maxKbps: Number(process.argv[6] || 0) }), times: number[] = [];
let samples = 0, seed = 428;
const store = new NeuralRooms(async body => {
  const start = performance.now();
  const result = await infer(body); times.push(performance.now() - start);
  if (samples++ === 0 || samples === 200) writeFileSync(`/tmp/tavern-inference-sample-${samples}.json`, JSON.stringify(body));
  return result;
}, Date.now, () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32), profile);
const start = performance.now();
for (let i = 0; i < count; i++) {
  const g = store.auth(store.guest('推理测试' + i).token);
  const r = store.create(g, 'friends', 's14_lich', 'training', 'free');
  store.start(g); r.seats[0].bot = true;
}
try {
  while (store.rooms.size) {
    if (performance.now() - start > 300000) throw Error('Benchmark timeout');
    for (const r of store.rooms.values()) {
      if (r.stage === 'combat' || r.stage === 'finished') {
        console.log(JSON.stringify({room: r.code, turn: r.turn, stage: r.stage,
          elapsedSeconds: (performance.now() - start) / 1000, ...store.ai }));
        if (r.turn >= rounds || r.stage === 'finished') store.rooms.delete(r.code);
        else store.next(r);
      }
    }
    if (store.ai.errors) throw Error(store.ai.lastError);
    await delay(10);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ decisions: times.length, rooms: count, rounds,
    totalSeconds: (performance.now() - start) / 1000,
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
    p50Ms: times[Math.floor(times.length * .5)], p95Ms: times[Math.floor(times.length * .95)],
    maxMs: times.at(-1), nodeRssMiB: process.memoryUsage().rss / 2 ** 20, traffic: infer.traffic }));
} finally { store.stop(); }
