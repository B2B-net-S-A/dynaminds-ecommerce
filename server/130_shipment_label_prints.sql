-- Server-owned local label assets. No network or carrier dispatch in this module.
ALTER TABLE shipping_plans ADD CONSTRAINT shipping_plans_tenant_id_unique UNIQUE(tenant_id,id);
ALTER TABLE print_jobs DROP CONSTRAINT print_jobs_source_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_source_kind_check CHECK(source_kind IN('manual','shipment_label'));
CREATE TABLE print_label_assets (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), shipment_id uuid NOT NULL, order_id uuid NOT NULL, shipping_plan_id uuid,
 source_kind text NOT NULL CHECK(source_kind IN('dpd_cached','demo_generated')), source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'), source_frame jsonb NOT NULL,
 content_encrypted text NOT NULL, content_sha256 text NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'), content_bytes integer NOT NULL CHECK(content_bytes BETWEEN 1 AND 2097152), format text NOT NULL CHECK(format='pdf'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,shipment_id,source_hash,content_sha256),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id), FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id), FOREIGN KEY(tenant_id,shipping_plan_id) REFERENCES shipping_plans(tenant_id,id)
);
CREATE TABLE print_label_previews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), asset_id uuid NOT NULL, shipment_id uuid NOT NULL, order_id uuid NOT NULL, station_id uuid NOT NULL, printer_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), api_key_id uuid, client_key uuid NOT NULL, request_hash text NOT NULL, request jsonb NOT NULL,
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'), payload jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,client_key), FOREIGN KEY(tenant_id,asset_id) REFERENCES print_label_assets(tenant_id,id), FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id), FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id), FOREIGN KEY(tenant_id,station_id) REFERENCES packing_stations(tenant_id,id), FOREIGN KEY(tenant_id,printer_id) REFERENCES print_printers(tenant_id,id), FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE print_job_label_sources (
 tenant_id uuid NOT NULL REFERENCES tenants(id), job_id uuid NOT NULL, preview_id uuid NOT NULL, asset_id uuid NOT NULL, shipment_id uuid NOT NULL, order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), api_key_id uuid, client_key uuid NOT NULL, request_hash text NOT NULL, request jsonb NOT NULL,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,job_id), UNIQUE(tenant_id,preview_id), UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,job_id) REFERENCES print_jobs(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,preview_id) REFERENCES print_label_previews(tenant_id,id), FOREIGN KEY(tenant_id,asset_id) REFERENCES print_label_assets(tenant_id,id), FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id), FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id), FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX print_label_preview_page ON print_label_previews(tenant_id,created_at DESC,id DESC);
