ALTER TABLE channels ADD COLUMN token_expires_at timestamptz;
ALTER TABLE channels ADD COLUMN sync_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN sync_interval integer NOT NULL DEFAULT 300 CHECK(sync_interval BETWEEN 60 AND 86400);
ALTER TABLE channels ADD COLUMN sync_actor_id uuid REFERENCES users(id);
ALTER TABLE channels ADD COLUMN next_sync_at timestamptz;
ALTER TABLE channels ADD COLUMN last_sync_at timestamptz;
ALTER TABLE channels ADD COLUMN event_cursor text;
ALTER TABLE channels ADD COLUMN bootstrap_done boolean NOT NULL DEFAULT false;
CREATE INDEX channels_schedule ON channels(next_sync_at) WHERE sync_enabled;
ALTER TABLE jobs ADD COLUMN lease_token uuid;
CREATE UNIQUE INDEX jobs_one_channel_sync ON jobs(tenant_id,(payload->>'channel_id')) WHERE kind='orders.sync' AND state IN ('pending','running');
CREATE TABLE oauth_states (
 state_hash text PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users,
 verifier text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE TABLE webhook_deliveries (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,delivery_id text NOT NULL,
 body_hash text NOT NULL,topic text NOT NULL,payload jsonb NOT NULL,job_id uuid NOT NULL REFERENCES jobs,
 received_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,channel_id,delivery_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['oauth_states','webhook_deliveries'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
