import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { call } from '@orpc/server';
import { ORPCError } from '@orpc/nest';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { assertProductUsableInDocument } from './products.rules.js';
import { ProductsController } from './products.controller.js';

async function createController(prisma: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProductsController],
    providers: [{ provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(ProductsController);
}

const water = {
  id: 'p1',
  sku: 'SKU001',
  name: 'Drinking water pack of 6',
  category: 'Beverage',
  unit: 'pack',
  sellingPrice: '60.00',
  isActive: true,
  reorderThresholds: [{ id: 't1', productId: 'p1', storeId: 'b01', threshold: 3 }],
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('ProductsController', () => {
  it('lists active products newest-first with pagination metadata', async () => {
    const findMany = vi.fn().mockResolvedValue([water]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ product: { findMany, count } });

    const result = await call(controller.list(), { page: 1, pageSize: 20, includeInactive: false });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: 'p1',
      sku: 'SKU001',
      sellingPrice: '60.00',
      reorderThresholds: [{ storeId: 'b01', threshold: 3 }],
    });
    // Active-only by default, newest-first, windowed, with thresholds included.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
        include: { reorderThresholds: true },
      }),
    );
  });

  it('includes inactive products in historical search when asked (MD-02)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const controller = await createController({ product: { findMany, count } });

    await call(controller.list(), {
      page: 1,
      pageSize: 20,
      includeInactive: true,
      search: 'water',
    });

    const arg = findMany.mock.calls[0]![0];
    // No isActive filter when including inactive, and the search term is applied.
    expect(arg.where.isActive).toBeUndefined();
    expect(JSON.stringify(arg.where)).toContain('water');
  });

  it('creates a product with a unique SKU and returns it with two-decimal price', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(water);
    const controller = await createController({ product: { findUnique, create } });

    const result = await call(controller.create(), {
      sku: 'SKU001',
      name: 'Drinking water pack of 6',
      category: 'Beverage',
      unit: 'pack',
      sellingPrice: '60.00',
      reorderThresholds: [{ storeId: 'b01', threshold: 3 }],
    });

    expect(result).toMatchObject({ id: 'p1', sku: 'SKU001', sellingPrice: '60.00' });
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ sku: 'SKU001', sellingPrice: '60.00', isActive: true });
    expect(data.reorderThresholds.create).toEqual([{ storeId: 'b01', threshold: 3 }]);
  });

  it('rejects a duplicate SKU with the Thai error envelope', async () => {
    const findUnique = vi.fn().mockResolvedValue(water);
    const create = vi.fn();
    const controller = await createController({ product: { findUnique, create } });

    const error = await call(controller.create(), {
      sku: 'SKU001',
      name: 'Another water',
      category: 'Beverage',
      unit: 'pack',
      sellingPrice: '60.00',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    const orpcError = error as ORPCError<string, unknown>;
    expect(orpcError.code).toBe('CONFLICT');
    expect(orpcError.data).toMatchObject({
      code: 'PRODUCT_SKU_TAKEN',
      message: 'รหัสสินค้านี้ถูกใช้แล้ว',
      fields: ['sku'],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a negative selling price before touching the database (AC2)', async () => {
    const create = vi.fn();
    const controller = await createController({ product: { create } });

    await expect(
      call(controller.create(), {
        sku: 'SKU001',
        name: 'Water',
        category: 'Beverage',
        unit: 'pack',
        sellingPrice: '-1.00',
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a negative reorder threshold before touching the database (AC2)', async () => {
    const create = vi.fn();
    const controller = await createController({ product: { create } });

    await expect(
      call(controller.create(), {
        sku: 'SKU001',
        name: 'Water',
        category: 'Beverage',
        unit: 'pack',
        sellingPrice: '60.00',
        reorderThresholds: [{ storeId: 'b01', threshold: -1 }],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it('sets a per-store reorder threshold for each store (AC3)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(water);
    const controller = await createController({ product: { findUnique, create } });

    await call(controller.create(), {
      sku: 'SKU001',
      name: 'Water',
      category: 'Beverage',
      unit: 'pack',
      sellingPrice: '60.00',
      reorderThresholds: [
        { storeId: 'b01', threshold: 3 },
        { storeId: 'b02', threshold: 5 },
      ],
    });

    expect(create.mock.calls[0]![0].data.reorderThresholds.create).toEqual([
      { storeId: 'b01', threshold: 3 },
      { storeId: 'b02', threshold: 5 },
    ]);
  });

  it('deactivates a product via update and replaces its thresholds', async () => {
    const update = vi.fn().mockResolvedValue({ ...water, isActive: false });
    const controller = await createController({
      product: { update },
      productReorderThreshold: { deleteMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          product: { update },
          productReorderThreshold: { deleteMany: vi.fn() },
        }),
      ),
    });

    const result = await call(controller.update(), {
      id: 'p1',
      name: 'Drinking water pack of 6',
      category: 'Beverage',
      unit: 'pack',
      sellingPrice: '60.00',
      isActive: false,
      reorderThresholds: [{ storeId: 'b01', threshold: 3 }],
    });

    expect(result).toMatchObject({ id: 'p1', isActive: false });
    // The update never carries an sku key (immutable, AC5).
    const updateArg = update.mock.calls[0]![0];
    expect('sku' in updateArg.data).toBe(false);
  });

  it('never writes sku on update even if a client sends one (AC5)', async () => {
    const update = vi.fn().mockResolvedValue(water);
    const controller = await createController({
      product: { update },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ product: { update }, productReorderThreshold: { deleteMany: vi.fn() } }),
      ),
    });

    // A stray `sku` is stripped by the contract and must never reach Prisma.
    await call(controller.update(), {
      id: 'p1',
      sku: 'SKU999',
      name: 'Drinking water pack of 6',
      category: 'Beverage',
      unit: 'pack',
      sellingPrice: '60.00',
    } as never);

    const data = update.mock.calls[0]![0].data;
    expect('sku' in data).toBe(false);
  });
});

/**
 * The reusable "is this product usable in a new document?" rule (MD-02, AC4). Documents
 * and transactions arrive in later tickets (#6, #8, #11); they import this guard and call
 * it when adding a product line. Proving it here keeps AC4 honest at seam 1 without a
 * document model existing yet.
 */
describe('assertProductUsableInDocument (AC4)', () => {
  it('passes an active product', () => {
    expect(() => assertProductUsableInDocument({ isActive: true })).not.toThrow();
  });

  it('rejects an inactive product with the Thai envelope', () => {
    const error = (() => {
      try {
        assertProductUsableInDocument({ isActive: false });
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).data).toMatchObject({
      code: 'PRODUCT_INACTIVE',
      message: 'สินค้านี้ถูกปิดการใช้งาน ไม่สามารถเพิ่มลงในเอกสารใหม่ได้',
    });
  });
});

/** Role enforcement (NFR-01): every route is Administrator-only, observable at seam 1. */
describe('ProductsController role enforcement', () => {
  const reflector = new Reflector();
  const rolesOf = async (method: 'list' | 'create' | 'update') => {
    const controller = await createController({});
    return reflector.get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller)[method] as () => unknown,
    );
  };

  it.each(['create', 'update'] as const)('restricts %s to ADMINISTRATOR', async (method) => {
    expect(await rolesOf(method)).toEqual(['ADMINISTRATOR']);
  });

  // A Purchasing officer must read products to add lines to a purchase order (PO-01).
  it('lets an administrator or a purchasing officer list', async () => {
    expect(await rolesOf('list')).toEqual(['ADMINISTRATOR', 'PURCHASING_OFFICER']);
  });
});
