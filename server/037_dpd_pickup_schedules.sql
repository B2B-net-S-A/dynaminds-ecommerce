CREATE TABLE dpd_pickup_schedules (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,
 definition jsonb NOT NULL,connection_hash text NOT NULL,next_at timestamptz,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE INDEX dpd_pickup_schedule_due ON dpd_pickup_schedules(next_at,channel_id) WHERE enabled;
CREATE TABLE dpd_pickup_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,version integer NOT NULL,
 scheduled_for timestamptz NOT NULL,state text NOT NULL CHECK(state IN ('queued','empty','missed')),
 count integer NOT NULL DEFAULT 0,collection_ids uuid[] NOT NULL DEFAULT '{}',remaining integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel_id,scheduled_for),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES dpd_pickup_schedules(tenant_id,channel_id)
);
CREATE INDEX dpd_pickup_run_history ON dpd_pickup_runs(tenant_id,channel_id,created_at DESC,id DESC);
ALTER TABLE dpd_collections ADD COLUMN schedule_run_id uuid,ADD COLUMN schedule_version integer;
ALTER TABLE dpd_collections ADD FOREIGN KEY(tenant_id,schedule_run_id) REFERENCES dpd_pickup_runs(tenant_id,id);
ALTER TABLE dpd_collections ADD CHECK((schedule_run_id IS NULL)=(schedule_version IS NULL));
CREATE INDEX dpd_scheduled_collection ON dpd_collections(tenant_id,channel_id) WHERE schedule_run_id IS NOT NULL AND state='queued';
CREATE INDEX dpd_pickup_ready ON shipping_plans(tenant_id,channel_id,created_at,id) WHERE state='ready' AND input->>'provider'='dpd';
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['dpd_pickup_schedules','dpd_pickup_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
