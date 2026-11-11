CREATE TABLE automation_schedules (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 name text NOT NULL,enabled boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1,definition_version bigint NOT NULL DEFAULT 1,
 definition jsonb NOT NULL,next_at timestamptz,error text,client_key uuid NOT NULL,creation_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key)
);
CREATE INDEX automation_schedules_due ON automation_schedules(next_at,id) WHERE enabled;
CREATE TABLE automation_schedule_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,schedule_id uuid NOT NULL,schedule_version bigint NOT NULL,definition_version bigint NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,definition jsonb NOT NULL,scheduled_for timestamptz NOT NULL,
 as_of timestamptz NOT NULL DEFAULT now(),job_id uuid NOT NULL,client_key uuid NOT NULL,request_hash text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','cancelled','failed')),
 cursor_at timestamptz,cursor_id uuid,scanned integer NOT NULL DEFAULT 0,done integer NOT NULL DEFAULT 0,
 skipped integer NOT NULL DEFAULT 0,failed integer NOT NULL DEFAULT 0,error text,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,id,schedule_id,schedule_version),UNIQUE(tenant_id,id,schedule_id,definition_version),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES automation_schedules(tenant_id,id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 CHECK(scanned=done+skipped+failed)
);
CREATE UNIQUE INDEX automation_schedule_active ON automation_schedule_runs(tenant_id,schedule_id) WHERE state='queued';
CREATE INDEX automation_schedule_runs_page ON automation_schedule_runs(tenant_id,schedule_id,created_at DESC,id DESC);
CREATE TABLE automation_schedule_items (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,schedule_id uuid NOT NULL,schedule_version bigint NOT NULL,order_id uuid NOT NULL,
 number text NOT NULL,snapshot jsonb NOT NULL,state text NOT NULL CHECK(state IN ('done','skipped','failed')),
 result jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id,order_id),
 FOREIGN KEY(tenant_id,run_id,schedule_id,schedule_version) REFERENCES automation_schedule_runs(tenant_id,id,schedule_id,schedule_version),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE TABLE automation_schedule_receipts (
 tenant_id uuid NOT NULL,schedule_id uuid NOT NULL,definition_version bigint NOT NULL,order_id uuid NOT NULL,run_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,schedule_id,definition_version,order_id),
 FOREIGN KEY(tenant_id,run_id,order_id) REFERENCES automation_schedule_items(tenant_id,run_id,order_id),
 FOREIGN KEY(tenant_id,run_id,schedule_id,definition_version) REFERENCES automation_schedule_runs(tenant_id,id,schedule_id,definition_version)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['automation_schedules','automation_schedule_runs','automation_schedule_items','automation_schedule_receipts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',tbl);
END LOOP; END $$;
GRANT UPDATE ON automation_schedules,automation_schedule_runs TO dyna_app;
CREATE FUNCTION automation_next_at(frequency jsonb,after_at timestamptz) RETURNS timestamptz
 LANGUAGE plpgsql STABLE AS $$ DECLARE local_date date; candidate timestamptz; day_offset integer; BEGIN
 IF frequency->>'kind'='interval' THEN RETURN after_at+make_interval(secs=>(frequency->>'seconds')::integer); END IF;
 local_date=(after_at AT TIME ZONE (frequency->>'timezone'))::date;
 FOR day_offset IN 0..7 LOOP
  IF frequency->'weekdays' @> to_jsonb(extract(isodow FROM local_date+day_offset)::integer) THEN
   candidate=((local_date+day_offset)+(frequency->>'time')::time) AT TIME ZONE (frequency->>'timezone');
   IF candidate>after_at THEN RETURN candidate; END IF;
  END IF;
 END LOOP;
 RAISE EXCEPTION 'Nieprawidłowy harmonogram';
END $$;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check1;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK(cardinality(scopes)>=1 AND cardinality(scopes)<=12);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check1 CHECK(scopes <@ ARRAY['orders:read','orders:write','products:read','products:write','inventory:read','inventory:write','documents:read','documents:write','purchasing:read','purchasing:write','automations:read','automations:write']::text[]);
