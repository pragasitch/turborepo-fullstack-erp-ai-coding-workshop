import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { call } from '@orpc/server';
import { ORPCError } from '@orpc/nest';
import type { User } from '@erp/contracts';
import { Decimal } from '@erp/database';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { GoodsReceiptsController } from './goods-receipts.controller.js';

async function createController(prisma: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [GoodsReceiptsController],
    providers: [{ provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(GoodsReceiptsController);
}

function user(role: User['role'], storeId: string | null): User {
  return {
    id: `${role}-${storeId ?? 'none'}`,
    email: `${role}@erp.local`,
    name: role,
    role,
    storeId,
  };
}

const staffB01 = user('STORE_EMPLOYEE', 'b01');
const staffB02 = user('STORE_EMPLOYEE', 'b02');
const manager = user('MANAGER', null);

const KEY = 'receive-key-0001';
const D = (value: string) => new Decimal(value);

/** PO-DEMO-001: Approved for B01, 20 x SKU001 @ 45.00. */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'po1',
    documentNumber: 'PO-DEMO-001',
    status: 'APPROVED',
    supplierId: 'sup1',
    supplier: { code: 'SUP01' },
    storeId: 'b01',
    store: { code: 'B01' },
    expectedReceiptDate: new Date('2026-02-01T00:00:00.000Z'),
    total: D('900.00'),
    lines: [
      {
        id: 'pl1',
        purchaseOrderId: 'po1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'น้ำดื่มแพ็ค 6',
        unit: 'แพ็ค',
        quantity: 20,
        unitPrice: D('45.00'),
        lineTotal: D('900.00'),
        product: { isActive: true },
      },
    ],
    ...overrides,
  };
}

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  sku: 'SKU001',
  name: 'น้ำดื่มแพ็ค 6',
  unit: 'แพ็ค',
  isActive: true,
  ...overrides,
});

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gr1',
    documentNumber: 'GR-000001',
    purchaseOrderId: 'po1',
    purchaseOrder: { documentNumber: 'PO-DEMO-001', status: 'PARTIALLY_RECEIVED' },
    storeId: 'b01',
    store: { code: 'B01' },
    receivedById: staffB01.id,
    idempotencyKey: KEY,
    confirmedAt: new Date('2026-01-02T01:00:00.000Z'),
    createdAt: new Date('2026-01-02T01:00:00.000Z'),
    lines: [
      {
        id: 'gl1',
        goodsReceiptId: 'gr1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'น้ำดื่มแพ็ค 6',
        unit: 'แพ็ค',
        quantity: 8,
        idempotencyKey: KEY,
        balanceAfter: 18,
      },
    ],
    ...overrides,
  };
}

/** A stub whose transaction runs against `tx`, with the row lock answering `lockedId`. */
function withTransaction(tx: Record<string, unknown>, lockedId = 'po1') {
  const full = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: lockedId }]),
    goodsReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
    goodsReceiptLine: { groupBy: vi.fn().mockResolvedValue([]) },
    ...tx,
  };
  return { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(full)), tx: full };
}

const body = (lines: { productId: string; quantity: number }[], purchaseOrderId = 'po1') => ({
  body: { purchaseOrderId, lines },
  headers: { 'idempotency-key': KEY },
});

