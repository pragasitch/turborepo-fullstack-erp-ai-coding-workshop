import { expect, test, type Page } from '@playwright/test';
import { storageState } from './accounts.js';

async function chooseHeader(page: Page, date: string) {
  const supplier = page.getByRole('option', { name: /SUP01/ });
  await expect(supplier).toHaveCount(1);
  await page.getByLabel('ผู้ขาย').selectOption((await supplier.getAttribute('value')) ?? '');
  const store = page.getByRole('option', { name: /B01/ });
  await expect(store).toHaveCount(1);
  await page.getByLabel('สาขาปลายทาง').selectOption((await store.getAttribute('value')) ?? '');
  await page.getByLabel('วันที่คาดว่าจะได้รับ').fill(date);
}

async function addLine(page: Page, sku: string, quantity: string, unitPrice: string) {
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

// Demo (PO-01): A Purchasing officer creates and edits a draft purchase order against
// SUP01 with B01 as the destination store. Supplier SUP01, store B01 and the seeded
// products come from the Section 8.1 fixture; the officer is buyer01@erp.local.
test.describe('purchase order drafts', () => {
  test.use({ storageState: storageState('buyer') });

  test('buyer01 creates a draft PO against SUP01 for B01, then edits it', async ({ page }) => {
    await page.goto('/purchase-orders');
    await expect(page.getByRole('heading', { name: 'ใบสั่งซื้อ' })).toBeVisible();

    // Create: SUP01 → B01, 2 x SKU001 @ 45.00 = 90.00.
    await chooseHeader(page, '2026-02-01');
    await addLine(page, 'SKU001', '2', '45.00');
    await page.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }).click();

    // The saved draft summary. "ยอดรวมทั้งหมด" and "สาขาปลายทาง" appear only in the summary,
    // not in the list below (which reads "สาขา B01"), so these locate the summary unambiguously.
    await expect(page.getByText('ยอดรวมทั้งหมด 90.00 บาท')).toBeVisible();
    await expect(page.getByText(/ผู้ขาย SUP01 · สาขาปลายทาง B01/)).toBeVisible();

    // Edit: change the date and bump the quantity to 3 @ 50.00 = 150.00.
    await page.getByRole('button', { name: 'แก้ไขใบสั่งซื้อ' }).click();
    await page.getByLabel('วันที่คาดว่าจะได้รับ').fill('2026-03-01');
    await page.getByRole('button', { name: 'ลบ SKU001' }).click();
    await addLine(page, 'SKU001', '3', '50.00');
    await page.getByRole('button', { name: 'บันทึกการแก้ไขใบสั่งซื้อ' }).click();

    await expect(page.getByText('ยอดรวมทั้งหมด 150.00 บาท')).toBeVisible();
    await expect(page.getByText(/สาขาปลายทาง B01 · รับวันที่ 2026-03-01/)).toBeVisible();
  });
});

