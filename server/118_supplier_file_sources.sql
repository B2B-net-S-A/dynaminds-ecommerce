-- File availability is external supplier data. No physical inventory or sale price writer.
ALTER TABLE supplier_sources ADD COLUMN kind text NOT NULL DEFAULT 'bigbuy' CHECK(kind IN('bigbuy','file'));
ALTER TABLE supplier_sources ADD COLUMN name text NOT NULL DEFAULT '';
ALTER TABLE supplier_sources ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE supplier_sources ADD CHECK((kind='bigbuy' AND channel_id IS NOT NULL) OR(kind='file' AND channel_id IS NULL));
CREATE TABLE supplier_file_source_configs(
 tenant_id uuid NOT NULL,source_id uuid NOT NULL,config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
 PRIMARY KEY(tenant_id,source_id),FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id)
);
CREATE TABLE supplier_file_source_revisions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),version integer NOT NULL CHECK(version>0),
 payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,version),UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE supplier_file_previews(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL CHECK(source_version>0),
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),raw_hash text NOT NULL CHECK(raw_hash~'^[a-f0-9]{64}$'),
 raw_content text NOT NULL,raw_bytes integer NOT NULL CHECK(raw_bytes BETWEEN 1 AND 2097152),payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_id,client_key),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX supplier_file_previews_source ON supplier_file_previews(tenant_id,source_id,created_at DESC,id DESC);
CREATE TABLE supplier_file_preview_rows(
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 499),payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,preview_id,index),FOREIGN KEY(tenant_id,preview_id) REFERENCES supplier_file_previews(tenant_id,id)
);
CREATE TABLE supplier_file_runs(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,source_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),payload jsonb NOT NULL,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,source_id,client_key),
 FOREIGN KEY(tenant_id,source_id) REFERENCES supplier_sources(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES supplier_file_previews(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX supplier_file_runs_source ON supplier_file_runs(tenant_id,source_id,created_at DESC,id DESC);
CREATE TABLE supplier_file_run_rows(
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 10499),item_id uuid NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,run_id,index),UNIQUE(tenant_id,run_id,item_id),FOREIGN KEY(tenant_id,run_id) REFERENCES supplier_file_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,item_id) REFERENCES supplier_catalog_items(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE supplier_catalog_items ADD COLUMN file_run_id uuid;
ALTER TABLE supplier_catalog_items ADD FOREIGN KEY(tenant_id,file_run_id) REFERENCES supplier_file_runs(tenant_id,id);
DO $$DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='supplier_catalog_items'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%read_id%' AND pg_get_constraintdef(oid) LIKE '%bulk_run_id%' LOOP
  EXECUTE format('ALTER TABLE supplier_catalog_items DROP CONSTRAINT %I',c.conname);
 END LOOP;
END$$;
ALTER TABLE supplier_catalog_items ADD CHECK((read_id IS NOT NULL)::integer+(bulk_run_id IS NOT NULL)::integer+(file_run_id IS NOT NULL)::integer=1);
CREATE INDEX supplier_catalog_items_file_run ON supplier_catalog_items(tenant_id,file_run_id);
DO $$DECLARE tbl text;BEGIN
 FOREACH tbl IN ARRAY ARRAY['supplier_file_source_configs','supplier_file_source_revisions','supplier_file_previews','supplier_file_preview_rows','supplier_file_runs','supplier_file_run_rows'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
  EXECUTE format('GRANT SELECT ON %I TO dyna_app',tbl);
 END LOOP;
END$$;
-- Encrypted source is never readable by the application SQL role.
REVOKE SELECT ON supplier_file_previews FROM dyna_app;
GRANT SELECT(id,tenant_id,source_id,source_version,actor_id,api_key_id,client_key,request_hash,scope_hash,raw_hash,raw_bytes,payload,created_at) ON supplier_file_previews TO dyna_app;
CREATE FUNCTION supplier_file_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='118_supplier_file_sources')$$;
CREATE FUNCTION supplier_file_config_valid(cfg jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE field_name text;spec jsonb;BEGIN
 IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR cfg->>'format' NOT IN('csv','xml') OR cfg->>'delimiter' NOT IN(';',',',E'\t','|') OR jsonb_typeof(cfg->'fields') IS DISTINCT FROM 'object' OR NOT(cfg->'fields' ?& ARRAY['remote_id','name','cost_minor','quantity']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(cfg) k(key_name) WHERE k.key_name NOT IN('format','delimiter','record_path','fields')) THEN RETURN false;END IF;
 IF cfg->>'format'='xml' THEN IF coalesce(length(cfg->>'record_path'),0) NOT BETWEEN 2 AND 1024 OR left(cfg->>'record_path',1)<>'/' OR cfg->>'record_path' ~ '[\[\]*()|=]' OR cardinality(string_to_array(substr(cfg->>'record_path',2),'/'))>16 THEN RETURN false;END IF;
 ELSIF cfg ? 'record_path' THEN RETURN false;END IF;
 FOR field_name,spec IN SELECT key,value FROM jsonb_each(cfg->'fields') LOOP
  IF field_name NOT IN('remote_id','remote_variant_id','sku','name','ean','description','cost_minor','quantity','handling_days') OR jsonb_typeof(spec) IS DISTINCT FROM 'object' OR NOT(spec ?& ARRAY['path','value_type']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(spec) k(key_name) WHERE k.key_name NOT IN('path','value_type')) OR coalesce(length(spec->>'path'),0) NOT BETWEEN 1 AND 1024 THEN RETURN false;END IF;
  IF field_name='cost_minor' THEN IF spec->>'value_type' NOT IN('integer','decimal_money') THEN RETURN false;END IF;
  ELSIF field_name IN('quantity','handling_days') THEN IF spec->>'value_type' IS DISTINCT FROM 'integer' THEN RETURN false;END IF;
  ELSIF spec->>'value_type' IS DISTINCT FROM 'text' THEN RETURN false;END IF;
  IF cfg->>'format'='csv' AND(length(spec->>'path')>80 OR btrim(spec->>'path') IS DISTINCT FROM spec->>'path' OR spec->>'path' IN('__proto__','prototype','constructor')) THEN RETURN false;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_each(cfg->'fields') f GROUP BY CASE WHEN cfg->>'format'='csv' THEN lower(f.value->>'path') ELSE f.value->>'path' END HAVING count(*)>1) THEN RETURN false;END IF;
 RETURN true;
END$$;
CREATE FUNCTION supplier_file_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k api_keys%ROWTYPE;valid boolean:=true;rd boolean;wr boolean;BEGIN
 IF t IS NULL OR uid IS NULL THEN RETURN jsonb_build_object('role',null,'key_valid',false,'allowed',false,'can_write',false);END IF;
 IF pin THEN SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;ELSE SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid;END IF;
 rd:=coalesce(r IN('admin','operator','viewer'),false);wr:=coalesce(r='admin',false);
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND user_id=uid AND id=kid FOR SHARE;ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND user_id=uid AND id=kid;END IF;
  valid:=FOUND AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>clock_timestamp());
  rd:=rd AND valid AND coalesce(k.scopes @> ARRAY['purchasing:read']::text[],false);wr:=wr AND rd AND coalesce(k.scopes @> ARRAY['purchasing:write']::text[],false);
 END IF;
 RETURN jsonb_build_object('role',r,'key_valid',valid,'allowed',rd AND(NOT writing OR wr),'can_write',wr);
