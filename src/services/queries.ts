import type { DB } from "../db.ts";
import { ApiError } from "../errors.ts";
import type { Clock } from "../util.ts";

export function getAssembly(db: DB, assemblyId: number) {
  const row = db.prepare("SELECT * FROM assemblies WHERE id = ?").get(assemblyId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `assembly ${assemblyId} not found`);
  return row;
}

export function listAssemblies(db: DB, batchId: number, limit: number, offset: number) {
  const items = db
    .prepare(
      `SELECT id, batch_id, k, status, node_count, edge_count, unitig_count,
              total_length, n50, created_at, fingerprint
       FROM assemblies WHERE batch_id = ? ORDER BY k, id LIMIT ? OFFSET ?`,
    )
    .all(batchId, limit, offset);
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM assemblies WHERE batch_id = ?").get(batchId) as {
      c: number;
    }
  ).c;
  return { items, total };
}

export function edgeCoverage(db: DB, assemblyId: number, limit: number, offset: number) {
  getAssembly(db, assemblyId);
  const items = db
    .prepare(
      `SELECT e.id, e.src_kmer, e.dst_kmer, e.label, e.coverage,
              (SELECT COUNT(*) FROM edge_obs o WHERE o.edge_id = e.id) AS observation_rows
       FROM edges e WHERE e.assembly_id = ?
       ORDER BY e.coverage DESC, e.src_kmer, e.dst_kmer LIMIT ? OFFSET ?`,
    )
    .all(assemblyId, limit, offset);
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM edges WHERE assembly_id = ?").get(assemblyId) as {
      c: number;
    }
  ).c;
  return { items, total };
}

export function listBranches(db: DB, assemblyId: number, limit: number, offset: number) {
  getAssembly(db, assemblyId);
  const rows = db
    .prepare(
      "SELECT id, kmer, kind, evidence_json FROM branches WHERE assembly_id = ? ORDER BY kmer, kind LIMIT ? OFFSET ?",
    )
    .all(assemblyId, limit, offset) as {
    id: number;
    kmer: string;
    kind: string;
    evidence_json: string;
  }[];
  const items = rows.map((r) => ({
    id: r.id,
    kmer: r.kmer,
    kind: r.kind,
    evidence: JSON.parse(r.evidence_json),
  }));
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM branches WHERE assembly_id = ?").get(assemblyId) as {
      c: number;
    }
  ).c;
  return { items, total };
}

/** Trace every supporting read/position for the competing edges at a branch node. */
export function traceBranch(db: DB, assemblyId: number, kmer: string, kind?: string) {
  getAssembly(db, assemblyId);
  const rows = db
    .prepare(
      `SELECT id, kind, evidence_json FROM branches
       WHERE assembly_id = ? AND kmer = ? ${kind ? "AND kind = ?" : ""} ORDER BY kind`,
    )
    .all(...(kind ? [assemblyId, kmer, kind] : [assemblyId, kmer])) as {
    id: number;
    kind: string;
    evidence_json: string;
  }[];
  if (rows.length === 0)
    throw new ApiError("NOT_FOUND", `no ${kind ?? ""} branch at kmer ${kmer}`);
  return rows.map((r) => ({ kind: r.kind, evidence: JSON.parse(r.evidence_json) }));
}

export function listUnitigs(db: DB, assemblyId: number, limit: number, offset: number) {
  getAssembly(db, assemblyId);
  const items = db
    .prepare(
      `SELECT id, ord, seq, length, coverage_sum, circular, isolated, start_kmer, end_kmer
       FROM unitigs WHERE assembly_id = ? ORDER BY ord LIMIT ? OFFSET ?`,
    )
    .all(assemblyId, limit, offset);
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM unitigs WHERE assembly_id = ?").get(assemblyId) as {
      c: number;
    }
  ).c;
  return { items, total };
}

