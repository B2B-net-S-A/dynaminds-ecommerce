-- Atomic queues of existing cached PDF labels. No carrier request or physical-print claim.
CREATE TABLE shipment_label_batch_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),payload jsonb NOT NULL,
 combined_content_encrypted text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE shipment_label_batch_preview_rows (
 tenant_id uuid NOT NULL REFERENCES tenants(id),preview_id uuid NOT NULL,index integer NOT NULL CHECK(index BETWEEN 0 AND 49),shipment_id uuid NOT NULL,order_id uuid NOT NULL,cache_asset_id uuid NOT NULL,child_preview_id uuid NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,preview_id,index),UNIQUE(tenant_id,preview_id,shipment_id),UNIQUE(tenant_id,child_preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES shipment_label_batch_previews(tenant_id,id),FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,cache_asset_id,shipment_id,order_id) REFERENCES shipment_label_cache_assets(tenant_id,id,shipment_id,order_id),FOREIGN KEY(tenant_id,child_preview_id) REFERENCES print_label_previews(tenant_id,id)
);
CREATE TABLE shipment_label_batch_executions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,scope_hash text NOT NULL,payload jsonb NOT NULL,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,preview_id) REFERENCES shipment_label_batch_previews(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE shipment_label_batch_execution_rows (
 tenant_id uuid NOT NULL REFERENCES tenants(id),execution_id uuid NOT NULL,preview_id uuid NOT NULL,index integer NOT NULL,child_preview_id uuid NOT NULL,job_id uuid NOT NULL,job_create_event_id uuid NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,execution_id,index),UNIQUE(tenant_id,job_id),UNIQUE(tenant_id,job_create_event_id),
 FOREIGN KEY(tenant_id,execution_id) REFERENCES shipment_label_batch_executions(tenant_id,id),FOREIGN KEY(tenant_id,preview_id,index) REFERENCES shipment_label_batch_preview_rows(tenant_id,preview_id,index),
 FOREIGN KEY(tenant_id,child_preview_id) REFERENCES print_label_previews(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES print_jobs(tenant_id,id),FOREIGN KEY(tenant_id,job_create_event_id) REFERENCES print_job_events(tenant_id,id)
);
CREATE TABLE shipment_label_batch_admissions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),preview_id uuid NOT NULL,execution_id uuid,phase text NOT NULL CHECK(phase IN('preview','queue')),actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 request jsonb NOT NULL,witnesses jsonb NOT NULL DEFAULT '{}'::jsonb,top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id,phase),CHECK((phase='queue')=(execution_id IS NOT NULL)),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES shipment_label_batch_previews(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,execution_id) REFERENCES shipment_label_batch_executions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX label_batch_preview_page ON shipment_label_batch_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX label_batch_execution_page ON shipment_label_batch_executions(tenant_id,created_at DESC,id DESC);
DO $$ DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['shipment_label_batch_previews','shipment_label_batch_preview_rows','shipment_label_batch_executions','shipment_label_batch_execution_rows','shipment_label_batch_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format('CREATE POLICY label_batch_tenant ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',rel);
 EXECUTE format('CREATE POLICY label_batch_owner ON %I TO %I USING(true) WITH CHECK(true)',rel,current_user);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',rel);
END LOOP;END $$;
GRANT SELECT(id,tenant_id,actor_id,api_key_id,client_key,scope_hash,payload,expires_at,created_at) ON shipment_label_batch_previews TO dyna_app;
GRANT SELECT ON shipment_label_batch_preview_rows,shipment_label_batch_execution_rows TO dyna_app;
GRANT SELECT(id,tenant_id,preview_id,actor_id,api_key_id,client_key,scope_hash,payload,created_at) ON shipment_label_batch_executions TO dyna_app;
CREATE FUNCTION label_batch_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM migrations WHERE name='132_shipment_label_batches') $$;
CREATE FUNCTION label_batch_require(uid uuid,kid uuid,writing boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF label_batch_guards() IS NOT TRUE OR label_batch_installed() IS NOT TRUE THEN RAISE EXCEPTION 'Moduł partii etykiet jest niekompletny' USING ERRCODE='55000';END IF;PERFORM label_cache_require(uid,kid,writing);
END $$;
CREATE FUNCTION label_batch_child_key(pid uuid,sid uuid,op text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE h text;BEGIN IF op NOT IN('preview','queue') THEN RAISE EXCEPTION 'Niepoprawny klucz pozycji partii' USING ERRCODE='23514';END IF;
 h:=encode(sha256(convert_to('shipment.label.batch:'||pid::text||':'||sid::text||':'||op,'UTF8')),'hex');RETURN (substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid;END $$;
CREATE FUNCTION label_batch_request_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE x jsonb;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (v-ARRAY['client_key','station_id','station_version','printer_id','printer_version','copies','shipments'])<>'{}'::jsonb OR jsonb_typeof(v->'shipments') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(v->'shipments') NOT BETWEEN 1 AND 50 OR coalesce(v->>'station_version','')!~'^[1-9][0-9]{0,18}$' OR coalesce(v->>'printer_version','')!~'^[1-9][0-9]{0,18}$' OR jsonb_typeof(v->'copies') IS DISTINCT FROM 'number' OR coalesce(v->>'copies','')!~'^[0-9]+$' OR (v->>'copies')::integer NOT BETWEEN 1 AND 10 THEN RETURN false;END IF;
 PERFORM (v->>'client_key')::uuid,(v->>'station_id')::uuid,(v->>'printer_id')::uuid;
 IF v->>'client_key' IS NULL OR v->>'station_id' IS NULL OR v->>'printer_id' IS NULL THEN RETURN false;END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(v->'shipments') LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR (x-ARRAY['shipment_id','order_version','asset_id'])<>'{}'::jsonb OR x->>'shipment_id' IS NULL OR x->>'asset_id' IS NULL OR coalesce(x->>'order_version','')!~'^[1-9][0-9]{0,18}$' THEN RETURN false;END IF;PERFORM (x->>'shipment_id')::uuid,(x->>'asset_id')::uuid;
 END LOOP;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'shipments') z GROUP BY (z->>'shipment_id')::uuid HAVING count(*)>1);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;END $$;
CREATE FUNCTION label_batch_child_request(pid uuid,v jsonb,x jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('client_key',label_batch_child_key(pid,(x->>'shipment_id')::uuid,'preview'),'order_version',x->>'order_version','station_id',v->'station_id','station_version',v->'station_version','printer_id',v->'printer_id','printer_version',v->'printer_version','copies',v->'copies','asset_id',x->'asset_id') $$;
CREATE FUNCTION label_batch_locks(v jsonb,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 PERFORM print_job_lock();PERFORM label_batch_require(uid,kid,true);IF label_batch_request_valid(v) IS NOT TRUE THEN RAISE EXCEPTION 'Niepoprawny zakres partii etykiet' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM orders o WHERE o.tenant_id=t AND o.id IN(SELECT s.order_id FROM shipments s JOIN jsonb_array_elements(v->'shipments') x ON s.id=(x->>'shipment_id')::uuid WHERE s.tenant_id=t) ORDER BY o.id FOR UPDATE;
 PERFORM 1 FROM shipments s WHERE s.tenant_id=t AND s.id IN(SELECT (x->>'shipment_id')::uuid FROM jsonb_array_elements(v->'shipments') x) ORDER BY s.id FOR UPDATE;
 PERFORM 1 FROM shipping_plans p WHERE p.tenant_id=t AND p.shipment_id IN(SELECT (x->>'shipment_id')::uuid FROM jsonb_array_elements(v->'shipments') x) ORDER BY p.id FOR UPDATE;
 PERFORM 1 FROM channels ch WHERE ch.tenant_id=t AND ch.id IN(SELECT s.channel_id FROM shipments s JOIN jsonb_array_elements(v->'shipments') x ON s.id=(x->>'shipment_id')::uuid WHERE s.tenant_id=t) ORDER BY ch.id FOR UPDATE;
 PERFORM 1 FROM packing_stations WHERE tenant_id=t AND id=(v->>'station_id')::uuid FOR UPDATE;PERFORM 1 FROM print_printers WHERE tenant_id=t AND id=(v->>'printer_id')::uuid FOR UPDATE;
 PERFORM label_batch_require(uid,kid,true);
END $$;
CREATE FUNCTION label_batch_preview_replay(v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p shipment_label_batch_previews;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 PERFORM print_job_lock();PERFORM label_batch_require(uid,kid,true);SELECT * INTO p FROM shipment_label_batch_previews WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF p.id IS NULL THEN RETURN NULL;END IF;
 IF p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.request IS DISTINCT FROM v OR p.request_hash IS DISTINCT FROM print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'request',v)) THEN RAISE EXCEPTION 'Klucz podglądu partii ma inną treść' USING ERRCODE='23514';END IF;RETURN p.id;END $$;
CREATE FUNCTION label_batch_prepare_preview(pid uuid,v jsonb,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 PERFORM label_batch_locks(v,uid,kid);INSERT INTO shipment_label_batch_admissions(id,tenant_id,preview_id,phase,actor_id,api_key_id,request) VALUES(gen_random_uuid(),nullif(current_setting('app.tenant_id',true),'')::uuid,pid,'preview',uid,kid,v);END $$;
-- Only an actual AFTER INSERT child trigger may append a witness to a live admission.
CREATE FUNCTION label_batch_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a shipment_label_batch_admissions;x jsonb;BEGIN
 FOR a IN SELECT * FROM shipment_label_batch_admissions WHERE tenant_id=NEW.tenant_id AND phase='preview' AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp() LOOP
  FOR x IN SELECT value FROM jsonb_array_elements(a.request->'shipments') LOOP
   IF NEW.client_key=label_batch_child_key(a.preview_id,(x->>'shipment_id')::uuid,'preview') THEN
    IF NEW.actor_id IS DISTINCT FROM a.actor_id OR NEW.api_key_id IS DISTINCT FROM a.api_key_id OR NEW.request IS DISTINCT FROM label_batch_child_request(a.preview_id,a.request,x) THEN RAISE EXCEPTION 'Podgląd pozycji nie odpowiada zgodzie partii' USING ERRCODE='23514';END IF;
    UPDATE shipment_label_batch_admissions SET witnesses=witnesses||jsonb_build_object(NEW.id::text,jsonb_build_object('child_preview_id',NEW.id,'request',NEW.request,'scope_hash',NEW.scope_hash)) WHERE tenant_id=a.tenant_id AND id=a.id;RETURN NULL;
   END IF;
  END LOOP;
 END LOOP;RETURN NULL;END $$;
CREATE TRIGGER label_batch_witness AFTER INSERT ON print_label_previews FOR EACH ROW EXECUTE FUNCTION label_batch_witness();
CREATE FUNCTION label_batch_admission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.top_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR NEW.witnesses<>'{}'::jsonb THEN RAISE EXCEPTION 'Niepoprawna prywatna zgoda partii' USING ERRCODE='23514';END IF;PERFORM label_batch_require(NEW.actor_id,NEW.api_key_id,true);RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR pg_trigger_depth()<2 OR OLD.phase<>'preview' OR OLD.top_xid IS DISTINCT FROM pg_current_xact_id() OR OLD.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR (to_jsonb(NEW)-'witnesses') IS DISTINCT FROM (to_jsonb(OLD)-'witnesses') OR NOT(NEW.witnesses @> OLD.witnesses) OR (SELECT count(*) FROM jsonb_object_keys(NEW.witnesses))<>(SELECT count(*)+1 FROM jsonb_object_keys(OLD.witnesses)) OR EXISTS(SELECT 1 FROM shipment_label_batch_previews WHERE tenant_id=OLD.tenant_id AND id=OLD.preview_id) THEN RAISE EXCEPTION 'Zgoda partii i świadkowie są trwałe' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER label_batch_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON shipment_label_batch_admissions FOR EACH ROW EXECUTE FUNCTION label_batch_admission_guard();
CREATE FUNCTION label_batch_store_preview(v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;pid uuid:=(v->>'id')::uuid;b jsonb:=v->'request';ad shipment_label_batch_admissions;x jsonb;mr jsonb;rawrow jsonb;req jsonb;f jsonb;cp print_label_previews;ca shipment_label_cache_assets;child uuid;rowsv jsonb:='[]';cfg jsonb;ph jsonb;sumv jsonb;nextpage integer:=1;i integer:=0;layoutv text;combined bytea;ts timestamptz:=clock_timestamp();BEGIN
 PERFORM label_batch_locks(b,uid,kid);SELECT * INTO ad FROM shipment_label_batch_admissions WHERE tenant_id=t AND preview_id=pid AND phase='preview';
 IF ad.id IS NULL OR ad.actor_id IS DISTINCT FROM uid OR ad.api_key_id IS DISTINCT FROM kid OR ad.request IS DISTINCT FROM b OR ad.top_xid IS DISTINCT FROM pg_current_xact_id() OR ad.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR jsonb_typeof(v->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'rows')<>jsonb_array_length(b->'shipments') THEN RAISE EXCEPTION 'Brak pełnej świeżej zgody podglądu partii' USING ERRCODE='23514';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(b->'shipments') LOOP
  req:=label_batch_child_request(pid,b,x);f:=label_cache_selected_frame((x->>'shipment_id')::uuid,req,uid,kid);cfg:=label_print_configuration(req,f->'order_snapshot');
  SELECT * INTO ca FROM shipment_label_cache_assets WHERE tenant_id=t AND id=(x->>'asset_id')::uuid;rawrow:=v->'rows'->i;
  IF ca.id IS NULL OR ca.layout IS DISTINCT FROM v->'combined_pdf'->>'layout' OR (layoutv IS NOT NULL AND ca.layout IS DISTINCT FROM layoutv) OR rawrow->>'shipment_id' IS DISTINCT FROM x->>'shipment_id' OR rawrow->>'asset_id' IS DISTINCT FROM x->>'asset_id' OR jsonb_typeof(rawrow->'pages') IS DISTINCT FROM 'number' OR coalesce(rawrow->>'pages','')!~'^[1-9][0-9]*$' OR (rawrow->>'pages')::integer>500 OR (rawrow->>'page_from')::integer IS DISTINCT FROM nextpage OR (rawrow->>'page_to')::integer IS DISTINCT FROM nextpage+(rawrow->>'pages')::integer-1 OR print_job_content_valid(rawrow->>'content_base64','pdf') IS NOT TRUE OR encode(sha256(decode(rawrow->>'content_base64','base64')),'hex') IS DISTINCT FROM ca.content_sha256 OR octet_length(decode(rawrow->>'content_base64','base64')) IS DISTINCT FROM ca.content_bytes THEN RAISE EXCEPTION 'Plik lub manifest pozycji partii jest niezgodny' USING ERRCODE='23514';END IF;layoutv:=ca.layout;
  IF EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND client_key=(req->>'client_key')::uuid) THEN RAISE EXCEPTION 'Podgląd partii wymaga nowej pozycji' USING ERRCODE='23514';END IF;
  child:=(label_print_store_preview(jsonb_build_object('shipment_id',x->'shipment_id','request',req,'source_frame',f->'source_frame','content_base64',rawrow->'content_base64','content_encrypted',rawrow->'content_encrypted'),uid,kid)->>'preview_id')::uuid;
  SELECT * INTO cp FROM print_label_previews WHERE tenant_id=t AND id=child;
  mr:=jsonb_build_object('index',i,'shipment_id',ca.shipment_id,'order_id',ca.order_id,'order_number',cp.payload->'order_snapshot'->'number','order_version',cp.payload->'order_snapshot'->'version','cache_asset_id',ca.id,'child_preview_id',child,'child_scope_hash',cp.scope_hash,'tracking_number',ca.tracking_number,'provider',ca.provider,'mode',ca.mode,'layout',ca.layout,'source_hash',ca.source_hash,'content_sha256',ca.content_sha256,'content_bytes',ca.content_bytes,'pages',rawrow->'pages','page_from',nextpage,'page_to',nextpage+(rawrow->>'pages')::integer-1);
  rowsv:=rowsv||jsonb_build_array(mr);nextpage:=nextpage+(rawrow->>'pages')::integer;i:=i+1;
 END LOOP;
 combined:=decode(v->>'combined_content_base64','base64');
 IF combined IS NULL OR octet_length(combined) NOT BETWEEN 1 AND 16777216 OR replace(encode(combined,'base64'),E'\n','') IS DISTINCT FROM v->>'combined_content_base64' OR encode(combined,'escape')!~'^%PDF-1\.[0-9]' OR encode(combined,'escape')!~'%%EOF[\r\n\t ]*$' OR encode(combined,'escape')~*'/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile)\M|#[0-9a-f]{2}' OR nextpage-1 NOT BETWEEN 1 AND 500 OR v->'combined_pdf' IS DISTINCT FROM jsonb_build_object('format','pdf','content_sha256',encode(sha256(combined),'hex'),'content_bytes',octet_length(combined),'pages',nextpage-1,'layout',layoutv) OR length(coalesce(v->>'combined_content_encrypted','')) NOT BETWEEN 40 AND 32000000 THEN RAISE EXCEPTION 'Niepoprawny pełny PDF partii' USING ERRCODE='23514';END IF;
 sumv:=jsonb_build_object('shipments',i,'orders',(SELECT count(DISTINCT value->>'order_id') FROM jsonb_array_elements(rowsv)),'source_pages',nextpage-1,'combined_pages',nextpage-1,'copies',b->'copies','expected_label_copies',i*(b->>'copies')::integer);
 ph:=jsonb_build_object('id',pid,'kind','preview','station_snapshot',cfg->'station_snapshot','printer_snapshot',cfg->'printer_snapshot','copies',b->'copies','summary',sumv,'combined_pdf',v->'combined_pdf','rows',rowsv,'created_at',ts,'expires_at',ts+interval '15 minutes');
 INSERT INTO shipment_label_batch_previews(id,tenant_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash,payload,combined_content_encrypted,expires_at,created_at) VALUES(pid,t,uid,kid,(b->>'client_key')::uuid,print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'request',b)),b,print_job_hash(ph),ph,v->>'combined_content_encrypted',ts+interval '15 minutes',ts);
 INSERT INTO shipment_label_batch_preview_rows(tenant_id,preview_id,index,shipment_id,order_id,cache_asset_id,child_preview_id,payload) SELECT t,pid,(z->>'index')::integer,(z->>'shipment_id')::uuid,(z->>'order_id')::uuid,(z->>'cache_asset_id')::uuid,(z->>'child_preview_id')::uuid,z FROM jsonb_array_elements(rowsv) z;
 PERFORM label_print_budget();PERFORM label_batch_require(uid,kid,true);RETURN pid;END $$;
CREATE FUNCTION label_batch_validate_preview(p shipment_label_batch_previews) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ad shipment_label_batch_admissions;cp print_label_previews;ca shipment_label_cache_assets;pa print_label_assets;x jsonb;r jsonb;expected jsonb;cfg jsonb;f jsonb;sumv jsonb;n integer:=0;np integer:=1;layoutv text;BEGIN
 IF p.client_key IS DISTINCT FROM (p.request->>'client_key')::uuid THEN RAISE EXCEPTION 'Klucz podglądu nie odpowiada partii' USING ERRCODE='23514';END IF;
 SELECT * INTO ad FROM shipment_label_batch_admissions WHERE tenant_id=p.tenant_id AND preview_id=p.id AND phase='preview';
 IF ad.id IS NULL OR ad.actor_id IS DISTINCT FROM p.actor_id OR ad.api_key_id IS DISTINCT FROM p.api_key_id OR ad.request IS DISTINCT FROM p.request OR ad.top_xid IS DISTINCT FROM pg_current_xact_id() OR ad.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR label_batch_request_valid(p.request) IS NOT TRUE OR p.request_hash IS DISTINCT FROM print_job_hash(jsonb_build_object('tenant_id',p.tenant_id,'actor_id',p.actor_id,'api_key_id',p.api_key_id,'request',p.request)) OR p.scope_hash IS DISTINCT FROM print_job_hash(p.payload) OR jsonb_typeof(p.payload->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p.payload->'rows')<>jsonb_array_length(p.request->'shipments') THEN RAISE EXCEPTION 'Niepoprawny pełny podgląd partii' USING ERRCODE='23514';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p.request->'shipments') LOOP
  r:=p.payload->'rows'->n;SELECT * INTO cp FROM print_label_previews WHERE tenant_id=p.tenant_id AND id=(r->>'child_preview_id')::uuid;SELECT * INTO ca FROM shipment_label_cache_assets WHERE tenant_id=p.tenant_id AND id=(x->>'asset_id')::uuid;
  IF cp.id IS NULL OR ca.id IS NULL OR cp.actor_id IS DISTINCT FROM p.actor_id OR cp.api_key_id IS DISTINCT FROM p.api_key_id OR cp.shipment_id IS DISTINCT FROM ca.shipment_id OR cp.order_id IS DISTINCT FROM ca.order_id OR ca.shipment_id IS DISTINCT FROM (x->>'shipment_id')::uuid OR cp.request IS DISTINCT FROM label_batch_child_request(p.id,p.request,x) OR ad.witnesses->cp.id::text IS DISTINCT FROM jsonb_build_object('child_preview_id',cp.id,'request',cp.request,'scope_hash',cp.scope_hash) OR jsonb_typeof(r->'pages') IS DISTINCT FROM 'number' OR coalesce(r->>'pages','')!~'^[1-9][0-9]*$' OR (r->>'pages')::integer>500 OR (layoutv IS NOT NULL AND ca.layout IS DISTINCT FROM layoutv) THEN RAISE EXCEPTION 'Brak świeżej dokładnej pozycji partii' USING ERRCODE='23514';END IF;
  layoutv:=ca.layout;f:=label_cache_selected_frame(ca.shipment_id,cp.request,p.actor_id,p.api_key_id);cfg:=label_print_configuration(cp.request,f->'order_snapshot');SELECT * INTO pa FROM print_label_assets WHERE tenant_id=p.tenant_id AND id=cp.asset_id;
  IF pa.id IS NULL OR pa.cache_asset_id IS DISTINCT FROM ca.id OR pa.source_frame IS DISTINCT FROM f->'source_frame' OR cfg IS DISTINCT FROM cp.payload-ARRAY['id','shipment_id','order_id','asset_id','source_kind','source_snapshot','format','content_sha256','content_bytes','created_at','expires_at'] OR cp.scope_hash IS DISTINCT FROM print_job_hash(cp.payload) THEN RAISE EXCEPTION 'Źródło świeżego podglądu partii zmieniło się' USING ERRCODE='23514';END IF;
  expected:=jsonb_build_object('index',n,'shipment_id',ca.shipment_id,'order_id',ca.order_id,'order_number',cp.payload->'order_snapshot'->'number','order_version',cp.payload->'order_snapshot'->'version','cache_asset_id',ca.id,'child_preview_id',cp.id,'child_scope_hash',cp.scope_hash,'tracking_number',ca.tracking_number,'provider',ca.provider,'mode',ca.mode,'layout',ca.layout,'source_hash',ca.source_hash,'content_sha256',ca.content_sha256,'content_bytes',ca.content_bytes,'pages',r->'pages','page_from',np,'page_to',np+(r->>'pages')::integer-1);
  IF r IS DISTINCT FROM expected OR cp.payload->>'content_sha256' IS DISTINCT FROM ca.content_sha256 OR cp.payload->>'content_bytes' IS DISTINCT FROM ca.content_bytes::text OR cp.payload->'source_snapshot'->>'cache_asset_id' IS DISTINCT FROM ca.id::text THEN RAISE EXCEPTION 'Manifest nie odpowiada etykietom partii' USING ERRCODE='23514';END IF;
  np:=np+(r->>'pages')::integer;n:=n+1;
 END LOOP;
 sumv:=jsonb_build_object('shipments',n,'orders',(SELECT count(DISTINCT z->>'order_id') FROM jsonb_array_elements(p.payload->'rows') z),'source_pages',np-1,'combined_pages',np-1,'copies',p.request->'copies','expected_label_copies',n*(p.request->>'copies')::integer);
 IF jsonb_typeof(p.payload->'combined_pdf') IS DISTINCT FROM 'object' OR p.payload->'combined_pdf'->>'format' IS DISTINCT FROM 'pdf' OR jsonb_typeof(p.payload->'combined_pdf'->'content_bytes') IS DISTINCT FROM 'number' OR coalesce(p.payload->'combined_pdf'->>'content_bytes','')!~'^[1-9][0-9]{0,7}$' OR length(p.combined_content_encrypted) NOT BETWEEN 40 AND 32000000 OR p.payload->'combined_pdf' IS DISTINCT FROM jsonb_build_object('format','pdf','content_sha256',p.payload->'combined_pdf'->'content_sha256','content_bytes',p.payload->'combined_pdf'->'content_bytes','pages',np-1,'layout',layoutv) THEN RAISE EXCEPTION 'Niepoprawne metadane pełnego PDF partii' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(ad.witnesses))<>n OR np-1 NOT BETWEEN 1 AND 500 OR p.expires_at IS DISTINCT FROM p.created_at+interval '15 minutes' OR p.payload->'combined_pdf'->>'layout' IS DISTINCT FROM layoutv OR p.payload->'combined_pdf'->>'pages' IS DISTINCT FROM (np-1)::text OR coalesce(p.payload->'combined_pdf'->>'content_sha256','')!~'^[a-f0-9]{64}$' OR (p.payload->'combined_pdf'->>'content_bytes')::integer NOT BETWEEN 1 AND 16777216 OR p.payload IS DISTINCT FROM jsonb_build_object('id',p.id,'kind','preview','station_snapshot',cfg->'station_snapshot','printer_snapshot',cfg->'printer_snapshot','copies',p.request->'copies','summary',sumv,'combined_pdf',p.payload->'combined_pdf','rows',p.payload->'rows','created_at',p.created_at,'expires_at',p.expires_at) THEN RAISE EXCEPTION 'Brak pełnego manifestu PDF partii' USING ERRCODE='23514';END IF;
 PERFORM label_batch_require(p.actor_id,p.api_key_id,true);END $$;
