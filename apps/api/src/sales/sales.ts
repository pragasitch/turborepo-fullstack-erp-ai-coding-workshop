import type { SaleLineInput, User } from '@erp/contracts';
import { Prisma, type PrismaClient } from '@erp/database';
import { ORPCError } from '@orpc/nest';
import { assertStoreScope } from '../auth/store-scope.js';
import { nextDocumentNumber } from '../inventory/document-numbers.js';
import { postStockMovement } from '../inventory/stock-ledger.js';
import { assertProductUsableInDocument } from '../products/products.rules.js';

/** What every sale route returns: the sale, its lines and its store's code. */
export const SALE_INCLUDE = {
  lines: { orderBy: { sku: 'asc' } },
  store: { select: { code: true } },
} satisfies Prisma.SaleInclude;
export type SaleRecord = Prisma.SaleGetPayload<{ include: typeof SALE_INCLUDE }>;

type ErrorExtras = { fields?: string[]; products?: unknown[] };

function conflict(code: string, message: string, extras: ErrorExtras = {}) {
  return new ORPCError('CONFLICT', { data: { code, message, ...extras } });
}

function saleNotFound() {
  return new ORPCError('NOT_FOUND', {
    data: { code: 'SALE_NOT_FOUND', message: 'ไม่พบใบขาย' },
  });
}

/** SAL-04: a confirmed sale is final in this release. */
export function saleConfirmedImmutable() {
  return conflict('SALE_CONFIRMED_IMMUTABLE', 'ใบขายที่ยืนยันแล้วไม่สามารถแก้ไข ยกเลิก หรือคืนสินค้าได้');
}

/** The sale's store is the store employee's assigned store (SAL-01). */
function assignedStoreId(actor: User): string {
  assertStoreScope(actor, actor.storeId ?? '');
  return actor.storeId as string;
}

/**
 * Look up the products on a draft and apply today's selling price, name and unit to each
 * line (SAL-01). The client only ever names a product and a quantity.
 */