export function exportFasta(db: DB, assemblyId: number): string {
  getAssembly(db, assemblyId);
  const rows = db
    .prepare("SELECT ord, seq, length, coverage_sum, circular, isolated FROM unitigs WHERE assembly_id = ? ORDER BY ord")
    .all(assemblyId) as {
    ord: number;
    seq: string;
    length: number;
    coverage_sum: number;
    circular: number;
    isolated: number;
  }[];
  return rows
    .map((r) => {
      const tags = [
        `len=${r.length}`,
        `cov_sum=${r.coverage_sum}`,
        r.circular ? "circular" : "linear",
        r.isolated ? "isolated_component" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `>unitig_${r.ord} assembly=${assemblyId} ${tags}\n${r.seq}`;
    })
    .join("\n");
}

/**
 * Verify supporting evidence for one unitig: every edge along its path must
 * exist with coverage >= 1 and map back to concrete read observations.
 */
export function verifyUnitigSupport(
  db: DB,
  assemblyId: number,
  ord: number,
) {
  getAssembly(db, assemblyId);
  const row = db
    .prepare("SELECT * FROM unitigs WHERE assembly_id = ? AND ord = ?")
    .get(assemblyId, ord) as
    | { seq: string; length: number; coverage_sum: number; circular: number; start_kmer: string }
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `unitig ord ${ord} not found`);

  const assembly = db
    .prepare("SELECT k FROM assemblies WHERE id = ?")
    .get(assemblyId) as { k: number };
  const k = assembly.k;
  const edgeRows = db
    .prepare(
      `SELECT e.src_kmer, e.dst_kmer, e.label, e.coverage,
              (SELECT json_group_array(json_object('readId', o.read_id, 'position', o.position))
               FROM edge_obs o WHERE o.edge_id = e.id) AS obs_json
       FROM edges e WHERE e.assembly_id = ?`,
    )
    .all(assemblyId) as {
    src_kmer: string;
    dst_kmer: string;
    label: string;
    coverage: number;
    obs_json: string;
  }[];
  const edgeByKey = new Map(edgeRows.map((e) => [`${e.src_kmer}>${e.dst_kmer}`, e]));

  const path: {
    kmer: string;
    src: string;
    dst: string;
    coverage: number;
    observations: { readId: number; position: number }[];
    supported: boolean;
  }[] = [];
  let allSupported = row.seq.length >= k;
  // circular unitigs: their stored sequence repeats start_kmer after one loop,
  // so wrap-around edges are examined on the doubled string.
  const scanSeq = row.circular === 1 ? row.seq + row.start_kmer.slice(0, k - 1) : row.seq;
  const expectedEdges = row.circular === 1
    ? row.seq.length - (k - 1)
    : row.seq.length - k + 1;
  for (let i = 0; i + k <= scanSeq.length && path.length < expectedEdges; i++) {
    const kmer = row.seq.slice(i, i + k);
    const src = kmer.slice(0, k - 1);
    const dst = kmer.slice(1);
    const e = edgeByKey.get(`${src}>${dst}`);
    const observations = e
      ? (JSON.parse(e.obs_json) as { readId: number; position: number }[])
      : [];
    const supported = !!e && e.coverage >= 1 && observations.length === e.coverage;
    if (!supported) allSupported = false;
    path.push({
      kmer,
      src,
      dst,
      coverage: e?.coverage ?? 0,
      observations,
      supported,
    });
  }
  return {
    ord,
    length: row.length,
    circular: row.circular === 1,
    allSupported,
    edgeCount: path.length,
    circular: row.circular === 1,
    expectedEdges,
    coverageSumCheck: path.reduce((a, p) => a + p.coverage, 0) === row.coverage_sum,
    path,
  };
}

export interface ReportVersion {
  version: number;
  content: string;
  createdAt: number;
}

/** Build/return a versioned summary report. Repeated request for identical content
 *  does NOT create a new version (idempotent by content hash within kind). */
export function getOrCreateReport(
  db: DB,
  assemblyId: number,
  clock: Clock,
  kind = "summary",
): ReportVersion {
  const a = getAssembly(db, assemblyId) as Record<string, number | string>;
  const branchCount = (
    db.prepare("SELECT COUNT(*) AS c FROM branches WHERE assembly_id = ?").get(assemblyId) as {
      c: number;
    }
  ).c;
  const contentLines = [
    `assembly_id=${assemblyId}`,
    `k=${a.k}`,
    `status=${a.status}`,
    `nodes=${a.node_count}`,
    `edges=${a.edge_count}`,
    `unitigs=${a.unitig_count}`,
    `branches=${branchCount}`,
    `sum_of_unitig_lengths=${a.total_length}`,
    `n50_of_unitigs=${a.n50}`,
    "",
    "NOTE: lengths and N50 are computed ONLY from produced unitigs.",
    "They are NOT the complete genome length and NOT an assembly-correctness rate.",
    branchCount > 0
      ? `AMBIGUITY: ${branchCount} branch node(s) remain; multiple solutions are possible and reported as evidence, no path was chosen arbitrarily.`
      : "DETERMINISTIC: no branch nodes; the maximal non-branching decomposition is unique.",
  ];
  const content = contentLines.join("\n");

  const existing = db
    .prepare("SELECT version, content, created_at FROM reports WHERE assembly_id = ? AND kind = ? ORDER BY version DESC LIMIT 1")
    .get(assemblyId, kind) as { version: number; content: string; created_at: number } | undefined;
  if (existing?.content === content)
    return { version: existing.version, content, createdAt: existing.created_at };

  const version = (existing?.version ?? 0) + 1;
  const createdAt = clock.now();
  db.prepare(
    "INSERT INTO reports(assembly_id, version, kind, content, created_at) VALUES (?,?,?,?,?)",
  ).run(assemblyId, version, kind, content, createdAt);
  return { version, content, createdAt };
}

/** Compare assemblies across k values: independent results, side-by-side stats. */
export function compareK(db: DB, batchId: number) {
  const rows = db
    .prepare(
      `SELECT id, k, node_count, edge_count, unitig_count, total_length, n50, created_at
       FROM assemblies WHERE batch_id = ? ORDER BY k`,
    )
    .all(batchId) as {
    id: number;
    k: number;
    node_count: number;
    edge_count: number;
    unitig_count: number;
    total_length: number;
    n50: number;
    created_at: number;
  }[];
  const enriched = rows.map((r) => {
    const branchCount = (
      db.prepare("SELECT COUNT(*) AS c FROM branches WHERE assembly_id = ?").get(r.id) as {
        c: number;
      }
    ).c;
    const circularCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM unitigs WHERE assembly_id = ? AND circular = 1")
        .get(r.id) as { c: number }
    ).c;
    return { ...r, branchCount, circularCount };
  });
  return {
    batchId,
    compared: enriched.length,
    disclaimer:
      "total_length is the sum of produced unitigs, not complete genome length; n50 is N50 of unitigs, not an accuracy metric.",
    assemblies: enriched,
  };
}
