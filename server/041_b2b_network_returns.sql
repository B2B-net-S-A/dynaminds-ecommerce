ALTER TABLE warehouse_documents DROP CONSTRAINT warehouse_documents_kind_check;
ALTER TABLE warehouse_documents ADD CHECK(kind IN ('receipt','transfer','count','issue'));
ALTER TABLE b2b_network_orders DROP CONSTRAINT b2b_network_orders_state_check;
ALTER TABLE b2b_network_orders ADD CHECK(state IN ('ordered','partial','received','cancelled'));
ALTER TABLE b2b_network_orders ADD COLUMN cancel_request jsonb,ADD COLUMN cancelled_at timestamptz;
CREATE TABLE b2b_network_returns (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,supplier_tenant_id uuid NOT NULL,source_return_id uuid NOT NULL,
 client_key uuid NOT NULL,fingerprint text NOT NULL,input jsonb NOT NULL,source_number text NOT NULL,
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','dispatched','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),dispatch_document_id uuid,dispatch_request jsonb,cancel_request jsonb,
 actor_id uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),dispatched_at timestamptz,cancelled_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id,id),UNIQUE(tenant_id,order_id,client_key),UNIQUE(supplier_tenant_id,source_return_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES b2b_network_orders(tenant_id,id),
 FOREIGN KEY(supplier_tenant_id,source_return_id) REFERENCES return_cases(tenant_id,id),
 FOREIGN KEY(tenant_id,dispatch_document_id) REFERENCES warehouse_documents(tenant_id,id)
);
CREATE INDEX b2b_network_return_page ON b2b_network_returns(tenant_id,order_id,id);
CREATE TABLE b2b_network_return_lines (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,product_id uuid NOT NULL,source_item_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),recovered integer NOT NULL DEFAULT 0 CHECK(recovered>=0 AND recovered<=quantity),
 PRIMARY KEY(tenant_id,return_id,product_id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES b2b_network_returns(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id,product_id) REFERENCES b2b_network_order_lines(tenant_id,order_id,product_id)
);
CREATE INDEX b2b_network_return_line_committed ON b2b_network_return_lines(tenant_id,order_id,product_id,return_id);
CREATE TABLE b2b_network_return_recoveries (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,return_id uuid NOT NULL,document_id uuid NOT NULL,client_key uuid NOT NULL,fingerprint text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,return_id,id),UNIQUE(tenant_id,return_id,client_key),UNIQUE(tenant_id,document_id),
 FOREIGN KEY(tenant_id,return_id) REFERENCES b2b_network_returns(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES warehouse_documents(tenant_id,id)
);
CREATE TABLE b2b_network_return_recovery_lines (
 tenant_id uuid NOT NULL,return_id uuid NOT NULL,recovery_id uuid NOT NULL,product_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),location text NOT NULL,
 PRIMARY KEY(tenant_id,recovery_id,product_id),
 FOREIGN KEY(tenant_id,return_id,recovery_id) REFERENCES b2b_network_return_recoveries(tenant_id,return_id,id),
 FOREIGN KEY(tenant_id,return_id,product_id) REFERENCES b2b_network_return_lines(tenant_id,return_id,product_id)
);
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['b2b_network_returns','b2b_network_return_lines','b2b_network_return_recoveries','b2b_network_return_recovery_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
-- The supplier can inspect only the dispatch fact for its own RMA. No buyer rows
-- or membership data are exposed. Source order locking serializes acceptance
-- with network dispatch; no opposite-side row lock is taken by this predicate.
CREATE FUNCTION b2b_network_return_dispatched(rid uuid) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.state='dispatched' AND r.dispatch_document_id IS NOT NULL AND d.status='posted' AND d.kind='issue'
 FROM public.b2b_network_returns r LEFT JOIN public.warehouse_documents d ON(d.tenant_id,d.id)=(r.tenant_id,r.dispatch_document_id)
 WHERE r.supplier_tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND r.source_return_id=rid
 $$;
REVOKE ALL ON FUNCTION b2b_network_return_dispatched(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_network_return_dispatched(uuid) TO dyna_app;
