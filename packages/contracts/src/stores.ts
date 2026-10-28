import { oc } from '@orpc/contract';
import * as z from 'zod';

/**
 * Shared Thai error envelope (NFR-04): a machine-readable `code`, a human-readable
 * Thai `message`, and the optional `fields` a validation error applies to. Handlers
 * attach it to an `ORPCError` via its `data`; the web surfaces `message`. It never
 * carries stack traces or database details.
 */
export const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string().min(1),
  fields: z.array(z.string()).optional(),
  /** The products a rejection concerns, e.g. the short lines of a sale (SAL-02). */
  products: z
    .array(
      z.object({
        productId: z.string(),
        sku: z.string(),
        productName: z.string(),
        requested: z.number().int(),
        available: z.number().int(),
      }),
    )
    .optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const StoreSchema = z.object({
  id: z.string(),
  code: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Store = z.infer<typeof StoreSchema>;

export const CreateStoreSchema = StoreSchema.pick({ code: true, name: true });
export type CreateStoreInput = z.infer<typeof CreateStoreSchema>;

export const UpdateStoreSchema = CreateStoreSchema.extend({ id: z.string() });
export type UpdateStoreInput = z.infer<typeof UpdateStoreSchema>;

/**
 * Shared list-query convention (Section 6.2): 1-based `page` and a bounded `pageSize`,
 * both optional so a caller can list with defaults. Reused by every later list screen.
 */
export const StoreListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type StoreListQuery = z.infer<typeof StoreListQuerySchema>;

/** A page of stores plus the echo of the query, so the UI can render pagination. */
export const StoreListSchema = z.object({
  items: z.array(StoreSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type StoreList = z.infer<typeof StoreListSchema>;

export const storesContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/stores',
      summary: 'List stores (newest first)',
      tags: ['Stores'],
    })
    .input(StoreListQuerySchema)
    .output(StoreListSchema),
  create: oc
    .route({ method: 'POST', path: '/stores', summary: 'Create a store', tags: ['Stores'] })
    .input(CreateStoreSchema)
    .output(StoreSchema),
  update: oc
    .route({ method: 'PATCH', path: '/stores/{id}', summary: 'Update a store', tags: ['Stores'] })
    .input(UpdateStoreSchema)
    .output(StoreSchema),
};
