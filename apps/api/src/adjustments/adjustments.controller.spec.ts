import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { call } from '@orpc/server';
import { ORPCError } from '@orpc/nest';
import type { User } from '@erp/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { AdjustmentsController } from './adjustments.controller.js';

async function createController(prisma: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [AdjustmentsController],
    providers: [{ provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(AdjustmentsController);
}

function user(role: User['role']): User {
  return { id: 'mgr1', email: 'manager01@erp.local', name: 'Manager 01', role, storeId: null };
}

const manager = user('MANAGER');

describe('AdjustmentsController.create (INV-05)', () => {
  it('records an adjustment through a single transaction and returns the result', async () => {
    const movement = {
      balanceAfter: 15,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    // $queryRaw is called twice: first for the ADJ document number, then for the
    // conditional balance UPDATE. Return the row shape each caller expects.
    const $queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ lastValue: 1 }])
      .mockResolvedValueOnce([{ quantity: 15 }]);
    const tx = {
      $queryRaw,
      $executeRaw: vi.fn().mockResolvedValue(1),
      stockMovement: { create: vi.fn().mockResolvedValue(movement) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const $transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(tx));
    const controller = await createController({ $transaction });

    const result = await call(controller.create(manager), {
      productId: 'p1',
      storeId: 's1',
      quantityChange: 5,
      reason: 'นับสต็อกใหม่',
    });

    expect(result).toMatchObject({
      documentNumber: 'ADJ-000001',
      quantityChange: 5,
      balanceAfter: 15,
      reason: 'นับสต็อกใหม่',
    });
    // The movement is an ADJUSTMENT attributed to the signed-in manager.
    expect(tx.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'ADJUSTMENT', actorId: 'mgr1' }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'STOCK_ADJUSTMENT', outcome: 'SUCCESS' }),
      }),
    );
  });

  it('rejects a blank reason before any write (AC2)', async () => {
    const $transaction = vi.fn();
    const controller = await createController({ $transaction });

    await expect(
      call(controller.create(manager), {
        productId: 'p1',
        storeId: 's1',
        quantityChange: 5,
        reason: '',
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('rejects a zero quantity change before any write', async () => {
    const $transaction = vi.fn();
    const controller = await createController({ $transaction });

    await expect(
      call(controller.create(manager), {
        productId: 'p1',
        storeId: 's1',
        quantityChange: 0,
        reason: 'ไม่มีผล',
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect($transaction).not.toHaveBeenCalled();
  });
});

describe('AdjustmentsController.auditList (NFR-03)', () => {
  const entry = {
    id: 'a1',
    actorId: 'mgr1',
    actor: { name: 'Manager 01' },
    action: 'STOCK_ADJUSTMENT',
    sourceDocumentType: 'ADJUSTMENT',
    sourceDocumentId: 'ADJ-000001',
    outcome: 'SUCCESS',
    detail: 'นับสต็อกใหม่',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  it('lists audit entries newest-first with pagination metadata', async () => {
    const findMany = vi.fn().mockResolvedValue([entry]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ auditLog: { findMany, count } });

    const result = await call(controller.auditList(), { page: 1, pageSize: 20 });

    expect(result).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      items: [
        expect.objectContaining({
          id: 'a1',
          actorName: 'Manager 01',
          action: 'STOCK_ADJUSTMENT',
          outcome: 'SUCCESS',
        }),
      ],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }),
    );
  });
});

/**
 * Role enforcement (NFR-01/NFR-03), observable at seam 1 through the metadata the global
 * AuthGuard reads. Only a Manager may adjust stock (AC4); only a Manager or Administrator
 * may read the audit trail (AC5).
 */
describe('AdjustmentsController role enforcement', () => {
  const reflector = new Reflector();

  it('restricts create to MANAGER (AC4)', async () => {
    const controller = await createController({});
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller).create as () => unknown,
    );

    expect(roles).toEqual(['MANAGER']);
  });

  it('restricts auditList to MANAGER and ADMINISTRATOR (AC5)', async () => {
    const controller = await createController({});
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller).auditList as () => unknown,
    );

    expect(roles).toEqual(['MANAGER', 'ADMINISTRATOR']);
  });
});
