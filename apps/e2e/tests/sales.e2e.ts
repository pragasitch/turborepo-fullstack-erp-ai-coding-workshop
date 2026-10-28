import { expect, test, type APIRequestContext } from '@playwright/test';
import { storageState } from './accounts.js';

type StockRow = {
  sku: string;
  storeCode: string;
  productId: string;
  storeId: string;
  quantity: number;
};

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** The B01 stock row for one SKU, read through the inventory API. */
async function b01Stock(request: APIRequestContext, sku: string): Promise<StockRow> {
  const body = await json<{ items: StockRow[] }>(
    await request.get(`/api/inventory?search=${sku}&pageSize=100`),
  );
  const row = body.items.find((item) => item.sku === sku && item.storeCode === 'B01');
  expect(row, `${sku} has a B01 stock row`).toBeTruthy();
  return row!;
}

test.describe('sales', () => {
  test.use({ storageState: storageState('staff') });

  test('staff_b01 sells two products and sees the total and the reduced balances; a replayed confirm changes nothing; a sale exceeding stock is rejected identifying the product', async ({
    page,
    request,
    playwright,
    baseURL,
  }) => {
    // This test's own products and stock, so it never depends on (or disturbs) the seeded
    // SKU001..SKU003 that other tests read. Prices 60.00 and 35.00 give the TOR total of 155.00.
    const suffix = Date.now();
    const skuA = `E2E-A-${suffix}`;
    const skuB = `E2E-B-${suffix}`;

    const admin = await playwright.request.newContext({
      baseURL,
      storageState: storageState('admin'),
    });
    const manager = await playwright.request.newContext({
      baseURL,
      storageState: storageState('manager'),
    });
    for (const [sku, name, price] of [
      [skuA, 'สินค้าทดสอบ A', '60.00'],
      [skuB, 'สินค้าทดสอบ B', '35.00'],
    ] as const) {
      await json(
        await admin.post('/api/products', {
          data: { sku, name, category: 'ทดสอบ', unit: 'แพ็ค', sellingPrice: price },
        }),
      );
    }
    for (const [sku, quantity] of [
      [skuA, 10],
      [skuB, 5],
    ] as const) {
      const row = await b01Stock(manager, sku);
      await json(
        await manager.post('/api/adjustments', {
          data: {
            productId: row.productId,
            storeId: row.storeId,
            quantityChange: quantity,
            reason: 'ยอดยกมาสำหรับการทดสอบ',
          },
        }),
      );
    }

    async function addLine(sku: string, quantity: string) {
      await page.getByLabel('ค้นหาสินค้า').fill(sku);
      const option = page.getByRole('option', { name: new RegExp(sku) });
      await expect(option).toHaveCount(1);
      const value = await option.getAttribute('value');
      await page.getByLabel('สินค้า', { exact: true }).selectOption(value!);
      await page.getByLabel('จำนวน').fill(quantity);
      await page.getByRole('button', { name: 'เพิ่มรายการ' }).click();
    }

    // Sell 2 of A and 1 of B: THB 155.00, balances 8 and 4.
    await page.goto('/sales');
    await expect(page.getByRole('heading', { name: 'ขายสินค้า' })).toBeVisible();
    await addLine(skuA, '2');
    await addLine(skuB, '1');
    await page.getByRole('button', { name: 'บันทึกใบขาย' }).click();
    await expect(page.getByText('ยอดรวมทั้งหมด 155.00 บาท')).toBeVisible();

    const confirmRequest = page.waitForRequest((r) => r.url().endsWith('/confirm'));
    await page.getByRole('button', { name: 'ยืนยันการขาย' }).click();
    const confirmed = await confirmRequest;
    await expect(page.getByRole('status')).toContainText('ยอดรวม 155.00 บาท');
    const documentNumber = /SAL-\d{6}/.exec(await page.getByRole('status').innerText())?.[0];
    expect(documentNumber).toBeTruthy();
    // The last column of the confirmed sale is the balance left after the line.
    await expect(
      page
        .getByRole('row', { name: new RegExp(skuA) })
        .getByRole('cell')
        .last(),
    ).toHaveText('8');
    await expect(
      page
        .getByRole('row', { name: new RegExp(skuB) })
        .getByRole('cell')
        .last(),
    ).toHaveText('4');
    expect((await b01Stock(request, skuA)).quantity).toBe(8);
    expect((await b01Stock(request, skuB)).quantity).toBe(4);

    // Replay the very same confirm (same Idempotency-Key): the original sale comes back, stock is unchanged.
    const key = confirmed.headers()['idempotency-key'];
    expect(key).toBeTruthy();
    const replay = await json<{ documentNumber: string; total: string }>(
      await request.post(new URL(confirmed.url()).pathname, {
        headers: { 'Idempotency-Key': key! },
      }),
    );
    expect(replay).toMatchObject({ documentNumber, total: '155.00' });
    expect((await b01Stock(request, skuA)).quantity).toBe(8);
    expect((await b01Stock(request, skuB)).quantity).toBe(4);

    // Selling more than is left is rejected, names the product, and changes nothing.
    await page.getByRole('button', { name: 'เริ่มใบขายใหม่' }).click();
    await addLine(skuA, '9');
    await page.getByRole('button', { name: 'บันทึกใบขาย' }).click();
    await page.getByRole('button', { name: 'ยืนยันการขาย' }).click();
    await expect(page.getByRole('alert')).toContainText(
      `${skuA} สินค้าทดสอบ A: ต้องการ 9 คงเหลือ 8`,
    );
    await expect(page.getByRole('status')).toHaveCount(0);
    expect((await b01Stock(request, skuA)).quantity).toBe(8);

    await admin.dispose();
    await manager.dispose();
  });
});
