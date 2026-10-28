import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ORPCError } from '@orpc/nest';
import { call } from '@orpc/server';
import type { Prisma } from '@erp/database';
import type { User } from '@erp/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { ReportsController } from './reports.controller.js';

// Seam 1 for RPT-04: the CSV export routes, driven through oRPC call() with a stubbed
// PrismaService. Expected CSV text below is written out by hand from the ticket, not
// derived with the code under test.

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

const manager = user('MANAGER', null);

/** The raw bytes of an exported file. */
async function bytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** The exported file as text, with the BOM left in place so tests can see it. */
async function text(file: File): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await bytes(file));
}

const BOM = '\uFEFF';

function stockRow(overrides: Record<string, unknown> = {}) {
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

const stockRoutes = [
  ['stock-on-hand', 'exportStockOnHand', 'stock-on-hand.csv'],
  ['low-stock', 'exportLowStock', 'low-stock.csv'],
] as const;

describe.each(stockRoutes)('ReportsController %s CSV export (RPT-04)', (_name, route, filename) => {
  it('is a UTF-8 CSV file that starts with a byte order mark and carries Thai text', async () => {
    const controller = await createController(vi.fn().mockResolvedValue([stockRow()]));

    const file = await call(controller[route](manager), {});

    expect(file.name).toBe(filename);
    expect(file.type).toBe('text/csv; charset=utf-8');
    expect([...(await bytes(file)).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await text(file)).toBe(
      BOM +
        'รหัสสินค้า,ชื่อสินค้า,หน่วย,รหัสสาขา,ชื่อสาขา,คงเหลือ,จุดสั่งซื้อ,สต็อกต่ำ\r\n' +
        'SKU003,น้ำยาซักผ้า,ถุง,B01,สาขาเซ็นทรัล,0,3,ใช่\r\n',
    );
  });

  it('writes a header-only file when nothing matches', async () => {
    const controller = await createController(vi.fn().mockResolvedValue([]));

    const file = await call(controller[route](manager), { search: 'nope' });

    expect(await text(file)).toBe(
      BOM + 'รหัสสินค้า,ชื่อสินค้า,หน่วย,รหัสสาขา,ชื่อสาขา,คงเหลือ,จุดสั่งซื้อ,สต็อกต่ำ\r\n',
    );
  });

  it('leaves an unset reorder threshold blank and marks a healthy row as not low', async () => {
    const controller = await createController(
      vi.fn().mockResolvedValue([stockRow({ quantity: 9, reorderThreshold: null })]),
    );

    const lines = (await text(await call(controller[route](manager), {}))).split('\r\n');

    expect(lines[1]).toBe('SKU003,น้ำยาซักผ้า,ถุง,B01,สาขาเซ็นทรัล,9,,ไม่ใช่');
  });

  it('exports every page of matching rows, not just the first', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      stockRow({ sku: `SKU${String(i).padStart(3, '0')}`, total: 130 }),
    );
    const secondPage = Array.from({ length: 30 }, (_, i) =>
      stockRow({ sku: `SKU${String(100 + i).padStart(3, '0')}`, total: 130 }),
    );
    const queryRaw = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    const controller = await createController(queryRaw);

    const lines = (await text(await call(controller[route](manager), {}))).split('\r\n');

    expect(lines).toHaveLength(1 + 130 + 1); // header, rows, trailing line break
    expect(lines[130]?.startsWith('SKU129,')).toBe(true);
  });

  it('applies the same product search and store filter as the screen', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const controller = await createController(queryRaw);

    await call(controller[route](manager), { search: 'SKU003', storeId: 's1' });

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.values).toEqual(expect.arrayContaining(['%SKU003%', 's1']));
  });

  it('confines a store employee to their assigned store', async () => {
    const queryRaw = vi.fn().mockResolvedValue([stockRow()]);
    const controller = await createController(queryRaw);

    await call(controller[route](user('STORE_EMPLOYEE', 's1')), {});

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.values).toContain('s1');
  });

  it('refuses a store employee exporting another store, and never queries', async () => {
    const queryRaw = vi.fn();
    const controller = await createController(queryRaw);

    const error = await call(controller[route](user('STORE_EMPLOYEE', 's1')), {
      storeId: 's2',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe('FORBIDDEN');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a store employee with no assigned store', async () => {
    const queryRaw = vi.fn();
    const controller = await createController(queryRaw);

    await expect(call(controller[route](user('STORE_EMPLOYEE', null)), {})).rejects.toThrow(
      ORPCError,
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('ReportsController CSV formula-injection guard (RPT-04)', () => {
  /** Export one stock row whose product name is `name`, and return its CSV data line. */
  async function exportedNameCell(name: string): Promise<string> {
    const controller = await createController(
      vi.fn().mockResolvedValue([stockRow({ productName: name })]),
    );
    const csv = await text(await call(controller.exportStockOnHand(manager), {}));
    // Data line is everything between the header's line break and the final one.
    return csv.slice(csv.indexOf('\r\n') + 2, -2);
  }

  it.each([
    ['=', '=HYPERLINK("http://evil.example","x")', `"'=HYPERLINK(""http://evil.example"",""x"")"`],
    ['+', '+66812345678', `'+66812345678`],
    ['-', '-1+1', `'-1+1`],
    ['@', '@SUM(A1:A9)', `'@SUM(A1:A9)`],
    ['tab', '\t=1+1', `'\t=1+1`],
    ['carriage return', '\r=1+1', `"'\r=1+1"`],
  ])('neutralizes a cell starting with %s', async (_label, name, cell) => {
    expect(await exportedNameCell(name)).toBe(`SKU003,${cell},ถุง,B01,สาขาเซ็นทรัล,0,3,ใช่`);
  });

  it('leaves ordinary and Thai text untouched', async () => {
    expect(await exportedNameCell('ปากกา = ดินสอ')).toBe(
      'SKU003,ปากกา = ดินสอ,ถุง,B01,สาขาเซ็นทรัล,0,3,ใช่',
    );
  });

  it('quotes a cell with a comma, a quote or a line break so columns stay aligned', async () => {
    expect(await exportedNameCell('ดินสอ, 2B')).toBe(
      'SKU003,"ดินสอ, 2B",ถุง,B01,สาขาเซ็นทรัล,0,3,ใช่',
    );
    expect(await exportedNameCell('ปากกา "ดำ"')).toBe(
      'SKU003,"ปากกา ""ดำ""",ถุง,B01,สาขาเซ็นทรัล,0,3,ใช่',
    );
    expect(await exportedNameCell('บรรทัด1\nบรรทัด2')).toBe(
      'SKU003,"บรรทัด1\nบรรทัด2",ถุง,B01,สาขาเซ็นทรัล,0,3,ใช่',
    );
  });
});

/** The daily sales report issues two raw queries per page: the rows, then the day count. */
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

const dailyInput = { from: '2026-01-01', to: '2026-01-31' };

describe('ReportsController daily sales CSV export (RPT-04)', () => {
  it('is a UTF-8 CSV file with a byte order mark and Thai column headings', async () => {
    const { controller } = dailyController([
      dayRow(),
      dayRow({ day: new Date('2026-01-01T00:00:00.000Z'), documentCount: BigInt(1) }),
    ]);

    const file = await call((await controller).exportDailySales(manager), dailyInput);

    expect(file.name).toBe('daily-sales_2026-01-01_2026-01-31.csv');
    expect(file.type).toBe('text/csv; charset=utf-8');
    expect([...(await bytes(file)).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await text(file)).toBe(
      BOM +
        'วันที่,จำนวนใบขาย,จำนวนหน่วย,ยอดขาย (บาท)\r\n' +
        '2026-01-02,2,5,300.00\r\n' +
        '2026-01-01,1,5,300.00\r\n',
    );
  });

  it('writes a header-only file for a range with no sales', async () => {
    const { controller } = dailyController([], 0);

    const file = await call((await controller).exportDailySales(manager), dailyInput);

    expect(await text(file)).toBe(BOM + 'วันที่,จำนวนใบขาย,จำนวนหน่วย,ยอดขาย (บาท)\r\n');
  });

  it('applies the same explicit store filter as the screen', async () => {
    const { queryRaw, controller } = dailyController([dayRow()]);

    await call((await controller).exportDailySales(manager), { ...dailyInput, storeId: 's2' });

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.values).toContain('s2');
  });

  it('confines a store employee to their assigned store', async () => {
    const { queryRaw, controller } = dailyController([dayRow()]);

    await call((await controller).exportDailySales(user('STORE_EMPLOYEE', 's1')), dailyInput);

    const sql = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.values).toContain('s1');
  });

  it("refuses a store employee exporting another store's sales, and never queries", async () => {
    const queryRaw = vi.fn();
    const controller = await createController(queryRaw);

    const error = await call(controller.exportDailySales(user('STORE_EMPLOYEE', 's1')), {
      ...dailyInput,
      storeId: 's2',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe('FORBIDDEN');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('is limited to the same roles as the sales screen, so a purchasing officer is refused', async () => {
    const controller = await createController(vi.fn());
    const roles = new Reflector().get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller).exportDailySales as () => unknown,
    );
    expect(roles).toEqual(['STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR']);
  });

  it.each(['exportStockOnHand', 'exportLowStock'] as const)(
    'leaves the stock export %s open to every signed-in role, like the stock reports',
    async (method) => {
      const controller = await createController(vi.fn());
      const roles = new Reflector().get<string[]>(
        ROLES_KEY,
        Object.getPrototypeOf(controller)[method] as () => unknown,
      );
      expect(roles).toBeUndefined();
    },
  );
});
