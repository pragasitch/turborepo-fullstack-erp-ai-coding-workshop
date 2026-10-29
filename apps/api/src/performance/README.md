# NFR-05 performance load test

The search and stock-view APIs must keep a p95 response time of **≤ 2 seconds** with
**1,000 products, 10,000 stock movements and 10 concurrent users over a continuous
5-minute run** (TOR NFR-05). CSV exports are out of scope.

Three pieces hold this together:

- **Supporting indexes** — `pg_trgm` GIN indexes on `Product.sku`, `Product.name`,
  `Store.code`, `Store.name` (the columns the free-text `ILIKE '%term%'` search filters),
  added in migration `20261029000000_nfr05_search_indexes`. The movement timestamp is
  already indexed on `StockMovement`. Without trigram indexes a leading-wildcard `ILIKE`
  forces a sequential scan.
- **Scale seed** — `seedPerformanceDataset` in `@erp/database`, the single source of
  "scale" shared by the integration spec and the harness below. **Destructive**: it
  truncates every ERP table, so only point it at a throwaway database.
- **Load-test harness** — `run-load-test.ts`, which signs in, drives N concurrent users
  against the two endpoints for a duration, and prints a per-endpoint p95 report, exiting
  non-zero unless every endpoint meets the ceiling.

## Proof that runs in CI

`performance.integration.spec.ts` (seam 4, `pnpm --filter @erp/api test:integration`)
loads the scaled dataset and asserts that the search is served by the trigram index, that
history reads newest-first from the timestamp index, and that both still return correct
rows. The 5-minute throughput run itself is too long for CI and is run on demand.

## Running the 5-minute load test on demand

Against a disposable database (never the dev `erp` database):

```bash
# 1. Point at a throwaway database and seed it to scale (truncates it first).
export DATABASE_URL=postgresql://erp:erp@localhost:5432/erp_loadtest
pnpm --filter @erp/api load-test:seed

# 2. Start the API against that same database (separate shell, same DATABASE_URL).
pnpm --filter @erp/api start

# 3. Run the load test (defaults: 10 users, 300s, p95 ceiling 2000ms, localhost:3000).
pnpm --filter @erp/api load-test
```

Overridable with env vars: `LOAD_USERS`, `LOAD_DURATION_SECONDS`, `LOAD_P95_CEILING_MS`,
`LOAD_BASE_URL`, `LOAD_EMAIL`, `LOAD_PASSWORD` (harness); `LOAD_PRODUCTS`,
`LOAD_MOVEMENTS` (seed). A short run (`LOAD_DURATION_SECONDS=10`) is handy to smoke-test
the harness.
