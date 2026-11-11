-- Additive file custody for core 088. Historical core rows and hashes are unchanged.
CREATE TABLE language_file_import_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 source text NOT NULL CHECK(source IN('manual','api')),core_preview_id uuid,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),byte_count bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,core_preview_id),
 FOREIGN KEY(tenant_id,core_preview_id) REFERENCES product_translation_bulk_edit_previews(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE language_file_import_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 2999),product_id uuid,locale text NOT NULL,
 core_preview_id uuid,core_index integer,receipt_id uuid,payload jsonb NOT NULL,byte_count bigint NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,preview_id,index),
 UNIQUE(tenant_id,preview_id,core_index),UNIQUE(tenant_id,preview_id,receipt_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES language_file_import_previews(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,core_preview_id,core_index,receipt_id,product_id,locale) REFERENCES product_translation_bulk_edit_rows(tenant_id,preview_id,index,receipt_id,product_id,locale)
);
CREATE TABLE language_file_import_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN('manual','api')),
 core_preview_id uuid NOT NULL,core_execution_id uuid NOT NULL,payload jsonb NOT NULL,byte_count bigint NOT NULL DEFAULT 0,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,core_execution_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES language_file_import_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,core_execution_id,core_preview_id) REFERENCES product_translation_bulk_edit_executions(tenant_id,id,preview_id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE language_file_import_execution_rows (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 2999),
 product_id uuid NOT NULL,locale text NOT NULL,receipt_id uuid NOT NULL,payload jsonb NOT NULL,byte_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,execution_id,index),UNIQUE(tenant_id,execution_id,product_id,locale),UNIQUE(tenant_id,execution_id,receipt_id),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES language_file_import_executions(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,index) REFERENCES language_file_import_rows(tenant_id,preview_id,index),
 FOREIGN KEY(tenant_id,receipt_id,product_id,locale) REFERENCES product_translation_bulk_edit_execution_rows(tenant_id,id,product_id,locale)
);
CREATE TABLE language_file_import_profiles (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,version integer NOT NULL CHECK(version>0),name text NOT NULL,
 definition jsonb NOT NULL,archived boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),CHECK(length(name) BETWEEN 1 AND 120)
);
CREATE TABLE language_file_import_profile_revisions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),payload jsonb NOT NULL,byte_count bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,profile_id,version),
 FOREIGN KEY(tenant_id,profile_id) REFERENCES language_file_import_profiles(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE language_file_import_admissions (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,execution_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(tenant_id,execution_id),UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES language_file_import_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES language_file_import_executions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE language_file_import_core_witnesses (
 tenant_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('preview','execution')),id uuid NOT NULL,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),PRIMARY KEY(tenant_id,kind,id)
);
CREATE INDEX language_file_preview_history ON language_file_import_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX language_file_execution_history ON language_file_import_executions(tenant_id,created_at DESC,id DESC);
CREATE INDEX language_file_profile_history ON language_file_import_profile_revisions(tenant_id,created_at DESC,id DESC);
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['language_file_import_previews','language_file_import_rows','language_file_import_executions','language_file_import_execution_rows','language_file_import_profiles','language_file_import_profile_revisions','language_file_import_admissions','language_file_import_core_witnesses'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',n);
  EXECUTE format('CREATE POLICY owner_scope ON %I TO %I USING(true) WITH CHECK(true)',n,current_user);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',n);
  IF n NOT IN('language_file_import_admissions','language_file_import_core_witnesses') THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',n);END IF;
 END LOOP;
END $$;

CREATE FUNCTION language_file_import_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Dowód importu języków jest niezmienny' USING ERRCODE='23514';END $$;
CREATE FUNCTION language_file_import_bytes() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE n bigint;BEGIN LOOP n:=octet_length(to_jsonb(NEW)::text);EXIT WHEN NEW.byte_count=n;NEW.byte_count:=n;END LOOP;RETURN NEW;END $$;
CREATE FUNCTION language_file_import_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE bytes bigint;BEGIN
 PERFORM language_file_import_locks(t);
 IF(SELECT count(*) FROM language_file_import_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM language_file_import_executions WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM language_file_import_profile_revisions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii importu języków' USING ERRCODE='P0001';END IF;
 IF(SELECT count(*) FROM language_file_import_profiles WHERE tenant_id=t)>100 THEN RAISE EXCEPTION 'Limit profili importu języków' USING ERRCODE='P0001';END IF;
 SELECT coalesce(sum(b),0) INTO bytes FROM(
 SELECT byte_count b FROM language_file_import_previews WHERE tenant_id=t UNION ALL SELECT byte_count FROM language_file_import_rows WHERE tenant_id=t
 UNION ALL SELECT byte_count FROM language_file_import_executions WHERE tenant_id=t UNION ALL SELECT byte_count FROM language_file_import_execution_rows WHERE tenant_id=t
 UNION ALL SELECT byte_count FROM language_file_import_profile_revisions WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(p)::text) FROM language_file_import_profiles p WHERE tenant_id=t
 UNION ALL SELECT octet_length(to_jsonb(a)::text) FROM language_file_import_admissions a WHERE tenant_id=t UNION ALL SELECT octet_length(to_jsonb(w)::text) FROM language_file_import_core_witnesses w WHERE tenant_id=t) q;
 IF bytes>268435456 THEN RAISE EXCEPTION 'Limit bajtów historii importu języków' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM language_file_import_previews p JOIN(SELECT preview_id,sum(byte_count) b FROM language_file_import_rows WHERE tenant_id=t GROUP BY preview_id) r ON r.preview_id=p.id WHERE p.tenant_id=t AND p.byte_count+r.b>33554432) THEN RAISE EXCEPTION 'Limit bajtów podglądu importu języków' USING ERRCODE='P0001';END IF;
END $$;
CREATE FUNCTION language_file_import_core_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 INSERT INTO language_file_import_core_witnesses(tenant_id,kind,id) VALUES(NEW.tenant_id,CASE WHEN TG_TABLE_NAME='product_translation_bulk_edit_previews' THEN 'preview' ELSE 'execution' END,NEW.id);RETURN NEW;
END $$;
CREATE TRIGGER language_file_import_core_witness AFTER INSERT ON product_translation_bulk_edit_previews FOR EACH ROW EXECUTE FUNCTION language_file_import_core_witness();
CREATE TRIGGER language_file_import_core_witness AFTER INSERT ON product_translation_bulk_edit_executions FOR EACH ROW EXECUTE FUNCTION language_file_import_core_witness();

