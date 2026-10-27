import { describe, expect, it } from 'vitest';
import { AuditListQuerySchema, CreateAdjustmentSchema } from './adjustments.js';

const base = { productId: 'p1', storeId: 's1', quantityChange: 5, reason: 'นับสต็อกใหม่' };

describe('CreateAdjustmentSchema', () => {
  it('accepts a positive adjustment with a reason', () => {
    expect(CreateAdjustmentSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a negative adjustment with a reason', () => {
    expect(CreateAdjustmentSchema.safeParse({ ...base, quantityChange: -3 }).success).toBe(true);
  });

  it('rejects a zero quantity change', () => {
    expect(CreateAdjustmentSchema.safeParse({ ...base, quantityChange: 0 }).success).toBe(false);
  });

  it('rejects a fractional quantity change', () => {
    expect(CreateAdjustmentSchema.safeParse({ ...base, quantityChange: 1.5 }).success).toBe(false);
  });

  it('rejects a missing reason', () => {
    const { reason: _reason, ...withoutReason } = base;
    expect(CreateAdjustmentSchema.safeParse(withoutReason).success).toBe(false);
  });

  it('rejects a blank or whitespace-only reason (AC2)', () => {
    expect(CreateAdjustmentSchema.safeParse({ ...base, reason: '' }).success).toBe(false);
    expect(CreateAdjustmentSchema.safeParse({ ...base, reason: '   ' }).success).toBe(false);
  });

  it('requires a product and a store', () => {
    expect(CreateAdjustmentSchema.safeParse({ ...base, productId: '' }).success).toBe(false);
    expect(CreateAdjustmentSchema.safeParse({ ...base, storeId: '' }).success).toBe(false);
  });
});

describe('AuditListQuerySchema', () => {
  it('defaults page and pageSize', () => {
    const result = AuditListQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ page: 1, pageSize: 20 });
    }
  });

  it('rejects a page below 1', () => {
    expect(AuditListQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});
