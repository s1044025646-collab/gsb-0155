import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db.ts";
import { ApiError, httpStatusFor, type ErrorCode } from "./errors.ts";
import { systemClock, type Clock } from "./util.ts";
import { createBatch, importReads, listBatches, listReads, getBatch } from "./services/batches.ts";
import { runAssembly } from "./services/assembler.ts";
import {
  compareK,
  edgeCoverage,
  exportFasta,
  getAssembly,
  getOrCreateReport,
  listAssemblies,
  listBranches,
  listUnitigs,
  traceBranch,
  verifyUnitigSupport,
} from "./services/queries.ts";
import { createFixtureBatch, FIXTURE_KINDS } from "./services/generator.ts";

export interface ServeOptions {
  db: DB;
  dataDir: string;
  clock?: Clock;
  host?: string; // defaults to loopback only
}

interface Ctx {
  db: DB;
  clock: Clock;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  return { method, pattern, keys, handler };
}

const ROUTES: Route[] = [
  route("POST", "/batches", (c) => {
    const b = c.body as { name?: string; description?: string };
    const id = createBatch(c.db, b?.name ?? "", b?.description ?? "", c.clock);
    return { batchId: id, ...getBatch(c.db, id) };
  }),
  route("GET", "/batches", (c) => ({ items: listBatches(c.db) })),
  route("GET", "/batches/:id", (c) => getBatch(c.db, num(c.params.id, "id"))),
  route("GET", "/batches/:id/reads", (c) => {
    const { limit, offset } = paging(c.query);
    return listReads(c.db, num(c.params.id, "id"), limit, offset);
  }),
  route("POST", "/batches/:id/reads", (c) => {
    const body = c.body as { reads?: unknown; minLength?: number };
    if (!Array.isArray(body?.reads))
      throw new ApiError("VALIDATION_ERROR", "body.reads must be an array");
    return importReads(c.db, num(c.params.id, "id"), body.reads, {
      minLength: body.minLength !== undefined ? num(body.minLength, "minLength", 1) : undefined,
      clock: c.clock,
    });
  }),
  route("POST", "/batches/:id/assemblies", (c) => {
    const body = c.body as { k?: number; maxNodes?: number };
    if (body?.k === undefined) throw new ApiError("VALIDATION_ERROR", "body.k is required");
    return runAssembly(c.db, num(c.params.id, "id"), {
      k: num(body.k, "k", 2),
      maxNodes: body.maxNodes !== undefined ? num(body.maxNodes, "maxNodes", 1) : undefined,
      clock: c.clock,
    });
  }),
  route("GET", "/batches/:id/assemblies", (c) => {
    const { limit, offset } = paging(c.query);
    return listAssemblies(c.db, num(c.params.id, "id"), limit, offset);
  }),
  route("GET", "/batches/:id/compare", (c) => compareK(c.db, num(c.params.id, "id"))),
  route("POST", "/fixtures", (c) => {
    const body = c.body as { kind?: string; batchName?: string; seed?: number; description?: string };
    if (!body?.kind || !FIXTURE_KINDS.includes(body.kind as never))
      throw new ApiError("VALIDATION_ERROR", `kind must be one of ${FIXTURE_KINDS.join(", ")}`);
    return createFixtureBatch(c.db, {
      kind: body.kind as never,
      batchName: body.batchName,
      seed: body.seed !== undefined ? num(body.seed, "seed", 0) : 42,
      description: body.description,
      clock: c.clock,
    });
  }),
  route("GET", "/assemblies/:id", (c) => getAssembly(c.db, num(c.params.id, "id"))),
  route("GET", "/assemblies/:id/edges", (c) => {
    const { limit, offset } = paging(c.query);
    return edgeCoverage(c.db, num(c.params.id, "id"), limit, offset);
  }),
  route("GET", "/assemblies/:id/branches", (c) => {
    const { limit, offset } = paging(c.query);
    return listBranches(c.db, num(c.params.id, "id"), limit, offset);
  }),
  route("GET", "/assemblies/:id/branches/:kmer", (c) =>
    traceBranch(c.db, num(c.params.id, "id"), c.params.kmer, c.query.get("kind") ?? undefined),
  ),
  route("GET", "/assemblies/:id/unitigs", (c) => {
    const { limit, offset } = paging(c.query);
    return listUnitigs(c.db, num(c.params.id, "id"), limit, offset);
  }),
  route("GET", "/assemblies/:id/unitigs/:ord/verify", (c) =>
    verifyUnitigSupport(c.db, num(c.params.id, "id"), num(c.params.ord, "ord", 0)),
  ),
  route("GET", "/assemblies/:id/fasta", (c) =>
    ({ fasta: exportFasta(c.db, num(c.params.id, "id")) }),
  ),
  route("GET", "/assemblies/:id/report", (c) =>
    getOrCreateReport(c.db, num(c.params.id, "id"), c.clock),
  ),
];

function num(v: unknown, name: string, min = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min)
    throw new ApiError("VALIDATION_ERROR", `${name} must be an integer >= ${min}`, { name });
  return n;
}

function paging(q: URLSearchParams): { limit: number; offset: number } {
  let limit = Number(q.get("limit") ?? 50);
  let offset = Number(q.get("offset") ?? 0);
  if (!Number.isInteger(limit) || limit < 1) limit = 50;
  if (limit > 500) limit = 500;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("BAD_REQUEST", "request body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, payload: unknown, contentType = "application/json") {
  res.writeHead(status, { "content-type": `${contentType}; charset=utf-8` });
  res.end(contentType === "application/json" ? JSON.stringify(payload, null, 2) : String(payload));
}

function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: { code, message, details: details ?? null } };
}

export function buildServer(opts: ServeOptions): Server {
  const clock = opts.clock ?? systemClock;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") return send(res, 200, { ok: true, time: clock.now() });
      const matched = ROUTES.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname),
      );
      if (!matched) return send(res, 404, errorBody("NOT_FOUND", `no route for ${req.method} ${url.pathname}`));
      const m = url.pathname.match(matched.pattern)!;
      const params: Record<string, string> = {};
      matched.keys.forEach((key, i) => (params[key] = decodeURIComponent(m[i + 1])));
      const body = req.method === "POST" ? await readJson(req) : {};
      const result = await matched.handler({ db: opts.db, clock, params, query: url.searchParams, body });
      return send(res, 200, result);
    } catch (err) {
      if (err instanceof ApiError)
        return send(res, httpStatusFor(err.code), errorBody(err.code, err.message, err.details));
      const e = err as Error;
      return send(res, 500, errorBody("INTERNAL", e.message));
    }
  });
}

/** Start bound to loopback only on an automatic port; record pid/port in data dir. */
export function startServer(opts: ServeOptions & { port?: number }): Promise<{ server: Server; port: number }> {
  const host = opts.host ?? "127.0.0.1";
  const server = buildServer(opts);
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      mkdirSync(opts.dataDir, { recursive: true });
      writeFileSync(join(opts.dataDir, "server.pid"), String(process.pid));
      writeFileSync(join(opts.dataDir, "server.port"), String(port));
      resolve({ server, port });
    });
  });
}
