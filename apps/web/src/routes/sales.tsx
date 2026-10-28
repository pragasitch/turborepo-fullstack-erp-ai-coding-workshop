import { ORPCError } from '@orpc/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ErrorEnvelope, Sale } from '@erp/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/lib/auth';
import { orpc } from '@/lib/orpc';

const GENERIC_ERROR = 'เกิดข้อผิดพลาด ไม่สามารถดำเนินการได้';

function envelopeOf(error: unknown): ErrorEnvelope | undefined {
  return error instanceof ORPCError ? (error.data as ErrorEnvelope | undefined) : undefined;
}

/** The Thai error, plus every product a rejected confirmation names (SAL-02). */
function ErrorAlert({ error }: { error: unknown }) {
  const envelope = envelopeOf(error);
  return (
    <div role="alert" className="space-y-1 text-sm text-destructive">
      <p>{envelope?.message ?? GENERIC_ERROR}</p>
      {envelope?.products && (
        <ul className="list-disc pl-5">
          {envelope.products.map((product) => (
            <li key={product.productId}>
              {product.sku} {product.productName}: ต้องการ {product.requested} คงเหลือ{' '}
              {product.available}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type BuilderLine = { productId: string; sku: string; productName: string; quantity: number };

/** A fresh key per draft, reused for every retry of that draft's confirmation (SAL-03). */
function newIdempotencyKey() {
  return crypto.randomUUID();
}

function SaleForm() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const stock = useQuery(
    orpc.inventory.list.queryOptions({ input: { pageSize: 100, search: search || undefined } }),
  );
  const [lines, setLines] = useState<BuilderLine[]>([]);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [draft, setDraft] = useState<Sale | null>(null);
  const [editing, setEditing] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: orpc.sales.key() });
    queryClient.invalidateQueries({ queryKey: orpc.inventory.key() });
  };

  const save = useMutation(
    orpc.sales.create.mutationOptions({
      onSuccess: (sale) => {
        setDraft(sale);
        setKeys((current) => ({ ...current, [sale.id]: newIdempotencyKey() }));
        setLines([]);
        refresh();
      },
    }),
  );
  const update = useMutation(
    orpc.sales.update.mutationOptions({
      onSuccess: (sale) => {
        setDraft(sale);
        setEditing(false);
        setLines([]);
        refresh();
      },
    }),
  );
  const confirm = useMutation(
    orpc.sales.confirm.mutationOptions({
      onSuccess: (sale) => {
        setDraft(sale);
        refresh();
      },
    }),
  );

  const options = stock.data?.items ?? [];
  const chosen = options.find((item) => item.productId === productId);
  const quantityNumber = Number(quantity);
  const canAdd = Boolean(chosen) && Number.isInteger(quantityNumber) && quantityNumber > 0;

  const addLine = () => {
    if (!chosen || !canAdd) return;
    setLines((current) => [
      ...current.filter((line) => line.productId !== chosen.productId),
      {
        productId: chosen.productId,
        sku: chosen.sku,
        productName: chosen.productName,
        quantity: quantityNumber,
      },
    ]);
    setProductId('');
    setQuantity('1');
  };

  const submitLines = () => {
    const payload = lines.map(({ productId, quantity }) => ({ productId, quantity }));
    if (editing && draft) update.mutate({ id: draft.id, lines: payload });
    else save.mutate({ lines: payload });
  };

  const startEditing = () => {
    if (!draft) return;
    setLines(
      draft.lines.map((line) => ({
        productId: line.productId,
        sku: line.sku,
        productName: line.productName,
        quantity: line.quantity,
      })),
    );
    setEditing(true);
    confirm.reset();
  };

  const showDraft = draft && !editing;
  const draftKey = draft ? keys[draft.id] : undefined;

  return (
    <div className="space-y-6">
      {!showDraft && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            addLine();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="sale-search">ค้นหาสินค้า</Label>
            <Input
              id="sale-search"
              placeholder="SKU หรือชื่อสินค้า"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="sale-product">สินค้า</Label>
              <select
                id="sale-product"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
              >
                <option value="">เลือกสินค้า</option>
                {options.map((item) => (
                  <option key={item.productId} value={item.productId}>
                    {item.sku} {item.productName} (คงเหลือ {item.quantity} {item.unit})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sale-quantity">จำนวน</Label>
              <Input
                id="sale-quantity"
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary" disabled={!canAdd}>
              เพิ่มรายการ
            </Button>
          </div>
        </form>
      )}

      {!showDraft && lines.length > 0 && (
        <div className="space-y-3">
          <ul className="divide-y rounded-md border" aria-label="รายการที่จะขาย">
            {lines.map((line) => (
              <li key={line.productId} className="flex items-center justify-between px-4 py-2">
                <span>
                  {line.sku} {line.productName} × {line.quantity}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`ลบ ${line.sku}`}
                  onClick={() =>
                    setLines((current) => current.filter((l) => l.productId !== line.productId))
                  }
                >
                  ลบ
                </Button>
              </li>
            ))}
          </ul>
          <Button type="button" onClick={submitLines} disabled={save.isPending || update.isPending}>
            {editing ? 'บันทึกการแก้ไขใบขาย' : 'บันทึกใบขาย'}
          </Button>
        </div>
      )}

      {(save.error || update.error) && <ErrorAlert error={save.error ?? update.error} />}

      {showDraft && (
        <div className="space-y-3">
          <SaleSummary sale={draft} />
          {draft.status === 'DRAFT' && (
            <>
              {confirm.error && <ErrorAlert error={confirm.error} />}
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={confirm.isPending || !draftKey}
                  onClick={() =>
                    draftKey &&
                    confirm.mutate({
                      params: { id: draft.id },
                      headers: { 'idempotency-key': draftKey },
                    })
                  }
                >
                  {confirm.isPending ? 'กำลังยืนยัน…' : 'ยืนยันการขาย'}
                </Button>
                <Button type="button" variant="outline" onClick={startEditing}>
                  แก้ไขรายการ
                </Button>
              </div>
            </>
          )}
          {draft.status === 'CONFIRMED' && (
            <>
              <p role="status" className="text-sm text-emerald-600">
                ยืนยันแล้ว {draft.documentNumber} ยอดรวม {draft.total} บาท
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDraft(null);
                  confirm.reset();
                }}
              >
                เริ่มใบขายใหม่
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SaleSummary({ sale }: { sale: Sale }) {
  return (
    <div className="space-y-2">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">รายการในใบขาย</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              สินค้า
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              จำนวน
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              ราคา
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              รวม
            </th>
            {sale.status === 'CONFIRMED' && (
              <th scope="col" className="py-2 text-right font-medium">
                คงเหลือ
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {sale.lines.map((line) => (
            <tr key={line.id} className="border-b last:border-0">
              <td className="py-2 pr-4">
                {line.sku} {line.productName}
              </td>
              <td className="py-2 pr-4 text-right">{line.quantity}</td>
              <td className="py-2 pr-4 text-right">{line.unitPrice}</td>
              <td className="py-2 pr-4 text-right">{line.lineTotal}</td>
              {sale.status === 'CONFIRMED' && (
                <td className="py-2 text-right">{line.balanceAfter}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-right font-medium">ยอดรวมทั้งหมด {sale.total} บาท</p>
    </div>
  );
}

function SaleList() {
  const sales = useQuery(orpc.sales.list.queryOptions({ input: {} }));

  if (sales.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }

  if (!sales.data) {
    return <ErrorAlert error={sales.error} />;
  }

  if (sales.data.items.length === 0) {
    return <p className="text-muted-foreground">ยังไม่มีใบขาย</p>;
  }

  return (
    <ul className="divide-y rounded-md border">
      {sales.data.items.map((sale) => (
        <li key={sale.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-col">
            <span className="font-medium">{sale.documentNumber ?? 'ฉบับร่าง'}</span>
            <span className="text-sm text-muted-foreground">
              {sale.storeCode} · {sale.lines.map((l) => `${l.sku} × ${l.quantity}`).join(', ')}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span>{sale.total} บาท</span>
            <Badge variant={sale.status === 'CONFIRMED' ? 'secondary' : 'outline'}>
              {sale.status === 'CONFIRMED' ? 'ยืนยันแล้ว' : 'ฉบับร่าง'}
            </Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Record and confirm sales (SAL-01..SAL-03); confirmed sales can only be viewed (SAL-04). */
export function SalesPage() {
  const user = useCurrentUser();
  const canSell = user?.role === 'STORE_EMPLOYEE';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">ขายสินค้า</h1>
        <p className="text-muted-foreground">
          บันทึกใบขายด้วยราคาขายปัจจุบัน แล้วยืนยันเพื่อตัดสต็อก
        </p>
      </div>
      {canSell && (
        <Card>
          <CardHeader>
            <CardTitle>ใบขายใหม่</CardTitle>
            <CardDescription>เลือกสินค้าและจำนวน ราคาระบบกำหนดให้</CardDescription>
          </CardHeader>
          <CardContent>
            <SaleForm />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>ใบขาย</CardTitle>
          <CardDescription>เรียงจากใหม่ไปเก่า</CardDescription>
        </CardHeader>
        <CardContent>
          <SaleList />
        </CardContent>
      </Card>
    </div>
  );
}
