import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { call } from '@orpc/server';
import { ORPCError } from '@orpc/nest';
import type { PurchaseOrderStatus, User } from '@erp/contracts';
import { Decimal } from '@erp/database';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { PurchaseOrdersController } from './purchase-orders.controller.js';

async function createController(prisma: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [PurchaseOrdersController],
    providers: [{ provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(PurchaseOrdersController);
}

function user(role: User['role'], storeId: string | null = null): User {
  return { id: `${role}-1`, email: `${role}@erp.local`, name: role, role, storeId };
}

const officer = user('PURCHASING_OFFICER');
const manager = user('MANAGER');
const D = (value: string) => new Decimal(value);

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  sku: 'SKU001',
  name: 'น้ำดื่มแพ็ค 6',
  unit: 'แพ็ค',
  sellingPrice: D('60.00'),
  isActive: true,
  ...overrides,
});

const validInput = () => ({
  supplierId: 'sup1',
  storeId: 'b01',
  expectedReceiptDate: '2026-02-01',
  lines: [{ productId: 'p1', quantity: 2, unitPrice: '10.00' }],
});

function poRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'po1',
    documentNumber: null,
    status: 'DRAFT',
    supplierId: 'sup1',
    supplier: { code: 'SUP01' },
    storeId: 'b01',
    store: { code: 'B01' },
    createdById: officer.id,
    expectedReceiptDate: new Date('2026-02-01T00:00:00.000Z'),
    total: D('20.00'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    lines: [
      {
        id: 'l1',
        purchaseOrderId: 'po1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'น้ำดื่มแพ็ค 6',
        unit: 'แพ็ค',
        quantity: 2,
        unitPrice: D('10.00'),
        lineTotal: D('20.00'),
      },
    ],
    ...overrides,
  };
}

/** A stub whose transaction runs against `tx`, with the row lock answering `lockedId`. */
function withTransaction(tx: Record<string, unknown>, lockedId = 'po1') {
  const full = { $queryRaw: vi.fn().mockResolvedValue([{ id: lockedId }]), ...tx };
  return { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(full)), tx: full };
}