CREATE FUNCTION label_batch_preview_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Niepoprawny tenant partii' USING ERRCODE='23514';END IF;PERFORM label_batch_validate_preview(NEW);RETURN NEW;END $$;
CREATE TRIGGER label_batch_preview_guard BEFORE INSERT ON shipment_label_batch_previews FOR EACH ROW EXECUTE FUNCTION label_batch_preview_guard();
CREATE FUNCTION label_batch_child_allowed(pid uuid,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rr shipment_label_batch_preview_rows;ad shipment_label_batch_admissions;BEGIN
 SELECT * INTO rr FROM shipment_label_batch_preview_rows WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND child_preview_id=pid;
 IF rr.preview_id IS NULL THEN RETURN;END IF;
 PERFORM label_batch_require(uid,kid,true);SELECT * INTO ad FROM shipment_label_batch_admissions WHERE tenant_id=rr.tenant_id AND preview_id=rr.preview_id AND phase='queue';
 IF ad.id IS NULL OR ad.actor_id IS DISTINCT FROM uid OR ad.api_key_id IS DISTINCT FROM kid OR ad.top_xid IS DISTINCT FROM pg_current_xact_id() OR ad.transaction_started_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION 'Pozycję partii można zlecić wyłącznie z całą partią' USING ERRCODE='23514';END IF;END $$;
CREATE FUNCTION label_batch_prepare_queue(pid uuid,eid uuid,v jsonb,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p shipment_label_batch_previews;cp print_label_previews;pa print_label_assets;r jsonb;f jsonb;cfg jsonb;BEGIN
 PERFORM print_job_lock();PERFORM label_batch_require(uid,kid,true);SELECT * INTO p FROM shipment_label_batch_previews WHERE tenant_id=t AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono partii' USING ERRCODE='P0002';END IF;
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (v-ARRAY['client_key','scope_hash','confirmed'])<>'{}'::jsonb OR v->>'client_key' IS NULL OR v->'confirmed' IS DISTINCT FROM 'true'::jsonb OR p.scope_hash IS DISTINCT FROM v->>'scope_hash' OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM shipment_label_batch_executions WHERE tenant_id=t AND preview_id=pid) THEN RAISE EXCEPTION 'Podgląd partii jest nieaktualny lub już użyty' USING ERRCODE='23514';END IF;
 PERFORM label_batch_locks(p.request,uid,kid);
 FOR r IN SELECT value FROM jsonb_array_elements(p.payload->'rows') LOOP
  SELECT * INTO cp FROM print_label_previews WHERE tenant_id=t AND id=(r->>'child_preview_id')::uuid;SELECT * INTO pa FROM print_label_assets WHERE tenant_id=t AND id=cp.asset_id;
  f:=label_cache_selected_frame(cp.shipment_id,cp.request,uid,kid);cfg:=label_print_configuration(cp.request,f->'order_snapshot');
  IF cp.id IS NULL OR cp.scope_hash IS DISTINCT FROM r->>'child_scope_hash' OR cp.expires_at<=clock_timestamp() OR pa.source_frame IS DISTINCT FROM f->'source_frame' OR cfg IS DISTINCT FROM cp.payload-ARRAY['id','shipment_id','order_id','asset_id','source_kind','source_snapshot','format','content_sha256','content_bytes','created_at','expires_at'] OR EXISTS(SELECT 1 FROM print_job_label_sources WHERE tenant_id=t AND preview_id=cp.id) THEN RAISE EXCEPTION 'Jedna pozycja partii zmieniła się' USING ERRCODE='23514';END IF;
 END LOOP;
 INSERT INTO shipment_label_batch_admissions(id,tenant_id,preview_id,execution_id,phase,actor_id,api_key_id,request) VALUES(gen_random_uuid(),t,pid,eid,'queue',uid,kid,v);PERFORM label_batch_require(uid,kid,true);END $$;
CREATE FUNCTION label_batch_execution_replay(pid uuid,v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e shipment_label_batch_executions;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 PERFORM print_job_lock();PERFORM label_batch_require(uid,kid,true);SELECT * INTO e FROM shipment_label_batch_executions WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF e.id IS NULL THEN RETURN NULL;END IF;
 IF e.preview_id IS DISTINCT FROM pid OR e.actor_id IS DISTINCT FROM uid OR e.api_key_id IS DISTINCT FROM kid OR e.request IS DISTINCT FROM v OR e.request_hash IS DISTINCT FROM print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'preview_id',pid,'request',v)) THEN RAISE EXCEPTION 'Klucz kolejki partii ma inną treść' USING ERRCODE='23514';END IF;RETURN e.id;END $$;
