import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '@/components/require-auth';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { HomePage } from './home';
import { RootLayout } from './root-layout';
import { StockReportsPage } from './stock-reports';

const water = {
  productId: 'p1',
  sku: 'SKU001',
  productName: 'น้ำดื่มแพ็ค 6',
  unit: 'แพ็ค',
  storeId: 's1',
  storeCode: 'B01',
  storeName: 'สาขาเซ็นทรัล',
  quantity: 10,
  reorderThreshold: 3,
  isLowStock: false,
};
const tissue = { ...water, productId: 'p2', sku: 'SKU002', productName: 'ทิชชู่', quantity: 5 };
const detergent = {
  ...water,
  productId: 'p3',
  sku: 'SKU003',
  productName: 'น้ำยาซักผ้า',
  unit: 'ถุง',
  quantity: 0,
  isLowStock: true,
};
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
  ...extra,
});

const manager = {
  id: '4',
  email: 'manager01@erp.local',
  name: 'Manager 01',
  role: 'MANAGER',
  storeId: null,
};

/** The B01 fixture: SKU003 sits at 0, at or under its threshold of 3. */
const b01Reports = {
  'GET /reports/stock-on-hand': page([water, tissue, detergent]),
  'GET /reports/low-stock': page([detergent]),
};

function renderReports() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <StockReportsPage />
    </QueryClientProvider>,
  );
}

