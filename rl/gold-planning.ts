import { RecruitSearchEnv, UnsupportedSearch } from './recruit-search';
import type { Entity } from './entities';

export const GOLD_PLANNING_VERSION = 'gold-rollout-v2';
export class GoldPlanningBatch {
  private branches: (RecruitSearchEnv | null)[] = [];
  constructor(roots: { entities: (Entity | null)[]; decisions: number; budget: number }[], requests: { root: number; seed: number }[]) {
    if (!Array.isArray(roots) || roots.length > 32 || !Array.isArray(requests) || requests.length > 96)
      throw Error('Invalid gold planning batch size');
    for (const request of requests) {
      if (!Number.isInteger(request.root) || request.root < 0 || request.root >= roots.length ||
          !Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff) throw Error('Invalid planning root or seed');
      const root = roots[request.root];
      try {
        const branch = new RecruitSearchEnv(root.entities, root.decisions, root.budget);
        branch.reset(request.seed); this.branches.push(branch);
      } catch (error) {
        if (!(error instanceof UnsupportedSearch)) throw error;
        this.branches.push(null);
      }
    }
  }
  views() { return this.branches.map(b => b?.view() ?? null); }
  expand(requests: { index: number; action: number; seeds?: number[] }[]) {
    if (!Array.isArray(requests) || requests.length > 96 || new Set(requests.map(r => r.index)).size !== requests.length)
      throw Error('Invalid planning expansion');
    let capacity = 0;
    for (const r of requests) {
      if (!Number.isInteger(r.index) || !this.branches[r.index] || !Number.isInteger(r.action))
        throw Error('Invalid planning branch');
      if (r.seeds !== undefined && (!Array.isArray(r.seeds) || r.seeds.length < 2 || r.seeds.length > 12 ||
          r.seeds.some(seed => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)))
        throw Error('Invalid planning chance seeds');
      capacity += r.seeds?.length ?? 1;
    }
    if (capacity > 96) throw Error('Invalid planning expansion size');
    const next: RecruitSearchEnv[] = [];
    const output = requests.flatMap(r => this.branches[r.index]!.planningStep(r.action, r.seeds).map(child => {
      const index = next.length; next.push(child.branch);
      return { parent: r.index, index, view: child.view, sampled: child.sampled };
    }));
    this.branches = next;
    return output;
  }
  step(requests: { index: number; action: number }[]) {
    if (!Array.isArray(requests) || requests.length > 96 || new Set(requests.map(r => r.index)).size !== requests.length)
      throw Error('Invalid planning step batch');
    for (const r of requests) if (!Number.isInteger(r.index) || !this.branches[r.index] || !Number.isInteger(r.action))
      throw Error('Invalid planning branch');
    return requests.map(r => this.branches[r.index]!.step(r.action));
  }
}
