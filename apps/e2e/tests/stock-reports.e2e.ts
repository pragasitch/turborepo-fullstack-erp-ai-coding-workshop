import { expect, test } from '@playwright/test';
import { storageState } from './accounts.js';

test.describe('stock reports', () => {
  test.use({ storageState: storageState('manager') });

  test('a Manager views B01 stock-on-hand and low-stock reports; SKU003 at balance 0 appears in the low-stock report because it is at or below its threshold of 3', async ({
    page,
  }) => {
    await page.goto('/reports/stock');
    await expect(page.getByRole('heading', { name: 'รายงานสต็อก', exact: true })).toBeVisible();

    await page.getByLabel('ค้นหา SKU ชื่อสินค้า หรือสาขา').fill('B01');
    await page.getByRole('button', { name: 'ค้นหา' }).click();

    // Stock on hand: every B01 product is listed, SKU003 at zero included.
    const onHand = page.getByRole('region', { name: 'สต็อกคงเหลือ', exact: true });
    await expect(onHand.getByRole('row', { name: /^SKU001 .* B01 / })).toBeVisible();
    const zeroStock = onHand.getByRole('row', { name: /^SKU003 .* B01 / });
    await expect(zeroStock.getByRole('cell', { name: '0', exact: true })).toBeVisible();
    await expect(onHand.getByRole('row', { name: / B02 / })).toHaveCount(0);

    // Low stock: SKU003 at 0 is at or below its threshold of 3.
    const low = page.getByRole('region', { name: 'สินค้าสต็อกต่ำ', exact: true });
    const detergent = low.getByRole('row', { name: /^SKU003 .* B01 / });
    await expect(detergent.getByRole('cell', { name: '0', exact: true })).toBeVisible();
    await expect(detergent.getByRole('cell', { name: '3', exact: true })).toBeVisible();
    await expect(detergent.getByText('สต็อกต่ำ')).toBeVisible();
    await expect(low.getByRole('row', { name: / B02 / })).toHaveCount(0);
  });
});
