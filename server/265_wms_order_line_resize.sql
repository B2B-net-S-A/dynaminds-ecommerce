-- An order line edit with WMS lots on resizes the order's own reservation layer rows in place.
-- wms_row_guard (090/104/108) keeps quantity and released rows fixed; this adds one narrow branch:
-- an UPDATE of an unscanned row of an order in new/paid, to the quantity and state this transaction
-- recorded beforehand in the immutable wms_order_line_resizes (one per resize, beside its WMS operation).
CREATE TABLE wms_order_line_resizes (
 tenant_id uuid NOT NULL,id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL,product_id uuid NOT NULL,warehouse_id uuid NOT NULL,
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 before_layers jsonb NOT NULL,after_layers jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,order_id,product_id,warehouse_id) REFERENCES reservations(tenant_id,order_id,product_id,warehouse_id),
 CHECK(jsonb_typeof(before_layers)='array' AND jsonb_typeof(after_layers)='array')
);
CREATE INDEX wms_order_line_resizes_tx ON wms_order_line_resizes(tenant_id,order_id,product_id,transaction_id);
ALTER TABLE wms_order_line_resizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_order_line_resizes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON wms_order_line_resizes TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION wms_order_line_resize_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Dowód zmiany ilości WMS jest niezmienny' USING ERRCODE='23514';END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON wms_order_line_resizes FOR EACH ROW EXECUTE FUNCTION wms_order_line_resize_immutable();
REVOKE ALL ON wms_order_line_resizes FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT ON wms_order_line_resizes TO dyna_app;

-- Same keys and scans, an active or released row becomes active, and both rows are the exact
-- before/after pair of a resize recorded in this very transaction for an order still in new/paid.
-- Runs as the caller, so the tenant policies of orders and wms_order_line_resizes apply.
CREATE FUNCTION wms_order_line_resize_allowed(old_row jsonb,new_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT old_row-'quantity'-'state'=new_row-'quantity'-'state' AND (old_row->>'scanned')::int=0
  AND old_row->>'state' IN ('active','released') AND new_row->>'state'='active'
  AND EXISTS(SELECT 1 FROM wms_order_line_resizes x JOIN orders o ON(o.tenant_id,o.id)=(x.tenant_id,x.order_id)
  WHERE x.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND x.tenant_id=(new_row->>'tenant_id')::uuid
  AND (x.order_id,x.product_id,x.warehouse_id)=((new_row->>'order_id')::uuid,(new_row->>'product_id')::uuid,(new_row->>'warehouse_id')::uuid)
  AND x.transaction_id=pg_current_xact_id() AND x.transaction_started_at=transaction_timestamp() AND o.status IN ('new','paid')
  AND x.before_layers @> jsonb_build_array(old_row) AND x.after_layers @> jsonb_build_array(new_row))
$$;
REVOKE ALL ON FUNCTION wms_order_line_resize_allowed(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_order_line_resize_allowed(jsonb,jsonb) TO dyna_app;

-- Keep the installed 108 row guard byte-for-byte except one derived UPDATE branch right after its
-- declarations (the 108 technique); no caller supplied GUC can authorize it.
DO $$ DECLARE definition text;anchor text:='DECLARE l record;op record;f record;p record;BEGIN';BEGIN
 definition:=pg_get_functiondef('public.wms_row_guard()'::regprocedure);
 IF position(anchor IN definition)=0 OR position('wms_order_line_resize_allowed' IN definition)>0 THEN
  RAISE EXCEPTION 'Nieznany wariant ochrony WMS';END IF;
 definition:=replace(definition,anchor,anchor||'
 IF TG_OP=''UPDATE'' AND TG_TABLE_NAME=''wms_reservation_layers'' AND wms_order_line_resize_allowed(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;');
 EXECUTE definition;END $$;
