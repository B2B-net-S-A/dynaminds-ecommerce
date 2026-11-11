CREATE TABLE deepl_catalog_drafts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),product_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),
 client_key uuid NOT NULL,request_hash text NOT NULL,connection_hash text NOT NULL,source_version integer NOT NULL,source jsonb NOT NULL,
 source_lang text NOT NULL,target_lang text NOT NULL,formality text NOT NULL,characters integer NOT NULL CHECK(characters BETWEEN 1 AND 10200),simulation boolean NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','queued','ready','failed','uncertain','conflict','cancelled','applied')),
 output jsonb,reviewed_text jsonb,usage jsonb,error text,job_id uuid,attempted_at timestamptz,applied_version integer,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE INDEX deepl_catalog_history ON deepl_catalog_drafts(tenant_id,product_id,created_at DESC,id DESC);
CREATE INDEX deepl_catalog_pending ON deepl_catalog_drafts(tenant_id) WHERE state IN ('prepared','queued');
ALTER TABLE deepl_catalog_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deepl_catalog_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON deepl_catalog_drafts TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON deepl_catalog_drafts TO dyna_app;
CREATE FUNCTION deepl_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.product_id,NEW.channel_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.connection_hash,NEW.source_version,NEW.source,NEW.source_lang,NEW.target_lang,NEW.formality,NEW.characters,NEW.simulation,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.product_id,OLD.channel_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.connection_hash,OLD.source_version,OLD.source,OLD.source_lang,OLD.target_lang,OLD.formality,OLD.characters,OLD.simulation,OLD.created_at,OLD.expires_at)
 OR (OLD.output IS NOT NULL AND (NEW.output IS DISTINCT FROM OLD.output OR NEW.usage IS DISTINCT FROM OLD.usage)) OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id)
 OR (OLD.state='applied' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'DeepL source and result are immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER deepl_catalog_immutable BEFORE UPDATE ON deepl_catalog_drafts FOR EACH ROW EXECUTE FUNCTION deepl_catalog_immutable();
ALTER TABLE product_translations ALTER COLUMN ai_draft_id DROP NOT NULL;
ALTER TABLE product_translations ADD COLUMN deepl_draft_id uuid;
ALTER TABLE product_translations ADD FOREIGN KEY(tenant_id,deepl_draft_id) REFERENCES deepl_catalog_drafts(tenant_id,id);
ALTER TABLE product_translations ADD CHECK ((ai_draft_id IS NOT NULL) <> (deepl_draft_id IS NOT NULL));
ALTER TABLE product_translations DROP CONSTRAINT product_translations_locale_check;
ALTER TABLE product_translations ADD CHECK (locale ~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$' AND length(locale)<=40);