END$$;
CREATE FUNCTION supplier_file_require(uid uuid,kid uuid,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE g jsonb;BEGIN
 g:=supplier_file_access(uid,kid,true,pin);
 IF (g->>'key_valid')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Klucz API wygasł lub został wycofany' USING ERRCODE='42501';END IF;
 IF(g->>'allowed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktualnych uprawnień purchasing' USING ERRCODE='42501';END IF;
END$$;
CREATE FUNCTION supplier_file_quota(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('supplier-file:'||t::text,0));
 IF(SELECT count(*) FROM supplier_sources WHERE tenant_id=t AND kind='file')>100 THEN RAISE EXCEPTION 'Limit 100 źródeł plikowych' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM supplier_catalog_items i JOIN supplier_sources s ON(s.tenant_id,s.id)=(i.tenant_id,i.source_id) WHERE i.tenant_id=t AND s.kind='file' GROUP BY i.source_id HAVING count(*)>10000) THEN RAISE EXCEPTION 'Limit 10000 pozycji źródła plikowego' USING ERRCODE='P0001';END IF;
 IF(SELECT count(*) FROM supplier_file_previews WHERE tenant_id=t)>200 OR(SELECT coalesce(sum(raw_bytes),0) FROM supplier_file_previews WHERE tenant_id=t)>33554432 THEN RAISE EXCEPTION 'Limit zachowanych plików źródła' USING ERRCODE='P0001';END IF;
 IF(SELECT coalesce(sum(n),0) FROM(
 SELECT octet_length(raw_content)+octet_length(payload::text) n FROM supplier_file_previews WHERE tenant_id=t
 UNION ALL SELECT octet_length(payload::text) FROM supplier_file_preview_rows WHERE tenant_id=t
 UNION ALL SELECT octet_length(payload::text) FROM supplier_file_runs WHERE tenant_id=t
 UNION ALL SELECT octet_length(payload::text) FROM supplier_file_run_rows WHERE tenant_id=t
 UNION ALL SELECT octet_length(payload::text) FROM supplier_file_source_revisions WHERE tenant_id=t
 UNION ALL SELECT octet_length(config::text) FROM supplier_file_source_configs WHERE tenant_id=t
 ) evidence)>33554432 THEN RAISE EXCEPTION 'Limit 32 MiB historii źródeł plikowych' USING ERRCODE='P0001';END IF;
END$$;
CREATE FUNCTION supplier_file_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_TABLE_NAME='supplier_file_source_configs' AND TG_OP='UPDATE' THEN
  IF EXISTS(SELECT 1 FROM supplier_file_source_revisions r JOIN supplier_sources s ON(s.tenant_id,s.id,s.version)=(r.tenant_id,r.source_id,r.version) WHERE(r.tenant_id,r.source_id)=(NEW.tenant_id,NEW.source_id) AND r.payload->'config'=NEW.config) AND(NEW.tenant_id,NEW.source_id)=(OLD.tenant_id,OLD.source_id) THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'Historia źródła plikowego jest niezmienna' USING ERRCODE='23514';END$$;
DO $$DECLARE tbl text;BEGIN FOREACH tbl IN ARRAY ARRAY['supplier_file_source_configs','supplier_file_source_revisions','supplier_file_previews','supplier_file_preview_rows','supplier_file_runs','supplier_file_run_rows'] LOOP
 EXECUTE format('CREATE TRIGGER supplier_file_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION supplier_file_immutable()',tbl);
END LOOP;END$$;
CREATE FUNCTION supplier_file_source_create(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;prior supplier_file_source_revisions%ROWTYPE;sid uuid:=(v->>'id')::uuid;BEGIN
 PERFORM supplier_file_quota(t);PERFORM supplier_file_require(uid,kid,false);
 SELECT * INTO prior FROM supplier_file_source_revisions WHERE tenant_id=t AND actor_id=uid AND client_key=(v->>'client_key')::uuid;
 IF FOUND THEN
  IF prior.request_hash IS DISTINCT FROM v->>'request_hash' OR prior.api_key_id IS DISTINCT FROM kid OR prior.version<>1 THEN RAISE EXCEPTION 'Klucz konfiguracji użyto z innymi danymi' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('id',prior.source_id,'reused',true);
 END IF;
 IF supplier_file_config_valid(v->'config') IS NOT TRUE OR coalesce(length(v->>'name'),0) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Niepoprawna konfiguracja źródła plikowego' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM suppliers WHERE tenant_id=t AND id=(v->>'supplier_id')::uuid AND active) THEN RAISE EXCEPTION 'Wybierz aktywnego dostawcę swojej firmy' USING ERRCODE='23514';END IF;
 INSERT INTO supplier_sources(id,tenant_id,kind,name,supplier_id,language,currency,max_handling_days) VALUES(sid,t,'file',v->>'name',(v->>'supplier_id')::uuid,v->>'language',v->>'currency',(v->>'max_handling_days')::integer);
 INSERT INTO supplier_file_source_revisions(id,tenant_id,source_id,actor_id,api_key_id,client_key,request_hash,version,payload) VALUES(gen_random_uuid(),t,sid,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',1,v);
 INSERT INTO supplier_file_source_configs VALUES(t,sid,v->'config');PERFORM supplier_file_quota(t);
 RETURN jsonb_build_object('id',sid,'reused',false);
END$$;
CREATE FUNCTION supplier_file_source_update(sid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s supplier_sources%ROWTYPE;prior supplier_file_source_revisions%ROWTYPE;BEGIN
 PERFORM supplier_file_quota(t);SELECT * INTO s FROM supplier_sources WHERE tenant_id=t AND id=sid AND kind='file' FOR UPDATE;PERFORM supplier_file_require(uid,kid,false);
 IF s.id IS NULL THEN RAISE EXCEPTION 'Brak źródła plikowego' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM supplier_file_source_revisions WHERE tenant_id=t AND actor_id=uid AND client_key=(v->>'client_key')::uuid;
 IF FOUND THEN
  IF prior.request_hash IS DISTINCT FROM v->>'request_hash' OR prior.api_key_id IS DISTINCT FROM kid OR prior.source_id<>sid THEN RAISE EXCEPTION 'Klucz konfiguracji użyto z innymi danymi' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('id',sid,'version',prior.version,'reused',true);
 END IF;
 IF s.version IS DISTINCT FROM(v->>'version')::integer THEN RAISE EXCEPTION 'Źródło zmieniło wersję' USING ERRCODE='23514';END IF;
 IF supplier_file_config_valid(v->'config') IS NOT TRUE OR coalesce(length(v->>'name'),0) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Niepoprawna konfiguracja źródła plikowego' USING ERRCODE='23514';END IF;
 UPDATE supplier_sources SET name=v->>'name',version=version+1 WHERE tenant_id=t AND id=sid;
 INSERT INTO supplier_file_source_revisions(id,tenant_id,source_id,actor_id,api_key_id,client_key,request_hash,version,payload) VALUES(gen_random_uuid(),t,sid,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',s.version+1,v);
 UPDATE supplier_file_source_configs SET config=v->'config' WHERE tenant_id=t AND source_id=sid;
 PERFORM supplier_file_quota(t);
 RETURN jsonb_build_object('id',sid,'version',s.version+1,'reused',false);
END$$;
CREATE FUNCTION supplier_file_store_preview(v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s supplier_sources%ROWTYPE;p jsonb:=v->'payload';part jsonb;idx integer:=0;pid uuid:=(v->>'id')::uuid;current_items jsonb;current_missing jsonb;BEGIN
 PERFORM supplier_file_quota(t);SELECT * INTO s FROM supplier_sources WHERE tenant_id=t AND id=(v->>'source_id')::uuid AND kind='file' FOR UPDATE;PERFORM supplier_file_require(uid,kid,false);
 IF s.id IS NULL OR s.paused OR s.version IS DISTINCT FROM(v->>'source_version')::integer OR p->>'scope' NOT IN('full','delta') OR jsonb_array_length(p->'rows') NOT BETWEEN 1 AND 500 OR p->'config_snapshot' IS DISTINCT FROM(SELECT config FROM supplier_file_source_configs WHERE tenant_id=t AND source_id=s.id) OR p->>'raw_hash' IS DISTINCT FROM v->>'raw_hash' OR octet_length(p::text)>8388608 OR language_file_import_hash(p) IS DISTINCT FROM v->>'scope_hash' THEN RAISE EXCEPTION 'Niepoprawny pełny podgląd źródła plikowego' USING ERRCODE='23514';END IF;
 IF p->>'connection_hash' IS DISTINCT FROM language_file_import_hash(jsonb_build_object('kind','file','source_id',s.id,'source_version',s.version,'config',p->'config_snapshot','language',s.language,'currency',s.currency,'max_handling_days',s.max_handling_days)) THEN RAISE EXCEPTION 'Zmieniła się konfiguracja dostawcy' USING ERRCODE='23514';END IF;
 IF p->>'id' IS DISTINCT FROM v->>'id' OR p->>'source_id' IS DISTINCT FROM s.id::text OR(p->>'source_version')::integer IS DISTINCT FROM s.version OR p->>'client_key' IS DISTINCT FROM v->>'client_key' THEN RAISE EXCEPTION 'Niepełny zakres źródła plikowego' USING ERRCODE='23514';END IF;
 PERFORM i.id FROM supplier_catalog_items i WHERE i.tenant_id=t AND i.source_id=s.id ORDER BY i.id FOR UPDATE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'version',i.version,'product_id',i.product_id,'snapshot_hash',encode(sha256(convert_to(i.snapshot::text,'UTF8')),'hex')) ORDER BY i.id),'[]') INTO current_items FROM supplier_catalog_items i WHERE i.tenant_id=t AND i.source_id=s.id;
 IF current_items IS DISTINCT FROM p->'expected_items' OR jsonb_array_length(current_items)>10000 THEN RAISE EXCEPTION 'Katalog dostawcy zmienił się po podglądzie' USING ERRCODE='23514';END IF;
 IF p->>'scope'='full' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'remote_product_id',i.remote_product_id,'remote_variant_id',i.remote_variant_id,'sku',i.sku,'name',i.name,'product_id',i.product_id,'version',i.version,'snapshot',i.snapshot,'snapshot_hash',encode(sha256(convert_to(i.snapshot::text,'UTF8')),'hex')) ORDER BY i.id),'[]') INTO current_missing FROM supplier_catalog_items i WHERE i.tenant_id=t AND i.source_id=s.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'rows') q(row_data) WHERE(q.row_data->>'remote_product_id',coalesce(q.row_data->>'remote_variant_id',''))=(i.remote_product_id,i.remote_variant_id));
 ELSE current_missing:='[]';END IF;
 IF current_missing IS DISTINCT FROM p->'missing' OR(p->'summary'->>'missing')::integer IS DISTINCT FROM jsonb_array_length(current_missing) THEN RAISE EXCEPTION 'Niepełny zakres brakujących pozycji' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'rows') q(row_data) WHERE jsonb_array_length(q.row_data->'errors')=0 GROUP BY q.row_data->>'remote_product_id',coalesce(q.row_data->>'remote_variant_id','') HAVING count(*)>1) THEN RAISE EXCEPTION 'Powtórzona pozycja źródła plikowego' USING ERRCODE='23514';END IF;
 IF(p->'summary'->>'total')::integer<>jsonb_array_length(p->'rows') OR(p->'summary'->>'invalid')::integer<>(SELECT count(*) FROM jsonb_array_elements(p->'rows') q(row_data) WHERE jsonb_array_length(q.row_data->'errors')>0) THEN RAISE EXCEPTION 'Niepełne wiersze źródła' USING ERRCODE='23514';END IF;
 INSERT INTO supplier_file_previews(id,tenant_id,source_id,source_version,actor_id,api_key_id,client_key,request_hash,scope_hash,raw_hash,raw_content,raw_bytes,payload) VALUES(pid,t,s.id,s.version,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',v->>'scope_hash',v->>'raw_hash',v->>'raw_content',(v->>'raw_bytes')::integer,p);
 FOR part IN SELECT value FROM jsonb_array_elements(p->'rows') LOOP
  IF(part->>'index')::integer IS DISTINCT FROM idx OR jsonb_typeof(part->'errors') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Niepełne indeksy wierszy źródła' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(part->'errors')=0 THEN
   IF jsonb_typeof(part->'snapshot') IS DISTINCT FROM 'object' OR part->'snapshot'->>'connection_hash' IS DISTINCT FROM p->>'connection_hash' OR(part->'snapshot'->>'source_version')::integer IS DISTINCT FROM s.version OR part->'snapshot'->>'currency' IS DISTINCT FROM s.currency OR part->'snapshot'->>'remote_product_id' IS DISTINCT FROM part->>'remote_product_id' OR part->'snapshot'->>'remote_variant_id' IS DISTINCT FROM part->>'remote_variant_id' OR coalesce(length(part->>'remote_product_id'),0) NOT BETWEEN 1 AND 200 OR coalesce(length(part->>'name'),0) NOT BETWEEN 2 AND 200 OR(part->'snapshot'->>'unit_cost')::bigint NOT BETWEEN 0 AND 1000000000 OR(part->'snapshot'->>'quantity')::bigint NOT BETWEEN 0 AND 10000000 OR(part->'snapshot'->'tiers') IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Niepoprawna pozycja źródła plikowego' USING ERRCODE='23514';END IF;
   IF NOT EXISTS(SELECT 1 FROM supplier_catalog_items i WHERE i.tenant_id=t AND i.source_id=s.id AND i.remote_product_id=part->>'remote_product_id' AND i.remote_variant_id=coalesce(part->>'remote_variant_id','')) THEN
    IF part->>'status' IS DISTINCT FROM 'new' OR part->'item_id' IS DISTINCT FROM 'null'::jsonb OR part->'expected_version' IS DISTINCT FROM 'null'::jsonb OR part->'before' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Niepoprawny zakres nowej pozycji' USING ERRCODE='23514';END IF;
   ELSIF NOT EXISTS(SELECT 1 FROM supplier_catalog_items i WHERE i.tenant_id=t AND i.source_id=s.id AND i.id=(part->>'item_id')::uuid AND i.version=(part->>'expected_version')::integer AND i.remote_product_id=part->>'remote_product_id' AND i.remote_variant_id=coalesce(part->>'remote_variant_id','') AND i.snapshot=part->'before' AND part->>'status'=CASE WHEN(i.snapshot-ARRAY['file_preview_id','file_run_id','raw_hash','withdrawn_by_file_run_id'])=part->'snapshot' THEN 'unchanged' ELSE 'changed' END) THEN RAISE EXCEPTION 'Pozycja dostawcy zmieniła się po podglądzie' USING ERRCODE='23514';END IF;
  END IF;
  INSERT INTO supplier_file_preview_rows VALUES(t,pid,idx,part);idx:=idx+1;
 END LOOP;PERFORM supplier_file_quota(t);RETURN pid;
END$$;
CREATE FUNCTION supplier_file_catalog_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s supplier_sources%ROWTYPE;r supplier_file_runs%ROWTYPE;row_data jsonb;old_kind text;BEGIN
 IF TG_OP='DELETE' THEN SELECT * INTO s FROM supplier_sources WHERE(tenant_id,id)=(OLD.tenant_id,OLD.source_id);ELSE SELECT * INTO s FROM supplier_sources WHERE(tenant_id,id)=(NEW.tenant_id,NEW.source_id);END IF;
 IF TG_OP='UPDATE' THEN
  SELECT kind INTO old_kind FROM supplier_sources WHERE(tenant_id,id)=(OLD.tenant_id,OLD.source_id);
  IF (old_kind='file' OR s.kind='file') AND(OLD.tenant_id,OLD.source_id,OLD.id) IS DISTINCT FROM(NEW.tenant_id,NEW.source_id,NEW.id) THEN RAISE EXCEPTION 'Nie można zmienić źródła pozycji' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  IF s.kind IS DISTINCT FROM 'file' AND NEW.file_run_id IS NOT NULL THEN RAISE EXCEPTION 'Plikowy odczyt należy do źródła plikowego' USING ERRCODE='23514';END IF;
 END IF;
 IF s.kind IS DISTINCT FROM 'file' THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.source_id,OLD.id) IS DISTINCT FROM(NEW.tenant_id,NEW.source_id,NEW.id) THEN RAISE EXCEPTION 'Nie można zmienić źródła pozycji' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Nie można usuwać historii pozycji źródła' USING ERRCODE='23514';END IF;
 -- Linking an own product is an existing separate workflow, without changing source evidence.
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['product_id','version'])=(to_jsonb(OLD)-ARRAY['product_id','version']) AND NEW.version=OLD.version+1 AND NOT EXISTS(SELECT 1 FROM supplier_file_runs WHERE tenant_id=s.tenant_id AND source_id=s.id AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp()) THEN RETURN NEW;END IF;
 END IF;
 SELECT * INTO r FROM supplier_file_runs WHERE(tenant_id,id)=(NEW.tenant_id,NEW.file_run_id) AND source_id=s.id AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 SELECT payload INTO row_data FROM supplier_file_run_rows WHERE(tenant_id,run_id,item_id)=(NEW.tenant_id,NEW.file_run_id,NEW.id);
 IF r.id IS NULL OR row_data IS NULL OR row_data->'after' IS DISTINCT FROM to_jsonb(NEW)-ARRAY['tenant_id','source_id'] THEN RAISE EXCEPTION 'Brak zatwierdzonego odświeżenia pozycji źródła' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER supplier_file_catalog_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_catalog_items FOR EACH ROW EXECUTE FUNCTION supplier_file_catalog_guard();
