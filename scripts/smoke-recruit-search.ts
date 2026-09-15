/** Isolated in-memory room. Uses live inference, but creates no public accounts/rooms. */
import { writeFileSync } from 'node:fs';
import { NeuralRooms, httpInference, type Infer } from '../server/neural';
const endpoint = process.argv[2] || 'http://127.0.0.1:18898';
const output = process.argv[3] || '/tmp/tavern-search-room-smoke.json';
const raw = httpInference(endpoint), actions: unknown[] = [];
const infer: Infer = async (body: any) => {
  const result = await raw(body);
  actions.push({ turn: body.rows[0].entities[0].details.turn, action: result.rows[0].action });
  return result;
};
const store = new NeuralRooms(infer, Date.now, () => .3, 'scouting-v4', [
  { id: 'search', label: 'search', profile: 'scouting-v4', search: true, infer },
]);
try {
  const guest = store.auth(store.guest('搜索测试').token);
  const room = store.create(guest, 'ai', 's14_patchwerk', 'training', 'free', 'search');
  const rounds = [];
  for (let turn = 1; turn <= 3; turn++) {
    const bot = room.seats.find(p => p.bot)!;
    for (const p of room.seats) if (p.bot && p !== bot) p.ended = true;
    store.autoChoices(room, bot); store.autoChoices(room, room.seats[0]);
    store.action(guest, { type: 'end' }, 'test-end-' + turn, turn);
    const started = Date.now();
    while (room.stage === 'recruit' && Date.now() - started < 45000) await new Promise(resolve => setTimeout(resolve, 100));
    rounds.push({ turn, stage: room.stage, elapsed_ms: Date.now() - started, decisions: store.ai.decisions,
      board_size: bot.game!.board.length, gold: bot.game!.gold });
    if (room.stage !== 'combat' || store.ai.errors) { process.exitCode = 1; break; }
    if (turn < 3) store.action(guest, { type: 'continue' }, 'test-next-' + turn, turn);
  }
  const result = { rounds, errors: store.ai.errors, lastError: store.ai.lastError, actions };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { store.stop(); }
