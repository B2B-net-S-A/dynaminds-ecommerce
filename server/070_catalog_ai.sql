CREATE TABLE ai_catalog_drafts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),product_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),
 client_key uuid NOT NULL,request_hash text NOT NULL,source_version integer NOT NULL,source jsonb NOT NULL,
 destination text NOT NULL CHECK(destination IN ('catalog','translation')),locale text NOT NULL CHECK(locale IN ('pl','en','de','fr','es','cs')),
 model text NOT NULL,model_digest text NOT NULL CHECK(model_digest~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','ready','failed','conflict','cancelled','applied')),
 output jsonb,reviewed_text jsonb,usage jsonb,error text,job_id uuid NOT NULL,applied_version integer,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX ai_catalog_history ON ai_catalog_drafts(tenant_id,product_id,created_at DESC,id DESC);
CREATE INDEX ai_catalog_pending ON ai_catalog_drafts(tenant_id) WHERE state='queued';
ALTER TABLE ai_catalog_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_catalog_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON ai_catalog_drafts TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON ai_catalog_drafts TO dyna_app;
CREATE FUNCTION catalog_ai_pending_count() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT count(*) FROM public.ai_catalog_drafts WHERE state='queued' $$;
REVOKE ALL ON FUNCTION catalog_ai_pending_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_ai_pending_count() TO dyna_app;
CREATE FUNCTION ai_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.product_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.source_version,NEW.source,NEW.destination,NEW.locale,NEW.model,NEW.model_digest,NEW.job_id,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.product_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.source_version,OLD.source,OLD.destination,OLD.locale,OLD.model,OLD.model_digest,OLD.job_id,OLD.created_at,OLD.expires_at)
 OR (OLD.output IS NOT NULL AND NEW.output IS DISTINCT FROM OLD.output) OR (OLD.state='applied' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'AI source and generated output are immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER ai_catalog_immutable BEFORE UPDATE ON ai_catalog_drafts FOR EACH ROW EXECUTE FUNCTION ai_catalog_immutable();
CREATE TABLE product_translations (
 tenant_id uuid NOT NULL,product_id uuid NOT NULL,locale text NOT NULL CHECK(locale IN ('pl','en','de','fr','es','cs')),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 200),description text NOT NULL CHECK(length(description)<=10000),
 version integer NOT NULL DEFAULT 1,ai_draft_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,product_id,locale),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,ai_draft_id) REFERENCES ai_catalog_drafts(tenant_id,id)
);
ALTER TABLE product_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_translations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON product_translations TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON product_translations TO dyna_app;
