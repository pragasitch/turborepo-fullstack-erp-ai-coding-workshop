import { expect, test, type APIRequestContext } from '@playwright/test';
import { storageState } from './accounts.js';

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** The id of the row with this code, paging through a master-data list newest first. */
async function idByCode(request: APIRequestContext, path: string, code: string): Promise<string> {
  for (let page = 1; page <= 20; page += 1) {
    const body = await json<{ items: { id: string; code: string }[]; total: number }>(
      await request.get(`${path}?page=${page}&pageSize=100`),
    );
    const found = body.items.find((item) => item.code === code);
    if (found) return found.id;
    if (page * 100 >= body.total) break;
  }
  throw new Error(`${code} not found at ${path}`);
}

/** The B01 stock quantity of one SKU, read through the inventory API. */
async function b01Quantity(request: APIRequestContext, sku: string): Promise<number> {
  const body = await json<{ items: { sku: string; storeCode: string; quantity: number }[] }>(
    await request.get(`/api/inventory?search=${sku}&pageSize=100`),
  );
  const row = body.items.find((item) => item.sku === sku && item.storeCode === 'B01');
  expect(row, `${sku} has a B01 stock row`).toBeTruthy();
  return row!.quantity;
}

test.describe('goods receipts', () => {
  test.use({ storageState: storageState('staff') });

  test('staff_b01 receives part of an approved order (the PO-DEMO-001 scenario: 20 ordered), sees outstanding update and the order move to Partially Received; a replayed confirm returns the original receipt; an over-receipt is rejected', async ({
    page,
    request,
    playwright,
    baseURL,
  }) => {
    // This test's own product and approved order, so it never depends on (or disturbs) the
    // seeded PO-DEMO-001 that other runs may already have received against. A new product
    // starts at 0 in B01, so receiving 8 of 20 leaves the balance at 8 and 12 outstanding.
    const sku = `E2E-GR-${Date.now()}`;
    const contexts = {
      admin: await playwright.request.newContext({ baseURL, storageState: storageState('admin') }),
      buyer: await playwright.request.newContext({ baseURL, storageState: storageState('buyer') }),
      manager: await playwright.request.newContext({
        baseURL,
        storageState: storageState('manager'),
      }),
    };
    try {
      const product = await json<{ id: string }>(
        await contexts.admin.post('/api/products', {
          data: {
            sku,
            name: 'สินค้าทดสอบรับของ',
            category: 'ทดสอบ',
            unit: 'แพ็ค',
            sellingPrice: '60.00',
          },
        }),
      );
      const [supplierId, storeId] = await Promise.all([
        idByCode(contexts.admin, '/api/suppliers', 'SUP01'),
        idByCode(contexts.admin, '/api/stores', 'B01'),
      ]);
      const order = await json<{ id: string }>(
        await contexts.buyer.post('/api/purchase-orders', {
          data: {
            supplierId,
            storeId,
            expectedReceiptDate: '2026-02-01',
            lines: [{ productId: product.id, quantity: 20, unitPrice: '45.00' }],
          },
        }),
      );
      await json(await contexts.buyer.post(`/api/purchase-orders/${order.id}/submit`));
      await json(
        await contexts.manager.post(`/api/purchase-orders/${order.id}/approve`, {
          data: { reason: 'อนุมัติเพื่อทดสอบรับสินค้า' },
        }),
      );

      await page.goto('/goods-receipts');
      await expect(page.getByRole('heading', { name: 'รับสินค้า', level: 1 })).toBeVisible();
      const card = page.getByRole('region').filter({ hasText: sku });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText('อนุมัติแล้ว');
      const cells = card.getByRole('cell');
      // Ordered 20, received 0, outstanding 20.
      await expect(cells.nth(1)).toHaveText('20');
      await expect(cells.nth(2)).toHaveText('0');
      await expect(cells.nth(3)).toHaveText('20');

      // Receive 8 of 20.
      const confirmRequest = page.waitForRequest(
        (r) => r.url().endsWith('/api/goods-receipts') && r.method() === 'POST',
      );
      await card.getByLabel(`รับครั้งนี้ ${sku}`).fill('8');
      await card.getByRole('button', { name: 'ยืนยันการรับสินค้า' }).click();
      const confirmed = await confirmRequest;
      await expect(page.getByRole('status')).toContainText('สถานะใบสั่งซื้อ: รับบางส่วน');
      const documentNumber = /GR-\d{6}/.exec(await page.getByRole('status').innerText())?.[0];
      expect(documentNumber).toBeTruthy();

      // Outstanding updated to 12, the order is Partially Received, B01 stock is 8.
      await expect(cells.nth(2)).toHaveText('8');
      await expect(cells.nth(3)).toHaveText('12');
      await expect(card.getByText('รับบางส่วน')).toBeVisible();
      expect(await b01Quantity(request, sku)).toBe(8);
      await expect(page.getByRole('listitem').filter({ hasText: documentNumber! })).toContainText(
        `${sku} × 8`,
      );

      // Replay the very same confirm (same Idempotency-Key and body): the original receipt
      // comes back and nothing changes.
      const key = confirmed.headers()['idempotency-key'];
      expect(key).toBeTruthy();
      const replay = await json<{ documentNumber: string }>(
        await request.post('/api/goods-receipts', {
          headers: { 'Idempotency-Key': key! },
          data: JSON.parse(confirmed.postData() ?? '{}') as Record<string, unknown>,
        }),
      );
      expect(replay.documentNumber).toBe(documentNumber);
      expect(await b01Quantity(request, sku)).toBe(8);
      await page.reload();
      await expect(cells.nth(2)).toHaveText('8');
      await expect(cells.nth(3)).toHaveText('12');

      // Receiving more than is outstanding (13 against 12) is rejected, names the product,
      // and changes nothing.
      await card.getByLabel(`รับครั้งนี้ ${sku}`).fill('13');
      await card.getByRole('button', { name: 'ยืนยันการรับสินค้า' }).click();
      await expect(card.getByRole('alert')).toContainText(
        `${sku} สินค้าทดสอบรับของ: รับได้อีกไม่เกิน 12 แต่ต้องการรับ 13`,
      );
      expect(await b01Quantity(request, sku)).toBe(8);
      await expect(cells.nth(3)).toHaveText('12');
    } finally {
      await Promise.all(Object.values(contexts).map((context) => context.dispose()));
    }
  });
});
