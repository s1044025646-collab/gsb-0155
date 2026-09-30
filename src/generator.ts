import { createHash } from 'node:crypto';
import { RandomSource } from './types.js';

export class SeededRandom implements RandomSource {
  private state: bigint;

  constructor(seed: number) {
    this.state = BigInt(seed >>> 0) || 0x9e3779b9n;
  }

  next(): number {
    // xorshift64
    let x = this.state;
    x ^= x << 13n;
    x ^= x >> 7n;
    x ^= x << 17n;
    x &= 0xffffffffffffffffn;
    if (x === 0n) x = 0x9e3779b97f4a7c15n;
    this.state = x;
    return Number(x >> 11n) / Number(1n << 53n);
  }

  nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

export interface GenerateOptions {
  seed: number;
  genomeLength?: number;
  readLength?: number;
  coverage?: number;
  pattern?: 'unique' | 'repeat' | 'bubble' | 'circle' | 'lowcov';
}

const BASES = ['A', 'C', 'G', 'T'] as const;

function randomGenome(
  rng: RandomSource,
  length: number,
  merLength = 14,
  circular = false,
): string {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const chars: string[] = [];
    for (let i = 0; i < length; i++) chars.push(BASES[rng.nextInt(4)]);
    const seq = chars.join('');
    const mers = new Set<string>();
    let unique = true;
    const count = circular ? length : length - merLength + 1;
    for (let i = 0; i < count; i++) {
      const mer = seq.slice(i, i + merLength);
      if (mers.has(mer)) {
        unique = false;
        break;
      }
      mers.add(mer);
    }
    if (unique) return seq;
  }
  throw new Error(`failed to generate a unique ${merLength}-mer genome of length ${length}`);
}

export interface GeneratedSet {
  batchId: string;
  genome: string;
  circular: boolean;
  reads: { readId: string; seq: string }[];
  expectedBreakNote: string;
}

export function generateReads(options: GenerateOptions): GeneratedSet {
  const rng = new SeededRandom(options.seed);
  const readLength = options.readLength ?? 22;
  const coverage = options.coverage ?? 6;
  const pattern = options.pattern ?? 'unique';

  let genome = '';
  let circular = false;
  let note = 'single unique linear genome';

  if (pattern === 'circle') {
    circular = true;
    genome = randomGenome(rng, options.genomeLength ?? 90, 14, true);
    note = 'circular genome; reads wrap around the origin';
  } else if (pattern === 'repeat') {
    const left = randomGenome(rng, 22, 6);
    const repeat = randomGenome(rng, 18, 18);
    const middle = randomGenome(rng, 22, 6);
    const right = randomGenome(rng, 18, 6);
    // Keep flanking 14-mers distinct from repeat k-mers so the graph forks only at repeat copies.
    genome = left + repeat + middle + repeat + right;
    note = 'one repeat copy occurs twice, creating fork/join ambiguity';
  } else if (pattern === 'bubble') {
    const left = randomGenome(rng, 24, 14);
    const right = randomGenome(rng, 24, 14);
    const armA = randomGenome(rng, 10, 9);
    const armB = mutate(armA, rng, 4);
    genome = left + armA + right;
    note = 'two alternative haplotype arms form a bubble';
  } else if (pattern === 'lowcov') {
    genome = randomGenome(rng, options.genomeLength ?? 120, 14);
    note = 'deliberately sparse sampling leaves uncovered break points';
  } else {
    genome = randomGenome(rng, options.genomeLength ?? 100, 14);
  }

  const reads: { readId: string; seq: string }[] = [];
  const span = circular ? genome.length : genome.length - readLength + 1;
  if (span <= 0) {
    return { batchId: `gen_${options.seed}`, genome, circular, reads, expectedBreakNote: note };
  }
  const pick = (start: number): string => {
    let seq = '';
    for (let j = 0; j < readLength; j++) seq += genome[(start + j) % genome.length];
    return seq;
  };

  if (pattern === 'bubble') {
    const armBLen = 10;
    const armB = mutate(genome.slice(22, 22 + armBLen), new SeededRandom(options.seed + 1), 4);
    const haplotypeB = genome.slice(0, 22) + armB + genome.slice(22 + armBLen);
    const stride = Math.max(1, Math.floor(readLength / 3));
    for (const hap of [genome, haplotypeB]) {
      for (let start = 0; start + readLength <= hap.length; start += stride) {
        let seq = '';
        for (let j = 0; j < readLength; j++) seq += hap[start + j];
        reads.push({
          readId: `r_${pattern}_${options.seed}_${String(reads.length + 1).padStart(4, '0')}`,
          seq,
        });
      }
    }
  } else if (pattern === 'lowcov') {
    // Sample two distant windows so an uncovered middle gap breaks the graph.
    const windows: [number, number][] = [
      [0, Math.min(span, 2)],
      [span - 2, span],
    ];
    for (const [from, to] of windows) {
      for (let start = from; start < to; start++) {
        reads.push({
          readId: `r_${pattern}_${options.seed}_${String(reads.length + 1).padStart(4, '0')}`,
          seq: pick(start),
        });
      }
    }
  } else {
    const totalReads = Math.max(1, Math.round((coverage * span) / readLength));
    for (let i = 0; i < totalReads; i++) {
      const base = Math.floor((i * span) / totalReads);
      const jitter = rng.nextInt(Math.min(4, Math.max(1, span - 1))) - 1;
      const start = Math.max(0, Math.min(span - 1, base + jitter));
      reads.push({
        readId: `r_${pattern}_${options.seed}_${String(reads.length + 1).padStart(4, '0')}`,
        seq: pick(start),
      });
    }
  }

  reads.sort((a, b) => a.readId.localeCompare(b.readId));
  const batchId = `gen_${pattern}_${options.seed}`;
  return { batchId, genome, circular, reads, expectedBreakNote: note };
}

function mutate(seq: string, rng: RandomSource, count: number): string {
  const chars = seq.split('');
  const positions = new Set<number>();
  while (positions.size < Math.min(count, chars.length)) positions.add(rng.nextInt(chars.length));
  for (const position of positions) {
    let next = BASES[rng.nextInt(4)];
    while (next === chars[position]) next = BASES[rng.nextInt(4)];
    chars[position] = next;
  }
  return chars.join('');
}

export function hashSeq(seq: string): string {
  return createHash('sha1').update(seq).digest('hex').slice(0, 10);
}
