import { describe, expect, it } from 'vitest';
import { contract } from './index.js';
import {
  DailySalesReportQuerySchema,
  DailySalesReportSchema,
  StockReportQuerySchema,
  StockReportSchema,
} from './reports.js';

const row = {
  productId: 'p3',
  sku: 'SKU003',
  productName: 'น้ำยาซักผ้า',
  unit: 'ถุง',
  storeId: 's1',
  storeCode: 'B01',
  storeName: 'สาขาเซ็นทรัล',
  quantity: 0,
  reorderThreshold: 3,
  isLowStock: true,
};

describe('StockReportQuerySchema (RPT-02)', () => {
  it('defaults to page 1 with 20 rows and no filters', () => {
    expect(StockReportQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('accepts a product search and a store filter, trimming the search', () => {
    expect(StockReportQuerySchema.parse({ search: ' SKU003 ', storeId: 's1' })).toMatchObject({
      search: 'SKU003',
      storeId: 's1',
    });
  });

  it('rejects a page below 1 and a pageSize above 100', () => {
    expect(StockReportQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(StockReportQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });
});

describe('StockReportSchema (RPT-02)', () => {
  it('accepts a page that holds a zero-stock row', () => {
    const page = { items: [row], total: 1, page: 1, pageSize: 20 };
    expect(StockReportSchema.safeParse(page).success).toBe(true);
  });

  it('rejects a row with a negative balance', () => {
    const page = { items: [{ ...row, quantity: -1 }], total: 1, page: 1, pageSize: 20 };
    expect(StockReportSchema.safeParse(page).success).toBe(false);
  });
});

describe('reports contract (RPT-02)', () => {
  it('exposes a stock-on-hand and a low-stock route under /reports', () => {
    expect(contract.reports.stockOnHand['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/reports/stock-on-hand',
    });
    expect(contract.reports.lowStock['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/reports/low-stock',
    });
  });
});

describe('DailySalesReportQuerySchema (RPT-01, Section 6.2)', () => {
  const base = { from: '2026-01-01', to: '2026-01-31' };

  it('requires a from and to date and defaults the pagination', () => {
    expect(DailySalesReportQuerySchema.parse(base)).toMatchObject({
      from: '2026-01-01',
      to: '2026-01-31',
      page: 1,
      pageSize: 20,
    });
  });

  it('accepts an optional store filter', () => {
    expect(DailySalesReportQuerySchema.parse({ ...base, storeId: 's1' })).toMatchObject({
      storeId: 's1',
    });
  });

  it('rejects a missing from or to', () => {
    expect(DailySalesReportQuerySchema.safeParse({ to: '2026-01-31' }).success).toBe(false);
    expect(DailySalesReportQuerySchema.safeParse({ from: '2026-01-01' }).success).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(DailySalesReportQuerySchema.safeParse({ from: '01/01/2026', to: '2026-01-31' }).success).toBe(
      false,
    );
    expect(DailySalesReportQuerySchema.safeParse({ ...base, from: 'not-a-date' }).success).toBe(false);
  });

  it('rejects a range whose end is before its start', () => {
    expect(
      DailySalesReportQuerySchema.safeParse({ from: '2026-01-31', to: '2026-01-01' }).success,
    ).toBe(false);
  });

  it('rejects a page below 1 and a pageSize above 100', () => {
    expect(DailySalesReportQuerySchema.safeParse({ ...base, page: 0 }).success).toBe(false);
    expect(DailySalesReportQuerySchema.safeParse({ ...base, pageSize: 101 }).success).toBe(false);
  });
});

describe('DailySalesReportSchema (RPT-01)', () => {
  const dayRow = {
    date: '2026-01-02',
    documentCount: 3,
    unitsSold: 7,
    totalAmount: '465.00',
  };
  const payload = { items: [dayRow], total: 1, page: 1, pageSize: 20 };

  it('accepts a page of per-day totals', () => {
    expect(DailySalesReportSchema.safeParse(payload).success).toBe(true);
  });

  it('accepts an empty page with zero items', () => {
    expect(
      DailySalesReportSchema.safeParse({ items: [], total: 0, page: 1, pageSize: 20 }).success,
    ).toBe(true);
  });

  it('keeps the total amount as a two-decimal string', () => {
    expect(DailySalesReportSchema.safeParse({ ...payload, items: [{ ...dayRow, totalAmount: 465 }] }).success).toBe(
      false,
    );
    expect(
      DailySalesReportSchema.safeParse({ ...payload, items: [{ ...dayRow, totalAmount: '465' }] })
        .success,
    ).toBe(false);
  });

  it('rejects negative counts', () => {
    expect(
      DailySalesReportSchema.safeParse({ ...payload, items: [{ ...dayRow, documentCount: -1 }] })
        .success,
    ).toBe(false);
  });
});

describe('daily sales report route (RPT-01)', () => {
  it('exposes a daily-sales route under /reports', () => {
    expect(contract.reports.dailySales['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/reports/daily-sales',
    });
  });
});
