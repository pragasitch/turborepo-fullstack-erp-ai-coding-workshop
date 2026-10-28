import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { mockApi } from '@/test/mock-api';
import { GoodsReceiptsPage } from './goods-receipts';

const staff = {
  id: 'u1',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STORE_EMPLOYEE',
  storeId: 's1',
};
const manager = { ...staff, id: 'u2', role: 'MANAGER', storeId: null };

const orderLine = (overrides: Record<string, unknown> = {}) => ({
  productId: 'p1',
  sku: 'SKU001',
  productName: 'น้ำดื่มแพ็ค 6',
  unit: 'แพ็ค',
  isActive: true,
  ordered: 20,
  received: 0,
  outstanding: 20,
  ...overrides,
});
const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'po1',
  documentNumber: 'PO-DEMO-001',
  status: 'APPROVED',
  supplierCode: 'SUP01',
  storeId: 's1',
  storeCode: 'B01',
  expectedReceiptDate: '2026-02-01',
  lines: [orderLine()],
  ...overrides,
});
const partlyReceived = order({
  status: 'PARTIALLY_RECEIVED',
  lines: [orderLine({ received: 8, outstanding: 12 })],
});

const receipt = (overrides: Record<string, unknown> = {}) => ({
  id: 'gr1',
  documentNumber: 'GR-000001',
  purchaseOrderId: 'po1',
  purchaseOrderNumber: 'PO-DEMO-001',
  orderStatus: 'PARTIALLY_RECEIVED',
  storeId: 's1',
  storeCode: 'B01',
  receivedById: 'u1',
  confirmedAt: '2026-01-02T01:00:00.000Z',
  lines: [
    {
      id: 'gl1',
      productId: 'p1',
      sku: 'SKU001',
      productName: 'น้ำดื่มแพ็ค 6',
      unit: 'แพ็ค',
      quantity: 8,
      balanceAfter: 18,
    },
  ],
  ...overrides,
});
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20 });

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <GoodsReceiptsPage />
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

const receiveInput = () => screen.findByLabelText('รับครั้งนี้ SKU001');
const confirmButton = () => screen.getByRole('button', { name: 'ยืนยันการรับสินค้า' });
const enter = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

/**
 * A fetch stub whose receivable orders change once the receipt is posted, like the real
 * API: the order moves to Partially Received and the outstanding quantity drops.
 */
