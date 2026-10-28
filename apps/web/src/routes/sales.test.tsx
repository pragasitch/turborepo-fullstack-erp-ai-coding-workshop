import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '@/components/require-auth';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { HomePage } from './home';
import { RootLayout } from './root-layout';
import { SalesPage } from './sales';

const staff = {
  id: 'u1',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STORE_EMPLOYEE',
  storeId: 's1',
};
const manager = { ...staff, id: 'u2', role: 'MANAGER', storeId: null };

const stockRow = (productId: string, sku: string, productName: string, quantity: number) => ({
  productId,
  sku,
  productName,
  unit: 'แพ็ค',
  storeId: 's1',
  storeCode: 'B01',
  storeName: 'สาขาเซ็นทรัล',
  quantity,
  reorderThreshold: 3,
  isLowStock: false,
});
const stock = {
  items: [
    stockRow('p1', 'SKU001', 'น้ำดื่มแพ็ค 6', 10),
    stockRow('p2', 'SKU002', 'กระดาษทิชชู่', 5),
  ],
  total: 2,
  page: 1,
  pageSize: 100,
};

const line = (
  id: string,
  productId: string,
  sku: string,
  productName: string,
  quantity: number,
  unitPrice: string,
  lineTotal: string,
  balanceAfter: number | null,
) => ({ id, productId, sku, productName, unit: 'แพ็ค', quantity, unitPrice, lineTotal, balanceAfter });

const draftLines = [
  line('l1', 'p1', 'SKU001', 'น้ำดื่มแพ็ค 6', 2, '60.00', '120.00', null),
  line('l2', 'p2', 'SKU002', 'กระดาษทิชชู่', 1, '35.00', '35.00', null),
];
const sale = (overrides: Record<string, unknown> = {}) => ({
  id: 'sale1',
  documentNumber: null,
  status: 'DRAFT',
  storeId: 's1',
  storeCode: 'B01',
  createdById: 'u1',
  total: '155.00',
  confirmedAt: null,
  createdAt: '2026-01-02T00:00:00.000Z',
  lines: draftLines,
  ...overrides,
});
const confirmed = sale({
  status: 'CONFIRMED',
  documentNumber: 'SAL-000001',
  confirmedAt: '2026-01-02T01:00:00.000Z',
  lines: [
    line('l1', 'p1', 'SKU001', 'น้ำดื่มแพ็ค 6', 2, '60.00', '120.00', 8),
    line('l2', 'p2', 'SKU002', 'กระดาษทิชชู่', 1, '35.00', '35.00', 4),
  ],
});
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

function renderSales(client = createQueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <SalesPage />
    </QueryClientProvider>,
  );
}

/** oRPC JSON error body carrying the shared Thai error envelope in `data`. */
function envelope(data: Record<string, unknown>, status = 409) {
  return Response.json(
    { defined: false, code: 'CONFLICT', status, message: 'Conflict', data },
    { status },
  );
}

async function addLine(sku: RegExp, quantity: string) {
  fireEvent.change(await screen.findByLabelText('สินค้า'), {
    target: { value: (await screen.findByRole('option', { name: sku })).getAttribute('value') },
  });
  fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: quantity } });
  fireEvent.click(screen.getByRole('button', { name: 'เพิ่มรายการ' }));
}

async function buildDraft() {
  await addLine(/SKU001/, '2');
  await addLine(/SKU002/, '1');
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกใบขาย' }));
}

