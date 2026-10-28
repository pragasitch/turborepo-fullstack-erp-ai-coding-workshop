import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '@/components/require-auth';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { DailySalesReportPage } from './daily-sales-report';
import { HomePage } from './home';
import { RootLayout } from './root-layout';

const manager = {
  id: '4',
  email: 'manager01@erp.local',
  name: 'Manager 01',
  role: 'MANAGER',
  storeId: null,
};

const store = (id: string, code: string, name: string) => ({
  id,
  code,
  name,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const stores = { items: [store('s1', 'B01', 'สาขาเซ็นทรัล')], total: 1, page: 1, pageSize: 20 };

const dayRow = (date: string, documentCount: number, unitsSold: number, totalAmount: string) => ({
  date,
  documentCount,
  unitsSold,
  totalAmount,
});
const report = (items: ReturnType<typeof dayRow>[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});

function renderPage(client = createQueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <DailySalesReportPage />
    </QueryClientProvider>,
  );
}

describe('DailySalesReportPage (RPT-01, AC-08)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows each day with its document count, units and two-decimal total', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /stores': stores,
      'GET /reports/daily-sales': report([
        dayRow('2026-01-03', 2, 5, '300.00'),
        dayRow('2026-01-02', 1, 2, '120.00'),
      ]),
    });
    renderPage();

    const row3 = await screen.findByRole('row', { name: /2026-01-03/ });
    expect(within(row3).getByText('2')).toBeInTheDocument();
    expect(within(row3).getByText('5')).toBeInTheDocument();
    expect(within(row3).getByText('300.00')).toBeInTheDocument();

    const row2 = screen.getByRole('row', { name: /2026-01-02/ });
    expect(within(row2).getByText('120.00')).toBeInTheDocument();
  });

  it('shows a clear empty state and zero totals when no sales match (AC-08)', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /stores': stores,
      'GET /reports/daily-sales': report([]),
    });
    renderPage();

    expect(await screen.findByText('ไม่มีการขายในช่วงวันที่ที่เลือก')).toBeInTheDocument();
    // Zero totals shown somewhere in the summary.
    expect(screen.getByText(/ยอดขายรวม 0.00 บาท/)).toBeInTheDocument();
  });

  it('sends the chosen date range and store to the API', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: manager },
      'GET /stores': stores,
      'GET /reports/daily-sales': report([dayRow('2026-01-02', 1, 2, '120.00')]),
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('ตั้งแต่วันที่'), {
      target: { value: '2026-01-01' },
    });
    fireEvent.change(screen.getByLabelText('ถึงวันที่'), { target: { value: '2026-01-31' } });
    fireEvent.change(screen.getByLabelText('สาขา'), { target: { value: 's1' } });

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([request]) => {
          const url = (request as Request).url;
          return (
            url.includes('from=2026-01-01') &&
            url.includes('to=2026-01-31') &&
            url.includes('storeId=s1')
          );
        }),
      ).toBe(true),
    );
  });

  it('surfaces a retry message when the report fails to load', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /stores': stores,
      'GET /reports/daily-sales': Response.json(
        { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'x' },
        { status: 500 },
      ),
    });
    renderPage();

    // The query client retries a failed request once before giving up.
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'ไม่สามารถโหลดรายงานการขายได้ กรุณาลองใหม่อีกครั้ง',
    );
  });
});

describe('navigation', () => {
  afterEach(() => vi.unstubAllGlobals());

  function renderApp() {
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
                { path: 'reports/daily-sales', element: <DailySalesReportPage /> },
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

  it('links a manager to the daily sales report', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /health': { status: 'ok' },
      'GET /stores': stores,
      'GET /reports/daily-sales': report([]),
    });
    renderApp();

    fireEvent.click(await screen.findByRole('link', { name: 'รายงานการขาย' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'รายงานการขายรายวัน' })).toBeInTheDocument(),
    );
  });

  it('does not offer the daily sales report to a purchasing officer', async () => {
    mockApi({
      'GET /auth/me': { user: { ...manager, role: 'PURCHASING_OFFICER', storeId: null } },
      'GET /health': { status: 'ok' },
    });
    renderApp();

    await screen.findByRole('link', { name: 'สต็อก' });
    expect(screen.queryByRole('link', { name: 'รายงานการขาย' })).not.toBeInTheDocument();
  });
});
