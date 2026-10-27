import { expect, test, type APIRequestContext } from '@playwright/test';
import { storageState } from './accounts.js';

/** Resolve the seeded SKU001 / B01 ids through the inventory API (manager can read all stores). */
async function waterB01Ids(request: APIRequestContext) {
  const response = await request.get('/api/inventory?search=SKU001&pageSize=100');
  expect(response.ok(), `inventory search returned ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    items: { sku: string; storeCode: string; productId: string; storeId: string }[];
  };
  const row = body.items.find((i) => i.sku === 'SKU001' && i.storeCode === 'B01');
  expect(row, 'SKU001 in B01 is seeded').toBeTruthy();
  return { productId: row!.productId, storeId: row!.storeId };
}

test.describe('stock adjustments', () => {
  test.use({ storageState: storageState('manager') });

  test('a Manager adjusts stock up and down with a reason and sees the audit record; an over-reduction is rejected', async ({
    page,
    request,
  }) => {
    const { productId, storeId } = await waterB01Ids(request);

    async function adjust(quantity: string, reason: string) {
      await page.getByLabel('รหัสสินค้า').fill(productId);
      await page.getByLabel('รหัสสาขา').fill(storeId);
      await page.getByLabel('จำนวนที่ปรับ (+ เพิ่ม / - ลด)').fill(quantity);
      await page.getByLabel('เหตุผล').fill(reason);
      await page.getByRole('button', { name: 'บันทึกการปรับสต็อก' }).click();
    }

    await page.goto('/adjustments');
    await expect(page.getByRole('heading', { name: 'ปรับสต็อก' })).toBeVisible();

    // Up: SKU001 B01 starts at 10 -> 15.
    await adjust('5', 'รับสินค้าเพิ่มจากการนับสต็อก');
    await expect(page.getByRole('status')).toContainText('คงเหลือ 15');

    // Down: 15 -> 13.
    await adjust('-2', 'สินค้าชำรุด');
    await expect(page.getByRole('status')).toContainText('คงเหลือ 13');

    // Both adjustments appear in the audit trail.
    await expect(page.getByRole('listitem').filter({ hasText: 'ADJ-000001' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'ADJ-000002' })).toBeVisible();

    // A reduction larger than the balance is rejected with the Thai envelope; stock unchanged.
    await adjust('-999', 'ทดสอบการลดเกิน');
    await expect(page.getByRole('alert')).toContainText('สต็อกไม่เพียงพอ');

    // The movement history (seam 4 / inventory) still shows the post-adjustment balance of 13.
    const search = await request.get('/api/inventory?search=SKU001&pageSize=100');
    const body = (await search.json()) as { items: { storeCode: string; quantity: number }[] };
    expect(body.items.find((i) => i.storeCode === 'B01')?.quantity).toBe(13);
  });
});
