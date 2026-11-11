CREATE TABLE shopify_oauth_states (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users,
 session_hash text NOT NULL CHECK(session_hash ~ '^[a-f0-9]{64}$'),state_hash text UNIQUE NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 account_hash text NOT NULL CHECK(account_hash ~ '^[a-f0-9]{64}$'),verifier text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','exchanging','failed','done','cancelled')),
 expires_at timestamptz NOT NULL,exchange_started_at timestamptz,consumed_at timestamptz,error text,
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE UNIQUE INDEX shopify_oauth_active_channel ON shopify_oauth_states(tenant_id,channel_id) WHERE state IN ('pending','exchanging','failed');
CREATE INDEX shopify_oauth_session ON shopify_oauth_states(tenant_id,user_id,session_hash,expires_at) WHERE state='pending';
CREATE TABLE shopify_account_bindings (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,store_url text NOT NULL,shop_id text NOT NULL,client_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('sandbox','live')),source text NOT NULL CHECK(source IN ('graphql','simulation')),
 grant_id uuid NOT NULL,grant_hash text NOT NULL CHECK(grant_hash ~ '^[a-f0-9]{64}$'),scopes text[] NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['shopify_oauth_states','shopify_account_bindings'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',t);
END LOOP;END $$;
CREATE FUNCTION shopify_account_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (NEW.tenant_id,NEW.channel_id,NEW.store_url,NEW.shop_id,NEW.client_id,NEW.mode,NEW.source,NEW.created_at)
 IS DISTINCT FROM (OLD.tenant_id,OLD.channel_id,OLD.store_url,OLD.shop_id,OLD.client_id,OLD.mode,OLD.source,OLD.created_at) THEN RAISE EXCEPTION 'Shopify account binding is immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER shopify_account_immutable BEFORE UPDATE ON shopify_account_bindings FOR EACH ROW EXECUTE FUNCTION shopify_account_immutable();
CREATE FUNCTION shopify_oauth_state_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.channel_id,NEW.user_id,NEW.session_hash,NEW.state_hash,NEW.account_hash,NEW.verifier,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.channel_id,OLD.user_id,OLD.session_hash,OLD.state_hash,OLD.account_hash,OLD.verifier,OLD.expires_at,OLD.created_at) THEN RAISE EXCEPTION 'Shopify OAuth state is immutable';END IF;
 IF OLD.exchange_started_at IS NOT NULL AND NEW.exchange_started_at IS DISTINCT FROM OLD.exchange_started_at THEN RAISE EXCEPTION 'Shopify OAuth exchange cannot be reset';END IF;RETURN NEW;END $$;
CREATE TRIGGER shopify_oauth_state_immutable BEFORE UPDATE ON shopify_oauth_states FOR EACH ROW EXECUTE FUNCTION shopify_oauth_state_immutable();
CREATE TABLE shopify_oauth_scopes (
 account_hash text PRIMARY KEY CHECK(account_hash ~ '^[a-f0-9]{64}$'),tenant_id uuid NOT NULL REFERENCES tenants,
 channel_id uuid NOT NULL REFERENCES channels(id),created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON shopify_oauth_scopes FROM PUBLIC,dyna_app;
CREATE FUNCTION shopify_oauth_claim(p_state uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE s public.shopify_oauth_states;BEGIN
 SELECT * INTO s FROM public.shopify_oauth_states WHERE id=p_state AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF s.id IS NULL THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('shopify-oauth-claim:'||s.account_hash,0));
 INSERT INTO public.shopify_oauth_scopes(account_hash,tenant_id,channel_id) VALUES(s.account_hash,s.tenant_id,s.channel_id) ON CONFLICT DO NOTHING;
 RETURN EXISTS(SELECT 1 FROM public.shopify_oauth_scopes WHERE account_hash=s.account_hash AND tenant_id=s.tenant_id AND channel_id=s.channel_id);
END $$;
CREATE FUNCTION shopify_oauth_release(p_channel uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DELETE FROM public.shopify_oauth_scopes s WHERE s.channel_id=p_channel AND s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND NOT EXISTS(SELECT 1 FROM public.shopify_account_bindings b WHERE b.channel_id=p_channel)
 AND NOT EXISTS(SELECT 1 FROM public.shopify_oauth_states o WHERE o.channel_id=p_channel AND (o.exchange_started_at IS NOT NULL OR o.state IN ('pending','exchanging')))
$$;
REVOKE ALL ON FUNCTION shopify_oauth_claim(uuid),shopify_oauth_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_oauth_claim(uuid),shopify_oauth_release(uuid) TO dyna_app;
