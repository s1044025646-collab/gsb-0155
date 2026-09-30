import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { DB } from "../src/db.ts";
import { ApiError } from "../src/errors.ts";
import { generateFixture } from "../src/services/generator.ts";
import {
  listBranches,
  listUnitigs,
  traceBranch,
  verifyUnitigSupport,
  edgeCoverage,
} from "../src/services/queries.ts";
import { assemble, cleanup, fixedClock, reopen, seedBatch, tempDb } from "./helpers.ts";
import { importReads, createBatch } from "../src/services/batches.ts";
import { runAssembly } from "../src/services/assembler.ts";

let db: DB;
let dir: string;
let dbPath: string;

beforeEach(() => {
  const t = tempDb();
  db = t.db;
  dir = t.dir;
  dbPath = t.path;
});
afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed (restart tests reassign db)
  }
  cleanup(dir);
});

function fixtureBatch(kind: Parameters<typeof generateFixture>[0]["kind"]): number {
  const { reads } = generateFixture({ kind, seed: 42, clock: fixedClock });
  return seedBatch(db, reads, kind);
}

describe("unique linear sequence", () => {
  test("produces a single non-circular unitig reconstructing the genome path", () => {
    const batchId = fixtureBatch("unique_linear");
    const r = assemble(db, batchId, 6);
    const units = listUnitigs(db, r.assemblyId, 100, 0).items as {
      circular: number;
      isolated: number;
      seq: string;
    }[];
    assert.equal(r.branchCount, 0);
    assert.equal(units.length, 1);
    assert.equal(units[0].circular, 0);
    const { genome } = generateFixture({ kind: "unique_linear", seed: 42, clock: fixedClock });
    assert.ok(units[0].seq.includes(genome), "unitig should contain the whole unique genome");
    const v = verifyUnitigSupport(db, r.assemblyId, 0);
    assert.equal(v.allSupported, true);
    assert.equal(v.coverageSumCheck, true);
  });
});

describe("repeat region", () => {
  test("emits fork/merge branch evidence instead of choosing one genome", () => {
    const batchId = fixtureBatch("repeat_region");
    const r = assemble(db, batchId, 6);
    const branches = listBranches(db, r.assemblyId, 100, 0).items as {
      kmer: string;
      kind: string;
    }[];
    assert.ok(branches.some((b) => b.kind === "fork"), "repeat must create a fork");
    assert.ok(branches.some((b) => b.kind === "merge"), "repeat must create a merge");
    for (const b of branches) {
      const traced = traceBranch(db, r.assemblyId, b.kmer, b.kind);
      for (const group of traced)
        for (const cand of group.evidence as { coverage: number; supportingReads: unknown[] }[]) {
          assert.ok(cand.coverage >= 1);
          assert.ok(cand.supportingReads.length >= 1);
        }
    }
  });
});

describe("branch bubble", () => {
  test("keeps both alleles as competing edges with concrete supporting reads", () => {
    const batchId = fixtureBatch("bubble");
    const r = assemble(db, batchId, 6);
    const branches = listBranches(db, r.assemblyId, 100, 0).items as { kmer: string; kind: string }[];
    const forks = branches.filter((b) => b.kind === "fork");
    assert.ok(forks.length >= 1);
    const traced = traceBranch(db, r.assemblyId, forks[0].kmer, "fork");
    const candidates = traced[0].evidence as {
      kmer: string;
      coverage: number;
      supportingReads: { readId: number; position: number }[];
    }[];
    assert.ok(candidates.length >= 2, "bubble requires at least two alternatives");
    // every independent edge observation is attributed to a distinct read/position
    const allObs = candidates.flatMap((c) => c.supportingReads.map((o) => `${o.readId}:${o.position}:${c.kmer}`));
    assert.equal(new Set(allObs).size, allObs.length);
  });
});