describe('SalesPage (SAL-01..SAL-04)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('saves a draft at system prices and shows the total, sending no price', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: staff },
      'GET /inventory': stock,
      'GET /sales': page([]),
      'POST /sales': sale(),
    });
    renderSales();

    await buildDraft();

    expect(await screen.findByText('ยอดรวมทั้งหมด 155.00 บาท')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ยืนยันการขาย' })).toBeInTheDocument();
    const create = fetch.mock.calls
      .map(([request]) => request as Request)
      .find((request) => request.method === 'POST')!;
    expect(await create.clone().json()).toEqual({
      lines: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
      ],
    });
  });

  it('confirms with an Idempotency-Key and shows the number, total and reduced balances', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: staff },
      'GET /inventory': stock,
      'GET /sales': page([]),
      'POST /sales': sale(),
      'POST /sales/sale1/confirm': confirmed,
    });
    renderSales();
    await buildDraft();

    fireEvent.click(await screen.findByRole('button', { name: 'ยืนยันการขาย' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'ยืนยันแล้ว SAL-000001 ยอดรวม 155.00 บาท',
    );
    const rows = screen.getAllByRole('row');
    expect(within(rows.find((r) => r.textContent?.includes('SKU001'))!).getAllByRole('cell')[4]).toHaveTextContent('8');
    expect(within(rows.find((r) => r.textContent?.includes('SKU002'))!).getAllByRole('cell')[4]).toHaveTextContent('4');
    expect(screen.queryByRole('button', { name: 'ยืนยันการขาย' })).not.toBeInTheDocument();

    const confirmRequest = fetch.mock.calls
      .map(([request]) => request as Request)
      .find((request) => request.url.endsWith('/confirm'))!;
    expect(confirmRequest.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('retries a failed confirm with the same Idempotency-Key', async () => {
    let attempts = 0;
    const fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname.replace(/^\/api/, '');
      const key = `${request.method} ${path}`;
      if (key === 'GET /auth/me') return Response.json({ user: staff });
      if (key === 'GET /inventory') return Response.json(stock);
      if (key === 'GET /sales') return Response.json(page([]));
      if (key === 'POST /sales') return Response.json(sale());
      if (key === 'POST /sales/sale1/confirm') {
        attempts += 1;
        return attempts === 1
          ? Response.json({ defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'x' }, { status: 500 })
          : Response.json(confirmed);
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    renderSales();
    await buildDraft();

    fireEvent.click(await screen.findByRole('button', { name: 'ยืนยันการขาย' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันการขาย' }));
    await screen.findByRole('status');

    const keys = fetch.mock.calls
      .map(([request]) => request as Request)
      .filter((request) => request.url.endsWith('/confirm'))
      .map((request) => request.headers.get('idempotency-key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('shows the Thai rejection and names the short product when stock is insufficient (SAL-02)', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /inventory': stock,
      'GET /sales': page([]),
      'POST /sales': sale({ total: '660.00', lines: [draftLines[0]] }),
      'POST /sales/sale1/confirm': envelope({
        code: 'INSUFFICIENT_STOCK',
        message: 'สต็อกไม่เพียงพอสำหรับสินค้าบางรายการ',
        fields: ['lines'],
        products: [
          { productId: 'p1', sku: 'SKU001', productName: 'น้ำดื่มแพ็ค 6', requested: 11, available: 10 },
        ],
      }),
    });
    renderSales();
    await addLine(/SKU001/, '11');
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกใบขาย' }));

    fireEvent.click(await screen.findByRole('button', { name: 'ยืนยันการขาย' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('สต็อกไม่เพียงพอสำหรับสินค้าบางรายการ');
    expect(alert).toHaveTextContent('SKU001 น้ำดื่มแพ็ค 6: ต้องการ 11 คงเหลือ 10');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('lets the employee edit a rejected draft and save the new lines', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: staff },
      'GET /inventory': stock,
      'GET /sales': page([]),
      'POST /sales': sale(),
      'PUT /sales/sale1': sale({ total: '60.00', lines: [draftLines[0]] }),
    });
    renderSales();
    await buildDraft();

    fireEvent.click(await screen.findByRole('button', { name: 'แก้ไขรายการ' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ลบ SKU002' }));
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการแก้ไขใบขาย' }));

    expect(await screen.findByText('ยอดรวมทั้งหมด 60.00 บาท')).toBeInTheDocument();
    const put = fetch.mock.calls.map(([r]) => r as Request).find((r) => r.method === 'PUT')!;
    expect(await put.clone().json()).toEqual({ lines: [{ productId: 'p1', quantity: 2 }] });
  });

  it('does not add a zero or fractional quantity', async () => {
    mockApi({ 'GET /auth/me': { user: staff }, 'GET /inventory': stock, 'GET /sales': page([]) });
    renderSales();
    const option = await screen.findByRole('option', { name: /SKU001/ });
    fireEvent.change(screen.getByLabelText('สินค้า'), {
      target: { value: option.getAttribute('value') },
    });

    for (const bad of ['0', '-1', '1.5', 'abc']) {
      fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: bad } });
      expect(screen.getByRole('button', { name: 'เพิ่มรายการ' })).toBeDisabled();
    }
  });

  it('searches the product picker on the server, so stores with many products can sell any of them', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: staff },
      'GET /inventory': stock,
      'GET /sales': page([]),
    });
    renderSales();

    fireEvent.change(await screen.findByLabelText('ค้นหาสินค้า'), { target: { value: 'SKU002' } });

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([request]) => (request as Request).url.includes('search=SKU002')),
      ).toBe(true),
    );
  });

  it('lists confirmed sales (viewable, with no edit, cancel or return controls)', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /inventory': stock,
      'GET /sales': page([confirmed]),
    });
    renderSales();

    const item = await screen.findByRole('listitem');
    expect(item).toHaveTextContent('SAL-000001');
    expect(item).toHaveTextContent('155.00 บาท');
    expect(item).toHaveTextContent('ยืนยันแล้ว');
    expect(screen.queryByRole('button', { name: /แก้ไข|ยกเลิก|คืน/ })).not.toBeInTheDocument();
  });

  it('shows a manager the sales but not the sale form', async () => {
    mockApi({ 'GET /auth/me': { user: manager }, 'GET /sales': page([confirmed]) });
    renderSales();

    expect(await screen.findByText('SAL-000001')).toBeInTheDocument();
    expect(screen.queryByLabelText('สินค้า')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no sales', async () => {
    mockApi({ 'GET /auth/me': { user: manager }, 'GET /sales': page([]) });
    renderSales();

    expect(await screen.findByText('ยังไม่มีใบขาย')).toBeInTheDocument();
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
                { path: 'sales', element: <SalesPage /> },
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

  it('links store employees to the sales page', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /health': { status: 'ok' },
      'GET /sales': page([]),
      'GET /inventory': stock,
    });
    renderApp();

    fireEvent.click(await screen.findByRole('link', { name: 'ขายสินค้า' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'ขายสินค้า' })).toBeInTheDocument(),
    );
  });

  it('does not offer the sales page to a purchasing officer', async () => {
    mockApi({
      'GET /auth/me': { user: { ...staff, role: 'PURCHASING_OFFICER', storeId: null } },
      'GET /health': { status: 'ok' },
    });
    renderApp();

    await screen.findByRole('link', { name: 'สต็อก' });
    expect(screen.queryByRole('link', { name: 'ขายสินค้า' })).not.toBeInTheDocument();
  });
});
