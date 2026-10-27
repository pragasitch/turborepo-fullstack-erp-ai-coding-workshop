import { Controller } from '@nestjs/common';
import { contract, type User } from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { recordAdjustment } from './record-adjustment.js';

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Manager stock adjustments (INV-05) and the audit trail (NFR-03). Adjusting is
 * Manager-only; reading the audit trail is open to Managers and Administrators. Both are
 * enforced at the API by `@Roles` and the global `AuthGuard` (NFR-01).
 */
@Controller()
export class AdjustmentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('MANAGER')
  @Implement(contract.adjustments.create)
  create(@CurrentUser() user: User) {
    return implement(contract.adjustments.create).handler(async ({ input }) => {
      const result = await recordAdjustment(this.prisma, {
        productId: input.productId,
        storeId: input.storeId,
        quantityChange: input.quantityChange,
        reason: input.reason,
        actorId: user.id,
      });
      return { ...result, createdAt: toIso(result.createdAt) };
    });
  }

  @Roles('MANAGER', 'ADMINISTRATOR')
  @Implement(contract.adjustments.auditList)
  auditList() {
    return implement(contract.adjustments.auditList).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.auditLog.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { actor: { select: { name: true } } },
        }),
        this.prisma.auditLog.count(),
      ]);
      return {
        items: rows.map((row) => ({
          id: row.id,
          actorId: row.actorId,
          actorName: row.actor.name,
          action: row.action,
          sourceDocumentType: row.sourceDocumentType,
          sourceDocumentId: row.sourceDocumentId,
          outcome: row.outcome,
          detail: row.detail,
          createdAt: toIso(row.createdAt),
        })),
        total,
        page,
        pageSize,
      };
    });
  }
}
