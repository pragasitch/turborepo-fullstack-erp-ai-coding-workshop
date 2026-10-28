import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '@/components/require-auth';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { HomePage } from './home';
import { PurchaseOrdersPage } from './purchase-orders';
import { RootLayout } from './root-layout';

const officer = {
  id: 'u1',
  email: 'buyer@erp.local',
  name: 'Buyer',
  role: 'PURCHASING_OFFICER',
  storeId: null,
};
const admin = { ...officer, id: 'u2', role: 'ADMINISTRATOR' };
const manager = {
  ...officer,
  id: 'u3',
  email: 'manager@erp.local',
  name: 'Manager',
  role: 'MANAGER',
};

const suppliers = {
  items: [
    {
      id: 'sup1',
      code: 'SUP01',
      name: 'ผู้ขายกลาง',
      contactPerson: null,
      phone: null,
      email: null,
      address: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};
const stores = {
  items: [
    {
      id: 'b01',
      code: 'B01',
      name: 'สาขาเซ็นทรัล',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};
const product = (id: string, sku: string, name: string) => ({
  id,
  sku,
  name,
  category: 'เครื่องดื่ม',
  unit: 'แพ็ค',
  sellingPrice: '60.00',
  isActive: true,
  reorderThresholds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const products = {
  items: [product('p1', 'SKU001', 'น้ำดื่มแพ็ค 6'), product('p2', 'SKU002', 'กระดาษทิชชู่')],
  total: 2,
  page: 1,
  pageSize: 100,
};

const line = (
  id: string,
  productId: string,
  sku: string,
  name: string,
  quantity: number,
  unitPrice: string,
  lineTotal: string,
) => ({
  id,
  productId,
  sku,
  productName: name,
  unit: 'แพ็ค',
  quantity,
  unitPrice,
  lineTotal,
});

const po = (overrides: Record<string, unknown> = {}) => ({
  id: 'po1',
  documentNumber: null,
  status: 'DRAFT',
  supplierId: 'sup1',
  supplierCode: 'SUP01',
  storeId: 'b01',
  storeCode: 'B01',
  createdById: 'u1',
  expectedReceiptDate: '2026-02-01',
  total: '20.00',
  createdAt: '2026-01-02T00:00:00.000Z',
  lines: [line('l1', 'p1', 'SKU001', 'น้ำดื่มแพ็ค 6', 2, '10.00', '20.00')],
  ...overrides,
});
const pageOf = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

function renderPage(client = createQueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <PurchaseOrdersPage />
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

function pickHeader(date = '2026-02-01') {
  fireEvent.change(screen.getByLabelText('ผู้ขาย'), { target: { value: 'sup1' } });
  fireEvent.change(screen.getByLabelText('สาขาปลายทาง'), { target: { value: 'b01' } });
  fireEvent.change(screen.getByLabelText('วันที่คาดว่าจะได้รับ'), { target: { value: date } });
}

async function addLine(sku: RegExp, quantity: string, unitPrice: string) {
  fireEvent.change(await screen.findByLabelText('สินค้า'), {
    target: { value: (await screen.findByRole('option', { name: sku })).getAttribute('value') },
  });
  fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: quantity } });
  fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย'), { target: { value: unitPrice } });
  fireEvent.click(screen.getByRole('button', { name: 'เพิ่มรายการ' }));
}

describe('PurchaseOrdersPage (PO-01)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a draft with a supplier, destination store, expected date and a line', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: officer },
      'GET /suppliers': suppliers,
      'GET /stores': stores,
      'GET /products': products,
      'GET /purchase-orders': pageOf([]),
      'POST /purchase-orders': po(),
    });
    renderPage();

    await screen.findByLabelText('ผู้ขาย');
    pickHeader();
    await addLine(/SKU001/, '2', '10.00');
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }));

    expect(await screen.findByText('ยอดรวมทั้งหมด 20.00 บาท')).toBeInTheDocument();
    const create = fetch.mock.calls
      .map(([request]) => request as Request)
      .find((request) => request.method === 'POST')!;
    expect(await create.clone().json()).toEqual({
      supplierId: 'sup1',
      storeId: 'b01',
      expectedReceiptDate: '2026-02-01',
      lines: [{ productId: 'p1', quantity: 2, unitPrice: '10.00' }],
    });
  });

  it('does not let a line be added with a non-positive, fractional or missing price', async () => {
    mockApi({
      'GET /auth/me': { user: officer },
      'GET /suppliers': suppliers,
      'GET /stores': stores,
      'GET /products': products,
      'GET /purchase-orders': pageOf([]),
    });
    renderPage();

    const option = await screen.findByRole('option', { name: /SKU001/ });
    fireEvent.change(screen.getByLabelText('สินค้า'), {
      target: { value: option.getAttribute('value') },
    });
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย'), { target: { value: '10.00' } });

    for (const badQty of ['0', '-1', '1.5', 'abc']) {
      fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: badQty } });
      expect(screen.getByRole('button', { name: 'เพิ่มรายการ' })).toBeDisabled();
    }
    fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: '2' } });
    for (const badPrice of ['', '-1.00', 'free']) {
      fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย'), { target: { value: badPrice } });
      expect(screen.getByRole('button', { name: 'เพิ่มรายการ' })).toBeDisabled();
    }
  });

  it('cannot save until a supplier, store, date and at least one line are present', async () => {
    mockApi({
      'GET /auth/me': { user: officer },
      'GET /suppliers': suppliers,
      'GET /stores': stores,
      'GET /products': products,
      'GET /purchase-orders': pageOf([]),
    });
    renderPage();

    await screen.findByLabelText('ผู้ขาย');
    // No line yet: save disabled.
    expect(screen.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' })).toBeDisabled();
    pickHeader();
    await addLine(/SKU001/, '2', '10.00');
    expect(screen.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' })).toBeEnabled();
  });

  it('surfaces the Thai error when the API rejects a duplicate SKU', async () => {
    mockApi({
      'GET /auth/me': { user: officer },
      'GET /suppliers': suppliers,
      'GET /stores': stores,
      'GET /products': products,
      'GET /purchase-orders': pageOf([]),
      'POST /purchase-orders': envelope({
        code: 'DUPLICATE_SKU',
        message: 'สินค้าแต่ละรายการต้องไม่ซ้ำกัน',
      }),
    });
    renderPage();

    await screen.findByLabelText('ผู้ขาย');
    pickHeader();
    await addLine(/SKU001/, '2', '10.00');
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('สินค้าแต่ละรายการต้องไม่ซ้ำกัน');
  });

  it('edits a saved draft and sends the new header and lines', async () => {
    const fetch = mockApi({
      'GET /auth/me': { user: officer },
      'GET /suppliers': suppliers,
      'GET /stores': stores,
      'GET /products': products,
      'GET /purchase-orders': pageOf([]),
      'POST /purchase-orders': po(),
      'PUT /purchase-orders/po1': po({
        expectedReceiptDate: '2026-03-01',
        total: '36.00',
        lines: [line('l1', 'p1', 'SKU001', 'น้ำดื่มแพ็ค 6', 3, '12.00', '36.00')],
      }),
    });
    renderPage();

    await screen.findByLabelText('ผู้ขาย');
    pickHeader();
    await addLine(/SKU001/, '2', '10.00');
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }));

    fireEvent.click(await screen.findByRole('button', { name: 'แก้ไขใบสั่งซื้อ' }));
    fireEvent.change(await screen.findByLabelText('วันที่คาดว่าจะได้รับ'), {
      target: { value: '2026-03-01' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'ลบ SKU001' }));
    await addLine(/SKU001/, '3', '12.00');
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการแก้ไขใบสั่งซื้อ' }));

    expect(await screen.findByText('ยอดรวมทั้งหมด 36.00 บาท')).toBeInTheDocument();
    const put = fetch.mock.calls.map(([r]) => r as Request).find((r) => r.method === 'PUT')!;
    expect(await put.clone().json()).toEqual({
      supplierId: 'sup1',
      storeId: 'b01',
      expectedReceiptDate: '2026-03-01',
      lines: [{ productId: 'p1', quantity: 3, unitPrice: '12.00' }],
    });
  });

  it('lists existing purchase orders newest first', async () => {
    mockApi({
      'GET /auth/me': { user: officer },
      'GET /suppliers': suppliers,
      'GET /stores': stores,
      'GET /products': products,
      'GET /purchase-orders': pageOf([po()]),
    });
    renderPage();

    const item = await screen.findByRole('listitem');
    expect(item).toHaveTextContent('SUP01');
    expect(item).toHaveTextContent('B01');
    expect(item).toHaveTextContent('20.00 บาท');
  });
});

