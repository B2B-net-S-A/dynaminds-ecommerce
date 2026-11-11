CREATE TABLE supplier_bulk_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,input_hash text NOT NULL,connection_hash text NOT NULL,taxonomy text,page_size integer NOT NULL CHECK(page_size BETWEEN 1 AND 10000),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','success','failed','cancelled')),
 phase text NOT NULL DEFAULT 'fetch' CHECK(phase IN ('fetch','parents','variants','retire')),resource_index integer NOT NULL DEFAULT 0,
 cursors jsonb NOT NULL DEFAULT '{}',after_id text NOT NULL DEFAULT '',fetched_rows bigint NOT NULL DEFAULT 0,fetched_bytes bigint NOT NULL DEFAULT 0,
 published integer NOT NULL DEFAULT 0,skipped_newer integer NOT NULL DEFAULT 0,rejected integer NOT NULL DEFAULT 0,withdrawn integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1,job_id uuid REFERENCES jobs,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,client_key),FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id)
);
CREATE UNIQUE INDEX supplier_bulk_active ON supplier_bulk_runs(tenant_id,source_id) WHERE state='queued';
CREATE INDEX supplier_bulk_recent ON supplier_bulk_runs(tenant_id,source_id,created_at DESC,id DESC);
CREATE TABLE supplier_bulk_parts (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,resource text NOT NULL,remote_id text NOT NULL,parent_id text,payload jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,run_id,resource,remote_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES supplier_bulk_runs(tenant_id,id)
);
CREATE TABLE supplier_bulk_issues (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,run_id uuid NOT NULL,remote_product_id text NOT NULL,remote_variant_id text NOT NULL DEFAULT '',error text NOT NULL,
 UNIQUE(tenant_id,run_id,remote_product_id,remote_variant_id),FOREIGN KEY(tenant_id,run_id) REFERENCES supplier_bulk_runs(tenant_id,id)
);
CREATE INDEX supplier_bulk_variants_parent ON supplier_bulk_parts(tenant_id,run_id,resource,parent_id,remote_id);
CREATE INDEX supplier_bulk_issues_page ON supplier_bulk_issues(tenant_id,run_id,id);
ALTER TABLE supplier_catalog_items ALTER COLUMN read_id DROP NOT NULL;
ALTER TABLE supplier_catalog_items ADD COLUMN bulk_run_id uuid;
ALTER TABLE supplier_catalog_items ADD FOREIGN KEY(tenant_id,bulk_run_id) REFERENCES supplier_bulk_runs(tenant_id,id);
ALTER TABLE supplier_catalog_items ADD CHECK((read_id IS NOT NULL)::integer+(bulk_run_id IS NOT NULL)::integer=1);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['supplier_bulk_runs','supplier_bulk_parts','supplier_bulk_issues'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
