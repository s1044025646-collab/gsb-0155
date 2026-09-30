import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, type DB } from "../src/db.ts";
import { createBatch, importReads } from "../src/services/batches.ts";
import { runAssembly } from "../src/services/assembler.ts";
import type { Clock } from "../src/util.ts";

export const fixedClock: Clock = { now: () => 1_700_000_000_000 };

export function tempDb(): { db: DB; dir: string; path: string } {
  const root = join(process.cwd(), "data");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "test-"));
  const path = join(dir, "t.db");
  return { db: openDb(path), dir, path };
}

export function cleanup(dir: string): void {
  // Windows can briefly retain WAL file handles right after close; retry briefly.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
export function reopen(path: string): DB {
  return openDb(path);
}

export function seedBatch(db: DB, reads: { readCode: string; seq: string }[], name = "b"): number {
  const id = createBatch(db, name + Math.random().toString(36).slice(2, 7), "", fixedClock);
  importReads(db, id, reads, { clock: fixedClock });
  return id;
}

export function assemble(db: DB, batchId: number, k: number, maxNodes?: number) {
  return runAssembly(db, batchId, { k, maxNodes, clock: fixedClock });
}

export function freshMigrateOnly(): { db: DB; dir: string } {
  const { db, dir } = tempDb();
  db.close();
  const reopened = openDb(join(dir, "t.db"));
  migrate(reopened); // running migration twice must be a no-op
  return { db: reopened, dir };
}
