import type { User } from '@erp/contracts';
import { describe, expect, it } from 'vitest';
import { useSection81Fixture } from '../../test/integration/harness.js';
import { dailySalesReport } from './daily-sales-report.js';

const db = useSection81Fixture();

async function actor(email: string): Promise<User> {
  const row = await db.user(email);
  return { id: row.id, email: row.email, name: row.name, role: row.role, storeId: row.storeId };
}

/**
 * Insert a CONFIRMED sale directly, so a test can pin `confirmedAt` to an exact instant.
 * One line of `quantity` units of SKU001 at 60.00. `confirmedAt` is a UTC instant.
 */
let saleSeq = 0;
async function confirmedSale(storeCode: string, quantity: number, confirmedAt: Date) {
  const [store, product, who] = await Promise.all([
    db.store(storeCode),
    db.product('SKU001'),
    db.user('staff_b01@erp.local'),
  ]);
  const unitPrice = '60.00';
  const lineTotal = (60 * quantity).toFixed(2);
  saleSeq += 1;
  const uniq = `${confirmedAt.getTime()}-${storeCode}-${saleSeq}`;
  return db.prisma.sale.create({
    data: {
      documentNumber: `SAL-${uniq}`,
      status: 'CONFIRMED',
      storeId: store.id,
      createdById: who.id,
      confirmedById: who.id,
      confirmedAt,
      total: lineTotal,
      idempotencyKey: `key-${uniq}`,
      lines: {
        create: {
          productId: product.id,
          sku: product.sku,
          productName: product.name,
          unit: product.unit,
          quantity,
          unitPrice,
          lineTotal,
          balanceAfter: 0,
        },
      },
    },
  });
}

/** Insert a DRAFT sale (no confirmedAt): it must never appear in the report. */
async function draftSale(storeCode: string, quantity: number) {
  const [store, product, who] = await Promise.all([
    db.store(storeCode),
    db.product('SKU001'),
    db.user('staff_b01@erp.local'),
  ]);
  return db.prisma.sale.create({
    data: {
      status: 'DRAFT',
      storeId: store.id,
      createdById: who.id,
      total: (60 * quantity).toFixed(2),
      lines: {
        create: {
          productId: product.id,
          sku: product.sku,
          productName: product.name,
          unit: product.unit,
          quantity,
          unitPrice: '60.00',
          lineTotal: (60 * quantity).toFixed(2),
        },
      },
    },
  });
}

const manager = () => actor('manager01@erp.local');

describe('daily sales report: Asia/Bangkok day boundary (RPT-01, Section 6.2)', () => {
  it('counts a sale confirmed just before Bangkok midnight on that day, and one just after on the next', async () => {
    // Bangkok is UTC+7. 2026-01-02 00:00:00 +07:00 == 2026-01-01 17:00:00Z.
    // 23:59:59 on 2026-01-02 Bangkok == 2026-01-02 16:59:59Z (still the 2nd).
    // 00:00:01 on 2026-01-03 Bangkok == 2026-01-02 17:00:01Z (now the 3rd).
    await confirmedSale('B01', 2, new Date('2026-01-02T16:59:59.000Z')); // 23:59:59 BKK on the 2nd
    await confirmedSale('B01', 5, new Date('2026-01-02T17:00:01.000Z')); // 00:00:01 BKK on the 3rd

    const report = await dailySalesReport(db.prisma, await manager(), {
      from: '2026-01-02',
      to: '2026-01-03',
      page: 1,
      pageSize: 20,
    });

    // Newest day first.
    expect(report.items).toEqual([
      { date: '2026-01-03', documentCount: 1, unitsSold: 5, totalAmount: '300.00' },
      { date: '2026-01-02', documentCount: 1, unitsSold: 2, totalAmount: '120.00' },
    ]);
    expect(report.total).toBe(2);
  });

  it('counts only confirmed sales and sums count, units and total to two decimals', async () => {
    await confirmedSale('B01', 2, new Date('2026-01-02T05:00:00.000Z')); // noon BKK on the 2nd
    await confirmedSale('B01', 3, new Date('2026-01-02T06:00:00.000Z')); // 13:00 BKK on the 2nd
    await draftSale('B01', 99); // never counted

    const report = await dailySalesReport(db.prisma, await manager(), {
      from: '2026-01-02',
      to: '2026-01-02',
      page: 1,
      pageSize: 20,
    });

    expect(report.items).toEqual([
      { date: '2026-01-02', documentCount: 2, unitsSold: 5, totalAmount: '300.00' },
    ]);
  });

  it('returns an empty page with zero totals when no sales match the day', async () => {
    const report = await dailySalesReport(db.prisma, await manager(), {
      from: '2026-02-01',
      to: '2026-02-01',
      page: 1,
      pageSize: 20,
    });

    expect(report.items).toEqual([]);
    expect(report.total).toBe(0);
  });

  it('rejects a store employee asking for another store (same permission as the screen)', async () => {
    await confirmedSale('B01', 2, new Date('2026-01-02T05:00:00.000Z'));
    await confirmedSale('B02', 4, new Date('2026-01-02T05:00:00.000Z'));
    const staff = await actor('staff_b01@erp.local');

    // Asking for B02 as a B01 employee is forbidden, the same rule the stock screen applies.
    await expect(
      dailySalesReport(db.prisma, staff, {
        from: '2026-01-02',
        to: '2026-01-02',
        storeId: (await db.store('B02')).id,
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('confines a store employee to their own store when no store is requested', async () => {
    await confirmedSale('B01', 2, new Date('2026-01-02T05:00:00.000Z'));
    await confirmedSale('B02', 4, new Date('2026-01-02T05:00:00.000Z'));
    const staff = await actor('staff_b01@erp.local');

    const report = await dailySalesReport(db.prisma, staff, {
      from: '2026-01-02',
      to: '2026-01-02',
      page: 1,
      pageSize: 20,
    });

    // Only B01's sale (2 units), never B02's.
    expect(report.items).toEqual([
      { date: '2026-01-02', documentCount: 1, unitsSold: 2, totalAmount: '120.00' },
    ]);
  });

  it('filters by store for a manager when a storeId is given', async () => {
    await confirmedSale('B01', 2, new Date('2026-01-02T05:00:00.000Z'));
    await confirmedSale('B02', 4, new Date('2026-01-02T05:00:00.000Z'));

    const report = await dailySalesReport(db.prisma, await manager(), {
      from: '2026-01-02',
      to: '2026-01-02',
      storeId: (await db.store('B02')).id,
      page: 1,
      pageSize: 20,
    });

    expect(report.items).toEqual([
      { date: '2026-01-02', documentCount: 1, unitsSold: 4, totalAmount: '240.00' },
    ]);
  });

  it('paginates the per-day rows, newest first', async () => {
    for (const day of ['02', '03', '04']) {
      await confirmedSale('B01', 1, new Date(`2026-01-${day}T05:00:00.000Z`));
    }

    const report = await dailySalesReport(db.prisma, await manager(), {
      from: '2026-01-01',
      to: '2026-01-31',
      page: 1,
      pageSize: 2,
    });

    expect(report.items.map((r) => r.date)).toEqual(['2026-01-04', '2026-01-03']);
    expect(report.total).toBe(3);
  });
});
