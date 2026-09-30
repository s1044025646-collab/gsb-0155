import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, collectBranchEvidence, computeStats, extractUnitigs } from '../src/assembly.js';
import { AppError, ReadRecord } from '../src/types.js';

function reads(batchId: string, entries: [string, string][]): ReadRecord[] {
  return entries.map(([readId, seq]) => ({
    readId,
    batchId,
    seq,
    length: seq.length,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
}

test('unique linear sequence produces one contig reconstructing the genome', () => {
  let state = 987654321;
  let genome = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate: string[] = [];
    const seen = new Set<string>();
    let localState = state + attempt * 1009;
    let unique = true;
    for (let i = 0; i < 44; i++) {
      localState = (Math.imul(localState ^ (localState >>> 13), 1664525) + 1013904223) >>> 0;
      candidate.push('ACGT'[localState % 4]);
    }
    const candidateGenome = candidate.join('');
    for (let i = 0; i + 6 <= candidateGenome.length; i++) {
      const mer = candidateGenome.slice(i, i + 6);
      if (seen.has(mer)) {
        unique = false;
        break;
      }
      seen.add(mer);
    }
    if (unique) {
      genome = candidateGenome;
      break;
    }
  }
  assert.ok(genome.length > 0, 'fixture builder should find a repeat-free genome');
  const data: [string, string][] = [];
  for (let start = 0; start + 12 <= genome.length; start += 6) {
    data.push([`r${start}`, genome.slice(start, start + 12)]);
  }
  data.push(['rTail', genome.slice(-12)]);
  const graph = buildGraph(7, reads('b', data));
  const contigs = extractUnitigs(graph);
  assert.equal(contigs.length, 1);
  assert.equal(contigs[0].sequence, genome);
  assert.equal(contigs[0].circular, false);
  assert.equal(collectBranchEvidence(graph).length, 0);
});

test('identical edge observations increase coverage instead of fake branches', () => {
  const graph = buildGraph(4, reads('b', [
    ['a1', 'ACGTACG'],
    ['a2', 'ACGTACG'],
    ['a3', 'ACGTACG'],
  ]));
  assert.equal(graph.edgeByKey.size, 4);
  for (const edge of graph.edgeByKey.values()) {
    assert.equal(edge.coverage, 3);
    assert.equal(edge.observations.length, 3);
  }
  assert.deepEqual(
    [...graph.edgeByKey.values()][0].observations.map((o) => o.readId),
    ['a1', 'a2', 'a3'],
  );
  assert.equal(collectBranchEvidence(graph).length, 0);
});

test('each independent edge observation is attributed to its read and position', () => {
  const graph = buildGraph(5, reads('b', [['x', 'ACGTACGT']]));
  const keys = [...graph.edgeByKey.keys()];
  assert.deepEqual(keys, ['ACGT>CGTA', 'CGTA>GTAC', 'GTAC>TACG', 'TACG>ACGT']);
  const first = graph.edgeByKey.get('ACGT>CGTA')!;
  assert.equal(first.observations[0].position, 0);
  assert.equal(first.observations[0].readId, 'x');
  const last = graph.edgeByKey.get('TACG>ACGT')!;
  assert.equal(last.observations[0].position, 3);
});

test('repeat region yields fork/join evidence and multiple unitigs, not a claimed unique genome', () => {
  const repeat = 'ACGTACGT';
  const left = 'GGGAAATTTCCC';
  const middle = 'CATCATCATCAT';
  const right = 'TTAGCTAGCTAG';
  const genome = left + repeat + middle + repeat + right;
  const data: [string, string][] = [];
  for (let start = 0; start + 18 <= genome.length; start += 3) {
    data.push([`r${start}`, genome.slice(start, start + 18)]);
  }
  const graph = buildGraph(9, reads('b', data));
  const branches = collectBranchEvidence(graph);
  assert.ok(branches.some((b) => b.kind === 'fork'), 'expected a fork at the repeat');
  assert.ok(branches.some((b) => b.kind === 'join'), 'expected a join at the repeat');
  const fork = branches.find((b) => b.kind === 'fork')!;
  assert.ok(fork.supportingEdges.every((e) => e.coverage >= 1));
  assert.ok(fork.supportingEdges.some((e) => e.reads.length > 0));
  const contigs = extractUnitigs(graph);
  assert.ok(contigs.length >= 2, 'ambiguous repeat must not collapse to one unique contig');
});

test('branch bubble creates fork and join with read-backed alternatives', () => {
  const left = 'AAAAAAAAGGGGCCCC';
  const armA = 'TTTT';
  const armB = 'GGGG';
  const right = 'AAAATTTTGGCCCC';
  const haplotypeA = left + armA + right;
  const haplotypeB = left + armB + right;
  const data: [string, string][] = [];
  for (const hap of [haplotypeA, haplotypeB]) {
    for (let start = 0; start + 14 <= hap.length; start += 2) {
      data.push([`r${data.length}`, hap.slice(start, start + 14)]);
    }
  }
  const graph = buildGraph(8, reads('b', data));
  const branches = collectBranchEvidence(graph);
  assert.ok(branches.filter((b) => b.kind === 'fork').length >= 1);
  assert.ok(branches.filter((b) => b.kind === 'join').length >= 1);
  const fork = branches.find((b) => b.kind === 'fork')!;
  assert.equal(fork.alternatives.length, 2);
  const readsPerAlt = fork.supportingEdges.map((e) => new Set(e.reads).size);
  assert.ok(readsPerAlt.every((count) => count >= 1));
});

test('pure circular input yields one marked circular contig with deterministic start', () => {
  const genome = 'ACGTTGGCCAAAGTCTGACGATCGCATG';
  const data: [string, string][] = [];
  for (let start = 0; start < genome.length; start += 2) {
    let seq = '';
    for (let j = 0; j < 14; j++) seq += genome[(start + j) % genome.length];
    data.push([`r${start}`, seq]);
  }
  const graph = buildGraph(13, reads('b', data));
  const first = extractUnitigs(graph);
  const second = extractUnitigs(graph);
  assert.equal(first.length, 1);
  assert.equal(first[0].circular, true);
  assert.deepEqual(first.map((c) => c.contigId), second.map((c) => c.contigId));
  assert.equal(first[0].edges.length, graph.edgeByKey.size);
});

test('low coverage breaks the assembly into separate components that are not dropped', () => {
  const left = 'ACGTACGTACGTACGT';
  const gap = 'NNNN';
  const right = 'TTTTGGGCCCCAAAAT';
  const genome = left + gap + right;
  const data: [string, string][] = [
    ['l1', genome.slice(0, 12)],
    ['l2', genome.slice(2, 14)],
    ['r1', genome.slice(20, 36)],
    ['r2', genome.slice(22, 38)],
  ];
  const clean = data.filter(([, seq]) => /^[ACGT]+$/.test(seq));
  const graph = buildGraph(7, reads('b', clean));
  const contigs = extractUnitigs(graph);
  assert.ok(contigs.length >= 2);
  const totalLength = contigs.reduce((sum, contig) => sum + contig.length, 0);
  assert.ok(totalLength >= left.length + right.length - 12);
});

test('isolated single-read component is kept and flagged', () => {
  const graph = buildGraph(6, reads('b', [['alone', 'ACGTAC']]));
  const contigs = extractUnitigs(graph);
  assert.equal(contigs.length, 1);
  assert.equal(contigs[0].isolated, true);
  assert.equal(contigs[0].sequence, 'ACGTAC');
});

test('reads shorter than k and illegal characters are reported, not fatal', () => {
  const graph = buildGraph(8, reads('b', [
    ['ok', 'ACGTACGTAC'],
    ['short', 'ACGT'],
    ['bad', 'ACGTZZZZ'],
  ]));
  const reasons = Object.fromEntries(graph.skippedReads.map((s) => [s.readId, s.reason]));
  assert.equal(reasons.short, 'TOO_SHORT');
  assert.equal(reasons.bad, 'INVALID_CHAR');
  assert.deepEqual([...graph.usedReads], ['ok']);
});

test('overly large graph is rejected with GRAPH_TOO_LARGE and a clear result', () => {
  const longReads: [string, string][] = [];
  let seq = '';
  let state = 123456789;
  for (let i = 0; i < 300_000; i++) {
    state = (Math.imul(state ^ (state >>> 15), 1103515245) + 12345) >>> 0;
    seq += 'ACGT'[state % 4];
  }
  longReads.push(['big', seq]);
  assert.throws(
    () => buildGraph(21, reads('b', longReads)),
    (error: unknown) => error instanceof AppError && error.code === 'GRAPH_TOO_LARGE',
  );
});

test('N50 is computed only over produced contigs with the documented caveat', () => {
  const graph = buildGraph(5, reads('b', [
    ['a', 'ACGTACGT'],
    ['b', 'GGGGCCCC'],
  ]));
  const stats = computeStats(extractUnitigs(graph));
  assert.equal(stats.contigCount, 2);
  assert.equal(stats.totalLength, 16);
  assert.equal(stats.n50, 8);
  assert.match(stats.note, /NOT the complete genome length/);
});

test('same sequence content with different read ids yields identical graph structure', () => {
  const seq = 'ACGTACGTACGT';
  const graphA = buildGraph(6, reads('b', [['id-a', seq]]));
  const graphB = buildGraph(6, reads('b', [['id-b', seq]]));
  assert.deepEqual([...graphA.edgeByKey.keys()], [...graphB.edgeByKey.keys()]);
  const contigsA = extractUnitigs(graphA);
  const contigsB = extractUnitigs(graphB);
  assert.equal(contigsA[0].sequence, contigsB[0].sequence);
});

test('assembly output is deterministic across repeated runs', () => {
  const data = reads('b', [
    ['a', 'ACGTACGTACGT'],
    ['b', 'TACGTACGTACG'],
    ['c', 'GTACGTACGTAC'],
  ]);
  const run1 = extractUnitigs(buildGraph(7, data)).map((c) => [c.contigId, c.sequence]);
  const run2 = extractUnitigs(buildGraph(7, data)).map((c) => [c.contigId, c.sequence]);
  assert.deepEqual(run1, run2);
});

