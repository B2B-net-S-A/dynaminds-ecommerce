-- Local PIM imports keep normalized evidence, never the uploaded raw document.
CREATE TABLE catalog_file_import_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
 source text NOT NULL CHECK(source IN ('manual','api')),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object' AND NOT config ? 'content'),
 rules_snapshot jsonb NOT NULL CHECK(jsonb_typeof(rules_snapshot)='array' AND jsonb_array_length(rules_snapshot)<=100),
 related_snapshot jsonb NOT NULL CHECK(jsonb_typeof(related_snapshot)='object'),
 total integer NOT NULL CHECK(total>=1 AND total<=500),created integer NOT NULL CHECK(created>=0),updated integer NOT NULL CHECK(updated>=0),unchanged integer NOT NULL CHECK(unchanged>=0),invalid integer NOT NULL CHECK(invalid>=0),ready boolean NOT NULL,
 byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),CHECK(created+updated+unchanged+invalid=total),CHECK(ready=(invalid=0))
);
CREATE INDEX catalog_file_import_preview_history ON catalog_file_import_previews(tenant_id,created_at DESC,id DESC);
CREATE TABLE catalog_file_import_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index>=0 AND index<=499),product_id uuid NOT NULL,resolved_product_id uuid,
 operation text NOT NULL CHECK(operation IN ('create','update','unchanged','invalid')),identity_value text,sku text,current_sku text,matched_historical_sku boolean NOT NULL,
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),before jsonb,after jsonb,
 changed_fields jsonb NOT NULL CHECK(jsonb_typeof(changed_fields)='array' AND jsonb_array_length(changed_fields)<=24),errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array'),
 byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),
 PRIMARY KEY(tenant_id,preview_id,index),UNIQUE(tenant_id,preview_id,index,product_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES catalog_file_import_previews(tenant_id,id),FOREIGN KEY(tenant_id,resolved_product_id) REFERENCES products(tenant_id,id),
 CHECK(resolved_product_id IS NULL OR resolved_product_id=product_id),
 CHECK(before IS NULL OR jsonb_typeof(before)='object'),CHECK(after IS NULL OR jsonb_typeof(after)='object'),
 CHECK(operation='invalid' OR (after IS NOT NULL AND jsonb_array_length(errors)=0)),
 CHECK(operation NOT IN ('update','unchanged') OR (resolved_product_id IS NOT NULL AND before IS NOT NULL)),
 CHECK(operation<>'create' OR (resolved_product_id IS NULL AND before IS NULL)),
 CHECK(operation<>'unchanged' OR jsonb_array_length(changed_fields)=0)
);
CREATE TABLE catalog_file_import_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),state text NOT NULL DEFAULT 'done' CHECK(state='done'),
 total integer NOT NULL CHECK(total>=1 AND total<=500),created integer NOT NULL CHECK(created>=0),updated integer NOT NULL CHECK(updated>=0),unchanged integer NOT NULL CHECK(unchanged>=0),
 byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES catalog_file_import_previews(tenant_id,id),CHECK(created+updated+unchanged=total)
);
CREATE INDEX catalog_file_import_execution_history ON catalog_file_import_executions(tenant_id,created_at DESC,id DESC);
CREATE TABLE catalog_file_import_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index>=0 AND index<=499),product_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('create','update','unchanged')),identity_value text,sku text,current_sku text,matched_historical_sku boolean NOT NULL,
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),before jsonb,after jsonb NOT NULL CHECK(jsonb_typeof(after)='object'),
 changed_fields jsonb NOT NULL CHECK(jsonb_typeof(changed_fields)='array' AND jsonb_array_length(changed_fields)<=24),errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array' AND jsonb_array_length(errors)=0),
 before_version integer CHECK(before_version>0),after_version integer NOT NULL CHECK(after_version>0),byte_count bigint NOT NULL DEFAULT 0 CHECK(byte_count>0),
 PRIMARY KEY(tenant_id,execution_id,index),UNIQUE(tenant_id,execution_id,product_id),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES catalog_file_import_executions(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,index,product_id) REFERENCES catalog_file_import_rows(tenant_id,preview_id,index,product_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK((operation='create' AND before IS NULL AND before_version IS NULL AND after_version=1)
 OR (operation='update' AND before IS NOT NULL AND before_version IS NOT NULL AND after_version::bigint=before_version::bigint+1)
 OR (operation='unchanged' AND before IS NOT NULL AND before_version IS NOT NULL AND after_version=before_version))
);

