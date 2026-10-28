import { oc } from '@orpc/contract';
import { InventoryListQuerySchema, InventoryListSchema } from './inventory.js';

/**
 * Stock reports (RPT-02). Both reports list one row per (product, store) with the same
 * shape as the stock search (INV-01), filtered by store and a product search term, and
 * the same store permission applies: a Store employee only ever gets their own store.
 *
 * - Stock on hand: every (product, store) pair, zero-stock products included.
 * - Low stock: only the pairs whose balance is at or below the store's reorder
 *   threshold. A pair with no threshold is never low.
 */
export const StockReportQuerySchema = InventoryListQuerySchema;
export const StockReportSchema = InventoryListSchema;

export const reportsContract = {
  stockOnHand: oc
    .route({
      method: 'GET',
      path: '/reports/stock-on-hand',
      summary: 'Stock-on-hand report by store, with product search',
      tags: ['Reports'],
    })
    .input(StockReportQuerySchema)
    .output(StockReportSchema),
  lowStock: oc
    .route({
      method: 'GET',
      path: '/reports/low-stock',
      summary: 'Low-stock report by store: balance at or below the reorder threshold',
      tags: ['Reports'],
    })
    .input(StockReportQuerySchema)
    .output(StockReportSchema),
};