CREATE FUNCTION label_batch_validate_execution(e shipment_label_batch_executions) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p shipment_label_batch_previews;ad shipment_label_batch_admissions;r jsonb;er jsonb;l print_job_label_sources;ev print_job_events;j print_jobs;i integer:=0;BEGIN
 IF e.client_key IS DISTINCT FROM (e.request->>'client_key')::uuid THEN RAISE EXCEPTION 'Klucz wykonania nie odpowiada partii' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM shipment_label_batch_previews WHERE tenant_id=e.tenant_id AND id=e.preview_id;SELECT * INTO ad FROM shipment_label_batch_admissions WHERE tenant_id=e.tenant_id AND preview_id=e.preview_id AND phase='queue';
 IF p.id IS NULL OR ad.id IS NULL OR ad.execution_id IS DISTINCT FROM e.id OR ad.actor_id IS DISTINCT FROM e.actor_id OR ad.api_key_id IS DISTINCT FROM e.api_key_id OR ad.request IS DISTINCT FROM e.request OR ad.top_xid IS DISTINCT FROM pg_current_xact_id() OR ad.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR e.top_xid IS DISTINCT FROM ad.top_xid OR e.transaction_started_at IS DISTINCT FROM ad.transaction_started_at OR e.actor_id IS DISTINCT FROM p.actor_id OR e.api_key_id IS DISTINCT FROM p.api_key_id OR e.scope_hash IS DISTINCT FROM p.scope_hash OR e.request->>'scope_hash' IS DISTINCT FROM p.scope_hash OR e.request->'confirmed' IS DISTINCT FROM 'true'::jsonb OR e.request_hash IS DISTINCT FROM print_job_hash(jsonb_build_object('tenant_id',e.tenant_id,'actor_id',e.actor_id,'api_key_id',e.api_key_id,'preview_id',p.id,'request',e.request)) OR jsonb_typeof(e.payload->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(e.payload->'rows')<>jsonb_array_length(p.payload->'rows') THEN RAISE EXCEPTION 'Niepełne atomowe wykonanie partii' USING ERRCODE='23514';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p.payload->'rows') LOOP
  er:=e.payload->'rows'->i;SELECT * INTO l FROM print_job_label_sources WHERE tenant_id=e.tenant_id AND preview_id=(r->>'child_preview_id')::uuid;SELECT * INTO ev FROM print_job_events WHERE tenant_id=e.tenant_id AND job_id=l.job_id AND operation='job_create';SELECT * INTO j FROM print_jobs WHERE tenant_id=e.tenant_id AND id=l.job_id;
  IF ev.actor_id IS DISTINCT FROM e.actor_id OR ev.api_key_id IS DISTINCT FROM e.api_key_id OR j.actor_id IS DISTINCT FROM e.actor_id OR j.api_key_id IS DISTINCT FROM e.api_key_id OR j.client_key IS DISTINCT FROM l.client_key OR j.request_hash IS DISTINCT FROM l.request_hash OR ev.client_key IS DISTINCT FROM l.client_key OR ev.request_hash IS DISTINCT FROM l.request_hash THEN RAISE EXCEPTION 'Principal pozycji kolejki nie odpowiada partii' USING ERRCODE='23514';END IF;
  IF l.job_id IS NULL OR ev.id IS NULL OR j.id IS NULL OR l.actor_id IS DISTINCT FROM e.actor_id OR l.api_key_id IS DISTINCT FROM e.api_key_id OR l.top_xid IS DISTINCT FROM ad.top_xid OR l.transaction_started_at IS DISTINCT FROM ad.transaction_started_at OR ev.top_xid IS DISTINCT FROM ad.top_xid OR ev.transaction_started_at IS DISTINCT FROM ad.transaction_started_at OR l.client_key IS DISTINCT FROM label_batch_child_key(p.id,(r->>'shipment_id')::uuid,'queue') OR l.request IS DISTINCT FROM jsonb_build_object('client_key',l.client_key,'scope_hash',r->'child_scope_hash','confirmed',true) OR j.state<>'queued' OR j.version<>1 OR er IS DISTINCT FROM r||jsonb_build_object('job_id',l.job_id,'job_create_event_id',ev.id) THEN RAISE EXCEPTION 'Brak dokładnej świeżej pozycji kolejki partii' USING ERRCODE='23514';END IF;i:=i+1;
 END LOOP;
 IF e.payload IS DISTINCT FROM jsonb_build_object('id',e.id,'kind','execution','preview_id',p.id,'scope_hash',p.scope_hash,'summary',p.payload->'summary','created_at',e.created_at,'rows',e.payload->'rows') THEN RAISE EXCEPTION 'Niepoprawny receipt kolejki partii' USING ERRCODE='23514';END IF;PERFORM label_batch_require(e.actor_id,e.api_key_id,true);END $$;
