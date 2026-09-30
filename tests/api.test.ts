import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { createApp, listenLocal } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'dna-api-'));
const dbPath = join(dir, 'api.db');
let tick = 0;
const clock = { now: () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z` };

const app = createApp(dbPath, clock);
let base: string;

before(async () => {
  const { port } = await listenLocal(app.server, 0);
  const address = app.server.address() as AddressInfo;
  assert.equal(address.address, '127.0.0.1', 'server must bind loopback only');
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((done) => app.server.close(() => done()));
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit) {
  const response = await fetch(base + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

test('health endpoint works', async () => {
  const { status, body } = await api('/health');
  assert.equal(status, 200);
  assert.equal((body as { status: string }).status, 'ok');
});

test('full flow: batch, import, assemble, evidence, report', async () => {
  const batch = await api('/batches', {
    method: 'POST',
    body: JSON.stringify({ batchId: 'api-batch' }),
  });
  assert.equal(batch.status, 201);

  const imported = await api('/reads/import', {
    method: 'POST',
    body: JSON.stringify({
      batchId: 'api-batch',
      reads: [
        { readId: 'a', seq: 'ACGTACGTACGT' },
        { readId: 'b', seq: 'TACGTACGTACG' },
      ],
    }),
  });
  assert.equal(imported.status, 200);

  const bad = await api('/reads/import', {
    method: 'POST',
    body: JSON.stringify({ batchId: 'api-batch', reads: [{ readId: 'x', seq: 'ZZZZ' }] }),
  });
  assert.equal(bad.status, 422);
  assert.equal((bad.body.error as { code: string }).code, 'INVALID_SEQUENCE');

  const assembled = await api('/assemblies', {
    method: 'POST',
    body: JSON.stringify({ k: 7, batchIds: ['api-batch'] }),
  });
  assert.equal(assembled.status, 201);
  const assembly = assembled.body as unknown as {
    assemblyId: string;
    contigs: { contigId: string; edges: string[]; supportingReadIds: string[] }[];
  };

  const evidence = await api(`/assemblies/${assembly.assemblyId}/contigs/${assembly.contigs[0].contigId}/evidence`);
  assert.equal(evidence.status, 200);
  assert.ok((evidence.body.edges as string[]).length > 0);

  const report = await api(`/assemblies/${assembly.assemblyId}/reports`, { method: 'POST' });
  assert.equal(report.status, 201);
});

test('parameter validation returns explicit codes', async () => {
  const invalidK = await api('/assemblies', { method: 'POST', body: JSON.stringify({ k: 1 }) });
  assert.equal(invalidK.status, 400);
  assert.equal((invalidK.body.error as { code: string }).code, 'INVALID_K');

  const badJson = await fetch(base + '/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  const body = (await badJson.json()) as { error: { code: string } };
  assert.equal(badJson.status, 400);
  assert.equal(body.error.code, 'INVALID_JSON');

  const missing = await api('/assemblies/asm_nope');
  assert.equal(missing.status, 404);
  assert.equal((missing.body.error as { code: string }).code, 'ASSEMBLY_NOT_FOUND');
});

test('pagination metadata is returned', async () => {
  const page = await api('/reads?batchId=api-batch&limit=1&offset=0');
  assert.equal(page.status, 200);
  assert.equal(page.body.limit, 1);
  assert.ok((page.body.total as number) >= 2);

  const badPaging = await api('/reads?limit=0');
  assert.equal(badPaging.status, 400);
  assert.equal((badPaging.body.error as { code: string }).code, 'INVALID_PAGINATION');
});

test('repeated assembly POST is idempotent', async () => {
  const payload = JSON.stringify({ k: 8, batchIds: ['api-batch'], label: 'idem' });
  const first = await api('/assemblies', { method: 'POST', body: payload });
  const second = await api('/assemblies', { method: 'POST', body: payload });
  assert.equal(
    (first.body as { assemblyId: string }).assemblyId,
    (second.body as { assemblyId: string }).assemblyId,
  );
});
