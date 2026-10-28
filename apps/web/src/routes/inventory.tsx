import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { StockLevelsTable } from '@/components/stock-levels-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { orpc } from '@/lib/orpc';

function StockTable({ search }: { search: string }) {
  const stock = useQuery(
    orpc.inventory.list.queryOptions({ input: { search: search || undefined } }),
  );

  if (stock.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }

  if (!stock.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        ไม่สามารถโหลดข้อมูลสต็อกได้ กรุณาลองใหม่อีกครั้ง
      </p>
    );
  }

  if (stock.data.items.length === 0) {
    return <p className="text-muted-foreground">ไม่พบสินค้าในสต็อก</p>;
  }

  return <StockLevelsTable items={stock.data.items} />;
}

/** Stock search and low-stock view (INV-01). Every signed-in role; the API scopes store employees. */
export function InventoryPage() {
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">สต็อกสินค้า</h1>
        <p className="text-muted-foreground">ค้นหายอดคงเหลือและสถานะสต็อกต่ำของแต่ละสาขา</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>ค้นหาสต็อก</CardTitle>
          <CardDescription>
            ค้นหาด้วยรหัสสินค้า ชื่อสินค้า หรือสาขา
            สต็อกต่ำคือยอดคงเหลือน้อยกว่าหรือเท่ากับจุดสั่งซื้อ
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(term.trim());
            }}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="stock-search">ค้นหา SKU ชื่อสินค้า หรือสาขา</Label>
              <Input
                id="stock-search"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
              />
            </div>
            <Button type="submit">ค้นหา</Button>
          </form>
          <StockTable search={search} />
        </CardContent>
      </Card>
    </div>
  );
}
