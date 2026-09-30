export interface Clock {
  now(): string;
}

export interface RandomSource {
  next(): number;
  nextInt(maxExclusive: number): number;
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ReadRecord {
  readId: string;
  batchId: string;
  seq: string;
  length: number;
  createdAt: string;
}

export interface EdgeObservation {
  readId: string;
  batchId: string;
  position: number;
}

export interface AssemblyRequest {
  k: number;
  batchIds?: string[];
  label?: string;
}

export interface BranchEvidence {
  node: string;
  kind: 'fork' | 'join';
  alternatives: string[];
  supportingEdges: { edge: string; coverage: number; reads: string[] }[];
}

export interface Contig {
  contigId: string;
  sequence: string;
  length: number;
  circular: boolean;
  coverage: number;
  supportingReadIds: string[];
  edges: string[];
  isolated: boolean;
}

export interface AssemblyResult {
  assemblyId: string;
  k: number;
  label: string;
  status: 'ok' | 'rejected';
  rejectionReason?: string;
  nodeCount: number;
  edgeCount: number;
  skippedReads: { readId: string; reason: string }[];
  contigs: Contig[];
  branches: BranchEvidence[];
  stats: ContigStats;
  createdAt: string;
}

export interface ContigStats {
  contigCount: number;
  totalLength: number;
  longest: number;
  n50: number;
  note: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
