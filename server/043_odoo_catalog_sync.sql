CREATE TABLE odoo_catalog_schedules (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),enabled boolean NOT NULL DEFAULT false,
 interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 30 AND 10080),prices boolean NOT NULL DEFAULT false,
 connection_hash text NOT NULL,next_at timestamptz,last_run_id uuid,last_finished_at timestamptz,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE INDEX odoo_catalog_schedule_due ON odoo_catalog_schedules(next_at,channel_id) WHERE enabled;
CREATE TABLE odoo_catalog_sync_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 schedule_version integer NOT NULL,client_key uuid NOT NULL,input_hash text NOT NULL,connection_hash text NOT NULL,
 prices boolean NOT NULL,simulation boolean NOT NULL,state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','success','partial','failed','cancelled')),
 total integer NOT NULL DEFAULT 0 CHECK(total BETWEEN 0 AND 100000),applied integer NOT NULL DEFAULT 0,skipped integer NOT NULL DEFAULT 0,
 job_id uuid REFERENCES jobs,context jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel_id,client_key),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE UNIQUE INDEX odoo_catalog_run_active ON odoo_catalog_sync_runs(tenant_id,channel_id) WHERE state='queued';
CREATE INDEX odoo_catalog_run_history ON odoo_catalog_sync_runs(tenant_id,channel_id,created_at DESC,id DESC);
ALTER TABLE odoo_catalog_schedules ADD FOREIGN KEY(tenant_id,last_run_id) REFERENCES odoo_catalog_sync_runs(tenant_id,id);
CREATE TABLE odoo_catalog_sync_items (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,run_id uuid NOT NULL,listing_id uuid NOT NULL,product_id uuid NOT NULL,
 external_id text NOT NULL,product_version integer NOT NULL,vat integer NOT NULL,local_currency text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','applied','skipped')),result jsonb,error text,
 captured_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,run_id,listing_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES odoo_catalog_sync_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,listing_id) REFERENCES listings(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX odoo_catalog_item_pending ON odoo_catalog_sync_items(tenant_id,run_id,id) WHERE state='pending';
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['odoo_catalog_schedules','odoo_catalog_sync_runs','odoo_catalog_sync_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
