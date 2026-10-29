-- NFR-05: keep the search and stock-view APIs fast at scale (1,000 products, 10,000
-- movements). The free-text stock search filters products and stores with ILIKE '%term%'
-- (a leading wildcard), which a btree index cannot serve. Trigram GIN indexes can, so the
-- planner uses an index scan instead of a sequential scan over the whole table.
--
-- The movement timestamp is already indexed (StockMovement @@index([createdAt]) and
-- @@index([productId, storeId, createdAt])), which serves the newest-first history read.

-- IF NOT EXISTS keeps this safe to replay; CREATE EXTENSION needs the pg_trgm contrib module.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- SKU and product name: the two columns the stock/report search matches with ILIKE.
CREATE INDEX "Product_sku_trgm_idx" ON "Product" USING gin ("sku" gin_trgm_ops);
CREATE INDEX "Product_name_trgm_idx" ON "Product" USING gin ("name" gin_trgm_ops);

-- Store code and name: the stock search also matches a store token with ILIKE.
CREATE INDEX "Store_code_trgm_idx" ON "Store" USING gin ("code" gin_trgm_ops);
CREATE INDEX "Store_name_trgm_idx" ON "Store" USING gin ("name" gin_trgm_ops);