describe('PurchaseOrdersController.create (PO-01)', () => {
  it('persists a draft with the supplier, store, expected date and priced lines', async () => {
    const create = vi.fn().mockResolvedValue(poRow());
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      purchaseOrder: { create },
    });

    const result = await call(controller.create(officer), validInput());

    expect(result).toMatchObject({
      status: 'DRAFT',
      documentNumber: null,
      supplierCode: 'SUP01',
      storeCode: 'B01',
      expectedReceiptDate: '2026-02-01',
      total: '20.00',
      lines: [{ sku: 'SKU001', quantity: 2, unitPrice: '10.00', lineTotal: '20.00' }],
    });
    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ supplierId: 'sup1', storeId: 'b01', createdById: officer.id });
    expect(data.total.toFixed(2)).toBe('20.00');
    expect(data.lines.create[0]).toMatchObject({ sku: 'SKU001', quantity: 2 });
    expect(data.lines.create[0].unitPrice.toFixed(2)).toBe('10.00');
    expect(data.lines.create[0].lineTotal.toFixed(2)).toBe('20.00');
  });

  it('rejects a draft with zero lines before touching the database', async () => {
    const create = vi.fn();
    const controller = await createController({ purchaseOrder: { create } });

    await expect(
      call(controller.create(officer), { ...validInput(), lines: [] }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([0, -2, 1.5])('rejects the ordered quantity %s', async (quantity) => {
    const create = vi.fn();
    const controller = await createController({ purchaseOrder: { create } });

    await expect(
      call(controller.create(officer), {
        ...validInput(),
        lines: [{ productId: 'p1', quantity, unitPrice: '10.00' }],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['-1.00', '10', '10.5'])('rejects the unit price %j', async (unitPrice) => {
    const create = vi.fn();
    const controller = await createController({ purchaseOrder: { create } });

    await expect(
      call(controller.create(officer), {
        ...validInput(),
        lines: [{ productId: 'p1', quantity: 2, unitPrice }],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate SKU (same product twice) before touching the database', async () => {
    const create = vi.fn();
    const controller = await createController({ purchaseOrder: { create } });

    await expect(
      call(controller.create(officer), {
        ...validInput(),
        lines: [
          { productId: 'p1', quantity: 2, unitPrice: '10.00' },
          { productId: 'p1', quantity: 3, unitPrice: '12.00' },
        ],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 404 for a supplier that does not exist', async () => {
    const create = vi.fn();
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue(null) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      purchaseOrder: { create },
    });

    await expect(call(controller.create(officer), validInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { code: 'SUPPLIER_NOT_FOUND' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 404 for a destination store that does not exist', async () => {
    const create = vi.fn();
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue(null) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      purchaseOrder: { create },
    });

    await expect(call(controller.create(officer), validInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { code: 'STORE_NOT_FOUND' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an inactive product', async () => {
    const create = vi.fn();
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product({ isActive: false })]) },
      purchaseOrder: { create },
    });

    await expect(call(controller.create(officer), validInput())).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { code: 'PRODUCT_INACTIVE' },
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('PurchaseOrdersController.update (edit a draft, PO-01)', () => {
  it('replaces the header and lines of a draft', async () => {
    const deleteMany = vi.fn();
    const update = vi.fn().mockResolvedValue(
      poRow({
        expectedReceiptDate: new Date('2026-03-01T00:00:00.000Z'),
        total: D('36.00'),
      }),
    );
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(poRow()), update },
      purchaseOrderLine: { deleteMany },
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
    });
    const controller = await createController({ $transaction });

    const result = await call(controller.update(officer), {
      id: 'po1',
      supplierId: 'sup1',
      storeId: 'b01',
      expectedReceiptDate: '2026-03-01',
      lines: [{ productId: 'p1', quantity: 3, unitPrice: '12.00' }],
    });

    expect(deleteMany).toHaveBeenCalledWith({ where: { purchaseOrderId: 'po1' } });
    expect(result).toMatchObject({ id: 'po1', total: '36.00' });
    const data = update.mock.calls[0]?.[0].data;
    expect(data.total.toFixed(2)).toBe('36.00');
    expect(data.lines.create[0]).toMatchObject({ quantity: 3 });
  });

  it('rejects an edit that leaves the order with zero lines', async () => {
    const deleteMany = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(poRow()), update: vi.fn() },
      purchaseOrderLine: { deleteMany },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.update(officer), {
        id: 'po1',
        supplierId: 'sup1',
        storeId: 'b01',
        expectedReceiptDate: '2026-03-01',
        lines: [],
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('answers 404 for an order that does not exist', async () => {
    const lock = vi.fn().mockResolvedValue([]);
    const controller = await createController({
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn({ $queryRaw: lock })),
    });

    await expect(
      call(controller.update(officer), {
        id: 'nope',
        supplierId: 'sup1',
        storeId: 'b01',
        expectedReceiptDate: '2026-03-01',
        lines: [{ productId: 'p1', quantity: 1, unitPrice: '1.00' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { code: 'PURCHASE_ORDER_NOT_FOUND' } });
  });
});

describe('PurchaseOrdersController.get / list (viewing)', () => {
  it('shows a draft with its supplier, store and lines', async () => {
    const controller = await createController({
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(poRow()) },
    });

    await expect(call(controller.get(officer), { id: 'po1' })).resolves.toMatchObject({
      id: 'po1',
      status: 'DRAFT',
      supplierCode: 'SUP01',
      storeCode: 'B01',
      expectedReceiptDate: '2026-02-01',
      lines: [{ sku: 'SKU001', quantity: 2, unitPrice: '10.00' }],
    });
  });

  it('answers 404 for an order that does not exist', async () => {
    const controller = await createController({
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(call(controller.get(officer), { id: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { code: 'PURCHASE_ORDER_NOT_FOUND' },
    });
  });

  it('lists newest first with pagination', async () => {
    const findMany = vi.fn().mockResolvedValue([poRow()]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ purchaseOrder: { findMany, count } });

    const result = await call(controller.list(officer), { page: 1, pageSize: 20 });

    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }),
    );
  });
});

describe('PurchaseOrdersController roles (NFR-01)', () => {
  const reflector = new Reflector();
  const rolesOf = async (method: keyof PurchaseOrdersController) => {
    const controller = await createController({});
    return reflector.get<string[]>(
      ROLES_KEY,
      Object.getPrototypeOf(controller)[method] as () => unknown,
    );
  };

  it.each(['create', 'update', 'submit'] as const)(
    'only a purchasing officer may %s',
    async (method) => {
      expect(await rolesOf(method)).toEqual(['PURCHASING_OFFICER']);
    },
  );

  it.each(['approve', 'reject'] as const)('only a manager may %s', async (method) => {
    expect(await rolesOf(method)).toEqual(['MANAGER']);
  });

  it.each(['get', 'list', 'cancel'] as const)(
    'a purchasing officer and a manager may %s',
    async (method) => {
      expect(await rolesOf(method)).toEqual(['PURCHASING_OFFICER', 'MANAGER']);
    },
  );
});

type Status = PurchaseOrderStatus;
const STATUSES: Status[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
];
type Action = 'submit' | 'approve' | 'reject' | 'cancel';
/** The five legal transitions of the agreed prototype, and no others (PO-02). */
const LEGAL: Record<Action, { from: Status[]; to: Status }> = {
  submit: { from: ['DRAFT'], to: 'PENDING_APPROVAL' },
  approve: { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
  reject: { from: ['PENDING_APPROVAL'], to: 'REJECTED' },
  cancel: { from: ['DRAFT', 'PENDING_APPROVAL'], to: 'CANCELLED' },
};
const ACTOR: Record<Action, User> = {
  submit: officer,
  approve: manager,
  reject: manager,
  cancel: manager,
};

/** A transaction over an order in `status`, with spies on everything that must not happen. */
function transitionHarness(status: Status) {
  const update = vi
    .fn()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      poRow({ status, ...data, decidedAt: data.decidedAt ?? null }),
    );
  const auditCreate = vi.fn().mockResolvedValue({});
  const stockMovementCreate = vi.fn();
  const stockBalanceWrite = vi.fn();
  const { $transaction, tx } = withTransaction({
    purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(poRow({ status })), update },
    auditLog: { create: auditCreate },
    stockMovement: { create: stockMovementCreate },
    stockBalance: {
      create: stockBalanceWrite,
      update: stockBalanceWrite,
      upsert: stockBalanceWrite,
    },
    $executeRaw: stockBalanceWrite,
  });
  return { $transaction, tx, update, auditCreate, stockMovementCreate, stockBalanceWrite };
}

async function run(controller: PurchaseOrdersController, action: Action, actor: User) {
  const input = action === 'submit' ? { id: 'po1' } : { id: 'po1', reason: 'เหตุผล' };
  return call(controller[action](actor), input);
}

describe('PurchaseOrdersController.submit (PO-03)', () => {
  it('moves a Draft to Pending Approval', async () => {
    const h = transitionHarness('DRAFT');
    const controller = await createController({ $transaction: h.$transaction });

    const result = await call(controller.submit(officer), { id: 'po1' });

    expect(result.status).toBe('PENDING_APPROVAL');
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'po1' }, data: { status: 'PENDING_APPROVAL' } }),
    );
  });
});

describe('PurchaseOrdersController.approve / reject (PO-03, NFR-03)', () => {
  it('approves a Pending Approval order with a reason and writes an audit row', async () => {
    const h = transitionHarness('PENDING_APPROVAL');
    const controller = await createController({ $transaction: h.$transaction });

    const result = await call(controller.approve(manager), { id: 'po1', reason: 'ราคาเหมาะสม' });

    expect(result).toMatchObject({ status: 'APPROVED', decisionReason: 'ราคาเหมาะสม' });
    expect(h.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'APPROVED',
      decisionReason: 'ราคาเหมาะสม',
      decidedById: manager.id,
    });
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: {
        actorId: manager.id,
        action: 'PO_APPROVAL',
        sourceDocumentType: 'PURCHASE_ORDER',
        sourceDocumentId: 'po1',
        outcome: 'SUCCESS',
        detail: 'ราคาเหมาะสม',
      },
    });
  });

  it('rejects a Pending Approval order with a reason and writes an audit row', async () => {
    const h = transitionHarness('PENDING_APPROVAL');
    const controller = await createController({ $transaction: h.$transaction });

    const result = await call(controller.reject(manager), { id: 'po1', reason: 'ราคาสูงเกินไป' });

    expect(result).toMatchObject({ status: 'REJECTED', decisionReason: 'ราคาสูงเกินไป' });
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: manager.id,
        action: 'PO_APPROVAL',
        sourceDocumentId: 'po1',
        outcome: 'REJECTED',
        detail: 'ราคาสูงเกินไป',
      }),
    });
  });

  it.each(['approve', 'reject'] as const)(
    '%s without a reason is refused and changes nothing',
    async (action) => {
      const h = transitionHarness('PENDING_APPROVAL');
      const controller = await createController({ $transaction: h.$transaction });

      for (const input of [{ id: 'po1' }, { id: 'po1', reason: '' }, { id: 'po1', reason: '  ' }]) {
        await expect(
          call(controller[action](manager), input as { id: string; reason: string }),
        ).rejects.toBeInstanceOf(ORPCError);
      }
      expect(h.$transaction).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
      expect(h.auditCreate).not.toHaveBeenCalled();
    },
  );

  it('never changes stock when approving', async () => {
    const h = transitionHarness('PENDING_APPROVAL');
    const controller = await createController({ $transaction: h.$transaction });

    await call(controller.approve(manager), { id: 'po1', reason: 'ok' });

    expect(h.stockMovementCreate).not.toHaveBeenCalled();
    expect(h.stockBalanceWrite).not.toHaveBeenCalled();
  });

  it('never changes stock when creating a draft', async () => {
    const stockMovementCreate = vi.fn();
    const stockBalanceWrite = vi.fn();
    const controller = await createController({
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup1', code: 'SUP01' }) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b01', code: 'B01' }) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
      purchaseOrder: { create: vi.fn().mockResolvedValue(poRow()) },
      stockMovement: { create: stockMovementCreate },
      stockBalance: { create: stockBalanceWrite, update: stockBalanceWrite },
      $executeRaw: stockBalanceWrite,
    });

    await call(controller.create(officer), validInput());

    expect(stockMovementCreate).not.toHaveBeenCalled();
    expect(stockBalanceWrite).not.toHaveBeenCalled();
  });

  it('answers 404 for an order that does not exist', async () => {
    const controller = await createController({
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) =>
        fn({ $queryRaw: vi.fn().mockResolvedValue([]) }),
      ),
    });

    await expect(
      call(controller.approve(manager), { id: 'nope', reason: 'ok' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', data: { code: 'PURCHASE_ORDER_NOT_FOUND' } });
  });
});

