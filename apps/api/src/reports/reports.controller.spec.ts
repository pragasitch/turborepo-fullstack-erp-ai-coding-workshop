import { Test } from '@nestjs/testing';
import { call } from '@orpc/server';
import { ORPCError } from '@orpc/nest';
import type { Prisma } from '@erp/database';
import type { User } from '@erp/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service.js';
import { ReportsController } from './reports.controller.js';

async function createController(queryRaw: ReturnType<typeof vi.fn>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ReportsController],
    providers: [{ provide: PrismaService, useValue: { $queryRaw: queryRaw } }],
  }).compile();
  return moduleRef.get(ReportsController);
}

function user(role: User['role'], storeId: string | null): User {
  return { id: 'u1', email: 'u@erp.local', name: 'U', role, storeId };
}

/** A row as the shared stock-level query returns it. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    productId: 'p3',
    sku: 'SKU003',
    productName: 'น้ำยาซักผ้า',
    unit: 'ถุง',
    storeId: 's1',
    storeCode: 'B01',
    storeName: 'สาขาเซ็นทรัล',
    quantity: 0,
    reorderThreshold: 3,
    total: 1,
    ...overrides,
  };
}

const manager = user('MANAGER', null);
const defaults = { page: 1, pageSize: 20 };

/** Both reports share one contract shape and one store permission (RPT-02). */
const reports = [
  ['stock-on-hand', 'stockOnHand'],
  ['low-stock', 'lowStock'],
] as const;

describe.each(reports)('ReportsController %s report (RPT-02)', (_name, route) => {
  it('returns the rows with quantity, threshold and the low-stock flag', async () => {
    const controller = await createController(vi.fn().mockResolvedValue([row()]));

    const result = await call(controller[route](manager), defaults);

    expect(result).toEqual({
      items: [
        {
          productId: 'p3',
          sku: 'SKU003',
          productName: 'น้ำยาซักผ้า',
          unit: 'ถุง',
          storeId: 's1',
          storeCode: 'B01',
          storeName: 'สาขาเซ็นทรัล',
          quantity: 0,
          reorderThreshold: 3,
          isLowStock: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it('returns an empty page with total 0 when nothing matches', async () => {
    const controller = await createController(vi.fn().mockResolvedValue([]));

    await expect(
      call(controller[route](manager), { ...defaults, search: 'nope' }),
    ).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('passes the product search and the requested store to the query as parameters', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const controller = await createController(queryRaw);

    await call(controller[route](manager), { ...defaults, search: 'SKU003', storeId: 's1' });

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.values).toEqual(expect.arrayContaining(['%SKU003%', 's1']));
  });

  it('lets a manager span every store', async () => {
    const queryRaw = vi.fn().mockResolvedValue([row(), row({ storeId: 's2', storeCode: 'B02' })]);
    const controller = await createController(queryRaw);

    const { items } = await call(controller[route](manager), defaults);

    expect(items.map((i) => i.storeCode)).toEqual(['B01', 'B02']);
  });

  it('confines a store employee to their assigned store when no store is requested', async () => {
    const queryRaw = vi.fn().mockResolvedValue([row()]);
    const controller = await createController(queryRaw);

    await call(controller[route](user('STORE_EMPLOYEE', 's1')), defaults);

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.values).toContain('s1');
  });

  it('rejects a store employee asking for another store and never queries', async () => {
    const queryRaw = vi.fn();
    const controller = await createController(queryRaw);

    const error = await call(controller[route](user('STORE_EMPLOYEE', 's1')), {
      ...defaults,
      storeId: 's2',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe('FORBIDDEN');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('rejects a store employee with no assigned store', async () => {
    const queryRaw = vi.fn();
    const controller = await createController(queryRaw);

    await expect(call(controller[route](user('STORE_EMPLOYEE', null)), defaults)).rejects.toThrow(
      ORPCError,
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

/** The daily sales report issues two raw queries: the page of rows, then the day count. */
function dailyController(rows: unknown[], count = rows.length) {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce([{ count: BigInt(count) }]);
  return { queryRaw, controller: createController(queryRaw) };
}

const dayRow = (overrides: Record<string, unknown> = {}) => ({
  day: new Date('2026-01-02T00:00:00.000Z'),
  documentCount: BigInt(2),
  unitsSold: BigInt(5),
  totalAmount: '300.00',
  ...overrides,
});

const dailyInput = { from: '2026-01-02', to: '2026-01-02', page: 1, pageSize: 20 };

describe('ReportsController daily sales report (RPT-01)', () => {
  it('maps the per-day rows to count, units and a two-decimal total', async () => {
    const { controller } = dailyController([dayRow()]);

    const result = await call((await controller).dailySales(manager), dailyInput);

    expect(result).toEqual({
      items: [{ date: '2026-01-02', documentCount: 2, unitsSold: 5, totalAmount: '300.00' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it('returns an empty page with total 0 when no day matches', async () => {
    const { controller } = dailyController([], 0);

    await expect(
      call((await controller).dailySales(manager), { ...dailyInput, from: '2026-02-01', to: '2026-02-01' }),
    ).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('confines a store employee to their assigned store when no store is requested', async () => {
    const { queryRaw, controller } = dailyController([dayRow()]);

    await call((await controller).dailySales(user('STORE_EMPLOYEE', 's1')), dailyInput);

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.values).toContain('s1');
  });

  it('rejects a store employee asking for another store and never queries', async () => {
    const queryRaw = vi.fn();
    const controller = await createController(queryRaw);

    const error = await call(controller.dailySales(user('STORE_EMPLOYEE', 's1')), {
      ...dailyInput,
      storeId: 's2',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe('FORBIDDEN');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('rejects a store employee with no assigned store', async () => {
    const queryRaw = vi.fn();
    const controller = await createController(queryRaw);

    await expect(
      call(controller.dailySales(user('STORE_EMPLOYEE', null)), dailyInput),
    ).rejects.toThrow(ORPCError);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('lets a manager filter by an explicit store', async () => {
    const { queryRaw, controller } = dailyController([dayRow()]);

    await call((await controller).dailySales(manager), { ...dailyInput, storeId: 's2' });

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.values).toContain('s2');
  });
});