DO $$ DECLARE rel text; BEGIN
 FOREACH rel IN ARRAY ARRAY['print_label_assets','print_label_previews','print_job_label_sources'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
  EXECUTE format('CREATE POLICY label_print_tenant ON %I TO dyna_app USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
  EXECUTE format('CREATE POLICY label_print_owner ON %I TO %I USING (true) WITH CHECK (true)',rel,current_user);
 END LOOP;
END $$;
REVOKE ALL ON print_label_assets,print_label_previews,print_job_label_sources FROM PUBLIC,dyna_app;
GRANT SELECT(id,tenant_id,shipment_id,order_id,shipping_plan_id,source_kind,source_hash,content_sha256,content_bytes,format,created_at) ON print_label_assets TO dyna_app;
GRANT SELECT ON print_label_previews,print_job_label_sources TO dyna_app;
CREATE FUNCTION label_print_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM migrations WHERE name='130_shipment_label_prints') $$;
CREATE FUNCTION label_print_require(uid uuid,kid uuid,writing boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF label_print_guards() IS NOT TRUE OR label_print_installed() IS NOT TRUE THEN RAISE EXCEPTION 'Moduł kolejki etykiet jest niekompletny' USING ERRCODE='55000'; END IF;
 PERFORM print_job_require(uid,kid,writing,false);
END $$;
CREATE FUNCTION label_print_frame(sid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; s shipments; o orders; p shipping_plans; src jsonb; renderer jsonb; b64 text; kind text; n integer;
BEGIN
 PERFORM label_print_require(uid,kid,true); PERFORM print_job_lock();
 SELECT * INTO s FROM shipments WHERE tenant_id=t AND id=sid;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono przesyłki do drukowania' USING ERRCODE='P0002'; END IF;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=s.order_id FOR UPDATE;
 SELECT * INTO s FROM shipments WHERE tenant_id=t AND id=sid FOR UPDATE;
 IF o.id IS NULL OR s.order_id IS DISTINCT FROM o.id OR s.status IN('cancelled','voided') THEN RAISE EXCEPTION 'Przesyłka nie ma aktualnego źródła etykiety' USING ERRCODE='23514'; END IF;
 IF s.mode='demo' THEN
  kind:='demo_generated'; renderer:=jsonb_build_object('order_number',o.number,'tracking_number',s.tracking_number,'carrier',s.carrier,'recipient',jsonb_build_object('name',o.customer_name,'address',jsonb_build_object('street',o.address->>'street','postal_code',o.address->>'postal_code','city',o.address->>'city','country',o.address->>'country')));
 ELSIF s.carrier='DPD Polska' THEN
  SELECT count(*) INTO n FROM shipping_plans WHERE tenant_id=t AND shipment_id=sid AND input->>'provider'='dpd' AND state IN('ready','dispatched') AND result->>'tracking_number'=s.tracking_number;
  IF n<>1 THEN RAISE EXCEPTION 'Brak jednoznacznej lokalnej etykiety DPD' USING ERRCODE='23514'; END IF;
  SELECT * INTO p FROM shipping_plans WHERE tenant_id=t AND shipment_id=sid AND input->>'provider'='dpd' AND state IN('ready','dispatched') AND result->>'tracking_number'=s.tracking_number FOR UPDATE;
  IF p.order_id IS DISTINCT FROM o.id OR p.channel_id IS DISTINCT FROM s.channel_id OR p.remote_id IS DISTINCT FROM s.external_id OR p.result->>'waybill' IS DISTINCT FROM s.tracking_number OR p.result->>'label_base64' IS NULL THEN RAISE EXCEPTION 'Brak zapisanych lokalnie bajtów etykiety' USING ERRCODE='23514'; END IF;
  b64:=p.result->>'label_base64'; kind:='dpd_cached';
  IF print_job_content_valid(b64,'pdf') IS NOT TRUE THEN RAISE EXCEPTION 'Zapisana etykieta nie spełnia limitu bezpiecznego PDF' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Brak zapisanych lokalnie bajtów etykiety; pobieranie dostawcy jest wyłączone' USING ERRCODE='23514'; END IF;
 src:=jsonb_build_object('source_kind',kind,'shipment',jsonb_build_object('id',s.id,'order_id',s.order_id,'carrier',s.carrier,'tracking_number',s.tracking_number,'mode',s.mode,'status',s.status,'channel_id',s.channel_id,'external_id',s.external_id,'dispatched_at',s.dispatched_at),'plan',CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'order_id',p.order_id,'shipment_id',p.shipment_id,'channel_id',p.channel_id,'state',p.state,'phase',p.phase,'remote_id',p.remote_id,'updated_at',p.updated_at,'content_sha256',encode(sha256(decode(b64,'base64')),'hex')) END,'renderer_input',renderer);
 PERFORM label_print_require(uid,kid,true);
 RETURN jsonb_build_object('source_frame',src,'source_hash',print_job_hash(src),'source_kind',kind,'shipping_plan_id',p.id,'order_snapshot',jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'warehouse_id',o.warehouse_id),'renderer_input',renderer,'content_base64',b64);
END $$;
CREATE FUNCTION label_print_configuration(v jsonb,orderh jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; st packing_stations; p print_printers;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (v-ARRAY['client_key','order_version','station_id','station_version','printer_id','printer_version','copies'])<>'{}'::jsonb OR jsonb_typeof(v->'copies') IS DISTINCT FROM 'number' OR (v->>'copies') !~ '^[0-9]+$' OR (v->>'copies')::integer NOT BETWEEN 1 AND 10 OR orderh->>'version' IS DISTINCT FROM v->>'order_version' THEN RAISE EXCEPTION 'Niepoprawny podgląd konfiguracji etykiety' USING ERRCODE='23514'; END IF;
 SELECT * INTO st FROM packing_stations WHERE tenant_id=t AND id=(v->>'station_id')::uuid FOR UPDATE;
 SELECT * INTO p FROM print_printers WHERE tenant_id=t AND id=(v->>'printer_id')::uuid FOR UPDATE;
 IF st.id IS NULL OR p.id IS NULL OR NOT st.enabled OR NOT p.enabled OR p.format<>'pdf' OR p.station_id IS DISTINCT FROM st.id OR st.version::text IS DISTINCT FROM v->>'station_version' OR p.version::text IS DISTINCT FROM v->>'printer_version' THEN RAISE EXCEPTION 'Konfiguracja drukowania etykiety zmieniła się' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('order_snapshot',orderh,'station_snapshot',jsonb_build_object('id',st.id,'code',st.code,'label',st.label,'version',st.version::text,'enabled',st.enabled),'printer_snapshot',print_job_printer_head(to_jsonb(p)),'copies',(v->>'copies')::integer);
END $$;
CREATE FUNCTION label_print_preview_replay(sid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p print_label_previews; t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 PERFORM label_print_require(uid,kid,true);
 SELECT * INTO p FROM print_label_previews WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p.shipment_id IS DISTINCT FROM sid OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.request_hash IS DISTINCT FROM print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'shipment_id',sid,'request',v)) THEN RAISE EXCEPTION 'Klucz podglądu etykiety ma inną treść' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('preview_id',p.id,'reused',true);
END $$;
CREATE FUNCTION label_print_store_preview(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; f jsonb; config jsonb; old jsonb; a print_label_assets; ph jsonb; rh text; ts timestamptz:=clock_timestamp(); pid uuid;
BEGIN
 PERFORM print_job_lock(); old:=label_print_preview_replay((v->>'shipment_id')::uuid,v->'request',uid,kid); IF old IS NOT NULL THEN RETURN old; END IF;
 f:=label_print_frame((v->>'shipment_id')::uuid,uid,kid); config:=label_print_configuration(v->'request',f->'order_snapshot');
 IF v->'source_frame' IS DISTINCT FROM f->'source_frame' OR print_job_content_valid(v->>'content_base64','pdf') IS NOT TRUE OR (f->>'source_kind'='dpd_cached' AND v->>'content_base64' IS DISTINCT FROM f->>'content_base64') OR jsonb_typeof(v->'content_encrypted') IS DISTINCT FROM 'string' OR length(v->>'content_encrypted') NOT BETWEEN 40 AND 4000000 THEN RAISE EXCEPTION 'Źródło etykiety zmieniło się podczas podglądu' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM print_label_assets WHERE tenant_id=t AND shipment_id=(v->>'shipment_id')::uuid AND source_hash=f->>'source_hash' AND content_sha256=encode(sha256(decode(v->>'content_base64','base64')),'hex');
 IF a.id IS NULL THEN
  a.id:=gen_random_uuid(); a.tenant_id:=t; a.shipment_id:=(v->>'shipment_id')::uuid; a.order_id:=(f->'order_snapshot'->>'id')::uuid; a.shipping_plan_id:=(f->>'shipping_plan_id')::uuid; a.source_kind:=f->>'source_kind'; a.source_hash:=f->>'source_hash'; a.source_frame:=f->'source_frame'; a.content_encrypted:=v->>'content_encrypted'; a.content_sha256:=encode(sha256(decode(v->>'content_base64','base64')),'hex'); a.content_bytes:=octet_length(decode(v->>'content_base64','base64')); a.format:='pdf'; a.created_at:=ts;
  INSERT INTO print_label_assets SELECT a.*;
 END IF;
 pid:=gen_random_uuid();
 ph:=config||jsonb_build_object('id',pid,'shipment_id',a.shipment_id,'order_id',a.order_id,'asset_id',a.id,'source_kind',a.source_kind,'source_snapshot',jsonb_build_object('carrier',f->'source_frame'->'shipment'->'carrier','mode',f->'source_frame'->'shipment'->'mode','tracking_number',f->'source_frame'->'shipment'->'tracking_number','shipping_plan_id',a.shipping_plan_id,'source_hash',a.source_hash),'format','pdf','content_sha256',a.content_sha256,'content_bytes',a.content_bytes,'created_at',ts,'expires_at',ts+interval '15 minutes');
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'shipment_id',a.shipment_id,'request',v->'request'));
 INSERT INTO print_label_previews(id,tenant_id,asset_id,shipment_id,order_id,station_id,printer_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash,payload,expires_at,created_at)
 VALUES(pid,t,a.id,a.shipment_id,a.order_id,(v->'request'->>'station_id')::uuid,(v->'request'->>'printer_id')::uuid,uid,kid,(v->'request'->>'client_key')::uuid,rh,v->'request',print_job_hash(ph),ph,ts+interval '15 minutes',ts);
 PERFORM label_print_budget(); PERFORM label_print_require(uid,kid,true); RETURN jsonb_build_object('preview_id',pid,'reused',false);
