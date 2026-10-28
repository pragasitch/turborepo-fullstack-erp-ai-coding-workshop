import { hashPassword } from './password.js';
import { Role, type PrismaClient } from './generated/prisma/client.js';

/**
 * The TOR Section 8.1 starting data, encoded once. It is the canonical acceptance
 * dataset: the demo seed applies it non-destructively, and the Postgres integration
 * harness resets to it before every scenario.
 *
 * Not yet encoded: purchase order PO-DEMO-001 (20 x SKU001 @ 45.00, Approved for B01).
 * The purchase order models land with their own ticket, which extends this fixture.
 */
export const DEMO_PASSWORD = 'password';

export const FIXTURE_STORES = [
  { code: 'B01', name: 'สาขาเซ็นทรัล' },
  { code: 'B02', name: 'สาขาริเวอร์ไซด์' },
] as const;

export const FIXTURE_SUPPLIER = { code: 'SUP01', name: 'SupplyOne Co Ltd' } as const;

/**
 * Demo accounts, matching TOR Section 8.1 (plus an administrator for master data).
 * `storeCode` assigns a STORE_EMPLOYEE to their store; other roles are not store-scoped.
 */
export const FIXTURE_USERS = [
  { email: 'buyer01@erp.local', name: 'Buyer 01', role: Role.PURCHASING_OFFICER, storeCode: null },
  { email: 'staff_b01@erp.local', name: 'Staff B01', role: Role.STORE_EMPLOYEE, storeCode: 'B01' },
  { email: 'staff_b02@erp.local', name: 'Staff B02', role: Role.STORE_EMPLOYEE, storeCode: 'B02' },
  { email: 'manager01@erp.local', name: 'Manager 01', role: Role.MANAGER, storeCode: null },
  {
    email: 'administrator@erp.local',
    name: 'Administrator',
    role: Role.ADMINISTRATOR,
    storeCode: null,
  },
] as const;

/** Every product has a reorder threshold of 3 in both stores; all B02 balances are zero. */
export const FIXTURE_REORDER_THRESHOLD = 3;

export const FIXTURE_PRODUCTS = [
  {
    sku: 'SKU001',
    name: 'น้ำดื่มแพ็ค 6',
    category: 'เครื่องดื่ม',
    unit: 'แพ็ค',
    sellingPrice: '60.00',
    b01Stock: 10,
  },
  {
    sku: 'SKU002',
    name: 'กระดาษทิชชู่',
    category: 'ของใช้ในบ้าน',
    unit: 'แพ็ค',
    sellingPrice: '35.00',
    b01Stock: 5,
  },
  {
    sku: 'SKU003',
    name: 'น้ำยาซักผ้า',
    category: 'ของใช้ในบ้าน',
    unit: 'ถุง',
    sellingPrice: '120.00',
    b01Stock: 0,
  },
] as const;

// Hashing is deliberately slow; do it once per process, not once per scenario.
let passwordHash: Promise<string> | undefined;
function demoPasswordHash() {
  passwordHash ??= hashPassword(DEMO_PASSWORD);
  return passwordHash;
}

/**
 * Apply the Section 8.1 data without removing anything. Re-runnable: stores, supplier,
 * users and products are upserted, and opening balances are created only when missing,
 * so restarting the dev stack never overwrites live stock. Used by the demo seed.
 */
export async function seedSection81(prisma: PrismaClient) {
  const storeIdByCode = new Map<string, string>();
  for (const store of FIXTURE_STORES) {
    const row = await prisma.store.upsert({
      where: { code: store.code },
      update: { name: store.name },
      create: store,
    });
    storeIdByCode.set(store.code, row.id);
  }

  await prisma.supplier.upsert({
    where: { code: FIXTURE_SUPPLIER.code },
    update: { name: FIXTURE_SUPPLIER.name },
    create: FIXTURE_SUPPLIER,
  });

  const hash = await demoPasswordHash();
  for (const user of FIXTURE_USERS) {
    const storeId = user.storeCode ? (storeIdByCode.get(user.storeCode) ?? null) : null;
    const data = { name: user.name, role: user.role, storeId, passwordHash: hash };
    await prisma.user.upsert({
      where: { email: user.email },
      update: data,
      create: { email: user.email, ...data },
    });
  }

  for (const { b01Stock, ...product } of FIXTURE_PRODUCTS) {
    const row = await prisma.product.upsert({
      where: { sku: product.sku },
      update: {},
      create: product,
    });
    for (const [storeCode, storeId] of storeIdByCode) {
      await prisma.productReorderThreshold.upsert({
        where: { productId_storeId: { productId: row.id, storeId } },
        update: {},
        create: { productId: row.id, storeId, threshold: FIXTURE_REORDER_THRESHOLD },
      });
      // Opening balance (TOR 4.2: balances = opening + movements). B02 starts at zero.
      await prisma.stockBalance.upsert({
        where: { productId_storeId: { productId: row.id, storeId } },
        update: {},
        create: { productId: row.id, storeId, quantity: storeCode === 'B01' ? b01Stock : 0 },
      });
    }
  }
}

/**
 * Wipe every ERP table and re-apply the Section 8.1 data, so each scenario starts from
 * the same state and never depends on a previous one. TRUNCATE is the one operation the
 * immutable-ledger triggers do not block. DESTRUCTIVE: only ever point this at a
 * throwaway test database.
 */
export async function resetToSection81Fixture(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "SaleLine", "Sale", "StockMovement", "StockBalance", "DocumentSequence",
       "ProductReorderThreshold", "Product", "Supplier", "User", "Store"
     RESTART IDENTITY CASCADE`,
  );
  await seedSection81(prisma);
}
