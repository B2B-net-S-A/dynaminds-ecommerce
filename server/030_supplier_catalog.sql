CREATE TABLE supplier_sources (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,channel_id uuid NOT NULL,supplier_id uuid NOT NULL,
 language text NOT NULL CHECK(language ~ '^[a-z]{2}$'),currency text NOT NULL CHECK(currency IN ('PLN','EUR','USD','GBP','CZK')),
 max_handling_days integer NOT NULL CHECK(max_handling_days BETWEEN 0 AND 365),paused boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id)
);
CREATE TABLE supplier_catalog_reads (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,input_hash text NOT NULL,
 remote_product_id text NOT NULL,remote_variant_id text NOT NULL DEFAULT '',connection_hash text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','success','failed','cancelled')),
 phase integer NOT NULL DEFAULT 0,parts jsonb NOT NULL DEFAULT '{}',job_id uuid REFERENCES jobs,error text,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,client_key),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id)
);
CREATE UNIQUE INDEX supplier_catalog_read_active ON supplier_catalog_reads(tenant_id,source_id,remote_product_id,remote_variant_id) WHERE state='queued';
CREATE INDEX supplier_catalog_reads_recent ON supplier_catalog_reads(tenant_id,source_id,created_at DESC,id DESC);
CREATE TABLE supplier_catalog_items (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,remote_product_id text NOT NULL,remote_variant_id text NOT NULL DEFAULT '',
 sku text NOT NULL,name text NOT NULL,snapshot jsonb NOT NULL,read_id uuid NOT NULL,product_id uuid,version integer NOT NULL DEFAULT 1,
 refreshed_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,remote_product_id,remote_variant_id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,read_id) REFERENCES supplier_catalog_reads(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX supplier_catalog_page ON supplier_catalog_items(tenant_id,source_id,id);
CREATE TABLE supplier_catalog_purchases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,client_key uuid NOT NULL,input_hash text NOT NULL,purchase_id uuid NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,source_id,client_key),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,purchase_id) REFERENCES purchase_orders(tenant_id,id)
);
-- Global service-only gate shares the supplier's token budget across organizations/channels.
CREATE TABLE supplier_api_limits (key text PRIMARY KEY,next_at timestamptz NOT NULL);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['supplier_sources','supplier_catalog_reads','supplier_catalog_items','supplier_catalog_purchases'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
