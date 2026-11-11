CREATE TABLE order_status_configs (
 tenant_id uuid NOT NULL,channel_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 external_authorized boolean NOT NULL DEFAULT false,connection_hash text NOT NULL,
 next_run_at timestamptz,last_run_at timestamptz,last_job_id uuid REFERENCES jobs,error text,
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,channel_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE TABLE order_status_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,channel_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,local_version bigint NOT NULL,local_status text NOT NULL,target text NOT NULL,
 connection_hash text NOT NULL,remote jsonb NOT NULL,state text NOT NULL DEFAULT 'preview'
 CHECK(state IN ('preview','queued','done','conflict','failed','cancelled')),
 phase text NOT NULL DEFAULT 'ready' CHECK(phase IN ('ready','write_started','verify','done')),
 config_version integer,job_id uuid REFERENCES jobs,result jsonb,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE INDEX order_status_history ON order_status_plans(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX order_status_revision_cache ON order_status_plans(tenant_id,order_id,local_version,config_version) WHERE config_version IS NOT NULL AND state<>'preview';
CREATE INDEX order_status_channel_page ON order_status_plans(tenant_id,channel_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX order_status_one_active ON order_status_plans(tenant_id,order_id)
 WHERE state='queued' OR (state='failed' AND phase IN ('write_started','verify'));
CREATE INDEX order_status_due ON order_status_configs(next_run_at,channel_id) WHERE enabled;
CREATE INDEX order_status_orders_page ON orders(tenant_id,channel_id,id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_one_status_scan ON jobs(tenant_id,(payload->>'channel_id'))
 WHERE kind='order.status.scan' AND state IN ('pending','running');
-- Simulation persists remote status independently of the OMS; never calls an external API.
CREATE TABLE order_status_simulations (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,status text NOT NULL,revision integer NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['order_status_configs','order_status_plans','order_status_simulations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP;END $$;
