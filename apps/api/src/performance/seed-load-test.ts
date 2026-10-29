/**
 * Seed a target database to NFR-05 scale (1,000 products, 10,000 movements) for the load
 * test. DESTRUCTIVE: truncates every ERP table, so point it only at a disposable database.
 *
 * Run: pnpm --filter @erp/api load-test:seed
 * Honours DATABASE_URL (defaults to the local dev database). Override the volume with
 * LOAD_PRODUCTS and LOAD_MOVEMENTS.
 */
import { createPrismaClient, seedPerformanceDataset } from '@erp/database';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgresql://erp:erp@localhost:5432/erp';
  const products = Number(process.env.LOAD_PRODUCTS ?? 1_000);
  const movements = Number(process.env.LOAD_MOVEMENTS ?? 10_000);

  const prisma = createPrismaClient(url);
  try {
    console.log(`Seeding ${products} products and ${movements} movements into ${url} …`);
    const { manager, storeIds } = await seedPerformanceDataset(prisma, { products, movements });
    console.log(`Done. Manager ${manager.email} (password "password"), stores ${storeIds.length}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
