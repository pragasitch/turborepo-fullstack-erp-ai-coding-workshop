import { oc } from '@orpc/contract';
import * as z from 'zod';

/**
 * Sales (SAL-01..SAL-04). A store employee records a draft sale for their assigned
 * store, then confirms it. Drafts never touch stock. Confirmation posts the sale and
 * decreases stock in one transaction, is idempotent on the `Idempotency-Key` header
 * (SAL-03), and rejects the whole document, naming the short products, when any line
 * cannot be covered by the latest stock (SAL-02). A confirmed sale is final (SAL-04).
 *
 * The client never sends a price: the API applies the current selling price when the
 * line is saved and keeps it on the document. Money is a two-decimal string.
 */

const Money = z.string().regex(/^\d+\.\d{2}$/, 'จำนวนเงินต้องเป็นตัวเลขทศนิยมสองตำแหน่ง');

/** A positive whole number of the product's base unit (SAL-01). */
const Quantity = z
  .number()
  .int('จำนวนต้องเป็นจำนวนเต็ม')
  .positive('จำนวนต้องมากกว่าศูนย์');

/**
 * What the client may say about a line: which product and how many. Strict, so a
 * `unitPrice` (or any other field) is rejected rather than silently dropped.
 */
export const SaleLineInputSchema = z.strictObject({
  productId: z.string().min(1),
  quantity: Quantity,
});
export type SaleLineInput = z.infer<typeof SaleLineInputSchema>;

const SaleLinesInput = z
  .array(SaleLineInputSchema)
  .min(1, 'ต้องมีรายการสินค้าอย่างน้อยหนึ่งรายการ')
  .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, {
    message: 'สินค้าแต่ละรายการต้องไม่ซ้ำกัน',
  });

export const CreateSaleSchema = z.strictObject({ lines: SaleLinesInput });
export type CreateSaleInput = z.infer<typeof CreateSaleSchema>;

/** Editing a draft replaces its lines. */
export const UpdateSaleSchema = z.strictObject({ id: z.string().min(1), lines: SaleLinesInput });
export type UpdateSaleInput = z.infer<typeof UpdateSaleSchema>;

/**
 * The client-supplied key that makes confirmation safe to retry (SAL-03). Generate one
 * per confirm attempt (a UUID is ideal) and resend the same key when retrying.
 */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'Idempotency-Key ต้องยาว 8-128 ตัวอักษร (a-z A-Z 0-9 . _ : -)');
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

/** Header names are lower-case on the wire. */
export const ConfirmSaleHeadersSchema = z.object({ 'idempotency-key': IdempotencyKeySchema });

export const SaleStatusSchema = z.enum(['DRAFT', 'CONFIRMED']);
export type SaleStatus = z.infer<typeof SaleStatusSchema>;

export const SaleLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  /** Snapshots taken when the line was saved, so master-data edits never change history. */
  sku: z.string(),
  productName: z.string(),
  unit: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: Money,
  lineTotal: Money,
  /** Stock left after this line was posted. Null while the sale is a draft. */
  balanceAfter: z.number().int().min(0).nullable(),
});
export type SaleLine = z.infer<typeof SaleLineSchema>;

export const SaleSchema = z.object({
  id: z.string(),
  /** Issued on confirmation (SAL-03); null for a draft. */
  documentNumber: z.string().nullable(),
  status: SaleStatusSchema,
  storeId: z.string(),
  storeCode: z.string(),
  createdById: z.string(),
  total: Money,
  confirmedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  lines: z.array(SaleLineSchema),
});
export type Sale = z.infer<typeof SaleSchema>;

/** List query (Section 6.2): 1-based `page`, bounded `pageSize`. Newest first. */
export const SaleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type SaleListQuery = z.infer<typeof SaleListQuerySchema>;

export const SaleListSchema = z.object({
  items: z.array(SaleSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type SaleList = z.infer<typeof SaleListSchema>;

const IdParam = z.object({ id: z.string().min(1) });

export const salesContract = {
  list: oc
    .route({ method: 'GET', path: '/sales', summary: 'List sales (newest first)', tags: ['Sales'] })
    .input(SaleListQuerySchema)
    .output(SaleListSchema),
  get: oc
    .route({ method: 'GET', path: '/sales/{id}', summary: 'View one sale', tags: ['Sales'] })
    .input(IdParam)
    .output(SaleSchema),
  create: oc
    .route({
      method: 'POST',
      path: '/sales',
      summary: 'Create a draft sale at the current selling prices',
      tags: ['Sales'],
    })
    .input(CreateSaleSchema)
    .output(SaleSchema),
  update: oc
    .route({
      method: 'PUT',
      path: '/sales/{id}',
      summary: 'Replace the lines of a draft sale',
      tags: ['Sales'],
    })
    .input(UpdateSaleSchema)
    .output(SaleSchema),
  confirm: oc
    .route({
      method: 'POST',
      path: '/sales/{id}/confirm',
      summary: 'Confirm a sale: post it and decrease stock, once per Idempotency-Key',
      tags: ['Sales'],
      inputStructure: 'detailed',
    })
    .input(z.object({ params: IdParam, headers: ConfirmSaleHeadersSchema }))
    .output(SaleSchema),
  // Confirmed sales cannot be cancelled or returned in this release (SAL-04, Q-04).
  // The routes exist so the refusal is explicit and observable instead of a 404.
  cancel: oc
    .route({
      method: 'POST',
      path: '/sales/{id}/cancel',
      summary: 'Cancel a sale (not available in this release)',
      tags: ['Sales'],
    })
    .input(IdParam)
    .output(SaleSchema),
  return: oc
    .route({
      method: 'POST',
      path: '/sales/{id}/return',
      summary: 'Return a sale (not available in this release)',
      tags: ['Sales'],
    })
    .input(IdParam)
    .output(SaleSchema),
};
