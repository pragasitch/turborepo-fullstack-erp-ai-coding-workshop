import type { ConfirmGoodsReceiptInput, User } from '@erp/contracts';
import type { Prisma, PrismaClient } from '@erp/database';
import { ORPCError } from '@orpc/nest';
import { assertStoreScope } from '../auth/store-scope.js';
import { nextDocumentNumber } from '../inventory/document-numbers.js';
import { postStockMovement } from '../inventory/stock-ledger.js';
import { assertProductUsableInDocument } from '../products/products.rules.js';
import { lockPurchaseOrder } from '../purchase-orders/purchase-orders.js';

/** The statuses an order can be received against (GR-01). */
export const RECEIVABLE_STATUSES = ['APPROVED', 'PARTIALLY_RECEIVED'] as const;

/** What every receipt route returns: the receipt, its lines, its store and its order. */
export const GOODS_RECEIPT_INCLUDE = {
  lines: { orderBy: { sku: 'asc' } },
  store: { select: { code: true } },
  purchaseOrder: { select: { documentNumber: true, status: true } },
} satisfies Prisma.GoodsReceiptInclude;
export type GoodsReceiptRecord = Prisma.GoodsReceiptGetPayload<{
  include: typeof GOODS_RECEIPT_INCLUDE;
}>;

/** What the receiving screen needs of an order: its lines and whether each product is active. */
export const RECEIVABLE_ORDER_INCLUDE = {
  lines: { orderBy: { sku: 'asc' }, include: { product: { select: { isActive: true } } } },
  supplier: { select: { code: true } },
  store: { select: { code: true } },
} satisfies Prisma.PurchaseOrderInclude;
export type ReceivableOrderRecord = Prisma.PurchaseOrderGetPayload<{
  include: typeof RECEIVABLE_ORDER_INCLUDE;
}>;

function conflict(code: string, message: string, extras: Record<string, unknown> = {}) {
  return new ORPCError('CONFLICT', { data: { code, message, ...extras } });
}

export function goodsReceiptNotFound() {
  return new ORPCError('NOT_FOUND', {
    data: { code: 'GOODS_RECEIPT_NOT_FOUND', message: 'ไม่พบใบรับสินค้า' },
  });
}

function keyReused() {
  return conflict(
    'IDEMPOTENCY_KEY_REUSED',
    'Idempotency-Key นี้ถูกใช้รับสินค้าครั้งอื่นแล้ว กรุณาใช้คีย์ใหม่',
  );
}

/**
 * Received so far per product on one order, summed over every confirmed receipt. The
 * cumulative figure is always derived from the receipts themselves, never stored, so it
 * cannot drift from them (GR-02, GR-05).
 */
