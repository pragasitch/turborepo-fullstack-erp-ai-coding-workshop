import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';

@Module({
  controllers: [SalesController],
})
export class SalesModule {}
