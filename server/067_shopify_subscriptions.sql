CREATE TABLE shopify_subscription_observations (
 tenant_id uuid NOT NULL,channel_id uuid PRIMARY KEY,connection_hash text NOT NULL CHECK(connection_hash~'^[a-f0-9]{64}$'),
 data jsonb NOT NULL,source text NOT NULL CHECK(source IN ('graphql','local_simulation')),observed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE TABLE shopify_subscription_simulations (
 tenant_id uuid NOT NULL,channel_id uuid PRIMARY KEY,data jsonb NOT NULL DEFAULT '[]',
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE TABLE shopify_subscription_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 connection_hash text NOT NULL CHECK(connection_hash~'^[a-f0-9]{64}$'),config_version integer NOT NULL CHECK(config_version>0),
 operation text NOT NULL CHECK(operation IN ('create','delete')),spec jsonb NOT NULL,snapshot jsonb NOT NULL,
 snapshot_hash text NOT NULL CHECK(snapshot_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','done','failed','uncertain','cancelled','conflict')),
 phase text NOT NULL DEFAULT 'fresh' CHECK(phase IN ('fresh','attempted','done')),attempted_at timestamptz,
 external_authorized boolean NOT NULL DEFAULT false,result jsonb NOT NULL DEFAULT '{}',error text,job_id uuid,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX shopify_subscription_history ON shopify_subscription_plans(tenant_id,channel_id,created_at DESC,id);
CREATE INDEX shopify_subscription_owned ON shopify_subscription_plans(tenant_id,channel_id,connection_hash,(result->>'remote_id')) WHERE operation='create' AND state='done';
CREATE UNIQUE INDEX shopify_subscription_active ON shopify_subscription_plans(tenant_id,channel_id) WHERE state IN ('queued','uncertain');
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['shopify_subscription_observations','shopify_subscription_simulations','shopify_subscription_plans'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',t);
END LOOP;END $$;
CREATE FUNCTION shopify_subscription_plan_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.channel_id,NEW.actor_id,NEW.connection_hash,NEW.config_version,NEW.operation,NEW.spec,NEW.snapshot,NEW.snapshot_hash,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.channel_id,OLD.actor_id,OLD.connection_hash,OLD.config_version,OLD.operation,OLD.spec,OLD.snapshot,OLD.snapshot_hash,OLD.expires_at,OLD.created_at) THEN RAISE EXCEPTION 'Shopify subscription plan is immutable';END IF;
 IF OLD.attempted_at IS NOT NULL AND (NEW.attempted_at IS DISTINCT FROM OLD.attempted_at OR NEW.phase='fresh') THEN RAISE EXCEPTION 'Shopify subscription attempt cannot be reset';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER shopify_subscription_plan_immutable BEFORE UPDATE ON shopify_subscription_plans FOR EACH ROW EXECUTE FUNCTION shopify_subscription_plan_immutable();
