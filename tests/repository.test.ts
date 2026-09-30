import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { AppError, Clock } from '../src/types.js';
import { generateReads } from '../src/generator.js';

const dir = mkdtempSync(join(tmpdir(), 'dna-assembly-'));
const dbPath = join(dir, 'test.db');

const clock: Clock = (() => {
  let tick = 0;
  return { now: () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z` };
})();

before(() => {
  rmSync(dbPath, { force: true });
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may briefly retain WAL handles; temp cleanup is best effort.
  }
});

test('imports reads, rejects illegal characters, and rolls back on failure', () => {
  const db = openDb(dbPath);
  const repo = new Repository(db, clock);
  repo.createBatch('imp');
  const result = repo.importReads('imp', [
    { readId: 'r1', seq: 'ACGTACGT' },
    { readId: 'r2', seq: 'ACGTACGT' },
  ]);
  assert.equal(result.imported, 2);
  assert.throws(
    () =>
      repo.importReads('imp', [
        { readId: 'r3', seq: 'ACGT' },
        { readId: 'r4', seq: 'ZZZZ' },
      ]),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_SEQUENCE',
  );
  const page = repo.listReads('imp', 100, 0);
  assert.equal(page.total, 2, 'rolled-back transaction must leave no partial reads');
  db.close();
});

test('repeated imports and repeated assemblies are idempotent', () => {
  const db = openDb(dbPath);
  const repo = new Repository(db, clock);
  const again = repo.importReads('imp', [
    { readId: 'r1', seq: 'ACGTACGT' },
    { readId: 'r2', seq: 'ACGTACGT' },
  ]);
  assert.equal(again.imported, 0);
  assert.equal(again.duplicated, 2);
  const first = repo.runAssembly(5, ['imp'], 'same');
  const second = repo.runAssembly(5, ['imp'], 'same');
  const third = repo.runAssembly(5, ['imp'], 'different-label-same-input');
  assert.equal(first.assemblyId, second.assemblyId);
  assert.equal(first.assemblyId, third.assemblyId, 'identity is based on input hash, not label');
  db.close();
});

test('different k values produce independent stored assemblies', () => {
  const db = openDb(dbPath);
  const repo = new Repository(db, clock);
  const a = repo.runAssembly(4, ['imp']);
  const b = repo.runAssembly(6, ['imp']);
  assert.notEqual(a.assemblyId, b.assemblyId);
  assert.notEqual(a.k, b.k);
  db.close();
});

test('pagination is bounded and total counts are accurate', () => {
  const db = openDb(dbPath);
  const repo = new Repository(db, clock);
  repo.createBatch('page');
  const entries = Array.from({ length: 5 }, (_, i) => ({
    readId: `p${i}`,
    seq: 'ACGTACGT',
  }));
  repo.importReads('page', entries);
  const page1 = repo.listReads('page', 2, 0);
  const page2 = repo.listReads('page', 2, 2);
  assert.equal(page1.total, 5);
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items[0].readId, 'p2');
  db.close();
});

test('reports are versioned and historical payloads remain reproducible', () => {
  const db = openDb(dbPath);
  const repo = new Repository(db, clock);
  const assembly = repo.runAssembly(4, ['imp'], 'report-me');
  repo.createReport(assembly.assemblyId);
  const second = repo.createReport(assembly.assemblyId);
  assert.equal(second.version, 2);
  const stored = repo.getReport(second.reportId)!;
  assert.equal(stored.assemblyId, assembly.assemblyId);
  assert.deepEqual(stored.contigs.map((c) => c.sequence), assembly.contigs.map((c) => c.sequence));
  db.close();
});

test('state survives closing and reopening the database (restart persistence)', () => {
  {
    const db = openDb(dbPath);
    const repo = new Repository(db, clock);
    const generated = generateReads({ seed: 7, pattern: 'repeat' });
    repo.importReads(generated.batchId, generated.reads);
    const assembly = repo.runAssembly(7, [generated.batchId], 'persist');
    assert.ok(assembly.assemblyId);
    db.close();
  }
  {
    const db = openDb(dbPath);
    const repo = new Repository(db, clock);
    const page = repo.listAssemblies(100, 0);
    const found = page.items.find((a) => a.label === 'persist');
    assert.ok(found);
    assert.ok(found!.contigs.length > 0);
    assert.ok(found!.branches.length > 0, 'repeat ambiguity evidence persists across restart');
    db.close();
  }
});

test('migrations are repeatable', () => {
  const db = openDb(dbPath);
  assert.doesNotThrow(() => {
    openDb(dbPath).close();
  });
  db.close();
});

test('validation error codes are explicit for k, batches and missing input', () => {
  const db = openDb(dbPath);
  const repo = new Repository(db, clock);
  assert.throws(() => repo.runAssembly(1, ['imp']), (e: unknown) => (e as AppError).code === 'INVALID_K');
  assert.throws(
    () => repo.runAssembly(5, ['missing-batch']),
    (e: unknown) => (e as AppError).code === 'BATCH_NOT_FOUND',
  );
  repo.createBatch('empty');
  assert.throws(
    () => repo.runAssembly(5, ['empty']),
    (e: unknown) => (e as AppError).code === 'NO_READS',
  );
  db.close();
});

