import { describe, expect, it } from 'vitest';
import {
  ConfirmGoodsReceiptHeadersSchema,
  ConfirmGoodsReceiptSchema,
  GoodsReceiptSchema,
  ReceivableOrderSchema,
} from './goods-receipts.js';

const line = { productId: 'p1', quantity: 8 };
const body = { purchaseOrderId: 'po1', lines: [line] };

describe('ConfirmGoodsReceiptSchema (GR-02)', () => {
  it('accepts an order and lines of product and a whole-number quantity', () => {
    expect(ConfirmGoodsReceiptSchema.safeParse(body).success).toBe(true);
    expect(
      ConfirmGoodsReceiptSchema.safeParse({
        purchaseOrderId: 'po1',
        lines: [line, { productId: 'p2', quantity: 0 }],
      }).success,
    ).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN])('rejects the quantity %s', (quantity) => {
    expect(
      ConfirmGoodsReceiptSchema.safeParse({ ...body, lines: [{ ...line, quantity }] }).success,
    ).toBe(false);
  });

  it('rejects a quantity sent as text', () => {
    expect(
      ConfirmGoodsReceiptSchema.safeParse({ ...body, lines: [{ ...line, quantity: '8' }] }).success,
    ).toBe(false);
  });

  it('needs at least one line greater than zero', () => {
    expect(ConfirmGoodsReceiptSchema.safeParse({ ...body, lines: [] }).success).toBe(false);
    expect(
      ConfirmGoodsReceiptSchema.safeParse({ ...body, lines: [{ ...line, quantity: 0 }] }).success,
    ).toBe(false);
    expect(
      ConfirmGoodsReceiptSchema.safeParse({
        ...body,
        lines: [
          { productId: 'p1', quantity: 0 },
          { productId: 'p2', quantity: 0 },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects the same product on two lines', () => {
    expect(
      ConfirmGoodsReceiptSchema.safeParse({ ...body, lines: [line, { ...line, quantity: 2 }] })
        .success,
    ).toBe(false);
  });

  it('names the order and a product on every line', () => {
    expect(ConfirmGoodsReceiptSchema.safeParse({ ...body, purchaseOrderId: '' }).success).toBe(
      false,
    );
    expect(
      ConfirmGoodsReceiptSchema.safeParse({ ...body, lines: [{ ...line, productId: '' }] }).success,
    ).toBe(false);
  });

  it('rejects fields the client may not set, such as a price or a status', () => {
    expect(
      ConfirmGoodsReceiptSchema.safeParse({ ...body, lines: [{ ...line, unitPrice: '1.00' }] })
        .success,
    ).toBe(false);
    expect(ConfirmGoodsReceiptSchema.safeParse({ ...body, status: 'COMPLETED' }).success).toBe(
      false,
    );
  });
});

describe('ConfirmGoodsReceiptHeadersSchema (GR-04)', () => {
  it('accepts a well-formed Idempotency-Key', () => {
    expect(
      ConfirmGoodsReceiptHeadersSchema.safeParse({ 'idempotency-key': 'receive-ac01-0001' })
        .success,
    ).toBe(true);
    expect(
      ConfirmGoodsReceiptHeadersSchema.safeParse({
        'idempotency-key': '0b9d6b34-8f0e-4a43-9c1e-2f5d1b6f0a11',
      }).success,
    ).toBe(true);
  });

  it('requires the key and rejects a malformed one', () => {
    expect(ConfirmGoodsReceiptHeadersSchema.safeParse({}).success).toBe(false);
    expect(ConfirmGoodsReceiptHeadersSchema.safeParse({ 'idempotency-key': 'short' }).success).toBe(
      false,
    );
    expect(
      ConfirmGoodsReceiptHeadersSchema.safeParse({ 'idempotency-key': 'has spaces in it' })
        .success,
    ).toBe(false);
  });
});

describe('GoodsReceiptSchema (viewing)', () => {
  const receipt = {
    id: 'gr1',
    documentNumber: 'GR-000001',
    purchaseOrderId: 'po1',
    purchaseOrderNumber: 'PO-DEMO-001',
    orderStatus: 'PARTIALLY_RECEIVED',
    storeId: 's1',
    storeCode: 'B01',
    receivedById: 'u1',
    confirmedAt: '2026-01-02T01:00:00.000Z',
    lines: [
      {
        id: 'l1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'น้ำดื่มแพ็ค 6',
        unit: 'แพ็ค',
        quantity: 8,
        balanceAfter: 18,
      },
    ],
  };

  it('describes a confirmed receipt with its number and the stock left in each line', () => {
    expect(GoodsReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it('allows an order without a document number', () => {
    expect(GoodsReceiptSchema.safeParse({ ...receipt, purchaseOrderNumber: null }).success).toBe(
      true,
    );
  });

  it('only describes statuses an order can have after a receipt', () => {
    expect(GoodsReceiptSchema.safeParse({ ...receipt, orderStatus: 'COMPLETED' }).success).toBe(
      true,
    );
    expect(GoodsReceiptSchema.safeParse({ ...receipt, orderStatus: 'DRAFT' }).success).toBe(false);
  });
});

describe('ReceivableOrderSchema (GR-01)', () => {
  it('shows ordered, previously received and outstanding quantities per line', () => {
    const result = ReceivableOrderSchema.safeParse({
      id: 'po1',
      documentNumber: 'PO-DEMO-001',
      status: 'APPROVED',
      supplierCode: 'SUP01',
      storeId: 's1',
      storeCode: 'B01',
      expectedReceiptDate: '2026-02-01',
      lines: [
        {
          productId: 'p1',
          sku: 'SKU001',
          productName: 'น้ำดื่มแพ็ค 6',
          unit: 'แพ็ค',
          isActive: true,
          ordered: 20,
          received: 8,
          outstanding: 12,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('is only for orders that can still be received', () => {
    const result = ReceivableOrderSchema.safeParse({
      id: 'po1',
      documentNumber: null,
      status: 'DRAFT',
      supplierCode: 'SUP01',
      storeId: 's1',
      storeCode: 'B01',
      expectedReceiptDate: '2026-02-01',
      lines: [],
    });
    expect(result.success).toBe(false);
  });
});
