-- SOURCE-ONLY core. Not registered, installed or accepted until normal wiring/Native QA.
-- Separate local read opt-in; native channel settings and sync_enabled remain unchanged.
CREATE TABLE local_woo_read_controls (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('orders.sync','catalog.fetch')),
 owner_id uuid NOT NULL REFERENCES users,fixture_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),
 enabled boolean NOT NULL DEFAULT false,interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 60 AND 86400),
 warehouse_id uuid NOT NULL,connection_hash text NOT NULL CHECK(connection_hash~'^[a-f0-9]{64}$'),
 next_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,channel_id,kind),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),CHECK(NOT enabled OR next_at IS NOT NULL)
);
CREATE INDEX local_woo_read_due ON local_woo_read_controls(next_at,tenant_id,channel_id,kind) WHERE enabled;
CREATE TABLE local_woo_read_commands (
 tenant_id uuid NOT NULL REFERENCES tenants,client_key uuid NOT NULL,channel_id uuid NOT NULL,kind text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,client_key),
 FOREIGN KEY(tenant_id,channel_id,kind) REFERENCES local_woo_read_controls(tenant_id,channel_id,kind)
);
CREATE TABLE local_woo_read_occurrences (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,kind text NOT NULL,control_version bigint NOT NULL CHECK(control_version>0),authorized_version bigint NOT NULL CHECK(authorized_version>0),
 owner_id uuid NOT NULL REFERENCES users,scheduled_for timestamptz NOT NULL,connection_hash text NOT NULL,
 job_id uuid NOT NULL,run_id uuid,state text NOT NULL CHECK(state IN('queued','running','done','blocked')),
 checkpoint_hash text NOT NULL CHECK(checkpoint_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,job_id),UNIQUE(tenant_id,channel_id,kind,control_version,scheduled_for),
 FOREIGN KEY(tenant_id,channel_id,kind) REFERENCES local_woo_read_controls(tenant_id,channel_id,kind),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES catalog_source_runs(tenant_id,id),
 CHECK((kind='catalog.fetch')=(run_id IS NOT NULL))
);
CREATE UNIQUE INDEX local_woo_read_one_active ON local_woo_read_occurrences(tenant_id,channel_id,kind) WHERE state<>'done';
CREATE INDEX local_woo_read_history ON local_woo_read_occurrences(tenant_id,channel_id,created_at DESC,id DESC);
CREATE TABLE local_woo_read_dispatches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,occurrence_id uuid NOT NULL,lease_token uuid NOT NULL,
 before_hash text NOT NULL CHECK(before_hash~'^[a-f0-9]{64}$'),after_hash text,
 state text NOT NULL CHECK(state IN('started','acknowledged')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),acknowledged_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,lease_token),FOREIGN KEY(tenant_id,occurrence_id) REFERENCES local_woo_read_occurrences(tenant_id,id),
 CHECK((state='acknowledged')=(after_hash IS NOT NULL AND acknowledged_at IS NOT NULL)),
 CHECK(after_hash IS NULL OR after_hash~'^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX local_woo_read_one_unresolved ON local_woo_read_dispatches(tenant_id,occurrence_id) WHERE state='started';
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['local_woo_read_controls','local_woo_read_commands','local_woo_read_occurrences','local_woo_read_dispatches'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
GRANT UPDATE ON local_woo_read_controls,local_woo_read_occurrences,local_woo_read_dispatches TO dyna_app;
