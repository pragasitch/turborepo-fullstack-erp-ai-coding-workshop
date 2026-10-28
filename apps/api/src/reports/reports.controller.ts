import { Controller } from '@nestjs/common';
import { contract, type User } from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { CurrentUser } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { listStockLevels } from '../inventory/stock-levels.js';

/**
 * Stock reports (RPT-02). Any signed-in role may read them, with the same store
 * permission as the stock screen: store employees only for their assigned store,
 * enforced by the stock query both share.
 */
@Controller()
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Every (product, store) pair, zero-stock products included. */
  @Implement(contract.reports.stockOnHand)
  stockOnHand(@CurrentUser() user: User) {
    return implement(contract.reports.stockOnHand).handler(({ input }) =>
      listStockLevels(this.prisma, user, input),
    );
  }

  /** Only the pairs whose balance is at or below the store's reorder threshold. */
  @Implement(contract.reports.lowStock)
  lowStock(@CurrentUser() user: User) {
    return implement(contract.reports.lowStock).handler(({ input }) =>
      listStockLevels(this.prisma, user, input, { lowStockOnly: true }),
    );
  }
}
