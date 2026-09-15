/** Generate public functional fixtures; no full room snapshots or training data. */
import { SelfPlayEnv } from '../rl/environment';
import { ACTIONS } from '../rl/actions';
const env = new SelfPlayEnv({ maxActionsPerTurn: 16, heroes: [
  'patchwerk', 'brann', 'lich', 'george', 'reno', 'yogg', 'shudderwock', 'millificent',
].map(h => 's14_' + h) });
let state = env.reset(0);
const rows = [], recorded = new Set<number>();
const priority = ['choosePower', 'discover', 'buyTrinket', 'play', 'cast', 'buy', 'upgrade', 'power', 'buySpell', 'end'];
const order = (id: number) => { const n = priority.indexOf(ACTIONS[id].type); return n < 0 ? 99 : n; };
for (let n = 0; n < 5000 && !state.terminated && !state.truncated; n++) {
  if (state.actor === 0 && [1, 4, 8].includes(state.info.turn) && !recorded.has(state.info.turn)) {
    rows.push({ entities: state.entities, legal: state.legalActions, memory: Array(128).fill(0), previous: ACTIONS.length });
    recorded.add(state.info.turn);
    if (rows.length === 3) break;
  }
  state = env.step([...state.legalActions].sort((a, b) => order(a) - order(b))[0]);
}
if (rows.length !== 3) throw Error('Fixture game ended before all requested turns');
console.log(JSON.stringify(rows));
