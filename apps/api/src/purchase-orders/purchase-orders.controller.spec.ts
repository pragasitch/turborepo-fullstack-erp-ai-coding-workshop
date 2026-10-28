import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { call } from '@orpc/server';
import { ORPCError } from '@orpc/nest';
import type { User } from '@erp/contracts';
import { Decimal } from '@erp/database';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { PurchaseOrdersController } from './purchase-orders.controller.js';

async function createController(prisma: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [PurchaseOrdersController],
    providers: [{ provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(PurchaseOrdersController);
}

function user(role: User['role'], storeId: string | null = null): User {
  return { id: `${role}-1`, email: `${role}@erp.local`, name: role, role, storeId };
}

const officer = user('PURCHASING_OFFICER');
const D = (value: string) => new Decimal(value);

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  sku: 'SKU001',
  name: 'น้ำดื่มแพ็ค 6',
  unit: 'แพ็ค',
  sellingPrice: D('60.00'),
  isActive: true,
  ...overrides,
});

const validInput = () => ({
  supplierId: 'sup1',
  storeId: 'b01',
  expectedReceiptDate: '2026-02-01',
  lines: [{ productId: 'p1', quantity: 2, unitPrice: '10.00' }],
});

function poRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'po1',
    documentNumber: null,
    status: 'DRAFT',
    supplierId: 'sup1',
    supplier: { code: 'SUP01' },
    storeId: 'b01',
    store: { code: 'B01' },
    createdById: officer.id,
    expectedReceiptDate: new Date('2026-02-01T00:00:00.000Z'),
    total: D('20.00'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    lines: [
      {
        id: 'l1',
        purchaseOrderId: 'po1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'น้ำดื่มแพ็ค 6',
        unit: 'แพ็ค',
        quantity: 2,
        unitPrice: D('10.00'),
        lineTotal: D('20.00'),
      },
    ],
    ...overrides,
  };
}

/** A stub whose transaction runs against `tx`, with the row lock answering `lockedId`. */
function withTransaction(tx: Record<string, unknown>, lockedId = 'po1') {
  const full = { $queryRaw: vi.fn().mockResolvedValue([{ id: lockedId }]), ...tx };
  return { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(full)), tx: full };
}

