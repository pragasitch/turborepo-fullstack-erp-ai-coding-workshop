import { Module } from '@nestjs/common';
import { GoodsReceiptsController } from './goods-receipts.controller.js';

@Module({
  controllers: [GoodsReceiptsController],
})
export class GoodsReceiptsModule {}
