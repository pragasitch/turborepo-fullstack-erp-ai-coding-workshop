import { describe, expect, it } from 'vitest';
import {
  ConfirmSaleHeadersSchema,
  CreateSaleSchema,
  IdempotencyKeySchema,
  SaleSchema,
  UpdateSaleSchema,
} from './sales.js';

const line = { productId: 'p1', quantity: 2 };

describe('CreateSaleSchema (SAL-01)', () => {
  it('accepts lines of product and a positive whole-number quantity', () => {
    expect(CreateSaleSchema.safeParse({ lines: [line, { productId: 'p2', quantity: 1 }] }).success).toBe(
      true,
    );
  });

  it('rejects a price override: price is never supplied by the client', () => {
    expect(
      CreateSaleSchema.safeParse({ lines: [{ ...line, unitPrice: '1.00' }] }).success,
    ).toBe(false);
    expect(
      CreateSaleSchema.safeParse({ lines: [{ ...line, sellingPrice: '1.00' }] }).success,
    ).toBe(false);
    expect(CreateSaleSchema.safeParse({ lines: [line], total: '1.00' }).success).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the quantity %s', (quantity) => {
    expect(CreateSaleSchema.safeParse({ lines: [{ ...line, quantity }] }).success).toBe(false);
  });

  it('rejects a quantity sent as text', () => {
    expect(CreateSaleSchema.safeParse({ lines: [{ ...line, quantity: '2' }] }).success).toBe(false);
  });

  it('requires at least one line and a product on every line', () => {
    expect(CreateSaleSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(CreateSaleSchema.safeParse({ lines: [{ ...line, productId: '' }] }).success).toBe(false);
  });

  it('rejects the same product on two lines', () => {
    expect(CreateSaleSchema.safeParse({ lines: [line, { ...line, quantity: 3 }] }).success).toBe(
      false,
    );
  });
});

describe('UpdateSaleSchema (edit a draft)', () => {
  it('takes the sale id and the full set of lines, under the same rules', () => {
    expect(UpdateSaleSchema.safeParse({ id: 's1', lines: [line] }).success).toBe(true);
    expect(UpdateSaleSchema.safeParse({ id: 's1', lines: [{ ...line, quantity: 0 }] }).success).toBe(
      false,
    );
    expect(
      UpdateSaleSchema.safeParse({ id: 's1', lines: [{ ...line, unitPrice: '1.00' }] }).success,
    ).toBe(false);
  });
});

describe('IdempotencyKeySchema / ConfirmSaleHeadersSchema (SAL-03)', () => {
  it('accepts a UUID-like key', () => {
    expect(IdempotencyKeySchema.safeParse('3f2b8c1e-6a52-4b7e-9d0a-1c2d3e4f5a6b').success).toBe(
      true,
    );
  });

  it.each(['', 'short', 'has space in it', 'x'.repeat(129)])('rejects the key %j', (key) => {
    expect(IdempotencyKeySchema.safeParse(key).success).toBe(false);
  });

  it('reads the key from the Idempotency-Key header and requires it', () => {
    const key = 'sale-confirm-0001';
    expect(ConfirmSaleHeadersSchema.safeParse({ 'idempotency-key': key }).success).toBe(true);
    expect(ConfirmSaleHeadersSchema.safeParse({}).success).toBe(false);
  });
});

describe('SaleSchema', () => {
  const draft = {
    id: 's1',
    documentNumber: null,
    status: 'DRAFT',
    storeId: 'st1',
    storeCode: 'B01',
    createdById: 'u1',
    total: '155.00',
    confirmedAt: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    lines: [
      {
        id: 'l1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'น้ำดื่มแพ็ค 6',
        unit: 'แพ็ค',
        quantity: 2,
        unitPrice: '60.00',
        lineTotal: '120.00',
        balanceAfter: null,
      },
    ],
  };

  it('describes a draft and a confirmed sale', () => {
    expect(SaleSchema.safeParse(draft).success).toBe(true);
    expect(
      SaleSchema.safeParse({
        ...draft,
        status: 'CONFIRMED',
        documentNumber: 'SAL-000001',
        confirmedAt: '2026-01-02T01:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('keeps money as a two-decimal string', () => {
    expect(SaleSchema.safeParse({ ...draft, total: 155 }).success).toBe(false);
    expect(SaleSchema.safeParse({ ...draft, total: '155' }).success).toBe(false);
  });

  it('only knows the DRAFT and CONFIRMED statuses (no cancelled or returned)', () => {
    expect(SaleSchema.safeParse({ ...draft, status: 'CANCELLED' }).success).toBe(false);
    expect(SaleSchema.safeParse({ ...draft, status: 'RETURNED' }).success).toBe(false);
  });
});
