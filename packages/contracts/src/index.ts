import { adjustmentsContract } from './adjustments.js';
import { authContract } from './auth.js';
import { healthContract } from './health.js';
import { inventoryContract } from './inventory.js';
import { productsContract } from './products.js';
import { storesContract } from './stores.js';
import { suppliersContract } from './suppliers.js';

export * from './adjustments.js';
export * from './auth.js';
export * from './health.js';
export * from './inventory.js';
export * from './products.js';
export * from './stores.js';
export * from './suppliers.js';

/**
 * The single source of truth for the HTTP API.
 * - apps/api implements it (see `@Implement(...)` in the Nest controllers)
 * - apps/web calls it through a fully typed client (see `src/lib/orpc.ts`)
 *
 * Add new feature contracts here, e.g. `customers: customersContract`.
 */
export const contract = {
  adjustments: adjustmentsContract,
  auth: authContract,
  health: healthContract,
  inventory: inventoryContract,
  products: productsContract,
  stores: storesContract,
  suppliers: suppliersContract,
};

export type Contract = typeof contract;
