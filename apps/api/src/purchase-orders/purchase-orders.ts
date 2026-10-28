import type { CreatePurchaseOrderInput, User } from '@erp/contracts';
import { Decimal, type Prisma, type PrismaClient } from '@erp/database';
import { ORPCError } from '@orpc/nest';
import { assertProductUsableInDocument } from '../products/products.rules.js';

/** What every purchase-order route returns: the order, its lines, supplier and store codes. */
export const PURCHASE_ORDER_INCLUDE = {
  lines: { orderBy: { sku: 'asc' } },
  supplier: { select: { code: true } },
  store: { select: { code: true } },
} satisfies Prisma.PurchaseOrderInclude;
export type PurchaseOrderRecord = Prisma.PurchaseOrderGetPayload<{
  include: typeof PURCHASE_ORDER_INCLUDE;
}>;

/** The header a client supplies for a draft, plus its lines (derived from the contract). */
export type PurchaseOrderHeaderInput = CreatePurchaseOrderInput;

export function purchaseOrderNotFound() {
  return new ORPCError('NOT_FOUND', {
    data: { code: 'PURCHASE_ORDER_NOT_FOUND', message: 'ไม่พบใบสั่งซื้อ' },
  });
}

/**
 * Resolve the supplier, destination store and products a draft names, and build the
 * priced lines from the client's ordered quantities and purchase unit prices (PO-01).
 * The line snapshots (sku, name, unit) are taken here so later master-data edits never
 * change the document. Throws 404 for a missing supplier, store or product, and refuses
 * an inactive product (MD-02).
 */
