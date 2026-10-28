import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { MovementType } from '@erp/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { orpc } from '@/lib/orpc';

/** Rows per page; the contract caps pageSize at 100. */
const PAGE_SIZE = 20;

/** Movement type labels, Thai, mirroring the StockMovementType enum (INV-02). */
const TYPE_LABEL: Record<MovementType, string> = {
  RECEIPT: 'รับสินค้า',
  SALE: 'ขายสินค้า',
  ADJUSTMENT: 'ปรับสต็อก',
};

type Filters = {
  storeId: string;
  productId: string;
  type: '' | MovementType;
  from: string;
  to: string;
};

function HistoryTable({ filters }: { filters: Filters }) {
  const [page, setPage] = useState(1);
  const report = useQuery(
    orpc.reports.movementHistory.queryOptions({
      input: {
        page,
        pageSize: PAGE_SIZE,
        storeId: filters.storeId || undefined,
        productId: filters.productId || undefined,
        type: filters.type || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
      },
    }),
  );

  if (report.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }

  if (!report.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        ไม่สามารถโหลดประวัติการเคลื่อนไหวสต็อกได้ กรุณาลองใหม่อีกครั้ง
      </p>
    );
  }

  const { items, total } = report.data;
  if (total === 0) {
    return <p className="text-muted-foreground">ไม่พบประวัติการเคลื่อนไหวสต็อก</p>;
  }

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="space-y-3">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">ประวัติการเคลื่อนไหวสต็อก</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              วันที่และเวลา
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              สินค้า
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              สาขา
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              ประเภท
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              จำนวน
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              คงเหลือ
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              เอกสารอ้างอิง
            </th>
            <th scope="col" className="py-2 font-medium">
              ผู้ทำรายการ
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b last:border-0">
              <td className="py-2 pr-4">{new Date(item.createdAt).toLocaleString('th-TH')}</td>
              <td className="py-2 pr-4">
                {item.sku} {item.productName}
              </td>
              <td className="py-2 pr-4">{item.storeCode}</td>
              <td className="py-2 pr-4">{TYPE_LABEL[item.type]}</td>
              <td className="py-2 pr-4 text-right">
                {item.quantityChange > 0 ? `+${item.quantityChange}` : item.quantityChange}
              </td>
              <td className="py-2 pr-4 text-right">{item.balanceAfter}</td>
              <td className="py-2 pr-4">
                {item.sourceDocumentType} {item.sourceDocumentId}
              </td>
              <td className="py-2">{item.actorName}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {lastPage > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ก่อนหน้า
          </Button>
          <span className="text-muted-foreground">
            หน้า {page} จาก {lastPage} ({total} รายการ)
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
          >
            ถัดไป
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Stock movement history (RPT-03). The append-only ledger filtered by product, store,
 * movement type and date range, with the source document on every row. Open to every
 * signed-in role; the API confines a store employee to their own store (NFR-01).
 */
export function MovementHistoryPage() {
  const [filters, setFilters] = useState<Filters>({
    storeId: '',
    productId: '',
    type: '',
    from: '',
    to: '',
  });
  const stores = useQuery(orpc.stores.list.queryOptions({ input: { pageSize: 100 } }));
  const products = useQuery(orpc.products.list.queryOptions({ input: { pageSize: 100 } }));

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">ประวัติการเคลื่อนไหวสต็อก</h1>
        <p className="text-muted-foreground">
          ประวัติการรับ ขาย และปรับสต็อก กรองตามสินค้า สาขา ประเภท และช่วงวันที่
          พร้อมเอกสารอ้างอิงของแต่ละรายการ
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>ตัวกรอง</CardTitle>
          <CardDescription>เลือกเงื่อนไขเพื่อกรองประวัติ</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-5">
            <div className="space-y-2">
              <Label htmlFor="history-product">สินค้า</Label>
              <select
                id="history-product"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={filters.productId}
                onChange={(event) => set('productId', event.target.value)}
              >
                <option value="">ทุกสินค้า</option>
                {(products.data?.items ?? []).map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} {product.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="history-store">สาขา</Label>
              <select
                id="history-store"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={filters.storeId}
                onChange={(event) => set('storeId', event.target.value)}
              >
                <option value="">ทุกสาขา</option>
                {(stores.data?.items ?? []).map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.code} {store.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="history-type">ประเภท</Label>
              <select
                id="history-type"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={filters.type}
                onChange={(event) => set('type', event.target.value as Filters['type'])}
              >
                <option value="">ทุกประเภท</option>
                <option value="RECEIPT">{TYPE_LABEL.RECEIPT}</option>
                <option value="SALE">{TYPE_LABEL.SALE}</option>
                <option value="ADJUSTMENT">{TYPE_LABEL.ADJUSTMENT}</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="history-from">ตั้งแต่วันที่</Label>
              <Input
                id="history-from"
                type="date"
                value={filters.from}
                onChange={(event) => set('from', event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="history-to">ถึงวันที่</Label>
              <Input
                id="history-to"
                type="date"
                value={filters.to}
                onChange={(event) => set('to', event.target.value)}
              />
            </div>
          </div>
          {/* Keyed by the filters so a new filter starts again on page 1. */}
          <HistoryTable key={JSON.stringify(filters)} filters={filters} />
        </CardContent>
      </Card>
    </div>
  );
}
