import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '@/components/require-auth';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { HomePage } from './home';
import { MovementHistoryPage } from './movement-history';
import { RootLayout } from './root-layout';

const manager = {
  id: '4',
  email: 'manager01@erp.local',
  name: 'Manager 01',
  role: 'MANAGER',
  storeId: null,
};

const staffB01 = {
  id: '2',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STORE_EMPLOYEE',
  storeId: 's1',
};

const store = (id: string, code: string, name: string) => ({
  id,
  code,
  name,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const stores = {
  items: [store('s1', 'B01', 'สาขาเซ็นทรัล'), store('s2', 'B02', 'สาขาริเวอร์ไซด์')],
  total: 2,
  page: 1,
  pageSize: 20,
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1',
  productId: 'p1',
  sku: 'SKU001',
  productName: 'น้ำดื่มแพ็ค 6',
  unit: 'แพ็ค',
  storeId: 's1',
  storeCode: 'B01',
  storeName: 'สาขาเซ็นทรัล',
  type: 'SALE',
  quantityChange: -2,
  balanceBefore: 10,
  balanceAfter: 8,
  sourceDocumentType: 'SALE',
  sourceDocumentId: 'SAL-000001',
  actorId: 'u1',
  actorName: 'Staff B01',
  createdAt: '2026-01-02T03:04:05.000Z',
  ...overrides,
});
const report = (items: ReturnType<typeof row>[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MovementHistoryPage />
    </QueryClientProvider>,
  );
}

describe('MovementHistoryPage (RPT-03)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows each movement with its store, type, quantity change and source document', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /stores': stores,
      'GET /products': { items: [], total: 0, page: 1, pageSize: 20 },
      'GET /reports/movement-history': report([
        row(),
        row({
          id: 'm2',
          type: 'RECEIPT',
          quantityChange: 5,
          sourceDocumentType: 'GOODS_RECEIPT',
          sourceDocumentId: 'GR-000001',
          storeId: 's2',
          storeCode: 'B02',
        }),
      ]),
    });
    renderPage();

    const saleRow = await screen.findByRole('row', { name: /SAL-000001/ });
    expect(within(saleRow).getByText('B01')).toBeInTheDocument();
    expect(within(saleRow).getByText(/-2/)).toBeInTheDocument();

    const receiptRow = screen.getByRole('row', { name: /GR-000001/ });
    expect(within(receiptRow).getByText('B02')).toBeInTheDocument();
  });

  it('shows an empty state when no movement matches', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /stores': stores,
      'GET /products': { items: [], total: 0, page: 1, pageSize: 20 },
      'GET /reports/movement-history': report([]),
    });
    renderPage();

    expect(await screen.findByText('ไม่พบประวัติการเคลื่อนไหวสต็อก')).toBeInTheDocument();
  });

  it('sends the chosen store, type and date range to the API', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: manager },
      'GET /stores': stores,
      'GET /products': { items: [], total: 0, page: 1, pageSize: 20 },
      'GET /reports/movement-history': report([row()]),
    });
    renderPage();

    const storeSelect = await screen.findByLabelText('สาขา');
    // Wait for the stores query so the B02 option exists before selecting it.
    await within(storeSelect).findByRole('option', { name: /B02/ });
    fireEvent.change(storeSelect, { target: { value: 's2' } });
    fireEvent.change(screen.getByLabelText('ประเภท'), { target: { value: 'RECEIPT' } });
    fireEvent.change(screen.getByLabelText('ตั้งแต่วันที่'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('ถึงวันที่'), { target: { value: '2026-01-31' } });

    await waitFor(() => {
      const urls = fetch.mock.calls
        .map(([request]) => (request as Request).url)
        .filter((url) => url.includes('movement-history'));
      const joined = urls.join(' ');
      expect(joined).toContain('storeId=s2');
      expect(joined).toContain('type=RECEIPT');
      expect(joined).toContain('from=2026-01-01');
      expect(joined).toContain('to=2026-01-31');
    });
  });

  it('surfaces a retry message when the report fails to load', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /stores': stores,
      'GET /products': { items: [], total: 0, page: 1, pageSize: 20 },
      'GET /reports/movement-history': Response.json(
        { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'x' },
        { status: 500 },
      ),
    });
    renderPage();

    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'ไม่สามารถโหลดประวัติการเคลื่อนไหวสต็อกได้ กรุณาลองใหม่อีกครั้ง',
    );
  });
});

describe('navigation', () => {
  afterEach(() => vi.unstubAllGlobals());

  function renderApp(user: unknown) {
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
                { path: 'reports/movement-history', element: <MovementHistoryPage /> },
              ],
            },
          ],
        },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it('links any signed-in user to the movement history report', async () => {
    mockApi({
      'GET /auth/me': { user: staffB01 },
      'GET /health': { status: 'ok' },
      'GET /stores': stores,
      'GET /products': { items: [], total: 0, page: 1, pageSize: 20 },
      'GET /reports/movement-history': report([]),
    });
    renderApp(staffB01);

    fireEvent.click(await screen.findByRole('link', { name: 'ประวัติสต็อก' }));

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'ประวัติการเคลื่อนไหวสต็อก' }),
      ).toBeInTheDocument(),
    );
  });
});
