CREATE TABLE source_payment_configs (
 tenant_id uuid NOT NULL,channel_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 60 AND 86400),
 version integer NOT NULL DEFAULT 1,connection_hash text NOT NULL,external_authorized boolean NOT NULL DEFAULT false,
 cursor uuid,next_at timestamptz NOT NULL DEFAULT now(),error text,updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE INDEX source_payment_due ON source_payment_configs(next_at,channel_id) WHERE enabled;
CREATE TABLE source_payment_checks (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,channel_id uuid NOT NULL,job_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('review','applied','unchanged','blocked')),
 source_amount integer CHECK(source_amount>=0),previous_amount integer NOT NULL CHECK(previous_amount>=0),
 delta integer,currency text NOT NULL,basis text NOT NULL,reason text,order_version bigint NOT NULL,
 connection_hash text NOT NULL,source_hash text NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),applied_at timestamptz,last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),seen_count integer NOT NULL DEFAULT 1 CHECK(seen_count>0),
 UNIQUE(tenant_id,job_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX source_payment_history ON source_payment_checks(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX source_payment_channel_history ON source_payment_checks(tenant_id,channel_id,created_at DESC,id DESC);
CREATE INDEX source_payment_order_scan ON orders(tenant_id,channel_id,id) INCLUDE(created_at) WHERE payment_mode='prepaid' AND source_snapshot IS NOT NULL AND external_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_one_source_payment ON jobs(tenant_id,(payload->>'order_id')) WHERE kind='payment.source.read' AND state IN ('pending','running');
CREATE INDEX jobs_source_payment_history ON jobs(tenant_id,(payload->>'order_id'),created_at DESC,id DESC) WHERE kind='payment.source.read';
CREATE INDEX jobs_source_payment_channel ON jobs(tenant_id,(payload->>'channel_id')) WHERE kind='payment.source.read' AND state IN ('pending','running');
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['source_payment_configs','source_payment_checks'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',t);
 END LOOP;
END $$;
