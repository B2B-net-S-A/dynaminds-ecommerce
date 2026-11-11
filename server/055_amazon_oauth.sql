ALTER TABLE channels ADD COLUMN amazon_oauth_attempt uuid;
CREATE TABLE amazon_account_bindings (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,
 seller_hash text NOT NULL CHECK(seller_hash ~ '^[a-f0-9]{64}$'),
 grant_hash text NOT NULL CHECK(grant_hash ~ '^[a-f0-9]{64}$'),
 mode text NOT NULL CHECK(mode IN ('sandbox','live')),region text NOT NULL CHECK(region IN ('eu','na','fe')),
 source text NOT NULL CHECK(source IN ('oauth_callback','simulation')),
 actor_id uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),authorized_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
ALTER TABLE amazon_account_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_account_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON amazon_account_bindings TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON amazon_account_bindings TO dyna_app;
CREATE FUNCTION amazon_account_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.tenant_id,OLD.channel_id,OLD.seller_hash,OLD.mode,OLD.region,OLD.source,OLD.created_at)
 IS DISTINCT FROM (NEW.tenant_id,NEW.channel_id,NEW.seller_hash,NEW.mode,NEW.region,NEW.source,NEW.created_at)
 THEN RAISE EXCEPTION 'Amazon account binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER amazon_account_binding_immutable BEFORE UPDATE ON amazon_account_bindings FOR EACH ROW EXECUTE FUNCTION amazon_account_binding_immutable();
CREATE TABLE amazon_oauth_states (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users,
 session_hash text NOT NULL CHECK(session_hash ~ '^[a-f0-9]{64}$'),state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 verifier text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE INDEX amazon_oauth_session ON amazon_oauth_states(tenant_id,user_id,session_hash,expires_at) WHERE consumed_at IS NULL;
ALTER TABLE amazon_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON amazon_oauth_states TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON amazon_oauth_states TO dyna_app;
