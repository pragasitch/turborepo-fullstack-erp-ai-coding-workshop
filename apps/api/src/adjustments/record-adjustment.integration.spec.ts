import { ORPCError } from '@orpc/nest';
import { describe, expect, it } from 'vitest';
import { useSection81Fixture } from '../../test/integration/harness.js';
import { recordAdjustment } from './record-adjustment.js';

const db = useSection81Fixture();

async function input(overrides: { quantityChange?: number; reason?: string } = {}) {
  const [product, store, actor] = await Promise.all([
    db.product('SKU001'),
    db.store('B01'),
    db.user('manager01@erp.local'),
  ]);
  return {
    productId: product.id,
    storeId: store.id,
    quantityChange: overrides.quantityChange ?? 5,
    reason: overrides.reason ?? 'นับสต็อกใหม่',
    actorId: actor.id,
  };
}

describe('recordAdjustment (INV-05, NFR-03)', () => {
  it('increases stock, appends an ADJUSTMENT movement and an audit row (AC1)', async () => {
    const result = await recordAdjustment(db.prisma, await input({ quantityChange: 5 }));

    // SKU001 B01 starts at 10 -> 15.
    expect(result.balanceAfter).toBe(15);
    expect(await db.balance('SKU001', 'B01')).toBe(15);

    const movement = await db.prisma.stockMovement.findFirstOrThrow({
      where: { sourceDocumentId: result.documentNumber },
    });
    expect(movement).toMatchObject({ type: 'ADJUSTMENT', quantityChange: 5, balanceAfter: 15 });

    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { sourceDocumentId: result.documentNumber },
    });
    expect(audit).toMatchObject({
      action: 'STOCK_ADJUSTMENT',
      sourceDocumentType: 'ADJUSTMENT',
      outcome: 'SUCCESS',
      detail: 'นับสต็อกใหม่',
    });
    expect(audit.actorId).toBe(movement.actorId);
    expect(audit.createdAt).toBeInstanceOf(Date);
  });

  it('decreases stock within the balance and records both rows (AC1)', async () => {
    const result = await recordAdjustment(db.prisma, await input({ quantityChange: -4 }));

    expect(result.balanceAfter).toBe(6);
    expect(await db.balance('SKU001', 'B01')).toBe(6);
    expect(await db.prisma.stockMovement.count({ where: { type: 'ADJUSTMENT' } })).toBe(1);
    expect(await db.prisma.auditLog.count()).toBe(1);
  });

  it('rejects a reduction larger than the balance and changes nothing (AC3)', async () => {
    const error = await recordAdjustment(db.prisma, await input({ quantityChange: -11 })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: 'CONFLICT', data: { code: 'INSUFFICIENT_STOCK' } });
    // Stock unchanged, and neither a movement nor an audit row was written.
    expect(await db.balance('SKU001', 'B01')).toBe(10);
    expect(await db.prisma.stockMovement.count()).toBe(0);
    expect(await db.prisma.auditLog.count()).toBe(0);
  });

  it('issues consecutive ADJ document numbers', async () => {
    const first = await recordAdjustment(db.prisma, await input({ quantityChange: 1 }));
    const second = await recordAdjustment(db.prisma, await input({ quantityChange: 1 }));

    expect([first.documentNumber, second.documentNumber]).toEqual(['ADJ-000001', 'ADJ-000002']);
  });

  it('keeps audit rows immutable (NFR-03)', async () => {
    const result = await recordAdjustment(db.prisma, await input({ quantityChange: 2 }));
    const audit = await db.prisma.auditLog.findFirstOrThrow({
      where: { sourceDocumentId: result.documentNumber },
    });

    await expect(
      db.prisma.auditLog.update({ where: { id: audit.id }, data: { outcome: 'REJECTED' } }),
    ).rejects.toThrow();
    await expect(db.prisma.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow();
  });
});
