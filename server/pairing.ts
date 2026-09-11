export type Pair = [string, string | null];

// A fixed round-robin schedule repeats only after every other seat was faced.
export function roundRobinPairings(members: string[], round: number): Pair[] {
  if (members.length < 2) return [];
  const order: (string | null)[] = [...members];
  if (order.length % 2) order.push(null);
  const tail = order.splice(1), shift = round % tail.length;
  order.push(...tail.slice(shift), ...tail.slice(0, shift));
  const pairs: Pair[] = [];
  while (order.length) {
    const first = order.shift()!, last = order.pop()!;
    pairs.push(first === null ? [last!, null] : [first, last]);
  }
  return pairs;
}

export interface PairingCycle {
  members: string[];
  order?: string[];
  startTurn: number;
  lastTurn?: number;
  pairs?: Pair[];
  meetings: Record<string, { count: number; turn: number }>;
  ghosts: Record<string, number>;
}
export function createPairingCycle(members: string[], turn: number): PairingCycle {
  return { members: [...members], startTurn: turn, meetings: {}, ghosts: {} };
}
const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort());
function matchings(ids: string[]): Pair[][] {
  if (!ids.length) return [[]];
  const [first, ...rest] = ids;
  return rest.flatMap((other, i) => matchings(rest.filter((_, j) => i !== j))
    .map(tail => [[first, other] as Pair, ...tail]));
}
export function cyclePairings(cycle: PairingCycle, turn: number, ghostCandidates: string[], rng: () => number, previousPairs: Pair[] = []): Pair[] {
  if (cycle.lastTurn === turn && cycle.pairs) return cycle.pairs;
  const previous = new Set(previousPairs.filter(([, b]) => b).map(([a, b]) => pairKey(a, b!)));
  const repeatsLastRound = (pairs: Pair[]) => cycle.members.length > 2 && pairs.some(([a, b]) => b && previous.has(pairKey(a, b)));
  let pairs: Pair[];
  if (cycle.members.length % 2 === 0) {
    if (!cycle.order && cycle.startTurn === turn && previous.size) {
      const options = matchings(cycle.members).filter(p => !repeatsLastRound(p));
      const first = options[Math.floor(rng() * options.length)];
      if (first) cycle.order = [...first.map(([a]) => a), ...first.map(([, b]) => b!).reverse()];
    }
    pairs = roundRobinPairings(cycle.order || cycle.members, turn - cycle.startTurn);
  }
  else {
    let best = Infinity, ties = 0;
    pairs = [];
    for (const ghost of ghostCandidates) for (const matches of matchings(cycle.members.filter(id => id !== ghost))) {
      if (repeatsLastRound(matches)) continue;
      const repeatCost = matches.reduce((total, [a, b]) => {
        const prior = cycle.meetings[pairKey(a, b!)];
        return total + (prior ? prior.count * 10000 + Math.max(0, 100 - (turn - prior.turn)) * 10 : 0);
      }, 0);
      const cost = repeatCost + (cycle.ghosts[ghost] || 0);
      if (cost < best) { best = cost; ties = 0; }
      if (cost === best && rng() < 1 / ++ties) pairs = [...matches, [ghost, null]];
    }
  }
  for (const [a, b] of pairs) {
    if (b) {
      const key = pairKey(a, b);
      cycle.meetings[key] = { count: (cycle.meetings[key]?.count || 0) + 1, turn };
    } else cycle.ghosts[a] = (cycle.ghosts[a] || 0) + 1;
  }
  cycle.lastTurn = turn; cycle.pairs = pairs;
  return pairs;
}
