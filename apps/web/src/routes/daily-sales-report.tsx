import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DailySalesRow } from '@erp/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { orpc } from '@/lib/orpc';

/** Days per page; the contract caps pageSize at 100 (≈ three months per page). */
const PAGE_SIZE = 100;

/** Sum a page of per-day rows into a single total, as a two-decimal string. */
function sumAmount(rows: DailySalesRow[]): string {
  const satang = rows.reduce((acc, row) => acc + Math.round(Number(row.totalAmount) * 100), 0);
  return (satang / 100).toFixed(2);
}

function ReportTable({ from, to, storeId }: { from: string; to: string; storeId: string }) {
  const [page, setPage] = useState(1);
  const report = useQuery(
    orpc.reports.dailySales.queryOptions({
      input: { from, to, storeId: storeId || undefined, page, pageSize: PAGE_SIZE },
    }),
  );

  if (report.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }

  if (!report.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        ไม่สามารถโหลดรายงานการขายได้ กรุณาลองใหม่อีกครั้ง
      </p>
    );
  }

  const { items, total } = report.data;
  const totalUnits = items.reduce((acc, row) => acc + row.unitsSold, 0);
  const totalDocs = items.reduce((acc, row) => acc + row.documentCount, 0);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const paginated = total > PAGE_SIZE;

  return (
    <div className="space-y-3">
      {/* Totals describe the days shown on this page; the label makes that explicit once paged. */}
      <p className="text-sm text-muted-foreground">
        {paginated ? 'หน้านี้: ' : ''}ใบขาย {totalDocs} ใบ · ขาย {totalUnits} หน่วย · ยอดขายรวม{' '}
        {sumAmount(items)} บาท
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground">ไม่มีการขายในช่วงวันที่ที่เลือก</p>
      ) : (
        <>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">ยอดขายรายวัน</caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  วันที่
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  จำนวนใบขาย
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  จำนวนหน่วย
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  ยอดขาย (บาท)
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.date} className="border-b last:border-0">
                  <td className="py-2 pr-4">{row.date}</td>
                  <td className="py-2 pr-4 text-right">{row.documentCount}</td>
                  <td className="py-2 pr-4 text-right">{row.unitsSold}</td>
                  <td className="py-2 text-right">{row.totalAmount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {paginated && (
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
                หน้า {page} จาก {lastPage}
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
        </>
      )}
    </div>
  );
}

/** Today's date in Asia/Bangkok as "YYYY-MM-DD", the default both ends of the range. */
function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

/**
 * Daily sales report (RPT-01). Confirmed sales per Asia/Bangkok day over a date range and
 * store. The API applies the same store permission as the sales screen, so a store
 * employee only ever sees their own store. Empty ranges show a clear empty state (AC-08).
 */
export function DailySalesReportPage() {
  const today = bangkokToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [storeId, setStoreId] = useState('');
  const stores = useQuery(orpc.stores.list.queryOptions({ input: { pageSize: 100 } }));

  const ready = Boolean(from && to && from <= to);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">รายงานการขายรายวัน</h1>
        <p className="text-muted-foreground">
          สรุปยอดขายที่ยืนยันแล้วรายวันตามช่วงวันที่และสาขา (เขตเวลา Asia/Bangkok)
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>ช่วงรายงาน</CardTitle>
          <CardDescription>เลือกช่วงวันที่และสาขา</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="report-from">ตั้งแต่วันที่</Label>
              <Input
                id="report-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-to">ถึงวันที่</Label>
              <Input
                id="report-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-store">สาขา</Label>
              <select
                id="report-store"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={storeId}
                onChange={(event) => setStoreId(event.target.value)}
              >
                <option value="">ทุกสาขา</option>
                {(stores.data?.items ?? []).map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.code} {store.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {ready ? (
            <ReportTable from={from} to={to} storeId={storeId} />
          ) : (
            <p className="text-muted-foreground">เลือกช่วงวันที่เพื่อดูรายงาน</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
