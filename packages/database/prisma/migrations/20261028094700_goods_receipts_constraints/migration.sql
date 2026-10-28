-- GR-02: a recorded receipt line carries a positive whole number of units. A product the
-- delivery did not include has no line at all.
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_quantity_positive" CHECK ("quantity" > 0);
