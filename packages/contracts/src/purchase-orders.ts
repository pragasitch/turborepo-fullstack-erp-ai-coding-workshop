import { oc } from '@orpc/contract';
import * as z from 'zod';

/**
 * Purchase order drafts (PO-01). A Purchasing officer raises a draft against a supplier,
 * for a destination store, with an expected receipt date and at least one product line.
 * A DRAFT is editable and never touches stock. Approval (PO-02, PO-03, PO-04) moves an
 * order through a fixed state machine, and no other transition exists:
 *
 *   DRAFT            --submit-->  PENDING_APPROVAL   (purchasing officer)
 *   PENDING_APPROVAL --approve--> APPROVED           (manager, reason)
 *   PENDING_APPROVAL --reject-->  REJECTED           (manager, reason)
 *   DRAFT            --cancel-->  CANCELLED          (creator or manager, reason)
 *   PENDING_APPROVAL --cancel-->  CANCELLED          (creator or manager, reason)
 *
 * PARTIALLY_RECEIVED and COMPLETED are reached by goods receipt, in a later ticket.
 * Creating or approving an order never changes stock. Line rules: ordered quantities are positive whole numbers, purchase unit prices
 * are non-negative, and a product appears at most once per order (no duplicate SKUs).
 *
 * Money is a two-decimal string. The client supplies the purchase unit price per line
 * (unlike a sale, where the system applies the selling price).
 */

const Money = z.string().regex(/^\d+\.\d{2}$/, 'จำนวนเงินต้องเป็นตัวเลขทศนิยมสองตำแหน่ง');

/** A non-negative money value, two decimals (PO-01: purchase unit price). */
const UnitPrice = Money;

/** A positive whole number of the product's base unit (PO-01). */
const Quantity = z.number().int('จำนวนต้องเป็นจำนวนเต็ม').positive('จำนวนต้องมากกว่าศูนย์');

/** A calendar date with no time, e.g. "2026-02-01" (expected receipt date). */
const CalendarDate = z.iso.date('วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD');

/**
 * What the client may say about a line: which product, how many, and at what price.
 * Strict, so an unexpected field is rejected rather than silently dropped.
 */
export const PurchaseOrderLineInputSchema = z.strictObject({
  productId: z.string().min(1),
  quantity: Quantity,
  unitPrice: UnitPrice,
});
export type PurchaseOrderLineInput = z.infer<typeof PurchaseOrderLineInputSchema>;

const PurchaseOrderLinesInput = z
  .array(PurchaseOrderLineInputSchema)
  .min(1, 'ต้องมีรายการสินค้าอย่างน้อยหนึ่งรายการ')
  .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, {
    message: 'สินค้าแต่ละรายการต้องไม่ซ้ำกัน',
  });

const PurchaseOrderHeaderInput = {
  supplierId: z.string().min(1),
  storeId: z.string().min(1),
  expectedReceiptDate: CalendarDate,
  lines: PurchaseOrderLinesInput,
};

export const CreatePurchaseOrderSchema = z.strictObject(PurchaseOrderHeaderInput);
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderSchema>;

/** Editing a draft replaces its header and lines. */
export const UpdatePurchaseOrderSchema = z.strictObject({
  id: z.string().min(1),
  ...PurchaseOrderHeaderInput,
});
export type UpdatePurchaseOrderInput = z.infer<typeof UpdatePurchaseOrderSchema>;

export const PurchaseOrderStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatusSchema>;

export const PurchaseOrderLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  /** Snapshots taken when the line was saved, so master-data edits never change history. */
  sku: z.string(),
  productName: z.string(),
  unit: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: Money,
  lineTotal: Money,
});
export type PurchaseOrderLine = z.infer<typeof PurchaseOrderLineSchema>;

