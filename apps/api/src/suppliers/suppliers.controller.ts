import { Controller } from '@nestjs/common';
import { contract, type CreateSupplierInput } from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { Roles } from '../auth/auth.decorators.js';
import type { Supplier } from '@erp/database';
import { PrismaService } from '../database/prisma.service.js';

/** Timestamps arrive as `Date` from Prisma; normalize to the contract's ISO string. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Serialize a Prisma supplier to the contract shape (timestamps as ISO strings). */
function toSupplier(supplier: Supplier) {
  return {
    id: supplier.id,
    code: supplier.code,
    name: supplier.name,
    contactPerson: supplier.contactPerson,
    phone: supplier.phone,
    email: supplier.email,
    address: supplier.address,
    createdAt: toIso(supplier.createdAt),
    updatedAt: toIso(supplier.updatedAt),
  };
}

/** The shared Thai error envelope for a taken supplier code (NFR-04). */
function supplierCodeTakenError() {
  return new ORPCError('CONFLICT', {
    data: { code: 'SUPPLIER_CODE_TAKEN', message: 'รหัสผู้ขายนี้ถูกใช้แล้ว', fields: ['code'] },
  });
}

/**
 * Normalize the contract's create/update fields for Prisma: required `code`/`name`
 * pass through, and each optional contact field becomes `null` when absent so the
 * database stores a consistent empty value.
 */
function toData(input: CreateSupplierInput) {
  return {
    code: input.code,
    name: input.name,
    contactPerson: input.contactPerson ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
  };
}

/**
 * Suppliers master data (MD-03). Writes are Administrator-only; listing is also open to a
 * Purchasing officer, who must read suppliers to raise a purchase order (PO-01). Enforced at
 * the API by `@Roles` and the global `AuthGuard` (NFR-01). Duplicate codes surface
 * the shared Thai error envelope (NFR-04), never a database error.
 */
@Controller()
export class SuppliersController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('ADMINISTRATOR', 'PURCHASING_OFFICER')
  @Implement(contract.suppliers.list)
  list() {
    return implement(contract.suppliers.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [items, total] = await Promise.all([
        this.prisma.supplier.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.supplier.count(),
      ]);
      return { items: items.map(toSupplier), total, page, pageSize };
    });
  }

  @Roles('ADMINISTRATOR')
  @Implement(contract.suppliers.create)
  create() {
    return implement(contract.suppliers.create).handler(async ({ input }) => {
      const existing = await this.prisma.supplier.findUnique({ where: { code: input.code } });
      if (existing) {
        throw supplierCodeTakenError();
      }
      const created = await this.prisma.supplier.create({ data: toData(input) });
      return toSupplier(created);
    });
  }

  @Roles('ADMINISTRATOR')
  @Implement(contract.suppliers.update)
  update() {
    return implement(contract.suppliers.update).handler(async ({ input }) => {
      const { id, ...rest } = input;
      // A code collision with a *different* supplier surfaces the shared envelope,
      // never a raw Prisma unique-constraint error (NFR-04).
      const existing = await this.prisma.supplier.findUnique({ where: { code: rest.code } });
      if (existing && existing.id !== id) {
        throw supplierCodeTakenError();
      }
      const updated = await this.prisma.supplier.update({ where: { id }, data: toData(rest) });
      return toSupplier(updated);
    });
  }
}
