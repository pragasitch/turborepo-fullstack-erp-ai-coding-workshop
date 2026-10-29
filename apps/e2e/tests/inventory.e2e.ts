import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { storageState } from './accounts.js';

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

type StockRow = { sku: string; storeCode: string; productId: string; storeId: string };

/** The (product, store) ids for one SKU, read through the inventory API (manager sees all). */
async function stockRows(request: APIRequestContext, sku: string): Promise<StockRow[]> {
  const body = await json<{ items: StockRow[] }>(
    await request.get(`/api/inventory?search=${sku}&pageSize=100`),
  );
  return body.items.filter((row) => row.sku === sku);
}

async function search(page: Page, term: string) {
  await page.getByLabel('ค้นหา SKU ชื่อสินค้า หรือสาขา').fill(term);
  await page.getByRole('button', { name: 'ค้นหา' }).click();
}

test.describe('inventory', () => {
  test.use({ storageState: storageState('admin') });

  // The stock search (INV-01) shows quantity, unit, reorder threshold and the low-stock flag.
  // This test creates its own products with a known threshold in each store and posts its own
  // adjustments, so it never depends on (or races with) the seeded SKU001..SKU003 that the
  // adjustment, sales and report tests mutate on the shared, parallel e2e database.
  test('stock search by SKU/name/store shows quantity, unit, threshold, and low-stock status', async ({
    page,
    playwright,
    baseURL,
  }) => {
    const suffix = Date.now();
    const stocked = `E2E-INV-${suffix}`; // in stock in B01, empty in B02
    const name = 'สินค้าทดสอบสต็อก';

    const admin = await playwright.request.newContext({
      baseURL,
      storageState: storageState('admin'),
    });
    const manager = await playwright.request.newContext({
      baseURL,
      storageState: storageState('manager'),
    });

    // Resolve the two store ids so the product can carry a reorder threshold in each.
    const seedStores = await stockRows(manager, 'SKU001');
    const b01StoreId = seedStores.find((row) => row.storeCode === 'B01')!.storeId;
    const b02StoreId = seedStores.find((row) => row.storeCode === 'B02')!.storeId;

    // One product, threshold 3 in both stores. B01 is stocked to 10 (above threshold → not
    // low); B02 is left at 0 (at or below threshold → low).
    await json(
      await admin.post('/api/products', {
        data: {
          sku: stocked,
          name,
          category: 'ทดสอบ',
          unit: 'แพ็ค',
          sellingPrice: '10.00',
          reorderThresholds: [
            { storeId: b01StoreId, threshold: 3 },
            { storeId: b02StoreId, threshold: 3 },
          ],
        },
      }),
    );
    const rows = await stockRows(manager, stocked);
    const b01 = rows.find((row) => row.storeCode === 'B01')!;
    await json(
      await manager.post('/api/adjustments', {
        data: {
          productId: b01.productId,
          storeId: b01.storeId,
          quantityChange: 10,
          reason: 'ยอดยกมาสำหรับการทดสอบสต็อก',
        },
      }),
    );

    await page.goto('/inventory');
    await expect(page.getByRole('heading', { name: 'สต็อกสินค้า' })).toBeVisible();

    // By SKU: 10 packs in B01 (threshold 3, not low) and nothing in B02 (threshold 3, low).
    await search(page, stocked);
    const inB01 = page.getByRole('row', { name: new RegExp(`^${stocked} .* B01 `) });
    await expect(inB01.getByRole('cell', { name: '10', exact: true })).toBeVisible();
    await expect(inB01.getByRole('cell', { name: 'แพ็ค', exact: true })).toBeVisible();
    await expect(inB01.getByRole('cell', { name: '3', exact: true })).toBeVisible();
    await expect(inB01.getByText('ปกติ')).toBeVisible();
    const inB02 = page.getByRole('row', { name: new RegExp(`^${stocked} .* B02 `) });
    await expect(inB02.getByRole('cell', { name: '0', exact: true })).toBeVisible();
    await expect(inB02.getByText('สต็อกต่ำ')).toBeVisible();

    // By product name: the same two rows come back (both stores share the name). Search is a
    // single ILIKE over SKU, name and store code/name (stock-levels.ts), so the product name
    // returns one row per store.
    await search(page, name);
    await expect(page.getByRole('row', { name: new RegExp(`^${stocked} .* B01 `) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`^${stocked} .* B02 `) })).toBeVisible();

    // That the store token confines results to a store, and that a store employee never sees
    // another store, is proven store-side in the store-scoping specs; it cannot be asserted
    // deterministically here against the shared, parallel database (a bare "B02" search would
    // return every product's B02 row, which other tests create and delete concurrently).

    await admin.dispose();
    await manager.dispose();

    // The scripted movement and the Postgres harness halves of the Demo line are proven at
    // seam 4 (apps/api/src/inventory/*.integration.spec.ts): there is no stock-writing screen yet.
  });
});
