import { hashPassword } from './password.js';
import { DEMO_PASSWORD, truncateAllErpTables } from './fixture.js';
import {
  Role,
  type Prisma,
  type PrismaClient,
  type StockMovementType,
} from './generated/prisma/client.js';

/**
 * The NFR-05 load dataset: enough products and ledger movements to exercise the search and
 * stock-view APIs at the scale the performance target is stated against (TOR NFR-05). It is
 * the source of truth for "scale" shared by the Postgres integration spec and the load-test
 * harness, so both measure the same thing.
 *
 * Two stores and one Manager (who can read every store) back the reads. Products are
 * `SKU000001`.."SKU<n>" with names "สินค้า <n>" so the free-text SKU/name search has
 * realistic, high-cardinality text to filter. Movements are positive RECEIPT rows spread
 * across products and both stores, with a correct running balance per (product, store) and
 * strictly increasing `createdAt`, so the newest-first history and the balances are valid.
 *
 * DESTRUCTIVE: truncates every ERP table first. Only ever point this at a throwaway
 * database (the integration test database, or a disposable load-test database).
 */
export type PerformanceSeedOptions = {
  products: number;
  movements: number;
};

export type PerformanceSeed = {
  /** A Manager, unscoped, for reads that must span every store. */
  manager: {
    id: string;
    email: string;
    name: string;
    role: Role;
    storeId: string | null;
  };
  storeIds: string[];
};

const STORE_CODES = ['B01', 'B02'] as const;
const BATCH = 1_000;

/** The Manager the load test and the integration spec sign in as. */
export const PERFORMANCE_MANAGER = {
  email: 'perf.manager@erp.local',
  password: DEMO_PASSWORD,
} as const;

/** Zero-padded SKU for product n (1-based), e.g. 500 -> "SKU000500". Shared with the harness. */
export function performanceSku(n: number): string {
  return `SKU${String(n).padStart(6, '0')}`;
}

export async function seedPerformanceDataset(
  prisma: PrismaClient,
  options: PerformanceSeedOptions,
): Promise<PerformanceSeed> {
  const { products: productCount, movements: movementCount } = options;

  await truncateAllErpTables(prisma);

  const storeIds: string[] = [];
  for (const [index, code] of STORE_CODES.entries()) {
    const store = await prisma.store.create({
      data: { code, name: `สาขา ${index + 1}` },
    });
    storeIds.push(store.id);
  }

  const passwordHash = await hashPassword(PERFORMANCE_MANAGER.password);
  const manager = await prisma.user.create({
    data: {
      email: PERFORMANCE_MANAGER.email,
      name: 'Performance Manager',
      role: Role.MANAGER,
      passwordHash,
    },
  });

  // Products, in batches so a 1,000-row seed is a handful of round trips.
  const productData: Prisma.ProductCreateManyInput[] = [];
  for (let n = 1; n <= productCount; n += 1) {
    productData.push({
      sku: performanceSku(n),
      name: `สินค้า ${n}`,
      category: 'ทดสอบประสิทธิภาพ',
      unit: 'ชิ้น',
      sellingPrice: '10.00',
    });
  }
  for (let i = 0; i < productData.length; i += BATCH) {
    await prisma.product.createMany({ data: productData.slice(i, i + BATCH) });
  }
  const productRows = await prisma.product.findMany({
    select: { id: true },
    orderBy: { sku: 'asc' },
  });
  const productIds = productRows.map((p) => p.id);

  // Movements: positive RECEIPT rows round-robin over (product, store), with a per-pair
  // running balance and a strictly increasing timestamp so history and balances are valid.
  type Balance = { productId: string; storeId: string; quantity: number };
  const balances = new Map<string, Balance>();
  const base = Date.UTC(2026, 0, 1);
  const movementData: Prisma.StockMovementCreateManyInput[] = [];
  const receipt: StockMovementType = 'RECEIPT';

  for (let i = 0; i < movementCount; i += 1) {
    const productId = productIds[i % productIds.length]!;
    const storeId = storeIds[i % storeIds.length]!;
    const k = `${productId}:${storeId}`;
    const before = balances.get(k)?.quantity ?? 0;
    const change = 1 + (i % 5); // 1..5, always positive so the balance never goes negative
    const after = before + change;
    balances.set(k, { productId, storeId, quantity: after });
    movementData.push({
      productId,
      storeId,
      quantityChange: change,
      balanceBefore: before,
      balanceAfter: after,
      type: receipt,
      sourceDocumentType: 'PERF_SEED',
      sourceDocumentId: `PERF-${String(i + 1).padStart(7, '0')}`,
      actorId: manager.id,
      createdAt: new Date(base + i * 1_000), // one second apart, strictly increasing
    });
  }
  for (let i = 0; i < movementData.length; i += BATCH) {
    await prisma.stockMovement.createMany({ data: movementData.slice(i, i + BATCH) });
  }

  // Current balances per (product, store) from the final running totals.
  const balanceData: Prisma.StockBalanceCreateManyInput[] = [...balances.values()].map(
    ({ productId, storeId, quantity }) => ({ productId, storeId, quantity }),
  );
  for (let i = 0; i < balanceData.length; i += BATCH) {
    await prisma.stockBalance.createMany({ data: balanceData.slice(i, i + BATCH) });
  }

  return {
    manager: {
      id: manager.id,
      email: manager.email,
      name: manager.name,
      role: manager.role,
      storeId: manager.storeId,
    },
    storeIds,
  };
}
