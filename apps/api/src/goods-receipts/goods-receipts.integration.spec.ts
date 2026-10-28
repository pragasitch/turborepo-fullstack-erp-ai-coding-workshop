import type { User } from '@erp/contracts';
import { ORPCError } from '@orpc/nest';
import { describe, expect, it } from 'vitest';
import { useSection81Fixture } from '../../test/integration/harness.js';
import { confirmGoodsReceipt } from './goods-receipts.js';

const db = useSection81Fixture();

async function actor(email = 'staff_b01@erp.local'): Promise<User> {
  const row = await db.user(email);
  return { id: row.id, email: row.email, name: row.name, role: row.role, storeId: row.storeId };
}

async function demoOrder() {
  return db.prisma.purchaseOrder.findUniqueOrThrow({
    where: { documentNumber: 'PO-DEMO-001' },
  });
}

/** Receive `quantity` of SKU001 against PO-DEMO-001 as staff_b01 (or `who`). */
async function receive(quantity: number, key: string, who?: User) {
  const [user, order, sku001] = await Promise.all([
    who ?? actor(),
    demoOrder(),
    db.product('SKU001'),
  ]);
  return confirmGoodsReceipt(
    db.prisma,
    user,
    { purchaseOrderId: order.id, lines: [{ productId: sku001.id, quantity }] },
    key,
  );
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ORPCError);
  return error as ORPCError<string, Record<string, unknown>>;
}

async function receivedTotal() {
  const sum = await db.prisma.goodsReceiptLine.aggregate({ _sum: { quantity: true } });
  return sum._sum.quantity ?? 0;
}

describe('the Section 8.1 fixture', () => {
  it('has PO-DEMO-001: Approved for B01, 20 x SKU001 at 45.00', async () => {
    const order = await db.prisma.purchaseOrder.findUniqueOrThrow({
      where: { documentNumber: 'PO-DEMO-001' },
      include: { lines: true, store: true, supplier: true },
    });

    expect(order).toMatchObject({ status: 'APPROVED', store: { code: 'B01' } });
    expect(order.supplier.code).toBe('SUP01');
    expect(order.total.toFixed(2)).toBe('900.00');
    expect(order.lines.map((l) => [l.sku, l.quantity, l.unitPrice.toFixed(2)])).toEqual([
      ['SKU001', 20, '45.00'],
    ]);
  });
});

