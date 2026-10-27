import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '@/components/require-auth';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { AdjustmentsPage } from './adjustments';
import { HomePage } from './home';
import { RootLayout } from './root-layout';

const auditEntry = {
  id: 'a1',
  actorId: 'mgr1',
  actorName: 'Manager 01',
  action: 'STOCK_ADJUSTMENT',
  sourceDocumentType: 'ADJUSTMENT',
  sourceDocumentId: 'ADJ-000001',
  outcome: 'SUCCESS',
  detail: 'นับสต็อกใหม่',
  createdAt: new Date('2026-01-02T00:00:00.000Z').toISOString(),
};

const manager = {
  id: 'mgr1',
  email: 'manager01@erp.local',
  name: 'Manager 01',
  role: 'MANAGER',
  storeId: null,
};
const staff = {
  id: '2',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STORE_EMPLOYEE',
  storeId: 's1',
};

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
              { path: 'adjustments', element: <AdjustmentsPage /> },
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

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AdjustmentsPage />
    </QueryClientProvider>,
  );
}

/** oRPC JSON error body carrying the shared Thai error envelope in `data`. */
function envelope(code: string, message: string, fields: string[], status = 409) {
  return Response.json(
    { defined: false, code, status, message, data: { code, message, fields } },
    { status },
  );
}

describe('AdjustmentsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the audit trail from the API', async () => {
    mockApi({ 'GET /audit-logs': { items: [auditEntry], total: 1, page: 1, pageSize: 20 } });

    renderPage();

    expect(await screen.findByText('ADJ-000001')).toBeInTheDocument();
    expect(screen.getByText(/นับสต็อกใหม่/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no audit entries', async () => {
    mockApi({ 'GET /audit-logs': { items: [], total: 0, page: 1, pageSize: 20 } });

    renderPage();

    expect(await screen.findByText('ยังไม่มีประวัติการตรวจสอบ')).toBeInTheDocument();
  });

  it('submits an adjustment and reports the new balance', async () => {
    const fetchMock = mockApi({
      'GET /audit-logs': { items: [], total: 0, page: 1, pageSize: 20 },
      'POST /adjustments': {
        documentNumber: 'ADJ-000001',
        productId: 'p1',
        storeId: 's1',
        quantityChange: 5,
        balanceAfter: 15,
        reason: 'นับสต็อกใหม่',
        createdAt: new Date('2026-01-02T00:00:00.000Z').toISOString(),
      },
    });

    renderPage();

    fireEvent.change(await screen.findByLabelText('รหัสสินค้า'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('รหัสสาขา'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('จำนวนที่ปรับ (+ เพิ่ม / - ลด)'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'นับสต็อกใหม่' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการปรับสต็อก' }));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([req]: [Request]) => req.method === 'POST');
      expect(posted, 'a POST request was sent').toBeTruthy();
    });
    expect(await screen.findByRole('status')).toHaveTextContent('ADJ-000001');
  });

  it('surfaces the Thai error envelope when the reduction exceeds the balance', async () => {
    mockApi({
      'GET /audit-logs': { items: [], total: 0, page: 1, pageSize: 20 },
      'POST /adjustments': envelope('CONFLICT', 'สต็อกไม่เพียงพอ', ['quantity']),
    });

    renderPage();

    fireEvent.change(await screen.findByLabelText('รหัสสินค้า'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('รหัสสาขา'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('จำนวนที่ปรับ (+ เพิ่ม / - ลด)'), {
      target: { value: '-99' },
    });
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'ทดสอบ' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการปรับสต็อก' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('สต็อกไม่เพียงพอ');
  });
});

describe('Adjustments navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lets a Manager reach the adjustments screen from the navigation', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /audit-logs': { items: [auditEntry], total: 1, page: 1, pageSize: 20 },
    });

    renderApp('/');

    fireEvent.click(await screen.findByRole('link', { name: 'ปรับสต็อก' }));

    expect(await screen.findByRole('heading', { name: 'ปรับสต็อก' })).toBeInTheDocument();
    expect(await screen.findByText('ADJ-000001')).toBeInTheDocument();
  });

  it('hides the adjustments link from a non-Manager', async () => {
    mockApi({ 'GET /auth/me': { user: staff } });

    renderApp('/');

    expect(await screen.findByText('Welcome 👋')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'ปรับสต็อก' })).not.toBeInTheDocument();
  });
});
