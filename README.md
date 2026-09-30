# DNA Short-Read Assembly & Branch Ambiguity Backend

A fully local Windows-runnable backend for assembling **orientation-unified, ACGT-only**
short reads with a hand-built directed de Bruijn graph. It tracks read ids, batches,
k values, coverage, assembly graphs, unitigs, branch evidence and versioned reports.

There is **no web UI, no species-tree inference, and no connection to real sequence
databases**. A fictional read generator and an HTTP API + CLI are provided.

## What it does

- Reads belong to batches; identical read ids are imported once (idempotent, no double counting).
- Graph nodes are the `k-1` prefix/suffix of each k-mer; edges carry **coverage** and the
  originating `(readId, batchId, position)` observations.
- Repeated observation of the same edge increments coverage instead of creating a false fork.
- Maximal non-branching paths are extracted as deterministic **unitigs**.
- Forks (`out-degree >= 2`) and joins (`in-degree >= 2`) are emitted as **branch evidence**
  with the supporting edges, coverage and read ids. The assembler never picks a cross-branch
  path and claims a unique genome.
- Pure cycles are emitted from a fixed start/direction and flagged `circular`.
- Isolated components are kept and flagged, not dropped.
- Reads shorter than `k` (`TOO_SHORT`) or containing non-ACGT characters (`INVALID_CHAR`)
  are reported per assembly; oversized graphs fail with `GRAPH_TOO_LARGE`.
- Length sums and N50 are computed **only over produced contigs** — they are explicitly not
  the complete genome length or an assembly accuracy rate.
- Different `k` / input sets are stored independently; identical repeated requests return the
  same stored assembly (content-hash idempotency).
- Reports are versioned snapshots for historical reproduction.

## Requirements

- Windows 10/11 with **Node.js >= 22.5** (developed on Node 25). The built-in
  `node:sqlite` module is used, so no native build tools are needed.
- All data stays under `data/` and `tmp/` inside this project.

## Install

```powershell
npm install
```

## Tests

```powershell
npm test
```

The suite (26 tests) covers: unique linear assembly, per-edge attribution and positions,
overlap stitching, coverage accumulation without fake forks, repeat-driven fork/join
ambiguity, branch bubbles, pure circular contigs, low-coverage breaks, isolated components,
same content with different read ids, deterministic output, N50 semantics, validation
failure codes, transaction rollback, idempotent imports/assemblies, pagination, versioned
reports, restart persistence, repeatable migrations and the HTTP API.

## Reproducible end-to-end demo

```powershell
npm run demo
```

Runs five fixtures (`unique`, `repeat`, `bubble`, `circle`, `lowcov`) with a fixed seed
and injected clock, verifies idempotent re-assembly, creates reports, and briefly serves
the API on an automatic loopback port. Its database is written to `tmp/demo.db`.

## HTTP API (start / stop)

```powershell
npm start          # binds 127.0.0.1 only, automatic port; writes tmp/server.port + tmp/server.pid
npm stop           # stops only this project's server recorded in tmp/
```

Optional fixed port: `$env:PORT=8765; npm start`.

Endpoints (JSON in/out):

- `GET  /health`
- `POST /batches` `{batchId, note?}`
- `GET  /batches`
- `POST /reads/import` `{batchId, reads:[{readId, seq}]}` (transactional)
- `GET  /reads?batchId=&limit=&offset=` (paginated, limit 1..500)
- `POST /assemblies` `{k, batchIds?, label?}` (idempotent by input content)
- `GET  /assemblies?limit=&offset=`
- `GET  /assemblies/:id`
- `GET  /assemblies/:id/contigs/:contigId/evidence` (independent edges + supporting reads)
- `POST /assemblies/:id/reports`, `GET /assemblies/:id/reports`, `GET /reports/:reportId`

Errors use a stable body `{error:{code,message,details}}` with codes such as
`INVALID_K`, `INVALID_SEQUENCE`, `INVALID_JSON`, `INVALID_PAGINATION`, `BATCH_NOT_FOUND`,
`NO_READS`, `GRAPH_TOO_LARGE`, `ASSEMBLY_NOT_FOUND`, `CONTIG_NOT_FOUND`, `NOT_FOUND`.

### Example

```powershell
npm start
$p = Get-Content tmp/server.port
Invoke-RestMethod "http://127.0.0.1:$p/batches" -Method Post -ContentType 'application/json' `
  -Body '{"batchId":"demo"}'
```

## CLI

```powershell
npm run cli -- generate --seed 42 --pattern repeat --import
npm run cli -- batches
npm run cli -- reads --batch gen_repeat_42 --limit 10
npm run cli -- assemble --k 15 --batch gen_repeat_42
npm run cli -- assemblies
npm run cli -- coverage --asm <asm_id>
npm run cli -- branches --asm <asm_id>
npm run cli -- contigs  --asm <asm_id>
npm run cli -- evidence --asm <asm_id> --contig <contig_id>
npm run cli -- compare  --k 11 --k 15 --batch gen_repeat_42
npm run cli -- export   --asm <asm_id> --out tmp/asm.json
npm run cli -- report   --asm <asm_id>
npm run cli -- reports  --asm <asm_id>
```

`generate` supports `unique|repeat|bubble|circle|lowcov`; without `--import` it previews
reads. Import accepts a JSON file (`--file`) that is either an array of
`{readId, seq}` or `{reads:[...]}`. CLI state-changing commands print before/after snapshots.

## Project layout

- `src/assembly.ts` — graph construction, unitig extraction, branch evidence, N50.
- `src/repository.ts` — SQLite persistence, transactions, idempotency, reports.
- `src/db.ts` — idempotent schema migrations.
- `src/server.ts` — local-only HTTP API with validation and pagination.
- `src/cli.ts` — command-line interface.
- `src/generator.ts` — seeded fictional read generator (xorshift PRNG, injectable).
- `scripts/demo.ts` — reproducible end-to-end demonstration.
- `tests/` — automated tests.

## Notes and limitations

- Input is assumed to be orientation-unified ACGT reads; no reverse-complement handling.
- A graph larger than 200,000 nodes (`MAX_NODES` in `src/assembly.ts`) is rejected rather
  than partially computed; increase `k` or split the input.
- Stop/start scripts manage only the process registered by `npm start` for this project.