describe('PurchaseOrdersController.cancel (PO-04)', () => {
  it('lets the creator cancel their Draft with a reason', async () => {
    const h = transitionHarness('DRAFT');
    const controller = await createController({ $transaction: h.$transaction });

    const result = await call(controller.cancel(officer), { id: 'po1', reason: 'สั่งผิดผู้ขาย' });

    expect(result).toMatchObject({ status: 'CANCELLED', decisionReason: 'สั่งผิดผู้ขาย' });
  });

  it('lets a manager cancel an order pending approval', async () => {
    const h = transitionHarness('PENDING_APPROVAL');
    const controller = await createController({ $transaction: h.$transaction });

    const result = await call(controller.cancel(manager), { id: 'po1', reason: 'ยกเลิกโครงการ' });

    expect(result.status).toBe('CANCELLED');
  });

  it('refuses a purchasing officer who did not create the order', async () => {
    const h = transitionHarness('DRAFT');
    const controller = await createController({ $transaction: h.$transaction });
    const stranger = { ...officer, id: 'someone-else' };

    await expect(
      call(controller.cancel(stranger), { id: 'po1', reason: 'ไม่ใช่ของฉัน' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { code: 'PURCHASE_ORDER_CANCEL_FORBIDDEN' },
    });
    expect(h.update).not.toHaveBeenCalled();
  });

  it('cancelling without a reason is refused and changes nothing', async () => {
    const h = transitionHarness('DRAFT');
    const controller = await createController({ $transaction: h.$transaction });

    await expect(
      call(controller.cancel(officer), { id: 'po1', reason: ' ' }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe('purchase order state machine: no other transition exists (PO-02)', () => {
  const illegal = (Object.keys(LEGAL) as Action[]).flatMap((action) =>
    STATUSES.filter((status) => !LEGAL[action].from.includes(status)).map(
      (status) => [action, status] as const,
    ),
  );

  it.each(illegal)(
    '%s from %s is refused with a Thai error and changes nothing',
    async (action, status) => {
      const h = transitionHarness(status);
      const controller = await createController({ $transaction: h.$transaction });

      await expect(run(controller, action, ACTOR[action])).rejects.toMatchObject({
        code: 'CONFLICT',
        data: {
          code: 'PURCHASE_ORDER_INVALID_TRANSITION',
          message: expect.stringMatching(/[\u0E00-\u0E7F]/),
        },
      });
      expect(h.update).not.toHaveBeenCalled();
      expect(h.auditCreate).not.toHaveBeenCalled();
    },
  );

  const legal = (Object.keys(LEGAL) as Action[]).flatMap((action) =>
    LEGAL[action].from.map((status) => [action, status, LEGAL[action].to] as const),
  );

  it.each(legal)('%s from %s reaches %s', async (action, status, to) => {
    const h = transitionHarness(status);
    const controller = await createController({ $transaction: h.$transaction });

    await expect(run(controller, action, ACTOR[action])).resolves.toMatchObject({ status: to });
  });
});

describe('an order that has left Draft is immutable (PO-03)', () => {
  const frozen = STATUSES.filter((status) => status !== 'DRAFT');

  it.each(frozen)('editing an order in %s is refused and changes nothing', async (status) => {
    const deleteMany = vi.fn();
    const update = vi.fn();
    const { $transaction } = withTransaction({
      purchaseOrder: { findUniqueOrThrow: vi.fn().mockResolvedValue(poRow({ status })), update },
      purchaseOrderLine: { deleteMany },
      supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'sup2', code: 'SUP02' }) },
      store: { findUnique: vi.fn().mockResolvedValue({ id: 'b02', code: 'B02' }) },
      product: { findMany: vi.fn().mockResolvedValue([product()]) },
    });
    const controller = await createController({ $transaction });

    await expect(
      call(controller.update(officer), {
        id: 'po1',
        supplierId: 'sup2',
        storeId: 'b02',
        expectedReceiptDate: '2026-04-01',
        lines: [{ productId: 'p1', quantity: 99, unitPrice: '1.00' }],
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      data: {
        code: 'PURCHASE_ORDER_NOT_EDITABLE',
        message: expect.stringMatching(/[\u0E00-\u0E7F]/),
      },
    });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('a rejected order stays viewable (PO-03)', () => {
  it('shows a rejected order with its reason to an officer and a manager', async () => {
    const rejected = poRow({
      status: 'REJECTED',
      decisionReason: 'ราคาสูงเกินไป',
      decidedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    const controller = await createController({
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(rejected) },
    });

    for (const viewer of [officer, manager]) {
      await expect(call(controller.get(viewer), { id: 'po1' })).resolves.toMatchObject({
        status: 'REJECTED',
        decisionReason: 'ราคาสูงเกินไป',
        decidedAt: '2026-01-03T00:00:00.000Z',
      });
    }
  });

  it('keeps a rejected order in the list', async () => {
    const controller = await createController({
      purchaseOrder: {
        findMany: vi.fn().mockResolvedValue([poRow({ status: 'REJECTED' })]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await call(controller.list(manager), { page: 1, pageSize: 20 });

    expect(result.items[0]).toMatchObject({ id: 'po1', status: 'REJECTED' });
  });
});
