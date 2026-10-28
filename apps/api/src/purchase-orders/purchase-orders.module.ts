import { Module } from '@nestjs/common';
import { PurchaseOrdersController } from './purchase-orders.controller.js';

@Module({ controllers: [PurchaseOrdersController] })
export class PurchaseOrdersModule {}
