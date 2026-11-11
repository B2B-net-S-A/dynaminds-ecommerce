ALTER TABLE stock ADD COLUMN version bigint NOT NULL DEFAULT 0;
CREATE FUNCTION bump_stock_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version := OLD.version + 1; RETURN NEW; END $$;
CREATE TRIGGER stock_version BEFORE UPDATE ON stock FOR EACH ROW EXECUTE FUNCTION bump_stock_version();
CREATE TABLE warehouse_documents (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,number text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('receipt','transfer','count')),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
 warehouse_id uuid NOT NULL,destination_id uuid,reference text NOT NULL DEFAULT '',note text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),posted_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,number),
 CHECK((kind='transfer')=(destination_id IS NOT NULL)),CHECK(destination_id IS NULL OR destination_id<>warehouse_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,destination_id) REFERENCES warehouses(tenant_id,id)
);
CREATE INDEX warehouse_documents_page ON warehouse_documents(tenant_id,created_at DESC,id DESC);
CREATE INDEX warehouse_documents_filter ON warehouse_documents(tenant_id,kind,status,created_at DESC,id DESC);
CREATE TABLE warehouse_document_lines (
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,product_id uuid NOT NULL,sku text NOT NULL,name text NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 0 AND 1000000),expected_on_hand integer NOT NULL,
 expected_reserved integer NOT NULL,expected_version bigint,location text NOT NULL DEFAULT 'A-01',
 PRIMARY KEY(tenant_id,document_id,product_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES warehouse_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
ALTER TABLE stock_movements ADD COLUMN warehouse_document_id uuid;
ALTER TABLE stock_movements ADD FOREIGN KEY(tenant_id,warehouse_document_id) REFERENCES warehouse_documents(tenant_id,id);
CREATE INDEX movements_warehouse_document ON stock_movements(tenant_id,warehouse_document_id) WHERE warehouse_document_id IS NOT NULL;
CREATE INDEX movements_tenant_date ON stock_movements(tenant_id,created_at DESC,id DESC);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['warehouse_documents','warehouse_document_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
