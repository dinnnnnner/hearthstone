import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

type Source = { seq: number; dump(): string };
// At most one atomic replacement is in flight. Changes made during I/O are
// coalesced into the next snapshot, so an older write cannot win a race.
export class SnapshotWriter {
  private saved = -1;
  private running?: Promise<void>;
  constructor(
    private source: Source,
    private path: string,
  ) {}
  flush(): Promise<void> {
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }
  private async drain() {
    while (this.saved !== this.source.seq) {
      const seq = this.source.seq,
        data = this.source.dump();
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path + ".next", data, { mode: 0o600 });
      await rename(this.path + ".next", this.path);
      this.saved = seq;
    }
  }
}