CREATE FUNCTION supplier_file_source_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF OLD.kind='file' OR NEW.kind='file' THEN
  IF(to_jsonb(OLD)-ARRAY['name','paused','version']) IS DISTINCT FROM(to_jsonb(NEW)-ARRAY['name','paused','version']) THEN RAISE EXCEPTION 'Tożsamość plikowego źródła dostawcy jest niezmienna' USING ERRCODE='23514';END IF;
  IF NEW.version IS DISTINCT FROM OLD.version+1 THEN RAISE EXCEPTION 'Niepoprawna rewizja plikowego źródła dostawcy' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER supplier_file_source_identity BEFORE UPDATE ON supplier_sources FOR EACH ROW EXECUTE FUNCTION supplier_file_source_identity();
CREATE FUNCTION supplier_file_apply(pid uuid,rid uuid,rhash text,request jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p supplier_file_previews%ROWTYPE;s supplier_sources%ROWTYPE;prior supplier_file_runs%ROWTYPE;current_items jsonb;part jsonb;olditem supplier_catalog_items%ROWTYPE;newitem supplier_catalog_items%ROWTYPE;outrows jsonb:='[]';after_data jsonb;idx integer:=0;run_payload jsonb;BEGIN
 PERFORM supplier_file_quota(t);SELECT * INTO p FROM supplier_file_previews WHERE tenant_id=t AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Brak podglądu źródła' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM supplier_sources WHERE tenant_id=t AND id=p.source_id AND kind='file' FOR UPDATE;PERFORM supplier_file_require(uid,kid,false);
 IF p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Podgląd należy do innego aktora lub klucza' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM supplier_file_runs WHERE tenant_id=t AND(source_id=p.source_id AND client_key=(request->>'client_key')::uuid OR preview_id=pid);
 IF FOUND THEN
  IF prior.request_hash IS DISTINCT FROM rhash OR prior.actor_id IS DISTINCT FROM uid OR prior.api_key_id IS DISTINCT FROM kid OR prior.preview_id<>pid THEN RAISE EXCEPTION 'Klucz wykonania użyto z innymi danymi' USING ERRCODE='23514';END IF;
  RETURN prior.payload||jsonb_build_object('id',prior.id,'created_at',prior.created_at,'reused',true);
 END IF;
 IF s.paused OR s.version IS DISTINCT FROM p.source_version OR NOT EXISTS(SELECT 1 FROM suppliers WHERE tenant_id=t AND id=s.supplier_id AND active) THEN RAISE EXCEPTION 'Źródło zmieniło wersję lub jest nieaktywne' USING ERRCODE='23514';END IF;
 IF(p.payload->'summary'->>'invalid')::integer<>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'rows') q(row_data) WHERE jsonb_array_length(q.row_data->'errors')>0 OR q.row_data->'snapshot'='null'::jsonb) OR(request->>'confirm_rows')::integer IS DISTINCT FROM jsonb_array_length(p.payload->'rows') THEN RAISE EXCEPTION 'Podgląd wymaga kompletnej poprawnej zgody' USING ERRCODE='23514';END IF;
 IF p.payload->>'scope'='full' AND jsonb_array_length(p.payload->'missing')>0 AND(request->>'confirm_missing')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Wymagane potwierdzenie wycofania brakujących pozycji' USING ERRCODE='23514';END IF;
 PERFORM id FROM supplier_catalog_items WHERE tenant_id=t AND source_id=s.id ORDER BY id FOR UPDATE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'version',i.version,'product_id',i.product_id,'snapshot_hash',encode(sha256(convert_to(i.snapshot::text,'UTF8')),'hex')) ORDER BY i.id),'[]') INTO current_items FROM supplier_catalog_items i WHERE i.tenant_id=t AND i.source_id=s.id;
 IF p.payload->>'scope'='full' AND current_items IS DISTINCT FROM p.payload->'expected_items' THEN RAISE EXCEPTION 'Katalog dostawcy zmienił się po podglądzie' USING ERRCODE='23514';END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(p.payload->'rows') LOOP
  SELECT * INTO olditem FROM supplier_catalog_items WHERE tenant_id=t AND source_id=s.id AND remote_product_id=part->>'remote_product_id' AND remote_variant_id=coalesce(part->>'remote_variant_id','');
  IF olditem.id IS DISTINCT FROM(part->>'item_id')::uuid OR olditem.version IS DISTINCT FROM(part->>'expected_version')::integer OR olditem.snapshot IS DISTINCT FROM nullif(part->'before','null'::jsonb) THEN RAISE EXCEPTION 'Pozycja dostawcy zmieniła się po podglądzie' USING ERRCODE='23514';END IF;
 END LOOP;
 run_payload:=p.payload||jsonb_build_object('id',rid,'preview_id',pid,'execute_request',request);
 INSERT INTO supplier_file_runs(id,tenant_id,source_id,preview_id,actor_id,api_key_id,client_key,request_hash,payload) VALUES(rid,t,s.id,pid,uid,kid,(request->>'client_key')::uuid,rhash,run_payload);
 FOR part IN SELECT value FROM jsonb_array_elements(p.payload->'rows') UNION ALL SELECT value||jsonb_build_object('missing',true) FROM jsonb_array_elements(p.payload->'missing') LOOP
  IF coalesce((part->>'missing')::boolean,false) THEN SELECT * INTO olditem FROM supplier_catalog_items WHERE tenant_id=t AND id=(part->>'id')::uuid;ELSE SELECT * INTO olditem FROM supplier_catalog_items WHERE tenant_id=t AND source_id=s.id AND remote_product_id=part->>'remote_product_id' AND remote_variant_id=coalesce(part->>'remote_variant_id','');END IF;
  newitem:=olditem;
  IF olditem.id IS NULL THEN newitem.id:=gen_random_uuid();newitem.tenant_id:=t;newitem.source_id:=s.id;newitem.remote_product_id:=part->>'remote_product_id';newitem.remote_variant_id:=coalesce(part->>'remote_variant_id','');newitem.product_id:=NULL;newitem.version:=1;END IF;
  IF coalesce((part->>'missing')::boolean,false) THEN
   newitem.snapshot:=olditem.snapshot||jsonb_build_object('active',false,'quantity',0,'withdrawn_by_file_run_id',rid,'file_preview_id',pid,'file_run_id',rid,'raw_hash',p.raw_hash);
   IF olditem.snapshot->'active'='true'::jsonb OR olditem.snapshot->'quantity'<>'0'::jsonb THEN newitem.version:=olditem.version+1;END IF;
  ELSE
   newitem.sku:=part->>'sku';newitem.name:=part->>'name';newitem.snapshot:=part->'snapshot'||jsonb_build_object('file_preview_id',pid,'file_run_id',rid,'raw_hash',p.raw_hash);
   IF olditem.id IS NOT NULL AND part->>'status'='changed' THEN newitem.version:=olditem.version+1;END IF;
  END IF;
  newitem.read_id:=NULL;newitem.bulk_run_id:=NULL;newitem.file_run_id:=rid;newitem.refreshed_at:=clock_timestamp();
  after_data:=to_jsonb(newitem)-ARRAY['tenant_id','source_id'];
  INSERT INTO supplier_file_run_rows VALUES(t,rid,idx,newitem.id,jsonb_build_object('index',idx,'item_id',newitem.id,'before',nullif(to_jsonb(olditem),'null'::jsonb),'after',after_data,'missing',coalesce((part->>'missing')::boolean,false)));
  INSERT INTO supplier_catalog_items(id,tenant_id,source_id,remote_product_id,remote_variant_id,sku,name,snapshot,read_id,bulk_run_id,file_run_id,product_id,version,refreshed_at) VALUES(newitem.id,t,s.id,newitem.remote_product_id,newitem.remote_variant_id,newitem.sku,newitem.name,newitem.snapshot,NULL,NULL,rid,newitem.product_id,newitem.version,newitem.refreshed_at)
   ON CONFLICT(tenant_id,source_id,remote_product_id,remote_variant_id) DO UPDATE SET sku=EXCLUDED.sku,name=EXCLUDED.name,snapshot=EXCLUDED.snapshot,read_id=NULL,bulk_run_id=NULL,file_run_id=rid,version=EXCLUDED.version,refreshed_at=EXCLUDED.refreshed_at;
  outrows:=outrows||jsonb_build_array(part||jsonb_build_object('item_id',newitem.id,'after',after_data));idx:=idx+1;
 END LOOP;
 -- The public run snapshot is already derivable from immutable typed run rows, without updating the immutable head.
 PERFORM supplier_file_require(uid,kid,false);RETURN run_payload||jsonb_build_object('rows',outrows,'created_at',now(),'reused',false);
