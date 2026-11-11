-- One consent, one transaction, complete native 127 proforma graph. No old rows are rewritten.
CREATE TABLE proforma_batch_previews(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,series_id uuid NOT NULL,shipping_vat integer NOT NULL CHECK(shipping_vat BETWEEN 0 AND 100),
 scope_hash text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,series_id) REFERENCES proforma_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$'),CHECK(octet_length(payload::text)<=4194304)
);
CREATE TABLE proforma_batch_preview_rows(
 tenant_id uuid NOT NULL,batch_preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 49),order_id uuid NOT NULL,preview_id uuid NOT NULL,issue_client_key uuid NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,batch_preview_id,index),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,batch_preview_id,order_id),UNIQUE(tenant_id,batch_preview_id,index,order_id,preview_id),
 FOREIGN KEY(tenant_id,batch_preview_id) REFERENCES proforma_batch_previews(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES proforma_previews(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE TABLE proforma_batch_executions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,
 request_hash text NOT NULL,request jsonb NOT NULL,scope_hash text NOT NULL,payload jsonb NOT NULL,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,preview_id) REFERENCES proforma_batch_previews(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE proforma_batch_execution_rows(
 tenant_id uuid NOT NULL,batch_execution_id uuid NOT NULL,batch_preview_id uuid NOT NULL,index integer NOT NULL,order_id uuid NOT NULL,preview_id uuid NOT NULL,receipt_id uuid NOT NULL,document_id uuid NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,batch_execution_id,index),UNIQUE(tenant_id,receipt_id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,batch_execution_id,order_id),
 FOREIGN KEY(tenant_id,batch_execution_id) REFERENCES proforma_batch_executions(tenant_id,id),
 FOREIGN KEY(tenant_id,batch_preview_id,index,order_id,preview_id) REFERENCES proforma_batch_preview_rows(tenant_id,batch_preview_id,index,order_id,preview_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES proforma_receipts(tenant_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id)
);
CREATE TABLE proforma_batch_admissions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,
 request_hash text NOT NULL,request jsonb NOT NULL,scope_hash text NOT NULL,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id),FOREIGN KEY(tenant_id,preview_id) REFERENCES proforma_batch_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,id) REFERENCES proforma_batch_executions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX proforma_batch_previews_page ON proforma_batch_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX proforma_batch_executions_page ON proforma_batch_executions(tenant_id,created_at DESC,id DESC);
CREATE INDEX proforma_batch_admissions_tx ON proforma_batch_admissions(tenant_id,top_xid,transaction_started_at);
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['proforma_batch_previews','proforma_batch_preview_rows','proforma_batch_executions','proforma_batch_execution_rows','proforma_batch_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 IF tab<>'proforma_batch_admissions' THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',tab);END IF;
 END LOOP;
