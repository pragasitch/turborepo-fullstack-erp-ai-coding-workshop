import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { call } from '@orpc/server';
import { ORPCError } from '@orpc/nest';
import type { User } from '@erp/contracts';
import { Decimal } from '@erp/database';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { SalesController } from './sales.controller.js';

async function createController(prisma: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [SalesController],
    providers: [{ provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(SalesController);
}

function user(role: User['role'], storeId: string | null): User {
  return { id: `${role}-1`, email: `${role}@erp.local`, name: role, role, storeId };
}

const staffB01 = user('STORE_EMPLOYEE', 'b01');
const staffB02 = user('STORE_EMPLOYEE', 'b02');
const manager = user('MANAGER', null);

const KEY = 'confirm-key-0001';
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

function saleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    documentNumber: null,
    status: 'DRAFT',
    storeId: 'b01',
    store: { code: 'B01' },
    createdById: staffB01.id,
    confirmedById: null,
    total: D('120.00'),
    idempotencyKey: null,
    confirmedAt: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    lines: [
      {
        id: 'l1',
        saleId: 's1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'น้ำดื่มแพ็ค 6',
        unit: 'แพ็ค',
        quantity: 2,
        unitPrice: D('60.00'),
        lineTotal: D('120.00'),
        idempotencyKey: null,
        balanceAfter: null,
      },
    ],
    ...overrides,
  };
}

const confirmedRow = (overrides: Record<string, unknown> = {}) =>
  saleRow({
    status: 'CONFIRMED',
    documentNumber: 'SAL-000001',
    confirmedById: staffB01.id,
    idempotencyKey: KEY,
    confirmedAt: new Date('2026-01-02T01:00:00.000Z'),
    ...overrides,
  });

/** A stub whose transaction runs against `tx`, with the row lock answering `lockedId`. */
function withTransaction(tx: Record<string, unknown>, lockedId = 's1') {
  const full = { $queryRaw: vi.fn().mockResolvedValue([{ id: lockedId }]), ...tx };
  return { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(full)), tx: full };
}

