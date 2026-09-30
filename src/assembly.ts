import { createHash } from 'node:crypto';
import {
  AppError,
  AssemblyResult,
  BranchEvidence,
  Contig,
  ContigStats,
  EdgeObservation,
  ReadRecord,
} from './types.js';

export const MAX_NODES = 200_000;
export const MAX_K = 256;

export interface EdgeData {
  source: string;
  target: string;
  coverage: number;
  observations: EdgeObservation[];
}

export interface BuiltGraph {
  k: number;
  nodes: Set<string>;
  outEdges: Map<string, EdgeData[]>;
  inEdges: Map<string, EdgeData[]>;
  edgeByKey: Map<string, EdgeData>;
  skippedReads: { readId: string; reason: string }[];
  usedReads: Set<string>;
}

const VALID_SEQ = /^[ACGT]+$/;

export function validateReadSequence(seq: string, k: number): string | null {
  if (!VALID_SEQ.test(seq)) return 'INVALID_CHAR';
  if (seq.length < k) return 'TOO_SHORT';
  return null;
}

export function buildGraph(k: number, reads: ReadRecord[]): BuiltGraph {
  if (!Number.isInteger(k) || k < 2) {
    throw new AppError('INVALID_K', `k must be an integer >= 2, got ${k}`, 400);
  }
  if (k > MAX_K) {
    throw new AppError('INVALID_K', `k must be <= ${MAX_K}`, 400);
  }
  const nodes = new Set<string>();
  const outEdges = new Map<string, EdgeData[]>();
  const inEdges = new Map<string, EdgeData[]>();
  const edgeByKey = new Map<string, EdgeData>();
  const skippedReads: { readId: string; reason: string }[] = [];
  const usedReads = new Set<string>();

  const ordered = [...reads].sort((a, b) =>
    a.batchId === b.batchId
      ? a.readId.localeCompare(b.readId)
      : a.batchId.localeCompare(b.batchId),
  );

  for (const read of ordered) {
    const invalid = validateReadSequence(read.seq, k);
    if (invalid) {
      skippedReads.push({ readId: read.readId, reason: invalid });
      continue;
    }
    usedReads.add(read.readId);
    for (let pos = 0; pos + k <= read.seq.length; pos++) {
      const kmer = read.seq.slice(pos, pos + k);
      const source = kmer.slice(0, k - 1);
      const target = kmer.slice(1);
      nodes.add(source);
      nodes.add(target);
      const key = `${source}>${target}`;
      let edge = edgeByKey.get(key);
      if (!edge) {
        edge = { source, target, coverage: 0, observations: [] };
        edgeByKey.set(key, edge);
        push(outEdges, source, edge);
        push(inEdges, target, edge);
      }
      edge.coverage += 1;
      edge.observations.push({
        readId: read.readId,
        batchId: read.batchId,
        position: pos,
      });
    }
  }

  for (const list of outEdges.values()) {
    list.sort((a, b) => a.target.localeCompare(b.target));
  }
  for (const list of inEdges.values()) {
    list.sort((a, b) => a.source.localeCompare(b.source));
  }

  if (nodes.size > MAX_NODES) {
    throw new AppError(
      'GRAPH_TOO_LARGE',
      `Graph has ${nodes.size} nodes, limit is ${MAX_NODES}. Raise k or reduce input.`,
 422,
      { nodeCount: nodes.size, limit: MAX_NODES },
    );
  }

  return { k, nodes, outEdges, inEdges, edgeByKey, skippedReads, usedReads };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function isOneInOneOut(graph: BuiltGraph, node: string): boolean {
  return (graph.outEdges.get(node)?.length ?? 0) === 1
    && (graph.inEdges.get(node)?.length ?? 0) === 1;
}

export function extractUnitigs(graph: BuiltGraph): Contig[] {
  const contigs: Contig[] = [];
  const consumedEdges = new Set<string>();
  const k = graph.k;

  const startNodes = [...graph.nodes].sort();

  // 1. Paths that start at non-1-in-1-out nodes (linear tips, forks, joins).
  for (const node of startNodes) {
    if (isOneInOneOut(graph, node)) continue;
    const outs = graph.outEdges.get(node);
    if (!outs) continue;
    for (const first of outs) {
      const key = edgeKey(first);
      if (consumedEdges.has(key)) continue;
      contigs.push(walkForward(graph, first, false, consumedEdges));
    }
  }

  // 2. Pure cycles where every node is 1-in-1-out. Deterministic start/direction.
  for (const node of startNodes) {
    const out = graph.outEdges.get(node);
    if (!out || out.length !== 1) continue;
    const firstKey = edgeKey(out[0]);
    if (consumedEdges.has(firstKey)) continue;
    contigs.push(walkForward(graph, out[0], true, consumedEdges));
  }

  return contigs;
}

function edgeKey(edge: EdgeData): string {
  return `${edge.source}>${edge.target}`;
}

function walkForward(
  graph: BuiltGraph,
  first: EdgeData,
  expectCycle: boolean,
  consumedEdges: Set<string>,
): Contig {
  const k = graph.k;
  const edges: EdgeData[] = [first];
  consumedEdges.add(edgeKey(first));
  let current = first.target;
  let circular = false;

  for (;;) {
    const outs = graph.outEdges.get(current);
    if (!outs || outs.length !== 1) break;
    const next = outs[0];
    const key = edgeKey(next);
    if (consumedEdges.has(key)) break;
    if (expectCycle && key === edgeKey(first)) {
      circular = true;
      break;
    }
    edges.push(next);
    consumedEdges.add(key);
    current = next.target;
    if (expectCycle && current === first.source) {
      circular = true;
      break;
    }
    if (!expectCycle && !isOneInOneOut(graph, current)) break;
  }

  let sequence = edges[0].source;
  for (const edge of edges) sequence += edge.target.charAt(edge.target.length - 1);

  const coverages = edges.map((e) => e.coverage);
  const coverage = coverages.reduce((a, b) => a + b, 0) / coverages.length;
  const readSet = new Set<string>();
  for (const edge of edges) {
    for (const obs of edge.observations) readSet.add(obs.readId);
  }

  const contigId = 'ctg_' + createHash('sha1')
    .update(sequence + '|' + (circular ? 'C' : 'L'))
    .digest('hex')
    .slice(0, 12);

  return {
    contigId,
    sequence,
    length: sequence.length,
    circular,
    coverage: Math.round(coverage * 100) / 100,
    supportingReadIds: [...readSet].sort(),
    edges: edges.map(edgeKey),
    isolated: isIsolatedComponent(graph, edges),
  };
}

function isIsolatedComponent(graph: BuiltGraph, seedEdges: EdgeData[]): boolean {
  const componentNodes = new Set<string>();
  for (const edge of seedEdges) {
    componentNodes.add(edge.source);
    componentNodes.add(edge.target);
  }
  for (const node of componentNodes) {
    for (const edge of graph.outEdges.get(node) ?? []) {
      if (!componentNodes.has(edge.target)) return false;
    }
    for (const edge of graph.inEdges.get(node) ?? []) {
      if (!componentNodes.has(edge.source)) return false;
    }
  }
  return true;
}

export function collectBranchEvidence(graph: BuiltGraph): BranchEvidence[] {
  const branches: BranchEvidence[] = [];
  for (const node of [...graph.nodes].sort()) {
    const outs = graph.outEdges.get(node) ?? [];
    const ins = graph.inEdges.get(node) ?? [];
    if (outs.length >= 2) {
      branches.push({
        node,
        kind: 'fork',
        alternatives: outs.map((e) => e.target),
        supportingEdges: outs.map((e) => ({
          edge: edgeKey(e),
          coverage: e.coverage,
          reads: [...new Set(e.observations.map((o) => o.readId))].sort(),
        })),
      });
    }
    if (ins.length >= 2) {
      branches.push({
        node,
        kind: 'join',
        alternatives: ins.map((e) => e.source),
        supportingEdges: ins.map((e) => ({
          edge: edgeKey(e),
          coverage: e.coverage,
          reads: [...new Set(e.observations.map((o) => o.readId))].sort(),
        })),
      });
    }
  }
  return branches;
}

export function computeStats(contigs: Contig[]): ContigStats {
  const lengths = contigs.map((c) => c.length).sort((a, b) => b - a);
  const totalLength = lengths.reduce((a, b) => a + b, 0);
  let n50 = 0;
  if (lengths.length > 0) {
    const half = totalLength / 2;
    let acc = 0;
    for (const length of lengths) {
      acc += length;
      if (acc >= half) {
        n50 = length;
        break;
      }
    }
  }
  return {
    contigCount: contigs.length,
    totalLength,
    longest: lengths[0] ?? 0,
    n50,
    note:
      'Lengths and N50 are computed only over produced contigs; they are NOT the complete genome length or an assembly accuracy rate.',
  };
}

export function runAssembly(
  assemblyId: string,
  label: string,
  k: number,
  reads: ReadRecord[],
  createdAt: string,
): Omit<AssemblyResult, 'assemblyId'> & { assemblyId?: string } {
  let graph: BuiltGraph;
  try {
    graph = buildGraph(k, reads);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw error;
  }
  const contigs = extractUnitigs(graph);
  for (const contig of contigs) contig.length = contig.sequence.length;
  const branches = collectBranchEvidence(graph);
  const stats = computeStats(contigs);
  return {
    assemblyId,
    k,
    label,
    status: 'ok',
    nodeCount: graph.nodes.size,
    edgeCount: graph.edgeByKey.size,
    skippedReads: graph.skippedReads,
    contigs,
    branches,
    stats,
    createdAt,
  };
}
