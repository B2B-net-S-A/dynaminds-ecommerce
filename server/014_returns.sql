ALTER TABLE order_items ADD UNIQUE(tenant_id,order_id,id);
CREATE TABLE return_cases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,warehouse_id uuid NOT NULL,
 number text NOT NULL,kind text NOT NULL CHECK(kind IN ('return','complaint')),
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','refund_pending','closed','rejected','cancelled')),
 reason text NOT NULL,decision_note text NOT NULL DEFAULT '',legacy boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1,receipt_sequence integer NOT NULL DEFAULT 0,client_key uuid,request jsonb NOT NULL DEFAULT '{}',receipt jsonb,settlement jsonb,
 requested_shipping integer NOT NULL DEFAULT 0 CHECK(requested_shipping>=0),
 refunded_shipping integer NOT NULL DEFAULT 0 CHECK(refunded_shipping BETWEEN 0 AND requested_shipping),
 refund_amount integer NOT NULL DEFAULT 0 CHECK(refund_amount>=0),
 received_at timestamptz,refunded_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id,id),UNIQUE(tenant_id,number),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE return_items (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,item_id uuid NOT NULL,
 sku text NOT NULL,name text NOT NULL,components jsonb NOT NULL,
 requested integer NOT NULL CHECK(requested BETWEEN 1 AND 100000),
 accepted integer NOT NULL DEFAULT 0 CHECK(accepted BETWEEN 0 AND requested),
 restocked integer NOT NULL DEFAULT 0 CHECK(restocked BETWEEN 0 AND accepted),
 refund_amount integer NOT NULL DEFAULT 0 CHECK(refund_amount>=0),
 PRIMARY KEY(tenant_id,return_id,item_id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id,item_id) REFERENCES order_items(tenant_id,order_id,id)
);
CREATE INDEX return_cases_order ON return_cases(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX return_cases_queue ON return_cases(tenant_id,state,created_at DESC,id DESC);
CREATE INDEX return_items_order ON return_items(tenant_id,order_id,item_id);
ALTER TABLE documents ADD COLUMN return_id uuid;
ALTER TABLE documents ADD FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id);
DROP INDEX document_order_mode;
CREATE UNIQUE INDEX document_order_mode ON documents(tenant_id,order_id,kind,mode) WHERE return_id IS NULL;
CREATE UNIQUE INDEX document_return_mode ON documents(tenant_id,return_id,mode) WHERE return_id IS NOT NULL;
ALTER TABLE invoice_plans ADD COLUMN return_id uuid;
ALTER TABLE invoice_plans ADD FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id);
DROP INDEX invoice_active;
CREATE UNIQUE INDEX invoice_active ON invoice_plans(tenant_id,order_id,kind,mode) WHERE return_id IS NULL AND state NOT IN ('preview','cancelled');
CREATE UNIQUE INDEX invoice_return_active ON invoice_plans(tenant_id,return_id,mode) WHERE return_id IS NOT NULL AND state NOT IN ('preview','cancelled');
ALTER TABLE stock_movements ADD COLUMN return_id uuid;
ALTER TABLE stock_movements ADD FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id);
-- Existing full returns already changed inventory. Book their quantities without moving stock again.
INSERT INTO return_cases(id,tenant_id,order_id,warehouse_id,number,kind,state,reason,legacy,requested_shipping,refunded_shipping,refund_amount,received_at,created_at)
 SELECT id,tenant_id,id,warehouse_id,'LEGACY-'||number,'return',
 CASE WHEN status='return_initiated' THEN 'requested' WHEN status='return_completed' THEN 'closed' ELSE 'refund_pending' END,
 'Historyczny pełny zwrot; przepływ środków nie był rejestrowany',true,shipping_cost,
 CASE WHEN status='return_initiated' THEN 0 ELSE shipping_cost END,
 CASE WHEN status='return_initiated' THEN 0 ELSE total END,
 CASE WHEN status='return_initiated' THEN NULL ELSE updated_at END,created_at
 FROM orders WHERE status IN ('return_initiated','return_received','return_completed');
INSERT INTO return_items(tenant_id,order_id,return_id,item_id,sku,name,components,requested,accepted,restocked,refund_amount)
 SELECT i.tenant_id,i.order_id,i.order_id,i.id,i.sku,i.name,
 CASE WHEN jsonb_array_length(i.components)>0 THEN i.components ELSE jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',1)) END,
 i.quantity,CASE WHEN r.state='requested' THEN 0 ELSE i.quantity END,
 CASE WHEN r.state='requested' THEN 0 ELSE i.quantity END,
 CASE WHEN r.state='requested' THEN 0 ELSE i.line_total END
 FROM order_items i JOIN return_cases r ON r.id=i.order_id AND r.tenant_id=i.tenant_id AND r.legacy;
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['return_cases','return_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',tbl);
END LOOP; END $$;
