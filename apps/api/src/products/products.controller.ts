import { Controller } from '@nestjs/common';
import { contract, type CreateProductInput } from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';

export { assertProductUsableInDocument } from './products.rules.js';

/** Timestamps arrive as `Date` from Prisma; normalize to the contract's ISO string. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Money arrives as a Prisma `Decimal` (or string in tests); normalize to "0.00". */
function toMoney(value: { toFixed(n: number): string } | string | number): string {
  return typeof value === 'string' ? value : Number(value).toFixed(2);
}

type ThresholdRow = { storeId: string; threshold: number };
type ProductRow = {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  sellingPrice: { toFixed(n: number): string } | string | number;
  isActive: boolean;
  reorderThresholds: ThresholdRow[];
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** Serialize a Prisma product (with its thresholds) to the contract shape. */
function toProduct(product: ProductRow) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    unit: product.unit,
    sellingPrice: toMoney(product.sellingPrice),
    isActive: product.isActive,
    reorderThresholds: product.reorderThresholds.map((t) => ({
      storeId: t.storeId,
      threshold: t.threshold,
    })),
    createdAt: toIso(product.createdAt),
    updatedAt: toIso(product.updatedAt),
  };
}

/** The shared Thai error envelope for a taken SKU (NFR-04). */
function productSkuTakenError() {
  return new ORPCError('CONFLICT', {
    data: { code: 'PRODUCT_SKU_TAKEN', message: 'รหัสสินค้านี้ถูกใช้แล้ว', fields: ['sku'] },
  });
}

/**
 * Products master data (MD-01, MD-02). Administrator-only (NFR-01). SKU is unique and
 * immutable (the update contract omits it). Deactivation keeps a product searchable
 * via `includeInactive` but blocks it from new documents through
 * `assertProductUsableInDocument`. Money is a two-decimal string (NFR-04/Section 6.1).
 */
@Controller()
export class ProductsController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('ADMINISTRATOR', 'PURCHASING_OFFICER')
  @Implement(contract.products.list)
  list() {
    return implement(contract.products.list).handler(async ({ input }) => {
      const { page, pageSize, search, includeInactive } = input;
      const where = {
        ...(includeInactive ? {} : { isActive: true }),
        ...(search
          ? {
              OR: [
                { sku: { contains: search, mode: 'insensitive' as const } },
                { name: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        this.prisma.product.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { reorderThresholds: true },
        }),
        this.prisma.product.count({ where }),
      ]);
      return { items: items.map(toProduct), total, page, pageSize };
    });
  }

  @Roles('ADMINISTRATOR')
  @Implement(contract.products.create)
  create() {
    return implement(contract.products.create).handler(async ({ input }) => {
      const existing = await this.prisma.product.findUnique({ where: { sku: input.sku } });
      if (existing) {
        throw productSkuTakenError();
      }
      const created = await this.prisma.product.create({
        data: this.createData(input),
        include: { reorderThresholds: true },
      });
      return toProduct(created);
    });
  }

  @Roles('ADMINISTRATOR')
  @Implement(contract.products.update)
  update() {
    return implement(contract.products.update).handler(async ({ input }) => {
      const { id, reorderThresholds, ...rest } = input;
      // Replace thresholds atomically with the product update. The update data never
      // includes `sku`: it is not in the contract, so SKU stays immutable (AC5).
      const data = {
        name: rest.name,
        category: rest.category,
        unit: rest.unit,
        sellingPrice: rest.sellingPrice,
        ...(rest.isActive === undefined ? {} : { isActive: rest.isActive }),
      };
      const updated = await this.prisma.$transaction(async (tx) => {
        if (reorderThresholds) {
          await tx.productReorderThreshold.deleteMany({ where: { productId: id } });
        }
        return tx.product.update({
          where: { id },
          data: {
            ...data,
            ...(reorderThresholds ? { reorderThresholds: { create: reorderThresholds } } : {}),
          },
          include: { reorderThresholds: true },
        });
      });
      return toProduct(updated);
    });
  }

  /** Shape the create payload for Prisma, with thresholds as nested creates. */
  private createData(input: CreateProductInput) {
    return {
      sku: input.sku,
      name: input.name,
      category: input.category,
      unit: input.unit,
      sellingPrice: input.sellingPrice,
      isActive: input.isActive ?? true,
      reorderThresholds: {
        create: (input.reorderThresholds ?? []).map((t) => ({
          storeId: t.storeId,
          threshold: t.threshold,
        })),
      },
    };
  }
}
