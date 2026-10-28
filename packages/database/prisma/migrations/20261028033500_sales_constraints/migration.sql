-- SAL-01: a sale line sells a positive whole number of units.
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_quantity_positive" CHECK ("quantity" > 0);

-- SAL-03: a confirmed sale always has its document number, confirmer, time and key,
-- whatever the application code does.
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_confirmed_has_document" CHECK (
  "status" <> 'CONFIRMED'
  OR ("documentNumber" IS NOT NULL
      AND "confirmedById" IS NOT NULL
      AND "confirmedAt" IS NOT NULL
      AND "idempotencyKey" IS NOT NULL)
);