export async function receivedForOrder(
  db: Pick<Prisma.TransactionClient, 'goodsReceiptLine'>,
  purchaseOrderId: string,
): Promise<Map<string, number>> {
  const rows = await db.goodsReceiptLine.groupBy({
    by: ['productId'],
    where: { goodsReceipt: { purchaseOrderId } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((row) => [row.productId, row._sum.quantity ?? 0]));
}

/** Ordered, received and outstanding for each line of an order (GR-01). */
export async function toReceivableLines(
  db: Pick<Prisma.TransactionClient, 'goodsReceiptLine'>,
  order: ReceivableOrderRecord,
) {
  const received = await receivedForOrder(db, order.id);
  return order.lines.map((line) => {
    const done = received.get(line.productId) ?? 0;
    return {
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      unit: line.unit,
      isActive: line.product.isActive,
      ordered: line.quantity,
      received: done,
      outstanding: Math.max(line.quantity - done, 0),
    };
  });
}

/** True when `existing` is the receipt the same request would have produced (GR-04). */
function isSameRequest(
  existing: GoodsReceiptRecord,
  purchaseOrderId: string,
  lines: ConfirmGoodsReceiptInput['lines'],
): boolean {
  if (existing.purchaseOrderId !== purchaseOrderId) return false;
  const wanted = lines.filter((l) => l.quantity > 0);
  if (wanted.length !== existing.lines.length) return false;
  const recorded = new Map(existing.lines.map((l) => [l.productId, l.quantity]));
  return wanted.every((l) => recorded.get(l.productId) === l.quantity);
}

/**
 * Confirm a goods receipt (GR-01..GR-05, Q-02) in one transaction: issue the GR number,
 * increase the destination store's stock with a RECEIPT movement per delivered line,
 * record the receipt, move the order to Partially Received or Completed, and audit it.
 *
 * - Concurrency: the order row is locked first, so two receiving requests for one order
 *   queue up and the second counts what the first received. Cumulative received can never
 *   pass ordered, whatever the browser believed.
 * - Idempotency: the key is stored on the receipt, unique per actor. Repeating the same
 *   request returns the original and posts nothing, even after the order is Completed. The
 *   same key with a different order or different quantities is refused, never silently
 *   answered with a receipt that does not match what was sent.
 * - All or nothing: any rejection throws and rolls the whole transaction back.
 */
export async function confirmGoodsReceipt(
  prisma: PrismaClient,
  actor: User,
  input: ConfirmGoodsReceiptInput,
  idempotencyKey: string,
): Promise<GoodsReceiptRecord> {
  try {
    return await prisma.$transaction(async (tx) => {
      const order = await lockPurchaseOrder(tx, input.purchaseOrderId);
      assertStoreScope(actor, order.storeId);

      const existing = await tx.goodsReceipt.findFirst({
        where: { receivedById: actor.id, idempotencyKey },
        include: GOODS_RECEIPT_INCLUDE,
      });
      if (existing) {
        if (isSameRequest(existing, order.id, input.lines)) return existing;
        throw keyReused();
      }

      if (!(RECEIVABLE_STATUSES as readonly string[]).includes(order.status)) {
        throw conflict(
          'PURCHASE_ORDER_NOT_RECEIVABLE',
          'รับสินค้าได้เฉพาะใบสั่งซื้อที่อนุมัติแล้วหรือรับบางส่วนเท่านั้น',
        );
      }

      // Zero-quantity lines say "none of this arrived": validated against the order, never recorded.
      const delivered = input.lines.filter((l) => l.quantity > 0);
      const orderLines = new Map(order.lines.map((l) => [l.productId, l]));
      for (const line of input.lines) {
        if (!orderLines.has(line.productId)) {
          throw new ORPCError('BAD_REQUEST', {
            data: {
              code: 'PRODUCT_NOT_IN_ORDER',
              message: 'ไม่สามารถรับสินค้าที่ไม่อยู่ในใบสั่งซื้อได้',
              fields: ['productId'],
            },
          });
        }
      }

      // Q-02: a product deactivated after approval cannot be received against this order.
      const products = await tx.product.findMany({
        where: { id: { in: delivered.map((l) => l.productId) } },
      });
      products.forEach(assertProductUsableInDocument);

      const received = await receivedForOrder(tx, order.id);
      const over = delivered.flatMap((line) => {
        const ordered = orderLines.get(line.productId)!;
        const outstanding = ordered.quantity - (received.get(line.productId) ?? 0);
        return line.quantity > outstanding
          ? [
              {
                productId: line.productId,
                sku: ordered.sku,
                productName: ordered.productName,
                requested: line.quantity,
                available: Math.max(outstanding, 0),
              },
            ]
          : [];
      });
      if (over.length > 0) {
        throw conflict('RECEIPT_EXCEEDS_ORDERED', 'จำนวนที่รับเกินจำนวนที่สั่งซื้อ', {
          fields: ['lines'],
          products: over,
        });
      }

      const documentNumber = await nextDocumentNumber(tx, 'GR');

      // Fixed order, so concurrent receipts that share products never deadlock.
      const ordered = [...delivered].sort((a, b) => a.productId.localeCompare(b.productId));
      const lines = [];
      for (const line of ordered) {
        const orderLine = orderLines.get(line.productId)!;
        const movement = await postStockMovement(tx, {
          productId: line.productId,
          storeId: order.storeId,
          quantityChange: line.quantity,
          type: 'RECEIPT',
          sourceDocumentType: 'GOODS_RECEIPT',
          sourceDocumentId: documentNumber,
          actorId: actor.id,
        });
        lines.push({
          productId: line.productId,
          sku: orderLine.sku,
          productName: orderLine.productName,
          unit: orderLine.unit,
          quantity: line.quantity,
          idempotencyKey,
          balanceAfter: movement.balanceAfter,
        });
      }

      const complete = order.lines.every((l) => {
        const now =
          (received.get(l.productId) ?? 0) +
          (delivered.find((d) => d.productId === l.productId)?.quantity ?? 0);
        return now >= l.quantity;
      });

      const receipt = await tx.goodsReceipt.create({
        data: {
          documentNumber,
          purchaseOrderId: order.id,
          storeId: order.storeId,
          receivedById: actor.id,
          idempotencyKey,
          lines: { create: lines },
        },
        include: GOODS_RECEIPT_INCLUDE,
      });
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: { status: complete ? 'COMPLETED' : 'PARTIALLY_RECEIVED' },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'GOODS_RECEIPT',
          sourceDocumentType: 'GOODS_RECEIPT',
          sourceDocumentId: documentNumber,
          outcome: 'SUCCESS',
        },
      });

      return tx.goodsReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
        include: GOODS_RECEIPT_INCLUDE,
      });
    });
  } catch (error) {
    // Two requests with one key raced past the lookup: the unique index let one win.
    if ((error as { code?: string } | null)?.code === 'P2002') throw keyReused();
    throw error;
  }
}
