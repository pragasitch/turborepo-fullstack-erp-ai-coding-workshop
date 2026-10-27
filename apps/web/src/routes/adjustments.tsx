import { ORPCError } from '@orpc/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ErrorEnvelope } from '@erp/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { orpc } from '@/lib/orpc';

/** The Thai message from the shared error envelope, with a safe Thai fallback. */
function thaiError(error: unknown): string {
  if (error instanceof ORPCError) {
    const data = error.data as ErrorEnvelope | undefined;
    if (data?.message) return data.message;
  }
  return 'เกิดข้อผิดพลาด ไม่สามารถดำเนินการได้';
}

function AdjustForm() {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');

  const adjust = useMutation(
    orpc.adjustments.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.adjustments.auditList.key() });
        setProductId('');
        setStoreId('');
        setQuantity('');
        setReason('');
      },
    }),
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        adjust.mutate({ productId, storeId, quantityChange: Number(quantity), reason });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="productId">รหัสสินค้า</Label>
        <Input
          id="productId"
          required
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="storeId">รหัสสาขา</Label>
        <Input
          id="storeId"
          required
          value={storeId}
          onChange={(event) => setStoreId(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="quantity">จำนวนที่ปรับ (+ เพิ่ม / - ลด)</Label>
        <Input
          id="quantity"
          required
          inputMode="numeric"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="reason">เหตุผล</Label>
        <Input
          id="reason"
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {adjust.error && (
        <p role="alert" className="text-sm text-destructive">
          {thaiError(adjust.error)}
        </p>
      )}
      {adjust.data && (
        <p role="status" className="text-sm text-emerald-600">
          บันทึกแล้ว {adjust.data.documentNumber} — คงเหลือ {adjust.data.balanceAfter}
        </p>
      )}
      <Button type="submit" disabled={adjust.isPending}>
        {adjust.isPending ? 'กำลังบันทึก…' : 'บันทึกการปรับสต็อก'}
      </Button>
    </form>
  );
}

function AuditTrail() {
  const audit = useQuery(orpc.adjustments.auditList.queryOptions({ input: {} }));

  if (audit.isPending) {
    return <p className="text-muted-foreground">กำลังโหลด…</p>;
  }

  if (!audit.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {thaiError(audit.error)}
      </p>
    );
  }

  if (audit.data.items.length === 0) {
    return <p className="text-muted-foreground">ยังไม่มีประวัติการตรวจสอบ</p>;
  }

  return (
    <ul className="divide-y rounded-md border">
      {audit.data.items.map((entry) => (
        <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-col">
            <span className="font-medium">{entry.sourceDocumentId}</span>
            <span className="text-sm text-muted-foreground">
              {entry.actorName} · {entry.detail}
            </span>
          </div>
          <Badge variant={entry.outcome === 'SUCCESS' ? 'secondary' : 'destructive'}>
            {entry.outcome}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** Manager stock adjustments and the audit trail (INV-05, NFR-03). */
export function AdjustmentsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">ปรับสต็อก</h1>
        <p className="text-muted-foreground">ปรับยอดสต็อกพร้อมเหตุผล และดูประวัติการตรวจสอบ</p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>ปรับยอดสต็อก</CardTitle>
            <CardDescription>ระบุสินค้า สาขา จำนวน และเหตุผล</CardDescription>
          </CardHeader>
          <CardContent>
            <AdjustForm />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>ประวัติการตรวจสอบ</CardTitle>
            <CardDescription>เรียงจากใหม่ไปเก่า</CardDescription>
          </CardHeader>
          <CardContent>
            <AuditTrail />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
