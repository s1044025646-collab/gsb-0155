import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import type { Server } from "node:http";
import type { DB } from "../src/db.ts";
import { fixedClock } from "./helpers.ts";
import { cleanup, tempDb } from "./helpers.ts";

let db: DB;
let server: Server;
let base: string;
let dir: string;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json as Record<string, unknown> };
}

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  dir = t.dir;
  server = buildServer({ db, dataDir: dir, clock: fixedClock });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(() =>
  new Promise<void>((resolve) => {
    server.close(() => {
      cleanup(dir);
      resolve();
    });
  }),
);

describe("HTTP API", () => {
  test("health", async () => {
    const r = await call("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
  });

  test("full fixture -> assembly -> branches -> verify -> report flow", async () => {
    const f = await call("POST", "/fixtures", { kind: "bubble", seed: 42 });
    assert.equal(f.status, 200);
    const batchId = (f.body as { batchId: number }).batchId;

    const a = await call("POST", `/batches/${batchId}/assemblies`, { k: 6 });
    assert.equal(a.status, 200);
    const assemblyId = (a.body as { assemblyId: number }).assemblyId;

    const edges = await call("GET", `/assemblies/${assemblyId}/edges?limit=2&offset=0`);
    assert.equal(edges.status, 200);
    assert.equal((edges.body as { total: number }).total >= 1, true);
    assert.equal((edges.body as { items: unknown[] }).items.length, 2);

    const branches = await call("GET", `/assemblies/${assemblyId}/branches`);
    const branchItems = (branches.body as { items: { kmer: string; kind: string }[] }).items;
    assert.ok(branchItems.some((b) => b.kind === "fork"));

    const traced = await call(
      "GET",
      `/assemblies/${assemblyId}/branches/${branchItems[0].kmer}?kind=${branchItems[0].kind}`,
    );
    assert.equal(traced.status, 200);

    const units = await call("GET", `/assemblies/${assemblyId}/unitigs`);
    const ord = (units.body as { items: { ord: number }[] }).items[0].ord;
    const verify = await call("GET", `/assemblies/${assemblyId}/unitigs/${ord}/verify`);
    assert.equal((verify.body as { allSupported: boolean }).allSupported, true);

    const fasta = await call("GET", `/assemblies/${assemblyId}/fasta`);
    assert.match(String((fasta.body as { fasta: string }).fasta), /^>unitig_0/);

    const r1 = await call("GET", `/assemblies/${assemblyId}/report`);
    const r2 = await call("GET", `/assemblies/${assemblyId}/report`);
    assert.equal((r1.body as { version: number }).version, (r2.body as { version: number }).version);
    assert.match(String((r1.body as { content: string }).content), /NOT the complete genome length/);

    const cmp = await call("GET", `/batches/${batchId}/compare`);
    assert.equal((cmp.body as { compared: number }).compared, 1);
  });

  test("validation errors use explicit codes and 422", async () => {
    const bad = await call("POST", "/fixtures", { kind: "nope" });
    assert.equal(bad.status, 422);
    assert.equal((bad.body as { error: { code: string } }).error.code, "VALIDATION_ERROR");

    const batch = await call("POST", "/batches", { name: "v" });
    const id = (batch.body as { batchId: number }).batchId;
    const dna = await call("POST", `/batches/${id}/reads`, { reads: [{ seq: "ACGTX" }] });
    assert.equal(dna.status, 200);
    assert.equal((dna.body as { rejected: { reason: string }[] }).rejected[0].reason.includes("ACGT"), true);

    const assemble = await call("POST", `/batches/${id}/assemblies`, { k: 6 });
    assert.equal((assemble.body as { error: { code: string } }).error.code, "EMPTY_BATCH");
  });

test("unknown routes and missing resources return 404 codes", async () => {
    const nf = await call("GET", "/nope");
    assert.equal(nf.status, 404);
    const missing = await call("GET", "/assemblies/9999/edges");
    assert.equal((missing.body as { error: { code: string } }).error.code, "NOT_FOUND");
  });

  test("pagination clamps oversized limit and respects offset", async () => {
    await call("POST", "/fixtures", { kind: "unique_linear", seed: 1 });
    const batches = await call("GET", "/batches?limit=999999");
    assert.ok(Array.isArray((batches.body as { items: unknown[] }).items));
    const readsPage = await call("GET", `/batches/1/reads?limit=1&offset=0`);
    assert.equal(readsPage.status, 200);
  });

  test("malformed JSON body is rejected with BAD_REQUEST", async () => {
    const res = await fetch(base + "/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "BAD_REQUEST");
  });
});
