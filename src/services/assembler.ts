import type { DB } from "../db.ts";
import { ApiError } from "../errors.ts";
import { sha256, type Clock } from "../util.ts";
import { getBatch } from "./batches.ts";

export interface AssemblyOptions {
  k: number;
  maxNodes?: number;
  clock: Clock;
}

interface EdgeRec {
  src: string;
  dst: string;
  label: string;
  reads: { readId: number; position: number }[];
}

export const DEFAULT_MAX_NODES = 200_000;

/**
 * Build a directed de Bruijn graph in memory and persist atomically.
 * Nodes are (k-1)-mers (prefix/suffix of each k-mer); each distinct k-mer is
 * an edge. Repeated observation of the same edge raises coverage and records
 * the source (read id, k-mer position) rather than creating a false fork.
 */
export function runAssembly(db: DB, batchId: number, opts: AssemblyOptions) {
  getBatch(db, batchId);
  const k = opts.k;
  if (!Number.isInteger(k) || k < 2)
    throw new ApiError("VALIDATION_ERROR", "k must be an integer >= 2", { k });
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;

  const reads = db
    .prepare("SELECT id, seq, length FROM reads WHERE batch_id = ? ORDER BY id")
    .all(batchId) as { id: number; seq: string; length: number }[];
  if (reads.length === 0)
    throw new ApiError("EMPTY_BATCH", `batch ${batchId} has no reads to assemble`);

  const fingerprint = sha256(
    `v1|k=${k}|` + reads.map((r) => `${r.id}:${r.seq}`).join("|"),
  );
  const existing = db
    .prepare("SELECT id FROM assemblies WHERE batch_id = ? AND k = ? AND fingerprint = ?")
    .get(batchId, k, fingerprint) as { id: number } | undefined;
  if (existing) return { assemblyId: existing.id, idempotent: true };

  const tooShortReads: { readId: number; length: number }[] = [];
  const edgeMap = new Map<string, EdgeRec>();
  const nodeSet = new Set<string>();

  for (const read of reads) {
    if (read.length < k) {
      tooShortReads.push({ readId: read.id, length: read.length });
      continue;
    }
    for (let i = 0; i + k <= read.seq.length; i++) {
      const kmer = read.seq.slice(i, i + k);
      const src = kmer.slice(0, k - 1);
      const dst = kmer.slice(1);
      nodeSet.add(src);
      nodeSet.add(dst);
      const key = `${src}>${dst}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { src, dst, label: kmer[k - 1], reads: [] };
        edgeMap.set(key, edge);
      }
      edge.reads.push({ readId: read.id, position: i });
    }
  }

  if (nodeSet.size > maxNodes) {
    throw new ApiError(
      "GRAPH_TOO_LARGE",
      `graph has ${nodeSet.size} nodes, exceeding limit ${maxNodes}; raise maxNodes or use larger k`,
      { nodeCount: nodeSet.size, maxNodes, k },
    );
  }

  const edges = [...edgeMap.values()];
  const outAdj = new Map<string, EdgeRec[]>();
  const inAdj = new Map<string, EdgeRec[]>();
  for (const e of edges) {
    outAdj.set(e.src, [...(outAdj.get(e.src) ?? []), e]);
    inAdj.set(e.dst, [...(inAdj.get(e.dst) ?? []), e]);
  }

  // ---- maximal non-branching paths ----
  interface UnitigSpec {
    start: string;
    pathEdges: EdgeRec[];
    circular: boolean;
    isolated: boolean;
  }
  const consumedEdges = new Set<EdgeRec>();
  const specs: UnitigSpec[] = [];
  const isSimple = (node: string) =>
    (inAdj.get(node)?.length ?? 0) === 1 && (outAdj.get(node)?.length ?? 0) === 1;

  // linear maximal non-branching paths: seed at non-simple nodes with outgoing edges
  for (const [node, outs] of outAdj) {
    if (isSimple(node)) continue;
    for (const first of outs) {
      if (consumedEdges.has(first)) continue;
      const pathEdges = [first];
      consumedEdges.add(first);
      let cur = first.dst;
      while (isSimple(cur)) {
        const next = outAdj.get(cur)![0];
        if (consumedEdges.has(next)) break;
        pathEdges.push(next);
        consumedEdges.add(next);
        cur = next.dst;
      }
      specs.push({ start: first.src, pathEdges, circular: false, isolated: false });
    }
  }

  // remaining edges form disjoint cycles: deterministic start (min k-mer) + direction
  for (const e of edges) {
    if (consumedEdges.has(e)) continue;
    const cycleEdges: EdgeRec[] = [];
    let startNode = e.src;
    {
      // lexicographically smallest node of the cycle
      let cur = e.src;
      do {
        if (cur < startNode) startNode = cur;
        const ne = outAdj.get(cur)![0];
        cur = ne.dst;
      } while (cur !== e.src);
    }
    let cur = startNode;
    do {
      const ne = outAdj.get(cur)![0];
      cycleEdges.push(ne);
      consumedEdges.add(ne);
      cur = ne.dst;
    } while (cur !== startNode);
    const isolated = !hasExternal(inAdj, outAdj, startNode, cycleEdges);
    specs.push({ start: startNode, pathEdges: cycleEdges, circular: true, isolated });
  }

  // stable ordering: longest first, then lexicographic
  const unitigs = specs
    .map((s) => specToUnitig(s))
    .sort((a, b) => b.seq.length - a.seq.length || a.seq.localeCompare(b.seq));

  // ---- branch evidence ----
  const branches: { kmer: string; kind: "fork" | "merge"; evidenceJson: string }[] = [];
  for (const node of [...nodeSet].sort()) {
    const outs = outAdj.get(node);
    const ins = inAdj.get(node);
    if (outs && outs.length > 1) branches.push(mkBranch(node, "fork", outs));
    if (ins && ins.length > 1) branches.push(mkBranch(node, "merge", ins));
  }

  const lengths = unitigs.map((u) => u.seq.length);
  const totalLength = lengths.reduce((a, b) => a + b, 0);
  const n50 = computeN50(lengths);

  db.exec("BEGIN");
  try {
    const info = db
      .prepare(
        `INSERT INTO assemblies(batch_id, k, max_nodes, fingerprint, status, node_count, edge_count,
         unitig_count, total_length, n50, created_at) VALUES (?,?,?,?,'ok',?,?,?,?,?,?)`,
      )
      .run(
        batchId, k, maxNodes, fingerprint, nodeSet.size, edges.length,
        unitigs.length, totalLength, n50, opts.clock.now(),
      );
    const assemblyId = Number(info.lastInsertRowid);

    const insNode = db.prepare("INSERT INTO graph_nodes(assembly_id, kmer) VALUES (?,?)");
    for (const node of nodeSet) insNode.run(assemblyId, node);

    const insEdge = db.prepare(
      "INSERT INTO edges(assembly_id, src_kmer, dst_kmer, label, coverage) VALUES (?,?,?,?,?)",
    );
    const insObs = db.prepare(
      "INSERT INTO edge_obs(edge_id, assembly_id, read_id, position) VALUES (?,?,?,?)",
    );
    const edgeIdByKey = new Map<string, number>();
    for (const e of edges) {
      const r = insEdge.run(assemblyId, e.src, e.dst, e.label, e.reads.length);
      const edgeId = Number(r.lastInsertRowid);
      edgeIdByKey.set(`${e.src}>${e.dst}`, edgeId);
      for (const obs of e.reads) insObs.run(edgeId, assemblyId, obs.readId, obs.position);
    }

    const insUnitig = db.prepare(
      `INSERT INTO unitigs(assembly_id, ord, seq, length, coverage_sum, circular, isolated, start_kmer, end_kmer)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    unitigs.forEach((u, i) => {
      insUnitig.run(
        assemblyId, i, u.seq, u.seq.length, u.coverageSum,
        u.circular ? 1 : 0, u.isolated ? 1 : 0, u.startKmer, u.endKmer,
      );
    });

    const insBranch = db.prepare(
      "INSERT INTO branches(assembly_id, kmer, kind, evidence_json) VALUES (?,?,?,?)",
    );
    for (const b of branches) insBranch.run(assemblyId, b.kmer, b.kind, b.evidenceJson);
    db.exec("COMMIT");
    return {
      assemblyId,
      idempotent: false,
      k,
      nodeCount: nodeSet.size,
      edgeCount: edges.length,
      unitigCount: unitigs.length,
      branchCount: branches.length,
      totalLength,
      n50,
      tooShortReads,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function hasExternal(
  inAdj: Map<string, EdgeRec[]>,
  outAdj: Map<string, EdgeRec[]>,
  startNode: string,
  cycleEdges: EdgeRec[],
): boolean {
  const cycleNodes = new Set(cycleEdges.map((e) => e.src));
  for (const node of cycleNodes) {
    for (const e of inAdj.get(node) ?? []) if (!cycleNodes.has(e.src)) return true;
    for (const e of outAdj.get(node) ?? []) if (!cycleNodes.has(e.dst)) return true;
  }
  void startNode;
  return false;
}

function specToUnitig(s: { start: string; pathEdges: EdgeRec[]; circular: boolean; isolated: boolean }) {
  let seq = s.start;
  let coverageSum = 0;
  for (const e of s.pathEdges) {
    seq += e.label;
    coverageSum += e.reads.length;
  }
  const last = s.pathEdges[s.pathEdges.length - 1];
  return {
    seq,
    coverageSum,
    circular: s.circular,
    isolated: s.isolated,
    startKmer: s.start,
    endKmer: last.dst,
  };
}

function mkBranch(node: string, kind: "fork" | "merge", group: EdgeRec[]) {
  const evidence = group
    .map((e) => ({
      kmer: e.src + e.label,
      from: e.src,
      to: e.dst,
      coverage: e.reads.length,
      supportingReads: e.reads.map((r) => ({ readId: r.readId, position: r.position })),
    }))
    .sort((a, b) => b.coverage - a.coverage || a.kmer.localeCompare(b.kmer));
  return { kmer: node, kind, evidenceJson: JSON.stringify(evidence) };
}

export function computeN50(lengths: number[]): number {
  if (lengths.length === 0) return 0;
  const sorted = [...lengths].sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const len of sorted) {
    acc += len;
    if (acc * 2 >= total) return len;
  }
  return sorted[sorted.length - 1];
}
