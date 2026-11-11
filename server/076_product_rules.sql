CREATE TABLE product_rules (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL,event text NOT NULL CHECK(event IN ('product.created','product.updated')),
 enabled boolean NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),definition jsonb NOT NULL,approved_by uuid NOT NULL REFERENCES users,approved_at timestamptz,
 client_key uuid NOT NULL,request_hash text NOT NULL,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),CHECK(jsonb_typeof(definition)='object'),CHECK(NOT enabled OR (approved_at IS NOT NULL AND deleted_at IS NULL)),
 CHECK(definition->>'name'=name AND definition->>'event'=event AND (definition->>'enabled')::boolean=enabled)
);
CREATE INDEX product_rules_enabled ON product_rules(tenant_id,event,id) WHERE enabled;
CREATE TABLE product_rule_revisions (
 tenant_id uuid NOT NULL,rule_id uuid NOT NULL,version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users,definition jsonb NOT NULL,deleted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,rule_id,version),FOREIGN KEY(tenant_id,rule_id) REFERENCES product_rules(tenant_id,id)
);
CREATE TABLE product_rule_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,event text NOT NULL CHECK(event IN ('product.created','product.updated')),
 origin text NOT NULL CHECK(origin IN ('manual','catalog')),cause_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,rules jsonb NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','done','failed')),consent jsonb,queued_actor uuid REFERENCES users,job_id uuid,queued_at timestamptz,finished_at timestamptz,error text,result jsonb NOT NULL DEFAULT '{}',
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 CHECK(jsonb_typeof(rules)='array' AND jsonb_array_length(rules) BETWEEN 1 AND 100),CHECK(origin<>'catalog' OR cause_id IS NOT NULL),
 CHECK(state='preview' OR (job_id IS NOT NULL AND consent IS NOT NULL AND queued_at IS NOT NULL)),CHECK(state NOT IN ('done','failed') OR finished_at IS NOT NULL)
);
CREATE INDEX product_rule_history ON product_rule_runs(tenant_id,created_at DESC,id DESC);
CREATE INDEX product_rule_pending ON product_rule_runs(tenant_id,id) WHERE state='queued';
CREATE UNIQUE INDEX product_rule_cause ON product_rule_runs(tenant_id,cause_id) WHERE origin='catalog';
CREATE TABLE product_rule_items (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 0 AND 99),product_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),source_hash text NOT NULL,source jsonb NOT NULL,projected jsonb NOT NULL,matched_rules jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','changed','skipped','failed')),result_version integer,error text,finished_at timestamptz,
 PRIMARY KEY(tenant_id,run_id,position),UNIQUE(tenant_id,run_id,product_id),FOREIGN KEY(tenant_id,run_id) REFERENCES product_rule_runs(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK(jsonb_typeof(source)='object' AND jsonb_typeof(projected)='object' AND jsonb_typeof(matched_rules)='array'),CHECK(state='pending' OR finished_at IS NOT NULL)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['product_rules','product_rule_revisions','product_rule_runs','product_rule_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
END LOOP;END $$;
GRANT UPDATE ON product_rules,product_rule_runs,product_rule_items TO dyna_app;
CREATE FUNCTION product_rule_revision_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Product rule revision is immutable';END $$;
CREATE TRIGGER product_rule_revision_immutable BEFORE UPDATE OR DELETE ON product_rule_revisions FOR EACH ROW EXECUTE FUNCTION product_rule_revision_immutable();
CREATE FUNCTION product_rule_definition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.client_key,NEW.request_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.client_key,OLD.request_hash,OLD.created_at)
 OR NEW.version<>OLD.version+1 OR OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Product rule requires next version and preserves identity';END IF;RETURN NEW;END $$;
CREATE TRIGGER product_rule_definition_guard BEFORE UPDATE ON product_rules FOR EACH ROW EXECUTE FUNCTION product_rule_definition_guard();
CREATE FUNCTION product_rule_run_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.actor_id,NEW.event,NEW.origin,NEW.cause_id,NEW.client_key,NEW.request_hash,NEW.scope_hash,NEW.rules,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.actor_id,OLD.event,OLD.origin,OLD.cause_id,OLD.client_key,OLD.request_hash,OLD.scope_hash,OLD.rules,OLD.expires_at,OLD.created_at)
 OR (OLD.consent IS NOT NULL AND ROW(NEW.consent,NEW.queued_actor,NEW.job_id,NEW.queued_at) IS DISTINCT FROM ROW(OLD.consent,OLD.queued_actor,OLD.job_id,OLD.queued_at))
 OR (OLD.state IN ('done','failed') AND NEW IS DISTINCT FROM OLD) OR (OLD.state='queued' AND NEW.state='preview')
 THEN RAISE EXCEPTION 'Product rule run scope and terminal result are immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER product_rule_run_immutable BEFORE UPDATE ON product_rule_runs FOR EACH ROW EXECUTE FUNCTION product_rule_run_immutable();
CREATE FUNCTION product_rule_item_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.tenant_id,NEW.run_id,NEW.position,NEW.product_id,NEW.source_version,NEW.source_hash,NEW.source,NEW.projected,NEW.matched_rules)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.run_id,OLD.position,OLD.product_id,OLD.source_version,OLD.source_hash,OLD.source,OLD.projected,OLD.matched_rules)
 OR (OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD)
 THEN RAISE EXCEPTION 'Product rule item scope and receipt are immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER product_rule_item_immutable BEFORE UPDATE ON product_rule_items FOR EACH ROW EXECUTE FUNCTION product_rule_item_immutable();
-- Indexed, immutable per-product event identity. Group consent is evidence, not
-- a history-wide JSON search index on every catalogue mutation.
CREATE TABLE product_rule_causes (
 tenant_id uuid NOT NULL,cause_id uuid NOT NULL,run_id uuid NOT NULL,product_id uuid NOT NULL,
 event text NOT NULL CHECK(event IN ('product.created','product.updated')),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,cause_id),
 FOREIGN KEY(tenant_id,run_id,product_id) REFERENCES product_rule_items(tenant_id,run_id,product_id)
);
CREATE INDEX product_rule_causes_run ON product_rule_causes(tenant_id,run_id);
ALTER TABLE product_rule_causes ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_rule_causes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON product_rule_causes TO dyna_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON product_rule_causes TO dyna_app;
CREATE FUNCTION product_rule_cause_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Product source event identity is immutable';END IF;
 SELECT event,origin,state,consent INTO r FROM product_rule_runs WHERE (tenant_id,id)=(NEW.tenant_id,NEW.run_id);
 IF r.origin IS DISTINCT FROM 'catalog' OR r.state IS DISTINCT FROM 'queued' OR r.event IS DISTINCT FROM NEW.event
 OR NOT coalesce((r.consent->'source_events') @> jsonb_build_array(jsonb_build_object('cause_id',NEW.cause_id,'product_id',NEW.product_id,'event',NEW.event)),false)
 THEN RAISE EXCEPTION 'Product cause must match frozen automatic consent';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER product_rule_cause_guard BEFORE INSERT OR UPDATE OR DELETE ON product_rule_causes FOR EACH ROW EXECUTE FUNCTION product_rule_cause_guard();
