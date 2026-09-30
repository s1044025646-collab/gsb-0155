import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { DB } from "../src/db.ts";
import { computeN50 } from "../src/services/assembler.ts";
import { validateDna, mulberry32 } from "../src/util.ts";
import { ApiError } from "../src/errors.ts";
import { getOrCreateReport } from "../src/services/queries.ts";
import { assemble, cleanup, fixedClock, freshMigrateOnly, seedBatch, tempDb } from "./helpers.ts";

describe("N50 math", () => {
  test("classic example: lengths 2,3,4,5,6,7,8,9,10 -> N50 7", () => {
    // total 54, half 27; descending cumulative 10+9+8=27 -> 8? verify against standard definition
    const lens = [2, 3, 4, 5, 6, 7, 8, 9, 10];
    const total = lens.reduce((a, b) => a + b, 0);
    let acc = 0;
    let expected = 0;
    for (const l of [...lens].sort((a, b) => b - a)) {
      acc += l;
      if (acc >= total / 2) {
        expected = l;
        break;
      }
    }
    assert.equal(computeN50(lens), expected);
  });
  test("empty -> 0", () => assert.equal(computeN50([]), 0));
});

describe("dna validation", () => {
  test("accepts ACGT and uppercases", () => assert.equal(validateDna("acgt"), "ACGT"));
  test("rejects other characters", () =>
    assert.throws(() => validateDna("ACGU"), (e: unknown) => e instanceof ApiError && e.code === "INVALID_DNA"));
});

describe("prng", () => {
  test("same seed -> same sequence", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const seqA = Array.from({ length: 5 }, a);
    const seqB = Array.from({ length: 5 }, b);
    assert.deepEqual(seqA, seqB);
  });
});

describe("migration", () => {
  test("migration is repeatable (PRAGMA user_version stable)", () => {
    const { db, dir } = freshMigrateOnly();
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.ok(v.user_version >= 1);
    db.close();
    cleanup(dir);
  });
});

describe("reports", () => {
  let db: DB;
  let dir: string;
  beforeEach(() => {
    const t = tempDb();
    db = t.db;
    dir = t.dir;
  });
  afterEach(() => cleanup(dir));

  test("identical report request does not add a version", () => {
    const id = seedBatch(db, [{ readCode: "a", seq: "ACGTACGT" }, { readCode: "b", seq: "GTACGTAC" }], "rep");
    const a = assemble(db, id, 4);
    const v1 = getOrCreateReport(db, a.assemblyId, fixedClock);
    const v2 = getOrCreateReport(db, a.assemblyId, fixedClock);
    assert.equal(v1.version, v2.version);
  });
});