describe('receiving goods (GR-01..GR-03)', () => {
  it('AC-01: 8 of 20 raises B01 stock to 18, leaves 12 outstanding, Partially Received, one receipt and one movement', async () => {
    const receipt = await receive(8, 'receive-ac01-0001');

    expect(receipt).toMatchObject({
      documentNumber: 'GR-000001',
      storeId: (await demoOrder()).storeId,
    });
    expect(receipt.lines.map((l) => [l.sku, l.quantity, l.balanceAfter])).toEqual([
      ['SKU001', 8, 18],
    ]);
    expect(await db.balance('SKU001', 'B01')).toBe(18);
    expect(await receivedTotal()).toBe(8);
    expect(20 - (await receivedTotal())).toBe(12);
    expect((await demoOrder()).status).toBe('PARTIALLY_RECEIVED');
    expect(await db.prisma.goodsReceipt.count()).toBe(1);

    const movements = await db.prisma.stockMovement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: 'RECEIPT',
      quantityChange: 8,
      balanceBefore: 10,
      balanceAfter: 18,
      sourceDocumentType: 'GOODS_RECEIPT',
      sourceDocumentId: 'GR-000001',
    });
    expect(await db.prisma.auditLog.count({ where: { action: 'GOODS_RECEIPT' } })).toBe(1);
  });

  it('stores the key on the receipt and on its lines', async () => {
    const receipt = await receive(8, 'receive-keys-0001');

    expect(receipt.idempotencyKey).toBe('receive-keys-0001');
    expect(receipt.lines[0]?.idempotencyKey).toBe('receive-keys-0001');
  });

  it('receives across deliveries and the order is Completed once everything has arrived', async () => {
    await receive(8, 'receive-part-0001');
    const second = await receive(12, 'receive-part-0002');

    expect(second.documentNumber).toBe('GR-000002');
    expect(await db.balance('SKU001', 'B01')).toBe(30);
    expect((await demoOrder()).status).toBe('COMPLETED');
    expect(await db.prisma.goodsReceipt.count()).toBe(2);
  });

  it('a Completed order cannot be received again', async () => {
    await receive(20, 'receive-done-0001');

    const error = await rejection(receive(1, 'receive-done-0002'));

    expect(error.data).toMatchObject({ code: 'PURCHASE_ORDER_NOT_RECEIVABLE' });
    expect(await db.balance('SKU001', 'B01')).toBe(30);
  });

  it('a zero line is not recorded and moves no stock', async () => {
    const [order, sku001, sku002] = await Promise.all([
      demoOrder(),
      db.product('SKU001'),
      db.product('SKU002'),
    ]);
    // SKU002 is not on the order: even a zero line for it is refused.
    const error = await rejection(
      confirmGoodsReceipt(
        db.prisma,
        await actor(),
        {
          purchaseOrderId: order.id,
          lines: [
            { productId: sku001.id, quantity: 3 },
            { productId: sku002.id, quantity: 0 },
          ],
        },
        'receive-zero-0001',
      ),
    );

    expect(error.data).toMatchObject({ code: 'PRODUCT_NOT_IN_ORDER' });
    expect(await db.balance('SKU001', 'B01')).toBe(10);
    expect(await db.prisma.goodsReceipt.count()).toBe(0);
  });

  it('refuses a product that is not on the order and changes nothing', async () => {
    const [order, sku002] = await Promise.all([demoOrder(), db.product('SKU002')]);

    const error = await rejection(
      confirmGoodsReceipt(
        db.prisma,
        await actor(),
        { purchaseOrderId: order.id, lines: [{ productId: sku002.id, quantity: 1 }] },
        'receive-extra-0001',
      ),
    );

    expect(error.data).toMatchObject({ code: 'PRODUCT_NOT_IN_ORDER' });
    expect(await db.balance('SKU002', 'B01')).toBe(5);
    expect(await db.prisma.stockMovement.count()).toBe(0);
  });

  it('Q-02: refuses a product deactivated after approval and changes nothing', async () => {
    await db.prisma.product.update({ where: { sku: 'SKU001' }, data: { isActive: false } });

    const error = await rejection(receive(1, 'receive-inact-0001'));

    expect(error.data).toMatchObject({ code: 'PRODUCT_INACTIVE' });
    expect(await db.balance('SKU001', 'B01')).toBe(10);
    expect(await db.prisma.goodsReceipt.count()).toBe(0);
  });

  it.each(['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED'] as const)(
    'refuses an order that is %s',
    async (status) => {
      await db.prisma.purchaseOrder.update({
        where: { documentNumber: 'PO-DEMO-001' },
        data: { status },
      });

      const error = await rejection(receive(1, 'receive-state-0001'));

      expect(error.data).toMatchObject({ code: 'PURCHASE_ORDER_NOT_RECEIVABLE' });
      expect(await db.balance('SKU001', 'B01')).toBe(10);
    },
  );
});

describe('over-receipt (GR-02)', () => {
  it('AC-03: receiving 21 against 20 is rejected, naming SKU001; no receipt, no movement, stock 10, still Approved', async () => {
    const error = await rejection(receive(21, 'receive-ac03-0001'));

    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(error.data).toMatchObject({
      code: 'RECEIPT_EXCEEDS_ORDERED',
      products: [expect.objectContaining({ sku: 'SKU001', requested: 21, available: 20 })],
    });
    expect(await db.prisma.goodsReceipt.count()).toBe(0);
    expect(await db.prisma.stockMovement.count()).toBe(0);
    expect(await db.balance('SKU001', 'B01')).toBe(10);
    expect((await demoOrder()).status).toBe('APPROVED');
  });

  it('counts earlier deliveries: after 8, receiving 13 is rejected and 12 is accepted', async () => {
    await receive(8, 'receive-cum-0001');

    const error = await rejection(receive(13, 'receive-cum-0002'));
    expect(error.data).toMatchObject({
      code: 'RECEIPT_EXCEEDS_ORDERED',
      products: [expect.objectContaining({ requested: 13, available: 12 })],
    });
    expect(await receivedTotal()).toBe(8);

    await receive(12, 'receive-cum-0003');
    expect(await receivedTotal()).toBe(20);
  });

  it('a rejected receipt hands its document number back', async () => {
    await rejection(receive(21, 'receive-gap-0001'));

    const receipt = await receive(5, 'receive-gap-0002');

    expect(receipt.documentNumber).toBe('GR-000001');
  });

  it('GR-05: two concurrent requests for 15 against 20 give one success, one rejection, 15 received', async () => {
    const results = await Promise.allSettled([
      receive(15, 'receive-race-a-001'),
      receive(15, 'receive-race-b-001'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONFLICT',
      data: { code: 'RECEIPT_EXCEEDS_ORDERED' },
    });
    expect(await receivedTotal()).toBe(15);
    expect(await db.balance('SKU001', 'B01')).toBe(25);
    expect(await db.prisma.goodsReceipt.count()).toBe(1);
    expect(await db.prisma.stockMovement.count()).toBe(1);
  });

  it('GR-05: many concurrent requests can never push the total above ordered', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => receive(5, `receive-many-${i}-0001`)),
    );

    // 20 ordered, 5 each: exactly four fit.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(await receivedTotal()).toBe(20);
    expect(await db.balance('SKU001', 'B01')).toBe(30);
    expect((await demoOrder()).status).toBe('COMPLETED');
  });
});