CREATE FUNCTION catalog_file_import_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Catalog file import evidence is immutable' USING ERRCODE='23514';END $$;
CREATE FUNCTION catalog_file_import_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE n bigint;BEGIN
 -- PostgreSQL serialization is the byte oracle; callers cannot understate it.
 LOOP n:=octet_length(to_jsonb(NEW)::text);EXIT WHEN NEW.byte_count=n;NEW.byte_count:=n;END LOOP;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION catalog_file_import_immutable(),catalog_file_import_bytes() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['catalog_file_import_previews','catalog_file_import_rows','catalog_file_import_executions','catalog_file_import_execution_rows'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION catalog_file_import_immutable()',t);
 EXECUTE format('CREATE TRIGGER serialized_bytes BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION catalog_file_import_bytes()',t);
END LOOP;END $$;

CREATE FUNCTION catalog_file_import_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE p record;e record;r record;BEGIN
 SELECT * INTO p FROM public.catalog_file_import_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF p.id IS NULL THEN RETURN NEW;END IF; -- Missing/foreign parents are rejected by their genuine FK.
 IF TG_TABLE_NAME='catalog_file_import_rows' THEN
  IF NEW.index>=p.total THEN RAISE EXCEPTION 'Catalog import row outside frozen scope' USING ERRCODE='23514';END IF;
  IF NEW.resolved_product_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.products WHERE (tenant_id,id)=(NEW.tenant_id,NEW.resolved_product_id)) THEN RETURN NEW;END IF;
  IF NEW.operation<>'invalid' AND ((NEW.after->>'id')::uuid IS DISTINCT FROM NEW.product_id OR NEW.after->>'sku' IS DISTINCT FROM NEW.sku
   OR (NEW.operation='create' AND (NEW.after->>'version')::integer IS DISTINCT FROM 1)
   OR (NEW.operation IN ('update','unchanged') AND ((NEW.before->>'id')::uuid IS DISTINCT FROM NEW.product_id OR NEW.before->>'sku' IS DISTINCT FROM NEW.current_sku
    OR (NEW.before->>'version')::integer IS NULL OR (NEW.before->>'version')::integer<=0
    OR (NEW.after->>'version')::bigint IS DISTINCT FROM (NEW.before->>'version')::bigint+(CASE WHEN NEW.operation='update' THEN 1 ELSE 0 END))))
  THEN RAISE EXCEPTION 'Catalog import product snapshot differs from typed row' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='catalog_file_import_executions' THEN
  IF NOT p.ready OR ROW(NEW.actor_id,NEW.scope_hash,NEW.total,NEW.created,NEW.updated,NEW.unchanged) IS DISTINCT FROM ROW(p.actor_id,p.scope_hash,p.total,p.created,p.updated,p.unchanged)
  THEN RAISE EXCEPTION 'Catalog import execution differs from ready preview' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM public.catalog_file_import_executions WHERE (tenant_id,id,preview_id)=(NEW.tenant_id,NEW.execution_id,NEW.preview_id);
  SELECT * INTO r FROM public.catalog_file_import_rows WHERE (tenant_id,preview_id,index,product_id)=(NEW.tenant_id,NEW.preview_id,NEW.index,NEW.product_id);
  IF e.id IS NULL OR r.product_id IS NULL THEN RETURN NEW;END IF;
  IF ROW(NEW.operation,NEW.identity_value,NEW.sku,NEW.current_sku,NEW.matched_historical_sku,NEW.input,NEW.before,NEW.after,NEW.changed_fields,NEW.errors,NEW.before_version)
   IS DISTINCT FROM ROW(r.operation,r.identity_value,r.sku,r.current_sku,r.matched_historical_sku,r.input,r.before,r.after,r.changed_fields,r.errors,(r.before->>'version')::integer)
   OR NEW.after_version IS DISTINCT FROM (r.after->>'version')::integer
  THEN RAISE EXCEPTION 'Catalog import receipt differs from approved row' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION catalog_file_import_scope() FROM PUBLIC;
CREATE TRIGGER scope BEFORE INSERT ON catalog_file_import_rows FOR EACH ROW EXECUTE FUNCTION catalog_file_import_scope();
CREATE TRIGGER scope BEFORE INSERT ON catalog_file_import_executions FOR EACH ROW EXECUTE FUNCTION catalog_file_import_scope();
CREATE TRIGGER scope BEFORE INSERT ON catalog_file_import_execution_rows FOR EACH ROW EXECUTE FUNCTION catalog_file_import_scope();

