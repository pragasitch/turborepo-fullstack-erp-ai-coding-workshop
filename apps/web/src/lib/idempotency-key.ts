/**
 * A fresh `Idempotency-Key` for one confirm attempt. Reuse the same key for every retry of
 * that attempt (SAL-03, GR-04). `randomUUID` only exists in secure contexts (https,
 * localhost); `getRandomValues` works everywhere, so use it when the first is missing.
 */
export function newIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
