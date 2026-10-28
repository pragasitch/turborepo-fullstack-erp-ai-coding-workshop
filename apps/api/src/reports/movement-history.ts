import type { MovementHistoryQuery, MovementHistoryReport, User } from '@erp/contracts';
import { Prisma, type PrismaClient } from '@erp/database';
import { scopedStoreId } from '../inventory/stock-levels.js';

type MovementRow = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  type: MovementHistoryReport['items'][number]['type'];
  quantityChange: number;
  balanceBefore: number;
  balanceAfter: number;
  sourceDocumentType: string;
  sourceDocumentId: string;
  actorId: string;
  actorName: string;
  createdAt: Date;
  total: number;
};

/**
 * Stock movement history (RPT-03). Reads the append-only ledger (INV-02) joined to its
 * product, store and actor, filtered by any of product, store, movement type and an
 * inclusive Asia/Bangkok calendar date range. Each row carries its source document so the
 * screen can point at the receipt, sale or adjustment that caused the movement.
 *
 * A Store employee is confined to their own store (NFR-01) by the shared `scopedStoreId`
 * check: asking for another store, or having none assigned, is rejected before any query.
 * Rows are newest-first and paginated, with the full filtered count returned as `total`.
 */
export async function movementHistory(
  prisma: PrismaClient,
  user: User,
  query: MovementHistoryQuery,
): Promise<MovementHistoryReport> {
  const { page, pageSize, productId, type, from, to } = query;
  const storeId = scopedStoreId(user, query.storeId);

  const productFilter = productId ? Prisma.sql`AND m."productId" = ${productId}` : Prisma.empty;
  const storeFilter = storeId ? Prisma.sql`AND m."storeId" = ${storeId}` : Prisma.empty;
  const typeFilter = type ? Prisma.sql`AND m."type" = ${type}::"StockMovementType"` : Prisma.empty;
  // `createdAt` is a UTC instant; bucket by its Asia/Bangkok calendar day for the range.
  const bangkokDay = Prisma.sql`((m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date`;
  const fromFilter = from ? Prisma.sql`AND ${bangkokDay} >= ${from}::date` : Prisma.empty;
  const toFilter = to ? Prisma.sql`AND ${bangkokDay} <= ${to}::date` : Prisma.empty;

  const rows = await prisma.$queryRaw<MovementRow[]>(Prisma.sql`
    SELECT
      m."id" AS "id",
      p."id" AS "productId",
      p."sku" AS "sku",
      p."name" AS "productName",
      p."unit" AS "unit",
      s."id" AS "storeId",
      s."code" AS "storeCode",
      s."name" AS "storeName",
      m."type" AS "type",
      m."quantityChange"::int AS "quantityChange",
      m."balanceBefore"::int AS "balanceBefore",
      m."balanceAfter"::int AS "balanceAfter",
      m."sourceDocumentType" AS "sourceDocumentType",
      m."sourceDocumentId" AS "sourceDocumentId",
      u."id" AS "actorId",
      u."name" AS "actorName",
      m."createdAt" AS "createdAt",
      (COUNT(*) OVER ())::int AS "total"
    FROM "StockMovement" m
    JOIN "Product" p ON p."id" = m."productId"
    JOIN "Store" s ON s."id" = m."storeId"
    JOIN "User" u ON u."id" = m."actorId"
    WHERE TRUE ${productFilter} ${storeFilter} ${typeFilter} ${fromFilter} ${toFilter}
    ORDER BY m."createdAt" DESC, m."id" DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `);

  return {
    items: rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      sku: row.sku,
      productName: row.productName,
      unit: row.unit,
      storeId: row.storeId,
      storeCode: row.storeCode,
      storeName: row.storeName,
      type: row.type,
      quantityChange: row.quantityChange,
      balanceBefore: row.balanceBefore,
      balanceAfter: row.balanceAfter,
      sourceDocumentType: row.sourceDocumentType,
      sourceDocumentId: row.sourceDocumentId,
      actorId: row.actorId,
      actorName: row.actorName,
      createdAt: row.createdAt.toISOString(),
    })),
    total: rows[0]?.total ?? 0,
    page,
    pageSize,
  };
}
