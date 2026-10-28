import { expect, test, type APIRequestContext } from '@playwright/test';
import { storageState } from './accounts.js';

// Demo (RPT-03): A Manager filters stock movement history across stores by type and date
// and reads the source document on a row; a Store employee (staff_b01) sees only their own
// store's movements.
//
// The first test creates its own product and posts an ADJUSTMENT movement in each of B01
// and B02 via the API, then reads the movement-history screen as a Manager. Filtering to
// this product keeps the assertions deterministic on the shared, parallel e2e database.

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** Today's Asia/Bangkok calendar day, "YYYY-MM-DD" — the day the new movements land in. */
function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

type StockRow = { sku: string; storeCode: string; productId: string; storeId: string };

test.describe('stock movement history - manager', () => {
  test.use({ storageState: storageState('manager') });

  test('a Manager filters across stores by type and date and reads a source document', async ({
    page,
    playwright,
    baseURL,
  }) => {
    const suffix = Date.now();
    const sku = `E2E-MOV-${suffix}`;

    const admin = await playwright.request.newContext({
      baseURL,
      storageState: storageState('admin'),
    });
    const manager = await playwright.request.newContext({
      baseURL,
      storageState: storageState('manager'),
    });

    // This test's own product, then one ADJUSTMENT movement in each store, via the API.
    await json(
      await admin.post('/api/products', {
        data: {
          sku,
          name: 'สินค้าทดสอบประวัติ',
          category: 'ทดสอบ',
          unit: 'ชิ้น',
          sellingPrice: '10.00',
        },
      }),
    );
    const stock = await json<{ items: StockRow[] }>(
      await manager.get(`/api/inventory?search=${sku}&pageSize=100`),
    );
    const b01 = stock.items.find((row) => row.sku === sku && row.storeCode === 'B01')!;
    const b02 = stock.items.find((row) => row.sku === sku && row.storeCode === 'B02')!;

    for (const target of [b01, b02]) {
      await json(
        await manager.post('/api/adjustments', {
          data: {
            productId: target.productId,
            storeId: target.storeId,
            quantityChange: 7,
            reason: 'ยอดยกมาสำหรับการทดสอบประวัติ',
          },
        }),
      );
    }

    const today = bangkokToday();

    // Filter to this product and to ADJUSTMENT movements, over today.
    await page.goto('/reports/movement-history');
    await expect(page.getByRole('heading', { name: 'ประวัติการเคลื่อนไหวสต็อก' })).toBeVisible();

    const productOption = page.getByRole('option', { name: new RegExp(sku) });
    await expect(productOption).toHaveCount(1);
    await page.getByLabel('สินค้า').selectOption((await productOption.getAttribute('value')) ?? '');
    await page.getByLabel('ประเภท').selectOption('ADJUSTMENT');
    await page.getByLabel('ตั้งแต่วันที่').fill(today);
    await page.getByLabel('ถึงวันที่').fill(today);

    // Both stores show for a Manager, and each row carries its source document (ADJUSTMENT).
    await expect(page.getByRole('cell', { name: 'B01', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'B02', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: /ADJUSTMENT/ }).first()).toBeVisible();

    await admin.dispose();
    await manager.dispose();
  });
});

test.describe('stock movement history - store employee', () => {
  test.use({ storageState: storageState('staff') });

  test('a Store employee sees only their own store in the history', async ({ page }) => {
    // staff_b01 is assigned to B01; the API confines them to it (NFR-01). Over a wide date
    // range the history must never show a B02 row, whatever other tests posted at B02.
    await page.goto('/reports/movement-history');
    await expect(page.getByRole('heading', { name: 'ประวัติการเคลื่อนไหวสต็อก' })).toBeVisible();
    await page.getByLabel('ตั้งแต่วันที่').fill('2000-01-01');
    await page.getByLabel('ถึงวันที่').fill('2999-12-31');

    // The store column never shows B02 for a B01 employee.
    await expect(page.getByRole('cell', { name: 'B02', exact: true })).toHaveCount(0);
  });
});