CREATE FUNCTION label_batch_store_execution(eid uuid,pid uuid,v jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p shipment_label_batch_previews;r jsonb;l print_job_label_sources;ev print_job_events;rowsv jsonb:='[]';ts timestamptz:=clock_timestamp();BEGIN
 PERFORM print_job_lock();PERFORM label_batch_require(uid,kid,true);SELECT * INTO p FROM shipment_label_batch_previews WHERE tenant_id=t AND id=pid;
 FOR r IN SELECT value FROM jsonb_array_elements(p.payload->'rows') LOOP
  SELECT * INTO l FROM print_job_label_sources WHERE tenant_id=t AND preview_id=(r->>'child_preview_id')::uuid;SELECT * INTO ev FROM print_job_events WHERE tenant_id=t AND job_id=l.job_id AND operation='job_create';rowsv:=rowsv||jsonb_build_array(r||jsonb_build_object('job_id',l.job_id,'job_create_event_id',ev.id));
 END LOOP;
 INSERT INTO shipment_label_batch_executions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash,payload,created_at) VALUES(eid,t,pid,uid,kid,(v->>'client_key')::uuid,print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'preview_id',pid,'request',v)),v,p.scope_hash,jsonb_build_object('id',eid,'kind','execution','preview_id',pid,'scope_hash',p.scope_hash,'summary',p.payload->'summary','created_at',ts,'rows',rowsv),ts);
 INSERT INTO shipment_label_batch_execution_rows(tenant_id,execution_id,preview_id,index,child_preview_id,job_id,job_create_event_id,payload) SELECT t,eid,pid,(z->>'index')::integer,(z->>'child_preview_id')::uuid,(z->>'job_id')::uuid,(z->>'job_create_event_id')::uuid,z FROM jsonb_array_elements(rowsv) z;PERFORM label_print_budget();RETURN eid;END $$;