const requestsTo = (fetch: ReturnType<typeof mockApi>, method: string, path: string) =>
  fetch.mock.calls
    .map(([request]) => request as Request)
    .filter(
      (request) => request.method === method && new URL(request.url).pathname === `/api${path}`,
    );

const listApi = (user: unknown, orders: unknown[], extra: Record<string, unknown> = {}) => ({
  'GET /auth/me': { user },
  'GET /suppliers': suppliers,
  'GET /stores': stores,
  'GET /products': products,
  'GET /purchase-orders': pageOf(orders),
  ...extra,
});

describe('PurchaseOrdersPage approval workflow (PO-02, PO-03, PO-04)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows each order with its Thai status', async () => {
    mockApi(
      listApi(manager, [
        po({ id: 'a', status: 'DRAFT' }),
        po({ id: 'b', status: 'PENDING_APPROVAL' }),
        po({ id: 'c', status: 'APPROVED' }),
        po({ id: 'd', status: 'REJECTED', decisionReason: 'ราคาสูงเกินไป' }),
        po({ id: 'e', status: 'CANCELLED', decisionReason: 'สั่งผิด' }),
      ]),
    );
    renderPage();

    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('ฉบับร่าง');
    expect(rows[1]).toHaveTextContent('รออนุมัติ');
    expect(rows[2]).toHaveTextContent('อนุมัติแล้ว');
    expect(rows[3]).toHaveTextContent('ไม่อนุมัติ');
    expect(rows[3]).toHaveTextContent('เหตุผล: ราคาสูงเกินไป');
    expect(rows[4]).toHaveTextContent('ยกเลิกแล้ว');
  });

  it('lets the purchasing officer submit a draft for approval', async () => {
    const fetch = mockApi(
      listApi(officer, [po()], {
        'POST /purchase-orders/po1/submit': po({ status: 'PENDING_APPROVAL' }),
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'ส่งขออนุมัติ' }));

    await waitFor(() =>
      expect(requestsTo(fetch, 'POST', '/purchase-orders/po1/submit')).toHaveLength(1),
    );
    // The list is read again so the new status shows.
    await waitFor(() =>
      expect(requestsTo(fetch, 'GET', '/purchase-orders').length).toBeGreaterThan(1),
    );
  });

  it('lets a manager approve a pending order, but only with a reason', async () => {
    const fetch = mockApi(
      listApi(manager, [po({ status: 'PENDING_APPROVAL' })], {
        'POST /purchase-orders/po1/approve': po({ status: 'APPROVED' }),
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'อนุมัติใบสั่งซื้อ' }));
    const confirm = screen.getByRole('button', { name: 'ยืนยันการอนุมัติ' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'ราคาเหมาะสม' } });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(requestsTo(fetch, 'POST', '/purchase-orders/po1/approve')).toHaveLength(1),
    );
    expect(
      await requestsTo(fetch, 'POST', '/purchase-orders/po1/approve')[0]!.clone().json(),
    ).toMatchObject({ reason: 'ราคาเหมาะสม' });
    await waitFor(() => expect(screen.queryByLabelText('เหตุผล')).not.toBeInTheDocument());
  });

  it('lets a manager reject a pending order with a reason', async () => {
    const fetch = mockApi(
      listApi(manager, [po({ status: 'PENDING_APPROVAL' })], {
        'POST /purchase-orders/po1/reject': po({ status: 'REJECTED' }),
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'ปฏิเสธใบสั่งซื้อ' }));
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'ราคาสูงเกินไป' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันการปฏิเสธ' }));

    await waitFor(() =>
      expect(requestsTo(fetch, 'POST', '/purchase-orders/po1/reject')).toHaveLength(1),
    );
    expect(
      await requestsTo(fetch, 'POST', '/purchase-orders/po1/reject')[0]!.clone().json(),
    ).toMatchObject({ reason: 'ราคาสูงเกินไป' });
  });

  it('shows the Thai error when the API refuses an illegal transition', async () => {
    mockApi(
      listApi(manager, [po({ status: 'PENDING_APPROVAL' })], {
        'POST /purchase-orders/po1/approve': envelope({
          code: 'PURCHASE_ORDER_INVALID_TRANSITION',
          message: 'ไม่สามารถดำเนินการนี้กับใบสั่งซื้อในสถานะปัจจุบันได้',
        }),
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'อนุมัติใบสั่งซื้อ' }));
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันการอนุมัติ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ไม่สามารถดำเนินการนี้กับใบสั่งซื้อในสถานะปัจจุบันได้',
    );
  });

  it('offers a manager no decision on an order that is not pending', async () => {
    mockApi(
      listApi(manager, [
        po({ id: 'a', status: 'DRAFT' }),
        po({ id: 'b', status: 'APPROVED' }),
        po({ id: 'c', status: 'REJECTED' }),
      ]),
    );
    renderPage();

    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('button', { name: 'อนุมัติใบสั่งซื้อ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ปฏิเสธใบสั่งซื้อ' })).not.toBeInTheDocument();
    // An Approved or Rejected order cannot be cancelled either; a Draft can.
    expect(screen.getAllByRole('button', { name: 'ยกเลิกใบสั่งซื้อ' })).toHaveLength(1);
  });

  it('offers an officer submit only on a draft, and no approval at all', async () => {
    mockApi(
      listApi(officer, [
        po({ id: 'a', status: 'DRAFT' }),
        po({ id: 'b', status: 'PENDING_APPROVAL' }),
        po({ id: 'c', status: 'APPROVED' }),
      ]),
    );
    renderPage();

    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[0]!).getByRole('button', { name: 'ส่งขออนุมัติ' })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole('button', { name: 'ส่งขออนุมัติ' })).toBeNull();
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'อนุมัติใบสั่งซื้อ' })).not.toBeInTheDocument();
  });

  it('lets an officer cancel only the orders they created, with a reason', async () => {
    const fetch = mockApi(
      listApi(
        officer,
        [po({ id: 'mine', createdById: 'u1' }), po({ id: 'theirs', createdById: 'someone-else' })],
        { 'POST /purchase-orders/mine/cancel': po({ id: 'mine', status: 'CANCELLED' }) },
      ),
    );
    renderPage();

    const cancelButtons = await screen.findAllByRole('button', { name: 'ยกเลิกใบสั่งซื้อ' });
    expect(cancelButtons).toHaveLength(1);
    fireEvent.click(cancelButtons[0]!);
    expect(screen.getByRole('button', { name: 'ยืนยันการยกเลิก' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'สั่งผิดผู้ขาย' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันการยกเลิก' }));

    await waitFor(() =>
      expect(requestsTo(fetch, 'POST', '/purchase-orders/mine/cancel')).toHaveLength(1),
    );
    expect(
      await requestsTo(fetch, 'POST', '/purchase-orders/mine/cancel')[0]!.clone().json(),
    ).toMatchObject({ reason: 'สั่งผิดผู้ขาย' });
  });

  it('takes the edit button away once the saved draft has been submitted', async () => {
    const fetch = mockApi({
      ...listApi(officer, [po()]),
      'POST /purchase-orders': po(),
      'POST /purchase-orders/po1/submit': po({ status: 'PENDING_APPROVAL' }),
    });
    renderPage();

    await screen.findByLabelText('ผู้ขาย');
    pickHeader();
    await addLine(/SKU001/, '2', '10.00');
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }));
    expect(await screen.findByRole('button', { name: 'แก้ไขใบสั่งซื้อ' })).toBeInTheDocument();

    // From now on the list reports the order as pending approval.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname.replace(/^\/api/, '');
        if (request.method === 'GET' && path === '/purchase-orders') {
          return Response.json(pageOf([po({ status: 'PENDING_APPROVAL' })]));
        }
        return fetch(request);
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'ส่งขออนุมัติ' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'แก้ไขใบสั่งซื้อ' })).not.toBeInTheDocument(),
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
                { path: 'purchase-orders', element: <PurchaseOrdersPage /> },
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

  it('links a purchasing officer to the purchase orders page', async () => {
    mockApi({
      'GET /auth/me': { user: officer },
      'GET /health': { status: 'ok' },
      'GET /suppliers': suppliers,
      'GET /stores': stores,
      'GET /products': products,
      'GET /purchase-orders': pageOf([]),
    });
    renderApp();

    fireEvent.click(await screen.findByRole('link', { name: 'ใบสั่งซื้อ' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'ใบสั่งซื้อ' })).toBeInTheDocument(),
    );
  });

  it('links a manager to the purchase orders page, with no order form', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /health': { status: 'ok' },
      'GET /purchase-orders': pageOf([po({ status: 'PENDING_APPROVAL' })]),
    });
    renderApp();

    fireEvent.click(await screen.findByRole('link', { name: 'ใบสั่งซื้อ' }));

    expect(await screen.findByRole('button', { name: 'อนุมัติใบสั่งซื้อ' })).toBeInTheDocument();
    expect(screen.queryByLabelText('ผู้ขาย')).not.toBeInTheDocument();
  });

  it('does not offer the purchase orders page to an administrator', async () => {
    mockApi({ 'GET /auth/me': { user: admin }, 'GET /health': { status: 'ok' } });
    renderApp();

    await screen.findByRole('link', { name: 'สต็อก' });
    expect(screen.queryByRole('link', { name: 'ใบสั่งซื้อ' })).not.toBeInTheDocument();
  });
});
