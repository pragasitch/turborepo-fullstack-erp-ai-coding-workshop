import { describe, expect, it } from 'vitest';
import { contract } from './index.js';
import {
  CsvFileSchema,
  DailySalesExportQuerySchema,
  DailySalesReportQuerySchema,
  DailySalesReportSchema,
  MovementHistoryQuerySchema,
  MovementHistoryReportSchema,
  MovementHistoryRowSchema,
  StockReportExportQuerySchema,
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
    expect(
      DailySalesReportQuerySchema.safeParse({ from: '01/01/2026', to: '2026-01-31' }).success,
    ).toBe(false);
    expect(DailySalesReportQuerySchema.safeParse({ ...base, from: 'not-a-date' }).success).toBe(
      false,
    );
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
    expect(
      DailySalesReportSchema.safeParse({ ...payload, items: [{ ...dayRow, totalAmount: 465 }] })
        .success,
    ).toBe(false);
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

describe('DailySalesExportQuerySchema (RPT-04)', () => {
  const base = { from: '2026-01-01', to: '2026-01-31' };

  it('takes the same filters as the on-screen report, with no pagination', () => {
    expect(DailySalesExportQuerySchema.parse({ ...base, storeId: 's1' })).toEqual({
      ...base,
      storeId: 's1',
    });
  });

  it('rejects a missing, malformed or reversed date range like the screen does', () => {
    expect(DailySalesExportQuerySchema.safeParse({ to: '2026-01-31' }).success).toBe(false);
    expect(DailySalesExportQuerySchema.safeParse({ ...base, from: '01/01/2026' }).success).toBe(
      false,
    );
    expect(
      DailySalesExportQuerySchema.safeParse({ from: '2026-01-31', to: '2026-01-01' }).success,
    ).toBe(false);
  });
});

describe('StockReportExportQuerySchema (RPT-04)', () => {
  it('takes the product search and store filter, with no pagination', () => {
    expect(StockReportExportQuerySchema.parse({ search: ' SKU003 ', storeId: 's1' })).toEqual({
      search: 'SKU003',
      storeId: 's1',
    });
    expect(StockReportExportQuerySchema.parse({})).toEqual({});
  });
});

describe('CsvFileSchema (RPT-04)', () => {
  it('accepts a file and rejects plain text', () => {
    const file = new File(['a,b'], 'report.csv', { type: 'text/csv; charset=utf-8' });
    expect(CsvFileSchema.safeParse(file).success).toBe(true);
    expect(CsvFileSchema.safeParse('a,b').success).toBe(false);
  });
});

describe('CSV export routes (RPT-04)', () => {
  it.each([
    ['exportDailySales', '/reports/daily-sales/export'],
    ['exportStockOnHand', '/reports/stock-on-hand/export'],
    ['exportLowStock', '/reports/low-stock/export'],
  ] as const)('exposes %s as GET %s', (route, path) => {
    expect(contract.reports[route]['~orpc'].route).toMatchObject({ method: 'GET', path });
  });
});

describe('MovementHistoryQuerySchema (RPT-03)', () => {
  it('defaults to page 1 with 20 rows and no filters', () => {
    expect(MovementHistoryQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('accepts product, store, type and an inclusive date range', () => {
    expect(
      MovementHistoryQuerySchema.parse({
        productId: 'p1',
        storeId: 's1',
        type: 'SALE',
        from: '2026-01-01',
        to: '2026-01-31',
      }),
    ).toMatchObject({
      productId: 'p1',
      storeId: 's1',
      type: 'SALE',
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });

  it('accepts each movement type and rejects an unknown one', () => {
    for (const type of ['RECEIPT', 'SALE', 'ADJUSTMENT'] as const) {
      expect(MovementHistoryQuerySchema.safeParse({ type }).success).toBe(true);
    }
    expect(MovementHistoryQuerySchema.safeParse({ type: 'TRANSFER' }).success).toBe(false);
  });

  it('rejects a reversed date range', () => {
    expect(
      MovementHistoryQuerySchema.safeParse({ from: '2026-01-31', to: '2026-01-01' }).success,
    ).toBe(false);
  });

  it('rejects a page below 1 and a pageSize above 100', () => {
    expect(MovementHistoryQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(MovementHistoryQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });
});

describe('MovementHistoryRowSchema (RPT-03)', () => {
  const row = {
    id: 'm1',
    productId: 'p1',
    sku: 'SKU001',
    productName: 'น้ำดื่ม',
    unit: 'ขวด',
    storeId: 's1',
    storeCode: 'B01',
    storeName: 'สาขาเซ็นทรัล',
    type: 'SALE',
    quantityChange: -2,
    balanceBefore: 10,
    balanceAfter: 8,
    sourceDocumentType: 'SALE',
    sourceDocumentId: 'SAL-000001',
    actorId: 'u1',
    actorName: 'พนักงาน',
    createdAt: '2026-01-02T03:04:05.000Z',
  };

  it('accepts a movement row with its source document and actor', () => {
    expect(MovementHistoryRowSchema.safeParse(row).success).toBe(true);
  });

  it('keeps createdAt as an ISO datetime', () => {
    expect(MovementHistoryRowSchema.safeParse({ ...row, createdAt: 'not-a-date' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown movement type', () => {
    expect(MovementHistoryRowSchema.safeParse({ ...row, type: 'TRANSFER' }).success).toBe(false);
  });
});

describe('MovementHistoryReportSchema (RPT-03)', () => {
  const row = {
    id: 'm1',
    productId: 'p1',
    sku: 'SKU001',
    productName: 'น้ำดื่ม',
    unit: 'ขวด',
    storeId: 's1',
    storeCode: 'B01',
    storeName: 'สาขาเซ็นทรัล',
    type: 'RECEIPT',
    quantityChange: 5,
    balanceBefore: 0,
    balanceAfter: 5,
    sourceDocumentType: 'GOODS_RECEIPT',
    sourceDocumentId: 'GR-000001',
    actorId: 'u1',
    actorName: 'พนักงาน',
    createdAt: '2026-01-02T03:04:05.000Z',
  };

  it('accepts a page of movement rows', () => {
    expect(
      MovementHistoryReportSchema.safeParse({ items: [row], total: 1, page: 1, pageSize: 20 })
        .success,
    ).toBe(true);
  });

  it('accepts an empty page', () => {
    expect(
      MovementHistoryReportSchema.safeParse({ items: [], total: 0, page: 1, pageSize: 20 }).success,
    ).toBe(true);
  });
});

describe('movement history route (RPT-03)', () => {
  it('exposes a movement-history route under /reports', () => {
    expect(contract.reports.movementHistory['~orpc'].route).toMatchObject({
      method: 'GET',
      path: '/reports/movement-history',
    });
  });
});
