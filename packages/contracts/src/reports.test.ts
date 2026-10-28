import { describe, expect, it } from 'vitest';
import { contract } from './index.js';
import { StockReportQuerySchema, StockReportSchema } from './reports.js';

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
