CREATE TABLE supplier_schedules (
 tenant_id uuid NOT NULL,source_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,
 interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 30 AND 10080),
 page_size integer NOT NULL CHECK(page_size BETWEEN 1 AND 10000),taxonomy text,
 connection_hash text NOT NULL,next_at timestamptz,last_bulk_id uuid,last_finished_at timestamptz,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,source_id),FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,last_bulk_id) REFERENCES supplier_bulk_runs(tenant_id,id)
);
CREATE INDEX supplier_schedule_due ON supplier_schedules(next_at,source_id) WHERE enabled;
ALTER TABLE supplier_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON supplier_schedules TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON supplier_schedules TO dyna_app;
ALTER TABLE supplier_bulk_runs ADD COLUMN schedule_version integer CHECK(schedule_version>0);
