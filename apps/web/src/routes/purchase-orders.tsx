import { ORPCError } from '@orpc/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ErrorEnvelope, PurchaseOrder, PurchaseOrderStatus, User } from '@erp/contracts';
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

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'ฉบับร่าง',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติแล้ว',
  PARTIALLY_RECEIVED: 'รับบางส่วน',
  COMPLETED: 'รับครบแล้ว',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิกแล้ว',
};

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
  // The list is the freshest view of the saved draft: once it is submitted it is frozen (PO-03).
  const orders = useQuery(orpc.purchaseOrders.list.queryOptions({ input: {} }));
  const draftStatus = orders.data?.items.find((item) => item.id === draft?.id)?.status;

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
          {(draftStatus ?? draft.status) === 'DRAFT' ? (
            <Button type="button" variant="outline" onClick={startEditing}>
              แก้ไขใบสั่งซื้อ
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              ใบสั่งซื้อนี้ไม่ใช่ฉบับร่างแล้ว จึงแก้ไขไม่ได้
            </p>
          )}
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

type Decision = 'approve' | 'reject' | 'cancel';

const DECISION_TEXT: Record<Decision, { open: string; confirm: string }> = {
  approve: { open: 'อนุมัติใบสั่งซื้อ', confirm: 'ยืนยันการอนุมัติ' },
  reject: { open: 'ปฏิเสธใบสั่งซื้อ', confirm: 'ยืนยันการปฏิเสธ' },
  cancel: { open: 'ยกเลิกใบสั่งซื้อ', confirm: 'ยืนยันการยกเลิก' },
};

/** Which actions the signed-in user is offered on an order. The API enforces the same rules. */
function actionsFor(po: PurchaseOrder, user: User | null | undefined) {
  const isManager = user?.role === 'MANAGER';
  const isOfficer = user?.role === 'PURCHASING_OFFICER';
  const open = po.status === 'DRAFT' || po.status === 'PENDING_APPROVAL';
  return {
    submit: isOfficer && po.status === 'DRAFT',
    decisions: [
      ...(isManager && po.status === 'PENDING_APPROVAL' ? (['approve', 'reject'] as const) : []),
      ...(open && (isManager || (isOfficer && po.createdById === user?.id))
        ? (['cancel'] as const)
        : []),
    ] satisfies Decision[],
  };
}

function PurchaseOrderList() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const orders = useQuery(orpc.purchaseOrders.list.queryOptions({ input: {} }));
  const [deciding, setDeciding] = useState<{ id: string; action: Decision } | null>(null);
  const [reason, setReason] = useState('');

  const onSuccess = () => {
    setDeciding(null);
    setReason('');
    return queryClient.invalidateQueries({ queryKey: orpc.purchaseOrders.key() });
  };
  const submit = useMutation(orpc.purchaseOrders.submit.mutationOptions({ onSuccess }));
  const mutations = {
    approve: useMutation(orpc.purchaseOrders.approve.mutationOptions({ onSuccess })),
    reject: useMutation(orpc.purchaseOrders.reject.mutationOptions({ onSuccess })),
    cancel: useMutation(orpc.purchaseOrders.cancel.mutationOptions({ onSuccess })),
  };
  const all = [submit, ...Object.values(mutations)];
  const failure = all.find((mutation) => mutation.error)?.error;
  const busy = all.some((mutation) => mutation.isPending);

  if (orders.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }
  if (!orders.data) {
    return <ErrorAlert error={orders.error} />;
  }
  if (orders.data.items.length === 0) {
    return <p className="text-muted-foreground">ยังไม่มีใบสั่งซื้อ</p>;
  }

  const startDecision = (id: string, action: Decision) => {
    all.forEach((mutation) => mutation.reset());
    setReason('');
    setDeciding({ id, action });
  };

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border">
        {orders.data.items.map((po) => {
          const actions = actionsFor(po, user);
          const open = deciding?.id === po.id ? deciding.action : null;
          return (
            <li key={po.id} className="space-y-2 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="font-medium">
                    {po.documentNumber ?? 'ใบสั่งซื้อ'} · {STATUS_LABEL[po.status]}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    ผู้ขาย {po.supplierCode} · สาขา {po.storeCode} · รับวันที่{' '}
                    {po.expectedReceiptDate}
                  </span>
                  {po.decisionReason && (
                    <span className="text-sm text-muted-foreground">
                      เหตุผล: {po.decisionReason}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span>{po.total} บาท</span>
                  {actions.submit && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        all.forEach((mutation) => mutation.reset());
                        submit.mutate({ id: po.id });
                      }}
                    >
                      ส่งขออนุมัติ
                    </Button>
                  )}
                  {actions.decisions.map((action) => (
                    <Button
                      key={action}
                      type="button"
                      size="sm"
                      variant={action === 'approve' ? 'default' : 'outline'}
                      disabled={busy}
                      onClick={() => startDecision(po.id, action)}
                    >
                      {DECISION_TEXT[action].open}
                    </Button>
                  ))}
                </div>
              </div>
              {open && (
                <form
                  className="flex items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!reason.trim()) return;
                    mutations[open].mutate({ id: po.id, reason });
                  }}
                >
                  <div className="flex-1 space-y-2">
                    <Label htmlFor={`po-reason-${po.id}`}>เหตุผล</Label>
                    <Input
                      id={`po-reason-${po.id}`}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
                    {DECISION_TEXT[open].confirm}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDeciding(null)}>
                    ปิด
                  </Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {failure && <ErrorAlert error={failure} />}
    </div>
  );
}

/**
 * Purchase orders (PO-01..PO-04). A Purchasing officer drafts, edits and submits; a Manager
 * approves or rejects with a reason; either can cancel a draft or pending order.
 */
export function PurchaseOrdersPage() {
  const user = useCurrentUser();
  const canManage = user?.role === 'PURCHASING_OFFICER';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">ใบสั่งซื้อ</h1>
        <p className="text-muted-foreground">
          สร้างและแก้ไขใบสั่งซื้อฉบับร่าง ส่งขออนุมัติ และติดตามสถานะการอนุมัติ
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