END$$;
CREATE FUNCTION proforma_batch_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT 1 FROM migrations WHERE name='128_proforma_batches')$$;
CREATE FUNCTION proforma_batch_child_key(parent uuid,oid uuid,operation text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE h text;BEGIN
 IF operation NOT IN('preview','issue') THEN RAISE EXCEPTION 'Niepoprawny klucz dziecka proformy' USING ERRCODE='23514';END IF;
 h:=encode(sha256(convert_to('proforma.batch:'||parent::text||':'||oid::text||':'||operation,'UTF8')),'hex');
 RETURN(substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid;
END$$;
CREATE FUNCTION proforma_batch_request_valid(body jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE rowval jsonb;previous_id uuid;oid uuid;BEGIN
 IF(jsonb_typeof(body)='object' AND body-ARRAY['client_key','series_id','shipping_vat','orders']='{}' AND jsonb_typeof(body->'orders')='array'
 AND jsonb_array_length(body->'orders') BETWEEN 1 AND 50 AND jsonb_typeof(body->'shipping_vat')='number' AND body->>'shipping_vat'~'^[0-9]+$' AND(body->>'shipping_vat')::bigint BETWEEN 0 AND 100) IS NOT TRUE THEN RETURN false;END IF;
 IF(body->>'client_key')::uuid IS NULL OR(body->>'series_id')::uuid IS NULL THEN RETURN false;END IF;
 FOR rowval IN SELECT value FROM jsonb_array_elements(body->'orders') LOOP
 IF(jsonb_typeof(rowval)='object' AND rowval-ARRAY['order_id','order_version']='{}' AND jsonb_typeof(rowval->'order_id')='string'
 AND jsonb_typeof(rowval->'order_version')='string' AND rowval->>'order_version'~'^[1-9][0-9]{0,18}$') IS NOT TRUE THEN RETURN false;END IF;
 IF(rowval->>'order_version')::numeric>9223372036854775807 THEN RETURN false;END IF;
 oid:=(rowval->>'order_id')::uuid;
 IF rowval->>'order_id' IS DISTINCT FROM oid::text OR(previous_id IS NOT NULL AND oid<=previous_id) THEN RETURN false;END IF;previous_id:=oid;
 END LOOP;RETURN true;
END$$;
CREATE FUNCTION proforma_batch_locks(body jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;ids uuid[];BEGIN
 PERFORM proforma_locks();IF NOT proforma_batch_request_valid(body) THEN RAISE EXCEPTION 'Niepoprawny zakres partii proform' USING ERRCODE='23514';END IF;
 SELECT array_agg((value->>'order_id')::uuid ORDER BY(value->>'order_id')::uuid) INTO ids FROM jsonb_array_elements(body->'orders');
 PERFORM id FROM orders WHERE tenant_id=t AND id=ANY(ids) ORDER BY id FOR UPDATE;
 IF(SELECT count(*) FROM orders WHERE tenant_id=t AND id=ANY(ids))<>cardinality(ids) THEN RAISE EXCEPTION 'Nie znaleziono wszystkich własnych zamówień' USING ERRCODE='P0002';END IF;
 PERFORM id FROM proforma_series WHERE(tenant_id,id)=(t,(body->>'series_id')::uuid) FOR UPDATE;
END$$;
CREATE FUNCTION proforma_batch_summary(rowsval jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('orders',jsonb_array_length(rowsval),'currencies',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',currency,'gross_minor',gross::text,'net_minor',net::text,'vat_minor',vat::text) ORDER BY currency COLLATE "C") FROM(
 SELECT value->'snapshot'->>'currency' currency,sum((value->'snapshot'->'totals'->>'gross_minor')::bigint) gross,sum((value->'snapshot'->'totals'->>'net_minor')::bigint) net,sum((value->'snapshot'->'totals'->>'vat_minor')::bigint) vat FROM jsonb_array_elements(rowsval) GROUP BY value->'snapshot'->>'currency') currencies),'[]'::jsonb))
$$;
-- Preserve the 127 function OID and its ACL. Combined retention applies to later standalone writes too.
CREATE OR REPLACE FUNCTION proforma_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE bytes bigint;BEGIN
 IF(SELECT count(*) FROM proforma_series WHERE tenant_id=t)>100 OR(SELECT count(*) FROM proforma_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM proforma_receipts WHERE tenant_id=t)>2000
 OR(SELECT count(*) FROM proforma_batch_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM proforma_batch_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii proform' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(octet_length(r::text)),0) INTO bytes FROM(
 SELECT to_jsonb(x) r FROM proforma_series x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM proforma_series_commands x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM proforma_previews x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM proforma_receipts x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM proforma_admissions x WHERE tenant_id=t UNION ALL SELECT d.data FROM documents d WHERE tenant_id=t AND kind='proforma'
 UNION ALL SELECT to_jsonb(x) FROM proforma_batch_previews x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM proforma_batch_preview_rows x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM proforma_batch_executions x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM proforma_batch_execution_rows x WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(x) FROM proforma_batch_admissions x WHERE tenant_id=t) history;
 IF bytes>67108864 THEN RAISE EXCEPTION 'Limit historii proform' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION proforma_batch_validate_preview(v jsonb,body jsonb,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;rowval jsonb;cp proforma_previews%ROWTYPE;idx integer:=0;BEGIN
 PERFORM proforma_require(uid,kid,true,false);PERFORM proforma_batch_locks(body);
 IF v-ARRAY['id','series_id','shipping_vat','summary','rows']<>'{}' OR jsonb_typeof(v->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'rows')<>jsonb_array_length(body->'orders') OR v->'summary' IS DISTINCT FROM proforma_batch_summary(v->'rows')
 OR v->>'series_id' IS DISTINCT FROM body->>'series_id' OR v->'shipping_vat' IS DISTINCT FROM body->'shipping_vat' OR octet_length(v::text)>4194304 THEN RAISE EXCEPTION 'Niepełny podgląd partii proform' USING ERRCODE='23514';END IF;
 FOR rowval IN SELECT value FROM jsonb_array_elements(v->'rows') LOOP
 SELECT * INTO cp FROM proforma_previews WHERE(tenant_id,id)=(t,(rowval->>'preview_id')::uuid);
 IF cp.id IS NULL OR(cp.actor_id,cp.api_key_id) IS DISTINCT FROM(uid,kid) OR cp.created_at<transaction_timestamp()
 OR rowval IS DISTINCT FROM jsonb_build_object('index',idx,'order_id',cp.order_id,'order_version',cp.order_version::text,'preview_id',cp.id,'scope_hash',cp.scope_hash,'snapshot',cp.snapshot)
 OR(cp.order_id::text,cp.order_version::text) IS DISTINCT FROM(body->'orders'->idx->>'order_id',body->'orders'->idx->>'order_version')
 OR cp.request IS DISTINCT FROM jsonb_build_object('client_key',proforma_batch_child_key((v->>'id')::uuid,cp.order_id,'preview'),'series_id',(body->>'series_id')::uuid,'order_version',cp.order_version::text,'shipping_vat',(body->>'shipping_vat')::integer)
 OR cp.snapshot IS DISTINCT FROM proforma_frame(cp.order_id,cp.series_id,(body->>'shipping_vat')::integer) THEN RAISE EXCEPTION 'Dziecko podglądu partii nie jest dokładnym świeżym zakresem' USING ERRCODE='23514';END IF;idx:=idx+1;
 END LOOP;PERFORM proforma_require(uid,kid,true,false);
END$$;
CREATE FUNCTION proforma_batch_preview_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.request_hash IS DISTINCT FROM proforma_request_hash('batch_preview',NULL,NEW.request,NEW.actor_id,NEW.api_key_id)
 OR NEW.payload->>'id' IS DISTINCT FROM NEW.id::text OR NEW.scope_hash IS DISTINCT FROM proforma_hash(NEW.payload) OR(NEW.series_id::text,NEW.shipping_vat) IS DISTINCT FROM(NEW.request->>'series_id',(NEW.request->>'shipping_vat')::integer)
 OR NEW.created_at>clock_timestamp() OR NEW.expires_at>NEW.created_at+interval '15 minutes'
 OR NEW.expires_at IS DISTINCT FROM(SELECT min(p.expires_at) FROM proforma_previews p WHERE p.tenant_id=NEW.tenant_id AND p.id=ANY(ARRAY(SELECT(value->>'preview_id')::uuid FROM jsonb_array_elements(NEW.payload->'rows')))) THEN RAISE EXCEPTION 'Niepoprawny podgląd partii proform' USING ERRCODE='23514';END IF;
 PERFORM proforma_batch_validate_preview(NEW.payload,NEW.request,NEW.actor_id,NEW.api_key_id);RETURN NEW;
END$$;
CREATE FUNCTION proforma_batch_preview_row_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE p proforma_batch_previews%ROWTYPE;BEGIN
 SELECT * INTO p FROM proforma_batch_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.batch_preview_id);
 IF p.id IS NULL OR NEW.payload IS DISTINCT FROM p.payload->'rows'->NEW.index OR(NEW.order_id::text,NEW.preview_id::text) IS DISTINCT FROM(NEW.payload->>'order_id',NEW.payload->>'preview_id')
 OR NEW.issue_client_key IS DISTINCT FROM proforma_batch_child_key(p.id,NEW.order_id,'issue') THEN RAISE EXCEPTION 'Pozycja partii nie ma dokładnego podglądu' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_batch_store_preview(body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p proforma_batch_previews%ROWTYPE;pid uuid:=gen_random_uuid();h text;rowval jsonb;cp jsonb;rowsval jsonb:='[]';v jsonb;idx integer:=0;stamp timestamptz;expires timestamptz;BEGIN
 PERFORM proforma_require(uid,kid,true,false);PERFORM proforma_locks();h:=proforma_request_hash('batch_preview',NULL,body,uid,kid);
 SELECT * INTO p FROM proforma_batch_previews WHERE(tenant_id,client_key)=(t,(body->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.actor_id,p.api_key_id,p.request_hash) IS DISTINCT FROM(uid,kid,h) THEN RAISE EXCEPTION 'Klucz partii użyty z innymi danymi' USING ERRCODE='23514';END IF;RETURN to_jsonb(p)||jsonb_build_object('reused',true);END IF;
 PERFORM proforma_batch_locks(body);
 FOR rowval IN SELECT value FROM jsonb_array_elements(body->'orders') LOOP
 cp:=proforma_store_preview((rowval->>'order_id')::uuid,jsonb_build_object('client_key',proforma_batch_child_key(pid,(rowval->>'order_id')::uuid,'preview'),'series_id',(body->>'series_id')::uuid,'order_version',rowval->>'order_version','shipping_vat',(body->>'shipping_vat')::integer),uid,kid);
 IF cp->>'reused' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Partia nie może adoptować historycznego podglądu' USING ERRCODE='23514';END IF;
 rowsval:=rowsval||jsonb_build_array(jsonb_build_object('index',idx,'order_id',cp->>'order_id','order_version',cp->>'order_version','preview_id',cp->>'id','scope_hash',cp->>'scope_hash','snapshot',cp->'snapshot'));
 expires:=least(expires,(cp->>'expires_at')::timestamptz);idx:=idx+1;
 END LOOP;
 v:=jsonb_build_object('id',pid,'series_id',(body->>'series_id')::uuid,'shipping_vat',(body->>'shipping_vat')::integer,'summary',proforma_batch_summary(rowsval),'rows',rowsval);stamp:=clock_timestamp();
 INSERT INTO proforma_batch_previews(id,tenant_id,actor_id,api_key_id,client_key,request_hash,request,series_id,shipping_vat,scope_hash,payload,created_at,expires_at)
 VALUES(pid,t,uid,kid,(body->>'client_key')::uuid,h,body,(body->>'series_id')::uuid,(body->>'shipping_vat')::integer,proforma_hash(v),v,stamp,expires) RETURNING * INTO p;
 FOR rowval IN SELECT value FROM jsonb_array_elements(rowsval) LOOP
 INSERT INTO proforma_batch_preview_rows(tenant_id,batch_preview_id,index,order_id,preview_id,issue_client_key,payload) VALUES(t,pid,(rowval->>'index')::integer,(rowval->>'order_id')::uuid,(rowval->>'preview_id')::uuid,proforma_batch_child_key(pid,(rowval->>'order_id')::uuid,'issue'),rowval);END LOOP;
 PERFORM proforma_budget(t);RETURN to_jsonb(p)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION proforma_batch_admission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p proforma_batch_previews%ROWTYPE;rowval jsonb;cp proforma_previews%ROWTYPE;lastnum integer;yr integer;BEGIN
 SELECT * INTO p FROM proforma_batch_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);PERFORM proforma_require(NEW.actor_id,NEW.api_key_id,true,false);
 IF p.id IS NULL OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR(NEW.actor_id,NEW.api_key_id) IS DISTINCT FROM(p.actor_id,p.api_key_id)
 OR(NEW.top_xid,NEW.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp()) OR p.expires_at<=clock_timestamp() OR NEW.scope_hash IS DISTINCT FROM p.scope_hash
 OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
 OR NEW.request_hash IS DISTINCT FROM proforma_request_hash('batch_issue',p.id,NEW.request,NEW.actor_id,NEW.api_key_id) THEN RAISE EXCEPTION 'Niepoprawna zgoda na partię proform' USING ERRCODE='23514';END IF;
 PERFORM proforma_batch_locks(p.request);
 FOR rowval IN SELECT value FROM jsonb_array_elements(p.payload->'rows') LOOP
 SELECT * INTO cp FROM proforma_previews WHERE(tenant_id,id)=(p.tenant_id,(rowval->>'preview_id')::uuid);
 IF cp.snapshot IS DISTINCT FROM proforma_frame(cp.order_id,cp.series_id,p.shipping_vat) OR cp.expires_at<=clock_timestamp()
 OR EXISTS(SELECT 1 FROM documents WHERE(tenant_id,order_id,kind)=(p.tenant_id,cp.order_id,'proforma')) THEN RAISE EXCEPTION 'Cała partia wymaga niezmienionych zamówień bez proformy' USING ERRCODE='23514';END IF;
 yr:=(cp.snapshot->>'year')::integer;
 END LOOP;
 SELECT last_number INTO lastnum FROM proforma_counters WHERE(tenant_id,series_id,year)=(p.tenant_id,p.series_id,yr) FOR UPDATE;
 IF coalesce(lastnum,0)+jsonb_array_length(p.payload->'rows')>999999 THEN RAISE EXCEPTION 'Numeracja nie mieści całej partii proform' USING ERRCODE='23514';END IF;
 PERFORM proforma_require(NEW.actor_id,NEW.api_key_id,true,false);RETURN NEW;
END$$;
CREATE FUNCTION proforma_batch_child_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE link proforma_batch_preview_rows%ROWTYPE;a proforma_batch_admissions%ROWTYPE;BEGIN
 SELECT * INTO link FROM proforma_batch_preview_rows WHERE(tenant_id,preview_id)=(NEW.tenant_id,NEW.preview_id);
 IF link.preview_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO a FROM proforma_batch_admissions WHERE(tenant_id,preview_id)=(link.tenant_id,link.batch_preview_id) AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 IF a.id IS NULL OR(NEW.actor_id,NEW.api_key_id,NEW.client_key) IS DISTINCT FROM(a.actor_id,a.api_key_id,link.issue_client_key)
 THEN RAISE EXCEPTION 'Podgląd dziecka wymaga zgody i wykonania całej partii' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_batch_execution_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a proforma_batch_admissions%ROWTYPE;p proforma_batch_previews%ROWTYPE;rowval jsonb;sourceval jsonb;r proforma_receipts%ROWTYPE;d documents%ROWTYPE;idx integer:=0;BEGIN
 SELECT * INTO a FROM proforma_batch_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);SELECT * INTO p FROM proforma_batch_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);
 IF a.id IS NULL OR(NEW.preview_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash,NEW.scope_hash,NEW.top_xid,NEW.transaction_started_at)
 IS DISTINCT FROM(a.preview_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.scope_hash,pg_current_xact_id(),transaction_timestamp()) OR NEW.request IS DISTINCT FROM a.request
 OR(NEW.payload-'rows') IS DISTINCT FROM((p.payload-'rows'-'id')||jsonb_build_object('id',NEW.id,'preview_id',p.id))
 OR jsonb_typeof(NEW.payload->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.payload->'rows')<>jsonb_array_length(p.payload->'rows') THEN RAISE EXCEPTION 'Niepełne wykonanie partii proform' USING ERRCODE='23514';END IF;
 FOR rowval IN SELECT value FROM jsonb_array_elements(NEW.payload->'rows') LOOP
 sourceval:=p.payload->'rows'->idx;
 SELECT * INTO r FROM proforma_receipts WHERE(tenant_id,id)=(NEW.tenant_id,(rowval->'receipt'->>'id')::uuid);SELECT * INTO d FROM documents WHERE(tenant_id,id)=(NEW.tenant_id,r.document_id);
 IF r.id IS NULL OR rowval-'document'-'receipt' IS DISTINCT FROM sourceval OR(r.preview_id,r.order_id,r.series_id,r.actor_id,r.api_key_id,r.client_key,r.top_xid,r.transaction_started_at)
 IS DISTINCT FROM((sourceval->>'preview_id')::uuid,(sourceval->>'order_id')::uuid,p.series_id,a.actor_id,a.api_key_id,proforma_batch_child_key(p.id,(sourceval->>'order_id')::uuid,'issue'),pg_current_xact_id(),transaction_timestamp())
 OR rowval->'document' IS DISTINCT FROM jsonb_build_object('id',d.id,'order_id',d.order_id,'number',d.number,'kind',d.kind,'mode',d.mode,'data',d.data,'created_at',d.created_at)
 OR rowval->'receipt' IS DISTINCT FROM jsonb_build_object('id',r.id,'document_id',r.document_id,'preview_id',r.preview_id,'series_id',r.series_id,'year',r.year,'sequence',r.sequence,'number',r.number,'scope_hash',r.scope_hash,'created_at',r.created_at)
 THEN RAISE EXCEPTION 'Receipt dziecka nie jest świeżą dokładną bijekcją partii' USING ERRCODE='23514';END IF;idx:=idx+1;
 END LOOP;PERFORM proforma_require(a.actor_id,a.api_key_id,true,false);RETURN NEW;
END$$;
CREATE FUNCTION proforma_batch_execution_row_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE e proforma_batch_executions%ROWTYPE;BEGIN
 SELECT * INTO e FROM proforma_batch_executions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.batch_execution_id);
 IF e.id IS NULL OR NEW.batch_preview_id IS DISTINCT FROM e.preview_id OR NEW.payload IS DISTINCT FROM e.payload->'rows'->NEW.index
 OR(NEW.order_id::text,NEW.preview_id::text,NEW.receipt_id::text,NEW.document_id::text) IS DISTINCT FROM(NEW.payload->>'order_id',NEW.payload->>'preview_id',NEW.payload->'receipt'->>'id',NEW.payload->'document'->>'id') THEN RAISE EXCEPTION 'Pozycja wykonania partii jest niepełna' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION proforma_batch_issue(pid uuid,body jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p proforma_batch_previews%ROWTYPE;e proforma_batch_executions%ROWTYPE;eid uuid:=gen_random_uuid();h text;rowval jsonb;r jsonb;d documents%ROWTYPE;rowsval jsonb:='[]';v jsonb;BEGIN
 PERFORM proforma_require(uid,kid,true,false);PERFORM proforma_locks();h:=proforma_request_hash('batch_issue',pid,body,uid,kid);
 SELECT * INTO e FROM proforma_batch_executions WHERE(tenant_id,client_key)=(t,(body->>'client_key')::uuid);
 IF e.id IS NOT NULL THEN IF(e.preview_id,e.actor_id,e.api_key_id,e.request_hash) IS DISTINCT FROM(pid,uid,kid,h) THEN RAISE EXCEPTION 'Klucz partii użyty z innymi danymi' USING ERRCODE='23514';END IF;RETURN to_jsonb(e)||jsonb_build_object('reused',true);END IF;
 SELECT * INTO p FROM proforma_batch_previews WHERE(tenant_id,id)=(t,pid);IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu partii' USING ERRCODE='P0002';END IF;
 INSERT INTO proforma_batch_admissions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash) VALUES(eid,t,pid,uid,kid,(body->>'client_key')::uuid,h,body,p.scope_hash);
 FOR rowval IN SELECT value FROM jsonb_array_elements(p.payload->'rows') LOOP
 r:=proforma_issue((rowval->>'preview_id')::uuid,jsonb_build_object('client_key',proforma_batch_child_key(pid,(rowval->>'order_id')::uuid,'issue'),'scope_hash',rowval->>'scope_hash','confirmed',true,'local_only',true),uid,kid);
 IF r->>'reused' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Partia nie może adoptować historycznego receipt' USING ERRCODE='23514';END IF;
 SELECT * INTO d FROM documents WHERE(tenant_id,id)=(t,(r->>'document_id')::uuid);
 rowsval:=rowsval||jsonb_build_array(rowval||jsonb_build_object('document',jsonb_build_object('id',d.id,'order_id',d.order_id,'number',d.number,'kind',d.kind,'mode',d.mode,'data',d.data,'created_at',d.created_at),
 'receipt',jsonb_build_object('id',r->>'id','document_id',r->>'document_id','preview_id',r->>'preview_id','series_id',r->>'series_id','year',r->'year','sequence',r->'sequence','number',r->>'number','scope_hash',r->>'scope_hash','created_at',r->'created_at')));
 END LOOP;
 v:=(p.payload-'id'-'rows')||jsonb_build_object('id',eid,'preview_id',p.id,'rows',rowsval);
 INSERT INTO proforma_batch_executions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash,payload) VALUES(eid,t,pid,uid,kid,(body->>'client_key')::uuid,h,body,p.scope_hash,v) RETURNING * INTO e;
 FOR rowval IN SELECT value FROM jsonb_array_elements(rowsval) LOOP
 INSERT INTO proforma_batch_execution_rows(tenant_id,batch_execution_id,batch_preview_id,index,order_id,preview_id,receipt_id,document_id,payload)
 VALUES(t,eid,pid,(rowval->>'index')::integer,(rowval->>'order_id')::uuid,(rowval->>'preview_id')::uuid,(rowval->'receipt'->>'id')::uuid,(rowval->'document'->>'id')::uuid,rowval);END LOOP;
 PERFORM proforma_budget(t);RETURN to_jsonb(e)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION proforma_batch_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE p proforma_batch_previews%ROWTYPE;e proforma_batch_executions%ROWTYPE;link proforma_batch_preview_rows%ROWTYPE;BEGIN
 IF TG_TABLE_NAME='proforma_batch_previews' THEN
 SELECT * INTO p FROM proforma_batch_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);
 IF(SELECT coalesce(jsonb_agg(payload ORDER BY index),'[]'::jsonb) FROM proforma_batch_preview_rows WHERE(tenant_id,batch_preview_id)=(p.tenant_id,p.id)) IS DISTINCT FROM p.payload->'rows' THEN RAISE EXCEPTION 'Partia nie ma kompletnych trwałych podglądów' USING ERRCODE='23514';END IF;
 PERFORM proforma_require(p.actor_id,p.api_key_id,true,false);
 ELSE
 IF TG_TABLE_NAME='proforma_receipts' THEN SELECT * INTO link FROM proforma_batch_preview_rows WHERE(tenant_id,preview_id)=(NEW.tenant_id,NEW.preview_id);IF link.preview_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO e FROM proforma_batch_executions WHERE(tenant_id,preview_id)=(link.tenant_id,link.batch_preview_id);
 ELSE SELECT * INTO e FROM proforma_batch_executions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);END IF;
 IF e.id IS NULL OR NOT EXISTS(SELECT 1 FROM proforma_batch_admissions a WHERE(a.tenant_id,a.id,a.preview_id,a.actor_id,a.api_key_id,a.request_hash,a.request,a.scope_hash,a.top_xid,a.transaction_started_at)
 IS NOT DISTINCT FROM(e.tenant_id,e.id,e.preview_id,e.actor_id,e.api_key_id,e.request_hash,e.request,e.scope_hash,pg_current_xact_id(),transaction_timestamp()))
 OR(SELECT coalesce(jsonb_agg(payload ORDER BY index),'[]'::jsonb) FROM proforma_batch_execution_rows WHERE(tenant_id,batch_execution_id)=(e.tenant_id,e.id)) IS DISTINCT FROM e.payload->'rows' THEN RAISE EXCEPTION 'Brak kompletnego atomowego grafu partii proform' USING ERRCODE='23514';END IF;
 PERFORM proforma_require(e.actor_id,e.api_key_id,true,false);
 END IF;PERFORM proforma_budget(NEW.tenant_id);RETURN NEW;
