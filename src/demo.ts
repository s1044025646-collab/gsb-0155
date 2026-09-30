/**
 * Reproducible end-to-end demo using a throwaway database inside ./data.
 * Runs the full pipeline over every fixture and prints key before/after state.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { systemClock } from "./util.ts";
import { FIXTURE_KINDS, createFixtureBatch } from "./services/generator.ts";
import { runAssembly } from "./services/assembler.ts";
import {
  compareK,
  edgeCoverage,
  getOrCreateReport,
  listBranches,
  listUnitigs,
  traceBranch,
  verifyUnitigSupport,
} from "./services/queries.ts";

const dir = join(process.cwd(), "data", "demo");
rmSync(dir, { recursive: true, force: true });
const db = openDb(join(dir, "demo.db"));
const clock = systemClock;
const K = 6;

function say(s: string): void {
  process.stdout.write(`\n### ${s}\n`);
}

for (const kind of FIXTURE_KINDS) {
  say(`fixture: ${kind}`);
  const { batchId, genome, notes, importResult } = createFixtureBatch(db, {
    kind,
    batchName: `demo_${kind}`,
    seed: 42,
    clock,
  });
  console.log("genome:", genome);
  console.log("notes :", notes.join("; "));
  console.log("import:", { inserted: importResult.inserted, total: importResult.readCount });

  const before = (
    db.prepare("SELECT COUNT(*) c FROM assemblies WHERE batch_id=?").get(batchId) as { c: number }
  ).c;
  const a = runAssembly(db, batchId, { k: K, clock });
  const after = (
    db.prepare("SELECT COUNT(*) c FROM assemblies WHERE batch_id=?").get(batchId) as { c: number }
  ).c;
  console.log("assemblies before/after:", before, after);
  if (a.idempotent) {
    console.log("(repeated assembly returned existing result idempotently)");
  } else {
    console.log("assembly:", {
      id: a.assemblyId,
      nodes: a.nodeCount,
      edges: a.edgeCount,
      unitigs: a.unitigCount,
      branches: a.branchCount,
      n50: a.n50,
      totalUnitigLength: a.totalLength,
      tooShort: a.tooShortReads.length,
    });
  }
  const id = a.assemblyId;
  const units = listUnitigs(db, id, 100, 0).items as {
    ord: number;
    length: number;
    circular: number;
    isolated: number;
  }[];
  console.log(
    "unitigs:",
    units.map((u) => `#${u.ord}(len=${u.length}${u.circular ? ",circ" : ""}${u.isolated ? ",isolated" : ""})`).join(" "),
  );
  const cov = edgeCoverage(db, id, 3, 0);
  console.log("top coverage edges:", cov.items.slice(0, 3));
  const branches = listBranches(db, id, 100, 0).items as { kmer: string; kind: string }[];
  if (branches.length) {
    const first = branches[0];
    console.log(`branch evidence at ${first.kind} ${first.kmer}:`, JSON.stringify(traceBranch(db, id, first.kmer, first.kind)).slice(0, 300));
  }
  if (units.length) {
    const v = verifyUnitigSupport(db, id, units[0].ord);
    console.log(`verify unitig #${units[0].ord}: supported=${v.allSupported} edges=${v.edgeCount} covCheck=${v.coverageSumCheck}`);
  }
  console.log(getOrCreateReport(db, id, clock).content.split("\n").slice(8).join("\n"));
}

say("compare across k values (repeat_region batch)");
const repeatBatch = (
  db.prepare("SELECT id FROM batches WHERE name=?").get("demo_repeat_region") as { id: number }
).id;
runAssembly(db, repeatBatch, { k: 5, clock });
runAssembly(db, repeatBatch, { k: 7, clock });
console.log(JSON.stringify(compareK(db, repeatBatch), null, 2));

say("idempotency: re-running identical assembly and report");
const a1 = runAssembly(db, repeatBatch, { k: K, clock });
const r1 = getOrCreateReport(db, a1.assemblyId, clock);
const r2 = getOrCreateReport(db, a1.assemblyId, clock);
console.log("same assembly id:", a1.assemblyId, "| report versions equal:", r1.version === r2.version);

db.close();
say(`demo complete; all files kept under ${dir}`);
