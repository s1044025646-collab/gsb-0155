#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { openDb } from "./db.ts";
import { systemClock } from "./util.ts";
import { createBatch, getBatch, importReads, listBatches } from "./services/batches.ts";
import { runAssembly } from "./services/assembler.ts";
import {
  compareK,
  edgeCoverage,
  exportFasta,
  getOrCreateReport,
  listBranches,
  listUnitigs,
  traceBranch,
  verifyUnitigSupport,
} from "./services/queries.ts";
import { createFixtureBatch, FIXTURE_KINDS } from "./services/generator.ts";
import { startServer } from "./server.ts";

const DATA_DIR = resolve(process.env.DNA_DATA_DIR ?? join(process.cwd(), "data"));
const DB_PATH = process.env.DNA_DB_PATH ?? join(DATA_DIR, "assembler.db");

function line(s = ""): void {
  process.stdout.write(s + "\n");
}
function header(title: string): void {
  line(`\n=== ${title} ===`);
}
function open() {
  return openDb(DB_PATH);
}
function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required argument --${name}`);
}
function optInt(name: string): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
}
function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const clock = systemClock;
  try {
    switch (cmd) {
      case "init": {
        const d = open();
        header("init");
        line(`database ready (migrations idempotent): ${DB_PATH}`);
        line(`batches: ${(listBatches(d) as unknown[]).length}`);
        d.close();
        break;
      }
      case "batch": {
        const d = open();
        const name = arg("name");
        const id = createBatch(d, name, arg("description", ""), clock);
        line(`created batch id=${id} name=${name}`);
        d.close();
        break;
      }
      case "batches": {
        const d = open();
        header("batches");
        console.table(listBatches(d));
        d.close();
        break;
      }
      case "import": {
        const batchId = Number(arg("batch"));
        const file = arg("file");
        const d = open();
        header(`import -> batch ${batchId}`);
        line(`BEFORE: ${JSON.stringify(getBatch(d, batchId))}`);
        const payload = readJsonFile(file) as { reads?: unknown } | unknown[];
        const reads = Array.isArray(payload) ? payload : (payload as { reads: unknown[] }).reads;
        const before = (
          d.prepare("SELECT COUNT(*) c FROM reads WHERE batch_id=?").get(batchId) as { c: number }
        ).c;
        const res = importReads(d, batchId, reads as never, {
          minLength: optInt("min-length"),
          clock,
        });
        const after = (
          d.prepare("SELECT COUNT(*) c FROM reads WHERE batch_id=?").get(batchId) as { c: number }
        ).c;
        line(`reads in batch: ${before} -> ${after}`);
        console.log(res);
        if (res.rejected.length || res.tooShort.length)
          line(`NOTE: ${res.rejected.length} invalid, ${res.tooShort.length} too short (recorded, not aborted)`);
        d.close();
        break;
      }
      case "fixture": {
        const kind = arg("kind") as (typeof FIXTURE_KINDS)[number];
        if (!FIXTURE_KINDS.includes(kind)) throw new Error(`kind must be one of ${FIXTURE_KINDS.join(",")}`);
        const d = open();
        const r = createFixtureBatch(d, {
          kind,
          batchName: arg("name", `fixture_${kind}`),
          seed: optInt("seed") ?? 42,
          clock,
        });
        header(`fixture ${kind}`);
        console.log({ batchId: r.batchId, genome: r.genome, notes: r.notes, import: r.importResult });
        d.close();
        break;
      }
      case "assemble": {
        const batchId = Number(arg("batch"));
        const k = Number(arg("k"));
        const d = open();
        header(`assemble batch=${batchId} k=${k}`);
        line("BEFORE assemblies:");
        console.table(
          d.prepare("SELECT id,k,status,unitig_count,n50 FROM assemblies WHERE batch_id=?").all(batchId),
        );
        const r = runAssembly(d, batchId, { k, maxNodes: optInt("max-nodes"), clock });
        line("AFTER:");
        console.log(r);
        if (!r.idempotent && r.tooShortReads.length)
          line(`NOTE: ${r.tooShortReads.length} reads shorter than k were excluded`);
        d.close();
        break;
      }
      case "coverage": {
        const id = Number(arg("assembly"));
        const limit = optInt("limit") ?? 50;
        const offset = optInt("offset") ?? 0;
        const d = open();
        const r = edgeCoverage(d, id, limit, offset);
        header(`coverage assembly=${id} (${r.total} edges total)`);
        console.table(r.items);
        d.close();
        break;
      }
      case "branches": {
        const id = Number(arg("assembly"));
        const d = open();
        if (process.argv.includes("--kmer")) {
          const kmer = arg("kmer");
          const kindArg = arg("kind", "");
          header(`trace branch assembly=${id} kmer=${kmer}`);
          console.log(JSON.stringify(traceBranch(d, id, kmer, kindArg || undefined), null, 2));
        } else {
          const r = listBranches(d, id, 500, 0);
          header(`branches assembly=${id} (${r.total})`);
          console.log(JSON.stringify(r.items, null, 2));
        }
        d.close();
        break;
      }
      case "unitigs": {
        const id = Number(arg("assembly"));
        const d = open();
        const r = listUnitigs(d, id, 500, 0);
        header(`unitigs assembly=${id} (${r.total})`);
        console.table(
          (r.items as Array<Record<string, unknown>>).map((u) => ({
            ord: u.ord,
            length: u.length,
            cov: u.coverage_sum,
            circular: u.circular,
            isolated: u.isolated,
            seq: String(u.seq).slice(0, 40),
          })),
        );
        d.close();
        break;
      }
      case "verify": {
        const id = Number(arg("assembly"));
        const ord = Number(arg("ord"));
        const d = open();
        header(`verify support assembly=${id} unitig=${ord}`);
        console.log(JSON.stringify(verifyUnitigSupport(d, id, ord), null, 2));
        d.close();
        break;
      }
      case "export": {
        const id = Number(arg("assembly"));
        const d = open();
        const fasta = exportFasta(d, id);
        const out = arg("out", "");
        if (out) {
          writeFileSync(resolve(out), fasta);
          line(`wrote FASTA -> ${resolve(out)}`);
        } else line(fasta);
        d.close();
        break;
      }
      case "compare": {
        const batchId = Number(arg("batch"));
        const d = open();
        header(`compare k values batch=${batchId}`);
        console.log(JSON.stringify(compareK(d, batchId), null, 2));
        d.close();
        break;
      }
      case "report": {
        const id = Number(arg("assembly"));
        const d = open();
        const r = getOrCreateReport(d, id, clock);
        line(`--- report v${r.version} ---`);
        line(r.content);
        d.close();
        break;
      }
      case "serve": {
        const d = open();
        const { port } = await startServer({ db: d, dataDir: DATA_DIR, port: optInt("port") });
        header("serve");
        line(`listening on http://127.0.0.1:${port} (loopback only)`);
        line(`pid file: ${join(DATA_DIR, "server.pid")}`);
        break;
      }
      case "stop": {
        const pidFile = join(DATA_DIR, "server.pid");
        if (!existsSync(pidFile)) {
          line("no server.pid found; nothing to stop");
          break;
        }
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        try {
          process.kill(pid);
          line(`stopped project server pid=${pid}`);
        } catch {
          line(`pid ${pid} not running`);
        }
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

function usage(): void {
  line(
    [
      "dna assembler CLI",
      "Commands:",
      "  init                                      create/migrate SQLite database",
      "  batch --name N [--description D]          create a batch",
      "  batches                                   list batches",
      "  import --batch ID --file reads.json [--min-length K]",
      "  fixture --kind KIND [--seed S --name N]   KIND = " + FIXTURE_KINDS.join("|"),
      "  assemble --batch ID --k K [--max-nodes N] build graph + unitigs",
      "  coverage --assembly ID [--limit --offset] edge coverage table",
      "  branches --assembly ID [--kmer X --kind fork|merge]",
      "  unitigs --assembly ID                     list unitigs",
      "  verify --assembly ID --ord N              check per-edge read support",
      "  export --assembly ID [--out f.fa]         FASTA export",
      "  compare --batch ID                        compare across k values",
      "  report --assembly ID                      versioned summary report",
      "  serve [--port P]                          HTTP API on 127.0.0.1 (auto port)",
      "  stop                                      stop this project's server",
    ].join("\n"),
  );
}

main();