// Demo (PO-02, PO-03, PO-04, NFR-03): A Purchasing officer submits a draft; a Manager
// approves or rejects it with a reason; an illegal transition is rejected with a Thai
// error; an Approved order cannot be edited.
test.describe('purchase order approval', () => {
  test.use({ storageState: storageState('buyer') });

  let sequence = 0;
  /** A total no other test's order has: the list shows no order number to find ours by. */
  function uniquePrice() {
    sequence += 1;
    const n = 100000 + ((Date.now() + test.info().parallelIndex * 7919 + sequence * 31) % 900000);
    return `${n}.00`;
  }

  const rowWithTotal = (page: Page, price: string) =>
    page.getByRole('listitem').filter({ hasText: new RegExp(`(?<!\\d)${price} บาท`) });

  /** The officer drafts one SKU001 line for SUP01 -> B01 on the page and returns the new id. */
  async function createDraft(page: Page, price: string) {
    await page.goto('/purchase-orders');
    await chooseHeader(page, '2026-02-01');
    await addLine(page, 'SKU001', '1', price);
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/purchase-orders') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }).click();
    const { id } = (await (await created).json()) as { id: string };
    await expect(page.getByText(`ยอดรวมทั้งหมด ${price} บาท`)).toBeVisible();
    return id;
  }

  async function submitDraft(page: Page, price: string) {
    const row = rowWithTotal(page, price);
    await expect(row).toContainText('ฉบับร่าง');
    await row.getByRole('button', { name: 'ส่งขออนุมัติ' }).click();
    await expect(row).toContainText('รออนุมัติ');
  }

  test('a Purchasing officer submits a draft, a Manager approves it with a reason, an illegal transition is rejected in Thai, and an Approved order cannot be edited', async ({
    page,
    browser,
  }) => {
    const price = uniquePrice();
    const id = await createDraft(page, price);

    // Submit: the draft moves to Pending Approval and can no longer be edited from the page.
    await submitDraft(page, price);
    await expect(page.getByRole('button', { name: 'แก้ไขใบสั่งซื้อ' })).toHaveCount(0);

    const managerContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: storageState('manager'),
    });
    try {
      // Approve: the confirm button stays disabled until a reason is typed.
      const managerPage = await managerContext.newPage();
      await managerPage.goto('/purchase-orders');
      const managerRow = rowWithTotal(managerPage, price);
      await expect(managerRow).toContainText('รออนุมัติ');
      await managerRow.getByRole('button', { name: 'อนุมัติใบสั่งซื้อ' }).click();
      const confirm = managerRow.getByRole('button', { name: 'ยืนยันการอนุมัติ' });
      await expect(confirm).toBeDisabled();
      await managerRow.getByLabel('เหตุผล').fill('ราคาเหมาะสมกับตลาด');
      await confirm.click();
      await expect(managerRow).toContainText('อนุมัติแล้ว');
      await expect(managerRow).toContainText('เหตุผล: ราคาเหมาะสมกับตลาด');
      await expect(managerRow.getByRole('button')).toHaveCount(0);

      // An illegal transition: an Approved order cannot be cancelled or approved again.
      for (const action of ['cancel', 'approve'] as const) {
        const response = await managerContext.request.post(`/api/purchase-orders/${id}/${action}`, {
          data: { reason: 'ลองอีกครั้ง' },
        });
        expect(response.status()).toBe(409);
        const body = (await response.json()) as { data: { code: string; message: string } };
        expect(body.data.code).toBe('PURCHASE_ORDER_INVALID_TRANSITION');
        expect(body.data.message).toBe('ไม่สามารถดำเนินการนี้กับใบสั่งซื้อในสถานะปัจจุบันได้');
      }
    } finally {
      await managerContext.close();
    }

    // An Approved order cannot be edited: the API refuses with a Thai error, nothing changes.
    const edit = await page.request.put(`/api/purchase-orders/${id}`, {
      data: {
        supplierId: 'any',
        storeId: 'any',
        expectedReceiptDate: '2026-05-01',
        lines: [{ productId: 'any', quantity: 99, unitPrice: '1.00' }],
      },
    });
    expect(edit.status()).toBe(409);
    const refused = (await edit.json()) as { data: { code: string; message: string } };
    expect(refused.data).toMatchObject({
      code: 'PURCHASE_ORDER_NOT_EDITABLE',
      message: 'แก้ไขได้เฉพาะใบสั่งซื้อฉบับร่างเท่านั้น',
    });

    // The officer still sees it, Approved, with no action left to take.
    await page.reload();
    const row = rowWithTotal(page, price);
    await expect(row).toContainText('อนุมัติแล้ว');
    await expect(row.getByRole('button')).toHaveCount(0);
  });

  test('a Manager rejects a submitted order with a reason and the rejected order stays viewable', async ({
    page,
    browser,
  }) => {
    const price = uniquePrice();
    await createDraft(page, price);
    await submitDraft(page, price);

    const managerContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: storageState('manager'),
    });
    try {
      const managerPage = await managerContext.newPage();
      await managerPage.goto('/purchase-orders');
      const managerRow = rowWithTotal(managerPage, price);
      await managerRow.getByRole('button', { name: 'ปฏิเสธใบสั่งซื้อ' }).click();
      await managerRow.getByLabel('เหตุผล').fill('ราคาสูงเกินไป');
      await managerRow.getByRole('button', { name: 'ยืนยันการปฏิเสธ' }).click();
      await expect(managerRow).toContainText('ไม่อนุมัติ');
      await expect(managerRow).toContainText('เหตุผล: ราคาสูงเกินไป');
    } finally {
      await managerContext.close();
    }

    // Rejected orders remain viewable by the officer; there is nothing to resubmit.
    await page.reload();
    const row = rowWithTotal(page, price);
    await expect(row).toContainText('ไม่อนุมัติ');
    await expect(row).toContainText('เหตุผล: ราคาสูงเกินไป');
    await expect(row.getByRole('button')).toHaveCount(0);
  });

  test('a Manager who acts on an order that was cancelled meanwhile sees a Thai error', async ({
    page,
    browser,
  }) => {
    const price = uniquePrice();
    const id = await createDraft(page, price);
    await submitDraft(page, price);

    const managerContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: storageState('manager'),
    });
    try {
      const managerPage = await managerContext.newPage();
      await managerPage.goto('/purchase-orders');
      const managerRow = rowWithTotal(managerPage, price);
      await managerRow.getByRole('button', { name: 'อนุมัติใบสั่งซื้อ' }).click();
      await managerRow.getByLabel('เหตุผล').fill('ตกลง');

      // The officer cancels it before the manager confirms.
      const cancelled = await page.request.post(`/api/purchase-orders/${id}/cancel`, {
        data: { reason: 'สั่งผิดผู้ขาย' },
      });
      expect(cancelled.ok()).toBeTruthy();

      await managerRow.getByRole('button', { name: 'ยืนยันการอนุมัติ' }).click();
      await expect(managerPage.getByRole('alert')).toContainText(
        'ไม่สามารถดำเนินการนี้กับใบสั่งซื้อในสถานะปัจจุบันได้',
      );
    } finally {
      await managerContext.close();
    }
  });
});
