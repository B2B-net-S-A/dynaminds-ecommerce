CREATE TABLE api_keys (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,user_id uuid NOT NULL REFERENCES users,
 name text NOT NULL,token_hash text UNIQUE NOT NULL,prefix text NOT NULL,scopes text[] NOT NULL,
 expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(scopes) BETWEEN 1 AND 8),
 CHECK(scopes <@ ARRAY['orders:read','orders:write','products:read','products:write','inventory:read','inventory:write','documents:read','documents:write']::text[]),
 UNIQUE(tenant_id,id)
);
CREATE INDEX api_keys_tenant ON api_keys(tenant_id,created_at DESC,id DESC);
CREATE TABLE outbound_subscriptions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 name text NOT NULL,mode text NOT NULL CHECK(mode IN ('local','https')),url text,
 secret text NOT NULL,events text[] NOT NULL,enabled boolean NOT NULL DEFAULT false,
 approved_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((mode='local' AND url IS NULL) OR (mode='https' AND url IS NOT NULL)),
 CHECK(cardinality(events) BETWEEN 1 AND 4),
 CHECK(events <@ ARRAY['order.created','order.status_changed','order.updated','item.scanned']::text[]),
 UNIQUE(tenant_id,id)
);
CREATE INDEX outbound_enabled ON outbound_subscriptions(tenant_id,id) WHERE enabled;
CREATE TABLE outbound_events (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,event_type text NOT NULL,
 payload jsonb NOT NULL,body text NOT NULL CHECK(octet_length(body)<=65536),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE outbound_deliveries (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,event_id uuid NOT NULL,subscription_id uuid NOT NULL,job_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','delivered','failed','cancelled')),
 response_status integer,error text,delivered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,event_id,subscription_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES outbound_events(tenant_id,id),
 FOREIGN KEY(tenant_id,subscription_id) REFERENCES outbound_subscriptions(tenant_id,id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX outbound_deliveries_page ON outbound_deliveries(tenant_id,created_at DESC,id DESC);
CREATE TABLE local_webhook_inbox (
 tenant_id uuid NOT NULL,delivery_id uuid NOT NULL,payload jsonb NOT NULL,body_hash text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,delivery_id),
 FOREIGN KEY(tenant_id,delivery_id) REFERENCES outbound_deliveries(tenant_id,id)
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON api_keys TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['outbound_subscriptions','outbound_events','outbound_deliveries','local_webhook_inbox'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
-- Removing or demoting a key/webhook owner must not reactivate old credentials if later reinvited.
CREATE FUNCTION revoke_developer_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (OLD.role='admin' AND NEW.role<>'admin') THEN
  UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id;
  UPDATE outbound_subscriptions SET enabled=false,revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=OLD.tenant_id AND actor_id=OLD.user_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER revoke_developer_access AFTER DELETE OR UPDATE OF role ON memberships FOR EACH ROW EXECUTE FUNCTION revoke_developer_access();
