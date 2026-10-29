import type { InventoryList, InventoryListQuery, User } from '@erp/contracts';
import { Prisma } from '@erp/database';
import { assertStoreScope } from '../auth/store-scope.js';
import type { PrismaService } from '../database/prisma.service.js';

type StockLevelRow = {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  quantity: number;
  reorderThreshold: number | null;
  total: number;
};

/**
 * Which store a stock query is confined to. A store employee is always confined to their
 * own store (NFR-01): asking for another store, or having none assigned, is rejected
 * by the shared store-scope check. Other roles may search every store or pick one.
 *
 * Shared with the daily sales report (RPT-01) so the stock and sales screens enforce the
 * store scope identically.
 */
export function scopedStoreId(user: User, requested: string | undefined): string | undefined {
  if (user.role !== 'STORE_EMPLOYEE') return requested;
  const storeId = requested ?? user.storeId ?? '';
  assertStoreScope(user, storeId);
  return storeId;
}

/**
 * One page of (product, store) stock levels, shared by the stock search (INV-01) and the
 * stock reports (RPT-02) so the screen and the reports can never disagree on store
 * permission or on what low stock means. Every (product, store) pair is listed, so a
 * product with no stock record shows quantity 0 instead of disappearing.
 *
 * `lowStockOnly` keeps just the pairs whose balance is at or below the store's reorder
 * threshold; a pair with no threshold is never low.
 */
export async function listStockLevels(
  prisma: PrismaService,
  user: User,
  query: InventoryListQuery,
  options: { lowStockOnly?: boolean } = {},
): Promise<InventoryList> {
  const { page, pageSize, search } = query;
  const storeId = scopedStoreId(user, query.storeId);

  // Each text predicate references a single table so the trigram indexes (NFR-05) can serve
  // it: a cross-table OR over the Product x Store join is not sargable and forces a scan.
  // Semantics are unchanged — a (product, store) row matches when the product matches the
  // term or the store does.
  const searchFilter = search
    ? Prisma.sql`AND (
        p."id" IN (SELECT "id" FROM "Product" WHERE "sku" ILIKE ${`%${search}%`} OR "name" ILIKE ${`%${search}%`})
        OR s."id" IN (SELECT "id" FROM "Store" WHERE "code" ILIKE ${`%${search}%`} OR "name" ILIKE ${`%${search}%`})
      )`
    : Prisma.empty;
  const storeFilter = storeId ? Prisma.sql`AND s."id" = ${storeId}` : Prisma.empty;
  const lowStockFilter = options.lowStockOnly
    ? Prisma.sql`AND t."threshold" IS NOT NULL AND COALESCE(b."quantity", 0) <= t."threshold"`
    : Prisma.empty;

  // The balance row is the source of truth for the current quantity (INV-03); a
  // missing row means nothing has ever been posted, i.e. 0.
  const rows = await prisma.$queryRaw<StockLevelRow[]>(Prisma.sql`
    SELECT
      p."id" AS "productId",
      p."sku" AS "sku",
      p."name" AS "productName",
      p."unit" AS "unit",
      s."id" AS "storeId",
      s."code" AS "storeCode",
      s."name" AS "storeName",
      COALESCE(b."quantity", 0)::int AS "quantity",
      t."threshold"::int AS "reorderThreshold",
      (COUNT(*) OVER ())::int AS "total"
    FROM "Product" p
    CROSS JOIN "Store" s
    LEFT JOIN "StockBalance" b ON b."productId" = p."id" AND b."storeId" = s."id"
    LEFT JOIN "ProductReorderThreshold" t ON t."productId" = p."id" AND t."storeId" = s."id"
    WHERE TRUE ${searchFilter} ${storeFilter} ${lowStockFilter}
    ORDER BY p."sku" ASC, s."code" ASC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `);

  return {
    items: rows.map((row) => ({
      productId: row.productId,
      sku: row.sku,
      productName: row.productName,
      unit: row.unit,
      storeId: row.storeId,
      storeCode: row.storeCode,
      storeName: row.storeName,
      quantity: row.quantity,
      reorderThreshold: row.reorderThreshold,
      // Low stock is quantity <= threshold (INV-01); no threshold means never low.
      isLowStock: row.reorderThreshold !== null && row.quantity <= row.reorderThreshold,
    })),
    total: rows[0]?.total ?? 0,
    page,
    pageSize,
  };
}
