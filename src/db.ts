import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  // v1: core schema
  `
  CREATE TABLE IF NOT EXISTS batches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    read_code     TEXT NOT NULL,
    seq           TEXT NOT NULL,
    length        INTEGER NOT NULL,
    imported_at   INTEGER NOT NULL,
    UNIQUE(batch_id, read_code)
  );
  CREATE INDEX IF NOT EXISTS idx_reads_batch ON reads(batch_id);

  -- one row per assembly attempt; deterministic fingerprint makes re-runs idempotent
  CREATE TABLE IF NOT EXISTS assemblies (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id       INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    k              INTEGER NOT NULL,
    max_nodes      INTEGER NOT NULL,
    fingerprint    TEXT NOT NULL,
    status         TEXT NOT NULL,           -- ok | graph_too_large | empty
    error_code     TEXT,
    error_message  TEXT,
    node_count     INTEGER NOT NULL DEFAULT 0,
    edge_count     INTEGER NOT NULL DEFAULT 0,
    unitig_count   INTEGER NOT NULL DEFAULT 0,
    total_length   INTEGER NOT NULL DEFAULT 0,
    n50            INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    UNIQUE(batch_id, k, fingerprint)
  );

  CREATE TABLE IF NOT EXISTS graph_nodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    assembly_id  INTEGER NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
    kmer         TEXT NOT NULL,
    UNIQUE(assembly_id, kmer)
  );

  CREATE TABLE IF NOT EXISTS edges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    assembly_id  INTEGER NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
    src_kmer     TEXT NOT NULL,
    dst_kmer     TEXT NOT NULL,
    label        TEXT NOT NULL,           -- overlapping edge label: last char of dst
    coverage     INTEGER NOT NULL,        -- number of read observations (NOT dedup)
    UNIQUE(assembly_id, src_kmer, dst_kmer)
  );
  CREATE INDEX IF NOT EXISTS idx_edges_asm ON edges(assembly_id);

  -- every individual (read, k-mer position) observation behind an edge
  CREATE TABLE IF NOT EXISTS edge_obs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    edge_id      INTEGER NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
    assembly_id  INTEGER NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
    read_id      INTEGER NOT NULL REFERENCES reads(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,         -- 0-based k-mer start within the read
    UNIQUE(edge_id, read_id, position)
  );
  CREATE INDEX IF NOT EXISTS idx_obs_read ON edge_obs(read_id);

  CREATE TABLE IF NOT EXISTS unitigs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    assembly_id  INTEGER NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
    ord          INTEGER NOT NULL,
    seq          TEXT NOT NULL,
    length       INTEGER NOT NULL,
    coverage_sum INTEGER NOT NULL,        -- summed edge coverage along path
    circular     INTEGER NOT NULL DEFAULT 0,
    isolated     INTEGER NOT NULL DEFAULT 0,
    start_kmer   TEXT NOT NULL,
    end_kmer     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_unitigs_asm ON unitigs(assembly_id);

  -- branch evidence: nodes where more than one non-branching continuation exists
  CREATE TABLE IF NOT EXISTS branches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    assembly_id  INTEGER NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
    kmer         TEXT NOT NULL,
    kind         TEXT NOT NULL,           -- fork | merge
    evidence_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_branches_asm ON branches(assembly_id);

  -- import receipts make repeated identical imports idempotent
  CREATE TABLE IF NOT EXISTS import_receipts (
    batch_id     INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
    payload_hash TEXT NOT NULL,
    read_count   INTEGER NOT NULL,
    skipped_duplicates INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );

  -- versioned text reports for an assembly
  CREATE TABLE IF NOT EXISTS reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    assembly_id  INTEGER NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'summary',
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    UNIQUE(assembly_id, kind, version)
  );
  `,
];

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

/** Idempotent migration driven by PRAGMA user_version; safe to run repeatedly. */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  for (; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
