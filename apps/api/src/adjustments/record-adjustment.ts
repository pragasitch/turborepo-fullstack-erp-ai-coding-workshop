import type { PrismaClient } from '@erp/database';
import { nextDocumentNumber } from '../inventory/document-numbers.js';
import { postStockMovement } from '../inventory/stock-ledger.js';

export type RecordAdjustmentInput = {
  productId: string;
  storeId: string;
  /** Signed, non-zero whole number: positive increases stock, negative decreases it. */
  quantityChange: number;
  reason: string;
  actorId: string;
};

export type RecordAdjustmentResult = {
  documentNumber: string;
  productId: string;
  storeId: string;
  quantityChange: number;
  balanceAfter: number;
  reason: string;
  createdAt: Date;
};

/**
 * Record a manager stock adjustment (INV-05) and its audit row (NFR-03) in one
 * transaction. It issues an ADJ document number, appends an ADJUSTMENT movement via the
 * shared ledger primitive (which refuses a decrease below zero, leaving stock
 * unchanged), and writes a SUCCESS audit row. A rejected adjustment rolls the whole
 * thing back, so no movement, balance change or audit row survives.
 */
export async function recordAdjustment(
  prisma: PrismaClient,
  input: RecordAdjustmentInput,
): Promise<RecordAdjustmentResult> {
  return prisma.$transaction(async (tx) => {
    const documentNumber = await nextDocumentNumber(tx, 'ADJ');

    const movement = await postStockMovement(tx, {
      productId: input.productId,
      storeId: input.storeId,
      quantityChange: input.quantityChange,
      type: 'ADJUSTMENT',
      sourceDocumentType: 'ADJUSTMENT',
      sourceDocumentId: documentNumber,
      actorId: input.actorId,
    });

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'STOCK_ADJUSTMENT',
        sourceDocumentType: 'ADJUSTMENT',
        sourceDocumentId: documentNumber,
        outcome: 'SUCCESS',
        detail: input.reason,
      },
    });

    return {
      documentNumber,
      productId: input.productId,
      storeId: input.storeId,
      quantityChange: input.quantityChange,
      balanceAfter: movement.balanceAfter,
      reason: input.reason,
      createdAt: movement.createdAt,
    };
  });
}
