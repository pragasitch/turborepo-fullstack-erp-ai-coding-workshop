import type { User } from '@erp/contracts';
import { ORPCError } from '@orpc/nest';
import { describe, expect, it } from 'vitest';
import { useSection81Fixture } from '../../test/integration/harness.js';
import { confirmSale, createDraftSale, replaceDraftLines } from './sales.js';

const db = useSection81Fixture();

async function actor(email = 'staff_b01@erp.local'): Promise<User> {
  const row = await db.user(email);
  return { id: row.id, email: row.email, name: row.name, role: row.role, storeId: row.storeId };
}

/** A draft at B01 for the given SKUs and quantities. */
async function draft(lines: Record<string, number>, who?: User) {
  const user = who ?? (await actor());
  const productLines = await Promise.all(
    Object.entries(lines).map(async ([sku, quantity]) => ({
      productId: (await db.product(sku)).id,
      quantity,
    })),
  );
  return createDraftSale(db.prisma, user, { lines: productLines });
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ORPCError);
  return error as ORPCError<string, Record<string, unknown>>;
}

describe('draft sales (SAL-01, SAL-02)', () => {
  it('applies the current selling prices, totals them, and does not move stock', async () => {
    const sale = await draft({ SKU001: 2, SKU002: 1 });

    expect(sale).toMatchObject({ status: 'DRAFT', documentNumber: null });
    expect(sale.total.toFixed(2)).toBe('155.00');
    expect(sale.lines.map((l) => [l.sku, l.quantity, l.unitPrice.toFixed(2)]).sort()).toEqual([
      ['SKU001', 2, '60.00'],
      ['SKU002', 1, '35.00'],
    ]);
    expect(await db.balance('SKU001', 'B01')).toBe(10);
    expect(await db.balance('SKU002', 'B01')).toBe(5);
    expect(await db.prisma.stockMovement.count()).toBe(0);
  });

  it('keeps the price on the document when the product price changes later', async () => {
    const sale = await draft({ SKU001: 1 });
    await db.prisma.product.update({ where: { sku: 'SKU001' }, data: { sellingPrice: '99.00' } });

    const confirmed = await confirmSale(db.prisma, await actor(), sale.id, 'key-price-0001');

    expect(confirmed.total.toFixed(2)).toBe('60.00');
    expect(confirmed.lines[0]?.unitPrice.toFixed(2)).toBe('60.00');
  });

  it('refuses to sell an inactive product', async () => {
    await db.prisma.product.update({ where: { sku: 'SKU001' }, data: { isActive: false } });

    const error = await rejection(draft({ SKU001: 1 }));

    expect(error.data).toMatchObject({ code: 'PRODUCT_INACTIVE' });
    expect(await db.prisma.sale.count()).toBe(0);
  });

  it('replaces the lines of a draft and recomputes the total', async () => {
    const sale = await draft({ SKU001: 2 });
    const sku002 = await db.product('SKU002');

    const edited = await replaceDraftLines(db.prisma, await actor(), sale.id, [
      { productId: sku002.id, quantity: 3 },
    ]);

    expect(edited.lines.map((l) => l.sku)).toEqual(['SKU002']);
    expect(edited.total.toFixed(2)).toBe('105.00');
  });
});

