import { oc } from '@orpc/contract';
import * as z from 'zod';
import { InventoryListQuerySchema, InventoryListSchema } from './inventory.js';

/**
 * Stock reports (RPT-02). Both reports list one row per (product, store) with the same
 * shape as the stock search (INV-01), filtered by store and a product search term, and
 * the same store permission applies: a Store employee only ever gets their own store.
 *
 * - Stock on hand: every (product, store) pair, zero-stock products included.
 * - Low stock: only the pairs whose balance is at or below the store's reorder
 *   threshold. A pair with no threshold is never low.
 */
export const StockReportQuerySchema = InventoryListQuerySchema;
export const StockReportSchema = InventoryListSchema;

/** Money with exactly two decimals, e.g. "465.00" (Section 6.1). */
const Money = z.string().regex(/^\d+\.\d{2}$/, 'จำนวนเงินต้องเป็นตัวเลขทศนิยมสองตำแหน่ง');

/** A calendar date with no time, e.g. "2026-01-31" (Asia/Bangkok reporting day). */
const CalendarDate = z.iso.date('วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD');

/**
 * Daily sales report query (RPT-01, Section 6.2). `from`/`to` are inclusive Asia/Bangkok
 * calendar days; the API windows confirmed sales by `confirmedAt` over
 * [from 00:00:00, to+1 day 00:00:00) in Asia/Bangkok. `storeId` is optional; a Store
 * employee is confined to their own store by the API regardless. Newest day first.
 */
const DailySalesRangeShape = {
  from: CalendarDate,
  to: CalendarDate,
  storeId: z.string().optional(),
};

/** The range must not end before it starts; shared by the screen and the CSV export. */
const rangeIsOrdered = (q: { from: string; to: string }) => q.from <= q.to;
const rangeOrderError = { message: 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น', path: ['to'] };

export const DailySalesReportQuerySchema = z
  .object({
    ...DailySalesRangeShape,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(rangeIsOrdered, rangeOrderError);
export type DailySalesReportQuery = z.infer<typeof DailySalesReportQuerySchema>;

/** One reporting day's confirmed-sales totals (RPT-01). */
export const DailySalesRowSchema = z.object({
  /** The Asia/Bangkok calendar day, "YYYY-MM-DD". */
  date: z.iso.date(),
  documentCount: z.number().int().min(0),
  unitsSold: z.number().int().min(0),
  totalAmount: Money,
});
export type DailySalesRow = z.infer<typeof DailySalesRowSchema>;

export const DailySalesReportSchema = z.object({
  items: z.array(DailySalesRowSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type DailySalesReport = z.infer<typeof DailySalesReportSchema>;

/**
 * CSV export (RPT-04). Each export takes exactly the filters of its on-screen report and
 * none of the pagination: it returns every matching row. The API applies the same role and
 * store permission as the screen. The response is a `text/csv` file, UTF-8 with a BOM so
 * spreadsheet software renders Thai text, and any cell a spreadsheet could read as a
 * formula (starting with `=`, `+`, `-`, `@`, tab or carriage return) is neutralized.
 */
export const DailySalesExportQuerySchema = z.object(DailySalesRangeShape).refine(rangeIsOrdered, rangeOrderError);
export type DailySalesExportQuery = z.infer<typeof DailySalesExportQuerySchema>;

export const StockReportExportQuerySchema = StockReportQuerySchema.omit({
  page: true,
  pageSize: true,
});
export type StockReportExportQuery = z.infer<typeof StockReportExportQuerySchema>;

export const CsvFileSchema = z.file();

export const reportsContract = {
  stockOnHand: oc
    .route({
      method: 'GET',
      path: '/reports/stock-on-hand',
      summary: 'Stock-on-hand report by store, with product search',
      tags: ['Reports'],
    })
    .input(StockReportQuerySchema)
    .output(StockReportSchema),
  lowStock: oc
    .route({
      method: 'GET',
      path: '/reports/low-stock',
      summary: 'Low-stock report by store: balance at or below the reorder threshold',
      tags: ['Reports'],
    })
    .input(StockReportQuerySchema)
    .output(StockReportSchema),
  dailySales: oc
    .route({
      method: 'GET',
      path: '/reports/daily-sales',
      summary: 'Daily sales report by date range and store (Asia/Bangkok days)',
      tags: ['Reports'],
    })
    .input(DailySalesReportQuerySchema)
    .output(DailySalesReportSchema),
  exportDailySales: oc
    .route({
      method: 'GET',
      path: '/reports/daily-sales/export',
      summary: 'Daily sales report as a CSV file (UTF-8 with BOM), same filters as the screen',
      tags: ['Reports'],
    })
    .input(DailySalesExportQuerySchema)
    .output(CsvFileSchema),
  exportStockOnHand: oc
    .route({
      method: 'GET',
      path: '/reports/stock-on-hand/export',
      summary: 'Stock-on-hand report as a CSV file (UTF-8 with BOM), same filters as the screen',
      tags: ['Reports'],
    })
    .input(StockReportExportQuerySchema)
    .output(CsvFileSchema),
  exportLowStock: oc
    .route({
      method: 'GET',
      path: '/reports/low-stock/export',
      summary: 'Low-stock report as a CSV file (UTF-8 with BOM), same filters as the screen',
      tags: ['Reports'],
    })
    .input(StockReportExportQuerySchema)
    .output(CsvFileSchema),
};
