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
async function lockPurchaseOrder(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<PurchaseOrderRecord> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${id} FOR UPDATE`;
  if (!locked[0]) throw purchaseOrderNotFound();
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: PURCHASE_ORDER_INCLUDE });
}

/** Replace the header and lines of a draft purchase order (PO-01). */
export async function updateDraftPurchaseOrder(
  prisma: PrismaClient,
  _actor: User,
  id: string,
  input: PurchaseOrderHeaderInput,
): Promise<PurchaseOrderRecord> {
  return prisma.$transaction(async (tx) => {
    await lockPurchaseOrder(tx, id);
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
