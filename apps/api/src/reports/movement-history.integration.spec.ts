import type { User } from '@erp/contracts';
import type { StockMovementType } from '@erp/database';
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

/** Post one movement to a (SKU, store) pair, returning nothing: the report reads it back. */
async function move(
  actor: User,
  sku: string,
  storeCode: string,
  quantityChange: number,
  type: StockMovementType,
  source: { type: string; id: string },
) {
  const [product, store] = await Promise.all([db.product(sku), db.store(storeCode)]);
  await db.prisma.$transaction((tx) =>
    postStockMovement(tx, {
      productId: product.id,
      storeId: store.id,
      quantityChange,
      type,
      sourceDocumentType: source.type,
      sourceDocumentId: source.id,
      actorId: actor.id,
    }),
  );
}

const docs = (items: { sourceDocumentType: string; sourceDocumentId: string }[]) =>
  items.map((i) => `${i.sourceDocumentType}:${i.sourceDocumentId}`);

// The SQL behind RPT-03 runs for real here; seam 2 covers the mapping and permissions
// with a stubbed database.
describe('movement history against Postgres (RPT-03)', () => {
  it('lists newest-first with the source document and actor on each row', async () => {
    const manager = await signedIn('manager01@erp.local');
    await move(manager, 'SKU001', 'B01', 5, 'RECEIPT', { type: 'GOODS_RECEIPT', id: 'GR-000001' });
    await move(manager, 'SKU001', 'B01', -2, 'SALE', { type: 'SALE', id: 'SAL-000001' });

    const report = await call(controller().movementHistory(manager), defaults);

    // Newest first: the sale was posted after the receipt.
    expect(docs(report.items)).toEqual(['SALE:SAL-000001', 'GOODS_RECEIPT:GR-000001']);
    expect(report.items[0]).toMatchObject({
      sku: 'SKU001',
      type: 'SALE',
      quantityChange: -2,
      actorName: 'Manager 01',
    });
    expect(report.total).toBe(2);
  });

  it('filters by product, store and movement type', async () => {
    const manager = await signedIn('manager01@erp.local');
    await move(manager, 'SKU001', 'B01', 5, 'RECEIPT', { type: 'GOODS_RECEIPT', id: 'GR-1' });
    await move(manager, 'SKU002', 'B01', 3, 'ADJUSTMENT', { type: 'ADJUSTMENT', id: 'ADJ-1' });
    await move(manager, 'SKU001', 'B02', 4, 'RECEIPT', { type: 'GOODS_RECEIPT', id: 'GR-2' });

    const bySearch = await call(controller().movementHistory(manager), {
      ...defaults,
      search: 'SKU001',
    });
    expect(bySearch.items.every((i) => i.sku === 'SKU001')).toBe(true);
    expect(bySearch.total).toBe(2);

    const b01 = await db.store('B01');
    const byStore = await call(controller().movementHistory(manager), {
      ...defaults,
      storeId: b01.id,
    });
    expect(byStore.items.every((i) => i.storeCode === 'B01')).toBe(true);
    expect(byStore.total).toBe(2);

    const byType = await call(controller().movementHistory(manager), {
      ...defaults,
      type: 'ADJUSTMENT',
    });
    expect(docs(byType.items)).toEqual(['ADJUSTMENT:ADJ-1']);
  });

  it('spans every store for a manager', async () => {
    const manager = await signedIn('manager01@erp.local');
    await move(manager, 'SKU001', 'B01', 5, 'RECEIPT', { type: 'GOODS_RECEIPT', id: 'GR-1' });
    await move(manager, 'SKU001', 'B02', 4, 'RECEIPT', { type: 'GOODS_RECEIPT', id: 'GR-2' });

    const report = await call(controller().movementHistory(manager), defaults);

    expect(new Set(report.items.map((i) => i.storeCode))).toEqual(new Set(['B01', 'B02']));
    expect(report.total).toBe(2);
  });

  it('confines a store employee to their own store and refuses another', async () => {
    const manager = await signedIn('manager01@erp.local');
    const staffB01 = await signedIn('staff_b01@erp.local');
    await move(manager, 'SKU001', 'B01', 5, 'RECEIPT', { type: 'GOODS_RECEIPT', id: 'GR-1' });
    await move(manager, 'SKU001', 'B02', 4, 'RECEIPT', { type: 'GOODS_RECEIPT', id: 'GR-2' });

    const own = await call(controller().movementHistory(staffB01), defaults);
    expect(new Set(own.items.map((i) => i.storeCode))).toEqual(new Set(['B01']));
    expect(own.total).toBe(1);

    const b02 = await db.store('B02');
    await expect(
      call(controller().movementHistory(staffB01), { ...defaults, storeId: b02.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
