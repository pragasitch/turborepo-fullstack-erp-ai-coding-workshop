import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ExportCsvButton } from '@/components/export-csv-button';
import { StockLevelsTable } from '@/components/stock-levels-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { client, orpc } from '@/lib/orpc';

type ReportKind = 'stockOnHand' | 'lowStock';

const reportText = {
  stockOnHand: {
    title: 'สต็อกคงเหลือ',
    description: 'ยอดคงเหลือของทุกสินค้าในแต่ละสาขา รวมสินค้าที่คงเหลือเป็นศูนย์',
    empty: 'ไม่พบสินค้าที่ตรงกับเงื่อนไข',
    failed: 'ไม่สามารถโหลดรายงานสต็อกคงเหลือได้ กรุณาลองใหม่อีกครั้ง',
    exportLabel: 'ส่งออก CSV สต็อกคงเหลือ',
    exportName: 'stock-on-hand.csv',
  },
  lowStock: {
    title: 'สินค้าสต็อกต่ำ',
    description: 'สินค้าที่ยอดคงเหลือน้อยกว่าหรือเท่ากับจุดสั่งซื้อของสาขา',
    empty: 'ไม่มีสินค้าสต็อกต่ำ',
    failed: 'ไม่สามารถโหลดรายงานสินค้าสต็อกต่ำได้ กรุณาลองใหม่อีกครั้ง',
    exportLabel: 'ส่งออก CSV สินค้าสต็อกต่ำ',
    exportName: 'low-stock.csv',
  },
} as const;

function ReportBody({ kind, search }: { kind: ReportKind; search: string }) {
  const [page, setPage] = useState(1);
  const input = { page, search: search || undefined };
  // Both routes share one input and output shape; only the path differs.
  const report = useQuery(
    kind === 'lowStock'
      ? orpc.reports.lowStock.queryOptions({ input })
      : orpc.reports.stockOnHand.queryOptions({ input }),
  );
  const text = reportText[kind];

  if (report.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }

  if (!report.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {text.failed}
      </p>
    );
  }

  const { items, total, pageSize } = report.data;
  if (total === 0) {
    return <p className="text-muted-foreground">{text.empty}</p>;
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="space-y-4">
      <StockLevelsTable items={items} />
      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{`หน้า ${page} จาก ${pages} (${total} รายการ)`}</span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              ก่อนหน้า
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              ถัดไป
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Report({ kind, search }: { kind: ReportKind; search: string }) {
  const headingId = useId();
  const text = reportText[kind];

  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader>
        <h2 id={headingId} className="leading-none font-semibold">
          {text.title}
        </h2>
        <CardDescription>{text.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ExportCsvButton
          label={text.exportLabel}
          fallbackName={text.exportName}
          exportFile={() => {
            const input = { search: search || undefined };
            return kind === 'lowStock'
              ? client.reports.exportLowStock(input)
              : client.reports.exportStockOnHand(input);
          }}
        />
        {/* Keyed by the search so a new search starts again on page 1. */}
        <ReportBody key={search} kind={kind} search={search} />
      </CardContent>
    </Card>
  );
}

/**
 * Stock-on-hand and low-stock reports (RPT-02). Every signed-in role; the API applies the
 * same store permission as the stock screen, so a store employee only sees their store.
 */
export function StockReportsPage() {
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">รายงานสต็อก</h1>
        <p className="text-muted-foreground">
          รายงานสต็อกคงเหลือและสินค้าสต็อกต่ำของแต่ละสาขา
          สต็อกต่ำคือยอดคงเหลือน้อยกว่าหรือเท่ากับจุดสั่งซื้อ
        </p>
      </div>
      <Card>
        <CardContent>
          <form
            className="flex items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(term.trim());
            }}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="report-search">ค้นหา SKU ชื่อสินค้า หรือสาขา</Label>
              <Input
                id="report-search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
              />
            </div>
            <Button type="submit">ค้นหา</Button>
          </form>
        </CardContent>
      </Card>
      <Report kind="stockOnHand" search={search} />
      <Report kind="lowStock" search={search} />
    </div>
  );
}
