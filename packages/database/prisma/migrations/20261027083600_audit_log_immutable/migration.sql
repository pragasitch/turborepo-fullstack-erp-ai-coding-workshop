-- Audit rows are immutable (NFR-03): reject UPDATE and DELETE at the database, the
-- same way StockMovement is protected. Appending only is allowed.
CREATE FUNCTION "reject_audit_log_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog rows are immutable (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_immutable"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "reject_audit_log_change"();
