import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ORPCModule } from '@orpc/nest';
import { AdjustmentsModule } from './adjustments/adjustments.module.js';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { OpenApiModule } from './openapi/openapi.module.js';
import { ProductsModule } from './products/products.module.js';
import { StoresModule } from './stores/stores.module.js';
import { SuppliersModule } from './suppliers/suppliers.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Repo-root .env (optional). Real environment variables always take precedence.
      envFilePath: ['../../.env'],
      validate: validateEnv,
    }),
    ORPCModule.forRoot({}),
    DatabaseModule,
    AdjustmentsModule,
    AuthModule,
    HealthModule,
    InventoryModule,
    OpenApiModule,
    ProductsModule,
    StoresModule,
    SuppliersModule,
  ],
})
export class AppModule {}