function statefulApi(confirm: (request: Request, attempt: number) => Response | Promise<Response>) {
  let posted = false;
  let attempt = 0;
  const fetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname.replace(/^\/api/, '');
    const key = `${request.method} ${path}`;
    if (key === 'GET /auth/me') return Response.json({ user: staff });
    if (key === 'GET /goods-receipts/receivable-orders') {
      return Response.json(page([posted ? partlyReceived : order()]));
    }
    if (key === 'GET /goods-receipts') return Response.json(page(posted ? [receipt()] : []));
    if (key === 'POST /goods-receipts') {
      attempt += 1;
      const response = await confirm(request, attempt);
      if (response.ok) posted = true;
      return response;
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const postsOf = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.map(([request]) => request as Request).filter((r) => r.method === 'POST');

describe('GoodsReceiptsPage (GR-01..GR-05)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GR-01: shows ordered, previously received and outstanding quantities per line', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /goods-receipts/receivable-orders': page([partlyReceived]),
      'GET /goods-receipts': page([]),
    });
    renderPage();

    const row = (await screen.findByText(/SKU001 น้ำดื่มแพ็ค 6/)).closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('20');
    expect(cells[2]).toHaveTextContent('8');
    expect(cells[3]).toHaveTextContent('12');
    expect(screen.getByRole('heading', { name: /PO-DEMO-001/ })).toBeInTheDocument();
    expect(screen.getByText(/ผู้ขาย SUP01/)).toBeInTheDocument();
    expect(screen.getByText('รับบางส่วน')).toBeInTheDocument();
  });

  it('confirms with an Idempotency-Key, sends only the delivered lines, then shows the new outstanding and status', async () => {
    const fetch = statefulApi(() => Response.json(receipt()));
    renderPage();

    enter(await receiveInput(), '8');
    fireEvent.click(confirmButton());

    expect(await screen.findByRole('status')).toHaveTextContent('ยืนยันแล้ว GR-000001');
    const [post] = postsOf(fetch);
    expect(post!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await post!.clone().json()).toEqual({
      purchaseOrderId: 'po1',
      lines: [{ productId: 'p1', quantity: 8 }],
    });

    const order = await screen.findByRole('region', { name: 'PO-DEMO-001' });
    await vi.waitFor(() => expect(within(order).getAllByRole('cell')[3]).toHaveTextContent('12'));
    expect(within(order).getByText('รับบางส่วน')).toBeInTheDocument();
    // The confirmed receipt is listed and viewable, with nothing to edit or cancel.
    const item = await screen.findByRole('listitem');
    expect(item).toHaveTextContent('GR-000001');
    expect(item).toHaveTextContent('SKU001 × 8');
    expect(screen.queryByRole('button', { name: /แก้ไข|ยกเลิก/ })).not.toBeInTheDocument();
  });

  it('GR-04: retries a failed confirm with the same key, and uses a fresh key once the quantity changes', async () => {
    const fetch = statefulApi((_request, attempt) =>
      attempt === 1
        ? Response.json(
            { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'x' },
            { status: 500 },
          )
        : attempt === 2
          ? envelope({ code: 'RECEIPT_EXCEEDS_ORDERED', message: 'เกิน' })
          : Response.json(receipt()),
    );
    renderPage();

    const input = await receiveInput();
    enter(input, '8');
    fireEvent.click(confirmButton());
    await screen.findByRole('alert');
    fireEvent.click(confirmButton());
    await vi.waitFor(() => expect(postsOf(fetch)).toHaveLength(2));
    enter(input, '7');
    fireEvent.click(confirmButton());
    await screen.findByRole('status');

    const keys = postsOf(fetch).map((r) => r.headers.get('idempotency-key'));
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('GR-02: shows the Thai rejection and the product when an over-receipt is refused', async () => {
    statefulApi(() =>
      envelope({
        code: 'RECEIPT_EXCEEDS_ORDERED',
        message: 'จำนวนที่รับเกินจำนวนที่สั่งซื้อ',
        fields: ['lines'],
        products: [
          {
            productId: 'p1',
            sku: 'SKU001',
            productName: 'น้ำดื่มแพ็ค 6',
            requested: 21,
            available: 20,
          },
        ],
      }),
    );
    renderPage();

    enter(await receiveInput(), '21');
    fireEvent.click(confirmButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('จำนวนที่รับเกินจำนวนที่สั่งซื้อ');
    expect(alert).toHaveTextContent('SKU001 น้ำดื่มแพ็ค 6: รับได้อีกไม่เกิน 20 แต่ต้องการรับ 21');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('only allows a confirm with a non-negative whole number and at least one line above zero', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /goods-receipts/receivable-orders': page([order()]),
      'GET /goods-receipts': page([]),
    });
    renderPage();
    const input = await receiveInput();

    expect(confirmButton()).toBeDisabled();
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      enter(input, bad);
      expect(confirmButton()).toBeDisabled();
    }
    enter(input, '3');
    expect(confirmButton()).toBeEnabled();
  });

  it('Q-02: a product deactivated after approval cannot be received', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /goods-receipts/receivable-orders': page([
        order({ lines: [orderLine({ isActive: false })] }),
      ]),
      'GET /goods-receipts': page([]),
    });
    renderPage();

    expect(await receiveInput()).toBeDisabled();
    expect(screen.getByText('สินค้าถูกปิดการใช้งาน รับไม่ได้')).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it('shows a manager the orders and receipts but nothing to receive with', async () => {
    mockApi({
      'GET /auth/me': { user: manager },
      'GET /goods-receipts/receivable-orders': page([partlyReceived]),
      'GET /goods-receipts': page([receipt()]),
    });
    renderPage();

    expect(await screen.findByText(/SKU001 น้ำดื่มแพ็ค 6/)).toBeInTheDocument();
    expect(screen.getByText('GR-000001')).toBeInTheDocument();
    expect(screen.queryByLabelText('รับครั้งนี้ SKU001')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ยืนยันการรับสินค้า' })).not.toBeInTheDocument();
  });

  it('shows empty states when nothing is waiting and nothing has been received', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /goods-receipts/receivable-orders': page([]),
      'GET /goods-receipts': page([]),
    });
    renderPage();

    expect(await screen.findByText('ไม่มีใบสั่งซื้อที่รอรับสินค้า')).toBeInTheDocument();
    expect(await screen.findByText('ยังไม่มีใบรับสินค้า')).toBeInTheDocument();
  });

  it('shows a Thai error when the lists cannot be loaded', async () => {
    mockApi({
      'GET /auth/me': { user: staff },
      'GET /goods-receipts/receivable-orders': envelope({ code: 'X', message: 'ขัดข้อง' }, 500),
      'GET /goods-receipts': page([]),
    });
    renderPage();

    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('ขัดข้อง');
  });
});