describe('SalesController.create (SAL-01)', () => {
  it('creates a draft at the current selling price for the employee’s store', async () => {
    const create = vi.fn().mockResolvedValue(saleRow());
    const controller = await createController({
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      sale: { create },
    });

    const result = await call(controller.create(staffB01), {
      lines: [{ productId: 'p1', quantity: 2 }],
    });

    expect(result).toMatchObject({
      status: 'DRAFT',
      documentNumber: null,
      storeCode: 'B01',
      total: '120.00',
      lines: [{ sku: 'SKU001', quantity: 2, unitPrice: '60.00', lineTotal: '120.00' }],
    });
    // Store and price come from the server, not the request.
    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ storeId: 'b01', createdById: staffB01.id });
    expect(data.total.toFixed(2)).toBe('120.00');
    expect(data.lines.create[0].unitPrice.toFixed(2)).toBe('60.00');
  });

  it('rejects a price override before touching the database', async () => {
    const create = vi.fn();
    const controller = await createController({ sale: { create }, product: { findMany: vi.fn() } });

    await expect(
      call(controller.create(staffB01), {
        lines: [{ productId: 'p1', quantity: 1, unitPrice: '1.00' }],
      } as never),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([0, -2, 1.5])('rejects the quantity %s', async (quantity) => {
    const create = vi.fn();
    const controller = await createController({ sale: { create }, product: { findMany: vi.fn() } });

    await expect(
      call(controller.create(staffB01), { lines: [{ productId: 'p1', quantity }] }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an inactive product', async () => {
    const create = vi.fn();
    const controller = await createController({
      product: { findMany: vi.fn().mockResolvedValue([product({ isActive: false })]) },
      sale: { create },
    });

    await expect(
      call(controller.create(staffB01), { lines: [{ productId: 'p1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT', data: { code: 'PRODUCT_INACTIVE' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a store employee with no assigned store', async () => {
    const create = vi.fn();
    const controller = await createController({ sale: { create }, product: { findMany: vi.fn() } });

    await expect(
      call(controller.create(user('STORE_EMPLOYEE', null)), {
        lines: [{ productId: 'p1', quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('SalesController.confirm (SAL-02, SAL-03)', () => {
  it('requires an Idempotency-Key', async () => {
    const controller = await createController({ $transaction: vi.fn() });

    await expect(
      call(controller.confirm(staffB01), { params: { id: 's1' }, headers: {} } as never),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('returns the stored sale for a replay of the same key and posts nothing', async () => {
    const stock = { $executeRaw: vi.fn(), stockMovement: { create: vi.fn() } };
    const { $transaction } = withTransaction({
      sale: { findUniqueOrThrow: vi.fn().mockResolvedValue(confirmedRow()), update: vi.fn() },
      ...stock,
    });
    const controller = await createController({ $transaction });

    const result = await call(controller.confirm(staffB01), {
      params: { id: 's1' },
      headers: { 'idempotency-key': KEY },
    });

    expect(result).toMatchObject({ status: 'CONFIRMED', documentNumber: 'SAL-000001' });
    expect(stock.$executeRaw).not.toHaveBeenCalled();
    expect(stock.stockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a new key on a sale that is already confirmed', async () => {
    const update = vi.fn();
    const { $transaction } = withTransaction({
      sale: { findUniqueOrThrow: vi.fn().mockResolvedValue(confirmedRow()), update },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), {
        params: { id: 's1' },
        headers: { 'idempotency-key': 'another-key-0002' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', data: { code: 'SALE_ALREADY_CONFIRMED' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a store employee confirming another store’s sale', async () => {
    const { $transaction } = withTransaction({
      sale: { findUniqueOrThrow: vi.fn().mockResolvedValue(saleRow()) },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB02), {
        params: { id: 's1' },
        headers: { 'idempotency-key': KEY },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('answers 404 for a sale that does not exist', async () => {
    const lock = vi.fn().mockResolvedValue([]);
    const controller = await createController({
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn({ $queryRaw: lock })),
    });

    await expect(
      call(controller.confirm(staffB01), {
        params: { id: 'nope' },
        headers: { 'idempotency-key': KEY },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { code: 'SALE_NOT_FOUND' } });
  });

  it('rejects an inactive product at confirmation, before any stock moves', async () => {
    const executeRaw = vi.fn();
    const { $transaction } = withTransaction({
      sale: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(saleRow()),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      product: { findMany: vi.fn().mockResolvedValue([product({ isActive: false })]) },
      $executeRaw: executeRaw,
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.confirm(staffB01), {
        params: { id: 's1' },
        headers: { 'idempotency-key': KEY },
      }),
    ).rejects.toMatchObject({ data: { code: 'PRODUCT_INACTIVE' } });
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe('confirmed sales are final (SAL-04)', () => {
  it('rejects an edit and leaves the lines alone', async () => {
    const deleteMany = vi.fn();
    const { $transaction } = withTransaction({
      sale: { findUniqueOrThrow: vi.fn().mockResolvedValue(confirmedRow()), update: vi.fn() },
      saleLine: { deleteMany },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.update(staffB01), { id: 's1', lines: [{ productId: 'p1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT', data: { code: 'SALE_CONFIRMED_IMMUTABLE' } });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'return'] as const)('rejects a %s attempt', async (action) => {
    const controller = await createController({
      sale: { findUnique: vi.fn().mockResolvedValue(confirmedRow()) },
    });

    await expect(call(controller[action](staffB01), { id: 's1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { code: 'SALE_CONFIRMED_IMMUTABLE' },
    });
  });

  it.each(['cancel', 'return'] as const)('does not offer %s for a draft either', async (action) => {
    const controller = await createController({
      sale: { findUnique: vi.fn().mockResolvedValue(saleRow()) },
    });

    await expect(call(controller[action](staffB01), { id: 's1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { code: 'SALE_ACTION_UNAVAILABLE' },
    });
  });
});

describe('SalesController.get / list (viewing)', () => {
  it('shows a confirmed sale with its number, lines and balances', async () => {
    const row = confirmedRow();
    row.lines[0]!.balanceAfter = 8 as never;
    const controller = await createController({
      sale: { findUnique: vi.fn().mockResolvedValue(row) },
    });

    await expect(call(controller.get(staffB01), { id: 's1' })).resolves.toMatchObject({
      status: 'CONFIRMED',
      documentNumber: 'SAL-000001',
      confirmedAt: '2026-01-02T01:00:00.000Z',
      lines: [{ sku: 'SKU001', balanceAfter: 8 }],
    });
  });

  it('hides another store’s sale from a store employee', async () => {
    const controller = await createController({
      sale: { findUnique: vi.fn().mockResolvedValue(saleRow()) },
    });

    await expect(call(controller.get(staffB02), { id: 's1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets a manager view any store', async () => {
    const controller = await createController({
      sale: { findUnique: vi.fn().mockResolvedValue(saleRow()) },
    });

    await expect(call(controller.get(manager), { id: 's1' })).resolves.toMatchObject({ id: 's1' });
  });

  it('lists newest first, confined to a store employee’s store, with pagination', async () => {
    const findMany = vi.fn().mockResolvedValue([saleRow()]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ sale: { findMany, count } });

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

  it('lists every store for a manager', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const controller = await createController({
      sale: { findMany, count: vi.fn().mockResolvedValue(0) },
    });

    await call(controller.list(manager), { page: 1, pageSize: 20 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});

describe('SalesController roles', () => {
  const reflector = new Reflector();
  const rolesOf = async (method: keyof SalesController) => {
    const controller = await createController({});
    return reflector.get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller)[method] as () => unknown,
    );
  };

  it.each(['create', 'update', 'confirm', 'cancel', 'return'] as const)(
    'only a store employee may %s',
    async (method) => {
      expect(await rolesOf(method)).toEqual(['STORE_EMPLOYEE']);
    },
  );

  it.each(['get', 'list'] as const)('store employees, managers and administrators may %s', async (method) => {
    expect(await rolesOf(method)).toEqual(['STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR']);
  });
});