-- One end-of-transaction scan per immutable head, rather than per imported row.
CREATE FUNCTION catalog_file_import_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE n integer;c integer;u integer;s integer;bad integer;BEGIN
 IF TG_TABLE_NAME='catalog_file_import_previews' THEN
  SELECT count(*),count(*) FILTER(WHERE operation='create'),count(*) FILTER(WHERE operation='update'),count(*) FILTER(WHERE operation='unchanged'),count(*) FILTER(WHERE operation='invalid') INTO n,c,u,s,bad
  FROM public.catalog_file_import_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id);
  IF ROW(n,c,u,s,bad) IS DISTINCT FROM ROW(NEW.total,NEW.created,NEW.updated,NEW.unchanged,NEW.invalid) THEN RAISE EXCEPTION 'Catalog import preview is incomplete' USING ERRCODE='23514';END IF;
  IF NEW.ready AND (SELECT count(DISTINCT product_id) FROM public.catalog_file_import_rows WHERE (tenant_id,preview_id)=(NEW.tenant_id,NEW.id))<>NEW.total THEN RAISE EXCEPTION 'Ready catalog import repeats a target product' USING ERRCODE='23514';END IF;
 ELSE
  SELECT count(*),count(*) FILTER(WHERE operation='create'),count(*) FILTER(WHERE operation='update'),count(*) FILTER(WHERE operation='unchanged') INTO n,c,u,s
  FROM public.catalog_file_import_execution_rows WHERE (tenant_id,execution_id)=(NEW.tenant_id,NEW.id);
  IF ROW(n,c,u,s) IS DISTINCT FROM ROW(NEW.total,NEW.created,NEW.updated,NEW.unchanged) THEN RAISE EXCEPTION 'Catalog import execution is incomplete' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION catalog_file_import_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON catalog_file_import_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_file_import_complete();
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON catalog_file_import_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_file_import_complete();

CREATE FUNCTION catalog_file_import_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE t uuid;n bigint;p uuid;BEGIN
 FOR t IN SELECT DISTINCT tenant_id FROM inserted ORDER BY tenant_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog.file.import:'||t::text,0));
  IF (SELECT count(*) FROM public.catalog_file_import_previews WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM public.catalog_file_import_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Catalog import history quota exceeded' USING ERRCODE='P0001';END IF;
  SELECT coalesce(sum(bytes),0) INTO n FROM (SELECT byte_count bytes FROM public.catalog_file_import_previews WHERE tenant_id=t UNION ALL SELECT byte_count FROM public.catalog_file_import_rows WHERE tenant_id=t UNION ALL SELECT byte_count FROM public.catalog_file_import_executions WHERE tenant_id=t UNION ALL SELECT byte_count FROM public.catalog_file_import_execution_rows WHERE tenant_id=t) all_bytes;
  IF n>134217728 THEN RAISE EXCEPTION 'Catalog import storage quota exceeded' USING ERRCODE='P0001';END IF;
  IF TG_TABLE_NAME IN ('catalog_file_import_previews','catalog_file_import_rows') THEN
   FOR p IN EXECUTE (CASE WHEN TG_TABLE_NAME='catalog_file_import_previews' THEN 'SELECT id FROM inserted WHERE tenant_id=$1' ELSE 'SELECT DISTINCT preview_id FROM inserted WHERE tenant_id=$1' END) USING t LOOP
    SELECT h.byte_count+coalesce(sum(r.byte_count),0) INTO n FROM public.catalog_file_import_previews h LEFT JOIN public.catalog_file_import_rows r ON (r.tenant_id,r.preview_id)=(h.tenant_id,h.id) WHERE (h.tenant_id,h.id)=(t,p) GROUP BY h.byte_count;
    IF n>8388608 THEN RAISE EXCEPTION 'Catalog import preview exceeds eight MiB' USING ERRCODE='P0001';END IF;
   END LOOP;
  END IF;
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION catalog_file_import_budget() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['catalog_file_import_previews','catalog_file_import_rows','catalog_file_import_executions','catalog_file_import_execution_rows'] LOOP
 EXECUTE format('CREATE TRIGGER budget AFTER INSERT ON %I REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION catalog_file_import_budget()',t);
END LOOP;END $$;
