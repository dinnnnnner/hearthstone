import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotWriter } from "./persistence";

test("overlapping saves coalesce, write the latest state atomically, and skip unchanged data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tavern-writer-"));
  let dumps = 0;
  const source = {
    seq: 1,
    dump() {
      dumps++;
      return JSON.stringify({ seq: this.seq });
    },
  };
  const path = join(dir, "state.json"),
    writer = new SnapshotWriter(source, path);
  try {
    const first = writer.flush();
    source.seq = 2;
    const second = writer.flush();
    source.seq = 3;
    await Promise.all([first, second, writer.flush()]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).seq, 3);
    assert.equal(dumps, 2);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(stat(path + ".next"), { code: "ENOENT" });
    await writer.flush();
    assert.equal(dumps, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed replacement can be retried without marking unwritten state as saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tavern-writer-retry-"));
  const path = join(dir, "state.json");
  const source = { seq: 1, dump: () => '{"seq":1}' };
  const writer = new SnapshotWriter(source, path);
  try {
    await mkdir(path);
    await assert.rejects(writer.flush());
    await rm(path, { recursive: true });
    await writer.flush();
    assert.equal(JSON.parse(await readFile(path, "utf8")).seq, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