export const PurchaseOrderSchema = z.object({
  id: z.string(),
  /** Issued when a later ticket approves the order; null while a draft. */
  documentNumber: z.string().nullable(),
  status: PurchaseOrderStatusSchema,
  supplierId: z.string(),
  supplierCode: z.string(),
  storeId: z.string(),
  storeCode: z.string(),
  createdById: z.string(),
  expectedReceiptDate: z.iso.date(),
  total: Money,
  createdAt: z.iso.datetime(),
  /** Why a manager approved or rejected, or why the order was cancelled. Null until then. */
  decisionReason: z.string().nullable().default(null),
  decidedAt: z.iso.datetime().nullable().default(null),
  lines: z.array(PurchaseOrderLineSchema),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

/** List query (Section 6.2): 1-based `page`, bounded `pageSize`. Newest first. */
export const PurchaseOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PurchaseOrderListQuery = z.infer<typeof PurchaseOrderListQuerySchema>;

export const PurchaseOrderListSchema = z.object({
  items: z.array(PurchaseOrderSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type PurchaseOrderList = z.infer<typeof PurchaseOrderListSchema>;

const IdParam = z.object({ id: z.string().min(1) });

/** Submitting a draft for approval needs only the order. */
export const SubmitPurchaseOrderSchema = IdParam;
export type SubmitPurchaseOrderInput = z.infer<typeof SubmitPurchaseOrderSchema>;

/** Approving, rejecting and cancelling each carry a mandatory reason (PO-03, PO-04). */
const DecisionInput = {
  id: z.string().min(1),
  reason: z.string().trim().min(1, 'ต้องระบุเหตุผล'),
};
export const ApprovePurchaseOrderSchema = z.object(DecisionInput);
export type ApprovePurchaseOrderInput = z.infer<typeof ApprovePurchaseOrderSchema>;
export const RejectPurchaseOrderSchema = z.object(DecisionInput);
export type RejectPurchaseOrderInput = z.infer<typeof RejectPurchaseOrderSchema>;
export const CancelPurchaseOrderSchema = z.object(DecisionInput);
export type CancelPurchaseOrderInput = z.infer<typeof CancelPurchaseOrderSchema>;

export const purchaseOrdersContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/purchase-orders',
      summary: 'List purchase orders (newest first)',
      tags: ['Purchase orders'],
    })
    .input(PurchaseOrderListQuerySchema)
    .output(PurchaseOrderListSchema),
  get: oc
    .route({
      method: 'GET',
      path: '/purchase-orders/{id}',
      summary: 'View one purchase order',
      tags: ['Purchase orders'],
    })
    .input(IdParam)
    .output(PurchaseOrderSchema),
  create: oc
    .route({
      method: 'POST',
      path: '/purchase-orders',
      summary: 'Create a draft purchase order',
      tags: ['Purchase orders'],
    })
    .input(CreatePurchaseOrderSchema)
    .output(PurchaseOrderSchema),
  update: oc
    .route({
      method: 'PUT',
      path: '/purchase-orders/{id}',
      summary: 'Replace the header and lines of a draft purchase order',
      tags: ['Purchase orders'],
    })
    .input(UpdatePurchaseOrderSchema)
    .output(PurchaseOrderSchema),
  submit: oc
    .route({
      method: 'POST',
      path: '/purchase-orders/{id}/submit',
      summary: 'Submit a draft purchase order for approval',
      tags: ['Purchase orders'],
    })
    .input(SubmitPurchaseOrderSchema)
    .output(PurchaseOrderSchema),
  approve: oc
    .route({
      method: 'POST',
      path: '/purchase-orders/{id}/approve',
      summary: 'Approve a purchase order pending approval, with a reason',
      tags: ['Purchase orders'],
    })
    .input(ApprovePurchaseOrderSchema)
    .output(PurchaseOrderSchema),
  reject: oc
    .route({
      method: 'POST',
      path: '/purchase-orders/{id}/reject',
      summary: 'Reject a purchase order pending approval, with a reason',
      tags: ['Purchase orders'],
    })
    .input(RejectPurchaseOrderSchema)
    .output(PurchaseOrderSchema),
  cancel: oc
    .route({
      method: 'POST',
      path: '/purchase-orders/{id}/cancel',
      summary: 'Cancel a draft or pending purchase order, with a reason',
      tags: ['Purchase orders'],
    })
    .input(CancelPurchaseOrderSchema)
    .output(PurchaseOrderSchema),
};
