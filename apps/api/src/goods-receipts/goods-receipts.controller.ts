import { Controller } from '@nestjs/common';
import { contract, type User } from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { assertStoreScope } from '../auth/store-scope.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  confirmGoodsReceipt,
  GOODS_RECEIPT_INCLUDE,
  goodsReceiptNotFound,
  RECEIVABLE_ORDER_INCLUDE,
  RECEIVABLE_STATUSES,
  toReceivableLines,
  type GoodsReceiptRecord,
  type ReceivableOrderRecord,
} from './goods-receipts.js';

/** Serialize a Prisma goods receipt (with lines, store and order) to the contract shape. */
function toGoodsReceipt(receipt: GoodsReceiptRecord) {
  return {
    id: receipt.id,
    documentNumber: receipt.documentNumber,
    purchaseOrderId: receipt.purchaseOrderId,
    purchaseOrderNumber: receipt.purchaseOrder.documentNumber,
    orderStatus: receipt.purchaseOrder.status as 'PARTIALLY_RECEIVED' | 'COMPLETED',
    storeId: receipt.storeId,
    storeCode: receipt.store.code,
    receivedById: receipt.receivedById,
    confirmedAt: receipt.confirmedAt.toISOString(),
    lines: receipt.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      unit: line.unit,
      quantity: line.quantity,
      balanceAfter: line.balanceAfter,
    })),
  };
}

/**
 * Goods receipts (GR-01..GR-05). Store employees receive against orders for their
 * assigned store; managers and administrators can view. The store scope is enforced on
 * every read and write (NFR-01). All posting rules live in `goods-receipts.ts`.
 * There is deliberately no route to edit or cancel a confirmed receipt (GR-05).
 */
@Controller()
export class GoodsReceiptsController {
  constructor(private readonly prisma: PrismaService) {}

  /** `{}` for roles that see every store, `{ storeId }` for a store employee. */
  private storeFilter(user: User): { storeId?: string } {
    if (user.role !== 'STORE_EMPLOYEE') return {};
    assertStoreScope(user, user.storeId ?? '');
    return { storeId: user.storeId as string };
  }

  @Roles('STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR')
  @Implement(contract.goodsReceipts.receivableOrders)
  receivableOrders(@CurrentUser() user: User) {
    return implement(contract.goodsReceipts.receivableOrders).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const where = {
        status: { in: [...RECEIVABLE_STATUSES] },
        ...this.storeFilter(user),
      };
      const [rows, total] = await Promise.all([
        this.prisma.purchaseOrder.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: RECEIVABLE_ORDER_INCLUDE,
        }),
        this.prisma.purchaseOrder.count({ where }),
      ]);
      const items = await Promise.all(
        rows.map(async (order: ReceivableOrderRecord) => ({
          id: order.id,
          documentNumber: order.documentNumber,
          status: order.status as 'APPROVED' | 'PARTIALLY_RECEIVED',
          supplierCode: order.supplier.code,
          storeId: order.storeId,
          storeCode: order.store.code,
          expectedReceiptDate: order.expectedReceiptDate.toISOString().slice(0, 10),
          lines: await toReceivableLines(this.prisma, order),
        })),
      );
      return { items, total, page, pageSize };
    });
  }

  @Roles('STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR')
  @Implement(contract.goodsReceipts.list)
  list(@CurrentUser() user: User) {
    return implement(contract.goodsReceipts.list).handler(async ({ input }) => {
      const { page, pageSize, purchaseOrderId } = input;
      const where = {
        ...this.storeFilter(user),
        ...(purchaseOrderId ? { purchaseOrderId } : {}),
      };
      const [rows, total] = await Promise.all([
        this.prisma.goodsReceipt.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: GOODS_RECEIPT_INCLUDE,
        }),
        this.prisma.goodsReceipt.count({ where }),
      ]);
      return { items: rows.map(toGoodsReceipt), total, page, pageSize };
    });
  }

  @Roles('STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR')
  @Implement(contract.goodsReceipts.get)
  get(@CurrentUser() user: User) {
    return implement(contract.goodsReceipts.get).handler(async ({ input }) => {
      const receipt = await this.prisma.goodsReceipt.findUnique({
        where: { id: input.id },
        include: GOODS_RECEIPT_INCLUDE,
      });
      if (!receipt) throw goodsReceiptNotFound();
      assertStoreScope(user, receipt.storeId);
      return toGoodsReceipt(receipt);
    });
  }

  @Roles('STORE_EMPLOYEE')
  @Implement(contract.goodsReceipts.confirm)
  confirm(@CurrentUser() user: User) {
    return implement(contract.goodsReceipts.confirm).handler(async ({ input }) =>
      toGoodsReceipt(
        await confirmGoodsReceipt(this.prisma, user, input.body, input.headers['idempotency-key']),
      ),
    );
  }
}