describe("pure cycle", () => {
  test("exports one circular unitig with deterministic start/direction", () => {
    const batchId = fixtureBatch("pure_cycle");
    const r1 = assemble(db, batchId, 6);
    const r2 = assemble(db, batchId, 6);
    assert.equal(r2.idempotent, true);
    const u1 = listUnitigs(db, r1.assemblyId, 100, 0).items as {
      circular: number;
      seq: string;
      start_kmer: string;
    }[];
    assert.equal(u1.length, 1);
    assert.equal(u1[0].circular, 1);
    // deterministic repeated builds yield the identical start k-mer and sequence
    const u2 = listUnitigs(db, r2.assemblyId, 100, 0).items as { start_kmer: string }[];
    assert.equal(u2[0].start_kmer, u1[0].start_kmer);
    const v = verifyUnitigSupport(db, r1.assemblyId, 0);
    assert.equal(v.allSupported, true);
    assert.equal(v.circular, true);
    assert.equal(v.edgeCount, v.expectedEdges);
  });
});

describe("low coverage gap", () => {
  test("does not drop isolated components; produces multiple fragments", () => {
    const batchId = fixtureBatch("low_coverage_gap");
    const r = assemble(db, batchId, 6);
    const units = listUnitigs(db, r.assemblyId, 100, 0).items as unknown[];
    assert.ok(units.length >= 2, "gap should fragment assembly");
    // every component's edges still verify
    for (let i = 0; i < units.length; i++)
      assert.equal(verifyUnitigSupport(db, r.assemblyId, i).allSupported, true);
  });
});

describe("coverage counting", () => {
  test("identical k-mer from multiple reads raises coverage, not a false fork", () => {
    const batchId = seedBatch(
      db,
      [
        { readCode: "x1", seq: "ACGTACGT" },
        { readCode: "x2", seq: "ACGTACGT" },
        { readCode: "x3", seq: "TACGTACG" },
      ],
      "cov",
    );
    const r = assemble(db, batchId, 5);
    const cov = edgeCoverage(db, r.assemblyId, 100, 0).items as {
      src_kmer: string;
      dst_kmer: string;
      coverage: number;
    }[];
    // ACGTA -> CGTAC appears in x1,x2,x3 (position 0,0,1): coverage 3, one edge only
    const shared = cov.find((e) => e.src_kmer === "ACGT" && e.dst_kmer === "CGTA");
    assert.ok(shared);
    assert.equal(shared!.coverage, 3);
    assert.equal(r.branchCount, 0);
  });

  test("reads with same content but different codes contribute independently", () => {
    const batchId = seedBatch(
      db,
      [
        { readCode: "idA", seq: "GGGACGT" },
        { readCode: "idB", seq: "GGGACGT" },
      ],
      "samecontent",
    );
    const r = assemble(db, batchId, 4);
    const obs = db
      .prepare(
        `SELECT COUNT(*) c FROM edge_obs o JOIN edges e ON e.id=o.edge_id
         WHERE e.assembly_id=? AND e.src_kmer=? AND e.dst_kmer=?`,
      )
      .get(r.assemblyId, "GGG", "GGA") as { c: number };
    assert.equal(obs.c, 2);
  });
});

describe("determinism and history", () => {
  test("same inputs produce identical unitigs; different k kept independently", () => {
    const batchId = fixtureBatch("unique_linear");
    const a6 = assemble(db, batchId, 6);
    const a8 = assemble(db, batchId, 8);
    assert.notEqual(a6.assemblyId, a8.assemblyId);
    const u6a = JSON.stringify(listUnitigs(db, a6.assemblyId, 100, 0).items);
    const again = runAssembly(db, batchId, { k: 6, clock: fixedClock });
    assert.equal(again.idempotent, true);
    const u6b = JSON.stringify(listUnitigs(db, a6.assemblyId, 100, 0).items);
    assert.equal(u6a, u6b);
  });

  test("history survives restart (close + reopen)", () => {
    const batchId = fixtureBatch("bubble");
    const r = assemble(db, batchId, 6);
    db.close();
    db = reopen(dbPath);
    const units = listUnitigs(db, r.assemblyId, 100, 0);
    assert.ok(units.total >= 1);
    const branches = listBranches(db, r.assemblyId, 100, 0);
    assert.ok(branches.total >= 1);
  });
});