CREATE FUNCTION language_file_import_store_preview(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;old language_file_import_previews%ROWTYPE;p language_file_import_previews%ROWTYPE;BEGIN
 PERFORM language_file_import_require(uid,kid,false);PERFORM language_file_import_locks(t);
 SELECT * INTO old FROM language_file_import_previews WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF old.id IS NOT NULL THEN IF old.actor_id IS DISTINCT FROM uid OR old.api_key_id IS DISTINCT FROM kid OR old.request_hash IS DISTINCT FROM v->>'request_hash' THEN RAISE EXCEPTION 'Inny autor, klucz lub treść podglądu języków' USING ERRCODE='23514';END IF;RETURN to_jsonb(old);END IF;
 INSERT INTO language_file_import_previews(id,tenant_id,actor_id,api_key_id,client_key,request_hash,scope_hash,source,core_preview_id,payload) VALUES((v->>'id')::uuid,t,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',v->>'scope_hash',v->>'source',(v->>'core_preview_id')::uuid,v) RETURNING * INTO p;
 INSERT INTO language_file_import_rows(tenant_id,preview_id,index,product_id,locale,core_preview_id,core_index,receipt_id,payload)
 SELECT t,p.id,(r->>'index')::int,(r->>'product_id')::uuid,r->>'locale',p.core_preview_id,(r->>'core_index')::int,(r->>'receipt_id')::uuid,r FROM jsonb_array_elements(v->'rows') r;
 PERFORM language_file_import_budget(t);PERFORM language_file_import_require(uid,kid,false);RETURN to_jsonb(p);
END $$;
CREATE FUNCTION language_file_import_prepare_execution(pid uuid,eid uuid,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p language_file_import_previews%ROWTYPE;cp product_translation_bulk_edit_previews%ROWTYPE;rules jsonb;BEGIN
 PERFORM language_file_import_require(uid,kid,false);PERFORM language_file_import_locks(t);
 SELECT * INTO p FROM language_file_import_previews WHERE(tenant_id,id)=(t,pid) FOR UPDATE;
 IF p.id IS NULL OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR(p.payload#>>'{summary,ready}')::boolean IS NOT TRUE OR p.core_preview_id IS NULL OR EXISTS(SELECT 1 FROM language_file_import_executions WHERE(tenant_id,preview_id)=(t,pid)) THEN RAISE EXCEPTION 'Niegotowy lub obcy podgląd języków' USING ERRCODE='23514';END IF;
 -- Same advisory admission as 088, then canonical product/translation locks.
 PERFORM pr.id FROM products pr JOIN(SELECT DISTINCT product_id FROM language_file_import_rows WHERE(tenant_id,preview_id)=(t,pid)) wanted ON wanted.product_id=pr.id WHERE pr.tenant_id=t ORDER BY pr.id FOR UPDATE OF pr;
 PERFORM tr.product_id FROM product_translations tr JOIN language_file_import_rows rr ON(rr.tenant_id,rr.product_id,rr.locale)=(tr.tenant_id,tr.product_id,tr.locale) WHERE rr.tenant_id=t AND rr.preview_id=pid ORDER BY tr.product_id,tr.locale FOR UPDATE OF tr;
 PERFORM language_file_import_validate_preview(p.payload,uid,kid,true,false);
 SELECT * INTO cp FROM product_translation_bulk_edit_previews WHERE(tenant_id,id)=(t,p.core_preview_id);
 IF to_regclass('public.product_rules') IS NULL THEN rules:='[]';ELSE
  PERFORM id FROM product_rules WHERE tenant_id=t AND enabled AND deleted_at IS NULL ORDER BY id FOR SHARE;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'event',event,'definition',definition,'approved_by',approved_by,'approved_at',to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY id),'[]') INTO rules FROM product_rules WHERE tenant_id=t AND enabled AND deleted_at IS NULL;
 END IF;
 IF cp.rules_snapshot IS DISTINCT FROM rules THEN RAISE EXCEPTION 'Reguły produktu zmieniły się po podglądzie języków' USING ERRCODE='23514';END IF;
 INSERT INTO language_file_import_admissions(tenant_id,preview_id,execution_id,actor_id,api_key_id) VALUES(t,pid,eid,uid,kid);
 PERFORM language_file_import_require(uid,kid,false);
END $$;

CREATE FUNCTION language_file_import_validate_execution(v jsonb,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p language_file_import_previews%ROWTYPE;a language_file_import_admissions%ROWTYPE;e product_translation_bulk_edit_executions%ROWTYPE;core_map jsonb;product_map jsonb;translations jsonb;approved_map jsonb;changed jsonb;expected_ack jsonb;rr jsonb;pr jsonb;cr jsonb;product jsonb;actual jsonb;i int:=0;BEGIN
 SELECT * INTO p FROM language_file_import_previews WHERE(tenant_id,id)=(t,(v->>'preview_id')::uuid);
 SELECT * INTO a FROM language_file_import_admissions WHERE(tenant_id,preview_id,execution_id,actor_id,top_xid,transaction_started_at)=(t,p.id,(v->>'id')::uuid,uid,pg_current_xact_id(),transaction_timestamp());
 SELECT * INTO e FROM product_translation_bulk_edit_executions WHERE(tenant_id,id,preview_id)=(t,(v->>'core_execution_id')::uuid,p.core_preview_id);
 IF p.id IS NULL OR a.execution_id IS NULL OR a.api_key_id IS DISTINCT FROM kid OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR e.id IS NULL OR e.actor_id IS DISTINCT FROM uid OR e.source IS DISTINCT FROM p.source OR(p.payload#>>'{summary,ready}')::boolean IS NOT TRUE OR v->>'scope_hash' IS DISTINCT FROM p.scope_hash OR v->>'source' IS DISTINCT FROM p.source OR v->>'core_preview_id' IS DISTINCT FROM p.core_preview_id::text OR v->'definition' IS DISTINCT FROM p.payload->'definition' OR v->'source_hash' IS DISTINCT FROM p.payload->'source_hash' OR v->'profile_snapshot' IS DISTINCT FROM p.payload->'profile_snapshot' OR v->'summary' IS DISTINCT FROM p.payload->'summary' OR v->'per_locale' IS DISTINCT FROM p.payload->'per_locale' OR v->>'client_key' IS DISTINCT FROM v#>>'{request,client_key}' OR jsonb_typeof(v->'request') IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v->'request') k WHERE k NOT IN('client_key','scope_hash','confirmed','ack_missing_locale_codes')) OR v#>>'{request,confirmed}' IS DISTINCT FROM 'true' OR v#>>'{request,scope_hash}' IS DISTINCT FROM p.scope_hash OR v->>'request_hash' IS DISTINCT FROM language_file_import_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'source',p.source,'kind','execute','parent_id',p.id,'request',v->'request')) OR NOT EXISTS(SELECT 1 FROM language_file_import_core_witnesses w WHERE(w.tenant_id,w.kind,w.id,w.top_xid,w.transaction_started_at)=(t,'execution',e.id,pg_current_xact_id(),transaction_timestamp())) THEN RAISE EXCEPTION 'Niekompletny własny dowód wykonania języków' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(x->'locale' ORDER BY x->>'locale'),'[]') INTO expected_ack FROM jsonb_array_elements(p.payload->'per_locale') x WHERE(x->>'missing_after_count')::int>0;
 IF v->'ack_missing_locale_codes' IS DISTINCT FROM expected_ack OR v#>'{request,ack_missing_locale_codes}' IS DISTINCT FROM expected_ack OR e.ack_missing_translations IS DISTINCT FROM(jsonb_array_length(expected_ack)>0) OR jsonb_typeof(v->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'rows')<>e.total THEN RAISE EXCEPTION 'Inny ACK lub zakres wykonania języków' USING ERRCODE='23514';END IF;
 SELECT jsonb_object_agg(index::text,payload) INTO approved_map FROM language_file_import_rows WHERE(tenant_id,preview_id)=(t,p.id);
 SELECT jsonb_object_agg(index::text,to_jsonb(c)) INTO core_map FROM product_translation_bulk_edit_execution_rows c WHERE(tenant_id,execution_id)=(t,e.id);
 IF(SELECT count(*) FROM jsonb_object_keys(core_map))<>e.total OR(SELECT count(*) FROM jsonb_object_keys(approved_map))<>e.total THEN RAISE EXCEPTION 'Niepełne receipts języków' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_object_agg(prd.id::text,to_jsonb(prd)),'{}') INTO product_map FROM products prd JOIN(SELECT DISTINCT product_id FROM language_file_import_rows WHERE(tenant_id,preview_id)=(t,p.id)) w ON w.product_id=prd.id WHERE prd.tenant_id=t;
 SELECT coalesce(jsonb_object_agg(tr.product_id::text||':'||tr.locale,to_jsonb(tr)),'{}') INTO translations FROM product_translations tr JOIN language_file_import_rows r ON(r.tenant_id,r.product_id,r.locale)=(tr.tenant_id,tr.product_id,tr.locale) WHERE(r.tenant_id,r.preview_id)=(t,p.id);
 SELECT coalesce(jsonb_object_agg(product_id::text,to_jsonb(true)),'{}') INTO changed FROM(SELECT DISTINCT product_id FROM language_file_import_rows WHERE(tenant_id,preview_id)=(t,p.id) AND payload->>'status'='changed') s;
 FOR rr IN SELECT value FROM jsonb_array_elements(v->'rows') LOOP
  pr:=approved_map->i::text;cr:=core_map->i::text;product:=product_map->(pr->>'product_id');actual:=language_file_import_snapshot(translations->((pr->>'product_id')||':'||(pr->>'locale')));
  IF(rr->>'index')::int IS DISTINCT FROM i OR pr IS NULL OR cr IS NULL OR (rr-ARRAY['core_receipt_id','before_product_version','after_product_version']) IS DISTINCT FROM pr OR rr->'core_receipt_id' IS DISTINCT FROM cr->'id' OR rr->'before_product_version' IS DISTINCT FROM cr->'before_product_version' OR rr->'after_product_version' IS DISTINCT FROM cr->'after_product_version' OR cr->'id' IS DISTINCT FROM pr->'receipt_id' OR cr->'product_id' IS DISTINCT FROM pr->'product_id' OR cr->'locale' IS DISTINCT FROM pr->'locale' OR cr->'input' IS DISTINCT FROM pr->'input' OR cr->'before' IS DISTINCT FROM pr->'before' OR cr->'after' IS DISTINCT FROM pr->'after' OR cr->>'status' IS DISTINCT FROM pr->>'status' OR actual IS DISTINCT FROM pr->'after' OR product->'version' IS DISTINCT FROM to_jsonb((pr->>'product_version')::int+CASE WHEN changed ? (pr->>'product_id') THEN 1 ELSE 0 END) OR cr->'after_product_version' IS DISTINCT FROM product->'version' THEN RAISE EXCEPTION 'Receipt języka nie odpowiada pełnemu rzeczywistemu wynikowi' USING ERRCODE='23514';END IF;
  IF cr->'source' IS DISTINCT FROM jsonb_build_object('name',product->'name','description',product->'description','category',product->'category','attributes',product->'attributes') OR cr->'sku' IS DISTINCT FROM product->'sku' OR cr->'kind' IS DISTINCT FROM product->'kind' OR cr->'product_name' IS DISTINCT FROM product->'name' THEN RAISE EXCEPTION 'Import języków zmienił dane bazowe produktu' USING ERRCODE='23514';END IF;i:=i+1;
 END LOOP;
END $$;
CREATE FUNCTION language_file_import_store_execution(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;old language_file_import_executions%ROWTYPE;e language_file_import_executions%ROWTYPE;BEGIN
 PERFORM language_file_import_require(uid,kid,false);PERFORM language_file_import_locks(t);
 SELECT * INTO old FROM language_file_import_executions WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF old.id IS NOT NULL THEN IF old.actor_id IS DISTINCT FROM uid OR old.api_key_id IS DISTINCT FROM kid OR old.request_hash IS DISTINCT FROM v->>'request_hash' THEN RAISE EXCEPTION 'Inny autor, klucz lub treść wykonania języków' USING ERRCODE='23514';END IF;RETURN to_jsonb(old);END IF;
 INSERT INTO language_file_import_executions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request_hash,scope_hash,source,core_preview_id,core_execution_id,payload) VALUES((v->>'id')::uuid,t,(v->>'preview_id')::uuid,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',v->>'scope_hash',v->>'source',(v->>'core_preview_id')::uuid,(v->>'core_execution_id')::uuid,v) RETURNING * INTO e;
 INSERT INTO language_file_import_execution_rows(tenant_id,execution_id,preview_id,index,product_id,locale,receipt_id,payload) SELECT t,e.id,e.preview_id,(r->>'index')::int,(r->>'product_id')::uuid,r->>'locale',(r->>'core_receipt_id')::uuid,r FROM jsonb_array_elements(v->'rows') r;
 PERFORM language_file_import_budget(t);PERFORM language_file_import_require(uid,kid,false);RETURN to_jsonb(e);
END $$;

CREATE FUNCTION language_file_import_store_profile(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p language_file_import_profiles%ROWTYPE;old language_file_import_profile_revisions%ROWTYPE;expected integer;request jsonb:=v->'request';public_profile jsonb;BEGIN
 PERFORM language_file_import_require(uid,kid,false);PERFORM language_file_import_locks(t);
 expected:=(v->>'expected_version')::int;
 IF expected IS NULL OR expected<0 OR expected>=2147483647 OR(v->>'version')::int IS DISTINCT FROM expected+1 OR jsonb_typeof(v->'name') IS DISTINCT FROM 'string' OR length(btrim(v->>'name')) NOT BETWEEN 1 AND 120 OR v->>'name' IS DISTINCT FROM btrim(v->>'name') OR NOT language_file_import_definition(v->'definition') OR jsonb_typeof(v->'archived') IS DISTINCT FROM 'boolean' OR jsonb_typeof(request) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(request) k WHERE k NOT IN('client_key','name','definition','version','archived')) OR request->>'client_key' IS DISTINCT FROM v->>'client_key' OR request->'name' IS DISTINCT FROM v->'name' OR request->'definition' IS DISTINCT FROM v->'definition' OR(expected=0 AND(request ? 'version' OR request ? 'archived' OR(v->>'archived')::boolean)) OR(expected>0 AND((request->>'version')::int IS DISTINCT FROM expected OR request->'archived' IS DISTINCT FROM v->'archived')) OR v->>'request_hash' IS DISTINCT FROM language_file_import_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'source',CASE WHEN kid IS NULL THEN 'manual' ELSE 'api' END,'kind','profile','parent_id',CASE WHEN expected=0 THEN NULL ELSE(v->>'id')::uuid END,'request',request)) THEN RAISE EXCEPTION 'Niepoprawny profil importu języków' USING ERRCODE='23514';END IF;
 SELECT * INTO old FROM language_file_import_profile_revisions WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF old.id IS NOT NULL THEN
  IF old.actor_id IS DISTINCT FROM uid OR old.api_key_id IS DISTINCT FROM kid OR old.request_hash IS DISTINCT FROM v->>'request_hash' OR(expected>0 AND old.profile_id IS DISTINCT FROM(v->>'id')::uuid) THEN RETURN jsonb_build_object('state','conflict');END IF;
  RETURN jsonb_build_object('profile',old.payload->'profile','reused',true);
 END IF;
 IF expected=0 THEN INSERT INTO language_file_import_profiles(id,tenant_id,version,name,definition,archived) VALUES((v->>'id')::uuid,t,1,v->>'name',v->'definition',false) RETURNING * INTO p;
 ELSE SELECT * INTO p FROM language_file_import_profiles WHERE(tenant_id,id)=(t,(v->>'id')::uuid) FOR UPDATE;
  IF p.id IS NULL OR p.version<>expected THEN RETURN jsonb_build_object('state','conflict');END IF;
  UPDATE language_file_import_profiles SET version=expected+1,name=v->>'name',definition=v->'definition',archived=(v->>'archived')::boolean,updated_at=clock_timestamp() WHERE(tenant_id,id)=(t,p.id) RETURNING * INTO p;
 END IF;
 public_profile:=to_jsonb(p)-'tenant_id';
 INSERT INTO language_file_import_profile_revisions(id,tenant_id,profile_id,version,actor_id,api_key_id,client_key,request_hash,payload) VALUES(gen_random_uuid(),t,p.id,p.version,uid,kid,(v->>'client_key')::uuid,v->>'request_hash',jsonb_build_object('profile',public_profile,'request',request,'expected_version',expected));
 PERFORM language_file_import_budget(t);PERFORM language_file_import_require(uid,kid,false);RETURN jsonb_build_object('profile',public_profile,'reused',false);
END $$;

CREATE FUNCTION language_file_import_row_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p language_file_import_previews%ROWTYPE;e language_file_import_executions%ROWTYPE;r jsonb;BEGIN
 IF TG_TABLE_NAME='language_file_import_rows' THEN
  SELECT * INTO p FROM language_file_import_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);r:=p.payload->'rows'->NEW.index;
  IF p.id IS NULL OR r IS NULL OR NEW.payload IS DISTINCT FROM r OR NEW.product_id IS DISTINCT FROM(r->>'product_id')::uuid OR NEW.locale IS DISTINCT FROM r->>'locale' OR NEW.core_preview_id IS DISTINCT FROM p.core_preview_id OR NEW.core_index IS DISTINCT FROM(r->>'core_index')::int OR NEW.receipt_id IS DISTINCT FROM(r->>'receipt_id')::uuid THEN RAISE EXCEPTION 'Wiersz pliku języków poza pełnym zakresem' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM language_file_import_executions WHERE(tenant_id,id,preview_id)=(NEW.tenant_id,NEW.execution_id,NEW.preview_id);r:=e.payload->'rows'->NEW.index;
  IF e.id IS NULL OR r IS NULL OR NEW.payload IS DISTINCT FROM r OR NEW.product_id IS DISTINCT FROM(r->>'product_id')::uuid OR NEW.locale IS DISTINCT FROM r->>'locale' OR NEW.receipt_id IS DISTINCT FROM(r->>'core_receipt_id')::uuid THEN RAISE EXCEPTION 'Receipt pliku języków poza pełnym zakresem' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION language_file_import_head_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.id IS DISTINCT FROM(NEW.payload->>'id')::uuid OR NEW.client_key IS DISTINCT FROM(NEW.payload->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM NEW.payload->>'request_hash' OR NEW.scope_hash IS DISTINCT FROM NEW.payload->>'scope_hash' OR NEW.source IS DISTINCT FROM NEW.payload->>'source' OR NEW.core_preview_id IS DISTINCT FROM(NEW.payload->>'core_preview_id')::uuid THEN RAISE EXCEPTION 'Inny zakres głowy importu języków' USING ERRCODE='23514';END IF;
 PERFORM language_file_import_require(NEW.actor_id,NEW.api_key_id,false);
 IF TG_TABLE_NAME='language_file_import_previews' THEN PERFORM language_file_import_validate_preview(NEW.payload,NEW.actor_id,NEW.api_key_id,true,true);
 ELSE
  IF NEW.preview_id IS DISTINCT FROM(NEW.payload->>'preview_id')::uuid OR NEW.core_execution_id IS DISTINCT FROM(NEW.payload->>'core_execution_id')::uuid OR NEW.top_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION 'Inna transakcja wykonania języków' USING ERRCODE='23514';END IF;
  PERFORM language_file_import_validate_execution(NEW.payload,NEW.actor_id,NEW.api_key_id);
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION language_file_import_admission_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE p language_file_import_previews%ROWTYPE;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Prywatna zgoda importu języków jest niezmienna' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM language_file_import_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR p.id IS NULL OR p.core_preview_id IS NULL OR(p.payload#>>'{summary,ready}')::boolean IS NOT TRUE OR NEW.actor_id IS DISTINCT FROM p.actor_id OR NEW.api_key_id IS DISTINCT FROM p.api_key_id OR NEW.top_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION 'Nieprawdziwa prywatna zgoda importu języków' USING ERRCODE='23514';END IF;
 PERFORM language_file_import_require(NEW.actor_id,NEW.api_key_id,false);RETURN NEW;
END $$;
CREATE FUNCTION language_file_import_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=NEW.tenant_id;p language_file_import_previews%ROWTYPE;e language_file_import_executions%ROWTYPE;a language_file_import_admissions%ROWTYPE;BEGIN
 IF TG_TABLE_NAME='language_file_import_previews' THEN
  SELECT * INTO p FROM language_file_import_previews WHERE(tenant_id,id)=(t,NEW.id);
  IF(SELECT count(*) FROM language_file_import_rows WHERE(tenant_id,preview_id)=(t,p.id))<>jsonb_array_length(p.payload->'rows') THEN RAISE EXCEPTION 'Niekompletny podgląd pliku języków' USING ERRCODE='23514';END IF;
  PERFORM language_file_import_require(p.actor_id,p.api_key_id,false);
 ELSIF TG_TABLE_NAME IN('product_translation_bulk_edit_executions','language_file_import_admissions','language_file_import_executions') THEN
  IF TG_TABLE_NAME='product_translation_bulk_edit_executions' THEN
   SELECT * INTO p FROM language_file_import_previews WHERE(tenant_id,core_preview_id)=(t,NEW.preview_id);
   IF p.id IS NULL THEN RETURN NEW;END IF;
   SELECT * INTO e FROM language_file_import_executions WHERE(tenant_id,core_execution_id)=(t,NEW.id);
  ELSIF TG_TABLE_NAME='language_file_import_admissions' THEN SELECT * INTO e FROM language_file_import_executions WHERE(tenant_id,id)=(t,NEW.execution_id);
  ELSE SELECT * INTO e FROM language_file_import_executions WHERE(tenant_id,id)=(t,NEW.id);END IF;
  SELECT * INTO p FROM language_file_import_previews WHERE(tenant_id,id)=(t,e.preview_id);
  SELECT * INTO a FROM language_file_import_admissions WHERE(tenant_id,execution_id,preview_id)=(t,e.id,p.id);
  IF e.id IS NULL OR p.id IS NULL OR a.execution_id IS NULL OR e.actor_id IS DISTINCT FROM p.actor_id OR e.api_key_id IS DISTINCT FROM p.api_key_id OR a.actor_id IS DISTINCT FROM e.actor_id OR a.api_key_id IS DISTINCT FROM e.api_key_id OR a.top_xid IS DISTINCT FROM pg_current_xact_id() OR a.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR e.top_xid IS DISTINCT FROM a.top_xid OR e.transaction_started_at IS DISTINCT FROM a.transaction_started_at OR e.core_preview_id IS DISTINCT FROM p.core_preview_id OR(SELECT count(*) FROM language_file_import_execution_rows WHERE(tenant_id,execution_id)=(t,e.id))<>jsonb_array_length(e.payload->'rows') OR(SELECT count(*) FROM product_translation_bulk_edit_execution_rows WHERE(tenant_id,execution_id)=(t,e.core_execution_id))<>jsonb_array_length(e.payload->'rows') THEN RAISE EXCEPTION 'Brak kompletnego powiązanego wykonania pliku języków' USING ERRCODE='23514';END IF;
  -- Truth is checked before immutable parent insertion. Mandatory same-TX seals
  -- keep that proof stable; each finalizer still rechecks fresh unpinned IAM.
  IF current_setting('session_replication_role')<>'origin' OR NOT language_file_import_guards() OR EXISTS(SELECT 1 FROM unnest(ARRAY['products','product_translations','product_sku_aliases','product_rules','product_translation_bulk_edit_previews','product_translation_bulk_edit_rows','product_translation_bulk_edit_executions','product_translation_bulk_edit_execution_rows','language_file_import_admissions','language_file_import_core_witnesses']) tbl WHERE NOT EXISTS(SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid=to_regclass('public.'||tbl) AND tg.tgname='language_file_import_seal' AND tg.tgenabled='O' AND tg.tgfoid='language_file_import_seal()'::regprocedure)) THEN RAISE EXCEPTION 'Brak ochrony końcowego wyniku pliku języków' USING ERRCODE='23514';END IF;
  PERFORM language_file_import_require(e.actor_id,e.api_key_id,false);
 ELSE
  IF NOT EXISTS(SELECT 1 FROM language_file_import_profiles pr JOIN language_file_import_profile_revisions rr ON(rr.tenant_id,rr.profile_id,rr.version)=(pr.tenant_id,pr.id,pr.version) WHERE pr.tenant_id=t AND pr.id=(CASE WHEN TG_TABLE_NAME='language_file_import_profiles' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'profile_id' END)::uuid AND rr.payload->'profile' IS NOT DISTINCT FROM to_jsonb(pr)-'tenant_id') THEN RAISE EXCEPTION 'Niekompletny profil importu języków' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='language_file_import_profile_revisions' THEN PERFORM language_file_import_require(NEW.actor_id,NEW.api_key_id,false);END IF;
 END IF;
 PERFORM language_file_import_budget(t);RETURN NEW;
END $$;
CREATE FUNCTION language_file_import_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE oldtenant uuid;newtenant uuid;BEGIN
 IF TG_OP<>'INSERT' THEN oldtenant:=OLD.tenant_id;END IF;IF TG_OP<>'DELETE' THEN newtenant:=NEW.tenant_id;END IF;
 IF EXISTS(SELECT 1 FROM language_file_import_executions e WHERE e.tenant_id IN(oldtenant,newtenant) AND e.top_xid=pg_current_xact_id() AND e.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Transakcja zakończonego importu języków jest zapieczętowana' USING ERRCODE='23514';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['language_file_import_previews','language_file_import_rows','language_file_import_executions','language_file_import_execution_rows','language_file_import_profile_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER language_file_import_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION language_file_import_immutable()',n);
  EXECUTE format('CREATE TRIGGER language_file_import_bytes BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION language_file_import_bytes()',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['language_file_import_previews','language_file_import_executions'] LOOP EXECUTE format('CREATE TRIGGER language_file_import_head_scope BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION language_file_import_head_scope()',n);END LOOP;
 FOREACH n IN ARRAY ARRAY['language_file_import_rows','language_file_import_execution_rows'] LOOP EXECUTE format('CREATE TRIGGER language_file_import_row_scope BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION language_file_import_row_scope()',n);END LOOP;
 FOREACH n IN ARRAY ARRAY['language_file_import_previews','language_file_import_executions','language_file_import_profile_revisions','language_file_import_admissions'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER language_file_import_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION language_file_import_complete()',n);END LOOP;
 CREATE CONSTRAINT TRIGGER language_file_import_profile_complete AFTER INSERT OR UPDATE ON language_file_import_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION language_file_import_complete();
 CREATE CONSTRAINT TRIGGER language_file_import_core_complete AFTER INSERT ON product_translation_bulk_edit_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION language_file_import_complete();
 CREATE TRIGGER language_file_import_admission_scope BEFORE INSERT OR UPDATE OR DELETE ON language_file_import_admissions FOR EACH ROW EXECUTE FUNCTION language_file_import_admission_scope();
 CREATE TRIGGER language_file_import_immutable BEFORE UPDATE OR DELETE ON language_file_import_core_witnesses FOR EACH ROW EXECUTE FUNCTION language_file_import_immutable();
 FOREACH n IN ARRAY ARRAY['products','product_translations','product_sku_aliases','product_translation_bulk_edit_previews','product_translation_bulk_edit_rows','product_translation_bulk_edit_executions','product_translation_bulk_edit_execution_rows','language_file_import_admissions','language_file_import_core_witnesses'] LOOP EXECUTE format('CREATE TRIGGER language_file_import_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION language_file_import_seal()',n);END LOOP;
 IF to_regclass('public.product_rules') IS NOT NULL THEN CREATE TRIGGER language_file_import_seal BEFORE INSERT OR UPDATE OR DELETE ON product_rules FOR EACH ROW EXECUTE FUNCTION language_file_import_seal();END IF;
END $$;
CREATE FUNCTION language_file_import_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k record;valid boolean:=true;allowed boolean;canwrite boolean;BEGIN
 IF t IS NULL OR uid IS NULL THEN RETURN jsonb_build_object('role',null,'allowed',false,'key_valid',false,'can_write',false);END IF;
 IF pin THEN SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;ELSE SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid;END IF;
 allowed:=coalesce(r IN('admin','operator','viewer'),false);canwrite:=coalesce(r='admin',false);
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid FOR SHARE;ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=t AND id=kid AND user_id=uid;END IF;
  valid:=FOUND AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp());
  allowed:=allowed AND valid AND coalesce(k.scopes @> ARRAY['products:read']::text[],false);canwrite:=canwrite AND allowed AND coalesce(k.scopes @> ARRAY['products:write']::text[],false);
 END IF;
 RETURN jsonb_build_object('role',r,'allowed',allowed AND(NOT writing OR canwrite),'key_valid',valid,'can_write',canwrite);
END $$;
CREATE FUNCTION language_file_import_require(uid uuid,kid uuid,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE g jsonb;BEGIN
 g:=language_file_import_access(uid,kid,true,pin);
 IF(g->>'key_valid')::boolean IS FALSE THEN RAISE EXCEPTION 'Wycofany klucz importu języków' USING ERRCODE='23514';END IF;
 IF(g->>'allowed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktualnej zgody na import języków' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION language_file_import_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT 1 FROM migrations WHERE name='117_language_file_imports') $$;
CREATE FUNCTION language_file_import_utf16_key(v text) RETURNS integer[] LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$ DECLARE key integer[]:=ARRAY[]::integer[];i integer;n integer;BEGIN
 FOR i IN 1..char_length(v) LOOP n:=ascii(substr(v,i,1));IF n>65535 THEN n:=n-65536;key:=key||ARRAY[55296+n/1024,56320+n%1024];ELSE key:=array_append(key,n);END IF;END LOOP;RETURN key;
END $$;
CREATE FUNCTION language_file_import_array_index(v text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$ BEGIN
 IF v~'^(0|[1-9][0-9]{0,9})$' THEN IF v::numeric<4294967295 THEN RETURN v::numeric;END IF;END IF;RETURN NULL;
END $$;
CREATE FUNCTION language_file_import_canonical(j jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$ DECLARE v text;BEGIN
 IF jsonb_typeof(j)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||language_file_import_canonical(value),',' ORDER BY CASE WHEN language_file_import_array_index(k) IS NULL THEN 1 ELSE 0 END,language_file_import_array_index(k),language_file_import_utf16_key(k)),'')||'}' INTO v FROM jsonb_each(j) e(k,value);
 ELSIF jsonb_typeof(j)='array' THEN SELECT '['||coalesce(string_agg(language_file_import_canonical(value),',' ORDER BY ord),'')||']' INTO v FROM jsonb_array_elements(j) WITH ORDINALITY e(value,ord);
 ELSE v:=j::text;END IF;RETURN v;
END $$;
CREATE FUNCTION language_file_import_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$ SELECT encode(sha256(convert_to(language_file_import_canonical(j),'UTF8')),'hex') $$;
CREATE FUNCTION language_file_import_text_valid(v text,isname boolean) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(v IS NOT NULL AND v !~ ('[<>'||chr(1)||'-'||chr(8)||chr(11)||chr(12)||chr(14)||'-'||chr(31)||']') AND CASE WHEN isname THEN char_length(v) BETWEEN 2 AND 200 AND length(btrim(v))>0 AND v !~ E'[\r\n]' ELSE char_length(v)<=10000 END,false)
$$;
CREATE FUNCTION language_file_import_definition(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$ DECLARE l jsonb;m jsonb;k text;prev text:='';BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?& ARRAY['format','mode','delimiter','spreadsheet_safe','spreadsheet_text_prefix','identity','mapping','languages'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) x WHERE x NOT IN('format','mode','delimiter','spreadsheet_safe','spreadsheet_text_prefix','identity','mapping','languages'))
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['format','mode','delimiter','identity','spreadsheet_text_prefix']) u(field_name) WHERE jsonb_typeof(d->u.field_name) IS DISTINCT FROM 'string') OR d->>'format' NOT IN('csv','xml') OR d->>'mode' NOT IN('columns','translations_json') OR d->>'delimiter' NOT IN(';',',',chr(9),'|') OR d->>'identity' NOT IN('uuid','sku','historical_sku','ean','name') OR d->>'spreadsheet_text_prefix' NOT IN('reject_ambiguous','decode_export','preserve_literal') OR jsonb_typeof(d->'spreadsheet_safe') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'mapping') IS DISTINCT FROM 'object' OR jsonb_typeof(d->'languages') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'languages') NOT BETWEEN 1 AND 6 THEN RETURN false;END IF;
 FOR k,m IN SELECT key,value FROM jsonb_each(d->'mapping') LOOP IF k NOT IN('identity','translations_json') OR jsonb_typeof(m) IS DISTINCT FROM 'string' OR length(btrim(m#>>'{}'))=0 OR char_length(m#>>'{}')>200 OR m#>>'{}' IN('__proto__','prototype','constructor') THEN RETURN false;END IF;END LOOP;
 IF NOT d->'mapping' ? 'identity' THEN RETURN false;END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(d->'languages') LOOP
  IF jsonb_typeof(l) IS DISTINCT FROM 'object' OR NOT l ?& ARRAY['locale','empty_name','empty_description'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(l) x WHERE x NOT IN('locale','empty_name','empty_description','mapping')) OR EXISTS(SELECT 1 FROM unnest(ARRAY['locale','empty_name','empty_description']) u(field_name) WHERE jsonb_typeof(l->u.field_name) IS DISTINCT FROM 'string') OR l->>'locale' !~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$' OR length(l->>'locale')>40 OR l->>'locale'<=prev OR l->>'empty_name' IS DISTINCT FROM 'preserve' OR l->>'empty_description' NOT IN('preserve','clear') THEN RETURN false;END IF;prev:=l->>'locale';
  IF d->>'mode'='columns' THEN
   IF d->>'format'<>'csv' OR d->'mapping' ? 'translations_json' OR jsonb_typeof(l->'mapping') IS DISTINCT FROM 'object' OR NOT EXISTS(SELECT 1 FROM jsonb_object_keys(l->'mapping')) THEN RETURN false;END IF;
   FOR k,m IN SELECT key,value FROM jsonb_each(l->'mapping') LOOP IF k NOT IN('name','description','operation') OR jsonb_typeof(m) IS DISTINCT FROM 'string' OR length(btrim(m#>>'{}'))=0 OR char_length(m#>>'{}')>200 OR m#>>'{}' IN('__proto__','prototype','constructor') THEN RETURN false;END IF;END LOOP;
  ELSIF NOT d->'mapping' ? 'translations_json' OR l ? 'mapping' THEN RETURN false;END IF;
 END LOOP;
 IF d->>'format'='xml' AND(d->>'delimiter'<>';' OR(d->>'spreadsheet_safe')::boolean OR d->'mapping'->>'translations_json' IS DISTINCT FROM 'translations_json' OR d->'mapping'->>'identity' IS DISTINCT FROM (CASE d->>'identity' WHEN 'uuid' THEN 'id' WHEN 'historical_sku' THEN 'sku' ELSE d->>'identity' END)) THEN RETURN false;END IF;
 RETURN true;
END $$;

CREATE FUNCTION language_file_import_xml_value(x xml,entry boolean DEFAULT false,depth integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE ty text;child xml;k text;answer jsonb;v text;attr xml;name text;BEGIN
 IF depth>16 THEN RAISE EXCEPTION 'Niedozwolona struktura XML języków' USING ERRCODE='23514';END IF;
 -- Attribute names are checked on the original element (including namespaces).
 IF cardinality(xpath('/*/@*[not(name()="type" or name()="nil" or (name()="key"))]',x))>0 OR (NOT entry AND cardinality(xpath('/*/@key',x))>0) OR cardinality(xpath('/*/namespace::*[name()!="xml"]',x))>0 THEN RAISE EXCEPTION 'Niedozwolony atrybut XML języków' USING ERRCODE='23514';END IF;
 ty:=(xpath('string(/*/@type)',x))[1]::text;SELECT str INTO v FROM XMLTABLE('/*' PASSING x COLUMNS str text PATH 'string(.)');
 IF cardinality(xpath('/*/@nil',x))>0 THEN
  IF (xpath('string(/*/@nil)',x))[1]::text<>'true' OR ty<>'' OR cardinality(xpath('/*/*',x))>0 OR v<>'' THEN RAISE EXCEPTION 'Niepoprawne null XML języków' USING ERRCODE='23514';END IF;RETURN 'null';
 END IF;
 IF ty NOT IN('string','number','boolean','array','object') THEN RAISE EXCEPTION 'Niepoprawny typ XML języków' USING ERRCODE='23514';END IF;
 IF ty IN('array','object') THEN
  IF cardinality(xpath('/*/text()[normalize-space(.)!=""]',x))>0 THEN RAISE EXCEPTION 'Dodatkowy tekst XML języków' USING ERRCODE='23514';END IF;
  answer:=CASE WHEN ty='array' THEN '[]'::jsonb ELSE '{}'::jsonb END;
  FOREACH child IN ARRAY xpath('/*/*',x) LOOP
   name:=(xpath('local-name(/*)',child))[1]::text;
   IF ty='array' THEN IF name<>'item' THEN RAISE EXCEPTION 'Tablica XML języków wymaga item' USING ERRCODE='23514';END IF;answer:=answer||jsonb_build_array(language_file_import_xml_value(child,false,depth+1));
   ELSE SELECT str INTO k FROM XMLTABLE('/*' PASSING child COLUMNS str text PATH '@key');IF name<>'entry' OR cardinality(xpath('/*/@key',child))<>1 OR k IN('__proto__','prototype','constructor') OR answer ? k THEN RAISE EXCEPTION 'Powtórzony klucz XML języków' USING ERRCODE='23514';END IF;answer:=answer||jsonb_build_object(k,language_file_import_xml_value(child,true,depth+1));END IF;
  END LOOP;RETURN answer;
 END IF;
 IF cardinality(xpath('/*/*',x))>0 THEN RAISE EXCEPTION 'Skalar XML języków zawiera tagi' USING ERRCODE='23514';END IF;
 IF ty='boolean' THEN IF v NOT IN('true','false') THEN RAISE EXCEPTION 'Niepoprawny boolean XML języków' USING ERRCODE='23514';END IF;RETURN v::jsonb;
 ELSIF ty='number' THEN IF v !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN RAISE EXCEPTION 'Niepoprawna liczba XML języków' USING ERRCODE='23514';END IF;RETURN v::jsonb;END IF;
 RETURN to_jsonb(v);
END $$;
CREATE FUNCTION language_file_import_source(request jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE content text:=request->>'content';d jsonb:=request->'definition';delim text:=d->>'delimiter';answer jsonb:='[]';records jsonb:='[]';cells jsonb:='[]';headers jsonb;obj jsonb;cell text:='';quoted boolean:=false;closed boolean:=false;skip_lf boolean:=false;i integer:=1;j integer;ch text;k text;doc xml;node xml;field xml;required text[];rootcurrency text;BEGIN
 IF jsonb_typeof(request->'content') IS DISTINCT FROM 'string' OR octet_length(content)>2097152 OR NOT language_file_import_definition(d) THEN RAISE EXCEPTION 'Niepoprawne źródło importu języków' USING ERRCODE='23514';END IF;
 content:=regexp_replace(content,'^'||chr(65279),'');
 IF d->>'format'='xml' THEN
  IF content~*'<!\s*(DOCTYPE|ENTITY)' OR regexp_replace(content,'^\s*<\?xml[^?]*\?>','')~'<\?' THEN RAISE EXCEPTION 'DTD i instrukcje XML języków są zabronione' USING ERRCODE='23514';END IF;
  doc:=xmlparse(document content);rootcurrency:=(xpath('string(/catalog/@currency)',doc))[1]::text;
  IF cardinality(xpath('/catalog',doc))<>1 OR rootcurrency NOT IN('PLN','EUR','USD','GBP','CZK') OR cardinality(xpath('/catalog/@*[not(name()="currency" or name()="price_source")]',doc))>0 OR (cardinality(xpath('/catalog/@price_source',doc))>0 AND (xpath('string(/catalog/@price_source)',doc))[1]::text<>'catalog') OR cardinality(xpath('//*[contains(name(),":") or name()="__proto__" or name()="prototype" or name()="constructor"]',doc))>0 OR cardinality(xpath('/*/namespace::*[name()!="xml"]',doc))>0 OR cardinality(xpath('/catalog/*[name()!="product"]|/catalog/text()[normalize-space(.)!=""]|/catalog/product/@*|/catalog/product/text()[normalize-space(.)!=""]',doc))>0 OR cardinality(xpath('//node()',doc))>100000 THEN RAISE EXCEPTION 'Niedozwolony katalog XML języków' USING ERRCODE='23514';END IF;
  FOREACH node IN ARRAY xpath('/catalog/product',doc) LOOP
   obj:='{}';FOREACH field IN ARRAY xpath('/*/*',node) LOOP k:=(xpath('local-name(/*)',field))[1]::text;IF obj ? k THEN RAISE EXCEPTION 'Powtórzone pole XML języków' USING ERRCODE='23514';END IF;obj:=obj||jsonb_build_object(k,language_file_import_xml_value(field));END LOOP;
   IF NOT obj ? (d#>>'{mapping,identity}') OR NOT obj ? (d#>>'{mapping,translations_json}') THEN RAISE EXCEPTION 'Brak mapowanego pola XML języków' USING ERRCODE='23514';END IF;
   answer:=answer||jsonb_build_array(jsonb_build_object('raw',obj,'width_valid',true));
  END LOOP;
 ELSE
  -- Split UTF-8 once: indexed substr/length rescans the whole growing prefix.
  -- A second quote after a close resumes the quoted field as an escaped quote.
  FOREACH ch IN ARRAY string_to_array(content,NULL) LOOP
   IF skip_lf THEN skip_lf:=false;IF ch=chr(10) THEN CONTINUE;END IF;END IF;
   IF quoted THEN IF ch='"' THEN quoted:=false;closed:=true;ELSE cell:=cell||ch;END IF;
   ELSIF closed AND ch='"' THEN cell:=cell||'"';quoted:=true;closed:=false;
   ELSIF ch=delim THEN cells:=cells||jsonb_build_array(cell);cell:='';closed:=false;
   ELSIF ch IN(chr(10),chr(13)) THEN skip_lf:=ch=chr(13);records:=records||jsonb_build_array(cells||jsonb_build_array(cell));cells:='[]';cell:='';closed:=false;
   ELSIF ch='"' THEN IF cell<>'' OR closed THEN RAISE EXCEPTION 'Niepoprawny CSV języków' USING ERRCODE='23514';END IF;quoted:=true;
   ELSE IF closed THEN RAISE EXCEPTION 'Niepoprawny CSV języków' USING ERRCODE='23514';END IF;cell:=cell||ch;END IF;
  END LOOP;
  IF quoted THEN RAISE EXCEPTION 'Niepoprawny CSV języków' USING ERRCODE='23514';END IF;IF cell<>'' OR jsonb_array_length(cells)>0 OR closed THEN records:=records||jsonb_build_array(cells||jsonb_build_array(cell));END IF;
  headers:=records->0;
  IF jsonb_typeof(headers) IS DISTINCT FROM 'array' OR jsonb_array_length(headers)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(headers) h WHERE length(btrim(h))=0 OR h IN('__proto__','prototype','constructor')) OR (SELECT count(DISTINCT lower(h))<>count(*) FROM jsonb_array_elements_text(headers) h) THEN RAISE EXCEPTION 'Niepoprawne nagłówki CSV języków' USING ERRCODE='23514';END IF;
  required:=ARRAY[d#>>'{mapping,identity}'];IF d->>'mode'='translations_json' THEN required:=required||ARRAY[d#>>'{mapping,translations_json}'];ELSE SELECT required||coalesce(array_agg(m.value#>>'{}'),ARRAY[]::text[]) INTO required FROM jsonb_array_elements(d->'languages') l CROSS JOIN LATERAL jsonb_each(l->'mapping') m;END IF;
  IF EXISTS(SELECT 1 FROM unnest(required) u(field_name) WHERE NOT headers ? u.field_name) THEN RAISE EXCEPTION 'Brak mapowanego nagłówka CSV języków' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(records)<2 OR jsonb_array_length(records)>501 THEN RAISE EXCEPTION 'Plik języków wymaga 1–500 produktów' USING ERRCODE='23514';END IF;
  FOR i IN 1..jsonb_array_length(records)-1 LOOP obj:='{}';FOR j IN 0..jsonb_array_length(headers)-1 LOOP IF j<jsonb_array_length(records->i) THEN obj:=obj||jsonb_build_object(headers->>j,records->i->j);END IF;END LOOP;answer:=answer||jsonb_build_array(jsonb_build_object('raw',obj,'width_valid',jsonb_array_length(records->i)=jsonb_array_length(headers)));END LOOP;
 END IF;
 IF jsonb_array_length(answer) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Plik języków wymaga 1–500 produktów' USING ERRCODE='23514';END IF;RETURN answer;
END $$;
CREATE FUNCTION language_file_import_decode(v jsonb,field text,d jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$ DECLARE txt text;unprefixed text;ambiguous boolean;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('value',coalesce(v,'null'),'valid',false);END IF;txt:=v#>>'{}';
 IF d->>'format'='csv' AND(d->>'spreadsheet_safe')::boolean AND left(txt,1)=chr(39) THEN
  unprefixed:=substr(txt,2);IF unprefixed<>'' AND field IN('uuid','sku','historical_sku','ean') THEN txt:=unprefixed;
  ELSIF unprefixed<>'' THEN ambiguous:=unprefixed~'^[[:space:]]*[=+@-]' OR left(unprefixed,1) IN(chr(9),chr(10),chr(13)) OR unprefixed~'^[[:space:]]*[+-]?[0-9]+([.,][0-9]+)?([eE][+-]?[0-9]+)?[[:space:]]*$';
   IF ambiguous AND d->>'spreadsheet_text_prefix'='reject_ambiguous' THEN RETURN jsonb_build_object('value',txt,'valid',false);ELSIF ambiguous AND d->>'spreadsheet_text_prefix'='decode_export' THEN txt:=unprefixed;END IF;
  END IF;
 END IF;RETURN jsonb_build_object('value',txt,'valid',true);
END $$;
CREATE FUNCTION language_file_import_cell(raw jsonb,l jsonb,d jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE operation text:='';patch jsonb:='{}';entry jsonb;entries jsonb;v jsonb;dec jsonb;field text;valid boolean:=true;selected jsonb;skipped jsonb:='[]';versions jsonb:='{}';seen text[]:=ARRAY[]::text[];lc text;BEGIN
 IF d->>'mode'='translations_json' THEN
  entries:=raw->(d#>>'{mapping,translations_json}');
  IF d->>'format'='csv' THEN BEGIN entries:=(entries#>>'{}')::jsonb;EXCEPTION WHEN others THEN entries:='null';END;END IF;
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('operation','none','valid',false,'skipped',skipped,'versions',versions);END IF;
  IF jsonb_array_length(entries)>100 THEN RETURN jsonb_build_object('operation','none','valid',false,'skipped',skipped,'versions',versions);END IF;
  SELECT jsonb_agg(x->'locale') INTO selected FROM jsonb_array_elements(d->'languages') x;
  FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
   IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN valid:=false;CONTINUE;END IF;lc:=lower(entry->>'locale');
   IF NOT entry ?& ARRAY['locale','name','description'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(entry) k WHERE k NOT IN('locale','name','description','version')) OR jsonb_typeof(entry->'locale') IS DISTINCT FROM 'string' OR lc !~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$' OR length(lc)>40 OR lc=ANY(seen) OR jsonb_typeof(entry->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(entry->'description') IS DISTINCT FROM 'string' OR (entry->>'name'<>'' AND NOT language_file_import_text_valid(entry->>'name',true)) OR NOT language_file_import_text_valid(entry->>'description',false) THEN valid:=false;END IF;
   IF entry ? 'version' THEN IF jsonb_typeof(entry->'version') IS DISTINCT FROM 'number' OR entry->>'version' !~ '^[1-9][0-9]*$' OR length(entry->>'version')>10 THEN valid:=false;ELSIF(entry->>'version')::numeric>2147483647 THEN valid:=false;END IF;END IF;
   IF lc IS NULL THEN valid:=false;CONTINUE;END IF;
   seen:=array_append(seen,lc);versions:=versions||jsonb_build_object(lc,coalesce(entry->'version','null'));IF NOT selected ? lc THEN skipped:=skipped||jsonb_build_array(lc);END IF;
   IF lc=l->>'locale' THEN v:=entry;END IF;
  END LOOP;
  IF NOT valid THEN RETURN jsonb_build_object('operation','none','valid',false,'skipped','[]'::jsonb,'versions','{}'::jsonb);END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY x#>>'{}'),'[]') INTO skipped FROM jsonb_array_elements(skipped) x;
  IF v IS NOT NULL THEN IF v->>'name'<>'' THEN patch:=patch||jsonb_build_object('name',v->'name');END IF;IF v->>'description'<>'' OR l->>'empty_description'='clear' THEN patch:=patch||jsonb_build_object('description',v->'description');END IF;END IF;
 ELSE
  IF l->'mapping' ? 'operation' THEN IF jsonb_typeof(raw->(l#>>'{mapping,operation}')) IS DISTINCT FROM 'string' THEN valid:=false;ELSE operation:=raw->>(l#>>'{mapping,operation}');END IF;END IF;
  IF operation NOT IN('','none','set','remove') OR NOT valid THEN RETURN jsonb_build_object('operation','none','valid',false,'skipped',skipped,'versions',versions);END IF;
  IF operation='none' THEN RETURN jsonb_build_object('operation','none','valid',true,'skipped',skipped,'versions',versions);END IF;
  FOREACH field IN ARRAY ARRAY['name','description'] LOOP
   IF NOT l->'mapping' ? field THEN CONTINUE;END IF;
   IF jsonb_typeof(raw->(l->'mapping'->>field)) IS DISTINCT FROM 'string' THEN valid:=false;CONTINUE;END IF;
   dec:=language_file_import_decode(raw->(l->'mapping'->>field),field,d);valid:=valid AND(dec->>'valid')::boolean;
   IF dec->>'value'<>'' OR(field='description' AND l->>'empty_description'='clear') THEN patch:=patch||jsonb_build_object(field,dec->'value');END IF;
   IF operation='remove' AND raw->(l->'mapping'->>field) IS DISTINCT FROM '""'::jsonb THEN valid:=false;END IF;
  END LOOP;
  IF operation='remove' THEN RETURN jsonb_build_object('operation','remove','valid',valid,'skipped',skipped,'versions',versions);END IF;
  IF patch='{}' THEN RETURN jsonb_build_object('operation','none','valid',valid AND operation<>'set','skipped',skipped,'versions',versions);END IF;
  IF patch ? 'name' THEN valid:=valid AND language_file_import_text_valid(patch->>'name',true);END IF;IF patch ? 'description' THEN valid:=valid AND language_file_import_text_valid(patch->>'description',false);END IF;
 END IF;
 RETURN jsonb_build_object('operation',CASE WHEN patch='{}' THEN 'none' ELSE 'set' END,'patch',patch,'valid',valid,'skipped',skipped,'versions',versions);
END $$;

CREATE FUNCTION language_file_import_snapshot(tr jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN tr IS NULL THEN jsonb_build_object('present',false,'version',null,'name',null,'description',null,'provenance',null)
 ELSE jsonb_build_object('present',true,'version',tr->'version','name',tr->'name','description',tr->'description','provenance',jsonb_build_object('kind',CASE WHEN tr->>'manual_receipt_id' IS NOT NULL THEN 'manual' WHEN tr->>'ai_draft_id' IS NOT NULL THEN 'ai' ELSE 'deepl' END,'id',coalesce(tr->>'manual_receipt_id',tr->>'ai_draft_id',tr->>'deepl_draft_id'))) END
$$;
CREATE FUNCTION language_file_import_summary(rows jsonb,whole boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('source_rows',count(DISTINCT r->>'source_index'),'product_count',count(DISTINCT r->>'product_id'),'total_pairs',count(*),
 'changed_pairs',count(*) FILTER(WHERE r->>'status'='changed'),'unchanged_pairs',count(*) FILTER(WHERE r->>'status'='unchanged'),
 'skipped_pairs',count(*) FILTER(WHERE r->>'status'='unchanged' AND r#>>'{input,operation}'='none'),'changed_products',count(DISTINCT r->>'product_id') FILTER(WHERE r->>'status'='changed'),
 'invalid',count(*) FILTER(WHERE r->>'status'='invalid'),'conflicts',count(*) FILTER(WHERE r->>'status'='conflict'),
 'missing_after_count',count(*) FILTER(WHERE r#>>'{after,present}'='false'),
 'skipped_locale_entries',CASE WHEN whole THEN coalesce((SELECT sum(jsonb_array_length(coalesce(x->'skipped_locales','[]'))) FROM(SELECT DISTINCT ON(x->>'source_index') x FROM jsonb_array_elements(rows) x ORDER BY x->>'source_index') s),0) ELSE 0 END,
 'ready',count(*) FILTER(WHERE r->>'status' IN('invalid','conflict'))=0) FROM jsonb_array_elements(rows) r
$$;
CREATE FUNCTION language_file_import_per_locale(rows jsonb,d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_agg(jsonb_build_object('locale',l->>'locale')||language_file_import_summary((SELECT coalesce(jsonb_agg(r ORDER BY(r->>'index')::int),'[]') FROM jsonb_array_elements(rows) r WHERE r->>'locale'=l->>'locale'),false) ORDER BY l->>'locale') FROM jsonb_array_elements(d->'languages') l
$$;
CREATE FUNCTION language_file_import_locks(t uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF t IS NULL OR t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Brak zakresu importu języków' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog:'||t,0));PERFORM pg_advisory_xact_lock(hashtextextended('product.rules:'||t,0));PERFORM pg_advisory_xact_lock(hashtextextended('product.translation.bulk:'||t,0));PERFORM pg_advisory_xact_lock(hashtextextended('language.file:'||t,0));
END $$;
CREATE FUNCTION language_file_import_validate_preview(v jsonb,uid uuid,kid uuid,current_facts boolean DEFAULT true,fresh_core boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d jsonb:=v->'definition';sources jsonb;source_record jsonb;raw jsonb;r jsonb;l jsonb;cell jsonb;decoded jsonb;identity text;identities jsonb:='[]';identity_map jsonb;product_map jsonb;translation_map jsonb;core_map jsonb;resolution jsonb;product jsonb;before jsonb;after jsonb;expected_input jsonb;expected_source jsonb;expectedstatus text;name text;description text;key text;index_expected int:=0;source_index int;locale_index int;nlocales int;cp product_translation_bulk_edit_previews%ROWTYPE;cr jsonb;bad boolean;canonical_uuid text;profile language_file_import_profiles%ROWTYPE;BEGIN
 IF t IS NULL OR uid IS NULL OR jsonb_typeof(v) IS DISTINCT FROM 'object' OR jsonb_typeof(v->'request') IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v->'request') k WHERE k NOT IN('client_key','content','definition','profile')) OR v->'request'->'definition' IS DISTINCT FROM d OR NOT language_file_import_definition(d) OR v->>'source' NOT IN('manual','api') OR v->>'client_key' IS DISTINCT FROM v#>>'{request,client_key}' OR v->>'request_hash' IS DISTINCT FROM language_file_import_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'source',v->>'source','kind','preview','parent_id',null,'request',v->'request')) OR v->>'scope_hash' IS DISTINCT FROM language_file_import_hash(v-'scope_hash') THEN RAISE EXCEPTION 'Niepoprawny związany podgląd importu języków' USING ERRCODE='23514';END IF;
 IF octet_length((v->'request')::text)>3145728 OR octet_length(v::text)>33554432 THEN RAISE EXCEPTION 'Limit bajtów podglądu importu języków' USING ERRCODE='P0001';END IF;
 sources:=language_file_import_source(v->'request');nlocales:=jsonb_array_length(d->'languages');
 IF v->>'source_hash' IS DISTINCT FROM encode(sha256(convert_to(v#>>'{request,content}','UTF8')),'hex') OR jsonb_typeof(v->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'rows')<>jsonb_array_length(sources)*nlocales THEN RAISE EXCEPTION 'Niepełna macierz źródła języków' USING ERRCODE='23514';END IF;
 IF v->'request' ? 'profile' AND current_facts AND fresh_core THEN
  SELECT * INTO profile FROM language_file_import_profiles WHERE(tenant_id,id)=(t,(v#>>'{request,profile,id}')::uuid) FOR SHARE;
  IF profile.id IS NULL OR profile.archived OR profile.version IS DISTINCT FROM(v#>>'{request,profile,version}')::int OR profile.definition IS DISTINCT FROM d OR v->'profile_snapshot' IS DISTINCT FROM jsonb_build_object('id',profile.id,'version',profile.version,'name',profile.name) THEN RAISE EXCEPTION 'Profil importu języków zmienił się' USING ERRCODE='23514';END IF;
 ELSIF NOT v->'request' ? 'profile' AND v->'profile_snapshot' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Nieprawdziwy profil importu języków' USING ERRCODE='23514';END IF;
 FOR source_record IN SELECT value FROM jsonb_array_elements(sources) LOOP
  decoded:=language_file_import_decode(source_record->'raw'->(d#>>'{mapping,identity}'),d->>'identity',d);identity:=decoded->>'value';
  IF jsonb_typeof(source_record->'raw'->(d#>>'{mapping,identity}')) IS DISTINCT FROM 'string' OR length(btrim(identity))=0 OR char_length(identity)>200 THEN identity:=NULL;END IF;
  IF d->>'identity'='uuid' THEN IF identity~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN identity:=lower(identity);ELSE identity:=NULL;END IF;END IF;
  identities:=identities||jsonb_build_array(jsonb_build_object('value',identity,'valid',(decoded->>'valid')::boolean AND coalesce(length(btrim(identity))>0 AND char_length(identity)<=200,false)));
 END LOOP;
 -- Resolve <=500 distinct identities once; candidates include inactive/group/bundle.
 WITH wanted AS(SELECT x->>'value' value,count(*) source_count FROM jsonb_array_elements(identities) x WHERE x->>'value' IS NOT NULL GROUP BY x->>'value'),matches AS(
  SELECT w.value,p.id FROM wanted w JOIN products p ON p.tenant_id=t AND p.id::text=w.value WHERE d->>'identity'='uuid'
  UNION ALL SELECT w.value,p.id FROM wanted w JOIN products p ON p.tenant_id=t AND p.sku=w.value WHERE d->>'identity' IN('sku','historical_sku')
  UNION ALL SELECT w.value,a.product_id FROM wanted w JOIN product_sku_aliases a ON a.tenant_id=t AND a.sku=w.value WHERE d->>'identity'='historical_sku'
  UNION ALL SELECT w.value,p.id FROM wanted w JOIN products p ON p.tenant_id=t AND p.ean=w.value AND p.ean<>'' WHERE d->>'identity'='ean'
  UNION ALL SELECT w.value,p.id FROM wanted w JOIN products p ON p.tenant_id=t AND p.name=w.value WHERE d->>'identity'='name'
 ),resolved AS(SELECT w.value,w.source_count,count(DISTINCT m.id) n,min(m.id::text) id FROM wanted w LEFT JOIN matches m USING(value) GROUP BY w.value,w.source_count)
 SELECT coalesce(jsonb_object_agg(value,jsonb_build_object('count',n,'id',id,'source_count',source_count)),'{}') INTO identity_map FROM resolved;
 SELECT coalesce(jsonb_object_agg(p.id::text,to_jsonb(p)),'{}') INTO product_map FROM products p JOIN(SELECT DISTINCT(x->>'product_id')::uuid id FROM jsonb_array_elements(v->'rows') x WHERE x->>'product_id' IS NOT NULL) wanted ON wanted.id=p.id WHERE p.tenant_id=t;
 SELECT coalesce(jsonb_object_agg(tr.product_id::text||':'||tr.locale,to_jsonb(tr)),'{}') INTO translation_map FROM product_translations tr JOIN(SELECT DISTINCT(x->>'product_id')::uuid id FROM jsonb_array_elements(v->'rows') x WHERE x->>'product_id' IS NOT NULL) wanted ON wanted.id=tr.product_id WHERE tr.tenant_id=t AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'languages') lng WHERE lng->>'locale'=tr.locale);
 IF v->>'core_preview_id' IS NOT NULL THEN
  SELECT * INTO cp FROM product_translation_bulk_edit_previews WHERE(tenant_id,id)=(t,(v->>'core_preview_id')::uuid);
  IF cp.id IS NULL OR cp.actor_id IS DISTINCT FROM uid OR cp.source IS DISTINCT FROM v->>'source' OR cp.client_key IS DISTINCT FROM(v->>'id')::uuid OR cp.total<>jsonb_array_length(v->'rows') OR cp.locales IS DISTINCT FROM(SELECT jsonb_agg(x->'locale' ORDER BY x->>'locale') FROM jsonb_array_elements(d->'languages') x) OR (fresh_core AND NOT EXISTS(SELECT 1 FROM language_file_import_core_witnesses w WHERE(w.tenant_id,w.kind,w.id,w.top_xid,w.transaction_started_at)=(t,'preview',cp.id,pg_current_xact_id(),transaction_timestamp()))) THEN RAISE EXCEPTION 'Brak nowego pełnego podglądu core języków' USING ERRCODE='23514';END IF;
  IF current_facts AND cp.rules_snapshot IS DISTINCT FROM language_file_import_rules(t) THEN RAISE EXCEPTION 'Reguły produktu zmieniły się po podglądzie języków' USING ERRCODE='23514';END IF;
  SELECT jsonb_object_agg(index::text,to_jsonb(rr)) INTO core_map FROM product_translation_bulk_edit_rows rr WHERE(tenant_id,preview_id)=(t,cp.id);
  IF (SELECT count(*) FROM jsonb_object_keys(core_map))<>cp.total THEN RAISE EXCEPTION 'Niepełny core języków' USING ERRCODE='23514';END IF;
 END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(v->'rows') LOOP
  source_index:=index_expected/nlocales;locale_index:=index_expected%nlocales;l:=d->'languages'->locale_index;raw:=sources->source_index->'raw';identity:=identities->source_index->>'value';resolution:=identity_map->identity;
  cell:=language_file_import_cell(raw,l,d);
  IF(r->>'index')::int IS DISTINCT FROM index_expected OR(r->>'source_index')::int IS DISTINCT FROM source_index OR r->>'locale' IS DISTINCT FROM l->>'locale' OR r->'raw_cells' IS DISTINCT FROM raw OR jsonb_typeof(r->'errors') IS DISTINCT FROM 'array' OR r->>'status' NOT IN('changed','unchanged','invalid','conflict') OR r#>>'{resolution,identity}' IS DISTINCT FROM d->>'identity' OR r#>>'{resolution,value}' IS DISTINCT FROM identity OR r->'skipped_locales' IS DISTINCT FROM cell->'skipped' OR r->'source_translation_version' IS DISTINCT FROM coalesce(cell->'versions'->(l->>'locale'),'null') THEN RAISE EXCEPTION 'Wiersz językowy nie odpowiada rzeczywistemu źródłu' USING ERRCODE='23514';END IF;index_expected:=index_expected+1;
  bad:=(sources->source_index->>'width_valid')::boolean IS NOT TRUE OR(identities->source_index->>'valid')::boolean IS NOT TRUE OR(cell->>'valid')::boolean IS NOT TRUE OR coalesce((resolution->>'count')::int,0)<>1;
  IF r->>'product_id' IS DISTINCT FROM (CASE WHEN coalesce((resolution->>'count')::int,0)=1 THEN resolution->>'id' ELSE NULL END) THEN RAISE EXCEPTION 'Źródłowy identyfikator języka wskazuje inny produkt' USING ERRCODE='23514';END IF;
  product:=product_map->(r->>'product_id');
  IF r->>'product_id' IS NOT NULL THEN
   IF product IS NULL OR r->>'sku' IS DISTINCT FROM product->>'sku' OR r->>'kind' IS DISTINCT FROM product->>'kind' OR r->>'product_name' IS DISTINCT FROM product->>'name' OR(current_facts AND r->'product_version' IS DISTINCT FROM product->'version') OR r#>>'{resolution,matched_historical_sku}' IS DISTINCT FROM (CASE WHEN d->>'identity'='historical_sku' AND product->>'sku' IS DISTINCT FROM identity THEN 'true' ELSE 'false' END) THEN RAISE EXCEPTION 'Nieprawdziwy własny produkt języka' USING ERRCODE='23514';END IF;
   before:=language_file_import_snapshot(translation_map->((r->>'product_id')||':'||(r->>'locale')));
   IF current_facts AND r->'before' IS DISTINCT FROM before THEN RAISE EXCEPTION 'Początkowa wersja języka zmieniła się' USING ERRCODE='23514';END IF;
   expected_input:=jsonb_build_object('product_id',r->>'product_id','product_version',r->'product_version','locale',r->>'locale','translation_version',r#>'{before,version}','operation',cell->>'operation');IF cell->>'operation'='set' THEN expected_input:=expected_input||jsonb_build_object('patch',cell->'patch');END IF;
   IF r->'input' IS DISTINCT FROM expected_input THEN RAISE EXCEPTION 'Źródłowy tekst lub operacja różni się od core języka' USING ERRCODE='23514';END IF;
  END IF;
  IF cp.id IS NULL THEN IF r->>'status' IS DISTINCT FROM 'invalid' OR r->'after' IS DISTINCT FROM 'null'::jsonb OR r->>'receipt_id' IS NOT NULL OR r->>'core_index' IS NOT NULL OR jsonb_array_length(r->'errors')=0 THEN RAISE EXCEPTION 'Niepoprawny plik języków ma częściowy core' USING ERRCODE='23514';END IF;CONTINUE;END IF;
  IF bad OR r->>'product_id' IS NULL OR(r->>'core_index')::int IS DISTINCT FROM(r->>'index')::int OR(resolution->>'source_count')::int<>1 THEN RAISE EXCEPTION 'Niejednoznaczne źródło języka w core' USING ERRCODE='23514';END IF;
  cr:=core_map->(r->>'core_index');expected_source:=jsonb_build_object('name',product->'name','description',product->'description','category',product->'category','attributes',product->'attributes');
  IF cr IS NULL OR cr->'receipt_id' IS DISTINCT FROM r->'receipt_id' OR cr->'product_id' IS DISTINCT FROM r->'product_id' OR cr->'sku' IS DISTINCT FROM r->'sku' OR cr->'kind' IS DISTINCT FROM r->'kind' OR cr->'product_name' IS DISTINCT FROM r->'product_name' OR cr->'product_version' IS DISTINCT FROM r->'product_version' OR cr->'locale' IS DISTINCT FROM r->'locale' OR cr->'input' IS DISTINCT FROM r->'input' OR cr->'before' IS DISTINCT FROM r->'before' OR coalesce(cr->'after','null') IS DISTINCT FROM r->'after' OR cr->>'status' IS DISTINCT FROM r->>'status' OR cr->'errors' IS DISTINCT FROM r->'errors' OR(current_facts AND cr->'source' IS DISTINCT FROM expected_source) THEN RAISE EXCEPTION 'Macierz pliku różni się od core języków' USING ERRCODE='23514';END IF;
  after:=r->'before';expectedstatus:='unchanged';
  IF cell->>'operation'='remove' AND(r#>>'{before,present}')::boolean THEN after:=language_file_import_snapshot(NULL);expectedstatus:='changed';
  ELSIF cell->>'operation'='set' THEN name:=coalesce(cell#>>'{patch,name}',r#>>'{before,name}');description:=coalesce(cell#>>'{patch,description}',r#>>'{before,description}','');
   IF NOT language_file_import_text_valid(name,true) OR NOT language_file_import_text_valid(description,false) THEN RAISE EXCEPTION 'Niepoprawny końcowy tekst języka' USING ERRCODE='23514';END IF;
   IF(r#>>'{before,present}')::boolean IS NOT TRUE OR name IS DISTINCT FROM r#>>'{before,name}' OR description IS DISTINCT FROM r#>>'{before,description}' THEN
    IF coalesce((r#>>'{before,version}')::int,0)=2147483647 OR(r->>'product_version')::int=2147483647 THEN RAISE EXCEPTION 'Wyczerpana wersja importu języków' USING ERRCODE='23514';END IF;
    after:=jsonb_build_object('present',true,'version',coalesce((r#>>'{before,version}')::int,0)+1,'name',name,'description',description,'provenance',jsonb_build_object('kind','manual','id',r->'receipt_id'));expectedstatus:='changed';
   END IF;
  END IF;
  IF r->'after' IS DISTINCT FROM after OR r->>'status' IS DISTINCT FROM expectedstatus OR r->'errors'<>'[]'::jsonb THEN RAISE EXCEPTION 'Wynik języka nie odpowiada źródłowej operacji' USING ERRCODE='23514';END IF;
 END LOOP;
 IF cp.id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows') source_rows(row_payload) GROUP BY source_rows.row_payload->>'product_id',source_rows.row_payload->>'locale' HAVING count(*)<>1) THEN RAISE EXCEPTION 'Powtórzona para importu języków' USING ERRCODE='23514';END IF;
 IF v->'summary' IS DISTINCT FROM language_file_import_summary(v->'rows',true) OR v->'per_locale' IS DISTINCT FROM language_file_import_per_locale(v->'rows',d) THEN RAISE EXCEPTION 'Nieprawdziwe podsumowanie importu języków' USING ERRCODE='23514';END IF;
 IF cp.id IS NOT NULL AND ROW(cp.total,cp.product_count,cp.changed_pairs,cp.unchanged_pairs,cp.changed_products,cp.invalid,cp.conflicts,cp.missing_after_count,cp.ready) IS DISTINCT FROM ROW((v#>>'{summary,total_pairs}')::int,(v#>>'{summary,product_count}')::int,(v#>>'{summary,changed_pairs}')::int,(v#>>'{summary,unchanged_pairs}')::int,(v#>>'{summary,changed_products}')::int,(v#>>'{summary,invalid}')::int,(v#>>'{summary,conflicts}')::int,(v#>>'{summary,missing_after_count}')::int,(v#>>'{summary,ready}')::boolean) THEN RAISE EXCEPTION 'Podsumowanie core różni się od macierzy języków' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION language_file_import_rules(t uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE rules jsonb;BEGIN
 IF to_regclass('public.product_rules') IS NULL THEN RETURN '[]';END IF;
 PERFORM id FROM product_rules WHERE tenant_id=t AND enabled AND deleted_at IS NULL ORDER BY id FOR SHARE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'event',event,'definition',definition,'approved_by',approved_by,'approved_at',to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY id),'[]') INTO rules FROM product_rules WHERE tenant_id=t AND enabled AND deleted_at IS NULL;RETURN rules;
END $$;
CREATE FUNCTION language_file_import_witness_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF pg_trigger_depth()<2 OR NEW.top_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR(NEW.kind='preview' AND NOT EXISTS(SELECT 1 FROM product_translation_bulk_edit_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id))) OR(NEW.kind='execution' AND NOT EXISTS(SELECT 1 FROM product_translation_bulk_edit_executions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id))) THEN RAISE EXCEPTION 'Brak rzeczywistego nowego core języków' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER language_file_import_witness_scope BEFORE INSERT ON language_file_import_core_witnesses FOR EACH ROW EXECUTE FUNCTION language_file_import_witness_scope();
CREATE FUNCTION language_file_import_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM(VALUES
 ('language_file_import_previews','language_file_import_head_scope','language_file_import_head_scope()'),
 ('language_file_import_executions','language_file_import_head_scope','language_file_import_head_scope()'),
 ('language_file_import_rows','language_file_import_row_scope','language_file_import_row_scope()'),
 ('language_file_import_execution_rows','language_file_import_row_scope','language_file_import_row_scope()'),
 ('language_file_import_previews','language_file_import_immutable','language_file_import_immutable()'),
 ('language_file_import_executions','language_file_import_immutable','language_file_import_immutable()'),
 ('language_file_import_rows','language_file_import_immutable','language_file_import_immutable()'),
 ('language_file_import_execution_rows','language_file_import_immutable','language_file_import_immutable()'),
 ('language_file_import_admissions','language_file_import_admission_scope','language_file_import_admission_scope()'),
 ('language_file_import_core_witnesses','language_file_import_witness_scope','language_file_import_witness_scope()'),
 ('language_file_import_core_witnesses','language_file_import_immutable','language_file_import_immutable()')
 ) required(tbl,name,fn) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=to_regclass('public.'||required.tbl) AND g.tgname=required.name AND g.tgenabled='O' AND g.tgfoid=to_regprocedure(required.fn)))
$$;
-- Default PUBLIC execution is removed from every utility, not only SD writers.
DO $$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure identity FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'language_file_import_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.identity);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION language_file_import_access(uuid,uuid,boolean,boolean),language_file_import_installed(),language_file_import_store_preview(jsonb,uuid,uuid),language_file_import_prepare_execution(uuid,uuid,uuid,uuid),language_file_import_store_execution(jsonb,uuid,uuid),language_file_import_store_profile(jsonb,uuid,uuid) TO dyna_app;
