#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb } from './db.js';
import { Repository } from './repository.js';
import { AppError, Clock } from './types.js';
import { generateReads } from './generator.js';

const clock: Clock = { now: () => new Date().toISOString() };

function usage(): void {
  console.log(`DNA short-read assembly CLI

Usage:
  npm run cli -- <command> [options]

Commands:
  init-db [--db PATH]
  generate --seed N --pattern unique|repeat|bubble|circle|lowcov [--import] [--batch ID]
  import --batch ID --file reads.json
  batches
  reads [--batch ID] [--limit N] [--offset N]
  assemble --k N [--batch ID ...] [--label TEXT]
  assemblies
  coverage --asm ID
  branches --asm ID
  contigs --asm ID
  evidence --asm ID --contig CONTIG_ID
  export --asm ID --out FILE
  compare --k N --k M [--batch ID ...]
  report --asm ID
  reports --asm ID

Defaults: database at data/assembly.db, exports under tmp/.`);
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const values = flags.get(name) ?? [];
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        values.push(argv[++i]);
      }
      flags.set(name, values);
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

function flagsAll(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function dbPathFrom(args: ParsedArgs): string {
  return resolve(flag(args, 'db') ?? resolve('data', 'assembly.db'));
}

function printBatchSnapshot(repo: Repository, title: string): void {
  const batches = repo.listBatches();
  console.log(`[${title}] ${batches.length} batch(es):`);
  for (const batch of batches) {
    console.log(`  - ${batch.batchId}: ${batch.readCount} read(s)`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const command = process.argv[2];
  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }

  const dbPath = dbPathFrom(args);
  const db = openDb(dbPath);
  const repo = new Repository(db, clock);

  try {
    switch (command) {
      case 'init-db': {
        console.log(`Database ready at ${dbPath} (migrations are idempotent).`);
        break;
      }
      case 'generate': {
        const seed = Number(flag(args, 'seed'));
        if (!Number.isInteger(seed)) throw new AppError('INVALID_SEED', '--seed must be an integer', 400);
        const pattern = (flag(args, 'pattern') ?? 'unique') as
          | 'unique' | 'repeat' | 'bubble' | 'circle' | 'lowcov';
        const generated = generateReads({ seed, pattern });
        console.log(`Generated ${generated.reads.length} reads (pattern=${pattern}, circular=${generated.circular}).`);
        console.log(`Note: ${generated.expectedBreakNote}`);
        if (args.flags.has('import')) {
          const batchId = flag(args, 'batch') ?? generated.batchId;
          printBatchSnapshot(repo, 'before import');
          const result = repo.importReads(batchId, generated.reads);
          console.log(`Imported ${result.imported} new read(s); ${result.duplicated} duplicate(s) skipped.`);
          printBatchSnapshot(repo, 'after import');
        } else {
          console.log('Preview (first 3):');
          for (const read of generated.reads.slice(0, 3)) console.log(`  ${read.readId} ${read.seq}`);
        }
        break;
      }
      case 'import': {
        const batchId = flag(args, 'batch');
        const file = flag(args, 'file');
        if (!batchId || !file) throw new AppError('MISSING_ARGS', 'import requires --batch and --file', 400);
        const parsed = JSON.parse(readFileSync(resolve(file), 'utf8')) as
          | { readId: string; seq: string }[]
          | { reads: { readId: string; seq: string }[] };
        const reads = Array.isArray(parsed) ? parsed : parsed.reads;
        printBatchSnapshot(repo, 'before import');
        const result = repo.importReads(batchId, reads);
        console.log(`Imported ${result.imported} new read(s); ${result.duplicated} duplicate(s) skipped.`);
        printBatchSnapshot(repo, 'after import');
        break;
      }
      case 'batches': {
        printBatchSnapshot(repo, 'batches');
        break;
      }
      case 'reads': {
        const limit = Number(flag(args, 'limit') ?? '20');
        const offset = Number(flag(args, 'offset') ?? '0');
        const page = repo.listReads(flag(args, 'batch'), limit, offset);
        console.log(`Reads ${offset + 1}..${offset + page.items.length} of ${page.total}:`);
        for (const read of page.items) {
          console.log(`  ${read.readId} [${read.batchId}] len=${read.length} ${read.seq}`);
        }
        break;
      }
      case 'assemble': {
        const k = Number(flag(args, 'k'));
        if (!Number.isInteger(k)) throw new AppError('MISSING_ARGS', 'assemble requires --k N', 400);
        const before = repo.listAssemblies(1, 0).total;
        console.log(`Assemblies before: ${before}`);
        const result = repo.runAssembly(k, flagsAll(args, 'batch'), flag(args, 'label'));
        console.log(`Assembly ${result.assemblyId} label='${result.label}' k=${result.k}`);
        console.log(`Graph: ${result.nodeCount} nodes, ${result.edgeCount} distinct edges; skipped ${result.skippedReads.length} read(s).`);
        console.log(`Contigs: ${result.stats.contigCount}, total length ${result.stats.totalLength}, N50 ${result.stats.n50}`);
        console.log(`Branch ambiguity points: ${result.branches.length}`);
        console.log(result.stats.note);
        const after = repo.listAssemblies(1, 0).total;
        console.log(`Assemblies after: ${after} (identical repeated request returns the same stored result).`);
        break;
      }
      case 'assemblies': {
        const page = repo.listAssemblies(100, 0);
        for (const assembly of page.items) {
          console.log(`${assembly.assemblyId} k=${assembly.k} label='${assembly.label}' contigs=${assembly.stats.contigCount} branches=${assembly.branches.length} created=${assembly.createdAt}`);
        }
        break;
      }
      case 'coverage': {
        const asm = requireAssembly(repo, flag(args, 'asm'));
        console.log(`Assembly ${asm.assemblyId}: ${asm.contigs.length} contig(s).`);
        for (const contig of asm.contigs) {
          console.log(`  ${contig.contigId} len=${contig.length} cov=${contig.coverage} circular=${contig.circular} isolated=${contig.isolated} reads=${contig.supportingReadIds.length}`);
        }
        break;
      }
      case 'branches': {
        const asm = requireAssembly(repo, flag(args, 'asm'));
        if (asm.branches.length === 0) {
          console.log('No branch ambiguity: every graph node has at most one incoming and one outgoing edge.');
        }
        for (const branch of asm.branches) {
          console.log(`${branch.kind.toUpperCase()} at ${branch.node}:`);
          for (const edge of branch.supportingEdges) {
            console.log(`  ${edge.edge} coverage=${edge.coverage} reads=[${edge.reads.join(', ')}]`);
          }
        }
        console.log('Cross-branch paths are not collapsed into a claimed unique genome; choose paths only with explicit evidence.');
        break;
      }
      case 'contigs': {
        const asm = requireAssembly(repo, flag(args, 'asm'));
        for (const contig of asm.contigs) {
          const tag = contig.circular ? ' [circular]' : contig.isolated ? ' [isolated component]' : '';
          console.log(`${contig.contigId}${tag} len=${contig.length} cov=${contig.coverage}`);
          console.log(`  ${contig.sequence}`);
        }
        break;
      }
      case 'evidence': {
        const asm = requireAssembly(repo, flag(args, 'asm'));
        const contigId = flag(args, 'contig');
        if (!contigId) throw new AppError('MISSING_ARGS', 'evidence requires --contig', 400);
        const contig = asm.contigs.find((c) => c.contigId === contigId);
        if (!contig) throw new AppError('CONTIG_NOT_FOUND', `contig ${contigId} not found`, 404);
        console.log(`Contig ${contigId} is supported by ${contig.edges.length} independent edge observation(s):`);
        contig.edges.forEach((edge, index) => {
          console.log(`  edge ${index + 1}: ${edge}`);
        });
        console.log(`Supporting reads (${contig.supportingReadIds.length}): ${contig.supportingReadIds.join(', ')}`);
        break;
      }
      case 'export': {
        const asm = requireAssembly(repo, flag(args, 'asm'));
        const out = resolve(flag(args, 'out') ?? resolve('tmp', `${asm.assemblyId}.json`));
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(asm, null, 2));
        console.log(`Exported assembly ${asm.assemblyId} to ${out}`);
        break;
      }
      case 'compare': {
        const ks = flagsAll(args, 'k').map(Number);
        if (ks.length < 2 || ks.some((k) => !Number.isInteger(k))) {
          throw new AppError('MISSING_ARGS', 'compare requires at least two --k N values', 400);
        }
        console.log('k\tcontigs\ttotal\tN50\tbranches\tskipped');
        for (const k of ks) {
          const result = repo.runAssembly(k, flagsAll(args, 'batch'));
          console.log(`${k}\t${result.stats.contigCount}\t${result.stats.totalLength}\t${result.stats.n50}\t${result.branches.length}\t${result.skippedReads.length}`);
        }
        console.log('Different k values are stored as independent assemblies; metrics describe produced contigs only.');
        break;
      }
      case 'report': {
        const asm = requireAssembly(repo, flag(args, 'asm'));
        const report = repo.createReport(asm.assemblyId);
        console.log(`Created versioned report ${report.reportId} (version ${report.version}).`);
        break;
      }
      case 'reports': {
        const asm = requireAssembly(repo, flag(args, 'asm'));
        for (const report of repo.listReports(asm.assemblyId)) {
          console.log(`${report.reportId} v${report.version} ${report.createdAt}`);
        }
        break;
      }
      default:
        throw new AppError('UNKNOWN_COMMAND', `unknown command '${command}'`, 400);
    }
  } finally {
    db.close();
  }
}

function requireAssembly(repo: Repository, id: string | undefined) {
  if (!id) throw new AppError('MISSING_ARGS', '--asm ID is required', 400);
  const assembly = repo.getAssembly(id);
  if (!assembly) throw new AppError('ASSEMBLY_NOT_FOUND', `assembly ${id} not found`, 404);
  return assembly;
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    console.error(`ERROR [${error.code}] ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`ERROR ${error.message}`);
  }
  process.exitCode = 1;
});