END $$;
CREATE FUNCTION label_print_asset(pid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p print_label_previews; a print_label_assets; BEGIN
 PERFORM label_print_require(uid,kid,true);
 SELECT * INTO p FROM print_label_previews WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu etykiety' USING ERRCODE='P0002'; END IF;
 SELECT * INTO a FROM print_label_assets WHERE tenant_id=p.tenant_id AND id=p.asset_id;
 RETURN jsonb_build_object('content_encrypted',a.content_encrypted,'content_sha256',a.content_sha256,'content_bytes',a.content_bytes,'format',a.format);
END $$;
CREATE FUNCTION label_print_queue_replay(pid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; l print_job_label_sources; rh text; outv jsonb; BEGIN
 PERFORM label_print_require(uid,kid,true);
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'preview_id',pid,'request',v));
 SELECT * INTO l FROM print_job_label_sources WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF l.job_id IS NULL THEN RETURN NULL; END IF;
 IF l.preview_id IS DISTINCT FROM pid OR l.actor_id IS DISTINCT FROM uid OR l.api_key_id IS DISTINCT FROM kid OR l.request_hash IS DISTINCT FROM rh THEN RAISE EXCEPTION 'Klucz kolejki etykiety ma inną treść' USING ERRCODE='23514'; END IF;
 outv:=print_job_replay(l.client_key,rh,uid,kid,'job_create',l.job_id); IF outv IS NULL THEN RAISE EXCEPTION 'Brak potwierdzenia kolejki etykiety' USING ERRCODE='23514'; END IF;
 RETURN outv||jsonb_build_object('preview_id',pid);
