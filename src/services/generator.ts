import { mulberry32, type Clock } from "../util.ts";
import { createBatch, importReads } from "./batches.ts";
import type { DB } from "../db.ts";

export type FixtureKind =
  | "unique_linear"
  | "repeat_region"
  | "bubble"
  | "pure_cycle"
  | "low_coverage_gap";

export interface GenerateOptions {
  kind: FixtureKind;
  batchName?: string;
  k?: number;
  clock: Clock;
  seed?: number;
}

export interface GeneratedRead {
  readCode: string;
  seq: string;
}

const BASES = ["A", "C", "G", "T"] as const;

/** Generate deterministic synthetic genomes + reads for the six required fixtures. */
export function generateFixture(opts: GenerateOptions): { genome: string; reads: GeneratedRead[]; notes: string[] } {
  const rand = mulberry32(opts.seed ?? 42);
  const pick = () => BASES[Math.floor(rand() * 4)];
  const notes: string[] = [];
  let genome: string;
  let reads: GeneratedRead[] = [];

  switch (opts.kind) {
    case "unique_linear": {
      // unique 30bp genome, read length 12, tiling step 6 -> k=6 clean single unitig
      genome = randSeq(30, rand);
      reads = tile(genome, 12, 3);
      notes.push("single linear genome, unique k-mers, expect one non-circular unitig");
      break;
    }
    case "repeat_region": {
      // a repeat R appears twice with unique flanks -> ambiguous repeat placement
      const left = randSeq(8, rand);
      const repeat = "ATCGATCG";
      const middle = randSeq(8, rand);
      const right = randSeq(8, rand);
      genome = left + repeat + middle + repeat + right;
      reads = tile(genome, 14, 3);
      notes.push("repeat ATCGATCG occurs twice; expect fork/merge branch evidence");
      break;
    }
    case "bubble": {
      // two alleles between same anchors -> classic bubble
      const anchor = randSeq(10, rand);
      const alleleA = "AAAACCCC";
      const alleleB = "GGGGTTTT";
      const tail = randSeq(10, rand);
      const genomeA = anchor + alleleA + tail;
      const genomeB = anchor + alleleB + tail;
      reads = [...tile(genomeA, 14, 3, "a"), ...tile(genomeB, 14, 3, "b")];
      genome = `${genomeA}|${genomeB}`;
      notes.push("two paths between identical anchors; expect a bubble (fork then merge)");
      break;
    }
    case "pure_cycle": {
      // reads wrapping around a circular 16bp molecule
      const circ = randSeq(16, rand);
      genome = circ;
      const doubled = circ + circ;
      reads = [];
      for (let i = 0; i < circ.length; i += 2) {
        const start = i;
        const raw = (doubled + doubled.slice(0, 12)).slice(start, start + 12);
        reads.push({ readCode: `c${i}`, seq: raw });
      }
      notes.push("all reads wrap a circular molecule; expect one circular unitig");
      break;
    }
    case "low_coverage_gap": {
      // two well-covered blocks with no reads across the middle -> two unitigs
      genome = randSeq(40, rand);
      const leftReads = tile(genome.slice(0, 18), 12, 3, "L");
      const rightReads = tile(genome.slice(22), 12, 3, "R");
      reads = [...leftReads, ...rightReads];
      notes.push("positions 18-22 have no spanning reads; expect fragmented unitigs");
      break;
    }
    default:
      throw new Error(`unknown fixture kind: ${String(opts.kind)}`);
  }
  return { genome, reads, notes };
}

function randSeq(n: number, rand: () => number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += BASES[Math.floor(rand() * 4)];
  return s;
}

function tile(genome: string, readLen: number, step: number, prefix = "r"): GeneratedRead[] {
  const out: GeneratedRead[] = [];
  let n = 0;
  for (let i = 0; i + readLen <= genome.length; i += step) {
    out.push({ readCode: `${prefix}${n++}`, seq: genome.slice(i, i + readLen) });
  }
  return out;
}

/** Convenience: create batch + import fixture reads in one call. */
export function createFixtureBatch(
  db: DB,
  opts: GenerateOptions & { description?: string },
): { batchId: number; genome: string; notes: string[]; importResult: ReturnType<typeof importReads> } {
  const { genome, reads, notes } = generateFixture(opts);
  const name = opts.batchName ?? `fixture_${opts.kind}_${opts.seed ?? 42}`;
  const batchId = createBatch(db, name, opts.description ?? opts.kind, opts.clock);
  const importResult = importReads(db, batchId, reads, { minLength: 1, clock: opts.clock });
  return { batchId, genome, notes, importResult };
}

export const FIXTURE_KINDS: FixtureKind[] = [
  "unique_linear",
  "repeat_region",
  "bubble",
  "pure_cycle",
  "low_coverage_gap",
];

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
