import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { openDb } from './db.js';
import { Repository } from './repository.js';
import { AppError, Clock } from './types.js';

const systemClock: Clock = { now: () => new Date().toISOString() };

export function createApp(dbPath = resolve('data', 'assembly.db'), clock: Clock = systemClock) {
  const db = openDb(dbPath);
  const repo = new Repository(db, clock);

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AppError('INVALID_JSON', 'Request body must be valid JSON', 400);
    }
  }

  function pagination(url: URL): { limit: number; offset: number } {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new AppError('INVALID_PAGINATION', 'limit must be an integer in [1,500]', 400);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AppError('INVALID_PAGINATION', 'offset must be a non-negative integer', 400);
    }
    return { limit, offset };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        json(res, 200, { status: 'ok', batches: repo.listBatches().length });
        return;
      }

      if (method === 'POST' && path === '/batches') {
        const body = (await readBody(req)) as { batchId?: unknown; note?: unknown };
        if (typeof body.batchId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(body.batchId)) {
          throw new AppError('INVALID_BATCH_ID', 'batchId must match [A-Za-z0-9_.-]{1,64}', 400);
        }
        if (body.note !== undefined && typeof body.note !== 'string') {
          throw new AppError('INVALID_NOTE', 'note must be a string', 400);
        }
        const result = repo.createBatch(body.batchId, body.note);
        json(res, result.created ? 201 : 200, result);
        return;
      }

      if (method === 'GET' && path === '/batches') {
        json(res, 200, { items: repo.listBatches() });
        return;
      }

      if (method === 'POST' && path === '/reads/import') {
        const body = (await readBody(req)) as {
          batchId?: unknown;
          reads?: unknown;
        };
        if (typeof body.batchId !== 'string') {
          throw new AppError('INVALID_BATCH_ID', 'batchId is required', 400);
        }
        if (!Array.isArray(body.reads) || body.reads.length === 0 || body.reads.length > 100_000) {
          throw new AppError('INVALID_READS', 'reads must be a non-empty array (<=100000)', 400);
        }
        const normalized = body.reads.map((entry, index) => {
          if (!entry || typeof entry !== 'object') {
            throw new AppError('INVALID_READ', `reads[${index}] must be an object`, 400);
          }
          const item = entry as { readId?: unknown; seq?: unknown };
          if (typeof item.readId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(item.readId)) {
            throw new AppError('INVALID_READ_ID', `reads[${index}].readId is invalid`, 400);
          }
          if (typeof item.seq !== 'string' || item.seq.length === 0 || item.seq.length > 100_000) {
            throw new AppError('INVALID_SEQUENCE', `reads[${index}].seq must be 1..100000 chars`, 400);
          }
          if (!/^[ACGT]+$/.test(item.seq)) {
            throw new AppError('INVALID_SEQUENCE', `reads[${index}] contains non-ACGT characters`, 422);
          }
          return { readId: item.readId, seq: item.seq };
        });
        const result = repo.importReads(body.batchId, normalized);
        json(res, 200, result);
        return;
      }

      if (method === 'GET' && path === '/reads') {
        const { limit, offset } = pagination(url);
        const batchId = url.searchParams.get('batchId') ?? undefined;
        json(res, 200, repo.listReads(batchId, limit, offset));
        return;
      }

      if (method === 'POST' && path === '/assemblies') {
        const body = (await readBody(req)) as { k?: unknown; batchIds?: unknown; label?: unknown };
        if (!Number.isInteger(body.k) || (body.k as number) < 2) {
          throw new AppError('INVALID_K', 'k must be an integer >= 2', 400);
        }
        let batchIds: string[] | undefined;
        if (body.batchIds !== undefined) {
          if (!Array.isArray(body.batchIds) || body.batchIds.some((b) => typeof b !== 'string')) {
            throw new AppError('INVALID_BATCH_IDS', 'batchIds must be an array of strings', 400);
          }
          batchIds = body.batchIds as string[];
        }
        if (body.label !== undefined && typeof body.label !== 'string') {
          throw new AppError('INVALID_LABEL', 'label must be a string', 400);
        }
        const result = repo.runAssembly(body.k as number, batchIds, body.label as string | undefined);
        json(res, 201, result);
        return;
      }

      if (method === 'GET' && path === '/assemblies') {
        const { limit, offset } = pagination(url);
        json(res, 200, repo.listAssemblies(limit, offset));
        return;
      }

      const assemblyMatch = path.match(/^\/assemblies\/([A-Za-z0-9_-]+)$/);
      if (method === 'GET' && assemblyMatch) {
        const assembly = repo.getAssembly(assemblyMatch[1]);
        if (!assembly) throw new AppError('ASSEMBLY_NOT_FOUND', 'assembly not found', 404);
        json(res, 200, assembly);
        return;
      }

      const contigEvidenceMatch = path.match(/^\/assemblies\/([A-Za-z0-9_-]+)\/contigs\/([A-Za-z0-9_]+)\/evidence$/);
      if (method === 'GET' && contigEvidenceMatch) {
        const assembly = repo.getAssembly(contigEvidenceMatch[1]);
        if (!assembly) throw new AppError('ASSEMBLY_NOT_FOUND', 'assembly not found', 404);
        const contig = assembly.contigs.find((c) => c.contigId === contigEvidenceMatch[2]);
        if (!contig) throw new AppError('CONTIG_NOT_FOUND', 'contig not found', 404);
        json(res, 200, {
          contigId: contig.contigId,
          edges: contig.edges,
          supportingReadIds: contig.supportingReadIds,
          coverage: contig.coverage,
        });
        return;
      }

      const reportsMatch = path.match(/^\/assemblies\/([A-Za-z0-9_-]+)\/reports$/);
      if (method === 'POST' && reportsMatch) {
        const result = repo.createReport(reportsMatch[1]);
        json(res, 201, result);
        return;
      }
      if (method === 'GET' && reportsMatch) {
        json(res, 200, { items: repo.listReports(reportsMatch[1]) });
        return;
      }

      const reportMatch = path.match(/^\/reports\/([A-Za-z0-9_.-]+)$/);
      if (method === 'GET' && reportMatch) {
        const report = repo.getReport(reportMatch[1]);
        if (!report) throw new AppError('REPORT_NOT_FOUND', 'report not found', 404);
        json(res, 200, report);
        return;
      }

      throw new AppError('NOT_FOUND', `route ${method} ${path} not found`, 404);
    } catch (error) {
      if (error instanceof AppError) {
        json(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      } else {
        const message = error instanceof Error ? error.message : 'internal error';
        json(res, 500, { error: { code: 'INTERNAL', message } });
      }
    }
  });

  return { server, db, repo };
}

export function listenLocal(server: Server, preferredPort = 0): Promise<{ port: number }> {
  return new Promise((resolveListen) => {
    server.listen(preferredPort, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveListen({ port });
    });
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const { server } = createApp();
  const { port } = await listenLocal(server, Number(process.env.PORT ?? 0));
  console.log(`DNA assembly API listening on http://127.0.0.1:${port}`);
}
