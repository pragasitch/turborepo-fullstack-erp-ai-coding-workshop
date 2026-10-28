import { Controller } from '@nestjs/common';
import { contract } from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { Roles } from '../auth/auth.decorators.js';
import type { Store } from '@erp/database';
import { PrismaService } from '../database/prisma.service.js';

/** Timestamps arrive as `Date` from Prisma; normalize to the contract's ISO string. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Serialize a Prisma store to the contract shape (timestamps as ISO strings). */
function toStore(store: Store) {
  return {
    id: store.id,
    code: store.code,
    name: store.name,
    createdAt: toIso(store.createdAt),
    updatedAt: toIso(store.updatedAt),
  };
}

/** The shared Thai error envelope for a taken store code (NFR-04). */
function storeCodeTakenError() {
  return new ORPCError('CONFLICT', {
    data: { code: 'STORE_CODE_TAKEN', message: 'รหัสสาขานี้ถูกใช้แล้ว', fields: ['code'] },
  });
}

/**
 * Stores master data. Writes are Administrator-only; listing is open to any signed-in role,
 * because several store-picker screens need it (purchase order destination, daily sales
 * report filter). Enforced at the API by `@Roles` and the global `AuthGuard` (NFR-01).
 * Duplicate codes surface the shared Thai error envelope (NFR-04), never a database error.
 */
@Controller()
export class StoresController {
  constructor(private readonly prisma: PrismaService) {}

  @Implement(contract.stores.list)
  list() {
    return implement(contract.stores.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [items, total] = await Promise.all([
        this.prisma.store.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.store.count(),
      ]);
      return { items: items.map(toStore), total, page, pageSize };
    });
  }

  @Roles('ADMINISTRATOR')
  @Implement(contract.stores.create)
  create() {
    return implement(contract.stores.create).handler(async ({ input }) => {
      const existing = await this.prisma.store.findUnique({ where: { code: input.code } });
      if (existing) {
        throw storeCodeTakenError();
      }
      const created = await this.prisma.store.create({
        data: { code: input.code, name: input.name },
      });
      return toStore(created);
    });
  }

  @Roles('ADMINISTRATOR')
  @Implement(contract.stores.update)
  update() {
    return implement(contract.stores.update).handler(async ({ input }) => {
      const { id, ...data } = input;
      // A code collision with a *different* store surfaces the shared envelope,
      // never a raw Prisma unique-constraint error (NFR-04).
      const existing = await this.prisma.store.findUnique({ where: { code: data.code } });
      if (existing && existing.id !== id) {
        throw storeCodeTakenError();
      }
      const updated = await this.prisma.store.update({ where: { id }, data });
      return toStore(updated);
    });
  }
}
