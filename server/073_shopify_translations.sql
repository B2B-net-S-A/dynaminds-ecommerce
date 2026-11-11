CREATE TABLE shopify_translation_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,channel_id uuid NOT NULL,product_id uuid NOT NULL,listing_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,request_hash text NOT NULL,
 connection_hash text NOT NULL,store_url text NOT NULL,shop_id text NOT NULL,remote_product_id text NOT NULL,remote_variant_id text NOT NULL,
 local_locale text NOT NULL,target_locale text NOT NULL,local_snapshot jsonb NOT NULL,remote_snapshot jsonb NOT NULL,spec jsonb NOT NULL,needs_replace boolean NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','done','failed','uncertain','cancelled','conflict','abandoned')),
 phase text NOT NULL DEFAULT 'fresh' CHECK(phase IN ('fresh','attempted','done')),attempted_at timestamptz,consent jsonb,queued_actor uuid REFERENCES users,queued_at timestamptz,job_id uuid,
 result jsonb NOT NULL DEFAULT '{}',error text,acknowledged_by uuid REFERENCES users,acknowledged_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,listing_id) REFERENCES listings(tenant_id,id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 CHECK(phase<>'attempted' OR attempted_at IS NOT NULL),CHECK(state<>'done' OR phase='done'),
 CHECK(state NOT IN ('uncertain','abandoned') OR phase='attempted'),CHECK(state<>'queued' OR (job_id IS NOT NULL AND consent IS NOT NULL AND queued_actor IS NOT NULL AND queued_at IS NOT NULL))
);
CREATE INDEX shopify_translation_history ON shopify_translation_plans(tenant_id,product_id,created_at DESC,id DESC);
CREATE INDEX shopify_translation_active ON shopify_translation_plans(tenant_id,created_at) WHERE state IN ('queued','uncertain');
CREATE INDEX shopify_translation_channel ON shopify_translation_plans(tenant_id,channel_id);
CREATE TABLE shopify_translation_observations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,plan_id uuid NOT NULL,data jsonb NOT NULL,source text NOT NULL CHECK(source IN ('graphql','local_simulation')),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES shopify_translation_plans(tenant_id,id)
);
CREATE INDEX shopify_translation_read_history ON shopify_translation_observations(tenant_id,plan_id,created_at DESC,id DESC);
CREATE TABLE shopify_translation_simulations (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,remote_product_id text NOT NULL,target_locale text NOT NULL,data jsonb NOT NULL,
 PRIMARY KEY(tenant_id,channel_id,remote_product_id,target_locale),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['shopify_translation_plans','shopify_translation_observations','shopify_translation_simulations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
END LOOP;END $$;
GRANT UPDATE ON shopify_translation_plans,shopify_translation_simulations TO dyna_app;
CREATE FUNCTION shopify_translation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.channel_id,NEW.product_id,NEW.listing_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.connection_hash,NEW.store_url,NEW.shop_id,NEW.remote_product_id,NEW.remote_variant_id,NEW.local_locale,NEW.target_locale,NEW.local_snapshot,NEW.remote_snapshot,NEW.spec,NEW.needs_replace,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.channel_id,OLD.product_id,OLD.listing_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.connection_hash,OLD.store_url,OLD.shop_id,OLD.remote_product_id,OLD.remote_variant_id,OLD.local_locale,OLD.target_locale,OLD.local_snapshot,OLD.remote_snapshot,OLD.spec,OLD.needs_replace,OLD.expires_at,OLD.created_at)
 OR (OLD.attempted_at IS NOT NULL AND (NEW.attempted_at IS DISTINCT FROM OLD.attempted_at OR NEW.phase='fresh'))
 OR (OLD.consent IS NOT NULL AND ROW(NEW.consent,NEW.queued_actor,NEW.queued_at,NEW.job_id) IS DISTINCT FROM ROW(OLD.consent,OLD.queued_actor,OLD.queued_at,OLD.job_id))
 OR (OLD.state IN ('done','cancelled','conflict','failed','abandoned') AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'Shopify translation scope and terminal evidence are immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER shopify_translation_immutable BEFORE UPDATE ON shopify_translation_plans FOR EACH ROW EXECUTE FUNCTION shopify_translation_immutable();
CREATE TABLE shopify_translation_claims (
 store_url text NOT NULL,shop_id text NOT NULL,remote_product_id text NOT NULL,target_locale text NOT NULL,plan_id uuid NOT NULL UNIQUE REFERENCES shopify_translation_plans,
 PRIMARY KEY(shop_id,remote_product_id,target_locale)
);
REVOKE ALL ON shopify_translation_claims FROM PUBLIC,dyna_app;
CREATE FUNCTION shopify_translation_claim(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE p public.shopify_translation_plans; BEGIN
 SELECT * INTO p FROM public.shopify_translation_plans WHERE id=p_id AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF p.id IS NULL OR p.phase<>'fresh' OR p.state NOT IN ('preview','queued') THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('shopify.translation.admission',0));
 IF (SELECT count(*) FROM public.shopify_translation_claims c JOIN public.shopify_translation_plans x ON x.id=c.plan_id WHERE x.tenant_id=p.tenant_id)>=100 AND NOT EXISTS(SELECT 1 FROM public.shopify_translation_claims WHERE plan_id=p.id) THEN RETURN false;END IF;
 IF (SELECT count(*) FROM public.shopify_translation_claims)>=500 AND NOT EXISTS(SELECT 1 FROM public.shopify_translation_claims WHERE plan_id=p.id) THEN RETURN false;END IF;
 INSERT INTO public.shopify_translation_claims(store_url,shop_id,remote_product_id,target_locale,plan_id) VALUES(p.store_url,p.shop_id,p.remote_product_id,p.target_locale,p.id) ON CONFLICT DO NOTHING;
 RETURN EXISTS(SELECT 1 FROM public.shopify_translation_claims WHERE plan_id=p.id);
END $$;
CREATE FUNCTION shopify_translation_claimed(p_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.shopify_translation_claims c JOIN public.shopify_translation_plans p ON p.id=c.plan_id WHERE p.id=p_id AND p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
$$;
CREATE FUNCTION shopify_translation_release(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DELETE FROM public.shopify_translation_claims c USING public.shopify_translation_plans p WHERE c.plan_id=p.id AND p.id=p_id AND p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 AND (p.state IN ('done','abandoned') OR (p.phase='fresh' AND p.state IN ('failed','conflict','cancelled')))
$$;
REVOKE ALL ON FUNCTION shopify_translation_claim(uuid),shopify_translation_claimed(uuid),shopify_translation_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_translation_claim(uuid),shopify_translation_claimed(uuid),shopify_translation_release(uuid) TO dyna_app;
