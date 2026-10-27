import { oc } from '@orpc/contract';
import * as z from 'zod';

/**
 * Manager stock adjustments (INV-05) and the audit trail (NFR-03).
 *
 * An adjustment changes one (product, store) balance by a signed whole number and must
 * carry a reason. Positive increases stock, negative decreases it; zero is rejected. A
 * decrease larger than the available balance is refused by the API (INV-05), leaving
 * stock unchanged. Every successful adjustment appends an `ADJUSTMENT` stock movement
 * and an audit-log row.
 */

/** A signed, non-zero whole-number change to a balance. */
const QuantityChange = z
  .number()
  .int('จำนวนต้องเป็นจำนวนเต็ม')
  .refine((value) => value !== 0, { message: 'จำนวนที่ปรับต้องไม่เป็นศูนย์' });

export const CreateAdjustmentSchema = z.object({
  productId: z.string().min(1),
  storeId: z.string().min(1),
  quantityChange: QuantityChange,
  reason: z.string().trim().min(1, 'ต้องระบุเหตุผลในการปรับสต็อก'),
});
export type CreateAdjustmentInput = z.infer<typeof CreateAdjustmentSchema>;

/** The result of a successful adjustment: the movement it appended and its audit row. */
export const AdjustmentResultSchema = z.object({
  documentNumber: z.string(),
  productId: z.string(),
  storeId: z.string(),
  quantityChange: z.number().int(),
  balanceAfter: z.number().int().min(0),
  reason: z.string(),
  createdAt: z.iso.datetime(),
});
export type AdjustmentResult = z.infer<typeof AdjustmentResultSchema>;

/** One audit-log entry (NFR-03): who did what to which document, and the outcome. */
export const AuditLogEntrySchema = z.object({
  id: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  action: z.string(),
  sourceDocumentType: z.string(),
  sourceDocumentId: z.string(),
  outcome: z.string(),
  detail: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

/** List query for the audit trail (Section 6.2): 1-based `page`, bounded `pageSize`. */
export const AuditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export const AuditListSchema = z.object({
  items: z.array(AuditLogEntrySchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type AuditList = z.infer<typeof AuditListSchema>;

export const adjustmentsContract = {
  create: oc
    .route({
      method: 'POST',
      path: '/adjustments',
      summary: 'Record a manager stock adjustment',
      tags: ['Adjustments'],
    })
    .input(CreateAdjustmentSchema)
    .output(AdjustmentResultSchema),
  auditList: oc
    .route({
      method: 'GET',
      path: '/audit-logs',
      summary: 'List audit-log entries (newest first)',
      tags: ['Adjustments'],
    })
    .input(AuditListQuerySchema)
    .output(AuditListSchema),
};