function renderApp(url = '/') {
  const router = createMemoryRouter(
    [
      {
        element: <RequireAuth />,
        children: [
          {
            path: '/',
            element: <RootLayout />,
            children: [
              { index: true, element: <HomePage /> },
              { path: 'reports/stock', element: <StockReportsPage /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const stockOnHand = () => screen.getByRole('region', { name: 'สต็อกคงเหลือ' });
const lowStock = () => screen.getByRole('region', { name: 'สินค้าสต็อกต่ำ' });

/** The requests the page made to one route, as URLs. */
function requests(fetchMock: ReturnType<typeof mockApi>, path: string) {
  return fetchMock.mock.calls
    .map(([req]: [Request]) => new URL(req.url))
    .filter((url) => url.pathname === `/api${path}`);
}

describe('StockReportsPage (RPT-02)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a loading state in both reports while they are pending', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );

    renderReports();

    expect(within(stockOnHand()).getByText('กำลังโหลด…')).toBeInTheDocument();
    expect(within(lowStock()).getByText('กำลังโหลด…')).toBeInTheDocument();
  });

  it('AC-08: lists SKU003 at balance 0 in the low-stock report, and not the healthy SKUs', async () => {
    mockApi(b01Reports);

    renderReports();

    const low = within(lowStock());
    const row = within(await low.findByRole('row', { name: /^SKU003 .* B01 / }));
    expect(row.getByRole('cell', { name: '0' })).toBeInTheDocument();
    expect(row.getByRole('cell', { name: '3' })).toBeInTheDocument();
    expect(row.getByText('สต็อกต่ำ')).toBeInTheDocument();
    expect(low.queryByRole('row', { name: /SKU001/ })).not.toBeInTheDocument();
    expect(low.queryByRole('row', { name: /SKU002/ })).not.toBeInTheDocument();
  });

  it('stock on hand lists every product with quantity, unit and threshold, zero stock included', async () => {
    mockApi(b01Reports);

    renderReports();

    const onHand = within(stockOnHand());
    const waterRow = within(await onHand.findByRole('row', { name: /^SKU001 / }));
    expect(waterRow.getByText('น้ำดื่มแพ็ค 6')).toBeInTheDocument();
    expect(waterRow.getByText('B01 สาขาเซ็นทรัล')).toBeInTheDocument();
    expect(waterRow.getByRole('cell', { name: '10' })).toBeInTheDocument();
    expect(waterRow.getByRole('cell', { name: 'แพ็ค' })).toBeInTheDocument();
    expect(waterRow.getByText('ปกติ')).toBeInTheDocument();
    expect(onHand.getByRole('row', { name: /^SKU002 / })).toBeInTheDocument();
    const zeroRow = within(onHand.getByRole('row', { name: /^SKU003 / }));
    expect(zeroRow.getByRole('cell', { name: '0' })).toBeInTheDocument();
  });

  it('shows a dash when no threshold is configured', async () => {
    mockApi({
      ...b01Reports,
      'GET /reports/stock-on-hand': page([{ ...water, reorderThreshold: null }]),
    });

    renderReports();

    const row = within(await within(stockOnHand()).findByRole('row', { name: /^SKU001 / }));
    expect(row.getByRole('cell', { name: '-' })).toBeInTheDocument();
  });

  it('searches both reports by the same term through the typed routes', async () => {
    const fetchMock = mockApi(b01Reports);

    renderReports();

    await within(lowStock()).findByRole('row', { name: /SKU003/ });
    fireEvent.change(screen.getByLabelText('ค้นหา SKU ชื่อสินค้า หรือสาขา'), {
      target: { value: 'B01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา' }));

    await vi.waitFor(() => {
      for (const path of ['/reports/stock-on-hand', '/reports/low-stock']) {
        expect(requests(fetchMock, path).some((u) => u.searchParams.get('search') === 'B01')).toBe(
          true,
        );
      }
    });
  });

  it('shows an empty state per report when nothing matches', async () => {
    mockApi({ 'GET /reports/stock-on-hand': page([]), 'GET /reports/low-stock': page([]) });

    renderReports();

    expect(await within(stockOnHand()).findByText('ไม่พบสินค้าที่ตรงกับเงื่อนไข')).toBeVisible();
    expect(await within(lowStock()).findByText('ไม่มีสินค้าสต็อกต่ำ')).toBeVisible();
  });

  it('keeps one report usable when the other fails, and tells the user to retry', async () => {
    mockApi({
      'GET /reports/stock-on-hand': page([water]),
      'GET /reports/low-stock': Response.json(
        { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'x' },
        { status: 500 },
      ),
    });

    renderReports();

    // The query client retries a failed request once before giving up.
    expect(await within(lowStock()).findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'ลองใหม่อีกครั้ง',
    );
    expect(within(stockOnHand()).getByRole('row', { name: /SKU001/ })).toBeInTheDocument();
  });

  it('pages through a long report', async () => {
    const fetchMock = mockApi({
      'GET /reports/stock-on-hand': page([water], { total: 25 }),
      'GET /reports/low-stock': page([detergent]),
    });

    renderReports();

    const onHand = within(stockOnHand());
    expect(await onHand.findByText('หน้า 1 จาก 2 (25 รายการ)')).toBeInTheDocument();
    expect(onHand.getByRole('button', { name: 'ก่อนหน้า' })).toBeDisabled();

    fireEvent.click(onHand.getByRole('button', { name: 'ถัดไป' }));

    await vi.waitFor(() => {
      expect(
        requests(fetchMock, '/reports/stock-on-hand').some(
          (u) => u.searchParams.get('page') === '2',
        ),
      ).toBe(true);
    });
    // The low-stock report keeps its own page.
    expect(
      requests(fetchMock, '/reports/low-stock').every((u) => u.searchParams.get('page') !== '2'),
    ).toBe(true);
  });
});

describe('Stock reports navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lets a manager reach the stock reports from the navigation', async () => {
    mockApi({ 'GET /auth/me': { user: manager }, ...b01Reports });

    renderApp('/');

    fireEvent.click(await screen.findByRole('link', { name: 'รายงานสต็อก' }));

    expect(await screen.findByRole('heading', { name: 'รายงานสต็อก' })).toBeInTheDocument();
    expect(await within(lowStock()).findByRole('row', { name: /SKU003/ })).toBeInTheDocument();
  });
});