CREATE FUNCTION label_batch_execution_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Niepoprawny tenant wykonania partii' USING ERRCODE='23514';END IF;PERFORM label_batch_validate_execution(NEW);RETURN NEW;END $$;
CREATE TRIGGER label_batch_execution_guard BEFORE INSERT ON shipment_label_batch_executions FOR EACH ROW EXECUTE FUNCTION label_batch_execution_guard();
CREATE FUNCTION label_batch_row_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ph jsonb;pid uuid;phasev text;ad shipment_label_batch_admissions;BEGIN
 IF TG_TABLE_NAME='shipment_label_batch_preview_rows' THEN SELECT payload INTO ph FROM shipment_label_batch_previews WHERE tenant_id=NEW.tenant_id AND id=NEW.preview_id;pid:=NEW.preview_id;phasev:='preview';
 ELSE SELECT payload INTO ph FROM shipment_label_batch_executions WHERE tenant_id=NEW.tenant_id AND id=NEW.execution_id;pid:=NEW.preview_id;phasev:='queue';END IF;
 SELECT * INTO ad FROM shipment_label_batch_admissions WHERE tenant_id=NEW.tenant_id AND preview_id=pid AND phase=phasev;
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR ph IS NULL OR ad.top_xid IS DISTINCT FROM pg_current_xact_id() OR ad.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR NEW.index NOT BETWEEN 0 AND 49 OR NEW.payload IS DISTINCT FROM ph->'rows'->NEW.index OR NEW.child_preview_id::text IS DISTINCT FROM NEW.payload->>'child_preview_id' THEN RAISE EXCEPTION 'Niepoprawna trwała pozycja partii' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='shipment_label_batch_preview_rows' THEN
  IF NEW.shipment_id::text IS DISTINCT FROM NEW.payload->>'shipment_id' OR NEW.order_id::text IS DISTINCT FROM NEW.payload->>'order_id' OR NEW.cache_asset_id::text IS DISTINCT FROM NEW.payload->>'cache_asset_id' THEN RAISE EXCEPTION 'Niepoprawne źródło pozycji partii' USING ERRCODE='23514';END IF;
 ELSE IF NEW.job_id::text IS DISTINCT FROM NEW.payload->>'job_id' OR NEW.job_create_event_id::text IS DISTINCT FROM NEW.payload->>'job_create_event_id' THEN RAISE EXCEPTION 'Niepoprawne potwierdzenie pozycji partii' USING ERRCODE='23514';END IF;END IF;RETURN NEW;END $$;