END$$;
CREATE FUNCTION proforma_batch_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE oldrow jsonb;newrow jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN oldrow:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN newrow:=to_jsonb(NEW);END IF;
 IF EXISTS(SELECT 1 FROM proforma_batch_admissions a JOIN proforma_batch_preview_rows r ON(r.tenant_id,r.batch_preview_id)=(a.tenant_id,a.preview_id)
 WHERE a.top_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp()
 AND((r.tenant_id=(oldrow->>'tenant_id')::uuid AND r.order_id=(CASE WHEN TG_TABLE_NAME='orders' THEN(oldrow->>'id')::uuid ELSE(oldrow->>'order_id')::uuid END))
 OR(r.tenant_id=(newrow->>'tenant_id')::uuid AND r.order_id=(CASE WHEN TG_TABLE_NAME='orders' THEN(newrow->>'id')::uuid ELSE(newrow->>'order_id')::uuid END)))) THEN RAISE EXCEPTION 'Cały zatwierdzony zakres partii proform jest zapieczętowany' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER proforma_batch_preview_guard BEFORE INSERT ON proforma_batch_previews FOR EACH ROW EXECUTE FUNCTION proforma_batch_preview_guard();
CREATE TRIGGER proforma_batch_preview_row_guard BEFORE INSERT ON proforma_batch_preview_rows FOR EACH ROW EXECUTE FUNCTION proforma_batch_preview_row_guard();
CREATE TRIGGER proforma_batch_admission_guard BEFORE INSERT ON proforma_batch_admissions FOR EACH ROW EXECUTE FUNCTION proforma_batch_admission_guard();
CREATE TRIGGER proforma_batch_execution_guard BEFORE INSERT ON proforma_batch_executions FOR EACH ROW EXECUTE FUNCTION proforma_batch_execution_guard();
CREATE TRIGGER proforma_batch_execution_row_guard BEFORE INSERT ON proforma_batch_execution_rows FOR EACH ROW EXECUTE FUNCTION proforma_batch_execution_row_guard();
CREATE TRIGGER proforma_batch_child_guard BEFORE INSERT ON proforma_admissions FOR EACH ROW EXECUTE FUNCTION proforma_batch_child_guard();
CREATE CONSTRAINT TRIGGER proforma_batch_complete AFTER INSERT ON proforma_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION proforma_batch_complete();
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['proforma_batch_previews','proforma_batch_preview_rows','proforma_batch_executions','proforma_batch_execution_rows','proforma_batch_admissions'] LOOP
 EXECUTE format('CREATE TRIGGER proforma_batch_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION proforma_immutable()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['proforma_batch_previews','proforma_batch_executions','proforma_batch_admissions'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER proforma_batch_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION proforma_batch_complete()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['orders','order_items','return_cases'] LOOP EXECUTE format('CREATE TRIGGER proforma_batch_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION proforma_batch_seal()',tab);END LOOP;
END$$;
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT p.oid::regprocedure sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'proforma_batch_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig);END LOOP;END$$;
GRANT EXECUTE ON FUNCTION proforma_batch_installed(),proforma_batch_store_preview(jsonb,uuid,uuid),proforma_batch_issue(uuid,jsonb,uuid,uuid) TO dyna_app;