async function priceLines(
  db: Pick<Prisma.TransactionClient, 'product'>,
  lines: SaleLineInput[],
) {
  const products = await db.product.findMany({
    where: { id: { in: lines.map((l) => l.productId) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const priced = lines.map((line) => {
    const product = byId.get(line.productId);
    if (!product) {
      throw new ORPCError('NOT_FOUND', {
        data: { code: 'PRODUCT_NOT_FOUND', message: 'ไม่พบสินค้า', fields: ['productId'] },
      });
    }
    assertProductUsableInDocument(product);
    return {
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      unit: product.unit,
      quantity: line.quantity,
      unitPrice: product.sellingPrice,
      lineTotal: product.sellingPrice.mul(line.quantity),
    };
  });

  const total = priced.reduce((sum, line) => sum.add(line.lineTotal), new Prisma.Decimal(0));
  return { lines: priced, total };
}

/** Create a draft sale for the employee's store. Stock is untouched (SAL-02). */
export async function createDraftSale(
  prisma: PrismaClient,
  actor: User,
  input: { lines: SaleLineInput[] },
): Promise<SaleRecord> {
  const storeId = assignedStoreId(actor);
  const { lines, total } = await priceLines(prisma, input.lines);
  return prisma.sale.create({
    data: { storeId, createdById: actor.id, total, lines: { create: lines } },
    include: SALE_INCLUDE,
  });
}

/** Take the row lock that serialises everything that changes one sale. */
async function lockSale(tx: Prisma.TransactionClient, saleId: string): Promise<SaleRecord> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Sale" WHERE "id" = ${saleId} FOR UPDATE`;
  if (!locked[0]) throw saleNotFound();
  return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: SALE_INCLUDE });
}

/** Replace the lines of a draft. A confirmed sale is final and is refused (SAL-04). */
export async function replaceDraftLines(
  prisma: PrismaClient,
  actor: User,
  saleId: string,
  lines: SaleLineInput[],
): Promise<SaleRecord> {
  return prisma.$transaction(async (tx) => {
    const sale = await lockSale(tx, saleId);
    assertStoreScope(actor, sale.storeId);
    if (sale.status !== 'DRAFT') throw saleConfirmedImmutable();

    const priced = await priceLines(tx, lines);
    await tx.saleLine.deleteMany({ where: { saleId } });
    return tx.sale.update({
      where: { id: saleId },
      data: { total: priced.total, lines: { create: priced.lines } },
      include: SALE_INCLUDE,
    });
  });
}

type Shortage = { productId: string; sku: string; productName: string; requested: number; available: number };

function isInsufficientStock(error: unknown): boolean {
  return (
    error instanceof ORPCError &&
    (error.data as { code?: string } | undefined)?.code === 'INSUFFICIENT_STOCK'
  );
}

/**
 * Confirm a draft sale (SAL-02, SAL-03, INV-04) in one transaction: issue the SAL
 * document number, decrease stock with a SALE movement per line, mark the sale
 * confirmed and audit it.
 *
 * - Concurrency: the sale row is locked, and each line decreases stock with the ledger's
 *   conditional UPDATE, so two confirmations on the same stock queue and the second sees
 *   the first's result. Nothing trusts a balance read earlier.
 * - All or nothing: every line is tried and the short ones are collected; if any is short
 *   the transaction is rolled back and the error names every affected product.
 * - Idempotency: the key is stored on the sale. Repeating a confirm with the same key
 *   returns the stored sale and posts nothing. A different key on a confirmed sale, or a
 *   key that confirmed another sale, is refused.
 */
export async function confirmSale(
  prisma: PrismaClient,
  actor: User,
  saleId: string,
  idempotencyKey: string,
): Promise<SaleRecord> {
  try {
    return await prisma.$transaction(async (tx) => {
      const sale = await lockSale(tx, saleId);
      assertStoreScope(actor, sale.storeId);

      if (sale.status === 'CONFIRMED') {
        if (sale.confirmedById === actor.id && sale.idempotencyKey === idempotencyKey) return sale;
        throw conflict('SALE_ALREADY_CONFIRMED', 'ใบขายนี้ยืนยันแล้ว ไม่สามารถยืนยันซ้ำได้');
      }

      const keyUsed = await tx.sale.findFirst({
        where: { confirmedById: actor.id, idempotencyKey },
        select: { id: true },
      });
      if (keyUsed) throw keyReused();

      // A product deactivated after the draft was saved cannot go onto a new sale (MD-02).
      const products = await tx.product.findMany({
        where: { id: { in: sale.lines.map((l) => l.productId) } },
      });
      products.forEach(assertProductUsableInDocument);

      const documentNumber = await nextDocumentNumber(tx, 'SAL');

      // Fixed order, so concurrent confirms that share products never deadlock.
      const ordered = [...sale.lines].sort((a, b) => a.productId.localeCompare(b.productId));
      const shortages: Shortage[] = [];
      const balanceAfter = new Map<string, number>();
      for (const line of ordered) {
        try {
          const movement = await postStockMovement(tx, {
            productId: line.productId,
            storeId: sale.storeId,
            quantityChange: -line.quantity,
            type: 'SALE',
            sourceDocumentType: 'SALE',
            sourceDocumentId: documentNumber,
            actorId: actor.id,
          });
          balanceAfter.set(line.id, movement.balanceAfter);
        } catch (error) {
          if (!isInsufficientStock(error)) throw error;
          const balance = await tx.stockBalance.findUnique({
            where: { productId_storeId: { productId: line.productId, storeId: sale.storeId } },
          });
          shortages.push({
            productId: line.productId,
            sku: line.sku,
            productName: line.productName,
            requested: line.quantity,
            available: balance?.quantity ?? 0,
          });
        }
      }
      if (shortages.length > 0) {
        // Throwing rolls the whole transaction back: no movement, no deduction, no number.
        throw conflict('INSUFFICIENT_STOCK', 'สต็อกไม่เพียงพอสำหรับสินค้าบางรายการ', {
          fields: ['lines'],
          products: shortages,
        });
      }

      for (const line of sale.lines) {
        await tx.saleLine.update({
          where: { id: line.id },
          data: { balanceAfter: balanceAfter.get(line.id), idempotencyKey },
        });
      }
      await tx.sale.update({
        where: { id: saleId },
        data: {
          status: 'CONFIRMED',
          documentNumber,
          confirmedById: actor.id,
          confirmedAt: new Date(),
          idempotencyKey,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: 'SALE_CONFIRMATION',
          sourceDocumentType: 'SALE',
          sourceDocumentId: documentNumber,
          outcome: 'SUCCESS',
        },
      });

      return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: SALE_INCLUDE });
    });
  } catch (error) {
    // Two different sales raced to confirm with one key: the unique index let one win.
    if ((error as { code?: string } | null)?.code === 'P2002') throw keyReused();
    throw error;
  }
}

function keyReused() {
  return conflict(
    'IDEMPOTENCY_KEY_REUSED',
    'Idempotency-Key นี้ถูกใช้ยืนยันใบขายอื่นแล้ว กรุณาใช้คีย์ใหม่',
  );
}
