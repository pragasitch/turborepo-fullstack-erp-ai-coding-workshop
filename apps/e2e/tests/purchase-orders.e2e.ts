import { expect, test } from '@playwright/test';
import { storageState } from './accounts.js';

// Demo (PO-01): A Purchasing officer creates and edits a draft purchase order against
// SUP01 with B01 as the destination store. Supplier SUP01, store B01 and the seeded
// products come from the Section 8.1 fixture; the officer is buyer01@erp.local.
test.describe('purchase order drafts', () => {
  test.use({ storageState: storageState('buyer') });

  test('buyer01 creates a draft PO against SUP01 for B01, then edits it', async ({ page }) => {
    async function chooseHeader(date: string) {
      const supplier = page.getByRole('option', { name: /SUP01/ });
      await expect(supplier).toHaveCount(1);
      await page.getByLabel('ผู้ขาย').selectOption((await supplier.getAttribute('value')) ?? '');
      const store = page.getByRole('option', { name: /B01/ });
      await expect(store).toHaveCount(1);
      await page.getByLabel('สาขาปลายทาง').selectOption((await store.getAttribute('value')) ?? '');
      await page.getByLabel('วันที่คาดว่าจะได้รับ').fill(date);
    }

    async function addLine(sku: string, quantity: string, unitPrice: string) {
      // Match the SKU exactly: other e2e files leave products whose SKU starts with a
      // seeded one (e.g. "SKU001-<timestamp>"), so a loose /SKU001/ would match two options.
      // Option text is "<sku> <name>", so anchor to the SKU followed by a space.
      const option = page.getByRole('option', { name: new RegExp(`^${sku} `) });
      await expect(option).toHaveCount(1);
      await page
        .getByLabel('สินค้า', { exact: true })
        .selectOption((await option.getAttribute('value')) ?? '');
      await page.getByLabel('จำนวน').fill(quantity);
      await page.getByLabel('ราคาต่อหน่วย').fill(unitPrice);
      await page.getByRole('button', { name: 'เพิ่มรายการ' }).click();
    }

    await page.goto('/purchase-orders');
    await expect(page.getByRole('heading', { name: 'ใบสั่งซื้อ' })).toBeVisible();

    // Create: SUP01 → B01, 2 x SKU001 @ 45.00 = 90.00.
    await chooseHeader('2026-02-01');
    await addLine('SKU001', '2', '45.00');
    await page.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }).click();

    // The saved draft summary. "ยอดรวมทั้งหมด" and "สาขาปลายทาง" appear only in the summary,
    // not in the list below (which reads "สาขา B01"), so these locate the summary unambiguously.
    await expect(page.getByText('ยอดรวมทั้งหมด 90.00 บาท')).toBeVisible();
    await expect(page.getByText(/ผู้ขาย SUP01 · สาขาปลายทาง B01/)).toBeVisible();

    // Edit: change the date and bump the quantity to 3 @ 50.00 = 150.00.
    await page.getByRole('button', { name: 'แก้ไขใบสั่งซื้อ' }).click();
    await page.getByLabel('วันที่คาดว่าจะได้รับ').fill('2026-03-01');
    await page.getByRole('button', { name: 'ลบ SKU001' }).click();
    await addLine('SKU001', '3', '50.00');
    await page.getByRole('button', { name: 'บันทึกการแก้ไขใบสั่งซื้อ' }).click();

    await expect(page.getByText('ยอดรวมทั้งหมด 150.00 บาท')).toBeVisible();
    await expect(page.getByText(/สาขาปลายทาง B01 · รับวันที่ 2026-03-01/)).toBeVisible();
  });
});