CREATE FUNCTION label_batch_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pid uuid;p shipment_label_batch_previews;e shipment_label_batch_executions;ad shipment_label_batch_admissions;n integer;BEGIN
 IF TG_TABLE_NAME='shipment_label_batch_previews' THEN pid:=NEW.id;ELSIF TG_TABLE_NAME='shipment_label_batch_executions' THEN pid:=NEW.preview_id;ELSE pid:=NEW.preview_id;END IF;
 SELECT * INTO p FROM shipment_label_batch_previews WHERE tenant_id=NEW.tenant_id AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Brak trwałego rodzica partii' USING ERRCODE='23514';END IF;
 n:=jsonb_array_length(p.payload->'rows');
 IF (SELECT count(*) FROM shipment_label_batch_preview_rows WHERE tenant_id=p.tenant_id AND preview_id=p.id)<>n OR EXISTS(SELECT 1 FROM shipment_label_batch_preview_rows r WHERE r.tenant_id=p.tenant_id AND r.preview_id=p.id AND r.payload IS DISTINCT FROM p.payload->'rows'->r.index) THEN RAISE EXCEPTION 'Niepełny zbiór podglądów partii' USING ERRCODE='23514';END IF;
 SELECT * INTO ad FROM shipment_label_batch_admissions WHERE tenant_id=p.tenant_id AND preview_id=p.id AND phase='preview';IF ad.top_xid=pg_current_xact_id() AND ad.transaction_started_at=transaction_timestamp() THEN PERFORM label_batch_validate_preview(p);END IF;
 SELECT * INTO e FROM shipment_label_batch_executions WHERE tenant_id=p.tenant_id AND preview_id=p.id;
 IF TG_TABLE_NAME='shipment_label_batch_admissions' AND to_jsonb(NEW)->>'phase'='queue' AND e.id IS NULL THEN RAISE EXCEPTION 'Brak atomowego wyniku partii' USING ERRCODE='23514';END IF;
 IF e.id IS NOT NULL AND e.top_xid=pg_current_xact_id() AND e.transaction_started_at=transaction_timestamp() THEN
  IF (SELECT count(*) FROM shipment_label_batch_execution_rows WHERE tenant_id=e.tenant_id AND execution_id=e.id)<>n OR EXISTS(SELECT 1 FROM shipment_label_batch_execution_rows r WHERE r.tenant_id=e.tenant_id AND r.execution_id=e.id AND (r.preview_id IS DISTINCT FROM p.id OR r.payload IS DISTINCT FROM e.payload->'rows'->r.index)) THEN RAISE EXCEPTION 'Niepełny zbiór jobów partii' USING ERRCODE='23514';END IF;PERFORM label_batch_validate_execution(e);
 END IF;PERFORM label_print_budget();RETURN NULL;END $$;
CREATE FUNCTION label_batch_child_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r shipment_label_batch_preview_rows;ad shipment_label_batch_admissions;BEGIN
 SELECT * INTO r FROM shipment_label_batch_preview_rows WHERE tenant_id=NEW.tenant_id AND child_preview_id=NEW.preview_id;IF r.preview_id IS NULL THEN RETURN NEW;END IF;
 PERFORM label_batch_child_allowed(NEW.preview_id,NEW.actor_id,NEW.api_key_id);SELECT * INTO ad FROM shipment_label_batch_admissions WHERE tenant_id=r.tenant_id AND preview_id=r.preview_id AND phase='queue';
 IF NEW.client_key IS DISTINCT FROM label_batch_child_key(r.preview_id,r.shipment_id,'queue') OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',r.payload->'child_scope_hash','confirmed',true) OR NEW.top_xid IS DISTINCT FROM ad.top_xid OR NEW.transaction_started_at IS DISTINCT FROM ad.transaction_started_at THEN RAISE EXCEPTION 'Pozycja kolejki nie jest częścią zatwierdzonej partii' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER label_batch_child_guard BEFORE INSERT ON print_job_label_sources FOR EACH ROW EXECUTE FUNCTION label_batch_child_guard();
