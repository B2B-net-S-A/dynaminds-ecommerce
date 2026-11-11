CREATE TABLE shopify_webhook_configs (
 tenant_id uuid NOT NULL,channel_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 connection_hash text NOT NULL CHECK(connection_hash~'^[a-f0-9]{64}$'),signing_secret text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE TABLE shopify_webhook_deliveries (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,delivery_id uuid NOT NULL,event_id uuid,
 topic text NOT NULL CHECK(topic IN ('orders/create','orders/updated','orders/paid','orders/cancelled','orders/fulfilled','refunds/create')),
 api_version text NOT NULL CHECK(api_version='2026-10'),shop_domain text NOT NULL,
 order_gid text NOT NULL CHECK(order_gid~'^gid://shopify/Order/[1-9][0-9]{0,19}$'),
 body_hash text NOT NULL CHECK(body_hash~'^[a-f0-9]{64}$'),connection_hash text NOT NULL CHECK(connection_hash~'^[a-f0-9]{64}$'),
 config_version integer NOT NULL CHECK(config_version>0),job_id uuid NOT NULL,triggered_at text,
 outcome text NOT NULL DEFAULT 'queued' CHECK(outcome IN ('queued','processed','stopped','failed')),
 result jsonb NOT NULL DEFAULT '{}',received_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,
 UNIQUE(tenant_id,channel_id,delivery_id),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX shopify_webhook_history ON shopify_webhook_deliveries(tenant_id,channel_id,received_at DESC,id);
CREATE INDEX shopify_webhook_event ON shopify_webhook_deliveries(tenant_id,channel_id,event_id) WHERE event_id IS NOT NULL;
CREATE INDEX shopify_webhook_queue ON jobs(tenant_id,(payload->>'channel_id')) WHERE kind='shopify.webhook' AND state IN ('pending','running');
CREATE TABLE shopify_webhook_simulations (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,order_gid text NOT NULL,raw jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(order_gid~'^gid://shopify/Order/[1-9][0-9]{0,19}$'),CHECK(raw->>'id'=order_gid),
 PRIMARY KEY(tenant_id,channel_id,order_gid),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['shopify_webhook_configs','shopify_webhook_deliveries','shopify_webhook_simulations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',t);
END LOOP;END $$;
CREATE FUNCTION shopify_webhook_receipt_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.channel_id,NEW.delivery_id,NEW.event_id,NEW.topic,NEW.api_version,NEW.shop_domain,NEW.order_gid,NEW.body_hash,NEW.connection_hash,NEW.config_version,NEW.job_id,NEW.triggered_at,NEW.received_at)
 IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.channel_id,OLD.delivery_id,OLD.event_id,OLD.topic,OLD.api_version,OLD.shop_domain,OLD.order_gid,OLD.body_hash,OLD.connection_hash,OLD.config_version,OLD.job_id,OLD.triggered_at,OLD.received_at) THEN RAISE EXCEPTION 'Shopify webhook receipt is immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER shopify_webhook_receipt_immutable BEFORE UPDATE ON shopify_webhook_deliveries FOR EACH ROW EXECUTE FUNCTION shopify_webhook_receipt_immutable();
