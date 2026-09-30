import type { DB } from "../db.ts";
import { ApiError } from "../errors.ts";
import { requireString, sha256, validateDna, type Clock } from "../util.ts";

export interface ReadInput {
  readCode?: string;
  code?: string;
  id?: string;
  seq?: string;
  sequence?: string;
}

export interface ImportResult {
  batchId: number;
  readCount: number;
  inserted: number;
  skippedDuplicates: number;
  rejected: { readCode: string; reason: string }[];
  tooShort: { readCode: string; length: number }[];
  idempotent: boolean;
}

export function createBatch(
  db: DB,
  name: string,
  description: string,
  clock: Clock,
): number {
  requireString(name, "name");
  const info = db
    .prepare("INSERT INTO batches(name, description, created_at) VALUES (?,?,?)")
    .run(name, description ?? "", clock.now());
  return Number(info.lastInsertRowid);
}

export function getBatch(db: DB, batchId: number) {
  const row = db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as
    | { id: number; name: string; description: string; created_at: number }
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `batch ${batchId} not found`);
  return row;
}

/**
 * Import reads into a batch with full transactional guarantees.
 * - Sequences are validated (ACGT only, oriented input assumed).
 * - Reads shorter than k are a graph-time concern; here only length < 1 fails,
 *   but callers pass minLength (typically k) so too-short reads are recorded
 *   separately instead of aborting the whole batch.
 * - (batch_id, read_code) uniqueness + a payload receipt make re-imports idempotent.
 */
export function importReads(
  db: DB,
  batchId: number,
  reads: ReadInput[],
  opts: { minLength?: number; clock: Clock },
): ImportResult {
  getBatch(db, batchId);
  if (!Array.isArray(reads) || reads.length === 0)
    throw new ApiError("EMPTY_BATCH", "reads must be a non-empty array");

  const normalized = reads.map((r, i) => {
    const readCode = String(r.readCode ?? r.code ?? r.id ?? `r${i + 1}`);
    const seqRaw = r.seq ?? r.sequence;
    return { readCode, seqRaw };
  });

  const rejected: ImportResult["rejected"] = [];
  const tooShort: ImportResult["tooShort"] = [];
  const valid: { code: string; seq: string }[] = [];
  for (const { readCode, seqRaw } of normalized) {
    let seq: string;
    try {
      seq = validateDna(seqRaw as string);
    } catch (err) {
      rejected.push({ readCode, reason: (err as Error).message });
      continue;
    }
    if (opts.minLength !== undefined && seq.length < opts.minLength) {
      tooShort.push({ readCode, length: seq.length });
      continue;
    }
    valid.push({ code: readCode, seq });
  }

  const payloadHash = sha256(
    normalized
      .map((r) => `${r.readCode}=${String(r.seqRaw ?? "").toUpperCase()}`)
      .sort()
      .join("\n"),
  );

  const receipt = db
    .prepare("SELECT * FROM import_receipts WHERE batch_id = ? AND payload_hash = ?")
    .get(batchId, payloadHash) as { read_count: number; skipped_duplicates: number } | undefined;
  if (receipt) {
    return {
      batchId,
      readCount: receipt.read_count,
      inserted: 0,
      skippedDuplicates: receipt.skipped_duplicates,
      rejected,
      tooShort,
      idempotent: true,
    };
  }

  let inserted = 0;
  let skippedDuplicates = 0;
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO reads(batch_id, read_code, seq, length, imported_at) VALUES (?,?,?,?,?)",
    );
    const seen = new Set<string>();
    for (const { code, seq } of valid) {
      if (seen.has(code)) {
        skippedDuplicates++;
        continue;
      }
      seen.add(code);
      const info = stmt.run(batchId, code, seq, seq.length, opts.clock.now());
      if (info.changes > 0) inserted++;
      else skippedDuplicates++;
    }
    const totalRow = db
      .prepare("SELECT COUNT(*) AS c FROM reads WHERE batch_id = ?")
      .get(batchId) as { c: number };
    db.prepare(
      "INSERT INTO import_receipts(batch_id, payload_hash, read_count, skipped_duplicates, created_at) VALUES (?,?,?,?,?)",
    ).run(batchId, payloadHash, totalRow.c, skippedDuplicates, opts.clock.now());
    db.exec("COMMIT");
    return {
      batchId,
      readCount: totalRow.c,
      inserted,
      skippedDuplicates,
      rejected,
      tooShort,
      idempotent: false,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function listBatches(db: DB) {
  return db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM reads r WHERE r.batch_id = b.id) AS read_count
       FROM batches b ORDER BY b.id`,
    )
    .all();
}

export function listReads(
  db: DB,
  batchId: number,
  limit: number,
  offset: number,
) {
  getBatch(db, batchId);
  const items = db
    .prepare("SELECT id, read_code, seq, length, imported_at FROM reads WHERE batch_id = ? ORDER BY id LIMIT ? OFFSET ?")
    .all(batchId, limit, offset);
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM reads WHERE batch_id = ?").get(batchId) as { c: number }
  ).c;
  return { items, total };
}
