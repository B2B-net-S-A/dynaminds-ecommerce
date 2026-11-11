ALTER TABLE repricing_rules ADD COLUMN config_version integer NOT NULL DEFAULT 1 CHECK(config_version>0);
CREATE TABLE repricing_schedules (
 tenant_id uuid NOT NULL,price_list_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 rule_config_version integer NOT NULL CHECK(rule_config_version>0),
 interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 5 AND 10080),
 batch_size integer NOT NULL CHECK(batch_size BETWEEN 1 AND 200),
 next_at timestamptz,last_run_id uuid,error text,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,price_list_id),FOREIGN KEY(tenant_id,price_list_id) REFERENCES repricing_rules(tenant_id,price_list_id)
);
CREATE INDEX repricing_schedule_due ON repricing_schedules(next_at,price_list_id) WHERE enabled;
CREATE TABLE repricing_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,price_list_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,job_id uuid NOT NULL,schedule_version integer NOT NULL,rule_version integer NOT NULL,
 initial_list_version integer NOT NULL,expected_list_version integer NOT NULL,batch_size integer NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','success','failed','partial','cancelled')),
 upper_id uuid,cursor uuid,total integer NOT NULL,scanned integer NOT NULL DEFAULT 0,changed integer NOT NULL DEFAULT 0,
 unchanged integer NOT NULL DEFAULT 0,blocked integer NOT NULL DEFAULT 0,skipped integer NOT NULL DEFAULT 0,
 error text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES repricing_schedules(tenant_id,price_list_id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 CHECK(batch_size BETWEEN 1 AND 200),CHECK(total>=0 AND scanned>=0 AND changed>=0 AND unchanged>=0 AND blocked>=0 AND skipped>=0)
);
CREATE UNIQUE INDEX repricing_one_run ON repricing_runs(tenant_id,price_list_id) WHERE state='queued';
CREATE INDEX repricing_runs_page ON repricing_runs(tenant_id,price_list_id,id);
ALTER TABLE repricing_schedules ADD FOREIGN KEY(tenant_id,last_run_id) REFERENCES repricing_runs(tenant_id,id);
ALTER TABLE repricing_previews ADD COLUMN schedule_run_id uuid;
ALTER TABLE repricing_previews ADD FOREIGN KEY(tenant_id,schedule_run_id) REFERENCES repricing_runs(tenant_id,id);
CREATE INDEX repricing_run_previews ON repricing_previews(tenant_id,schedule_run_id,id) WHERE schedule_run_id IS NOT NULL;
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['repricing_schedules','repricing_runs'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