END $$;
CREATE FUNCTION label_print_queue(pid uuid,v jsonb,b64 text,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; p print_label_previews; a print_label_assets; j print_jobs; l print_job_label_sources; f jsonb; config jsonb; rh text; outv jsonb; ts timestamptz:=clock_timestamp();
BEGIN
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
 f:=label_print_frame(p.shipment_id,uid,kid); config:=label_print_configuration(p.request,f->'order_snapshot');
 SELECT * INTO a FROM print_label_assets WHERE tenant_id=t AND id=p.asset_id;
 IF a.source_frame IS DISTINCT FROM f->'source_frame' OR config IS DISTINCT FROM p.payload-ARRAY['id','shipment_id','order_id','asset_id','source_kind','source_snapshot','format','content_sha256','content_bytes','created_at','expires_at'] OR print_job_hash(p.payload) IS DISTINCT FROM p.scope_hash OR print_job_content_valid(b64,'pdf') IS NOT TRUE OR encode(sha256(decode(b64,'base64')),'hex') IS DISTINCT FROM a.content_sha256 OR octet_length(decode(b64,'base64')) IS DISTINCT FROM a.content_bytes OR (a.source_kind='dpd_cached' AND b64 IS DISTINCT FROM f->>'content_base64') THEN RAISE EXCEPTION 'Etykieta lub zakres podglądu zmieniły się' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM print_job_events WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid) THEN RAISE EXCEPTION 'Klucz polecenia drukowania ma inną treść' USING ERRCODE='23514'; END IF;
 j.id:=gen_random_uuid(); j.tenant_id:=t; j.order_id:=p.order_id; j.station_id:=p.station_id; j.printer_id:=p.printer_id; j.actor_id:=uid; j.api_key_id:=kid; j.client_key:=(v->>'client_key')::uuid; j.request_hash:=rh; j.order_snapshot:=p.payload->'order_snapshot'; j.station_snapshot:=p.payload->'station_snapshot'; j.printer_snapshot:=p.payload->'printer_snapshot'; j.source_kind:='shipment_label'; j.format:='pdf'; j.copies:=(p.payload->>'copies')::integer; j.content_base64:=b64; j.content_sha256:=a.content_sha256; j.content_bytes:=a.content_bytes; j.version:=1; j.state:='queued'; j.created_at:=ts; j.updated_at:=ts;
 INSERT INTO print_job_label_sources(tenant_id,job_id,preview_id,asset_id,shipment_id,order_id,actor_id,api_key_id,client_key,request_hash,request,created_at) VALUES(t,j.id,pid,a.id,p.shipment_id,p.order_id,uid,kid,j.client_key,rh,v,ts);
 outv:=print_job_event(gen_random_uuid(),j.id,NULL,uid,kid,j.client_key,rh,'job_create',NULL,print_job_head(to_jsonb(j)),jsonb_build_object('preview_id',pid,'shipment_id',p.shipment_id,'asset_id',a.id,'source_kind',a.source_kind));
 INSERT INTO print_jobs SELECT j.*; PERFORM label_print_budget(); PERFORM label_print_require(uid,kid,true); RETURN outv||jsonb_build_object('preview_id',pid);
