import { Controller } from '@nestjs/common';
import { contract, type StockReportExportQuery, type User } from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { listStockLevels } from '../inventory/stock-levels.js';
import { csvFile } from './csv.js';
import { dailySalesReport } from './daily-sales-report.js';

/** Rows fetched per query while exporting; the contract caps a page at 100. */
const EXPORT_PAGE_SIZE = 100;

/** Every page of a paged report, fetched with the report's own query. */
async function allPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page += 1) {
    const { items, total } = await fetchPage(page);
    rows.push(...items);
    if (items.length === 0 || rows.length >= total) return rows;
  }
}

const STOCK_HEADER = [
  'รหัสสินค้า',
  'ชื่อสินค้า',
  'หน่วย',
  'รหัสสาขา',
  'ชื่อสาขา',
  'คงเหลือ',
  'จุดสั่งซื้อ',
  'สต็อกต่ำ',
];

/**
 * Stock reports (RPT-02). Any signed-in role may read them, with the same store
 * permission as the stock screen: store employees only for their assigned store,
 * enforced by the stock query both share.
 */
@Controller()
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  /** The stock report as CSV: the screen's rows, filters and store permission, all pages. */
  private async stockCsv(
    user: User,
    filters: StockReportExportQuery,
    name: string,
    options: { lowStockOnly?: boolean },
  ) {
    const rows = await allPages((page) =>
      listStockLevels(this.prisma, user, { ...filters, page, pageSize: EXPORT_PAGE_SIZE }, options),
    );
    return csvFile(
      name,
      STOCK_HEADER,
      rows.map((row) => [
        row.sku,
        row.productName,
        row.unit,
        row.storeCode,
        row.storeName,
        row.quantity,
        row.reorderThreshold,
        row.isLowStock ? 'ใช่' : 'ไม่ใช่',
      ]),
    );
  }

  /** Every (product, store) pair, zero-stock products included. */
  @Implement(contract.reports.stockOnHand)
  stockOnHand(@CurrentUser() user: User) {
    return implement(contract.reports.stockOnHand).handler(({ input }) =>
      listStockLevels(this.prisma, user, input),
    );
  }

  /** Only the pairs whose balance is at or below the store's reorder threshold. */
  @Implement(contract.reports.lowStock)
  lowStock(@CurrentUser() user: User) {
    return implement(contract.reports.lowStock).handler(({ input }) =>
      listStockLevels(this.prisma, user, input, { lowStockOnly: true }),
    );
  }

  /**
   * Daily sales report (RPT-01): confirmed sales per Asia/Bangkok day in the range, with
   * the same store permission as the sales screen — store employees, managers and
   * administrators only (@Roles), and store employees see only their own store (the
   * query's store-scope check). A purchasing officer may not read sales data.
   */
  @Roles('STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR')
  @Implement(contract.reports.dailySales)
  dailySales(@CurrentUser() user: User) {
    return implement(contract.reports.dailySales).handler(({ input }) =>
      dailySalesReport(this.prisma, user, input),
    );
  }

  /** Stock-on-hand report as CSV (RPT-04). */
  @Implement(contract.reports.exportStockOnHand)
  exportStockOnHand(@CurrentUser() user: User) {
    return implement(contract.reports.exportStockOnHand).handler(({ input }) =>
      this.stockCsv(user, input, 'stock-on-hand.csv', {}),
    );
  }

  /** Low-stock report as CSV (RPT-04). */
  @Implement(contract.reports.exportLowStock)
  exportLowStock(@CurrentUser() user: User) {
    return implement(contract.reports.exportLowStock).handler(({ input }) =>
      this.stockCsv(user, input, 'low-stock.csv', { lowStockOnly: true }),
    );
  }

  /**
   * Daily sales report as CSV (RPT-04): the screen's rows, filters, roles and store
   * permission, over the whole date range instead of one page.
   */
  @Roles('STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR')
  @Implement(contract.reports.exportDailySales)
  exportDailySales(@CurrentUser() user: User) {
    return implement(contract.reports.exportDailySales).handler(async ({ input }) => {
      const rows = await allPages((page) =>
        dailySalesReport(this.prisma, user, { ...input, page, pageSize: EXPORT_PAGE_SIZE }),
      );
      return csvFile(
        `daily-sales_${input.from}_${input.to}.csv`,
        ['วันที่', 'จำนวนใบขาย', 'จำนวนหน่วย', 'ยอดขาย (บาท)'],
        rows.map((row) => [row.date, row.documentCount, row.unitsSold, row.totalAmount]),
      );
    });
  }
}
