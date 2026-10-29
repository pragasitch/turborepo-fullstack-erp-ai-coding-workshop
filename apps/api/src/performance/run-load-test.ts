/**
 * NFR-05 load-test harness. Drives the search and stock-view APIs with a number of
 * simulated concurrent users for a continuous run, then prints a per-endpoint latency
 * report and exits non-zero unless every targeted endpoint's p95 is within the ceiling.
 *
 * It does not seed: run `seedPerformanceDataset` against the target database first (see
 * README / the repo's load-test instructions), so the dataset is the same one the seam-4
 * integration spec measures. CSV exports are deliberately excluded (TOR NFR-05).
 *
 *   Defaults (TOR NFR-05): 10 users, 300 s, p95 ceiling 2000 ms, against the local API.
 *   Override with env: LOAD_USERS, LOAD_DURATION_SECONDS, LOAD_P95_CEILING_MS,
 *   LOAD_BASE_URL, LOAD_EMAIL, LOAD_PASSWORD.
 *
 * Run: pnpm --filter @erp/api load-test   (API and Postgres must be up and seeded).
 */
import { meetsTarget, summarize, type LatencySummary } from './load-test.js';
import { PERFORMANCE_MANAGER, performanceSku } from '@erp/database';

type Config = {
  users: number;
  durationMs: number;
  p95CeilingMs: number;
  baseUrl: string;
  email: string;
  password: string;
};

function readConfig(): Config {
  return {
    users: Number(process.env.LOAD_USERS ?? 10),
    durationMs: Number(process.env.LOAD_DURATION_SECONDS ?? 300) * 1_000,
    p95CeilingMs: Number(process.env.LOAD_P95_CEILING_MS ?? 2_000),
    baseUrl: (process.env.LOAD_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    email: process.env.LOAD_EMAIL ?? PERFORMANCE_MANAGER.email,
    password: process.env.LOAD_PASSWORD ?? PERFORMANCE_MANAGER.password,
  };
}

/** Sign in and return the session cookie to send on every subsequent request. */
async function login(config: Config): Promise<string> {
  const response = await fetch(`${config.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  if (!response.ok) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('login returned no session cookie');
  // The cookie jar is just the name=value pairs, enough to echo back.
  return setCookie
    .split(/,(?=[^;]+?=)/)
    .map((part) => (part.split(';')[0] ?? '').trim())
    .filter((pair) => pair.length > 0)
    .join('; ');
}

/**
 * The two targeted endpoints (search + stock-view); CSV exports are excluded by NFR-05.
 * The search alternates between a SKU term and a product-name term so both trigram indexes
 * are exercised, not just the SKU one.
 */
const PRODUCT_POOL = 1_000;
const ENDPOINTS = {
  search: (base: string, i: number) => {
    const n = (i % PRODUCT_POOL) + 1;
    const term = i % 2 === 0 ? performanceSku(n) : encodeURIComponent(`สินค้า ${n}`);
    return `${base}/api/inventory?search=${term}`;
  },
  'stock-view': (base: string, i: number) => `${base}/api/inventory?page=${(i % 50) + 1}`,
} as const;

type EndpointName = keyof typeof ENDPOINTS;

/** The outcome of one request: its latency, and whether it was a 2xx. */
type Sample = { ms: number; ok: boolean };

async function timedGet(url: string, cookie: string): Promise<Sample> {
  const start = performance.now();
  const response = await fetch(url, { headers: { cookie } });
  await response.arrayBuffer(); // drain the body so the timing covers the whole response
  return { ms: performance.now() - start, ok: response.ok };
}

/**
 * One simulated user: hit each endpoint in turn until the deadline, recording latencies.
 * A non-2xx is counted (as an error and a latency sample) rather than aborting the run, so
 * one transient failure never discards the whole report.
 */
async function runUser(
  config: Config,
  cookie: string,
  deadline: number,
  samples: Record<EndpointName, number[]>,
  errors: Record<EndpointName, number>,
): Promise<void> {
  const names = Object.keys(ENDPOINTS) as EndpointName[];
  let i = 0;
  while (performance.now() < deadline) {
    for (const name of names) {
      const url = ENDPOINTS[name](config.baseUrl, i);
      const sample = await timedGet(url, cookie);
      samples[name].push(sample.ms);
      if (!sample.ok) errors[name] += 1;
    }
    i += 1;
  }
}

function reportLine(
  name: string,
  summary: LatencySummary,
  errorCount: number,
  ceiling: number,
): string {
  const ok = meetsTarget(summary, ceiling) && errorCount === 0 ? 'PASS' : 'FAIL';
  const n = (value: number) => value.toFixed(0).padStart(5);
  return (
    `${name.padEnd(12)} n=${String(summary.count).padStart(6)}  ` +
    `p50=${n(summary.p50)}  p95=${n(summary.p95)}  p99=${n(summary.p99)}  ` +
    `max=${n(summary.max)}  err=${errorCount}  [${ok}]`
  );
}

export async function main(): Promise<number> {
  const config = readConfig();
  console.log(
    `NFR-05 load test: ${config.users} users, ${config.durationMs / 1_000}s, ` +
      `p95 ceiling ${config.p95CeilingMs}ms, target ${config.baseUrl}`,
  );

  const cookie = await login(config);
  const samples: Record<EndpointName, number[]> = { search: [], 'stock-view': [] };
  const errors: Record<EndpointName, number> = { search: 0, 'stock-view': 0 };
  const deadline = performance.now() + config.durationMs;

  await Promise.all(
    Array.from({ length: config.users }, () => runUser(config, cookie, deadline, samples, errors)),
  );

  let allMet = true;
  console.log('\nResults (latency in ms):');
  for (const name of Object.keys(ENDPOINTS) as EndpointName[]) {
    if (samples[name].length === 0) {
      console.log(`${name}: no samples`);
      allMet = false;
      continue;
    }
    const summary = summarize(samples[name]);
    console.log(reportLine(name, summary, errors[name], config.p95CeilingMs));
    allMet &&= meetsTarget(summary, config.p95CeilingMs) && errors[name] === 0;
  }

  console.log(
    `\nNFR-05 ${allMet ? 'MET' : 'NOT MET'}: p95 <= ${config.p95CeilingMs}ms and no errors ` +
      `for every endpoint.`,
  );
  return allMet ? 0 : 1;
}

// Run only when invoked directly, never on import (so the unit test can load the stats).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
