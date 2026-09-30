import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, AssemblyResult, Clock, Contig, Page, ReadRecord } from './types.js';
import { buildGraph, collectBranchEvidence, computeStats, extractUnitigs } from './assembly.js';

export class Repository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  createBatch(batchId: string, note?: string): { created: boolean } {
    const existing = this.db.prepare('SELECT batch_id FROM batches WHERE batch_id = ?').get(batchId);
    if (existing) return { created: false };
    this.db
      .prepare('INSERT INTO batches(batch_id, note, created_at) VALUES (?, ?, ?)')
      .run(batchId, note ?? null, this.clock.now());
    return { created: true };
  }

  importRead(batchId: string, readId: string, seq: string): { created: boolean } {
    const batch = this.db.prepare('SELECT batch_id FROM batches WHERE batch_id = ?').get(batchId);
    if (!batch) throw new AppError('BATCH_NOT_FOUND', `Batch '${batchId}' does not exist`, 404);
    if (!/^[ACGT]+$/.test(seq)) {
      throw new AppError('INVALID_SEQUENCE', 'Sequence must contain only ACGT characters', 422, {
        readId,
      });
    }
    const existing = this.db.prepare('SELECT read_id FROM reads WHERE read_id = ?').get(readId);
    if (existing) return { created: false };
    this.db
      .prepare(
        'INSERT INTO reads(read_id, batch_id, seq, length, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(readId, batchId, seq, seq.length, this.clock.now());
    return { created: true };
  }

  importReads(
    batchId: string,
    reads: { readId: string; seq: string }[],
  ): { imported: number; duplicated: number } {
    this.createBatch(batchId);
    let imported = 0;
    let duplicated = 0;
    const tx = this.db.prepare('BEGIN');
    tx.run();
    try {
      for (const read of reads) {
        const result = this.importRead(batchId, read.readId, read.seq);
        if (result.created) imported += 1;
        else duplicated += 1;
      }
      this.db.prepare('COMMIT').run();
    } catch (error) {
      this.db.prepare('ROLLBACK').run();
      throw error;
    }
    return { imported, duplicated };
  }

  listBatches(): { batchId: string; note: string | null; readCount: number; createdAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT b.batch_id AS batchId, b.note, b.created_at AS createdAt,
                COUNT(r.read_id) AS readCount
         FROM batches b LEFT JOIN reads r ON r.batch_id = b.batch_id
         GROUP BY b.batch_id ORDER BY b.batch_id`,
      )
      .all() as { batchId: string; note: string | null; readCount: number; createdAt: string }[];
    return rows;
  }

  listReads(batchId: string | undefined, limit: number, offset: number): Page<ReadRecord> {
    const where = batchId ? 'WHERE batch_id = ?' : '';
    const params = batchId ? [batchId] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM reads ${where}`).get(...params) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT read_id AS readId, batch_id AS batchId, seq, length, created_at AS createdAt
         FROM reads ${where} ORDER BY batch_id, read_id LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as ReadRecord[];
    return { items: rows, total, limit, offset };
  }

  private loadReads(batchIds?: string[]): ReadRecord[] {
    if (batchIds && batchIds.length > 0) {
      const placeholders = batchIds.map(() => '?').join(',');
      return this.db
        .prepare(
          `SELECT read_id AS readId, batch_id AS batchId, seq, length, created_at AS createdAt
           FROM reads WHERE batch_id IN (${placeholders})`,
        )
        .all(...batchIds) as unknown as ReadRecord[];
    }
    return this.db
      .prepare(
        `SELECT read_id AS readId, batch_id AS batchId, seq, length, created_at AS createdAt
         FROM reads`,
      )
      .all() as unknown as ReadRecord[];
  }

  runAssembly(k: number, batchIds: string[] | undefined, label?: string): AssemblyResult {
    if (!Number.isInteger(k) || k < 2) {
      throw new AppError('INVALID_K', 'k must be an integer >= 2', 400);
    }
    if (batchIds) {
      for (const batchId of batchIds) {
        const found = this.db.prepare('SELECT 1 FROM batches WHERE batch_id = ?').get(batchId);
        if (!found) throw new AppError('BATCH_NOT_FOUND', `Batch '${batchId}' does not exist`, 404);
      }
    }
    const reads = this.loadReads(batchIds);
    if (reads.length === 0) {
      throw new AppError('NO_READS', 'No reads available for the selected batches', 422);
    }

    const graph = buildGraph(k, reads);
    const contigs = extractUnitigs(graph);
    const branches = collectBranchEvidence(graph);
    const stats = computeStats(contigs);
    const sortedBatchIds = [...new Set(reads.map((r) => r.batchId))].sort();
    const inputHash = createHash('sha1')
      .update(
        JSON.stringify({
          k,
          batches: sortedBatchIds,
          reads: reads.map((r) => `${r.readId}:${r.seq}`).sort(),
        }),
      )
      .digest('hex');

    const existing = this.db
      .prepare('SELECT assembly_id AS assemblyId FROM assemblies WHERE input_hash = ?')
      .get(inputHash) as { assemblyId: string } | undefined;
    if (existing) {
      return this.getAssembly(existing.assemblyId)!;
    }

    const assemblyId = 'asm_' + randomUUID().slice(0, 8);
    const displayLabel = label ?? `k${k}`;
    this.db.prepare('BEGIN').run();
    try {
      this.db
        .prepare(
          `INSERT INTO assemblies(assembly_id, k, label, input_hash, status, rejection_reason, batch_ids,
             node_count, edge_count, skipped_reads, branches, stats, created_at)
           VALUES (?, ?, ?, ?, 'ok', NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          assemblyId,
          k,
          displayLabel,
          inputHash,
          JSON.stringify(sortedBatchIds),
          graph.nodes.size,
          graph.edgeByKey.size,
          JSON.stringify(graph.skippedReads),
          JSON.stringify(branches),
          JSON.stringify(stats),
          this.clock.now(),
        );
      contigs.forEach((contig, ord) => this.insertContig(assemblyId, contig, ord));
      for (const batchId of sortedBatchIds) {
        this.db
          .prepare('INSERT INTO assembly_inputs(assembly_id, batch_id) VALUES (?, ?)')
          .run(assemblyId, batchId);
      }
      this.db.prepare('COMMIT').run();
    } catch (error) {
      this.db.prepare('ROLLBACK').run();
      throw error;
    }
    return this.getAssembly(assemblyId)!;
  }

  private insertContig(assemblyId: string, contig: Contig, ord: number): void {
    this.db
      .prepare(
        `INSERT INTO contigs(contig_id, assembly_id, ord, sequence, length, circular, isolated,
           coverage, edges, supporting_read_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        contig.contigId,
        assemblyId,
        ord,
        contig.sequence,
        contig.length,
        contig.circular ? 1 : 0,
        contig.isolated ? 1 : 0,
        contig.coverage,
        JSON.stringify(contig.edges),
        JSON.stringify(contig.supportingReadIds),
      );
  }

  listAssemblies(limit: number, offset: number): Page<AssemblyResult> {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS c FROM assemblies').get() as { c: number }
    ).c;
    const rows = this.db
      .prepare('SELECT assembly_id AS id FROM assemblies ORDER BY created_at, assembly_id LIMIT ? OFFSET ?')
      .all(limit, offset) as { id: string }[];
    return {
      items: rows.map((row) => this.getAssembly(row.id)!),
      total,
      limit,
      offset,
    };
  }

  getAssembly(assemblyId: string): AssemblyResult | null {
    const row = this.db
      .prepare('SELECT * FROM assemblies WHERE assembly_id = ?')
      .get(assemblyId) as
      | {
          assembly_id: string;
          k: number;
          label: string;
          status: 'ok' | 'rejected';
          rejection_reason: string | null;
          node_count: number;
          edge_count: number;
          skipped_reads: string;
          branches: string;
          stats: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    const contigRows = this.db
      .prepare('SELECT * FROM contigs WHERE assembly_id = ? ORDER BY ord')
      .all(assemblyId) as {
      contig_id: string;
      sequence: string;
      length: number;
      circular: number;
      isolated: number;
      coverage: number;
      edges: string;
      supporting_read_ids: string;
    }[];
    return {
      assemblyId: row.assembly_id,
      k: row.k,
      label: row.label,
      status: row.status,
      rejectionReason: row.rejection_reason ?? undefined,
      nodeCount: row.node_count,
      edgeCount: row.edge_count,
      skippedReads: JSON.parse(row.skipped_reads),
      branches: JSON.parse(row.branches),
      stats: JSON.parse(row.stats),
      createdAt: row.created_at,
      contigs: contigRows.map((c) => ({
        contigId: c.contig_id,
        sequence: c.sequence,
        length: c.length,
        circular: c.circular === 1,
        coverage: c.coverage,
        supportingReadIds: JSON.parse(c.supporting_read_ids),
        edges: JSON.parse(c.edges),
        isolated: c.isolated === 1,
      })),
    };
  }

  createReport(assemblyId: string): { reportId: string; version: number } {
    const assembly = this.getAssembly(assemblyId);
    if (!assembly) throw new AppError('ASSEMBLY_NOT_FOUND', `Assembly '${assemblyId}' does not exist`, 404);
    const last = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM reports WHERE assembly_id = ?')
      .get(assemblyId) as { v: number };
    const version = last.v + 1;
    const reportId = `rpt_${assemblyId}_v${version}`;
    this.db
      .prepare('INSERT INTO reports(report_id, assembly_id, version, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(reportId, assemblyId, version, JSON.stringify(assembly), this.clock.now());
    return { reportId, version };
  }

  listReports(assemblyId: string): { reportId: string; version: number; createdAt: string }[] {
    return this.db
      .prepare('SELECT report_id AS reportId, version, created_at AS createdAt FROM reports WHERE assembly_id = ? ORDER BY version')
      .all(assemblyId) as { reportId: string; version: number; createdAt: string }[];
  }

  getReport(reportId: string): AssemblyResult | null {
    const row = this.db.prepare('SELECT payload FROM reports WHERE report_id = ?').get(reportId) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as AssemblyResult) : null;
  }
}
