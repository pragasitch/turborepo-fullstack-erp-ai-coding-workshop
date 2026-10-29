/**
 * The statistics behind the NFR-05 load-test report. Kept pure and separate from the
 * request driver so the percentile and pass/fail logic is unit-tested without a server.
 */

/** Latency summary for one endpoint over a load-test run. All values are milliseconds. */
export type LatencySummary = {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
};

/**
 * Nearest-rank percentile (0 < p <= 100): sort ascending, take the ceil(p/100 * n)-th
 * sample (1-based). No interpolation, so the result is always an observed value — which is
 * what a latency report should quote. Throws on an empty set rather than inventing a number.
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error('percentile of an empty sample set');
  if (p <= 0 || p > 100) throw new Error(`percentile p must be in (0, 100], got ${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] as number;
}

export function summarize(latencies: number[]): LatencySummary {
  if (latencies.length === 0) throw new Error('cannot summarize an empty sample set');
  const sum = latencies.reduce((acc, value) => acc + value, 0);
  return {
    count: latencies.length,
    min: Math.min(...latencies),
    max: Math.max(...latencies),
    mean: sum / latencies.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };
}

/** NFR-05 is met when the 95th-percentile latency is at or under the ceiling (ms). */
export function meetsTarget(summary: LatencySummary, p95CeilingMs: number): boolean {
  return summary.p95 <= p95CeilingMs;
}
