import type { DailySalesReport, DailySalesReportQuery, User } from '@erp/contracts';
import { Decimal, Prisma, type PrismaClient } from '@erp/database';
import { assertStoreScope } from '../auth/store-scope.js';

const BANGKOK_TZ = 'Asia/Bangkok';

/**
 * Which store the report is confined to. A store employee is always confined to their own
 * store (NFR-01): asking for another store, or having none assigned, is rejected by the
 * shared store-scope check. Other roles may span every store or pick one.
 */
function scopedStoreId(user: User, requested: string | undefined): string | undefined {
  if (user.role !== 'STORE_EMPLOYEE') return requested;
  const storeId = requested ?? user.storeId ?? '';
  assertStoreScope(user, storeId);
  return storeId;
}

/**
 * The daily sales report (RPT-01, Section 6.2). One row per Asia/Bangkok calendar day in
 * [from, to], counting only CONFIRMED sales by their `confirmedAt` instant (stored in UTC).
 *
 * Postgres does the day bucketing: `confirmedAt AT TIME ZONE 'Asia/Bangkok'` converts the
 * stored UTC instant to Bangkok wall-clock time, and `::date` takes its calendar day, so a
 * sale confirmed at 23:59 Bangkok lands on that day and one at 00:00 the next lands on the
 * next — the day boundary the ticket demands, with no manual offset arithmetic.
 *
 * The window is half-open [from 00:00:00, (to + 1 day) 00:00:00) in Bangkok. `storeId`
 * filters to one store; a Store employee is confined to their own store regardless of the
 * filter (NFR-01). Rows are newest-day-first and paginated.
 */
export async function dailySalesReport(
  prisma: PrismaClient,
  user: User,
  query: DailySalesReportQuery,
): Promise<DailySalesReport> {
  const { from, to, page, pageSize } = query;

  // A store employee is always confined to their own store (NFR-01): asking for another
  // store, or having none assigned, is rejected; other roles may span all or pick one.
  const storeId = scopedStoreId(user, query.storeId);

  const storeFilter = storeId ? Prisma.sql`AND s."storeId" = ${storeId}` : Prisma.empty;

  // `confirmedAt` is `timestamp` holding a UTC instant, so first interpret it as UTC
  // (`AT TIME ZONE 'UTC'` → timestamptz) and then convert to Bangkok wall-clock
  // (`AT TIME ZONE 'Asia/Bangkok'`); `::date` is then the Bangkok calendar day.
  const bangkokDay = Prisma.sql`((s."confirmedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${BANGKOK_TZ})::date`;

  // Bucket each confirmed sale into its Bangkok calendar day, then aggregate per day.
  const rows = await prisma.$queryRaw<
    { day: Date; documentCount: bigint; unitsSold: bigint | null; totalAmount: Decimal }[]
  >(Prisma.sql`
    SELECT
      ${bangkokDay} AS day,
      COUNT(DISTINCT s."id") AS "documentCount",
      COALESCE(SUM(l."quantity"), 0) AS "unitsSold",
      COALESCE(SUM(l."lineTotal"), 0) AS "totalAmount"
    FROM "Sale" s
    JOIN "SaleLine" l ON l."saleId" = s."id"
    WHERE s."status" = 'CONFIRMED'
      AND s."confirmedAt" IS NOT NULL
      AND ${bangkokDay} >= ${from}::date
      AND ${bangkokDay} <= ${to}::date
      ${storeFilter}
    GROUP BY day
    ORDER BY day DESC
    OFFSET ${(page - 1) * pageSize}
    LIMIT ${pageSize}
  `);

  const totalRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS count FROM (
      SELECT ${bangkokDay} AS day
      FROM "Sale" s
      WHERE s."status" = 'CONFIRMED'
        AND s."confirmedAt" IS NOT NULL
        AND ${bangkokDay} >= ${from}::date
        AND ${bangkokDay} <= ${to}::date
        ${storeFilter}
      GROUP BY day
    ) days
  `);

  const items = rows.map((row) => ({
    date: toDateOnly(row.day),
    documentCount: Number(row.documentCount),
    unitsSold: Number(row.unitsSold ?? 0),
    totalAmount: new Decimal(row.totalAmount).toFixed(2),
  }));

  return { items, total: Number(totalRows[0]?.count ?? 0), page, pageSize };
}

/** Postgres returns `::date` as a Date at UTC midnight; take its calendar part. */
function toDateOnly(day: Date): string {
  return day.toISOString().slice(0, 10);
}