END $$;
CREATE FUNCTION label_print_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; n bigint; BEGIN
 PERFORM print_job_budget();
 IF (SELECT count(*) FROM print_label_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_label_previews WHERE tenant_id=t)>2000 OR EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND octet_length(payload::text)+octet_length(request::text)>4194304) THEN RAISE EXCEPTION 'Limit historii etykiet drukowania' USING ERRCODE='23514'; END IF;
 SELECT coalesce((SELECT sum(octet_length(content_base64)+octet_length(order_snapshot::text)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM print_label_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM print_label_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+512) FROM print_job_label_sources WHERE tenant_id=t),0) INTO n;
 IF n>67108864 THEN RAISE EXCEPTION 'Limit historii drukowania' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION label_print_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Źródła i podglądy etykiet są niezmienne' USING ERRCODE='23514'; END $$;
CREATE FUNCTION label_print_budget_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN PERFORM label_print_budget(); RETURN NULL; END $$;
CREATE FUNCTION label_print_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p print_label_previews; a print_label_assets; j print_jobs; f jsonb; cfg jsonb; t uuid; jid uuid; BEGIN
 t:=NEW.tenant_id;
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Niepoprawny tenant etykiety' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='print_jobs' THEN
  IF NEW.source_kind<>'shipment_label' THEN RETURN NEW; END IF;
  j:=NEW;
  SELECT * INTO p FROM print_label_previews WHERE tenant_id=t AND id=(SELECT preview_id FROM print_job_label_sources WHERE tenant_id=t AND job_id=NEW.id);
 ELSE
  SELECT * INTO p FROM print_label_previews WHERE tenant_id=t AND id=NEW.preview_id;
  SELECT * INTO j FROM print_jobs WHERE tenant_id=t AND id=NEW.job_id;
  IF NEW.top_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() OR p.actor_id IS DISTINCT FROM NEW.actor_id OR p.api_key_id IS DISTINCT FROM NEW.api_key_id OR NEW.asset_id IS DISTINCT FROM p.asset_id OR NEW.shipment_id IS DISTINCT FROM p.shipment_id OR NEW.order_id IS DISTINCT FROM p.order_id OR NEW.request_hash IS DISTINCT FROM print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'preview_id',p.id,'request',NEW.request)) OR NEW.request->>'scope_hash' IS DISTINCT FROM p.scope_hash OR NEW.request->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Niepoprawna zgoda źródłowej etykiety' USING ERRCODE='23514'; END IF;
 END IF;
 IF p.id IS NULL OR j.id IS NULL THEN RAISE EXCEPTION 'Zadanie etykiety wymaga pełnego powiązania' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM print_label_assets WHERE tenant_id=t AND id=p.asset_id;
 IF j.source_kind<>'shipment_label' OR j.order_id IS DISTINCT FROM p.order_id OR j.station_id IS DISTINCT FROM p.station_id OR j.printer_id IS DISTINCT FROM p.printer_id OR j.order_snapshot IS DISTINCT FROM p.payload->'order_snapshot' OR j.station_snapshot IS DISTINCT FROM p.payload->'station_snapshot' OR j.printer_snapshot IS DISTINCT FROM p.payload->'printer_snapshot' OR j.content_sha256 IS DISTINCT FROM a.content_sha256 OR j.content_bytes IS DISTINCT FROM a.content_bytes OR j.copies IS DISTINCT FROM (p.payload->>'copies')::integer OR j.format<>'pdf' THEN RAISE EXCEPTION 'Zadanie nie odpowiada zatwierdzonej etykiecie' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='print_job_label_sources' THEN
  IF j.actor_id IS DISTINCT FROM NEW.actor_id OR j.api_key_id IS DISTINCT FROM NEW.api_key_id OR j.client_key IS DISTINCT FROM NEW.client_key OR j.request_hash IS DISTINCT FROM NEW.request_hash OR p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Niepoprawny principal źródłowej etykiety' USING ERRCODE='23514'; END IF;
  f:=label_print_frame(p.shipment_id,NEW.actor_id,NEW.api_key_id); cfg:=label_print_configuration(p.request,f->'order_snapshot');
  IF a.source_frame IS DISTINCT FROM f->'source_frame' OR cfg IS DISTINCT FROM p.payload-ARRAY['id','shipment_id','order_id','asset_id','source_kind','source_snapshot','format','content_sha256','content_bytes','created_at','expires_at'] OR print_job_hash(p.payload) IS DISTINCT FROM p.scope_hash THEN RAISE EXCEPTION 'Końcowe źródło etykiety zmieniło się' USING ERRCODE='23514'; END IF;
  PERFORM label_print_require(NEW.actor_id,NEW.api_key_id,true);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER label_print_job_guard BEFORE INSERT ON print_jobs FOR EACH ROW EXECUTE FUNCTION label_print_guard();