CREATE FUNCTION label_batch_content(pid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p shipment_label_batch_previews;BEGIN PERFORM label_batch_require(uid,kid,true);SELECT * INTO p FROM shipment_label_batch_previews WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono PDF partii' USING ERRCODE='P0002';END IF;RETURN jsonb_build_object('combined_content_encrypted',p.combined_content_encrypted,'metadata',p.payload->'combined_pdf');END $$;
CREATE FUNCTION label_batch_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Historia partii etykiet jest niezmienna' USING ERRCODE='23514';END $$;
CREATE OR REPLACE FUNCTION label_print_queue(pid uuid,v jsonb,b64 text,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; p print_label_previews; a print_label_assets; j print_jobs; l print_job_label_sources; f jsonb; config jsonb; rh text; outv jsonb; ts timestamptz:=clock_timestamp();
BEGIN

 PERFORM label_batch_child_allowed(pid,uid,kid);
 PERFORM label_print_require(uid,kid,true); PERFORM print_job_lock();
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (v-ARRAY['client_key','scope_hash','confirmed'])<>'{}'::jsonb OR v->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Niepoprawna zgoda kolejki etykiety' USING ERRCODE='23514'; END IF;
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'preview_id',pid,'request',v));
 SELECT * INTO l FROM print_job_label_sources WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF l.job_id IS NOT NULL THEN
  IF l.preview_id IS DISTINCT FROM pid OR l.actor_id IS DISTINCT FROM uid OR l.api_key_id IS DISTINCT FROM kid OR l.request_hash IS DISTINCT FROM rh THEN RAISE EXCEPTION 'Klucz kolejki etykiety ma inną treść' USING ERRCODE='23514'; END IF;
  outv:=print_job_replay(l.client_key,rh,uid,kid,'job_create',l.job_id); IF outv IS NULL THEN RAISE EXCEPTION 'Brak potwierdzenia kolejki etykiety' USING ERRCODE='23514'; END IF; RETURN outv||jsonb_build_object('preview_id',pid);
 END IF;
 SELECT * INTO p FROM print_label_previews WHERE tenant_id=t AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu etykiety' USING ERRCODE='P0002'; END IF;
 IF p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.scope_hash IS DISTINCT FROM v->>'scope_hash' OR p.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM print_job_label_sources WHERE tenant_id=t AND preview_id=pid) THEN RAISE EXCEPTION 'Podgląd etykiety jest nieaktualny lub już użyty' USING ERRCODE='23514'; END IF;
 f:=label_cache_selected_frame(p.shipment_id,p.request,uid,kid); config:=label_print_configuration(p.request,f->'order_snapshot');
 SELECT * INTO a FROM print_label_assets WHERE tenant_id=t AND id=p.asset_id;
 IF a.source_frame IS DISTINCT FROM f->'source_frame' OR config IS DISTINCT FROM p.payload-ARRAY['id','shipment_id','order_id','asset_id','source_kind','source_snapshot','format','content_sha256','content_bytes','created_at','expires_at'] OR print_job_hash(p.payload) IS DISTINCT FROM p.scope_hash OR print_job_content_valid(b64,'pdf') IS NOT TRUE OR encode(sha256(decode(b64,'base64')),'hex') IS DISTINCT FROM a.content_sha256 OR octet_length(decode(b64,'base64')) IS DISTINCT FROM a.content_bytes OR (a.source_kind='dpd_cached' AND b64 IS DISTINCT FROM f->>'content_base64') THEN RAISE EXCEPTION 'Etykieta lub zakres podglądu zmieniły się' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM print_job_events WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid) THEN RAISE EXCEPTION 'Klucz polecenia drukowania ma inną treść' USING ERRCODE='23514'; END IF;
 j.id:=gen_random_uuid(); j.tenant_id:=t; j.order_id:=p.order_id; j.station_id:=p.station_id; j.printer_id:=p.printer_id; j.actor_id:=uid; j.api_key_id:=kid; j.client_key:=(v->>'client_key')::uuid; j.request_hash:=rh; j.order_snapshot:=p.payload->'order_snapshot'; j.station_snapshot:=p.payload->'station_snapshot'; j.printer_snapshot:=p.payload->'printer_snapshot'; j.source_kind:='shipment_label'; j.format:='pdf'; j.copies:=(p.payload->>'copies')::integer; j.content_base64:=b64; j.content_sha256:=a.content_sha256; j.content_bytes:=a.content_bytes; j.version:=1; j.state:='queued'; j.created_at:=ts; j.updated_at:=ts;
 INSERT INTO print_job_label_sources(tenant_id,job_id,preview_id,asset_id,shipment_id,order_id,actor_id,api_key_id,client_key,request_hash,request,created_at) VALUES(t,j.id,pid,a.id,p.shipment_id,p.order_id,uid,kid,j.client_key,rh,v,ts);
 outv:=print_job_event(gen_random_uuid(),j.id,NULL,uid,kid,j.client_key,rh,'job_create',NULL,print_job_head(to_jsonb(j)),jsonb_build_object('preview_id',pid,'shipment_id',p.shipment_id,'asset_id',a.id,'source_kind',a.source_kind));
 INSERT INTO print_jobs SELECT j.*; PERFORM label_print_budget(); IF p.request->>'asset_id' IS NOT NULL THEN PERFORM label_cache_require(uid,kid,true); END IF; PERFORM label_print_require(uid,kid,true); RETURN outv||jsonb_build_object('preview_id',pid);
END $$;
CREATE OR REPLACE FUNCTION label_print_queue_replay(pid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; l print_job_label_sources; rh text; outv jsonb; BEGIN

 PERFORM label_batch_child_allowed(pid,uid,kid);
 PERFORM label_print_require(uid,kid,true);
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'preview_id',pid,'request',v));
 SELECT * INTO l FROM print_job_label_sources WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF l.job_id IS NULL THEN RETURN NULL; END IF;
 IF l.preview_id IS DISTINCT FROM pid OR l.actor_id IS DISTINCT FROM uid OR l.api_key_id IS DISTINCT FROM kid OR l.request_hash IS DISTINCT FROM rh THEN RAISE EXCEPTION 'Klucz kolejki etykiety ma inną treść' USING ERRCODE='23514'; END IF;
 outv:=print_job_replay(l.client_key,rh,uid,kid,'job_create',l.job_id); IF outv IS NULL THEN RAISE EXCEPTION 'Brak potwierdzenia kolejki etykiety' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND id=pid AND request->>'asset_id' IS NOT NULL) THEN PERFORM label_cache_require(uid,kid,true); END IF;
 RETURN outv||jsonb_build_object('preview_id',pid);
END $$;
CREATE OR REPLACE FUNCTION label_print_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; n bigint; BEGIN
 PERFORM print_job_budget();
 IF (SELECT count(*) FROM shipment_label_batch_previews WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_batch_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii partii etykiet' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM shipment_label_cache_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_cache_acquisitions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit cache etykiet' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM print_label_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_label_previews WHERE tenant_id=t)>2000 OR EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND octet_length(payload::text)+octet_length(request::text)>4194304) THEN RAISE EXCEPTION 'Limit historii etykiet drukowania' USING ERRCODE='23514'; END IF;
 SELECT coalesce((SELECT sum(octet_length(content_base64)+octet_length(order_snapshot::text)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM print_label_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM print_label_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+512) FROM print_job_label_sources WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM shipment_label_cache_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(source_frame::text)+1024) FROM shipment_label_cache_acquisitions WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(combined_content_encrypted)+octet_length(payload::text)+octet_length(request::text)+512) FROM shipment_label_batch_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+512) FROM shipment_label_batch_preview_rows WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM shipment_label_batch_executions WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+512) FROM shipment_label_batch_execution_rows WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(witnesses::text)+512) FROM shipment_label_batch_admissions WHERE tenant_id=t),0) INTO n;
 IF n>67108864 THEN RAISE EXCEPTION 'Limit historii drukowania' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION label_batch_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE oldv jsonb;newv jsonb;a shipment_label_batch_admissions;x jsonb;s shipments;ca shipment_label_cache_assets;BEGIN
 IF TG_OP<>'INSERT' THEN oldv:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN newv:=to_jsonb(NEW);END IF;
 FOR a IN SELECT * FROM shipment_label_batch_admissions WHERE tenant_id IN((newv->>'tenant_id')::uuid,(oldv->>'tenant_id')::uuid) AND top_xid=pg_current_xact_id() AND transaction_started_at=transaction_timestamp() LOOP
  FOR x IN SELECT value FROM jsonb_array_elements(CASE WHEN a.phase='preview' THEN a.request->'shipments' ELSE (SELECT request->'shipments' FROM shipment_label_batch_previews WHERE tenant_id=a.tenant_id AND id=a.preview_id) END) LOOP
   SELECT * INTO s FROM shipments WHERE tenant_id=a.tenant_id AND id=(x->>'shipment_id')::uuid;SELECT * INTO ca FROM shipment_label_cache_assets WHERE tenant_id=a.tenant_id AND id=(x->>'asset_id')::uuid;
   IF (TG_TABLE_NAME='orders' AND s.order_id::text IN(oldv->>'id',newv->>'id')) OR (TG_TABLE_NAME='shipments' AND s.id::text IN(oldv->>'id',newv->>'id')) OR (TG_TABLE_NAME='channels' AND ca.channel_id::text IN(oldv->>'id',newv->>'id')) OR (TG_TABLE_NAME='shipping_plans' AND s.id::text IN(oldv->>'shipment_id',newv->>'shipment_id')) THEN RAISE EXCEPTION 'Źródło zatwierdzonej partii jest zamrożone' USING ERRCODE='23514';END IF;
  END LOOP;
  IF TG_TABLE_NAME IN('packing_stations','print_printers') AND ((CASE WHEN a.phase='preview' THEN a.request ELSE (SELECT request FROM shipment_label_batch_previews WHERE tenant_id=a.tenant_id AND id=a.preview_id) END)->>(CASE WHEN TG_TABLE_NAME='packing_stations' THEN 'station_id' ELSE 'printer_id' END)) IN(oldv->>'id',newv->>'id') THEN RAISE EXCEPTION 'Konfiguracja zatwierdzonej partii jest zamrożona' USING ERRCODE='23514';END IF;
 END LOOP;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END $$;
