import { expect, test, type APIRequestContext } from '@playwright/test';
import { storageState } from './accounts.js';

// Demo (RPT-01, AC-08): A Manager views a daily sales report for B01 over a date range
// and sees document count, units and total; a day with no sales shows zero totals and an
// empty-state message. A store employee confirms a sale through the API so it has a real
// Asia/Bangkok confirmation day; the Manager then reads the report for that day.

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** Today's Asia/Bangkok calendar day, "YYYY-MM-DD" — the reporting day a sale now lands in. */
function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

type StockRow = { sku: string; storeCode: string; productId: string; storeId: string };

test.describe('daily sales report', () => {
  test.use({ storageState: storageState('manager') });

  test('a Manager sees B01 totals for a day with a sale, and an empty state for a day with none', async ({
    page,
    playwright,
    baseURL,
  }) => {
    const suffix = Date.now();
    const sku = `E2E-RPT-${suffix}`;

    // Set up this test's own product and B01 stock, then confirm a sale, all via the API.
    const admin = await playwright.request.newContext({
      baseURL,
      storageState: storageState('admin'),
    });
    const manager = await playwright.request.newContext({
      baseURL,
      storageState: storageState('manager'),
    });
    const staff = await playwright.request.newContext({
      baseURL,
      storageState: storageState('staff'),
    });

    // 2 units @ 60.00 → total 120.00 for one confirmed document.
    await json(
      await admin.post('/api/products', {
        data: {
          sku,
          name: 'สินค้าทดสอบรายงาน',
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
      await staff.post('/api/sales', {
        data: { lines: [{ productId: b01.productId, quantity: 2 }] },
      }),
    );
    await json(
      await staff.post(`/api/sales/${draft.id}/confirm`, {
        headers: { 'Idempotency-Key': `rpt-${suffix}` },
      }),
    );

    const today = bangkokToday();

    // A day with a sale: the report shows one document, two units and 120.00.
    await page.goto('/reports/daily-sales');
    await expect(page.getByRole('heading', { name: 'รายงานการขายรายวัน' })).toBeVisible();
    await page.getByLabel('ตั้งแต่วันที่').fill(today);
    await page.getByLabel('ถึงวันที่').fill(today);

    const row = page.getByRole('row', { name: new RegExp(today) });
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible();
    await expect(row.getByRole('cell', { name: '120.00', exact: true })).toBeVisible();

    // A day with no sales (far future): zero totals and the empty-state message.
    await page.getByLabel('ตั้งแต่วันที่').fill('2099-01-01');
    await page.getByLabel('ถึงวันที่').fill('2099-01-01');
    await expect(page.getByText('ไม่มีการขายในช่วงวันที่ที่เลือก')).toBeVisible();
    await expect(page.getByText(/ยอดขายรวม 0.00 บาท/)).toBeVisible();

    await admin.dispose();
    await manager.dispose();
    await staff.dispose();
  });
});
