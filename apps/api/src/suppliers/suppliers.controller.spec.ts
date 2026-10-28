import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { call } from '@orpc/server';
import { ORPCError } from '@orpc/nest';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { SuppliersController } from './suppliers.controller.js';

async function createController(prisma: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [SuppliersController],
    providers: [{ provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(SuppliersController);
}

const supplyOne = {
  id: 'sup1',
  code: 'SUP01',
  name: 'SupplyOne Co Ltd',
  contactPerson: null,
  phone: null,
  email: null,
  address: null,
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('SuppliersController', () => {
  it('lists suppliers newest-first with pagination metadata', async () => {
    const findMany = vi.fn().mockResolvedValue([supplyOne]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ supplier: { findMany, count } });

    const result = await call(controller.list(), { page: 1, pageSize: 20 });

    expect(result).toEqual({
      items: [
        {
          ...supplyOne,
          createdAt: supplyOne.createdAt.toISOString(),
          updatedAt: supplyOne.updatedAt.toISOString(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
    });
  });

  it('skips the right window for a later page', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const controller = await createController({ supplier: { findMany, count } });

    await call(controller.list(), { page: 3, pageSize: 10 });

    expect(findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' }, skip: 20, take: 10 });
  });

  it('creates a supplier with a unique code and returns it', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(supplyOne);
    const controller = await createController({ supplier: { findUnique, create } });

    const result = await call(controller.create(), { code: 'SUP01', name: 'SupplyOne Co Ltd' });

    expect(result).toMatchObject({ id: 'sup1', code: 'SUP01', name: 'SupplyOne Co Ltd' });
    expect(create).toHaveBeenCalledWith({
      data: {
        code: 'SUP01',
        name: 'SupplyOne Co Ltd',
        contactPerson: null,
        phone: null,
        email: null,
        address: null,
      },
    });
  });

  it('persists optional contact details when provided', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(supplyOne);
    const controller = await createController({ supplier: { findUnique, create } });

    await call(controller.create(), {
      code: 'SUP01',
      name: 'SupplyOne Co Ltd',
      contactPerson: 'Somchai',
      phone: '021234567',
      email: 'sales@supplyone.co.th',
      address: 'Bangkok',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        code: 'SUP01',
        name: 'SupplyOne Co Ltd',
        contactPerson: 'Somchai',
        phone: '021234567',
        email: 'sales@supplyone.co.th',
        address: 'Bangkok',
      },
    });
  });

  it('rejects a duplicate code with the Thai error envelope', async () => {
    const findUnique = vi.fn().mockResolvedValue(supplyOne);
    const create = vi.fn();
    const controller = await createController({ supplier: { findUnique, create } });

    const error = await call(controller.create(), { code: 'SUP01', name: 'Another Co' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ORPCError);
    const orpcError = error as ORPCError<string, unknown>;
    expect(orpcError.code).toBe('CONFLICT');
    expect(orpcError.data).toMatchObject({
      code: 'SUPPLIER_CODE_TAKEN',
      message: 'รหัสผู้ขายนี้ถูกใช้แล้ว',
      fields: ['code'],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a blank name before touching the database', async () => {
    const create = vi.fn();
    const controller = await createController({ supplier: { create } });

    await expect(call(controller.create(), { code: 'SUP01', name: '' })).rejects.toBeInstanceOf(
      ORPCError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an invalid email before touching the database', async () => {
    const create = vi.fn();
    const controller = await createController({ supplier: { create } });

    await expect(
      call(controller.create(), { code: 'SUP01', name: 'SupplyOne Co Ltd', email: 'nope' }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it('updates a supplier and returns it', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const update = vi.fn().mockResolvedValue({ ...supplyOne, name: 'SupplyOne Renamed' });
    const controller = await createController({ supplier: { findUnique, update } });

    const result = await call(controller.update(), {
      id: 'sup1',
      code: 'SUP01',
      name: 'SupplyOne Renamed',
    });

    expect(result).toMatchObject({ id: 'sup1', name: 'SupplyOne Renamed' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'sup1' },
      data: {
        code: 'SUP01',
        name: 'SupplyOne Renamed',
        contactPerson: null,
        phone: null,
        email: null,
        address: null,
      },
    });
  });

  it('rejects an update whose code belongs to another supplier with the Thai envelope', async () => {
    const findUnique = vi.fn().mockResolvedValue({ ...supplyOne, id: 'other' });
    const update = vi.fn();
    const controller = await createController({ supplier: { findUnique, update } });

    const error = await call(controller.update(), {
      id: 'sup1',
      code: 'SUP01',
      name: 'Another Co',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).data).toMatchObject({
      code: 'SUPPLIER_CODE_TAKEN',
      fields: ['code'],
    });
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * Role enforcement (NFR-01) is observable at seam 1 through the `@Roles('ADMINISTRATOR')`
 * metadata the global AuthGuard reads; the guard's allow/deny behaviour itself is proven
 * in `auth.guard.spec.ts`.
 */
describe('SuppliersController role enforcement', () => {
  const reflector = new Reflector();
  const rolesOf = async (method: 'list' | 'create' | 'update') => {
    const controller = await createController({});
    return reflector.get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller)[method] as () => unknown,
    );
  };

  it.each(['create', 'update'] as const)('restricts %s to ADMINISTRATOR', async (method) => {
    expect(await rolesOf(method)).toEqual(['ADMINISTRATOR']);
  });

  // A Purchasing officer must read suppliers to raise a purchase order (PO-01).
  it('lets an administrator or a purchasing officer list', async () => {
    expect(await rolesOf('list')).toEqual(['ADMINISTRATOR', 'PURCHASING_OFFICER']);
  });
});
