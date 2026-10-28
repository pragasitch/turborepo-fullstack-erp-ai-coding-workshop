import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';

@Module({
  controllers: [ReportsController],
})
export class ReportsModule {}
