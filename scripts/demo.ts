import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/db.js';
import { Repository } from '../src/repository.js';
import { generateReads } from '../src/generator.js';
import { createApp, listenLocal } from '../src/server.js';

const dbPath = resolve('tmp', 'demo.db');
rmSync(resolve('tmp'), { recursive: true, force: true });

let tick = 0;
const fixedClock = { now: () => `2026-01-01T00:00:${String(tick++ % 60).padStart(2, '0')}.000Z` };

const db = openDb(dbPath);
const repo = new Repository(db, fixedClock);

console.log('=== Reproducible end-to-end demo ===');
for (const pattern of ['unique', 'repeat', 'bubble', 'circle', 'lowcov'] as const) {
  const generated = generateReads({ seed: 42, pattern });
  const result = repo.importReads(generated.batchId, generated.reads);
  console.log(`\n[${pattern}] batch=${generated.batchId} imported=${result.imported} duplicated=${result.duplicated}`);
  console.log(`  scenario: ${generated.expectedBreakNote}`);
  try {
    const assembly = repo.runAssembly(15, [generated.batchId], `demo-${pattern}`);
    console.log(`  nodes=${assembly.nodeCount} edges=${assembly.edgeCount} skipped=${assembly.skippedReads.length}`);
    console.log(`  contigs=${assembly.stats.contigCount} total=${assembly.stats.totalLength} N50=${assembly.stats.n50} branches=${assembly.branches.length}`);
    for (const contig of assembly.contigs) {
      console.log(`    - ${contig.contigId} len=${contig.length} circular=${contig.circular} isolated=${contig.isolated} cov=${contig.coverage}`);
    }
    const first = repo.runAssembly(15, [generated.batchId], `demo-${pattern}`);
    console.log(`  repeated assembly idempotent: ${first.assemblyId === assembly.assemblyId}`);
    const report = repo.createReport(assembly.assemblyId);
    console.log(`  report: ${report.reportId} v${report.version}`);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'UNKNOWN';
    console.log(`  assembly rejected with explicit code: ${code} (documented low-coverage outcome)`);
  }
}
db.close();

const app = createApp(dbPath, fixedClock);
const { port } = await listenLocal(app.server, 0);
console.log(`\nAPI live at http://127.0.0.1:${port}/health (bound to loopback only)`);
const response = await fetch(`http://127.0.0.1:${port}/assemblies?limit=2&offset=0`);
const body = (await response.json()) as { total: number; items: unknown[] };
console.log(`GET /assemblies -> ${response.status}, total=${body.total}, page items=${body.items.length}`);
app.server.close();
app.db.close();
console.log('\nDemo finished. Database retained at', dbPath);
