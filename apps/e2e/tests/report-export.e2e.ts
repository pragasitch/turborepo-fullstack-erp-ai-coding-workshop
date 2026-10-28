import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { storageState } from './accounts.js';

// Demo (RPT-04): A Manager exports a Thai sales report that opens correctly in a
// spreadsheet; a cell whose value starts with `=` is neutralized.
//
// "Opens correctly" is a UTF-8 byte order mark in front of Thai text. The sales report has
// no free-text cells, so the "=" cell is a product name in the stock report export, which
// the same Manager exports in the same test. Sales go through store B01 with this test's own
// product; the file's totals are not asserted because other tests sell at B01 on the same day.

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** Today's Asia/Bangkok calendar day, "YYYY-MM-DD" — the reporting day a sale now lands in. */
function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

type StockRow = { sku: string; storeCode: string; productId: string; storeId: string };

test.describe('report CSV export', () => {
  test.use({ storageState: storageState('manager') });

  test('a Manager exports a Thai sales report with a BOM, and a cell starting with = is neutralized', async ({
    page,
    playwright,
    baseURL,
  }) => {
    const suffix = Date.now();
    const sku = `E2E-CSV-${suffix}`;
    const formulaName = '=HYPERLINK("http://evil.example","คลิก")';

    const admin = await playwright.request.newContext({
      baseURL,
      storageState: storageState('admin'),
    });
    const manager = await playwright.request.newContext({
      baseURL,
      storageState: storageState('manager'),
    });
    const staffB01 = await playwright.request.newContext({
      baseURL,
      storageState: storageState('staff'),
    });

    // This test's own product, named like a formula, with B01 stock and one confirmed sale.
    await json(
      await admin.post('/api/products', {
        data: {
          sku,
          name: formulaName,
          category: 'ทดสอบ',
          unit: 'แพ็ค',
          sellingPrice: '60.00',
        },
      }),
    );
    const stock = await json<{ items: StockRow[] }>(
      await manager.get(`/api/inventory?search=${sku}&pageSize=100`),
    );
    const b01 = stock.items.find((row) => row.sku === sku && row.storeCode === 'B01')!;
    await json(
      await manager.post('/api/adjustments', {
        data: {
          productId: b01.productId,
          storeId: b01.storeId,
          quantityChange: 10,
          reason: 'ยอดยกมาสำหรับการทดสอบ',
        },
      }),
    );
    const draft = await json<{ id: string }>(
      await staffB01.post('/api/sales', {
        data: { lines: [{ productId: b01.productId, quantity: 2 }] },
      }),
    );
    await json(
      await staffB01.post(`/api/sales/${draft.id}/confirm`, {
        headers: { 'Idempotency-Key': `csv-${suffix}` },
      }),
    );

    const today = bangkokToday();

    // The sales report for today at B01, exported from the screen.
    await page.goto('/reports/daily-sales');
    await expect(page.getByRole('heading', { name: 'รายงานการขายรายวัน' })).toBeVisible();
    const b01Option = page.getByRole('option', { name: /^B01 / });
    await expect(b01Option).toHaveCount(1);
    await page.getByLabel('สาขา').selectOption((await b01Option.getAttribute('value')) ?? '');
    await page.getByLabel('ตั้งแต่วันที่').fill(today);
    await page.getByLabel('ถึงวันที่').fill(today);
    await expect(page.getByRole('row', { name: new RegExp(today) })).toBeVisible();

    const salesDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ส่งออก CSV' }).click();
    const salesFile = await salesDownload;
    expect(salesFile.suggestedFilename()).toBe(`daily-sales_${today}_${today}.csv`);
    const salesBytes = await readFile(await salesFile.path());
    expect([...salesBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const salesLines = salesBytes.toString('utf8').split('\r\n');
    expect(salesLines[0]).toBe('\uFEFFวันที่,จำนวนใบขาย,จำนวนหน่วย,ยอดขาย (บาท)');
    expect(salesLines[1]).toMatch(new RegExp(`^${today},\\d+,\\d+,\\d+\\.\\d{2}$`));

    // The stock report with the "=" product name, exported from its screen.
    await page.goto('/reports/stock');
    await page.getByLabel('ค้นหา SKU ชื่อสินค้า หรือสาขา').fill(sku);
    await page.getByRole('button', { name: 'ค้นหา' }).click();
    await expect(page.getByRole('row', { name: new RegExp(sku) }).first()).toBeVisible();

    const stockDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ส่งออก CSV สต็อกคงเหลือ' }).click();
    const stockFile = await stockDownload;
    const stockBytes = await readFile(await stockFile.path());
    expect([...stockBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const stockCsv = stockBytes.toString('utf8');
    expect(stockCsv).toContain(`${sku},"'=HYPERLINK(""http://evil.example"",""คลิก"")",แพ็ค,B01,`);
    expect(stockCsv).not.toMatch(/(^|,|\r\n)=/);

    await admin.dispose();
    await manager.dispose();
    await staffB01.dispose();
  });
});
