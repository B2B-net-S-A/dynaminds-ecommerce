CREATE TABLE deepl_catalog_batches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid NOT NULL REFERENCES users(id),channel_id uuid NOT NULL,
 client_key uuid NOT NULL,request_hash text NOT NULL,connection_hash text NOT NULL,source_lang text NOT NULL,target_langs jsonb NOT NULL,formality text NOT NULL,
 product_count integer NOT NULL CHECK(product_count BETWEEN 1 AND 500),draft_count integer NOT NULL CHECK(draft_count BETWEEN 1 AND 3000),characters integer NOT NULL CHECK(characters BETWEEN 1 AND 30600000),simulation boolean NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','queued','finished','expired','cancelled')),
 error text,approved_characters integer,queued_at timestamptz,finished_at timestamptz,last_dispatch_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),preview_until timestamptz NOT NULL DEFAULT now()+interval '30 minutes',expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE INDEX deepl_batch_history ON deepl_catalog_batches(tenant_id,created_at DESC,id DESC);
CREATE INDEX deepl_batch_active ON deepl_catalog_batches(state,last_dispatch_at,created_at,id) WHERE state IN ('prepared','queued');
ALTER TABLE deepl_catalog_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE deepl_catalog_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON deepl_catalog_batches TO dyna_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON deepl_catalog_batches TO dyna_app;
CREATE FUNCTION deepl_batch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.actor_id,NEW.channel_id,NEW.client_key,NEW.request_hash,NEW.connection_hash,NEW.source_lang,NEW.target_langs,NEW.formality,NEW.product_count,NEW.draft_count,NEW.characters,NEW.simulation,NEW.created_at,NEW.preview_until,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.actor_id,OLD.channel_id,OLD.client_key,OLD.request_hash,OLD.connection_hash,OLD.source_lang,OLD.target_langs,OLD.formality,OLD.product_count,OLD.draft_count,OLD.characters,OLD.simulation,OLD.created_at,OLD.preview_until,OLD.expires_at)
 OR (OLD.approved_characters IS NOT NULL AND NEW.approved_characters IS DISTINCT FROM OLD.approved_characters)
 OR (OLD.queued_at IS NOT NULL AND NEW.queued_at IS DISTINCT FROM OLD.queued_at) THEN RAISE EXCEPTION 'DeepL batch scope is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER deepl_batch_immutable BEFORE UPDATE ON deepl_catalog_batches FOR EACH ROW EXECUTE FUNCTION deepl_batch_immutable();
ALTER TABLE deepl_catalog_drafts ADD COLUMN batch_id uuid;
ALTER TABLE deepl_catalog_drafts ADD COLUMN batch_ordinal integer;
ALTER TABLE deepl_catalog_drafts ADD COLUMN batch_sku text;
ALTER TABLE deepl_catalog_drafts ADD FOREIGN KEY(tenant_id,batch_id) REFERENCES deepl_catalog_batches(tenant_id,id);
ALTER TABLE deepl_catalog_drafts ADD CHECK ((batch_id IS NULL AND batch_ordinal IS NULL AND batch_sku IS NULL) OR (batch_id IS NOT NULL AND batch_ordinal IS NOT NULL AND batch_ordinal BETWEEN 0 AND 2999 AND batch_sku IS NOT NULL));
CREATE UNIQUE INDEX deepl_batch_ordinal ON deepl_catalog_drafts(tenant_id,batch_id,batch_ordinal) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX deepl_batch_product_locale ON deepl_catalog_drafts(tenant_id,batch_id,product_id,target_lang) WHERE batch_id IS NOT NULL;
CREATE INDEX deepl_batch_waiting ON deepl_catalog_drafts(tenant_id,batch_id,batch_ordinal) WHERE batch_id IS NOT NULL AND state='prepared';
CREATE INDEX deepl_draft_job ON deepl_catalog_drafts(tenant_id,job_id) WHERE job_id IS NOT NULL;
CREATE OR REPLACE FUNCTION deepl_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.product_id,NEW.channel_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.connection_hash,NEW.source_version,NEW.source,NEW.source_lang,NEW.target_lang,NEW.formality,NEW.characters,NEW.simulation,NEW.created_at,NEW.expires_at,NEW.batch_id,NEW.batch_ordinal,NEW.batch_sku)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.product_id,OLD.channel_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.connection_hash,OLD.source_version,OLD.source,OLD.source_lang,OLD.target_lang,OLD.formality,OLD.characters,OLD.simulation,OLD.created_at,OLD.expires_at,OLD.batch_id,OLD.batch_ordinal,OLD.batch_sku)
 OR (OLD.output IS NOT NULL AND (NEW.output IS DISTINCT FROM OLD.output OR NEW.usage IS DISTINCT FROM OLD.usage)) OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id)
 OR (OLD.state='applied' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'DeepL source and result are immutable'; END IF;
 RETURN NEW; END $$;

-- Operational state shared by firms holding the same API key; owner-only, never exposed by API.
CREATE TABLE deepl_key_cooldowns (key_hash text PRIMARY KEY CHECK(length(key_hash)=64),retry_until timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON deepl_key_cooldowns FROM PUBLIC,dyna_app;
CREATE INDEX deepl_bulk_jobs_due ON jobs(run_at,created_at,id) WHERE kind='catalog.deepl.batch' AND state='pending';
