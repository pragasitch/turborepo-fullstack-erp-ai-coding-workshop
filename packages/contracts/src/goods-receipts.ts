import { oc } from '@orpc/contract';
import * as z from 'zod';
import { IdempotencyKeySchema } from './sales.js';

/**
 * Goods receipts (GR-01..GR-05, Q-02). A store employee receives goods against an
 * Approved or Partially Received purchase order for their assigned store, in as many
 * deliveries as it takes. Confirming a receipt issues its number, increases the
 * destination store's stock, appends the movements and moves the order to Partially
 * Received or Completed, all in one transaction. A confirmed receipt is final: there is
 * no route to edit or cancel one.
 *
 * Confirmation is idempotent on the `Idempotency-Key` header (GR-04): resending a request
 * with the same key returns the original receipt and posts nothing; a new key is a new
 * receipt. The key is unique per actor.
 *
 * The client says which order and how many of each product arrived. It never sends a
 * price, a store or a status.
 */

/** A whole number of the product's base unit, zero allowed (GR-02). */
const ReceivedQuantity = z.number().int('จำนวนต้องเป็นจำนวนเต็ม').min(0, 'จำนวนต้องไม่ติดลบ');

export const ReceiptLineInputSchema = z.strictObject({
  productId: z.string().min(1),
  quantity: ReceivedQuantity,
});
export type ReceiptLineInput = z.infer<typeof ReceiptLineInputSchema>;

export const ConfirmGoodsReceiptSchema = z.strictObject({
  purchaseOrderId: z.string().min(1),
  lines: z
    .array(ReceiptLineInputSchema)
    .min(1, 'ต้องมีรายการสินค้าอย่างน้อยหนึ่งรายการ')
    .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, {
      message: 'สินค้าแต่ละรายการต้องไม่ซ้ำกัน',
    })
    .refine((lines) => lines.some((l) => l.quantity > 0), {
      message: 'ต้องมีอย่างน้อยหนึ่งรายการที่จำนวนรับมากกว่าศูนย์',
    }),
});
export type ConfirmGoodsReceiptInput = z.infer<typeof ConfirmGoodsReceiptSchema>;

/** Header names are lower-case on the wire. */
export const ConfirmGoodsReceiptHeadersSchema = z.object({
  'idempotency-key': IdempotencyKeySchema,
});

/** The statuses an order has once something has been received against it. */
export const ReceivedOrderStatusSchema = z.enum(['PARTIALLY_RECEIVED', 'COMPLETED']);

export const GoodsReceiptLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  /** Snapshots taken when the receipt was confirmed, so master-data edits never change it. */
  sku: z.string(),
  productName: z.string(),
  unit: z.string(),
  /** Received in this delivery: a positive whole number. Zero lines are not recorded. */
  quantity: z.number().int().positive(),
  /** Stock left in the store once this line was posted. */
  balanceAfter: z.number().int().min(0),
});
export type GoodsReceiptLine = z.infer<typeof GoodsReceiptLineSchema>;

export const GoodsReceiptSchema = z.object({
  id: z.string(),
  documentNumber: z.string(),
  purchaseOrderId: z.string(),
  purchaseOrderNumber: z.string().nullable(),
  /** The order's status after this receipt (or now, when viewing an older one). */
  orderStatus: ReceivedOrderStatusSchema,
  storeId: z.string(),
  storeCode: z.string(),
  receivedById: z.string(),
  confirmedAt: z.iso.datetime(),
  lines: z.array(GoodsReceiptLineSchema),
});
export type GoodsReceipt = z.infer<typeof GoodsReceiptSchema>;

/** List query (Section 6.2): 1-based `page`, bounded `pageSize`. Newest first. */
export const GoodsReceiptListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  purchaseOrderId: z.string().min(1).optional(),
});
export type GoodsReceiptListQuery = z.infer<typeof GoodsReceiptListQuerySchema>;

export const GoodsReceiptListSchema = z.object({
  items: z.array(GoodsReceiptSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type GoodsReceiptList = z.infer<typeof GoodsReceiptListSchema>;

/** One line of an order open for receiving: what was ordered, received so far, and what is left (GR-01). */
export const ReceivableLineSchema = z.object({
  productId: z.string(),
  sku: z.string(),
  productName: z.string(),
  unit: z.string(),
  /** False once the product was deactivated after approval: it cannot be received (Q-02). */
  isActive: z.boolean(),
  ordered: z.number().int().positive(),
  received: z.number().int().min(0),
  outstanding: z.number().int().min(0),
});
export type ReceivableLine = z.infer<typeof ReceivableLineSchema>;

export const ReceivableOrderSchema = z.object({
  id: z.string(),
  documentNumber: z.string().nullable(),
  status: z.enum(['APPROVED', 'PARTIALLY_RECEIVED']),
  supplierCode: z.string(),
  storeId: z.string(),
  storeCode: z.string(),
  expectedReceiptDate: z.iso.date(),
  lines: z.array(ReceivableLineSchema),
});
export type ReceivableOrder = z.infer<typeof ReceivableOrderSchema>;

export const ReceivableOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ReceivableOrderListQuery = z.infer<typeof ReceivableOrderListQuerySchema>;

export const ReceivableOrderListSchema = z.object({
  items: z.array(ReceivableOrderSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ReceivableOrderList = z.infer<typeof ReceivableOrderListSchema>;

const IdParam = z.object({ id: z.string().min(1) });

export const goodsReceiptsContract = {
  receivableOrders: oc
    .route({
      method: 'GET',
      path: '/goods-receipts/receivable-orders',
      summary: 'Approved and Partially Received orders open for receiving, with outstanding quantities',
      tags: ['Goods receipts'],
    })
    .input(ReceivableOrderListQuerySchema)
    .output(ReceivableOrderListSchema),
  list: oc
    .route({
      method: 'GET',
      path: '/goods-receipts',
      summary: 'List goods receipts (newest first)',
      tags: ['Goods receipts'],
    })
    .input(GoodsReceiptListQuerySchema)
    .output(GoodsReceiptListSchema),
  get: oc
    .route({
      method: 'GET',
      path: '/goods-receipts/{id}',
      summary: 'View one goods receipt',
      tags: ['Goods receipts'],
    })
    .input(IdParam)
    .output(GoodsReceiptSchema),
  confirm: oc
    .route({
      method: 'POST',
      path: '/goods-receipts',
      summary: 'Confirm a goods receipt: increase stock and update the order, once per Idempotency-Key',
      tags: ['Goods receipts'],
      inputStructure: 'detailed',
    })
    .input(z.object({ body: ConfirmGoodsReceiptSchema, headers: ConfirmGoodsReceiptHeadersSchema }))
    .output(GoodsReceiptSchema),
};
