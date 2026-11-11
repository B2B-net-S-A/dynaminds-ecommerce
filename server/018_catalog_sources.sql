CREATE TABLE catalog_source_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 warehouse_id uuid NOT NULL,client_key uuid NOT NULL,input_hash text NOT NULL,connection_hash text NOT NULL,
 vat integer NOT NULL CHECK(vat IN(0,5,8,23)),import_stock boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','ready','failed','cancelled')),
 context jsonb,cursor jsonb NOT NULL DEFAULT '{"phase":"products","product_page":1}',
 fetched integer NOT NULL DEFAULT 0,job_id uuid REFERENCES jobs,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel_id,client_key),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE INDEX catalog_source_runs_channel ON catalog_source_runs(tenant_id,channel_id,created_at DESC,id DESC);
CREATE TABLE catalog_source_items (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,run_id uuid NOT NULL,external_id text NOT NULL,parent_external_id text,
 kind text NOT NULL CHECK(kind IN('simple','group','variant','unsupported')),
 source jsonb NOT NULL,source_hash text NOT NULL,issues jsonb NOT NULL DEFAULT '[]',
 captured_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'staged' CHECK(state IN('staged','applied')),
 product_id uuid,apply_hash text,result jsonb,applied_at timestamptz,
 UNIQUE(tenant_id,run_id,external_id),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES catalog_source_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX catalog_source_items_page ON catalog_source_items(tenant_id,run_id,id);
CREATE INDEX catalog_source_items_parent ON catalog_source_items(tenant_id,run_id,parent_external_id) WHERE parent_external_id IS NOT NULL;
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['catalog_source_runs','catalog_source_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