describe('PurchaseOrdersController.create (PO-01)', () => {
  it('persists a draft with the supplier, store, expected date and priced lines', async () => {
    const create = vi.fn().mockResolvedValue(poRow());
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      purchaseOrder: { create },
    });

    const result = await call(controller.create(officer), validInput());

    expect(result).toMatchObject({
      status: 'DRAFT',
      documentNumber: null,
      supplierCode: 'SUP01',
      storeCode: 'B01',
      expectedReceiptDate: '2026-02-01',
      total: '20.00',
      lines: [{ sku: 'SKU001', quantity: 2, unitPrice: '10.00', lineTotal: '20.00' }],
    });
    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ supplierId: 'sup1', storeId: 'b01', createdById: officer.id });
    expect(data.total.toFixed(2)).toBe('20.00');
    expect(data.lines.create[0]).toMatchObject({ sku: 'SKU001', quantity: 2 });
    expect(data.lines.create[0].unitPrice.toFixed(2)).toBe('10.00');
    expect(data.lines.create[0].lineTotal.toFixed(2)).toBe('20.00');
  });

  it('rejects a draft with zero lines before touching the database', async () => {
    const create = vi.fn();
    const controller = await createController({ purchaseOrder: { create } });

    await expect(
      call(controller.create(officer), { ...validInput(), lines: [] }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([0, -2, 1.5])('rejects the ordered quantity %s', async (quantity) => {
    const create = vi.fn();
    const controller = await createController({ purchaseOrder: { create } });

    await expect(
      call(controller.create(officer), {
        ...validInput(),
        lines: [{ productId: 'p1', quantity, unitPrice: '10.00' }],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['-1.00', '10', '10.5'])('rejects the unit price %j', async (unitPrice) => {
    const create = vi.fn();
    const controller = await createController({ purchaseOrder: { create } });

    await expect(
      call(controller.create(officer), {
        ...validInput(),
        lines: [{ productId: 'p1', quantity: 2, unitPrice }],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate SKU (same product twice) before touching the database', async () => {
    const create = vi.fn();
    const controller = await createController({ purchaseOrder: { create } });

    await expect(
      call(controller.create(officer), {
        ...validInput(),
        lines: [
          { productId: 'p1', quantity: 2, unitPrice: '10.00' },
          { productId: 'p1', quantity: 3, unitPrice: '12.00' },
        ],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 404 for a supplier that does not exist', async () => {
    const create = vi.fn();
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue(null) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      purchaseOrder: { create },
    });

    await expect(call(controller.create(officer), validInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { code: 'SUPPLIER_NOT_FOUND' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 404 for a destination store that does not exist', async () => {
    const create = vi.fn();
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue(null) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      purchaseOrder: { create },
    });

    await expect(call(controller.create(officer), validInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { code: 'STORE_NOT_FOUND' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an inactive product', async () => {
    const create = vi.fn();
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product({ isActive: false })]) },
      purchaseOrder: { create },
    });

    await expect(call(controller.create(officer), validInput())).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { code: 'PRODUCT_INACTIVE' },
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('PurchaseOrdersController.update (edit a draft, PO-01)', () => {
  it('replaces the header and lines of a draft', async () => {
    const deleteMany = vi.fn();
    const update = vi.fn().mockResolvedValue(
      poRow({
        expectedReceiptDate: new Date('2026-03-01T00:00:00.000Z'),
        total: D('36.00'),
      }),
    );
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(poRow()), update },
      purchaseOrderLine: { deleteMany },
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
    });
    const controller = await createController({ $transaction });

    const result = await call(controller.update(officer), {
      id: 'po1',
      supplierId: 'sup1',
      storeId: 'b01',
      expectedReceiptDate: '2026-03-01',
      lines: [{ productId: 'p1', quantity: 3, unitPrice: '12.00' }],
    });

    expect(deleteMany).toHaveBeenCalledWith({ where: { purchaseOrderId: 'po1' } });
    expect(result).toMatchObject({ id: 'po1', total: '36.00' });
    const data = update.mock.calls[0]?.[0].data;
    expect(data.total.toFixed(2)).toBe('36.00');
    expect(data.lines.create[0]).toMatchObject({ quantity: 3 });
  });

  it('rejects an edit that leaves the order with zero lines', async () => {
    const deleteMany = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(poRow()), update: vi.fn() },
      purchaseOrderLine: { deleteMany },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.update(officer), {
        id: 'po1',
        supplierId: 'sup1',
        storeId: 'b01',
        expectedReceiptDate: '2026-03-01',
        lines: [],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('answers 404 for an order that does not exist', async () => {
    const lock = vi.fn().mockResolvedValue([]);
    const controller = await createController({
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn({ $queryRaw: lock })),
    });

    await expect(
      call(controller.update(officer), {
        id: 'nope',
        supplierId: 'sup1',
        storeId: 'b01',
        expectedReceiptDate: '2026-03-01',
        lines: [{ productId: 'p1', quantity: 1, unitPrice: '1.00' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { code: 'PURCHASE_ORDER_NOT_FOUND' } });
  });
});

describe('PurchaseOrdersController.get / list (viewing)', () => {
  it('shows a draft with its supplier, store and lines', async () => {
    const controller = await createController({
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(poRow()) },
    });

    await expect(call(controller.get(officer), { id: 'po1' })).resolves.toMatchObject({
      id: 'po1',
      status: 'DRAFT',
      supplierCode: 'SUP01',
      storeCode: 'B01',
      expectedReceiptDate: '2026-02-01',
      lines: [{ sku: 'SKU001', quantity: 2, unitPrice: '10.00' }],
    });
  });

  it('answers 404 for an order that does not exist', async () => {
    const controller = await createController({
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(call(controller.get(officer), { id: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { code: 'PURCHASE_ORDER_NOT_FOUND' },
    });
  });

  it('lists newest first with pagination', async () => {
    const findMany = vi.fn().mockResolvedValue([poRow()]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ purchaseOrder: { findMany, count } });

    const result = await call(controller.list(officer), { page: 1, pageSize: 20 });

    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }),
    );
  });
});

describe('PurchaseOrdersController roles (NFR-01)', () => {
  const reflector = new Reflector();
  const rolesOf = async (method: keyof PurchaseOrdersController) => {
    const controller = await createController({});
    return reflector.get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller)[method] as () => unknown,
    );
  };

  it.each(['create', 'update', 'get', 'list'] as const)(
    'only a purchasing officer may %s',
    async (method) => {
      expect(await rolesOf(method)).toEqual(['PURCHASING_OFFICER']);
    },
  );
});