CREATE CONSTRAINT TRIGGER label_print_source_complete AFTER INSERT ON print_job_label_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION label_print_guard();
CREATE FUNCTION label_print_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ot uuid; nt uuid; oi uuid; ni uuid; osid uuid; nsid uuid; BEGIN
 IF TG_OP<>'INSERT' THEN ot:=OLD.tenant_id; oi:=OLD.id; END IF; IF TG_OP<>'DELETE' THEN nt:=NEW.tenant_id; ni:=NEW.id; END IF;
 IF TG_TABLE_NAME='shipping_plans' THEN IF TG_OP<>'INSERT' THEN osid:=OLD.shipment_id; END IF; IF TG_OP<>'DELETE' THEN nsid:=NEW.shipment_id; END IF; END IF;
 IF EXISTS(SELECT 1 FROM print_job_label_sources l JOIN print_label_previews p ON(p.tenant_id,p.id)=(l.tenant_id,l.preview_id) JOIN print_label_assets a ON(a.tenant_id,a.id)=(l.tenant_id,l.asset_id)
 WHERE l.top_xid=pg_current_xact_id() AND l.transaction_started_at=transaction_timestamp() AND ((l.tenant_id=ot AND (TG_TABLE_NAME='orders' AND l.order_id=oi OR TG_TABLE_NAME='shipments' AND l.shipment_id=oi OR TG_TABLE_NAME='shipping_plans' AND (a.shipping_plan_id=oi OR l.shipment_id=osid) OR TG_TABLE_NAME='packing_stations' AND p.station_id=oi OR TG_TABLE_NAME='print_printers' AND p.printer_id=oi)) OR (l.tenant_id=nt AND (TG_TABLE_NAME='orders' AND l.order_id=ni OR TG_TABLE_NAME='shipments' AND l.shipment_id=ni OR TG_TABLE_NAME='shipping_plans' AND (a.shipping_plan_id=ni OR l.shipment_id=nsid) OR TG_TABLE_NAME='packing_stations' AND p.station_id=ni OR TG_TABLE_NAME='print_printers' AND p.printer_id=ni)))) THEN RAISE EXCEPTION 'Zatwierdzone źródło etykiety jest zamknięte w tej transakcji' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DO $$ DECLARE rel text; BEGIN
 FOREACH rel IN ARRAY ARRAY['print_label_assets','print_label_previews','print_job_label_sources'] LOOP EXECUTE format('CREATE TRIGGER label_print_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION label_print_immutable()',rel); END LOOP;
 FOREACH rel IN ARRAY ARRAY['print_printers','print_jobs','print_job_events','print_label_assets','print_label_previews','print_job_label_sources'] LOOP EXECUTE format('CREATE TRIGGER label_print_budget AFTER INSERT OR UPDATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION label_print_budget_trigger()',rel); END LOOP;
 FOREACH rel IN ARRAY ARRAY['orders','shipments','packing_stations','print_printers'] LOOP EXECUTE format('CREATE TRIGGER label_print_seal BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION label_print_seal()',rel); END LOOP;
 CREATE TRIGGER label_print_seal BEFORE INSERT OR UPDATE OR DELETE ON shipping_plans FOR EACH ROW EXECUTE FUNCTION label_print_seal();
