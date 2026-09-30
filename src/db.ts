import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS batches (
      batch_id TEXT PRIMARY KEY,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reads (
      read_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(batch_id),
      seq TEXT NOT NULL,
      length INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reads_batch ON reads(batch_id);
    CREATE TABLE IF NOT EXISTS assemblies (
      assembly_id TEXT PRIMARY KEY,
      k INTEGER NOT NULL,
      label TEXT NOT NULL,
      input_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      rejection_reason TEXT,
      batch_ids TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      edge_count INTEGER NOT NULL,
      skipped_reads TEXT NOT NULL,
      branches TEXT NOT NULL,
      stats TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contigs (
      contig_id TEXT NOT NULL,
      assembly_id TEXT NOT NULL REFERENCES assemblies(assembly_id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      sequence TEXT NOT NULL,
      length INTEGER NOT NULL,
      circular INTEGER NOT NULL,
      isolated INTEGER NOT NULL,
      coverage REAL NOT NULL,
      edges TEXT NOT NULL,
      supporting_read_ids TEXT NOT NULL,
      PRIMARY KEY (assembly_id, contig_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
      report_id TEXT PRIMARY KEY,
      assembly_id TEXT NOT NULL REFERENCES assemblies(assembly_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (assembly_id, version)
    );
    CREATE TABLE IF NOT EXISTS assembly_inputs (
      assembly_id TEXT NOT NULL REFERENCES assemblies(assembly_id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL,
      PRIMARY KEY (assembly_id, batch_id)
    );
  `);
  const row = db.prepare('SELECT COUNT(*) AS c FROM schema_meta').get() as { c: number };
  if (row.c === 0) {
    db.prepare('INSERT INTO schema_meta(version) VALUES (?)').run(1);
  }
}