DO $$ DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['shipment_label_batch_previews','shipment_label_batch_preview_rows','shipment_label_batch_executions','shipment_label_batch_execution_rows'] LOOP EXECUTE format('CREATE TRIGGER label_batch_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION label_batch_immutable()',rel);END LOOP;
 FOREACH rel IN ARRAY ARRAY['shipment_label_batch_previews','shipment_label_batch_executions','shipment_label_batch_admissions'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER label_batch_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION label_batch_complete()',rel);END LOOP;
 FOREACH rel IN ARRAY ARRAY['shipment_label_batch_preview_rows','shipment_label_batch_execution_rows'] LOOP EXECUTE format('CREATE TRIGGER label_batch_row_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION label_batch_row_guard()',rel);END LOOP;
 FOREACH rel IN ARRAY ARRAY['orders','shipments','channels','packing_stations','print_printers'] LOOP EXECUTE format('CREATE TRIGGER label_batch_seal BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION label_batch_seal()',rel);END LOOP;
 CREATE TRIGGER label_batch_seal BEFORE INSERT OR UPDATE OR DELETE ON shipping_plans FOR EACH ROW EXECUTE FUNCTION label_batch_seal();
 FOREACH rel IN ARRAY ARRAY['shipment_label_batch_previews','shipment_label_batch_preview_rows','shipment_label_batch_executions','shipment_label_batch_execution_rows','shipment_label_batch_admissions'] LOOP EXECUTE format('CREATE TRIGGER label_batch_budget AFTER INSERT OR UPDATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION label_print_budget_trigger()',rel);END LOOP;
END $$;
CREATE FUNCTION label_batch_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin' AND label_cache_guards()
 AND (SELECT count(*) FROM pg_class WHERE oid=ANY(ARRAY(SELECT to_regclass(n) FROM unnest(ARRAY['shipment_label_batch_previews','shipment_label_batch_preview_rows','shipment_label_batch_executions','shipment_label_batch_execution_rows','shipment_label_batch_admissions']) n)) AND relrowsecurity AND relforcerowsecurity)=5
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['label_batch_installed()','label_batch_require(uuid,uuid,boolean)','label_batch_child_key(uuid,uuid,text)','label_batch_request_valid(jsonb)','label_batch_child_request(uuid,jsonb,jsonb)','label_batch_locks(jsonb,uuid,uuid)','label_batch_preview_replay(jsonb,uuid,uuid)','label_batch_prepare_preview(uuid,jsonb,uuid,uuid)','label_batch_witness()','label_batch_admission_guard()','label_batch_store_preview(jsonb,uuid,uuid)','label_batch_validate_preview(shipment_label_batch_previews)','label_batch_preview_guard()','label_batch_child_allowed(uuid,uuid,uuid)','label_batch_prepare_queue(uuid,uuid,jsonb,uuid,uuid)','label_batch_execution_replay(uuid,jsonb,uuid,uuid)','label_batch_validate_execution(shipment_label_batch_executions)','label_batch_store_execution(uuid,uuid,jsonb,uuid,uuid)','label_batch_execution_guard()','label_batch_row_guard()','label_batch_complete()','label_batch_child_guard()','label_batch_content(uuid,uuid,uuid)','label_batch_immutable()','label_batch_seal()']) n WHERE to_regprocedure(n) IS NULL)
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['shipment_label_batch_previews','shipment_label_batch_preview_rows','shipment_label_batch_executions','shipment_label_batch_execution_rows','shipment_label_batch_admissions']) n WHERE has_table_privilege('dyna_app',to_regclass(n),'INSERT,UPDATE,DELETE'))
 AND NOT has_table_privilege('dyna_app',to_regclass('shipment_label_batch_admissions'),'SELECT')
 AND NOT has_column_privilege('dyna_app',to_regclass('shipment_label_batch_previews'),'combined_content_encrypted','SELECT')
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('shipment_label_batch_previews') AND contype='f' AND convalidated AND cardinality(conkey)=2)=1
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('shipment_label_batch_preview_rows') AND contype='f' AND convalidated)=6
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('shipment_label_batch_executions') AND contype='f' AND convalidated AND cardinality(conkey)=2)=2
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('shipment_label_batch_execution_rows') AND contype='f' AND convalidated)=6
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('shipment_label_batch_admissions') AND contype='f' AND convalidated AND condeferrable AND condeferred)=2
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['label_batch_preview_page','label_batch_execution_page']) n WHERE NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass(n) AND i.indisvalid))
 AND NOT EXISTS(SELECT 1 FROM (
 SELECT x rel,'label_batch_immutable' name,'label_batch_immutable()' fn,false d FROM unnest(ARRAY['shipment_label_batch_previews','shipment_label_batch_preview_rows','shipment_label_batch_executions','shipment_label_batch_execution_rows']) x
 UNION ALL SELECT x,'label_batch_complete','label_batch_complete()',true FROM unnest(ARRAY['shipment_label_batch_previews','shipment_label_batch_executions','shipment_label_batch_admissions']) x
 UNION ALL SELECT x,'label_batch_budget','label_print_budget_trigger()',false FROM unnest(ARRAY['shipment_label_batch_previews','shipment_label_batch_preview_rows','shipment_label_batch_executions','shipment_label_batch_execution_rows','shipment_label_batch_admissions']) x
 UNION ALL SELECT x,'label_batch_row_guard','label_batch_row_guard()',false FROM unnest(ARRAY['shipment_label_batch_preview_rows','shipment_label_batch_execution_rows']) x
 UNION ALL SELECT x,'label_batch_seal','label_batch_seal()',false FROM unnest(ARRAY['orders','shipments','channels','packing_stations','print_printers','shipping_plans']) x
 UNION ALL SELECT 'shipment_label_batch_previews','label_batch_preview_guard','label_batch_preview_guard()',false
 UNION ALL SELECT 'shipment_label_batch_executions','label_batch_execution_guard','label_batch_execution_guard()',false
 UNION ALL SELECT 'shipment_label_batch_admissions','label_batch_admission_guard','label_batch_admission_guard()',false
 UNION ALL SELECT 'print_label_previews','label_batch_witness','label_batch_witness()',false
 UNION ALL SELECT 'print_job_label_sources','label_batch_child_guard','label_batch_child_guard()',false
 ) g WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(g.rel) AND t.tgname::text=g.name AND t.tgfoid=to_regprocedure(g.fn) AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgdeferrable=g.d AND t.tginitdeferred=g.d))
$$;
DO $$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'label_batch_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.sig);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION label_batch_installed(),label_batch_guards(),label_batch_preview_replay(jsonb,uuid,uuid),label_batch_prepare_preview(uuid,jsonb,uuid,uuid),label_batch_store_preview(jsonb,uuid,uuid),label_batch_prepare_queue(uuid,uuid,jsonb,uuid,uuid),label_batch_execution_replay(uuid,jsonb,uuid,uuid),label_batch_store_execution(uuid,uuid,jsonb,uuid,uuid),label_batch_content(uuid,uuid,uuid),label_batch_child_allowed(uuid,uuid,uuid) TO dyna_app;
