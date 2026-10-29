import { describe, expect, it } from 'vitest';
import { meetsTarget, percentile, summarize } from './load-test.js';

describe('load-test statistics (NFR-05)', () => {
  describe('percentile', () => {
    // 1..100 inclusive: the nearest-rank p95 is 95, p50 is 50, p99 is 99 (worked by hand).
    const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

    it('uses nearest-rank: p95 of 1..100 is 95', () => {
      expect(percentile(oneToHundred, 95)).toBe(95);
      expect(percentile(oneToHundred, 50)).toBe(50);
      expect(percentile(oneToHundred, 99)).toBe(99);
      expect(percentile(oneToHundred, 100)).toBe(100);
    });

    it('does not assume the input is sorted', () => {
      expect(percentile([30, 10, 20], 100)).toBe(30);
      expect(percentile([30, 10, 20], 1)).toBe(10);
    });

    it('is the single value for a one-sample set', () => {
      expect(percentile([42], 95)).toBe(42);
    });

    it('throws on an empty sample set rather than inventing a number', () => {
      expect(() => percentile([], 95)).toThrow();
    });
  });

  describe('summarize', () => {
    it('reports count and the p95 from the samples', () => {
      const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
      const summary = summarize(latencies);
      expect(summary.count).toBe(100);
      expect(summary.min).toBe(1);
      expect(summary.max).toBe(100);
      expect(summary.p50).toBe(50);
      expect(summary.p95).toBe(95);
      expect(summary.p99).toBe(99);
    });
  });

  describe('meetsTarget', () => {
    // NFR-05: p95 <= 2000 ms.
    it('passes when p95 is at or under the ceiling and fails above it', () => {
      expect(meetsTarget(summarize([1000, 1500, 1800, 1900, 2000]), 2000)).toBe(true);
      expect(meetsTarget(summarize([2001, 2001, 2001]), 2000)).toBe(false);
    });
  });
});
