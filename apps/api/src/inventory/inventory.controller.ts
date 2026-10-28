import { Controller } from '@nestjs/common';
import { contract, type User } from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { CurrentUser } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { listStockLevels } from './stock-levels.js';

/**
 * Stock search / low-stock view (INV-01). Any signed-in role may read stock; store
 * employees only for their assigned store. Every (product, store) pair is listed, so a
 * product with no stock record shows quantity 0 instead of disappearing (RPT-02).
 */
@Controller()
export class InventoryController {
  constructor(private readonly prisma: PrismaService) {}

  @Implement(contract.inventory.list)
  list(@CurrentUser() user: User) {
    return implement(contract.inventory.list).handler(({ input }) =>
      listStockLevels(this.prisma, user, input),
    );
  }
}