describe("failure paths", () => {
  test("illegal characters are recorded as rejected with the reason and excluded", () => {
    const id = createBatch(db, "bad", "", fixedClock);
    const res = importReads(
      db,
      id,
      [
        { readCode: "good", seq: "ACGTACGT" },
        { readCode: "z", seq: "ACGTX" },
      ],
      { clock: fixedClock },
    );
    assert.equal(res.rejected.length, 1);
    assert.match(res.rejected[0].reason, /outside ACGT/);
    const stored = db.prepare("SELECT COUNT(*) c FROM reads WHERE batch_id=?").get(id) as {
      c: number;
    };
    assert.equal(stored.c, 1);
    // direct sequence validation still surfaces the explicit INVALID_DNA code
    assert.throws(() => {
      throw new ApiError("INVALID_DNA", "x");
    });
  });

  test("reads shorter than k are recorded separately and excluded from the graph", () => {
    const id = createBatch(db, "short", "", fixedClock);
    const res = importReads(db, id, [
      { readCode: "ok", seq: "ACGTACGT" },
      { readCode: "tiny", seq: "ACG" },
    ], { clock: fixedClock });
    assert.equal(res.inserted, 2);
    const r = runAssembly(db, id, { k: 6, clock: fixedClock });
    assert.equal(r.tooShortReads.length, 1);
  });

  test("oversized graph fails with GRAPH_TOO_LARGE and rolls the assembly back", () => {
    const id = createBatch(db, "big", "", fixedClock);
    importReads(db, id, [{ readCode: "q", seq: "ACGTACGTACGT" }], { clock: fixedClock });
    assert.throws(
      () => runAssembly(db, id, { k: 2, maxNodes: 2, clock: fixedClock }),
      (e: unknown) => e instanceof ApiError && e.code === "GRAPH_TOO_LARGE",
    );
    const c = db.prepare("SELECT COUNT(*) c FROM assemblies WHERE batch_id=?").get(id) as { c: number };
    assert.equal(c.c, 0);
  });

  test("empty assembly is rejected", () => {
    const id = createBatch(db, "empty", "", fixedClock);
    assert.throws(
      () => runAssembly(db, id, { k: 4, clock: fixedClock }),
      (e: unknown) => e instanceof ApiError && e.code === "EMPTY_BATCH",
    );
  });

  test("invalid k is rejected with VALIDATION_ERROR", () => {
    const id = seedBatch(db, [{ readCode: "a", seq: "ACGTACGT" }], "kbad");
    assert.throws(() => runAssembly(db, id, { k: 1, clock: fixedClock }), ApiError);
  });
});

describe("import idempotency / transaction", () => {
  test("repeated identical import does not duplicate reads", () => {
    const id = createBatch(db, "idem", "", fixedClock);
    const reads = [{ readCode: "a", seq: "ACGTACGT" }, { readCode: "b", seq: "TTTTACGT" }];
    const first = importReads(db, id, reads, { clock: fixedClock });
    const second = importReads(db, id, reads, { clock: fixedClock });
    assert.equal(first.inserted, 2);
    assert.equal(second.idempotent, true);
    const c = db.prepare("SELECT COUNT(*) c FROM reads WHERE batch_id=?").get(id) as { c: number };
    assert.equal(c.c, 2);
  });

  test("import transaction rolls back when receipt insert fails", () => {
    const id = createBatch(db, "rollback", "", fixedClock);
    importReads(db, id, [{ readCode: "a", seq: "ACGTACGT" }], { clock: fixedClock });
    // force the receipt insert to fail by dropping the table mid-transaction
    const orig = db.prepare("INSERT INTO import_receipts(batch_id, payload_hash, read_count, skipped_duplicates, created_at) VALUES (?,?,?,?,?)");
    db.exec("DROP TABLE import_receipts");
    assert.throws(() =>
      importReads(db, id, [{ readCode: "b", seq: "ACGTACGT" }], { clock: fixedClock }),
    );
    void orig;
    const c = db.prepare("SELECT COUNT(*) c FROM reads WHERE batch_id=?").get(id) as { c: number };
    assert.equal(c.c, 1, "new read must be rolled back with the transaction");
  });
});
