import { describe, expect, it } from 'vitest';
import {
  CreatePurchaseOrderSchema,
  PurchaseOrderSchema,
  UpdatePurchaseOrderSchema,
} from './purchase-orders.js';

const line = { productId: 'p1', quantity: 2, unitPrice: '10.00' };
const base = {
  supplierId: 'sup1',
  storeId: 'st1',
  expectedReceiptDate: '2026-02-01',
  lines: [line],
};

describe('CreatePurchaseOrderSchema (PO-01)', () => {
  it('accepts a supplier, destination store, expected date and at least one valid line', () => {
    expect(CreatePurchaseOrderSchema.safeParse(base).success).toBe(true);
    expect(
      CreatePurchaseOrderSchema.safeParse({
        ...base,
        lines: [line, { productId: 'p2', quantity: 1, unitPrice: '0.00' }],
      }).success,
    ).toBe(true);
  });

  it('requires a supplier, a destination store and an expected receipt date', () => {
    expect(CreatePurchaseOrderSchema.safeParse({ ...base, supplierId: '' }).success).toBe(false);
    expect(CreatePurchaseOrderSchema.safeParse({ ...base, storeId: '' }).success).toBe(false);
    const { expectedReceiptDate: _d, ...noDate } = base;
    expect(CreatePurchaseOrderSchema.safeParse(noDate).success).toBe(false);
  });

  it('rejects a malformed expected receipt date', () => {
    expect(
      CreatePurchaseOrderSchema.safeParse({ ...base, expectedReceiptDate: '01/02/2026' }).success,
    ).toBe(false);
    expect(
      CreatePurchaseOrderSchema.safeParse({ ...base, expectedReceiptDate: 'not-a-date' }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the ordered quantity %s', (quantity) => {
    expect(
      CreatePurchaseOrderSchema.safeParse({ ...base, lines: [{ ...line, quantity }] }).success,
    ).toBe(false);
  });

  it('rejects a quantity sent as text', () => {
    expect(
      CreatePurchaseOrderSchema.safeParse({ ...base, lines: [{ ...line, quantity: '2' }] }).success,
    ).toBe(false);
  });

  it.each(['-1.00', '10', '10.5', '10.555', 'free'])('rejects the unit price %j', (unitPrice) => {
    expect(
      CreatePurchaseOrderSchema.safeParse({ ...base, lines: [{ ...line, unitPrice }] }).success,
    ).toBe(false);
  });

  it('accepts a zero unit price but rejects a negative one', () => {
    expect(
      CreatePurchaseOrderSchema.safeParse({ ...base, lines: [{ ...line, unitPrice: '0.00' }] })
        .success,
    ).toBe(true);
  });

  it('requires at least one line and a product on every line', () => {
    expect(CreatePurchaseOrderSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(
      CreatePurchaseOrderSchema.safeParse({ ...base, lines: [{ ...line, productId: '' }] }).success,
    ).toBe(false);
  });

  it('rejects the same product on two lines (no duplicate SKUs)', () => {
    expect(
      CreatePurchaseOrderSchema.safeParse({
        ...base,
        lines: [line, { ...line, quantity: 3 }],
      }).success,
    ).toBe(false);
  });
});

describe('UpdatePurchaseOrderSchema (edit a draft)', () => {
  it('takes the order id and the full header and lines, under the same rules', () => {
    expect(UpdatePurchaseOrderSchema.safeParse({ id: 'po1', ...base }).success).toBe(true);
    expect(
      UpdatePurchaseOrderSchema.safeParse({ id: 'po1', ...base, lines: [] }).success,
    ).toBe(false);
    expect(
      UpdatePurchaseOrderSchema.safeParse({
        id: 'po1',
        ...base,
        lines: [{ ...line, quantity: 0 }],
      }).success,
    ).toBe(false);
  });

  it('requires the id', () => {
    expect(UpdatePurchaseOrderSchema.safeParse({ ...base }).success).toBe(false);
  });
});

describe('PurchaseOrderSchema', () => {
  const draft = {
    id: 'po1',
    documentNumber: null,
    status: 'DRAFT',
    supplierId: 'sup1',
    supplierCode: 'SUP01',
    storeId: 'st1',
    storeCode: 'B01',
    createdById: 'u1',
    expectedReceiptDate: '2026-02-01',
    total: '20.00',
    createdAt: '2026-01-02T00:00:00.000Z',
    lines: [
      {
        id: 'l1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'น้ำดื่มแพ็ค 6',
        unit: 'แพ็ค',
        quantity: 2,
        unitPrice: '10.00',
        lineTotal: '20.00',
      },
    ],
  };

  it('describes a draft purchase order', () => {
    expect(PurchaseOrderSchema.safeParse(draft).success).toBe(true);
  });

  it('keeps money as a two-decimal string', () => {
    expect(PurchaseOrderSchema.safeParse({ ...draft, total: 20 }).success).toBe(false);
    expect(PurchaseOrderSchema.safeParse({ ...draft, total: '20' }).success).toBe(false);
  });

  it('only knows the DRAFT status in this release', () => {
    expect(PurchaseOrderSchema.safeParse({ ...draft, status: 'APPROVED' }).success).toBe(false);
  });
});