END$$;
CREATE FUNCTION supplier_file_run_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE p supplier_file_previews%ROWTYPE;actual_count integer;BEGIN
 SELECT * INTO p FROM supplier_file_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF p.id IS NULL OR NEW.top_xid<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp() OR NEW.actor_id IS DISTINCT FROM p.actor_id OR NEW.api_key_id IS DISTINCT FROM p.api_key_id THEN RAISE EXCEPTION 'Niepełne wykonanie źródła plikowego' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO actual_count FROM supplier_file_run_rows WHERE(tenant_id,run_id)=(NEW.tenant_id,NEW.id);
 IF actual_count IS DISTINCT FROM jsonb_array_length(p.payload->'rows')+jsonb_array_length(p.payload->'missing') OR EXISTS(SELECT 1 FROM supplier_file_run_rows rr LEFT JOIN supplier_catalog_items i ON(i.tenant_id,i.id)=(rr.tenant_id,rr.item_id) WHERE(rr.tenant_id,rr.run_id)=(NEW.tenant_id,NEW.id) AND rr.payload->'after' IS DISTINCT FROM to_jsonb(i)-ARRAY['tenant_id','source_id']) THEN RAISE EXCEPTION 'Niepełny zapis pozycji źródła plikowego' USING ERRCODE='23514';END IF;
 PERFORM supplier_file_quota(NEW.tenant_id);PERFORM supplier_file_require(NEW.actor_id,NEW.api_key_id,true);RETURN NEW;
END$$;
CREATE CONSTRAINT TRIGGER supplier_file_run_complete AFTER INSERT ON supplier_file_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION supplier_file_run_complete();
REVOKE ALL ON FUNCTION supplier_file_installed(),supplier_file_access(uuid,uuid,boolean,boolean),supplier_file_require(uuid,uuid,boolean),supplier_file_quota(uuid),supplier_file_immutable(),supplier_file_source_create(jsonb,uuid,uuid),supplier_file_source_update(uuid,jsonb,uuid,uuid),supplier_file_store_preview(jsonb,uuid,uuid),supplier_file_apply(uuid,uuid,text,jsonb,uuid,uuid),supplier_file_catalog_guard(),supplier_file_run_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_file_config_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_file_source_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION supplier_file_installed(),supplier_file_access(uuid,uuid,boolean,boolean),supplier_file_source_create(jsonb,uuid,uuid),supplier_file_source_update(uuid,jsonb,uuid,uuid),supplier_file_store_preview(jsonb,uuid,uuid),supplier_file_apply(uuid,uuid,text,jsonb,uuid,uuid) TO dyna_app;
