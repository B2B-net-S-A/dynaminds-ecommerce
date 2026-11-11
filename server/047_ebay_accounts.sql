CREATE TABLE ebay_account_bindings (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,
 account_hash text NOT NULL CHECK(account_hash ~ '^[a-f0-9]{64}$'),
 username text CHECK(length(username)<=160),mode text NOT NULL CHECK(mode IN ('sandbox','live')),
 source text NOT NULL CHECK(source IN ('trading','simulation')),
 actor_id uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
ALTER TABLE ebay_account_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ebay_account_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON ebay_account_bindings TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON ebay_account_bindings TO dyna_app;
-- A bound channel keeps its account for its lifetime. New credentials cannot move its history.
CREATE FUNCTION ebay_account_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.tenant_id,OLD.channel_id,OLD.account_hash,OLD.mode,OLD.source,OLD.created_at)
 IS DISTINCT FROM (NEW.tenant_id,NEW.channel_id,NEW.account_hash,NEW.mode,NEW.source,NEW.created_at)
 THEN RAISE EXCEPTION 'eBay account binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ebay_account_binding_immutable BEFORE UPDATE ON ebay_account_bindings
 FOR EACH ROW EXECUTE FUNCTION ebay_account_binding_immutable();
