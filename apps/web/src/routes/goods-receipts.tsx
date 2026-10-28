import { ORPCError } from '@orpc/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ErrorEnvelope, GoodsReceipt, ReceivableOrder } from '@erp/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/lib/auth';
import { newIdempotencyKey } from '@/lib/idempotency-key';
import { orpc } from '@/lib/orpc';

const GENERIC_ERROR = 'เกิดข้อผิดพลาด ไม่สามารถดำเนินการได้';

const STATUS_LABEL = {
  APPROVED: 'อนุมัติแล้ว',
  PARTIALLY_RECEIVED: 'รับบางส่วน',
  COMPLETED: 'รับครบแล้ว',
} as const;

function envelopeOf(error: unknown): ErrorEnvelope | undefined {
  return error instanceof ORPCError ? (error.data as ErrorEnvelope | undefined) : undefined;
}

/** The Thai error, plus each product an over-receipt names and what can still be received (GR-02). */
function ErrorAlert({ error }: { error: unknown }) {
  const envelope = envelopeOf(error);
  return (
    <div role="alert" className="space-y-1 text-sm text-destructive">
      <p>{envelope?.message ?? GENERIC_ERROR}</p>
      {envelope?.products && (
        <ul className="list-disc pl-5">
          {envelope.products.map((product) => (
            <li key={product.productId}>
              {product.sku} {product.productName}: รับได้อีกไม่เกิน {product.available}{' '}
              แต่ต้องการรับ {product.requested}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Blank means "none of this arrived"; otherwise a non-negative whole number. */
function parseQuantity(text: string): number | null {
  if (text.trim() === '') return 0;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && /^\d+$/.test(text.trim()) ? value : null;
}

function OrderReceiving({
  order,
  canReceive,
  onConfirmed,
}: {
  order: ReceivableOrder;
  canReceive: boolean;
  onConfirmed: (receipt: GoodsReceipt) => void;
}) {
  const queryClient = useQueryClient();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  // One key per delivery being confirmed: kept across retries of the same request,
  // dropped as soon as the quantities change, so a deliberately new receipt gets a new key.
  const [key, setKey] = useState<string | null>(null);

  const confirm = useMutation(
    orpc.goodsReceipts.confirm.mutationOptions({
      onSuccess: (receipt) => {
        setKey(null);
        setQuantities({});
        onConfirmed(receipt);
        queryClient.invalidateQueries({ queryKey: orpc.goodsReceipts.key() });
        queryClient.invalidateQueries({ queryKey: orpc.inventory.key() });
        queryClient.invalidateQueries({ queryKey: orpc.purchaseOrders.key() });
      },
    }),
  );

  const parsed = order.lines.map((line) => ({
    line,
    quantity: parseQuantity(quantities[line.productId] ?? ''),
  }));
  const valid = parsed.every((p) => p.quantity !== null);
  const delivered = parsed.flatMap((p) =>
    p.quantity !== null && p.quantity > 0
      ? [{ productId: p.line.productId, quantity: p.quantity }]
      : [],
  );
  const canConfirm = canReceive && valid && delivered.length > 0 && !confirm.isPending;

  const title = order.documentNumber ?? 'ใบสั่งซื้อ';
  const submit = () => {
    const attemptKey = key ?? newIdempotencyKey();
    setKey(attemptKey);
    confirm.mutate({
      body: { purchaseOrderId: order.id, lines: delivered },
      headers: { 'idempotency-key': attemptKey },
    });
  };

  return (
    <section aria-labelledby={`order-${order.id}`} className="space-y-3 rounded-md border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id={`order-${order.id}`} className="font-medium">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">
            ผู้ขาย {order.supplierCode} · สาขา {order.storeCode} · กำหนดรับ{' '}
            {order.expectedReceiptDate}
          </p>
        </div>
        <Badge variant={order.status === 'APPROVED' ? 'outline' : 'secondary'}>
          {STATUS_LABEL[order.status]}
        </Badge>
      </div>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">รายการสินค้าของ {title}</caption>
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              สินค้า
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              สั่ง
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              รับแล้ว
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">
              คงเหลือ
            </th>
            {canReceive && (
              <th scope="col" className="py-2 text-right font-medium">
                รับครั้งนี้
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => {
            const inputId = `receive-${order.id}-${line.productId}`;
            const text = quantities[line.productId] ?? '';
            return (
              <tr key={line.productId} className="border-b last:border-0">
                <td className="py-2 pr-4">
                  {line.sku} {line.productName}
                </td>
                <td className="py-2 pr-4 text-right">{line.ordered}</td>
                <td className="py-2 pr-4 text-right">{line.received}</td>
                <td className="py-2 pr-4 text-right">{line.outstanding}</td>
                {canReceive && (
                  <td className="py-2 text-right">
                    <Label htmlFor={inputId} className="sr-only">
                      รับครั้งนี้ {line.sku}
                    </Label>
                    <Input
                      id={inputId}
                      inputMode="numeric"
                      className="ml-auto w-24 text-right"
                      value={text}
                      disabled={!line.isActive}
                      aria-invalid={parseQuantity(text) === null}
                      onChange={(event) => {
                        setKey(null);
                        setQuantities((current) => ({
                          ...current,
                          [line.productId]: event.target.value,
                        }));
                      }}
                    />
                    {!line.isActive && (
                      <p className="mt-1 text-xs text-destructive">
                        สินค้าถูกปิดการใช้งาน รับไม่ได้
                      </p>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {confirm.error && <ErrorAlert error={confirm.error} />}
      {canReceive && (
        <Button type="button" disabled={!canConfirm} onClick={submit}>
          {confirm.isPending ? 'กำลังยืนยัน…' : 'ยืนยันการรับสินค้า'}
        </Button>
      )}
    </section>
  );
}

function ReceivableOrders({
  canReceive,
  onConfirmed,
}: {
  canReceive: boolean;
  onConfirmed: (receipt: GoodsReceipt) => void;
}) {
  const orders = useQuery(orpc.goodsReceipts.receivableOrders.queryOptions({ input: {} }));

  if (orders.isPending) return <p className="text-muted-foreground">กำลังโหลด…</p>;
  if (!orders.data) return <ErrorAlert error={orders.error} />;
  if (orders.data.items.length === 0) {
    return <p className="text-muted-foreground">ไม่มีใบสั่งซื้อที่รอรับสินค้า</p>;
  }
  return (
    <div className="space-y-4">
      {orders.data.items.map((order) => (
        <OrderReceiving
          key={order.id}
          order={order}
          canReceive={canReceive}
          onConfirmed={onConfirmed}
        />
      ))}
    </div>
  );
}

function ReceiptList() {
  const receipts = useQuery(orpc.goodsReceipts.list.queryOptions({ input: {} }));

  if (receipts.isPending) return <p className="text-muted-foreground">กำลังโหลด…</p>;
  if (!receipts.data) return <ErrorAlert error={receipts.error} />;
  if (receipts.data.items.length === 0) {
    return <p className="text-muted-foreground">ยังไม่มีใบรับสินค้า</p>;
  }
  return (
    <ul className="divide-y rounded-md border">
      {receipts.data.items.map((receipt) => (
        <li key={receipt.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-col">
            <span className="font-medium">{receipt.documentNumber}</span>
            <span className="text-sm text-muted-foreground">
              {receipt.purchaseOrderNumber ?? 'ใบสั่งซื้อ'} · {receipt.storeCode} ·{' '}
              {receipt.lines.map((l) => `${l.sku} × ${l.quantity}`).join(', ')}
            </span>
          </div>
          <Badge variant="secondary">{STATUS_LABEL[receipt.orderStatus]}</Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * Receive goods against approved purchase orders (GR-01..GR-04). Store employees record
 * deliveries; managers and administrators can view. Confirmed receipts are final (GR-05),
 * so the page offers nothing to edit or cancel one.
 */
export function GoodsReceiptsPage() {
  const user = useCurrentUser();
  const canReceive = user?.role === 'STORE_EMPLOYEE';
  const [lastReceipt, setLastReceipt] = useState<GoodsReceipt | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">รับสินค้า</h1>
        <p className="text-muted-foreground">
          บันทึกการรับสินค้าตามใบสั่งซื้อที่อนุมัติแล้ว รับได้หลายครั้งจนครบจำนวนที่สั่ง
        </p>
      </div>
      {lastReceipt && (
        <p role="status" className="text-sm text-emerald-600">
          ยืนยันแล้ว {lastReceipt.documentNumber} สถานะใบสั่งซื้อ:{' '}
          {STATUS_LABEL[lastReceipt.orderStatus]}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>ใบสั่งซื้อที่รอรับสินค้า</CardTitle>
          <CardDescription>แสดงจำนวนที่สั่ง รับแล้ว และคงเหลือของแต่ละรายการ</CardDescription>
        </CardHeader>
        <CardContent>
          <ReceivableOrders canReceive={canReceive} onConfirmed={setLastReceipt} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>ใบรับสินค้า</CardTitle>
          <CardDescription>เรียงจากใหม่ไปเก่า</CardDescription>
        </CardHeader>
        <CardContent>
          <ReceiptList />
        </CardContent>
      </Card>
    </div>
  );
}
