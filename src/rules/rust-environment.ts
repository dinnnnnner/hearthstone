import { RustKernel } from './rust-kernel';

/** Owns one native session. Every environment transition stays inside Rust. */
export class RustSelfPlayEnvironment {
  private session: number | undefined;
  readonly meta: Record<string, unknown>;
  constructor(readonly kernel: RustKernel) {
    kernel.requireFullEngine();
    this.meta = kernel.call({ command: 'envMeta' });
    this.session = kernel.call({ command: 'envCreate' });
  }
  private request<T>(command: string, fields: Record<string, unknown> = {}): T {
    if (this.session === undefined) throw Error('Native environment is closed');
    return this.kernel.call<T>({ ...fields, command, session: this.session });
  }
  reset(seed: number, options: Record<string, unknown> = {}) { return this.request('envReset', { seed, options }); }
  step(action: number) { return this.request('envStep', { action }); }
  view() { return this.request('envView'); }
  snapshot() { return this.request('envSnapshot'); }
  restore(snapshot: unknown) { return this.request('envRestore', { snapshot }); }
  replay() { return this.request('envReplay'); }
  close() {
    if (this.session !== undefined) {
      this.request('envClose');
      this.session = undefined;
    }
  }
}
