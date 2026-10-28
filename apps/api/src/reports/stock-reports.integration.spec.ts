import type { User } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { useSection81Fixture } from '../../test/integration/harness.js';
import type { PrismaService } from '../database/prisma.service.js';
import { postStockMovement } from '../inventory/stock-ledger.js';
import { ReportsController } from './reports.controller.js';

const db = useSection81Fixture();

function controller() {
  return new ReportsController(db.prisma as unknown as PrismaService);
}

async function signedIn(email: string): Promise<User> {
  const user = await db.user(email);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    storeId: user.storeId,
  };
}

const defaults = { page: 1, pageSize: 20 };

/** Post a stock movement to SKU001 in B01 so its balance moves by `quantityChange`. */
async function moveWaterB01(actor: User, quantityChange: number) {
  const [product, store] = await Promise.all([db.product('SKU001'), db.store('B01')]);
  await db.prisma.$transaction((tx) =>
    postStockMovement(tx, {
      productId: product.id,
      storeId: store.id,
      quantityChange,
      type: 'SALE',
      sourceDocumentType: 'SALE',
      sourceDocumentId: 'SO-000001',
      actorId: actor.id,
    }),
  );
}

const summary = (items: { sku: string; storeCode: string; quantity: number }[]) =>
  items.map((i) => `${i.sku}@${i.storeCode}=${i.quantity}`);

// The SQL behind RPT-02 runs for real here; seam 1 covers the mapping and permissions
// with a stubbed database.
describe('stock reports against Postgres (RPT-02)', () => {
  it('AC-08: SKU003 at balance 0 is in the B01 low-stock report (0 <= threshold 3)', async () => {
    const manager = await signedIn('manager01@erp.local');
    const b01 = await db.store('B01');

    const report = await call(controller().lowStock(manager), { ...defaults, storeId: b01.id });

    // SKU001 (10) and SKU002 (5) are above their threshold of 3, so they are not low.
    expect(summary(report.items)).toEqual(['SKU003@B01=0']);
    expect(report.items[0]).toMatchObject({ reorderThreshold: 3, isLowStock: true });
    expect(report.total).toBe(1);
  });

  it('the B01 stock-on-hand report lists every product, SKU003 at 0 included', async () => {
    const manager = await signedIn('manager01@erp.local');
    const b01 = await db.store('B01');

    const report = await call(controller().stockOnHand(manager), { ...defaults, storeId: b01.id });

    expect(summary(report.items)).toEqual(['SKU001@B01=10', 'SKU002@B01=5', 'SKU003@B01=0']);
  });

  it('a zero-stock product that matches the search stays visible in stock on hand', async () => {
    const manager = await signedIn('manager01@erp.local');

    const byName = await call(controller().stockOnHand(manager), { ...defaults, search: 'ซักผ้า' });
    const bySku = await call(controller().stockOnHand(manager), { ...defaults, search: 'sku003' });

    expect(summary(byName.items)).toEqual(['SKU003@B01=0', 'SKU003@B02=0']);
    expect(summary(bySku.items)).toEqual(['SKU003@B01=0', 'SKU003@B02=0']);
  });

  it('the product search narrows the low-stock report too', async () => {
    const manager = await signedIn('manager01@erp.local');

    const report = await call(controller().lowStock(manager), { ...defaults, search: 'SKU002' });

    // SKU002 is fine in B01 (5) but empty in B02 (0 <= 3).
    expect(summary(report.items)).toEqual(['SKU002@B02=0']);
  });

  it('low stock is balance <= threshold: a balance of 3 is low, 4 is not', async () => {
    const manager = await signedIn('manager01@erp.local');
    const b01 = await db.store('B01');
    const lowStock = async () =>
      summary(
        (await call(controller().lowStock(manager), { ...defaults, storeId: b01.id })).items,
      );

    await moveWaterB01(manager, -6); // 10 -> 4: above the threshold of 3
    expect(await lowStock()).toEqual(['SKU003@B01=0']);

    await moveWaterB01(manager, -1); // 4 -> 3: exactly at the threshold
    expect(await lowStock()).toEqual(['SKU001@B01=3', 'SKU003@B01=0']);
  });

  it('a product with no threshold in a store is never in the low-stock report', async () => {
    const manager = await signedIn('manager01@erp.local');
    const [product, b01] = await Promise.all([db.product('SKU003'), db.store('B01')]);
    await db.prisma.productReorderThreshold.deleteMany({
      where: { productId: product.id, storeId: b01.id },
    });

    const report = await call(controller().lowStock(manager), { ...defaults, storeId: b01.id });

    expect(report.items).toEqual([]);
    expect(report.total).toBe(0);
  });

  it('spans every store for a manager, and paginates with the full filtered total', async () => {
    const manager = await signedIn('manager01@erp.local');

    const all = await call(controller().lowStock(manager), defaults);
    const page2 = await call(controller().lowStock(manager), { page: 2, pageSize: 2 });

    // B02 holds nothing, so all three SKUs are low there, plus SKU003 in B01.
    expect(summary(all.items)).toEqual([
      'SKU001@B02=0',
      'SKU002@B02=0',
      'SKU003@B01=0',
      'SKU003@B02=0',
    ]);
    expect(page2.total).toBe(4);
    expect(summary(page2.items)).toEqual(['SKU003@B01=0', 'SKU003@B02=0']);
  });

  it('confines a store employee to their own store and refuses another', async () => {
    const staffB01 = await signedIn('staff_b01@erp.local');
    const b02 = await db.store('B02');

    const own = await call(controller().lowStock(staffB01), defaults);
    expect(summary(own.items)).toEqual(['SKU003@B01=0']);

    const onHand = await call(controller().stockOnHand(staffB01), defaults);
    expect(new Set(onHand.items.map((i) => i.storeCode))).toEqual(new Set(['B01']));

    await expect(
      call(controller().lowStock(staffB01), { ...defaults, storeId: b02.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      call(controller().stockOnHand(staffB01), { ...defaults, storeId: b02.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
