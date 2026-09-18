import type { Action, Game } from '../engine';
import { RustKernel } from './rust-kernel';
interface Transition { state: Game; error?: string; rng: number; uidCounter: number; }
/** One deterministic rule stream; the host only handles transport and presentation. */
export class RustGameRules {
  private rng: number;
  private uidCounter = 0;
  constructor(readonly kernel: RustKernel, seed: number) {
    kernel.requireFullEngine();
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('Seed must be uint32');
    this.rng = seed;
  }
  private transition(command: string, fields: Record<string, unknown>): Transition {
    const result = this.kernel.call<Transition>({ ...fields, command, seed: this.rng, uidCounter: this.uidCounter });
    this.rng = result.rng;
    this.uidCounter = result.uidCounter;
    return result;
  }
  create(hero: string, options?: Record<string, unknown>) { return this.transition('createSeason', { hero, options }).state; }
  act(state: Game, action: Action, privateContext?: { opponentBoard: Game['board'] }) {
    return this.transition('actSeason', { state, action, privateContext });
  }
  releasePlayerCards(state: Game) { return this.transition('releasePlayerCards', { state }).state; }
  endEffects(state: Game) { return this.transition('endEffects', { state }).state; }
  advanceRecruit(state: Game) { return this.transition('advanceRecruit', { state }).state; }
  combat(state: Game, other: Game) {
    const result = this.kernel.call<Transition & { other: Game; battle: NonNullable<Game['battle']> }>({ command: 'combat', state, other, seed: this.rng, uidCounter: this.uidCounter });
    this.rng = result.rng;
    this.uidCounter = result.uidCounter;
    return result;
  }
  snapshot() { return { rng: this.rng, uidCounter: this.uidCounter }; }
  restore(saved: { rng: number; uidCounter: number }) {
    if (!Number.isInteger(saved.rng) || saved.rng < 0 || saved.rng > 0xffffffff || !Number.isSafeInteger(saved.uidCounter) || saved.uidCounter < 0) throw Error('Invalid Rust stream snapshot');
    this.rng = saved.rng;
    this.uidCounter = saved.uidCounter;
  }
}
