import type { User } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { useSection81Fixture } from '../../test/integration/harness.js';
import type { PrismaService } from '../database/prisma.service.js';
import { ReportsController } from './reports.controller.js';

// Seam 4 for RPT-04: the exports run against real Postgres on the Section 8.1 fixture, so
// the BOM, the Thai text and the formula guard are checked on bytes that came out of the
// database, and the export is compared with the on-screen report over the same data.

const db = useSection81Fixture();

function controller() {
  return new ReportsController(db.prisma as unknown as PrismaService);
}

async function signedIn(email: string): Promise<User> {
  const row = await db.user(email);
  return { id: row.id, email: row.email, name: row.name, role: row.role, storeId: row.storeId };
}

async function bytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** The file's text with the BOM kept, so tests can see it. */
async function text(file: File): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await bytes(file));
}

const STOCK_HEADER = 'รหัสสินค้า,ชื่อสินค้า,หน่วย,รหัสสาขา,ชื่อสาขา,คงเหลือ,จุดสั่งซื้อ,สต็อกต่ำ';

describe('stock report CSV export against Postgres (RPT-04)', () => {
  it('writes the fixture products in Thai, UTF-8 with a BOM', async () => {
    const manager = await signedIn('manager01@erp.local');
    const b01 = await db.store('B01');

    const file = await call(controller().exportStockOnHand(manager), { storeId: b01.id });

    expect([...(await bytes(file)).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = (await text(file)).split('\r\n');
    expect(lines[0]).toBe('\uFEFF' + STOCK_HEADER);
    expect(lines.slice(1, 4)).toEqual([
      'SKU001,น้ำดื่มแพ็ค 6,แพ็ค,B01,สาขาเซ็นทรัล,10,3,ไม่ใช่',
      'SKU002,กระดาษทิชชู่,แพ็ค,B01,สาขาเซ็นทรัล,5,3,ไม่ใช่',
      'SKU003,น้ำยาซักผ้า,ถุง,B01,สาขาเซ็นทรัล,0,3,ใช่',
    ]);
  });

  it('neutralizes a product name that starts with "=" so a spreadsheet will not evaluate it', async () => {
    await db.prisma.product.update({
      where: { sku: 'SKU002' },
      data: { name: '=HYPERLINK("http://evil.example","คลิก")' },
    });
    const manager = await signedIn('manager01@erp.local');
    const b01 = await db.store('B01');

    const csv = await text(
      await call(controller().exportStockOnHand(manager), { storeId: b01.id }),
    );

    expect(csv).toContain(`SKU002,"'=HYPERLINK(""http://evil.example"",""คลิก"")",แพ็ค,`);
    expect(csv).not.toMatch(/(^|,|\r\n)=/);
  });

  it('exports the same rows as the on-screen report for the same filters', async () => {
    const manager = await signedIn('manager01@erp.local');

    const screen = await call(controller().stockOnHand(manager), {
      page: 1,
      pageSize: 100,
      search: 'SKU00',
    });
    const file = await call(controller().exportStockOnHand(manager), { search: 'SKU00' });

    const dataLines = (await text(file)).split('\r\n').slice(1, -1);
    expect(dataLines.map((line) => line.split(',').slice(0, 1)[0])).toEqual(
      screen.items.map((item) => item.sku),
    );
    expect(dataLines).toHaveLength(screen.total);
  });

  it('low-stock export lists only the pairs the low-stock report lists', async () => {
    const manager = await signedIn('manager01@erp.local');
    const b01 = await db.store('B01');

    const csv = await text(await call(controller().exportLowStock(manager), { storeId: b01.id }));

    expect(csv).toBe(
      '\uFEFF' + STOCK_HEADER + '\r\nSKU003,น้ำยาซักผ้า,ถุง,B01,สาขาเซ็นทรัล,0,3,ใช่\r\n',
    );
  });

  it("gives a store employee only their own store's rows, and refuses another store", async () => {
    const staffB01 = await signedIn('staff_b01@erp.local');
    const b02 = await db.store('B02');

    const own = await text(await call(controller().exportStockOnHand(staffB01), {}));
    expect(own).toContain(',B01,');
    expect(own).not.toContain(',B02,');

    await expect(
      call(controller().exportStockOnHand(staffB01), { storeId: b02.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('daily sales CSV export against Postgres (RPT-04)', () => {
  async function confirmedSale(storeCode: string, quantity: number, confirmedAt: Date) {
    const [store, product, who] = await Promise.all([
      db.store(storeCode),
      db.product('SKU001'),
      db.user('staff_b01@erp.local'),
    ]);
    const lineTotal = (60 * quantity).toFixed(2);
    const uniq = `${confirmedAt.getTime()}-${storeCode}`;
    await db.prisma.sale.create({
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
            unitPrice: '60.00',
            lineTotal,
            balanceAfter: 0,
          },
        },
      },
    });
  }

  it('writes a Thai-headed CSV of confirmed sales per Bangkok day, with a BOM', async () => {
    await confirmedSale('B01', 2, new Date('2026-01-02T16:59:59.000Z')); // 2nd, Bangkok
    await confirmedSale('B01', 5, new Date('2026-01-02T17:00:01.000Z')); // 3rd, Bangkok
    const manager = await signedIn('manager01@erp.local');

    const file = await call(controller().exportDailySales(manager), {
      from: '2026-01-02',
      to: '2026-01-03',
    });

    expect([...(await bytes(file)).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await text(file)).toBe(
      '\uFEFFวันที่,จำนวนใบขาย,จำนวนหน่วย,ยอดขาย (บาท)\r\n' +
        '2026-01-03,1,5,300.00\r\n' +
        '2026-01-02,1,2,120.00\r\n',
    );
  });

  it('applies the store filter: a manager exporting B02 gets none of the B01 sales', async () => {
    await confirmedSale('B01', 2, new Date('2026-01-02T05:00:00.000Z'));
    const manager = await signedIn('manager01@erp.local');
    const b02 = await db.store('B02');

    const csv = await text(
      await call(controller().exportDailySales(manager), {
        from: '2026-01-02',
        to: '2026-01-02',
        storeId: b02.id,
      }),
    );

    expect(csv).toBe('\uFEFFวันที่,จำนวนใบขาย,จำนวนหน่วย,ยอดขาย (บาท)\r\n');
  });

  it("refuses a store employee exporting another store's sales", async () => {
    const staffB01 = await signedIn('staff_b01@erp.local');
    const b02 = await db.store('B02');

    await expect(
      call(controller().exportDailySales(staffB01), {
        from: '2026-01-02',
        to: '2026-01-02',
        storeId: b02.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
