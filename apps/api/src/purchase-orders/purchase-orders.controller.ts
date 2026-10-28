import { Controller } from '@nestjs/common';
import { contract, type User } from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  createDraftPurchaseOrder,
  PURCHASE_ORDER_INCLUDE,
  type PurchaseOrderRecord,
  updateDraftPurchaseOrder,
} from './purchase-orders.js';

type Money = { toFixed(digits: number): string };

/** The calendar part of a date, "YYYY-MM-DD", for the `@db.Date` expected receipt date. */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Serialize a Prisma purchase order (with lines, supplier and store) to the contract shape. */
function toPurchaseOrder(po: PurchaseOrderRecord) {
  const money = (value: Money) => value.toFixed(2);
  return {
    id: po.id,
    documentNumber: po.documentNumber,
    status: po.status,
    supplierId: po.supplierId,
    supplierCode: po.supplier.code,
    storeId: po.storeId,
    storeCode: po.store.code,
    createdById: po.createdById,
    expectedReceiptDate: toDateOnly(po.expectedReceiptDate),
    total: money(po.total),
    createdAt: po.createdAt.toISOString(),
    lines: po.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      unit: line.unit,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice),
      lineTotal: money(line.lineTotal),
    })),
  };
}

/**
 * Purchase order drafts (PO-01). Only a Purchasing officer may create, edit or view
 * drafts; the global `AuthGuard` and `@Roles` enforce it (NFR-01). All line rules and
 * pricing live in `purchase-orders.ts`.
 */
@Controller()
export class PurchaseOrdersController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('PURCHASING_OFFICER')
  @Implement(contract.purchaseOrders.list)
  list(@CurrentUser() _user: User) {
    return implement(contract.purchaseOrders.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.purchaseOrder.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: PURCHASE_ORDER_INCLUDE,
        }),
        this.prisma.purchaseOrder.count(),
      ]);
      return { items: rows.map(toPurchaseOrder), total, page, pageSize };
    });
  }

  @Roles('PURCHASING_OFFICER')
  @Implement(contract.purchaseOrders.get)
  get(@CurrentUser() _user: User) {
    return implement(contract.purchaseOrders.get).handler(async ({ input }) => {
      const po = await this.prisma.purchaseOrder.findUnique({
        where: { id: input.id },
        include: PURCHASE_ORDER_INCLUDE,
      });
      if (!po) {
        throw new ORPCError('NOT_FOUND', {
          data: { code: 'PURCHASE_ORDER_NOT_FOUND', message: 'ไม่พบใบสั่งซื้อ' },
        });
      }
      return toPurchaseOrder(po);
    });
  }

  @Roles('PURCHASING_OFFICER')
  @Implement(contract.purchaseOrders.create)
  create(@CurrentUser() user: User) {
    return implement(contract.purchaseOrders.create).handler(async ({ input }) =>
      toPurchaseOrder(await createDraftPurchaseOrder(this.prisma, user, input)),
    );
  }

  @Roles('PURCHASING_OFFICER')
  @Implement(contract.purchaseOrders.update)
  update(@CurrentUser() user: User) {
    return implement(contract.purchaseOrders.update).handler(async ({ input }) => {
      const { id, ...header } = input;
      return toPurchaseOrder(await updateDraftPurchaseOrder(this.prisma, user, id, header));
    });
  }
}
