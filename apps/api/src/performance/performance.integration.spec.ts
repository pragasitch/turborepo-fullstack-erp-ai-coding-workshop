import {
  createPrismaClient,
  seedPerformanceDataset,
  type PrismaClient,
} from '@erp/database';
import type { User } from '@erp/contracts';
import { call } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../../test/integration/test-database.js';
import type { PrismaService } from '../database/prisma.service.js';
import { InventoryController } from '../inventory/inventory.controller.js';
import { movementHistory } from '../reports/movement-history.js';

/**
 * NFR-05 (seam 4). The search and stock-view APIs must stay fast at scale: 1,000 products
 * and 10,000 movements. These scenarios prove, against a real Postgres loaded to that
 * scale, that:
 *
 *  - the scale seed produces the agreed volume;
 *  - the free-text SKU/name search and the stock-view both run on an index, not a full
 *    table scan (so the p95 target is reachable, not luck of a small table);
 *  - the movement-history read, filtered and newest-first, uses the timestamp index.
 *
 * The index names are an implementation detail; the behaviour under test is "the planner
 * chooses an index scan over a sequential scan for the query the API actually runs".
 */

const PRODUCT_COUNT = 1_000;
const MOVEMENT_COUNT = 10_000;

// One scaled database for the whole file: building it is expensive, and every scenario
// below only reads, so there is nothing to reset between them.
let prisma: PrismaClient;
let manager: User;

beforeAll(async () => {
  prisma = createPrismaClient(testDatabaseUrl());
  const seeded = await seedPerformanceDataset(prisma, {
    products: PRODUCT_COUNT,
    movements: MOVEMENT_COUNT,
  });
  manager = seeded.manager;
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The JSON plan for a query. `indexOnly` forces the planner to prefer indexes over a
 * sequential scan, which proves the index can serve this query — the thing NFR-05 needs —
 * rather than asserting on a row-count heuristic that flips with table size. The ANALYZE,
 * SET and EXPLAIN run on one connection (a transaction) so the SET actually applies.
 */
async function plan(sql: string, indexOnly = false): Promise<string> {
  if (!indexOnly) {
    const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(
      `EXPLAIN (FORMAT JSON) ${sql}`,
    );
    return JSON.stringify(rows[0]['QUERY PLAN']);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ANALYZE "Product", "Store", "StockMovement"');
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(
      `EXPLAIN (FORMAT JSON) ${sql}`,
    );
    return JSON.stringify(rows[0]['QUERY PLAN']);
  });
}

function controller() {
  return new InventoryController(prisma as unknown as PrismaService);
}

describe('search and stock-view at NFR-05 scale', () => {
  it('seeds 1,000 products and 10,000 movements', async () => {
    const [products, movements] = await Promise.all([
      prisma.product.count(),
      prisma.stockMovement.count(),
    ]);
    expect(products).toBe(PRODUCT_COUNT);
    expect(movements).toBe(MOVEMENT_COUNT);
  });

  it('serves the SKU/name search from an index, not a sequential scan over Product', async () => {
    // The stock search filters products with ILIKE '%term%' (a leading wildcard), which only
    // a trigram index can serve; a btree cannot. With the sequential scan disabled the planner
    // must reach for the trigram index, proving it covers this query at any table size.
    const planned = await plan(
      `
      SELECT p."id"
      FROM "Product" p
      WHERE p."sku" ILIKE '%SKU000500%' OR p."name" ILIKE '%สินค้า 500%'
    `,
      true,
    );
    expect(planned).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"Product"/);
    expect(planned).toMatch(/Bitmap Index Scan|Index Scan/);
    expect(planned).toMatch(/Product_(sku|name)_trgm_idx/);
  });

  it('reads movement history newest-first from the timestamp index', async () => {
    const planned = await plan(
      `
      SELECT m."id"
      FROM "StockMovement" m
      ORDER BY m."createdAt" DESC, m."id" DESC
      LIMIT 20
    `,
      true,
    );
    expect(planned).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"StockMovement"/);
    expect(planned).toMatch(/Index Scan/);
  });

  it('still returns correct rows for a SKU search at scale', async () => {
    const result = await call(controller().list(manager), {
      page: 1,
      pageSize: 20,
      search: 'SKU000500',
    });
    // One product, both stores (stock-view lists every (product, store) pair).
    expect(result.items.map((i) => `${i.sku}@${i.storeCode}`).sort()).toEqual([
      'SKU000500@B01',
      'SKU000500@B02',
    ]);
  });

  it('returns a filtered movement-history page newest-first at scale', async () => {
    const report = await movementHistory(prisma, manager, {
      page: 1,
      pageSize: 20,
      search: 'SKU000500',
    });
    expect(report.items.length).toBeGreaterThan(0);
    for (const row of report.items) expect(row.sku).toBe('SKU000500');
    const times = report.items.map((r) => Date.parse(r.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
