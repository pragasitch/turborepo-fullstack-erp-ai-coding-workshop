import { Controller } from '@nestjs/common';
import { contract, type User } from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { assertStoreScope } from '../auth/store-scope.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  confirmSale,
  createDraftSale,
  replaceDraftLines,
  SALE_INCLUDE,
  saleConfirmedImmutable,
  type SaleRecord,
} from './sales.js';

type Money = { toFixed(digits: number): string };

/** Serialize a Prisma sale (with lines and store) to the contract shape. */
function toSale(sale: SaleRecord) {
  const money = (value: Money) => value.toFixed(2);
  return {
    id: sale.id,
    documentNumber: sale.documentNumber,
    status: sale.status,
    storeId: sale.storeId,
    storeCode: sale.store.code,
    createdById: sale.createdById,
    total: money(sale.total),
    confirmedAt: sale.confirmedAt ? sale.confirmedAt.toISOString() : null,
    createdAt: sale.createdAt.toISOString(),
    lines: sale.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      unit: line.unit,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice),
      lineTotal: money(line.lineTotal),
      balanceAfter: line.balanceAfter,
    })),
  };
}

/**
 * Sales (SAL-01..SAL-04). Store employees record and confirm sales for their assigned
 * store; managers and administrators can view them. The store scope is enforced on every
 * read and write (NFR-01). All posting rules live in `sales.ts`.
 */
@Controller()
export class SalesController {
  constructor(private readonly prisma: PrismaService) {}

  /** Load a sale the caller may see, or throw 404 / 403. */
  private async visibleSale(user: User, id: string): Promise<SaleRecord> {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: SALE_INCLUDE });
    if (!sale) {
      throw new ORPCError('NOT_FOUND', {
        data: { code: 'SALE_NOT_FOUND', message: 'ไม่พบใบขาย' },
      });
    }
    assertStoreScope(user, sale.storeId);
    return sale;
  }

  @Roles('STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR')
  @Implement(contract.sales.list)
  list(@CurrentUser() user: User) {
    return implement(contract.sales.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      let where = {};
      if (user.role === 'STORE_EMPLOYEE') {
        assertStoreScope(user, user.storeId ?? '');
        where = { storeId: user.storeId };
      }
      const [rows, total] = await Promise.all([
        this.prisma.sale.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: SALE_INCLUDE,
        }),
        this.prisma.sale.count({ where }),
      ]);
      return { items: rows.map(toSale), total, page, pageSize };
    });
  }

  @Roles('STORE_EMPLOYEE', 'MANAGER', 'ADMINISTRATOR')
  @Implement(contract.sales.get)
  get(@CurrentUser() user: User) {
    return implement(contract.sales.get).handler(async ({ input }) =>
      toSale(await this.visibleSale(user, input.id)),
    );
  }

  @Roles('STORE_EMPLOYEE')
  @Implement(contract.sales.create)
  create(@CurrentUser() user: User) {
    return implement(contract.sales.create).handler(async ({ input }) =>
      toSale(await createDraftSale(this.prisma, user, input)),
    );
  }

  @Roles('STORE_EMPLOYEE')
  @Implement(contract.sales.update)
  update(@CurrentUser() user: User) {
    return implement(contract.sales.update).handler(async ({ input }) =>
      toSale(await replaceDraftLines(this.prisma, user, input.id, input.lines)),
    );
  }

  @Roles('STORE_EMPLOYEE')
  @Implement(contract.sales.confirm)
  confirm(@CurrentUser() user: User) {
    return implement(contract.sales.confirm).handler(async ({ input }) =>
      toSale(
        await confirmSale(this.prisma, user, input.params.id, input.headers['idempotency-key']),
      ),
    );
  }

  @Roles('STORE_EMPLOYEE')
  @Implement(contract.sales.cancel)
  cancel(@CurrentUser() user: User) {
    return implement(contract.sales.cancel).handler(async ({ input }) =>
      this.refuseAction(user, input.id),
    );
  }

  @Roles('STORE_EMPLOYEE')
  @Implement(contract.sales.return)
  return(@CurrentUser() user: User) {
    return implement(contract.sales.return).handler(async ({ input }) =>
      this.refuseAction(user, input.id),
    );
  }

  /** Neither action exists in this release (SAL-04, Q-04); say so rather than 404. */
  private async refuseAction(user: User, id: string): Promise<never> {
    const sale = await this.visibleSale(user, id);
    if (sale.status === 'CONFIRMED') throw saleConfirmedImmutable();
    throw new ORPCError('CONFLICT', {
      data: {
        code: 'SALE_ACTION_UNAVAILABLE',
        message: 'ยังไม่รองรับการยกเลิกหรือคืนสินค้าในรุ่นนี้',
      },
    });
  }
}