describe('GoodsReceiptsController.confirm: who and where (GR-01, NFR-01)', () => {
  it('AC-04: refuses a store employee receiving for another store, and writes nothing', async () => {
    const create = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow()), update: vi.fn() },
      goodsReceipt: { findFirst: vi.fn(), create },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB02), body([{ productId: 'p1', quantity: 8 }])),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', data: { code: 'STORE_SCOPE_FORBIDDEN' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a store employee with no assigned store', async () => {
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow()) },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(
        controller.confirm(user('STORE_EMPLOYEE', null)),
        body([{ productId: 'p1', quantity: 1 }]),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('answers 404 for an order that does not exist', async () => {
    const controller = await createController({
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) =>
        fn({ $queryRaw: vi.fn().mockResolvedValue([]) }),
      ),
    });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 1 }], 'nope')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { code: 'PURCHASE_ORDER_NOT_FOUND' } });
  });

  it('requires an Idempotency-Key', async () => {
    const controller = await createController({ $transaction: vi.fn() });

    await expect(
      call(controller.confirm(staffB01), {
        body: { purchaseOrderId: 'po1', lines: [{ productId: 'p1', quantity: 1 }] },
        headers: {},
      } as never),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe('GoodsReceiptsController.confirm: what may be received (GR-01, GR-02, Q-02)', () => {
  it.each(['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'COMPLETED'])(
    'refuses an order that is %s',
    async (status) => {
      const create = vi.fn();
      const { $transaction } = withTransaction({
        purchaseOrder: {
          findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow({ status })),
          update: vi.fn(),
        },
        goodsReceipt: { findFirst: vi.fn().mockResolvedValue(null), create },
      });
      const controller = await createController({ $transaction });

      await expect(
        call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 1 }])),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        data: { code: 'PURCHASE_ORDER_NOT_RECEIVABLE' },
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5])('rejects the quantity %s before touching the database', async (quantity) => {
    const $transaction = vi.fn();
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity }])),
    ).rejects.toBeInstanceOf(ORPCError);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('rejects a receipt where every line is zero before touching the database', async () => {
    const $transaction = vi.fn();
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 0 }])),
    ).rejects.toBeInstanceOf(ORPCError);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('rejects a product that is not on the order', async () => {
    const create = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow()), update: vi.fn() },
      product: { findMany: vi.fn().mockResolvedValue([]) },
      goodsReceipt: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p9', quantity: 1 }])),
    ).rejects.toMatchObject({
      data: { code: 'PRODUCT_NOT_IN_ORDER', fields: ['productId'] },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('AC-03: rejects 21 against 20 ordered and names the product and what is outstanding', async () => {
    const create = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow()), update: vi.fn() },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      goodsReceipt: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 21 }])),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      data: {
        code: 'RECEIPT_EXCEEDS_ORDERED',
        products: [expect.objectContaining({ sku: 'SKU001', requested: 21, available: 20 })],
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('counts earlier deliveries: 8 already received leaves 12 outstanding', async () => {
    const create = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow({ status: 'PARTIALLY_RECEIVED' })),
        update: vi.fn(),
      },
      goodsReceiptLine: {
        groupBy: vi.fn().mockResolvedValue([{ productId: 'p1', _sum: { quantity: 8 } }]),
      },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      goodsReceipt: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 13 }])),
    ).rejects.toMatchObject({
      data: {
        code: 'RECEIPT_EXCEEDS_ORDERED',
        products: [expect.objectContaining({ requested: 13, available: 12 })],
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('Q-02: rejects a product deactivated after approval, before any stock moves', async () => {
    const executeRaw = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow()), update: vi.fn() },
      product: { findMany: vi.fn().mockResolvedValue([product({ isActive: false })]) },
      $executeRaw: executeRaw,
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 1 }])),
    ).rejects.toMatchObject({ data: { code: 'PRODUCT_INACTIVE' } });
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe('GoodsReceiptsController.confirm: idempotency (GR-04)', () => {
  it('returns the stored receipt for a replay of the same key and request, and posts nothing', async () => {
    const executeRaw = vi.fn();
    const create = vi.fn();
    const update = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow({ status: 'PARTIALLY_RECEIVED' })),
        update,
      },
      goodsReceipt: { findFirst: vi.fn().mockResolvedValue(receiptRow()), create },
      $executeRaw: executeRaw,
    });
    const controller = await createController({ $transaction });

    const result = await call(
      controller.confirm(staffB01),
      body([{ productId: 'p1', quantity: 8 }]),
    );

    expect(result).toMatchObject({
      id: 'gr1',
      documentNumber: 'GR-000001',
      orderStatus: 'PARTIALLY_RECEIVED',
      lines: [{ sku: 'SKU001', quantity: 8, balanceAfter: 18 }],
    });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('still returns the original once the order is Completed', async () => {
    const { $transaction } = withTransaction({
      purchaseOrder: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow({ status: 'COMPLETED' })),
      },
      goodsReceipt: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            receiptRow({ purchaseOrder: { documentNumber: 'PO-DEMO-001', status: 'COMPLETED' } }),
          ),
      },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 8 }])),
    ).resolves.toMatchObject({ documentNumber: 'GR-000001', orderStatus: 'COMPLETED' });
  });

  it('refuses a key that already received a different order', async () => {
    const { $transaction } = withTransaction(
      {
        purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow({ id: 'po2' })) },
        goodsReceipt: { findFirst: vi.fn().mockResolvedValue(receiptRow()) },
      },
      'po2',
    );
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 8 }], 'po2')),
    ).rejects.toMatchObject({ code: 'CONFLICT', data: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('refuses a key reused with different quantities rather than pretending they were recorded', async () => {
    const { $transaction } = withTransaction({
      purchaseOrder: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(orderRow({ status: 'PARTIALLY_RECEIVED' })),
      },
      goodsReceipt: { findFirst: vi.fn().mockResolvedValue(receiptRow()) },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), body([{ productId: 'p1', quantity: 9 }])),
    ).rejects.toMatchObject({ data: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });
});

