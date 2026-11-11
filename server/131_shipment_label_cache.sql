-- Immutable encrypted provider labels; explicit InPost GET and local DPD adoption only.
CREATE TABLE shipment_label_cache_acquisitions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),shipment_id uuid NOT NULL,order_id uuid NOT NULL,channel_id uuid NOT NULL,shipping_plan_id uuid,
 actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),source_frame jsonb NOT NULL,connection_hash text NOT NULL,
 state text NOT NULL CHECK(state IN('fetching','ready','failed','unknown','abandoned')),asset_id uuid,error_code text CHECK(error_code IN('LABEL_FETCH_FAILED','LABEL_INVALID','SOURCE_CHANGED','ACCESS_REVOKED','ABANDONED')),
 reconcile_key uuid,reconcile_hash text,completed_xid xid8,completed_transaction timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,id,shipment_id,order_id),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,shipping_plan_id) REFERENCES shipping_plans(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK((state='ready')=(asset_id IS NOT NULL)),CHECK((state IN('failed','unknown','abandoned'))=(error_code IS NOT NULL)),CHECK((reconcile_key IS NULL)=(reconcile_hash IS NULL))
);
CREATE TABLE shipment_label_cache_assets (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),shipment_id uuid NOT NULL,order_id uuid NOT NULL,channel_id uuid NOT NULL,shipping_plan_id uuid,
 acquisition_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN('inpost','dpd')),mode text NOT NULL CHECK(mode IN('sandbox','live')),tracking_number text NOT NULL,
 source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),source_frame jsonb NOT NULL,connection_hash text NOT NULL,
 content_encrypted text NOT NULL CHECK(length(content_encrypted) BETWEEN 40 AND 4000000),content_sha256 text NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'),content_bytes integer NOT NULL CHECK(content_bytes BETWEEN 1 AND 2097152),
 format text NOT NULL CHECK(format='pdf'),layout text NOT NULL CHECK(layout IN('A6','A4')),origin text NOT NULL CHECK(origin IN('provider_get','legacy_dpd_cache')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,shipment_id,order_id),UNIQUE(tenant_id,shipment_id,source_hash,connection_hash),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,shipping_plan_id) REFERENCES shipping_plans(tenant_id,id),FOREIGN KEY(tenant_id,acquisition_id,shipment_id,order_id) REFERENCES shipment_label_cache_acquisitions(tenant_id,id,shipment_id,order_id)
);
ALTER TABLE shipment_label_cache_acquisitions ADD CONSTRAINT label_cache_acquisition_asset FOREIGN KEY(tenant_id,asset_id,shipment_id,order_id) REFERENCES shipment_label_cache_assets(tenant_id,id,shipment_id,order_id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX label_cache_one_active ON shipment_label_cache_acquisitions(tenant_id,shipment_id) WHERE state IN('fetching','unknown');
CREATE INDEX label_cache_history ON shipment_label_cache_acquisitions(tenant_id,shipment_id,created_at DESC,id DESC);
ALTER TABLE print_label_assets DROP CONSTRAINT print_label_assets_source_kind_check;
ALTER TABLE print_label_assets ADD CONSTRAINT print_label_assets_source_kind_check CHECK(source_kind IN('dpd_cached','demo_generated','inpost_cached'));
ALTER TABLE print_label_assets ADD COLUMN cache_asset_id uuid;
ALTER TABLE print_label_assets ADD CONSTRAINT label_cache_print_asset FOREIGN KEY(tenant_id,cache_asset_id,shipment_id,order_id) REFERENCES shipment_label_cache_assets(tenant_id,id,shipment_id,order_id);
DO $$ DECLARE rel text; BEGIN
 FOREACH rel IN ARRAY ARRAY['shipment_label_cache_assets','shipment_label_cache_acquisitions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
  EXECUTE format('CREATE POLICY label_cache_tenant ON %I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',rel);
  EXECUTE format('CREATE POLICY label_cache_owner ON %I TO %I USING(true) WITH CHECK(true)',rel,current_user);
 END LOOP;
END $$;
REVOKE ALL ON shipment_label_cache_assets,shipment_label_cache_acquisitions FROM PUBLIC,dyna_app;
GRANT SELECT(id,tenant_id,shipment_id,order_id,provider,mode,tracking_number,shipping_plan_id,format,layout,content_sha256,content_bytes,source_hash,acquisition_id,origin,created_at) ON shipment_label_cache_assets TO dyna_app;
GRANT SELECT(id,tenant_id,shipment_id,state,asset_id,source_hash,error_code,created_at,updated_at) ON shipment_label_cache_acquisitions TO dyna_app;
CREATE FUNCTION label_cache_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM migrations WHERE name='131_shipment_label_cache') $$;
CREATE FUNCTION label_cache_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g jsonb;k api_keys;BEGIN
 g:=print_job_access(uid,kid,writing,pin);
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM api_keys WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=kid AND user_id=uid FOR SHARE;ELSE SELECT * INTO k FROM api_keys WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=kid AND user_id=uid;END IF;
  g:=g||jsonb_build_object('allowed',(g->>'allowed')::boolean AND (NOT writing OR 'documents:read'=ANY(k.scopes)),'can_write',g->>'role' IN('admin','operator') AND (g->>'key_valid')::boolean AND 'orders:read'=ANY(k.scopes) AND 'orders:write'=ANY(k.scopes) AND 'documents:read'=ANY(k.scopes));
 ELSE g:=g||jsonb_build_object('can_write',g->>'role' IN('admin','operator'));END IF;RETURN g;
END $$;
CREATE FUNCTION label_cache_require(uid uuid,kid uuid,writing boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g jsonb;BEGIN
 IF label_cache_guards() IS NOT TRUE OR label_cache_installed() IS NOT TRUE THEN RAISE EXCEPTION 'Moduł cache etykiet jest niekompletny' USING ERRCODE='55000';END IF;
 PERFORM label_print_require(uid,kid,writing);g:=label_cache_access(uid,kid,writing,false);
 IF (g->>'key_valid')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Klucz cache etykiet jest nieaktualny' USING ERRCODE='23514';END IF;
 IF (g->>'allowed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktualnego uprawnienia do cache etykiet' USING ERRCODE='23514';END IF;
END $$;
-- Private resolver: credentials and their fingerprint are never public metadata.
CREATE FUNCTION label_cache_frame(sid uuid,locking boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;s shipments;o orders;p shipping_plans;ch channels;src jsonb;n integer;BEGIN
 IF locking THEN PERFORM print_job_lock();END IF;SELECT * INTO s FROM shipments WHERE tenant_id=t AND id=sid;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono przesyłki' USING ERRCODE='P0002';END IF;
 IF locking THEN PERFORM 1 FROM orders WHERE tenant_id=t AND id=s.order_id FOR UPDATE;PERFORM 1 FROM shipments WHERE tenant_id=t AND id=sid FOR UPDATE;END IF;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=s.order_id;SELECT * INTO s FROM shipments WHERE tenant_id=t AND id=sid;
 IF s.mode='demo' OR s.status IN('cancelled','voided') OR s.channel_id IS NULL OR nullif(s.external_id,'') IS NULL THEN RAISE EXCEPTION 'Brak rzeczywistego źródła etykiety' USING ERRCODE='23514';END IF;
 IF s.carrier='DPD Polska' THEN
  SELECT count(*) INTO n FROM shipping_plans WHERE tenant_id=t AND shipment_id=sid AND input->>'provider'='dpd' AND state IN('ready','dispatched') AND result->>'tracking_number'=s.tracking_number;
  IF n<>1 THEN RAISE EXCEPTION 'Brak jednoznacznej zapisanej etykiety DPD' USING ERRCODE='23514';END IF;
  IF locking THEN PERFORM 1 FROM shipping_plans WHERE tenant_id=t AND shipment_id=sid AND input->>'provider'='dpd' AND state IN('ready','dispatched') AND result->>'tracking_number'=s.tracking_number FOR UPDATE;END IF;
  SELECT * INTO p FROM shipping_plans WHERE tenant_id=t AND shipment_id=sid AND input->>'provider'='dpd' AND state IN('ready','dispatched') AND result->>'tracking_number'=s.tracking_number;
  IF p.order_id IS DISTINCT FROM o.id OR p.channel_id IS DISTINCT FROM s.channel_id OR p.remote_id IS DISTINCT FROM s.external_id OR p.result->>'waybill' IS DISTINCT FROM s.tracking_number OR p.result->>'label_base64' IS NULL THEN RAISE EXCEPTION 'Brak zapisanych lokalnie bajtów DPD' USING ERRCODE='23514';END IF;
 END IF;
 IF locking THEN PERFORM 1 FROM channels WHERE tenant_id=t AND id=s.channel_id FOR UPDATE;END IF;SELECT * INTO ch FROM channels WHERE tenant_id=t AND id=s.channel_id;
 IF ch.id IS NULL OR ch.provider NOT IN('inpost','dpd') OR ch.mode IS DISTINCT FROM s.mode OR coalesce((ch.settings->>'simulation')::boolean,false) OR (ch.provider='dpd') IS DISTINCT FROM (s.carrier='DPD Polska') THEN RAISE EXCEPTION 'Połączenie nie jest rzeczywistym źródłem etykiety' USING ERRCODE='23514';END IF;
 src:=jsonb_build_object('shipment',jsonb_build_object('id',s.id,'order_id',s.order_id,'carrier',s.carrier,'tracking_number',s.tracking_number,'mode',s.mode,'status',s.status,'channel_id',s.channel_id,'external_id',s.external_id,'dispatched_at',s.dispatched_at),'plan',CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'order_id',p.order_id,'channel_id',p.channel_id,'shipment_id',p.shipment_id,'state',p.state,'phase',p.phase,'remote_id',p.remote_id,'updated_at',p.updated_at,'content_sha256',encode(sha256(decode(p.result->>'label_base64','base64')),'hex')) END,'provider',ch.provider,'format','pdf','layout',CASE WHEN ch.provider='inpost' THEN 'A6' ELSE 'A4' END);
 RETURN jsonb_build_object('source_frame',src,'source_hash',print_job_hash(src),'connection_hash',print_job_hash(jsonb_build_object('id',ch.id,'provider',ch.provider,'mode',ch.mode,'settings',ch.settings,'credentials',ch.credentials)),'credentials',ch.credentials,'provider',ch.provider,'mode',ch.mode,'external_id',s.external_id,'content_base64',p.result->>'label_base64','order_version',o.version::text);
END $$;
CREATE FUNCTION label_cache_head(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT v-ARRAY['tenant_id','channel_id','source_frame','connection_hash','content_encrypted'] $$;
CREATE FUNCTION label_cache_acquisition_head(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT jsonb_build_object('id',v->'id','shipment_id',v->'shipment_id','state',v->'state','asset_id',v->'asset_id','source_hash',v->'source_hash','error_code',v->'error_code','created_at',v->'created_at','updated_at',v->'updated_at') $$;
CREATE FUNCTION label_cache_metadata(sid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb;a shipment_label_cache_assets;r shipment_label_cache_acquisitions;why text;BEGIN
 PERFORM label_cache_require(uid,kid,false);
 BEGIN f:=label_cache_frame(sid,false);EXCEPTION WHEN check_violation THEN why:='Brak rzeczywistego dostępnego źródła etykiety';END;
 IF f IS NOT NULL THEN SELECT * INTO a FROM shipment_label_cache_assets WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND shipment_id=sid AND source_hash=f->>'source_hash' AND connection_hash=f->>'connection_hash';END IF;
 SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND shipment_id=sid ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object('cache',CASE WHEN a.id IS NULL THEN NULL ELSE label_cache_head(to_jsonb(a)) END,'latest_acquisition',CASE WHEN r.id IS NULL THEN NULL ELSE label_cache_acquisition_head(to_jsonb(r))||jsonb_build_object('principal_matches',r.actor_id=uid AND r.api_key_id IS NOT DISTINCT FROM kid) END,'source_hash',f->'source_hash','order_version',f->'order_version','unavailable_reason',why,'active',r.state IN('fetching','unknown'));
END $$;
CREATE FUNCTION label_cache_begin(sid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f jsonb;r shipment_label_cache_acquisitions;a shipment_label_cache_assets;rh text;BEGIN
 PERFORM label_cache_require(uid,kid,true);PERFORM print_job_lock();
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (v-ARRAY['client_key','order_version','source_hash','confirmed_existing_label'])<>'{}'::jsonb OR v->'confirmed_existing_label' IS DISTINCT FROM 'true'::jsonb OR coalesce((v->>'order_version')~'^[1-9][0-9]*$',false) IS NOT TRUE OR coalesce((v->>'source_hash')~'^[a-f0-9]{64}$',false) IS NOT TRUE THEN RAISE EXCEPTION 'Niepoprawna zgoda pobrania istniejącej etykiety' USING ERRCODE='23514';END IF;
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'shipment_id',sid,'request',v));
 SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF r.id IS NOT NULL THEN
  IF r.shipment_id IS DISTINCT FROM sid OR r.actor_id IS DISTINCT FROM uid OR r.api_key_id IS DISTINCT FROM kid OR r.request_hash IS DISTINCT FROM rh THEN RAISE EXCEPTION 'Klucz cache etykiety ma inną treść' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('id',r.id,'reused',true,'network',false);
 END IF;
 f:=label_cache_frame(sid);
 IF f->>'source_hash' IS DISTINCT FROM v->>'source_hash' OR f->>'order_version' IS DISTINCT FROM v->>'order_version' THEN RAISE EXCEPTION 'Źródło etykiety zmieniło się' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM shipment_label_cache_acquisitions WHERE tenant_id=t AND shipment_id=sid AND state IN('fetching','unknown')) THEN RAISE EXCEPTION 'Pobranie etykiety wymaga jawnego rozstrzygnięcia' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM shipment_label_cache_assets WHERE tenant_id=t AND shipment_id=sid AND source_hash=f->>'source_hash' AND connection_hash=f->>'connection_hash';
 r.id:=gen_random_uuid();r.tenant_id:=t;r.shipment_id:=sid;r.order_id:=(f->'source_frame'->'shipment'->>'order_id')::uuid;r.channel_id:=(f->'source_frame'->'shipment'->>'channel_id')::uuid;r.shipping_plan_id:=(f->'source_frame'->'plan'->>'id')::uuid;r.actor_id:=uid;r.api_key_id:=kid;r.client_key:=(v->>'client_key')::uuid;r.request_hash:=rh;r.request:=v;r.source_hash:=f->>'source_hash';r.source_frame:=f->'source_frame';r.connection_hash:=f->>'connection_hash';r.state:=CASE WHEN a.id IS NULL THEN 'fetching' ELSE 'ready' END;r.asset_id:=a.id;r.created_at:=clock_timestamp();r.updated_at:=r.created_at;
 IF r.state='ready' THEN r.completed_xid:=pg_current_xact_id();r.completed_transaction:=transaction_timestamp();END IF;
 INSERT INTO shipment_label_cache_acquisitions SELECT r.*;PERFORM label_cache_budget();PERFORM label_cache_require(uid,kid,true);
 RETURN jsonb_build_object('id',r.id,'reused',false,'network',a.id IS NULL AND f->>'provider'='inpost');
END $$;
-- Returns the frozen transport only to the exact original principal while current access remains valid.
CREATE FUNCTION label_cache_transport(rid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r shipment_label_cache_acquisitions;f jsonb;BEGIN
 PERFORM label_cache_require(uid,kid,true);SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=rid;
 IF r.id IS NULL OR r.actor_id IS DISTINCT FROM uid OR r.api_key_id IS DISTINCT FROM kid OR r.state<>'fetching' THEN RAISE EXCEPTION 'Brak własnej aktywnej próby etykiety' USING ERRCODE='23514';END IF;
 f:=label_cache_frame(r.shipment_id);IF f->'source_frame' IS DISTINCT FROM r.source_frame OR f->>'connection_hash' IS DISTINCT FROM r.connection_hash OR f->>'order_version' IS DISTINCT FROM r.request->>'order_version' THEN RAISE EXCEPTION 'Źródło etykiety zmieniło się' USING ERRCODE='23514';END IF;
 PERFORM label_cache_require(uid,kid,true);RETURN f-ARRAY['connection_hash','source_frame','source_hash'];
END $$;
CREATE FUNCTION label_cache_finish(rid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r shipment_label_cache_acquisitions;a shipment_label_cache_assets;f jsonb;BEGIN
 PERFORM label_cache_require(uid,kid,true);PERFORM print_job_lock();SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=t AND id=rid;
 IF r.id IS NULL OR r.state<>'fetching' OR r.actor_id IS DISTINCT FROM uid OR r.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Brak własnej aktywnej próby etykiety' USING ERRCODE='23514';END IF;
 f:=label_cache_frame(r.shipment_id);SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=t AND id=rid FOR UPDATE;
 IF r.state<>'fetching' OR f->'source_frame' IS DISTINCT FROM r.source_frame OR f->>'connection_hash' IS DISTINCT FROM r.connection_hash OR f->>'order_version' IS DISTINCT FROM r.request->>'order_version' THEN RAISE EXCEPTION 'Źródło etykiety zmieniło się' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (v-ARRAY['content_base64','content_encrypted'])<>'{}'::jsonb OR print_job_content_valid(v->>'content_base64','pdf') IS NOT TRUE OR coalesce(length(v->>'content_encrypted') BETWEEN 40 AND 4000000,false) IS NOT TRUE OR (f->>'provider'='dpd' AND v->>'content_base64' IS DISTINCT FROM f->>'content_base64') THEN RAISE EXCEPTION 'Nieprawidłowy plik cache etykiety' USING ERRCODE='23514';END IF;
 a.id:=gen_random_uuid();a.tenant_id:=t;a.shipment_id:=r.shipment_id;a.order_id:=r.order_id;a.channel_id:=r.channel_id;a.shipping_plan_id:=r.shipping_plan_id;a.acquisition_id:=r.id;a.provider:=f->>'provider';a.mode:=f->>'mode';a.tracking_number:=r.source_frame->'shipment'->>'tracking_number';a.source_hash:=r.source_hash;a.source_frame:=r.source_frame;a.connection_hash:=r.connection_hash;a.content_encrypted:=v->>'content_encrypted';a.content_sha256:=encode(sha256(decode(v->>'content_base64','base64')),'hex');a.content_bytes:=octet_length(decode(v->>'content_base64','base64'));a.format:='pdf';a.layout:=CASE WHEN a.provider='inpost' THEN 'A6' ELSE 'A4' END;a.origin:=CASE WHEN a.provider='inpost' THEN 'provider_get' ELSE 'legacy_dpd_cache' END;a.created_at:=clock_timestamp();
 INSERT INTO shipment_label_cache_assets SELECT a.*;UPDATE shipment_label_cache_acquisitions SET state='ready',asset_id=a.id,completed_xid=pg_current_xact_id(),completed_transaction=transaction_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=t AND id=rid;
 PERFORM label_cache_budget();PERFORM label_cache_require(uid,kid,true);RETURN jsonb_build_object('id',rid);
END $$;
-- Failure cleanup cannot publish bytes; original principal binding remains required after revocation.
CREATE FUNCTION label_cache_fail(rid uuid,uid uuid,kid uuid,why text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r shipment_label_cache_acquisitions;BEGIN
 PERFORM print_job_lock();SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=rid FOR UPDATE;
 IF r.id IS NULL OR r.actor_id IS DISTINCT FROM uid OR r.api_key_id IS DISTINCT FROM kid OR why NOT IN('LABEL_FETCH_FAILED','LABEL_INVALID','SOURCE_CHANGED','ACCESS_REVOKED') THEN RAISE EXCEPTION 'Niepoprawne zamknięcie próby etykiety' USING ERRCODE='23514';END IF;
 IF r.state='fetching' THEN UPDATE shipment_label_cache_acquisitions SET state=CASE WHEN why='LABEL_FETCH_FAILED' THEN 'unknown' ELSE 'failed' END,error_code=why,updated_at=clock_timestamp() WHERE tenant_id=r.tenant_id AND id=r.id;END IF;
END $$;
CREATE FUNCTION label_cache_read(rid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r shipment_label_cache_acquisitions;a shipment_label_cache_assets;BEGIN
 PERFORM label_cache_require(uid,kid,false);SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=rid;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono próby etykiety' USING ERRCODE='P0002';END IF;
 SELECT * INTO a FROM shipment_label_cache_assets WHERE tenant_id=r.tenant_id AND id=r.asset_id;
 RETURN jsonb_build_object('acquisition',label_cache_acquisition_head(to_jsonb(r))||jsonb_build_object('principal_matches',r.actor_id=uid AND r.api_key_id IS NOT DISTINCT FROM kid),'cache',CASE WHEN a.id IS NULL THEN NULL ELSE label_cache_head(to_jsonb(a)) END);
END $$;
CREATE FUNCTION label_cache_content(aid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a shipment_label_cache_assets;BEGIN
 PERFORM label_cache_require(uid,kid,true);SELECT * INTO a FROM shipment_label_cache_assets WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=aid;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono cache etykiety' USING ERRCODE='P0002';END IF;
 RETURN jsonb_build_object('content_encrypted',a.content_encrypted,'content_sha256',a.content_sha256,'content_bytes',a.content_bytes,'format',a.format);
END $$;
CREATE FUNCTION label_cache_reconcile(rid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r shipment_label_cache_acquisitions;rh text;BEGIN
 PERFORM label_cache_require(uid,kid,true);PERFORM print_job_lock();SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=rid FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono próby etykiety' USING ERRCODE='P0002';END IF;
 IF (v-ARRAY['client_key','confirmed_abandon'])<>'{}'::jsonb OR v->'confirmed_abandon' IS DISTINCT FROM 'true'::jsonb OR r.actor_id IS DISTINCT FROM uid OR r.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Niepoprawna zgoda zamknięcia próby etykiety' USING ERRCODE='23514';END IF;
 rh:=print_job_hash(jsonb_build_object('id',rid,'actor_id',uid,'api_key_id',kid,'request',v));
 IF r.reconcile_key IS NOT NULL THEN IF r.reconcile_key IS DISTINCT FROM (v->>'client_key')::uuid OR r.reconcile_hash IS DISTINCT FROM rh THEN RAISE EXCEPTION 'Klucz zamknięcia próby ma inną treść' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('id',rid,'reused',true);END IF;
 IF r.state NOT IN('fetching','unknown') THEN RAISE EXCEPTION 'Próba etykiety nie wymaga zamknięcia' USING ERRCODE='23514';END IF;
 UPDATE shipment_label_cache_acquisitions SET state='abandoned',error_code='ABANDONED',reconcile_key=(v->>'client_key')::uuid,reconcile_hash=rh,updated_at=clock_timestamp() WHERE tenant_id=r.tenant_id AND id=rid;
 RETURN jsonb_build_object('id',rid,'reused',false);
END $$;
CREATE FUNCTION label_cache_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Cache etykiety jest niezmienny' USING ERRCODE='23514';END $$;
CREATE FUNCTION label_cache_acquisition_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Próba etykiety jest trwała' USING ERRCODE='23514';END IF;
 IF (to_jsonb(NEW)-ARRAY['state','asset_id','error_code','reconcile_key','reconcile_hash','updated_at','completed_xid','completed_transaction']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','asset_id','error_code','reconcile_key','reconcile_hash','updated_at','completed_xid','completed_transaction']) OR OLD.state NOT IN('fetching','unknown') OR (OLD.state='unknown' AND NEW.state<>'abandoned') OR (OLD.state='fetching' AND NEW.state NOT IN('ready','failed','unknown','abandoned')) OR (NEW.state='ready' AND (NEW.completed_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.completed_transaction IS DISTINCT FROM transaction_timestamp())) THEN RAISE EXCEPTION 'Niepoprawna zmiana próby etykiety' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER label_cache_immutable BEFORE UPDATE OR DELETE ON shipment_label_cache_assets FOR EACH ROW EXECUTE FUNCTION label_cache_immutable();
CREATE TRIGGER label_cache_acquisition_guard BEFORE UPDATE OR DELETE ON shipment_label_cache_acquisitions FOR EACH ROW EXECUTE FUNCTION label_cache_acquisition_guard();
CREATE FUNCTION label_cache_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a shipment_label_cache_assets;r shipment_label_cache_acquisitions;f jsonb;BEGIN
 IF TG_TABLE_NAME='shipment_label_cache_assets' THEN SELECT * INTO a FROM shipment_label_cache_assets WHERE tenant_id=NEW.tenant_id AND id=NEW.id;SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=a.tenant_id AND id=a.acquisition_id;
 ELSE SELECT * INTO r FROM shipment_label_cache_acquisitions WHERE tenant_id=NEW.tenant_id AND id=NEW.id;SELECT * INTO a FROM shipment_label_cache_assets WHERE tenant_id=r.tenant_id AND id=r.asset_id;END IF;
 IF r.id IS NULL OR (r.state='ready' AND (a.id IS NULL OR a.shipment_id IS DISTINCT FROM r.shipment_id OR a.order_id IS DISTINCT FROM r.order_id OR a.source_frame IS DISTINCT FROM r.source_frame OR a.connection_hash IS DISTINCT FROM r.connection_hash)) THEN RAISE EXCEPTION 'Niepełny graf cache etykiety' USING ERRCODE='23514';END IF;
 IF r.state='ready' AND r.completed_xid=pg_current_xact_id() AND r.completed_transaction=transaction_timestamp() THEN
  f:=label_cache_frame(r.shipment_id);
  IF f->'source_frame' IS DISTINCT FROM r.source_frame OR f->>'connection_hash' IS DISTINCT FROM r.connection_hash OR f->>'order_version' IS DISTINCT FROM r.request->>'order_version' THEN RAISE EXCEPTION 'Końcowe źródło cache etykiety zmieniło się' USING ERRCODE='23514';END IF;
  PERFORM label_cache_require(r.actor_id,r.api_key_id,true);
 END IF;
 PERFORM label_cache_budget();
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER label_cache_complete AFTER INSERT ON shipment_label_cache_assets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION label_cache_complete();
CREATE CONSTRAINT TRIGGER label_cache_complete AFTER INSERT OR UPDATE ON shipment_label_cache_acquisitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION label_cache_complete();
CREATE FUNCTION label_cache_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN PERFORM label_print_budget();END $$;
CREATE FUNCTION label_cache_budget_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN PERFORM print_job_lock();PERFORM label_cache_budget();RETURN NULL;END $$;
CREATE TRIGGER label_cache_budget AFTER INSERT OR UPDATE ON shipment_label_cache_assets FOR EACH STATEMENT EXECUTE FUNCTION label_cache_budget_trigger();
CREATE TRIGGER label_cache_budget AFTER INSERT OR UPDATE ON shipment_label_cache_acquisitions FOR EACH STATEMENT EXECUTE FUNCTION label_cache_budget_trigger();

CREATE FUNCTION label_cache_selected_frame(sid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a shipment_label_cache_assets;f jsonb;o orders;src jsonb;BEGIN
 IF v->>'asset_id' IS NULL THEN RETURN label_print_frame(sid,uid,kid);END IF;
 PERFORM label_cache_require(uid,kid,true);f:=label_cache_frame(sid);
 SELECT * INTO a FROM shipment_label_cache_assets WHERE tenant_id=t AND id=(v->>'asset_id')::uuid;
 IF a.id IS NULL OR a.shipment_id IS DISTINCT FROM sid OR a.source_frame IS DISTINCT FROM f->'source_frame' OR a.connection_hash IS DISTINCT FROM f->>'connection_hash' THEN RAISE EXCEPTION 'Wybrany cache etykiety jest nieaktualny' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM orders WHERE tenant_id=t AND id=a.order_id;
 src:=a.source_frame||jsonb_build_object('source_kind',CASE WHEN a.provider='inpost' THEN 'inpost_cached' ELSE 'dpd_cached' END,'cache_asset_id',a.id,'renderer_input',NULL);
 RETURN jsonb_build_object('source_frame',src,'source_hash',print_job_hash(src),'cache_source_hash',a.source_hash,'source_kind',CASE WHEN a.provider='inpost' THEN 'inpost_cached' ELSE 'dpd_cached' END,'shipping_plan_id',a.shipping_plan_id,'order_snapshot',jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'warehouse_id',o.warehouse_id),'renderer_input',NULL,'content_base64',f->'content_base64','cache_sha256',a.content_sha256,'cache_bytes',a.content_bytes);
END $$;
CREATE FUNCTION label_cache_print_asset_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a shipment_label_cache_assets;BEGIN
 IF NEW.cache_asset_id IS NULL THEN IF NEW.source_kind='inpost_cached' THEN RAISE EXCEPTION 'Etykieta InPost wymaga cache' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO a FROM shipment_label_cache_assets WHERE tenant_id=NEW.tenant_id AND id=NEW.cache_asset_id;
 IF a.id IS NULL OR a.shipment_id IS DISTINCT FROM NEW.shipment_id OR a.order_id IS DISTINCT FROM NEW.order_id OR a.content_sha256 IS DISTINCT FROM NEW.content_sha256 OR a.content_bytes IS DISTINCT FROM NEW.content_bytes OR NEW.source_kind IS DISTINCT FROM (CASE WHEN a.provider='inpost' THEN 'inpost_cached' ELSE 'dpd_cached' END) OR NEW.source_frame IS DISTINCT FROM (a.source_frame||jsonb_build_object('source_kind',NEW.source_kind,'cache_asset_id',a.id,'renderer_input',NULL)) THEN RAISE EXCEPTION 'Kopia drukowania nie odpowiada cache etykiety' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER label_cache_print_asset_guard BEFORE INSERT ON print_label_assets FOR EACH ROW EXECUTE FUNCTION label_cache_print_asset_guard();
CREATE FUNCTION label_cache_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ot uuid;nt uuid;oi uuid;ni uuid;os uuid;ns uuid;BEGIN
 IF TG_OP<>'INSERT' THEN ot:=OLD.tenant_id;oi:=OLD.id;IF TG_TABLE_NAME='shipping_plans' THEN os:=OLD.shipment_id;END IF;END IF;
 IF TG_OP<>'DELETE' THEN nt:=NEW.tenant_id;ni:=NEW.id;IF TG_TABLE_NAME='shipping_plans' THEN ns:=NEW.shipment_id;END IF;END IF;
 IF EXISTS(SELECT 1 FROM shipment_label_cache_acquisitions r WHERE r.completed_xid=pg_current_xact_id() AND r.completed_transaction=transaction_timestamp() AND ((r.tenant_id=ot AND (TG_TABLE_NAME='orders' AND r.order_id=oi OR TG_TABLE_NAME='shipments' AND r.shipment_id=oi OR TG_TABLE_NAME='channels' AND r.channel_id=oi OR TG_TABLE_NAME='shipping_plans' AND (r.shipping_plan_id=oi OR r.shipment_id=os))) OR(r.tenant_id=nt AND (TG_TABLE_NAME='orders' AND r.order_id=ni OR TG_TABLE_NAME='shipments' AND r.shipment_id=ni OR TG_TABLE_NAME='channels' AND r.channel_id=ni OR TG_TABLE_NAME='shipping_plans' AND (r.shipping_plan_id=ni OR r.shipment_id=ns))))) OR (TG_TABLE_NAME='channels' AND EXISTS(SELECT 1 FROM print_job_label_sources l JOIN print_label_assets a ON(a.tenant_id,a.id)=(l.tenant_id,l.asset_id) JOIN shipment_label_cache_assets ca ON(ca.tenant_id,ca.id)=(a.tenant_id,a.cache_asset_id) WHERE l.top_xid=pg_current_xact_id() AND l.transaction_started_at=transaction_timestamp() AND ((l.tenant_id=ot AND ca.channel_id=oi) OR(l.tenant_id=nt AND ca.channel_id=ni)))) THEN RAISE EXCEPTION 'Zapisane źródło cache jest zamknięte w tej transakcji' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
DO $$ DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['orders','shipments','channels'] LOOP EXECUTE format('CREATE TRIGGER label_cache_seal BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION label_cache_seal()',rel);END LOOP;
 CREATE TRIGGER label_cache_seal BEFORE INSERT OR UPDATE OR DELETE ON shipping_plans FOR EACH ROW EXECUTE FUNCTION label_cache_seal();
END $$;
-- Existing 130 function OIDs/ACLs remain; legacy requests use the unchanged legacy frame.
CREATE OR REPLACE FUNCTION label_print_configuration(v jsonb,orderh jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; st packing_stations; p print_printers;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (v-ARRAY['client_key','order_version','station_id','station_version','printer_id','printer_version','copies','asset_id'])<>'{}'::jsonb OR jsonb_typeof(v->'copies') IS DISTINCT FROM 'number' OR (v->>'copies') !~ '^[0-9]+$' OR (v->>'copies')::integer NOT BETWEEN 1 AND 10 OR orderh->>'version' IS DISTINCT FROM v->>'order_version' THEN RAISE EXCEPTION 'Niepoprawny podgląd konfiguracji etykiety' USING ERRCODE='23514'; END IF;
 SELECT * INTO st FROM packing_stations WHERE tenant_id=t AND id=(v->>'station_id')::uuid FOR UPDATE;
 SELECT * INTO p FROM print_printers WHERE tenant_id=t AND id=(v->>'printer_id')::uuid FOR UPDATE;
 IF st.id IS NULL OR p.id IS NULL OR NOT st.enabled OR NOT p.enabled OR p.format<>'pdf' OR p.station_id IS DISTINCT FROM st.id OR st.version::text IS DISTINCT FROM v->>'station_version' OR p.version::text IS DISTINCT FROM v->>'printer_version' THEN RAISE EXCEPTION 'Konfiguracja drukowania etykiety zmieniła się' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('order_snapshot',orderh,'station_snapshot',jsonb_build_object('id',st.id,'code',st.code,'label',st.label,'version',st.version::text,'enabled',st.enabled),'printer_snapshot',print_job_printer_head(to_jsonb(p)),'copies',(v->>'copies')::integer);
END $$;
CREATE OR REPLACE FUNCTION label_print_store_preview(v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; f jsonb; config jsonb; old jsonb; a print_label_assets; ph jsonb; rh text; ts timestamptz:=clock_timestamp(); pid uuid;
BEGIN
 PERFORM print_job_lock(); old:=label_print_preview_replay((v->>'shipment_id')::uuid,v->'request',uid,kid); IF old IS NOT NULL THEN RETURN old; END IF;
 f:=label_cache_selected_frame((v->>'shipment_id')::uuid,v->'request',uid,kid); config:=label_print_configuration(v->'request',f->'order_snapshot');
 IF v->'source_frame' IS DISTINCT FROM f->'source_frame' OR print_job_content_valid(v->>'content_base64','pdf') IS NOT TRUE OR (f->>'source_kind'='dpd_cached' AND v->>'content_base64' IS DISTINCT FROM f->>'content_base64') OR (f->>'cache_sha256' IS NOT NULL AND (encode(sha256(decode(v->>'content_base64','base64')),'hex') IS DISTINCT FROM f->>'cache_sha256' OR octet_length(decode(v->>'content_base64','base64')) IS DISTINCT FROM (f->>'cache_bytes')::integer)) OR jsonb_typeof(v->'content_encrypted') IS DISTINCT FROM 'string' OR length(v->>'content_encrypted') NOT BETWEEN 40 AND 4000000 THEN RAISE EXCEPTION 'Źródło etykiety zmieniło się podczas podglądu' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM print_label_assets WHERE tenant_id=t AND shipment_id=(v->>'shipment_id')::uuid AND source_hash=f->>'source_hash' AND content_sha256=encode(sha256(decode(v->>'content_base64','base64')),'hex');
 IF a.id IS NULL THEN
  a.id:=gen_random_uuid(); a.tenant_id:=t; a.shipment_id:=(v->>'shipment_id')::uuid; a.order_id:=(f->'order_snapshot'->>'id')::uuid; a.shipping_plan_id:=(f->>'shipping_plan_id')::uuid; a.source_kind:=f->>'source_kind'; a.cache_asset_id:=(v->'request'->>'asset_id')::uuid; a.source_hash:=f->>'source_hash'; a.source_frame:=f->'source_frame'; a.content_encrypted:=v->>'content_encrypted'; a.content_sha256:=encode(sha256(decode(v->>'content_base64','base64')),'hex'); a.content_bytes:=octet_length(decode(v->>'content_base64','base64')); a.format:='pdf'; a.created_at:=ts;
  INSERT INTO print_label_assets SELECT a.*;
 END IF;
 pid:=gen_random_uuid();
 ph:=config||jsonb_build_object('id',pid,'shipment_id',a.shipment_id,'order_id',a.order_id,'asset_id',a.id,'source_kind',a.source_kind,'source_snapshot',jsonb_build_object('carrier',f->'source_frame'->'shipment'->'carrier','mode',f->'source_frame'->'shipment'->'mode','tracking_number',f->'source_frame'->'shipment'->'tracking_number','shipping_plan_id',a.shipping_plan_id,'source_hash',coalesce(f->>'cache_source_hash',a.source_hash))||CASE WHEN a.cache_asset_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cache_asset_id',a.cache_asset_id) END,'format','pdf','content_sha256',a.content_sha256,'content_bytes',a.content_bytes,'created_at',ts,'expires_at',ts+interval '15 minutes');
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'shipment_id',a.shipment_id,'request',v->'request'));
 INSERT INTO print_label_previews(id,tenant_id,asset_id,shipment_id,order_id,station_id,printer_id,actor_id,api_key_id,client_key,request_hash,request,scope_hash,payload,expires_at,created_at)
 VALUES(pid,t,a.id,a.shipment_id,a.order_id,(v->'request'->>'station_id')::uuid,(v->'request'->>'printer_id')::uuid,uid,kid,(v->'request'->>'client_key')::uuid,rh,v->'request',print_job_hash(ph),ph,ts+interval '15 minutes',ts);
 PERFORM label_print_budget(); PERFORM label_print_require(uid,kid,true); RETURN jsonb_build_object('preview_id',pid,'reused',false);
END $$;
CREATE OR REPLACE FUNCTION label_print_queue(pid uuid,v jsonb,b64 text,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
 f:=label_cache_selected_frame(p.shipment_id,p.request,uid,kid); config:=label_print_configuration(p.request,f->'order_snapshot');
 SELECT * INTO a FROM print_label_assets WHERE tenant_id=t AND id=p.asset_id;
 IF a.source_frame IS DISTINCT FROM f->'source_frame' OR config IS DISTINCT FROM p.payload-ARRAY['id','shipment_id','order_id','asset_id','source_kind','source_snapshot','format','content_sha256','content_bytes','created_at','expires_at'] OR print_job_hash(p.payload) IS DISTINCT FROM p.scope_hash OR print_job_content_valid(b64,'pdf') IS NOT TRUE OR encode(sha256(decode(b64,'base64')),'hex') IS DISTINCT FROM a.content_sha256 OR octet_length(decode(b64,'base64')) IS DISTINCT FROM a.content_bytes OR (a.source_kind='dpd_cached' AND b64 IS DISTINCT FROM f->>'content_base64') THEN RAISE EXCEPTION 'Etykieta lub zakres podglądu zmieniły się' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM print_job_events WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid) THEN RAISE EXCEPTION 'Klucz polecenia drukowania ma inną treść' USING ERRCODE='23514'; END IF;
 j.id:=gen_random_uuid(); j.tenant_id:=t; j.order_id:=p.order_id; j.station_id:=p.station_id; j.printer_id:=p.printer_id; j.actor_id:=uid; j.api_key_id:=kid; j.client_key:=(v->>'client_key')::uuid; j.request_hash:=rh; j.order_snapshot:=p.payload->'order_snapshot'; j.station_snapshot:=p.payload->'station_snapshot'; j.printer_snapshot:=p.payload->'printer_snapshot'; j.source_kind:='shipment_label'; j.format:='pdf'; j.copies:=(p.payload->>'copies')::integer; j.content_base64:=b64; j.content_sha256:=a.content_sha256; j.content_bytes:=a.content_bytes; j.version:=1; j.state:='queued'; j.created_at:=ts; j.updated_at:=ts;
 INSERT INTO print_job_label_sources(tenant_id,job_id,preview_id,asset_id,shipment_id,order_id,actor_id,api_key_id,client_key,request_hash,request,created_at) VALUES(t,j.id,pid,a.id,p.shipment_id,p.order_id,uid,kid,j.client_key,rh,v,ts);
 outv:=print_job_event(gen_random_uuid(),j.id,NULL,uid,kid,j.client_key,rh,'job_create',NULL,print_job_head(to_jsonb(j)),jsonb_build_object('preview_id',pid,'shipment_id',p.shipment_id,'asset_id',a.id,'source_kind',a.source_kind));
 INSERT INTO print_jobs SELECT j.*; PERFORM label_print_budget(); IF p.request->>'asset_id' IS NOT NULL THEN PERFORM label_cache_require(uid,kid,true); END IF; PERFORM label_print_require(uid,kid,true); RETURN outv||jsonb_build_object('preview_id',pid);
END $$;
CREATE OR REPLACE FUNCTION label_print_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
  f:=label_cache_selected_frame(p.shipment_id,p.request,NEW.actor_id,NEW.api_key_id); cfg:=label_print_configuration(p.request,f->'order_snapshot');
  IF a.source_frame IS DISTINCT FROM f->'source_frame' OR cfg IS DISTINCT FROM p.payload-ARRAY['id','shipment_id','order_id','asset_id','source_kind','source_snapshot','format','content_sha256','content_bytes','created_at','expires_at'] OR print_job_hash(p.payload) IS DISTINCT FROM p.scope_hash THEN RAISE EXCEPTION 'Końcowe źródło etykiety zmieniło się' USING ERRCODE='23514'; END IF;
  IF p.request->>'asset_id' IS NOT NULL THEN PERFORM label_cache_require(NEW.actor_id,NEW.api_key_id,true); END IF; PERFORM label_print_require(NEW.actor_id,NEW.api_key_id,true);
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION label_print_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; n bigint; BEGIN
 PERFORM print_job_budget();
 IF (SELECT count(*) FROM shipment_label_cache_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_cache_acquisitions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit cache etykiet' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM print_label_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_label_previews WHERE tenant_id=t)>2000 OR EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND octet_length(payload::text)+octet_length(request::text)>4194304) THEN RAISE EXCEPTION 'Limit historii etykiet drukowania' USING ERRCODE='23514'; END IF;
 SELECT coalesce((SELECT sum(octet_length(content_base64)+octet_length(order_snapshot::text)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM print_label_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM print_label_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+512) FROM print_job_label_sources WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM shipment_label_cache_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(source_frame::text)+1024) FROM shipment_label_cache_acquisitions WHERE tenant_id=t),0) INTO n;
 IF n>67108864 THEN RAISE EXCEPTION 'Limit historii drukowania' USING ERRCODE='23514'; END IF;
END $$;
CREATE OR REPLACE FUNCTION label_print_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
CREATE OR REPLACE FUNCTION label_print_asset(pid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p print_label_previews; a print_label_assets; BEGIN
 PERFORM label_print_require(uid,kid,true);
 SELECT * INTO p FROM print_label_previews WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=pid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu etykiety' USING ERRCODE='P0002'; END IF;
 SELECT * INTO a FROM print_label_assets WHERE tenant_id=p.tenant_id AND id=p.asset_id;
 IF a.cache_asset_id IS NOT NULL THEN PERFORM label_cache_require(uid,kid,true); END IF;
 RETURN jsonb_build_object('content_encrypted',a.content_encrypted,'content_sha256',a.content_sha256,'content_bytes',a.content_bytes,'format',a.format);
END $$;
CREATE OR REPLACE FUNCTION label_print_queue_replay(pid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; l print_job_label_sources; rh text; outv jsonb; BEGIN
 PERFORM label_print_require(uid,kid,true);
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'preview_id',pid,'request',v));
 SELECT * INTO l FROM print_job_label_sources WHERE tenant_id=t AND client_key=(v->>'client_key')::uuid;
 IF l.job_id IS NULL THEN RETURN NULL; END IF;
 IF l.preview_id IS DISTINCT FROM pid OR l.actor_id IS DISTINCT FROM uid OR l.api_key_id IS DISTINCT FROM kid OR l.request_hash IS DISTINCT FROM rh THEN RAISE EXCEPTION 'Klucz kolejki etykiety ma inną treść' USING ERRCODE='23514'; END IF;
 outv:=print_job_replay(l.client_key,rh,uid,kid,'job_create',l.job_id); IF outv IS NULL THEN RAISE EXCEPTION 'Brak potwierdzenia kolejki etykiety' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND id=pid AND request->>'asset_id' IS NOT NULL) THEN PERFORM label_cache_require(uid,kid,true); END IF;
 RETURN outv||jsonb_build_object('preview_id',pid);
END $$;
CREATE FUNCTION label_cache_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin' AND label_print_guards()
 AND (SELECT count(*) FROM pg_class WHERE oid=ANY(ARRAY(SELECT to_regclass(x) FROM unnest(ARRAY['shipment_label_cache_assets','shipment_label_cache_acquisitions']) x)) AND relrowsecurity AND relforcerowsecurity)=2
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['label_cache_installed()','label_cache_access(uuid,uuid,boolean,boolean)','label_cache_require(uuid,uuid,boolean)','label_cache_frame(uuid,boolean)','label_cache_head(jsonb)','label_cache_acquisition_head(jsonb)','label_cache_metadata(uuid,uuid,uuid)','label_cache_begin(uuid,jsonb,uuid,uuid)','label_cache_transport(uuid,uuid,uuid)','label_cache_finish(uuid,jsonb,uuid,uuid)','label_cache_fail(uuid,uuid,uuid,text)','label_cache_read(uuid,uuid,uuid)','label_cache_content(uuid,uuid,uuid)','label_cache_reconcile(uuid,jsonb,uuid,uuid)','label_cache_immutable()','label_cache_acquisition_guard()','label_cache_complete()','label_cache_budget()','label_cache_budget_trigger()','label_cache_selected_frame(uuid,jsonb,uuid,uuid)','label_cache_print_asset_guard()','label_cache_seal()']) x WHERE to_regprocedure(x) IS NULL)
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['shipment_label_cache_assets','shipment_label_cache_acquisitions']) x WHERE has_table_privilege('dyna_app',to_regclass(x),'INSERT,UPDATE,DELETE'))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['content_encrypted','source_frame','connection_hash']) x WHERE has_column_privilege('dyna_app','shipment_label_cache_assets',x,'SELECT'))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['request','request_hash','source_frame','connection_hash','actor_id','api_key_id','reconcile_hash']) x WHERE has_column_privilege('dyna_app','shipment_label_cache_acquisitions',x,'SELECT'))
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid='shipment_label_cache_assets'::regclass AND contype='f' AND convalidated AND cardinality(conkey)=2)=4
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid='shipment_label_cache_assets'::regclass AND contype='f' AND convalidated AND cardinality(conkey)=4)=1
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid='shipment_label_cache_acquisitions'::regclass AND contype='f' AND convalidated AND cardinality(conkey)=2)=5
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid='shipment_label_cache_acquisitions'::regclass AND contype='f' AND convalidated AND cardinality(conkey)=4 AND condeferrable AND condeferred)=1
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='print_label_assets'::regclass AND conname='label_cache_print_asset' AND convalidated AND cardinality(conkey)=4)
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='print_label_assets'::regclass AND conname='print_label_assets_source_kind_check' AND convalidated AND position('inpost_cached' IN pg_get_constraintdef(oid))>0)
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['label_cache_one_active','label_cache_history']) x WHERE NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass(x) AND indisvalid))
 AND NOT EXISTS(SELECT 1 FROM (
 SELECT 'shipment_label_cache_assets' rel,'label_cache_immutable' n,'label_cache_immutable()' fn,false d
 UNION ALL SELECT 'shipment_label_cache_acquisitions','label_cache_acquisition_guard','label_cache_acquisition_guard()',false
 UNION ALL SELECT x,'label_cache_complete','label_cache_complete()',true FROM unnest(ARRAY['shipment_label_cache_assets','shipment_label_cache_acquisitions']) x
 UNION ALL SELECT x,'label_cache_budget','label_cache_budget_trigger()',false FROM unnest(ARRAY['shipment_label_cache_assets','shipment_label_cache_acquisitions']) x
 UNION ALL SELECT 'print_label_assets','label_cache_print_asset_guard','label_cache_print_asset_guard()',false
 UNION ALL SELECT x,'label_cache_seal','label_cache_seal()',false FROM unnest(ARRAY['orders','shipments','channels','shipping_plans']) x
 ) g WHERE NOT EXISTS(SELECT 1 FROM pg_trigger z WHERE z.tgrelid=to_regclass(g.rel) AND z.tgname::text=g.n AND z.tgfoid=to_regprocedure(g.fn) AND z.tgenabled='O' AND NOT z.tgisinternal AND z.tgdeferrable=g.d AND z.tginitdeferred=g.d))
$$;
-- Deny all helpers by default, then expose only principal-bound typed operations.
DO $$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'label_cache_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.sig);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION label_cache_installed(),label_cache_guards(),label_cache_access(uuid,uuid,boolean,boolean),label_cache_metadata(uuid,uuid,uuid),label_cache_begin(uuid,jsonb,uuid,uuid),label_cache_transport(uuid,uuid,uuid),label_cache_finish(uuid,jsonb,uuid,uuid),label_cache_fail(uuid,uuid,uuid,text),label_cache_read(uuid,uuid,uuid),label_cache_content(uuid,uuid,uuid),label_cache_reconcile(uuid,jsonb,uuid,uuid),label_cache_selected_frame(uuid,jsonb,uuid,uuid) TO dyna_app;