describe('idempotent confirmation (GR-04)', () => {
  it('AC-02: resending the same request returns the original; stock stays 18 and received stays 8', async () => {
    const first = await receive(8, 'receive-ac02-0001');

    const replay = await receive(8, 'receive-ac02-0001');

    expect(replay.id).toBe(first.id);
    expect(replay.documentNumber).toBe('GR-000001');
    expect(await db.balance('SKU001', 'B01')).toBe(18);
    expect(await receivedTotal()).toBe(8);
    expect(await db.prisma.goodsReceipt.count()).toBe(1);
    expect(await db.prisma.stockMovement.count()).toBe(1);
    expect(await db.prisma.auditLog.count({ where: { action: 'GOODS_RECEIPT' } })).toBe(1);
  });

  it('a new key is a new receipt', async () => {
    const first = await receive(8, 'receive-new-0001');

    const second = await receive(8, 'receive-new-0002');

    expect(second.id).not.toBe(first.id);
    expect(await db.balance('SKU001', 'B01')).toBe(26);
    expect(await db.prisma.goodsReceipt.count()).toBe(2);
  });

  it('a replay still returns the original after the order is Completed', async () => {
    const first = await receive(20, 'receive-late-0001');

    const replay = await receive(20, 'receive-late-0001');

    expect(replay.id).toBe(first.id);
    expect(replay.purchaseOrder.status).toBe('COMPLETED');
    expect(await db.balance('SKU001', 'B01')).toBe(30);
  });

  it('two concurrent requests with the same key post once and both return that receipt', async () => {
    const [one, two] = await Promise.all([
      receive(8, 'receive-twice-0001'),
      receive(8, 'receive-twice-0001'),
    ]);

    expect(one.id).toBe(two.id);
    expect(await db.balance('SKU001', 'B01')).toBe(18);
    expect(await db.prisma.stockMovement.count()).toBe(1);
  });

  it('the same key with a different quantity is refused, not answered with the old receipt', async () => {
    await receive(8, 'receive-diff-0001');

    const error = await rejection(receive(9, 'receive-diff-0001'));

    expect(error.data).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await db.balance('SKU001', 'B01')).toBe(18);
  });
});

describe('store scope (GR-01, NFR-01)', () => {
  it('AC-04: staff_b02 receiving goods for B01 is rejected and no business data changes', async () => {
    const error = await rejection(
      receive(8, 'receive-ac04-0001', await actor('staff_b02@erp.local')),
    );

    expect(error).toMatchObject({ code: 'FORBIDDEN' });
    expect(await db.balance('SKU001', 'B01')).toBe(10);
    expect(await db.balance('SKU001', 'B02')).toBe(0);
    expect(await db.prisma.goodsReceipt.count()).toBe(0);
    expect(await db.prisma.stockMovement.count()).toBe(0);
    expect(await db.prisma.auditLog.count()).toBe(0);
    expect((await demoOrder()).status).toBe('APPROVED');
  });
});

describe('database guards', () => {
  it('refuses a receipt line with a zero quantity, whatever the application code does', async () => {
    const receipt = await receive(8, 'receive-guard-0001');

    await expect(
      db.prisma.goodsReceiptLine.update({
        where: { id: receipt.lines[0]!.id },
        data: { quantity: 0 },
      }),
    ).rejects.toThrow();
  });

  it('keeps a key unique per actor', async () => {
    const first = await receive(1, 'receive-uniq-0001');

    await expect(
      db.prisma.goodsReceipt.create({
        data: {
          documentNumber: 'GR-999999',
          purchaseOrderId: first.purchaseOrderId,
          storeId: first.storeId,
          receivedById: first.receivedById,
          idempotencyKey: 'receive-uniq-0001',
        },
      }),
    ).rejects.toThrow();
  });
});
