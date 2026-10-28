import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';
export * from './fixture.js';
// Money columns come back as Decimal. The bundled `Prisma` namespace types drop its value.
export { Decimal } from '@prisma/client/runtime/client';
export { hashPassword, verifyPassword } from './password.js';

/** Prisma 7 talks to Postgres through a driver adapter (node-postgres). */
export function createPrismaAdapter(connectionString: string) {
  return new PrismaPg({ connectionString });
}

export function createPrismaClient(connectionString: string) {
  return new PrismaClient({ adapter: createPrismaAdapter(connectionString) });
}