END $$;
CREATE FUNCTION label_print_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND (SELECT count(*) FROM pg_class WHERE oid=ANY(ARRAY(SELECT to_regclass(x) FROM unnest(ARRAY['print_label_assets','print_label_previews','print_job_label_sources']) x)) AND relrowsecurity AND relforcerowsecurity)=3
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['label_print_installed()','label_print_require(uuid,uuid,boolean)','label_print_frame(uuid,uuid,uuid)','label_print_configuration(jsonb,jsonb)','label_print_preview_replay(uuid,jsonb,uuid,uuid)','label_print_store_preview(jsonb,uuid,uuid)','label_print_asset(uuid,uuid,uuid)','label_print_queue_replay(uuid,jsonb,uuid,uuid)','label_print_queue(uuid,jsonb,text,uuid,uuid)','label_print_budget()','label_print_immutable()','label_print_budget_trigger()','label_print_guard()','label_print_seal()']) x WHERE to_regprocedure(x) IS NULL)
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['print_label_assets','print_label_previews','print_job_label_sources']) x WHERE has_table_privilege('dyna_app',to_regclass(x),'INSERT,UPDATE,DELETE'))
 AND NOT has_column_privilege('dyna_app',to_regclass('print_label_assets'),'content_encrypted','SELECT')
 AND NOT has_column_privilege('dyna_app',to_regclass('print_label_assets'),'source_frame','SELECT')
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('print_label_assets') AND contype='f' AND convalidated AND cardinality(conkey)=2)=3
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('print_label_previews') AND contype='f' AND convalidated AND cardinality(conkey)=2)=6
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('print_job_label_sources') AND contype='f' AND convalidated AND cardinality(conkey)=2)=6
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('print_job_label_sources') AND contype='f' AND convalidated AND condeferrable AND condeferred)=1
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='print_jobs'::regclass AND conname='print_jobs_source_kind_check' AND convalidated AND position('shipment_label' IN pg_get_constraintdef(oid))>0)
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='shipping_plans'::regclass AND conname='shipping_plans_tenant_id_unique' AND contype='u' AND convalidated)
 AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('print_label_preview_page') AND indisvalid)
 AND NOT EXISTS(SELECT 1 FROM (
  SELECT x rel,'label_print_immutable' n,'label_print_immutable()' fn,false d FROM unnest(ARRAY['print_label_assets','print_label_previews','print_job_label_sources']) x
  UNION ALL SELECT x,'label_print_budget','label_print_budget_trigger()',false FROM unnest(ARRAY['print_printers','print_jobs','print_job_events','print_label_assets','print_label_previews','print_job_label_sources']) x
  UNION ALL SELECT x,'label_print_seal','label_print_seal()',false FROM unnest(ARRAY['orders','shipments','shipping_plans','packing_stations','print_printers']) x
  UNION ALL SELECT 'print_jobs','label_print_job_guard','label_print_guard()',false
  UNION ALL SELECT 'print_job_label_sources','label_print_source_complete','label_print_guard()',true
 ) g WHERE NOT EXISTS(SELECT 1 FROM pg_trigger z WHERE z.tgrelid=to_regclass(g.rel) AND z.tgname::text=g.n AND z.tgfoid=to_regprocedure(g.fn) AND z.tgenabled='O' AND NOT z.tgisinternal AND z.tgdeferrable=g.d AND z.tginitdeferred=g.d))
$$;
REVOKE ALL ON FUNCTION label_print_installed(),label_print_frame(uuid,uuid,uuid),label_print_configuration(jsonb,jsonb),label_print_preview_replay(uuid,jsonb,uuid,uuid),label_print_store_preview(jsonb,uuid,uuid),label_print_asset(uuid,uuid,uuid),label_print_queue_replay(uuid,jsonb,uuid,uuid),label_print_queue(uuid,jsonb,text,uuid,uuid),label_print_budget(),label_print_immutable(),label_print_budget_trigger(),label_print_guard() FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION label_print_installed(),label_print_frame(uuid,uuid,uuid),label_print_preview_replay(uuid,jsonb,uuid,uuid),label_print_store_preview(jsonb,uuid,uuid),label_print_asset(uuid,uuid,uuid),label_print_queue_replay(uuid,jsonb,uuid,uuid),label_print_queue(uuid,jsonb,text,uuid,uuid) TO dyna_app;
REVOKE ALL ON FUNCTION label_print_seal(),label_print_guards() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION label_print_require(uuid,uuid,boolean) FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION label_print_guards() TO dyna_app;