describe('confirmed receipts are final (GR-05)', () => {
  it('offers no route to edit or cancel one', async () => {
    const controller = await createController({});

    for (const method of ['update', 'cancel', 'delete'] as const) {
      expect(method in controller).toBe(false);
    }
  });
});

describe('GoodsReceiptsController.get / list / receivableOrders (viewing)', () => {
  it('shows a confirmed receipt with its number, lines and the balances left', async () => {
    const controller = await createController({
      goodsReceipt: { findUnique: vi.fn().mockResolvedValue(receiptRow()) },
    });

    await expect(call(controller.get(staffB01), { id: 'gr1' })).resolves.toMatchObject({
      documentNumber: 'GR-000001',
      purchaseOrderNumber: 'PO-DEMO-001',
      storeCode: 'B01',
      confirmedAt: '2026-01-02T01:00:00.000Z',
      lines: [{ sku: 'SKU001', quantity: 8, balanceAfter: 18 }],
    });
  });

  it('hides another store’s receipt from a store employee', async () => {
    const controller = await createController({
      goodsReceipt: { findUnique: vi.fn().mockResolvedValue(receiptRow()) },
    });

    await expect(call(controller.get(staffB02), { id: 'gr1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('answers 404 for a receipt that does not exist', async () => {
    const controller = await createController({
      goodsReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(call(controller.get(manager), { id: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { code: 'GOODS_RECEIPT_NOT_FOUND' },
    });
  });

  it('lists newest first, confined to a store employee’s store, with pagination', async () => {
    const findMany = vi.fn().mockResolvedValue([receiptRow()]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ goodsReceipt: { findMany, count } });

    const result = await call(controller.list(staffB01), { page: 1, pageSize: 20 });

    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: 'b01' },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      }),
    );
  });

  it('lists every store for a manager, optionally for one order', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const controller = await createController({
      goodsReceipt: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await call(controller.list(manager), { page: 1, pageSize: 20, purchaseOrderId: 'po1' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { purchaseOrderId: 'po1' } }),
    );
  });

  it('GR-01: shows ordered, previously received and outstanding quantities for Approved and Partially Received orders of the employee’s store', async () => {
    const findMany = vi.fn().mockResolvedValue([orderRow({ status: 'PARTIALLY_RECEIVED' })]);
    const controller = await createController({
      purchaseOrder: { findMany, count: vi.fn().mockResolvedValue(1) },
      goodsReceiptLine: {
        groupBy: vi.fn().mockResolvedValue([{ productId: 'p1', _sum: { quantity: 8 } }]),
      },
    });

    const result = await call(controller.receivableOrders(staffB01), { page: 1, pageSize: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] }, storeId: 'b01' },
      }),
    );
    expect(result.items).toMatchObject([
      {
        documentNumber: 'PO-DEMO-001',
        status: 'PARTIALLY_RECEIVED',
        storeCode: 'B01',
        supplierCode: 'SUP01',
        lines: [{ sku: 'SKU001', isActive: true, ordered: 20, received: 8, outstanding: 12 }],
      },
    ]);
  });

  it('lists receivable orders of every store for a manager', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const controller = await createController({
      purchaseOrder: { findMany, count: vi.fn().mockResolvedValue(0) },
      goodsReceiptLine: { groupBy: vi.fn().mockResolvedValue([]) },
    });

    await call(controller.receivableOrders(manager), { page: 1, pageSize: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } } }),
    );
  });
});

describe('GoodsReceiptsController roles', () => {
  const reflector = new Reflector();
  const rolesOf = async (method: keyof GoodsReceiptsController) => {
    const controller = await createController({});
    return reflector.get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller)[method] as () => unknown,
    );
  };

  it('only a store employee may confirm a receipt', async () => {
    expect(await rolesOf('confirm')).toEqual(['STORE_EMPLOYEE']);
  });

  it.each(['get', 'list', 'receivableOrders'] as const)(
    'store employees, managers and administrators may %s',
    async (method) => {
      expect(await rolesOf(method)).toEqual(['STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR']);
    },
  );
});
