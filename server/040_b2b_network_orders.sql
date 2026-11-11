CREATE TABLE b2b_network_quotes (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,link_id uuid NOT NULL,client_key uuid NOT NULL,fingerprint text NOT NULL,
 supplier_tenant_id uuid NOT NULL,source_quote_id uuid NOT NULL,link_version integer NOT NULL,
 warehouse_id uuid NOT NULL,input jsonb NOT NULL,summary jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,link_id,client_key),
 FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(supplier_tenant_id,source_quote_id) REFERENCES b2b_quotes(tenant_id,id)
);
CREATE TABLE b2b_network_orders (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,link_id uuid NOT NULL,quote_id uuid NOT NULL,supplier_tenant_id uuid NOT NULL,
 source_order_id uuid NOT NULL,account_id uuid NOT NULL,warehouse_id uuid NOT NULL,source_number text NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),total_gross integer NOT NULL CHECK(total_gross>=0),shipping_gross integer NOT NULL CHECK(shipping_gross>=0),
 state text NOT NULL DEFAULT 'ordered' CHECK(state IN ('ordered','partial','received')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,quote_id),UNIQUE(supplier_tenant_id,source_order_id),
 FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),
 FOREIGN KEY(tenant_id,quote_id) REFERENCES b2b_network_quotes(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(supplier_tenant_id,source_order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(supplier_tenant_id,account_id) REFERENCES b2b_accounts(tenant_id,id)
);
CREATE INDEX b2b_network_orders_page ON b2b_network_orders(tenant_id,link_id,id);
CREATE TABLE b2b_network_order_lines (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,product_id uuid NOT NULL,source_product_id uuid NOT NULL,
 sku text NOT NULL,name text NOT NULL,vat numeric NOT NULL,unit_gross integer NOT NULL CHECK(unit_gross>=0),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),received integer NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=quantity),
 PRIMARY KEY(tenant_id,order_id,product_id),UNIQUE(tenant_id,order_id,source_product_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES b2b_network_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE b2b_network_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,document_id uuid NOT NULL,client_key uuid NOT NULL,fingerprint text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,order_id,id),UNIQUE(tenant_id,order_id,client_key),UNIQUE(tenant_id,document_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES b2b_network_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES warehouse_documents(tenant_id,id)
);
CREATE TABLE b2b_network_receipt_lines (
 tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,order_id uuid NOT NULL,product_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),location text NOT NULL,
 PRIMARY KEY(tenant_id,receipt_id,product_id),
 FOREIGN KEY(tenant_id,order_id,receipt_id) REFERENCES b2b_network_receipts(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,order_id,product_id) REFERENCES b2b_network_order_lines(tenant_id,order_id,product_id)
);
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['b2b_network_quotes','b2b_network_orders','b2b_network_order_lines','b2b_network_receipts','b2b_network_receipt_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
