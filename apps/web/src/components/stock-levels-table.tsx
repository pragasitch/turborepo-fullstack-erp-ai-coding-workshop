import type { StockLevel } from '@erp/contracts';
import { Badge } from '@/components/ui/badge';

/** One row per (product, store): balance, unit, reorder threshold and low-stock status. */
export function StockLevelsTable({ items }: { items: StockLevel[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th scope="col" className="py-2 pr-4 font-medium">
            SKU
          </th>
          <th scope="col" className="py-2 pr-4 font-medium">
            สินค้า
          </th>
          <th scope="col" className="py-2 pr-4 font-medium">
            สาขา
          </th>
          <th scope="col" className="py-2 pr-4 text-right font-medium">
            คงเหลือ
          </th>
          <th scope="col" className="py-2 pr-4 font-medium">
            หน่วย
          </th>
          <th scope="col" className="py-2 pr-4 text-right font-medium">
            จุดสั่งซื้อ
          </th>
          <th scope="col" className="py-2 font-medium">
            สถานะ
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={`${item.productId}:${item.storeId}`} className="border-b last:border-0">
            <td className="py-2 pr-4 font-medium">{item.sku}</td>
            <td className="py-2 pr-4">{item.productName}</td>
            <td className="py-2 pr-4">{`${item.storeCode} ${item.storeName}`}</td>
            <td className="py-2 pr-4 text-right tabular-nums">{item.quantity}</td>
            <td className="py-2 pr-4">{item.unit}</td>
            <td className="py-2 pr-4 text-right tabular-nums">{item.reorderThreshold ?? '-'}</td>
            <td className="py-2">
              {item.isLowStock ? (
                <Badge variant="destructive">สต็อกต่ำ</Badge>
              ) : (
                <Badge variant="secondary">ปกติ</Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
