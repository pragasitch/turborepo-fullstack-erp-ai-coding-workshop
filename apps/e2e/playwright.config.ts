import { defineConfig, devices } from '@playwright/test';

// Browser tests for the Demo: lines. On your machine they run against the Docker stack
// (the two servers below are reused when they are already up); in CI Playwright starts
// the built API and the built web app itself. See lessons/10 and the write-e2e skill.

// Same host ports as compose.yaml, overridable from the repo-root .env like Prisma does.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No .env file: the defaults below apply.
}

const isCI = !!process.env.CI;
const apiPort = process.env.API_PORT ?? '3000';
const webPort = process.env.WEB_PORT ?? '5173';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: true,
  // A test that passes on retry is a bug in the test. Zero retries, and a trace for every failure.
  retries: 0,
  // One API + one web server back every worker. On CI (2 shared vCPUs) a flood of parallel
  // browser contexts starves them, so a correct UI can take longer than Playwright's 5s
  // default to settle (a freshly created row refetching into a list, say). Cap the workers
  // and give assertions real headroom so the suite stays deterministic rather than timing
  // out under load. Locally (reusing the Docker stack) parallelism is left unbounded.
  workers: isCI ? 2 : undefined,
  expect: { timeout: 15_000 },
  forbidOnly: isCI,
  reporter: isCI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    // Signs in once per account and saves the cookies. Tests opt in with test.use({ storageState }).
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },
  ],
  webServer: [
    {
      command: 'pnpm --filter @erp/api start',
      url: `http://localhost:${apiPort}/api/health`,
      env: { PORT: apiPort },
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @erp/web preview --port ${webPort}`,
      url: baseURL,
      env: { API_PROXY_TARGET: `http://localhost:${apiPort}` },
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
