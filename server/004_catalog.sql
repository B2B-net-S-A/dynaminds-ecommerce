ALTER TABLE products ADD COLUMN kind text NOT NULL DEFAULT 'simple' CHECK(kind IN ('simple','group','variant','bundle'));
ALTER TABLE products ADD COLUMN parent_id uuid;
ALTER TABLE products ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(attributes)='object');
ALTER TABLE products ADD COLUMN images jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(images)='array');
ALTER TABLE products ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE products ADD FOREIGN KEY(tenant_id,parent_id) REFERENCES products(tenant_id,id);
ALTER TABLE products ADD CHECK((kind='variant')=(parent_id IS NOT NULL));
CREATE INDEX products_parent ON products(tenant_id,parent_id) WHERE parent_id IS NOT NULL;
CREATE TABLE bundle_components (
 tenant_id uuid NOT NULL,bundle_id uuid NOT NULL,product_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
 PRIMARY KEY(tenant_id,bundle_id,product_id),CHECK(bundle_id<>product_id),
 FOREIGN KEY(tenant_id,bundle_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX bundle_component_product ON bundle_components(tenant_id,product_id);
CREATE TABLE order_pick_items (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,product_id uuid NOT NULL,
 sku text NOT NULL,name text NOT NULL,ean text NOT NULL DEFAULT '',quantity integer NOT NULL CHECK(quantity>0),
 scanned integer NOT NULL DEFAULT 0 CHECK(scanned BETWEEN 0 AND quantity),UNIQUE(tenant_id,order_id,product_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
INSERT INTO order_pick_items(id,tenant_id,order_id,product_id,sku,name,ean,quantity,scanned)
 SELECT i.id,i.tenant_id,i.order_id,i.product_id,i.sku,i.name,coalesce(p.ean,''),i.quantity,i.scanned FROM order_items i JOIN products p ON p.id=i.product_id AND p.tenant_id=i.tenant_id;
ALTER TABLE order_items ADD COLUMN components jsonb NOT NULL DEFAULT '[]';
CREATE TABLE catalog_imports (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('preview','applied')),rows jsonb NOT NULL,observed jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE product_images (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,mime text NOT NULL,size integer NOT NULL CHECK(size BETWEEN 1 AND 524288),created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['bundle_components','order_pick_items','catalog_imports','product_images'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
