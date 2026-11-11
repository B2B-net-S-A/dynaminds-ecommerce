CREATE TABLE shopify_translation_batches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,channel_id uuid NOT NULL,
 client_key uuid NOT NULL,request_hash text NOT NULL,local_locale text NOT NULL,target_locale text NOT NULL,fields jsonb NOT NULL,
 state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','preview','queued','cancelled')),
 consent jsonb,queued_actor uuid REFERENCES users,queued_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 CHECK(jsonb_typeof(fields)='array' AND jsonb_array_length(fields) BETWEEN 1 AND 2),
 CHECK(state<>'queued' OR (consent IS NOT NULL AND queued_actor IS NOT NULL AND queued_at IS NOT NULL))
);
CREATE INDEX shopify_translation_batch_history ON shopify_translation_batches(tenant_id,created_at DESC,id DESC);
CREATE TABLE shopify_translation_batch_items (
 tenant_id uuid NOT NULL,batch_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 99),product_id uuid NOT NULL,listing_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),translation_version integer NOT NULL CHECK(translation_version>0),sku text NOT NULL,name text NOT NULL,client_key uuid NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed','cancelled')),plan_id uuid,error text,
 PRIMARY KEY(tenant_id,batch_id,position),UNIQUE(tenant_id,batch_id,product_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,plan_id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES shopify_translation_batches(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,listing_id) REFERENCES listings(tenant_id,id),FOREIGN KEY(tenant_id,plan_id) REFERENCES shopify_translation_plans(tenant_id,id),
 CHECK((state='ready')=(plan_id IS NOT NULL)),CHECK(state<>'failed' OR error IS NOT NULL)
);
CREATE INDEX shopify_translation_batch_plan ON shopify_translation_batch_items(tenant_id,plan_id) WHERE plan_id IS NOT NULL;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['shopify_translation_batches','shopify_translation_batch_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',t);
END LOOP;END $$;
CREATE FUNCTION shopify_translation_batch_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.actor_id,NEW.channel_id,NEW.client_key,NEW.request_hash,NEW.local_locale,NEW.target_locale,NEW.fields,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.actor_id,OLD.channel_id,OLD.client_key,OLD.request_hash,OLD.local_locale,OLD.target_locale,OLD.fields,OLD.expires_at,OLD.created_at)
 OR (OLD.consent IS NOT NULL AND ROW(NEW.consent,NEW.queued_actor,NEW.queued_at) IS DISTINCT FROM ROW(OLD.consent,OLD.queued_actor,OLD.queued_at))
 OR (OLD.state='cancelled' AND NEW IS DISTINCT FROM OLD)
 OR (OLD.state='queued' AND NEW.state NOT IN ('queued','cancelled'))
 OR (OLD.state='preview' AND NEW.state='building')
 THEN RAISE EXCEPTION 'Shopify translation batch scope and consent are immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER shopify_translation_batch_immutable BEFORE UPDATE ON shopify_translation_batches FOR EACH ROW EXECUTE FUNCTION shopify_translation_batch_immutable();
CREATE FUNCTION shopify_translation_batch_item_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.tenant_id,NEW.batch_id,NEW.position,NEW.product_id,NEW.listing_id,NEW.version,NEW.translation_version,NEW.sku,NEW.name,NEW.client_key)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.batch_id,OLD.position,OLD.product_id,OLD.listing_id,OLD.version,OLD.translation_version,OLD.sku,OLD.name,OLD.client_key)
 OR (OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'Shopify translation batch item scope and preview are immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER shopify_translation_batch_item_immutable BEFORE UPDATE ON shopify_translation_batch_items FOR EACH ROW EXECUTE FUNCTION shopify_translation_batch_item_immutable();
