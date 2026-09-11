/** Exercise a room for each configured model, sharing one outbound budget. */
import { configuredModels } from '../server/model-registry';
import { NeuralRooms } from '../server/neural';
import { setTimeout as delay } from 'node:timers/promises';
const models = configuredModels(process.argv[2], Number(process.argv[4] || 512));
const rounds = Number(process.argv[3] || 8);
const times = new Map<string, number[]>();
const traffic = models[0].infer.traffic;
for (const model of models) {
  const infer = model.infer;
  times.set(model.id, []);
  model.infer = async body => {
    const start = performance.now();
    const result = await infer(body);
    times.get(model.id)!.push(performance.now() - start);
    return result;
  };
}
let seed = 428;
const store = new NeuralRooms(models[0].infer, Date.now,
  () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32), models[0].profile, models);
const start = performance.now();
try {
  await store.checkModels();
  for (const model of models) {
    const guest = store.auth(store.guest(model.id.slice(0, 16)).token);
    const room = store.create(guest, 'friends', 's14_lich', 'training', 'free', model.id);
    store.start(guest); room.seats[0].bot = true;
  }
  while (store.rooms.size) {
    if (performance.now() - start > 600000) throw Error('Benchmark timeout');
    for (const room of store.rooms.values()) {
      if (room.stage === 'combat' || room.stage === 'finished') {
        console.log(JSON.stringify({ modelId: room.aiModel!.id, turn: room.turn, stage: room.stage,
          elapsedSeconds: (performance.now() - start) / 1000 }));
        if (room.turn >= rounds || room.stage === 'finished') store.rooms.delete(room.code);
        else store.next(room);
      }
    }
    if (store.ai.errors) throw Error(store.ai.lastError);
    await delay(10);
  }
  console.log(JSON.stringify({ totalSeconds: (performance.now() - start) / 1000, rounds,
    errors: store.ai.errors, fallbackRounds: store.ai.fallbackRounds, traffic,
    models: models.map(model => {
      const samples = times.get(model.id)!.sort((a, b) => a - b);
      return { id: model.id, decisions: samples.length,
        meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
        p95Ms: samples[Math.floor(samples.length * .95)], maxMs: samples.at(-1) };
    }) }));
} finally { store.stop(); }