async function resolveDraft(
  db: Pick<Prisma.TransactionClient, 'supplier' | 'store' | 'product'>,
  input: PurchaseOrderHeaderInput,
) {
  const supplier = await db.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) {
    throw new ORPCError('NOT_FOUND', {
      data: { code: 'SUPPLIER_NOT_FOUND', message: 'ไม่พบผู้ขาย', fields: ['supplierId'] },
    });
  }

  const store = await db.store.findUnique({ where: { id: input.storeId } });
  if (!store) {
    throw new ORPCError('NOT_FOUND', {
      data: { code: 'STORE_NOT_FOUND', message: 'ไม่พบสาขาปลายทาง', fields: ['storeId'] },
    });
  }

  const products = await db.product.findMany({
    where: { id: { in: input.lines.map((l) => l.productId) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = input.lines.map((line) => {
    const product = byId.get(line.productId);
    if (!product) {
      throw new ORPCError('NOT_FOUND', {
        data: { code: 'PRODUCT_NOT_FOUND', message: 'ไม่พบสินค้า', fields: ['productId'] },
      });
    }
    assertProductUsableInDocument(product);
    const unitPrice = new Decimal(line.unitPrice);
    return {
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      unit: product.unit,
      quantity: line.quantity,
      unitPrice,
      lineTotal: unitPrice.mul(line.quantity),
    };
  });

  const total = lines.reduce((sum, line) => sum.add(line.lineTotal), new Decimal(0));
  return { supplierId: supplier.id, storeId: store.id, lines, total };
}

/** Create a draft purchase order (PO-01). */
export async function createDraftPurchaseOrder(
  prisma: PrismaClient,
  actor: User,
  input: PurchaseOrderHeaderInput,
): Promise<PurchaseOrderRecord> {
  const { supplierId, storeId, lines, total } = await resolveDraft(prisma, input);
  return prisma.purchaseOrder.create({
    data: {
      supplierId,
      storeId,
      createdById: actor.id,
      expectedReceiptDate: new Date(input.expectedReceiptDate),
      total,
      lines: { create: lines },
    },
    include: PURCHASE_ORDER_INCLUDE,
  });
}

/** Take the row lock that serialises everything that changes one order. */
export async function lockPurchaseOrder(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<PurchaseOrderRecord> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${id} FOR UPDATE`;
  if (!locked[0]) throw purchaseOrderNotFound();
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: PURCHASE_ORDER_INCLUDE });
}

type Status = PurchaseOrderRecord['status'];

/** PO-03: once an order leaves Draft its header and lines are frozen. */
function purchaseOrderNotEditable() {
  return new ORPCError('CONFLICT', {
    data: {
      code: 'PURCHASE_ORDER_NOT_EDITABLE',
      message: 'แก้ไขได้เฉพาะใบสั่งซื้อฉบับร่างเท่านั้น',
    },
  });
}

/** Replace the header and lines of a draft purchase order (PO-01, PO-03). */
export async function updateDraftPurchaseOrder(
  prisma: PrismaClient,
  _actor: User,
  id: string,
  input: PurchaseOrderHeaderInput,
): Promise<PurchaseOrderRecord> {
  return prisma.$transaction(async (tx) => {
    const current = await lockPurchaseOrder(tx, id);
    if (current.status !== 'DRAFT') throw purchaseOrderNotEditable();
    const { supplierId, storeId, lines, total } = await resolveDraft(tx, input);
    await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    return tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId,
        storeId,
        expectedReceiptDate: new Date(input.expectedReceiptDate),
        total,
        lines: { create: lines },
      },
      include: PURCHASE_ORDER_INCLUDE,
    });
  });
}

export type PurchaseOrderAction = 'submit' | 'approve' | 'reject' | 'cancel';

/**
 * The state machine (PO-02): every legal transition and nothing else. Receiving, which
 * moves Approved and Partially Received orders on, belongs to the goods-receipt ticket.
 */
const TRANSITIONS: Record<PurchaseOrderAction, { from: readonly Status[]; to: Status }> = {
  submit: { from: ['DRAFT'], to: 'PENDING_APPROVAL' },
  approve: { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  reject: { from: ['PENDING_APPROVAL'], to: 'REJECTED' },
  cancel: { from: ['DRAFT', 'PENDING_APPROVAL'], to: 'CANCELLED' },
};

/** Approval decisions are audited (NFR-03): SUCCESS when approved, REJECTED when rejected. */
const AUDIT_OUTCOME = { approve: 'SUCCESS', reject: 'REJECTED' } as const;

function invalidTransition() {
  return new ORPCError('CONFLICT', {
    data: {
      code: 'PURCHASE_ORDER_INVALID_TRANSITION',
      message: 'ไม่สามารถดำเนินการนี้กับใบสั่งซื้อในสถานะปัจจุบันได้',
    },
  });
}

function cancelForbidden() {
  return new ORPCError('FORBIDDEN', {
    data: {
      code: 'PURCHASE_ORDER_CANCEL_FORBIDDEN',
      message: 'เฉพาะผู้สร้างใบสั่งซื้อหรือผู้จัดการเท่านั้นที่ยกเลิกได้',
    },
  });
}

/**
 * Move one purchase order along the state machine (PO-02..PO-04) in one transaction.
 * The row is locked first, so two managers deciding at once cannot both win. An illegal
 * move throws 409 and writes nothing. Approve and reject record the manager's reason on
 * the order and append an audit row (NFR-03); none of this touches stock.
 */
export async function transitionPurchaseOrder(
  prisma: PrismaClient,
  actor: User,
  id: string,
  action: PurchaseOrderAction,
  reason?: string,
): Promise<PurchaseOrderRecord> {
  return prisma.$transaction(async (tx) => {
    const current = await lockPurchaseOrder(tx, id);

    // PO-04: a purchasing officer may cancel only an order they created; a manager any.
    if (action === 'cancel' && actor.role !== 'MANAGER' && current.createdById !== actor.id) {
      throw cancelForbidden();
    }

    const { from, to } = TRANSITIONS[action];
    if (!from.includes(current.status)) throw invalidTransition();

    const decided = action !== 'submit';
    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: to,
        ...(decided
          ? { decisionReason: reason, decidedById: actor.id, decidedAt: new Date() }
          : {}),
      },
      include: PURCHASE_ORDER_INCLUDE,
    });

    if (action === 'approve' || action === 'reject') {
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'PO_APPROVAL',
          sourceDocumentType: 'PURCHASE_ORDER',
          sourceDocumentId: id,
          outcome: AUDIT_OUTCOME[action],
          detail: reason,
        },
      });
    }
    return updated;
  });
}