describe('confirming a sale (SAL-02, SAL-03)', () => {
  it('AC-06: totals THB 155.00, leaves 8 and 4, and a resend changes nothing', async () => {
    const who = await actor();
    const sale = await draft({ SKU001: 2, SKU002: 1 });
    const key = 'confirm-ac06-0001';

    const first = await confirmSale(db.prisma, who, sale.id, key);

    expect(first).toMatchObject({ status: 'CONFIRMED', documentNumber: 'SAL-000001' });
    expect(first.total.toFixed(2)).toBe('155.00');
    expect(await db.balance('SKU001', 'B01')).toBe(8);
    expect(await db.balance('SKU002', 'B01')).toBe(4);
    expect(first.lines.map((l) => [l.sku, l.balanceAfter]).sort()).toEqual([
      ['SKU001', 8],
      ['SKU002', 4],
    ]);

    const replay = await confirmSale(db.prisma, who, sale.id, key);

    expect(replay.id).toBe(first.id);
    expect(replay.documentNumber).toBe('SAL-000001');
    expect(await db.balance('SKU001', 'B01')).toBe(8);
    expect(await db.balance('SKU002', 'B01')).toBe(4);
    expect(await db.prisma.sale.count({ where: { status: 'CONFIRMED' } })).toBe(1);
    expect(await db.prisma.stockMovement.count()).toBe(2);
    expect(await db.prisma.auditLog.count({ where: { action: 'SALE_CONFIRMATION' } })).toBe(1);
  });

  it('records a SALE movement per line with the balances either side', async () => {
    const sale = await draft({ SKU001: 3 });

    const confirmed = await confirmSale(db.prisma, await actor(), sale.id, 'confirm-move-0001');

    const movement = await db.prisma.stockMovement.findFirstOrThrow({
      where: { sourceDocumentId: confirmed.documentNumber! },
    });
    expect(movement).toMatchObject({
      type: 'SALE',
      quantityChange: -3,
      balanceBefore: 10,
      balanceAfter: 7,
      sourceDocumentType: 'SALE',
    });
    expect(confirmed.lines[0]?.idempotencyKey).toBe('confirm-move-0001');
    expect(confirmed.idempotencyKey).toBe('confirm-move-0001');
  });

  it('AC-05: 11 packs of SKU001 against 10 is rejected, names SKU001 and changes nothing', async () => {
    const sale = await draft({ SKU001: 11 });

    const error = await rejection(
      confirmSale(db.prisma, await actor(), sale.id, 'confirm-ac05-0001'),
    );

    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(error.data).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      products: [expect.objectContaining({ sku: 'SKU001', requested: 11, available: 10 })],
    });
    expect(await db.balance('SKU001', 'B01')).toBe(10);
    expect(await db.prisma.stockMovement.count()).toBe(0);
    expect(await db.prisma.auditLog.count()).toBe(0);
    const row = await db.prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row).toMatchObject({ status: 'DRAFT', documentNumber: null, idempotencyKey: null });
  });

  it('rejects the whole document when only one of several lines is short (no partial posting)', async () => {
    // SKU001 has 10 (enough), SKU002 has 5 (not enough for 6), SKU003 has 0.
    const sale = await draft({ SKU001: 2, SKU002: 6, SKU003: 1 });

    const error = await rejection(
      confirmSale(db.prisma, await actor(), sale.id, 'confirm-partial-01'),
    );

    const products = (error.data.products as { sku: string }[]).map((p) => p.sku).sort();
    expect(products).toEqual(['SKU002', 'SKU003']);
    expect(await db.balance('SKU001', 'B01')).toBe(10);
    expect(await db.balance('SKU002', 'B01')).toBe(5);
    expect(await db.prisma.stockMovement.count()).toBe(0);
  });

  it('a rejected confirm gives its document number back and the sale can be fixed and confirmed', async () => {
    const who = await actor();
    const sale = await draft({ SKU001: 11 });
    await rejection(confirmSale(db.prisma, who, sale.id, 'confirm-retry-0001'));

    const sku001 = await db.product('SKU001');
    await replaceDraftLines(db.prisma, who, sale.id, [{ productId: sku001.id, quantity: 4 }]);
    const confirmed = await confirmSale(db.prisma, who, sale.id, 'confirm-retry-0002');

    expect(confirmed.documentNumber).toBe('SAL-000001');
    expect(await db.balance('SKU001', 'B01')).toBe(6);
  });

  it('INV-04 / AC-07: two concurrent sales of 7 against 10 give one success, one rejection, stock 3', async () => {
    const who = await actor();
    const [a, b] = [await draft({ SKU001: 7 }), await draft({ SKU001: 7 })];

    const results = await Promise.allSettled([
      confirmSale(db.prisma, who, a.id, 'confirm-race-a-001'),
      confirmSale(db.prisma, who, b.id, 'confirm-race-b-001'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONFLICT',
      data: { code: 'INSUFFICIENT_STOCK' },
    });
    expect(await db.balance('SKU001', 'B01')).toBe(3);
    expect(await db.prisma.sale.count({ where: { status: 'CONFIRMED' } })).toBe(1);
    expect(await db.prisma.stockMovement.count()).toBe(1);
  });

  it('two concurrent confirms with the same key post once and both return that sale', async () => {
    const who = await actor();
    const sale = await draft({ SKU001: 4 });

    const [one, two] = await Promise.all([
      confirmSale(db.prisma, who, sale.id, 'confirm-twice-0001'),
      confirmSale(db.prisma, who, sale.id, 'confirm-twice-0001'),
    ]);

    expect(one.id).toBe(two.id);
    expect(one.documentNumber).toBe(two.documentNumber);
    expect(await db.balance('SKU001', 'B01')).toBe(6);
    expect(await db.prisma.stockMovement.count()).toBe(1);
  });

  it('a new key on an already confirmed sale posts nothing more', async () => {
    const who = await actor();
    const sale = await draft({ SKU001: 4 });
    await confirmSale(db.prisma, who, sale.id, 'confirm-first-0001');

    const error = await rejection(confirmSale(db.prisma, who, sale.id, 'confirm-second-001'));

    expect(error.data).toMatchObject({ code: 'SALE_ALREADY_CONFIRMED' });
    expect(await db.balance('SKU001', 'B01')).toBe(6);
    expect(await db.prisma.stockMovement.count()).toBe(1);
  });

  it('a key that already confirmed a different sale is refused', async () => {
    const who = await actor();
    const [a, b] = [await draft({ SKU001: 1 }), await draft({ SKU002: 1 })];
    await confirmSale(db.prisma, who, a.id, 'confirm-reuse-0001');

    const error = await rejection(confirmSale(db.prisma, who, b.id, 'confirm-reuse-0001'));

    expect(error.data).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await db.balance('SKU002', 'B01')).toBe(5);
  });

  it('refuses a draft whose product was deactivated before confirmation', async () => {
    const sale = await draft({ SKU001: 1 });
    await db.prisma.product.update({ where: { sku: 'SKU001' }, data: { isActive: false } });

    const error = await rejection(
      confirmSale(db.prisma, await actor(), sale.id, 'confirm-inact-001'),
    );

    expect(error.data).toMatchObject({ code: 'PRODUCT_INACTIVE' });
    expect(await db.balance('SKU001', 'B01')).toBe(10);
  });

  it('a store employee cannot confirm another store’s sale', async () => {
    const sale = await draft({ SKU001: 1 });

    const error = await rejection(
      confirmSale(db.prisma, await actor('staff_b02@erp.local'), sale.id, 'confirm-scope-0001'),
    );

    expect(error).toMatchObject({ code: 'FORBIDDEN' });
    expect(await db.balance('SKU001', 'B01')).toBe(10);
  });
});

describe('confirmed sales are final (SAL-04)', () => {
  it('cannot have their lines replaced', async () => {
    const who = await actor();
    const sale = await draft({ SKU001: 1 });
    await confirmSale(db.prisma, who, sale.id, 'confirm-final-0001');
    const sku002 = await db.product('SKU002');

    const error = await rejection(
      replaceDraftLines(db.prisma, who, sale.id, [{ productId: sku002.id, quantity: 1 }]),
    );

    expect(error.data).toMatchObject({ code: 'SALE_CONFIRMED_IMMUTABLE' });
  });

  it('are protected by the database too: a confirmed row without a document number is refused', async () => {
    const sale = await draft({ SKU001: 1 });

    await expect(
      db.prisma.sale.update({ where: { id: sale.id }, data: { status: 'CONFIRMED' } }),
    ).rejects.toThrow();
  });
});
