CREATE TABLE suppliers (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL,code text NOT NULL,
 contact_name text NOT NULL DEFAULT '',email text NOT NULL DEFAULT '',phone text NOT NULL DEFAULT '',
 address text NOT NULL DEFAULT '',tax_id text NOT NULL DEFAULT '',country text NOT NULL DEFAULT 'PL',
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check1;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK(cardinality(scopes) BETWEEN 1 AND 10);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check1 CHECK(scopes <@ ARRAY['orders:read','orders:write','products:read','products:write','inventory:read','inventory:write','documents:read','documents:write','purchasing:read','purchasing:write']::text[]);
CREATE UNIQUE INDEX suppliers_code ON suppliers(tenant_id,lower(code));
CREATE INDEX suppliers_page ON suppliers(tenant_id,created_at DESC,id DESC);
CREATE TABLE purchase_orders (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,number text NOT NULL,supplier_id uuid NOT NULL,warehouse_id uuid NOT NULL,
 currency text NOT NULL CHECK(currency IN ('PLN','EUR','USD','GBP','CZK')),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','ordered','partial','received','closed','cancelled')),
 supplier_snapshot jsonb NOT NULL,reference text NOT NULL DEFAULT '',note text NOT NULL DEFAULT '',expected_date date,
 close_reason text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,number),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE INDEX purchase_orders_page ON purchase_orders(tenant_id,created_at DESC,id DESC);
CREATE INDEX purchase_orders_state ON purchase_orders(tenant_id,state,created_at DESC,id DESC);
CREATE TABLE purchase_order_lines (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,product_id uuid NOT NULL,sku text NOT NULL,name text NOT NULL,supplier_sku text NOT NULL DEFAULT '',
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),received_quantity integer NOT NULL DEFAULT 0 CHECK(received_quantity>=0),
 closed_quantity integer NOT NULL DEFAULT 0 CHECK(closed_quantity>=0),unit_cost integer NOT NULL CHECK(unit_cost BETWEEN 0 AND 1000000000),
 PRIMARY KEY(tenant_id,order_id,product_id),CHECK(received_quantity+closed_quantity<=quantity),
 FOREIGN KEY(tenant_id,order_id) REFERENCES purchase_orders(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE purchase_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,document_id uuid NOT NULL,client_key uuid NOT NULL,input_hash text NOT NULL,
 reference text NOT NULL DEFAULT '',note text NOT NULL DEFAULT '',created_by uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id,order_id),UNIQUE(tenant_id,order_id,client_key),UNIQUE(tenant_id,document_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES purchase_orders(tenant_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES warehouse_documents(tenant_id,id)
);
CREATE INDEX purchase_receipts_order ON purchase_receipts(tenant_id,order_id,created_at DESC,id DESC);
CREATE TABLE purchase_receipt_lines (
 tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,order_id uuid NOT NULL,product_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),location text NOT NULL,
 PRIMARY KEY(tenant_id,receipt_id,product_id),
 FOREIGN KEY(tenant_id,receipt_id,order_id) REFERENCES purchase_receipts(tenant_id,id,order_id),
 FOREIGN KEY(tenant_id,order_id,product_id) REFERENCES purchase_order_lines(tenant_id,order_id,product_id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['suppliers','purchase_orders','purchase_order_lines','purchase_receipts','purchase_receipt_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
