import { ORPCError } from '@orpc/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ErrorEnvelope, PurchaseOrder } from '@erp/contracts';
import { PurchaseOrderLineInputSchema } from '@erp/contracts';
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

function ErrorAlert({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {envelopeOf(error)?.message ?? GENERIC_ERROR}
    </p>
  );
}

type BuilderLine = {
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: string;
};

function PurchaseOrderForm() {
  const queryClient = useQueryClient();
  const suppliers = useQuery(orpc.suppliers.list.queryOptions({ input: { pageSize: 100 } }));
  const stores = useQuery(orpc.stores.list.queryOptions({ input: { pageSize: 100 } }));
  const products = useQuery(orpc.products.list.queryOptions({ input: { pageSize: 100 } }));

  const [supplierId, setSupplierId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [expectedReceiptDate, setExpectedReceiptDate] = useState('');
  const [lines, setLines] = useState<BuilderLine[]>([]);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [draft, setDraft] = useState<PurchaseOrder | null>(null);
  const [editing, setEditing] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.purchaseOrders.key() });

  const save = useMutation(
    orpc.purchaseOrders.create.mutationOptions({
      onSuccess: (po) => {
        setDraft(po);
        setLines([]);
        refresh();
      },
    }),
  );
  const update = useMutation(
    orpc.purchaseOrders.update.mutationOptions({
      onSuccess: (po) => {
        setDraft(po);
        setEditing(false);
        setLines([]);
        refresh();
      },
    }),
  );

  const productOptions = (products.data?.items ?? []).filter((p) => p.isActive);
  const chosen = productOptions.find((item) => item.id === productId);
  // The contract's line schema is the single source of the quantity and price rules.
  const canAdd =
    Boolean(chosen) &&
    PurchaseOrderLineInputSchema.safeParse({ productId, quantity: Number(quantity), unitPrice })
      .success;

  const addLine = () => {
    if (!chosen || !canAdd) return;
    setLines((current) => [
      ...current.filter((line) => line.productId !== chosen.id),
      {
        productId: chosen.id,
        sku: chosen.sku,
        productName: chosen.name,
        quantity: Number(quantity),
        unitPrice,
      },
    ]);
    setProductId('');
    setQuantity('1');
    setUnitPrice('');
  };

  const headerReady = Boolean(supplierId && storeId && expectedReceiptDate);
  const canSave = headerReady && lines.length > 0;

  const submit = () => {
    const payload = {
      supplierId,
      storeId,
      expectedReceiptDate,
      lines: lines.map(({ productId, quantity, unitPrice }) => ({
        productId,
        quantity,
        unitPrice,
      })),
    };
    if (editing && draft) update.mutate({ id: draft.id, ...payload });
    else save.mutate(payload);
  };

  const startEditing = () => {
    if (!draft) return;
    setSupplierId(draft.supplierId);
    setStoreId(draft.storeId);
    setExpectedReceiptDate(draft.expectedReceiptDate);
    setLines(
      draft.lines.map((line) => ({
        productId: line.productId,
        sku: line.sku,
        productName: line.productName,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
    );
    setEditing(true);
  };

  const showDraft = draft && !editing;

  if (suppliers.isPending || stores.isPending || products.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }

  return (
    <div className="space-y-6">
      {!showDraft && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="po-supplier">ผู้ขาย</Label>
              <select
                id="po-supplier"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
              >
                <option value="">เลือกผู้ขาย</option>
                {(suppliers.data?.items ?? []).map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.code} {supplier.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="po-store">สาขาปลายทาง</Label>
              <select
                id="po-store"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={storeId}
                onChange={(event) => setStoreId(event.target.value)}
              >
                <option value="">เลือกสาขา</option>
                {(stores.data?.items ?? []).map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.code} {store.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="po-date">วันที่คาดว่าจะได้รับ</Label>
              <Input
                id="po-date"
                type="date"
                value={expectedReceiptDate}
                onChange={(event) => setExpectedReceiptDate(event.target.value)}
              />
            </div>
          </div>

          <form
            className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              addLine();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="po-product">สินค้า</Label>
              <select
                id="po-product"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
              >
                <option value="">เลือกสินค้า</option>
                {productOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sku} {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="po-quantity">จำนวน</Label>
              <Input
                id="po-quantity"
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="po-price">ราคาต่อหน่วย</Label>
              <Input
                id="po-price"
                inputMode="decimal"
                placeholder="0.00"
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
              />
            </div>
            <Button type="submit" variant="secondary" disabled={!canAdd}>
              เพิ่มรายการ
            </Button>
          </form>

          {lines.length > 0 && (
            <ul className="divide-y rounded-md border" aria-label="รายการในใบสั่งซื้อ">
              {lines.map((line) => (
                <li key={line.productId} className="flex items-center justify-between px-4 py-2">
                  <span>
                    {line.sku} {line.productName} × {line.quantity} @ {line.unitPrice}
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
          )}

          <Button
            type="button"
            onClick={submit}
            disabled={!canSave || save.isPending || update.isPending}
          >
            {editing ? 'บันทึกการแก้ไขใบสั่งซื้อ' : 'บันทึกใบสั่งซื้อ'}
          </Button>

          {(save.error || update.error) && <ErrorAlert error={save.error ?? update.error} />}
        </>
      )}

      {showDraft && (
        <div className="space-y-3">
          <PurchaseOrderSummary po={draft} />
          <Button type="button" variant="outline" onClick={startEditing}>
            แก้ไขใบสั่งซื้อ
          </Button>
        </div>
      )}
    </div>
  );
}

function PurchaseOrderSummary({ po }: { po: PurchaseOrder }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        ผู้ขาย {po.supplierCode} · สาขาปลายทาง {po.storeCode} · รับวันที่ {po.expectedReceiptDate}
      </p>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">รายการในใบสั่งซื้อ</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              สินค้า
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              จำนวน
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              ราคาต่อหน่วย
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              รวม
            </th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((line) => (
            <tr key={line.id} className="border-b last:border-0">
              <td className="py-2 pr-4">
                {line.sku} {line.productName}
              </td>
              <td className="py-2 pr-4 text-right">{line.quantity}</td>
              <td className="py-2 pr-4 text-right">{line.unitPrice}</td>
              <td className="py-2 text-right">{line.lineTotal}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-right font-medium">ยอดรวมทั้งหมด {po.total} บาท</p>
    </div>
  );
}

function PurchaseOrderList() {
  const orders = useQuery(orpc.purchaseOrders.list.queryOptions({ input: {} }));

  if (orders.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }
  if (!orders.data) {
    return <ErrorAlert error={orders.error} />;
  }
  if (orders.data.items.length === 0) {
    return <p className="text-muted-foreground">ยังไม่มีใบสั่งซื้อ</p>;
  }

  return (
    <ul className="divide-y rounded-md border">
      {orders.data.items.map((po) => (
        <li key={po.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-col">
            <span className="font-medium">{po.documentNumber ?? 'ฉบับร่าง'}</span>
            <span className="text-sm text-muted-foreground">
              ผู้ขาย {po.supplierCode} · สาขา {po.storeCode} · รับวันที่ {po.expectedReceiptDate}
            </span>
          </div>
          <span>{po.total} บาท</span>
        </li>
      ))}
    </ul>
  );
}

/** Create and edit draft purchase orders (PO-01). Purchasing officer only. */
export function PurchaseOrdersPage() {
  const user = useCurrentUser();
  const canManage = user?.role === 'PURCHASING_OFFICER';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">ใบสั่งซื้อ</h1>
        <p className="text-muted-foreground">
          สร้างและแก้ไขใบสั่งซื้อฉบับร่างสำหรับผู้ขายและสาขาปลายทาง
        </p>
      </div>
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>ใบสั่งซื้อใหม่</CardTitle>
            <CardDescription>เลือกผู้ขาย สาขาปลายทาง วันที่ และรายการสินค้า</CardDescription>
          </CardHeader>
          <CardContent>
            <PurchaseOrderForm />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>รายการใบสั่งซื้อ</CardTitle>
          <CardDescription>เรียงจากใหม่ไปเก่า</CardDescription>
        </CardHeader>
        <CardContent>
          <PurchaseOrderList />
        </CardContent>
      </Card>
    </div>
  );
}
