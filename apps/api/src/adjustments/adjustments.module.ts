import { Module } from '@nestjs/common';
import { AdjustmentsController } from './adjustments.controller.js';

@Module({
  controllers: [AdjustmentsController],
})
export class AdjustmentsModule {}
