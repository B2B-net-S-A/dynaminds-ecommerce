-- Configuration foundation only. No numbering, historical backfill or physical
-- issuer. One system-managed WZ series per warehouse, born at first consent.
CREATE TABLE warehouse_automatic_wz_previews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants, warehouse_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users, api_key_id uuid, client_key uuid NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'), request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'), nonce uuid NOT NULL,
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'), created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at=created_at+interval '900 seconds'),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,warehouse_id), UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id), FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE warehouse_automatic_wz_operations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants, warehouse_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users, api_key_id uuid, preview_id uuid NOT NULL, client_key uuid NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'), request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'), snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 revision_id uuid NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,warehouse_id), UNIQUE(tenant_id,actor_id,client_key), UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id), FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,preview_id,warehouse_id) REFERENCES warehouse_automatic_wz_previews(tenant_id,id,warehouse_id)
);
CREATE TABLE warehouse_automatic_wz_revisions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants, warehouse_id uuid NOT NULL, operation_id uuid NOT NULL,
 series_id uuid NOT NULL, version bigint NOT NULL CHECK(version>0), settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'), created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,warehouse_id), UNIQUE(tenant_id,id,warehouse_id,version), UNIQUE(tenant_id,warehouse_id,version), UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id,warehouse_id) REFERENCES warehouse_automatic_wz_operations(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE warehouse_automatic_wz_operations ADD FOREIGN KEY(tenant_id,revision_id,warehouse_id)
 REFERENCES warehouse_automatic_wz_revisions(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE warehouse_automatic_wz_configurations (
 tenant_id uuid NOT NULL REFERENCES tenants, warehouse_id uuid NOT NULL, series_id uuid NOT NULL,
 version bigint NOT NULL CHECK(version>0), settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'), revision_id uuid NOT NULL, operation_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,warehouse_id), UNIQUE(tenant_id,series_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,revision_id,warehouse_id,version) REFERENCES warehouse_automatic_wz_revisions(tenant_id,id,warehouse_id,version) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,operation_id,warehouse_id) REFERENCES warehouse_automatic_wz_operations(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE warehouse_automatic_wz_admissions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants, warehouse_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users, api_key_id uuid,
 preview_id uuid NOT NULL, operation_id uuid NOT NULL, revision_id uuid NOT NULL, request jsonb NOT NULL,
 txid xid8 NOT NULL DEFAULT pg_current_xact_id(), sealed boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,operation_id), UNIQUE(tenant_id,warehouse_id,txid),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id), FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,preview_id,warehouse_id) REFERENCES warehouse_automatic_wz_previews(tenant_id,id,warehouse_id),
 FOREIGN KEY(tenant_id,operation_id,warehouse_id) REFERENCES warehouse_automatic_wz_operations(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,revision_id,warehouse_id) REFERENCES warehouse_automatic_wz_revisions(tenant_id,id,warehouse_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE warehouse_automatic_wz_manifest (singleton boolean PRIMARY KEY CHECK(singleton), fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'));
CREATE INDEX warehouse_automatic_wz_preview_history ON warehouse_automatic_wz_previews(tenant_id,warehouse_id,id DESC);
CREATE INDEX warehouse_automatic_wz_operation_history ON warehouse_automatic_wz_operations(tenant_id,warehouse_id,id DESC);
CREATE INDEX warehouse_automatic_wz_preview_actor ON warehouse_automatic_wz_previews(actor_id);
CREATE INDEX warehouse_automatic_wz_operation_actor ON warehouse_automatic_wz_operations(actor_id);
CREATE INDEX warehouse_automatic_wz_admission_actor ON warehouse_automatic_wz_admissions(actor_id);
CREATE INDEX warehouse_automatic_wz_preview_key ON warehouse_automatic_wz_previews(tenant_id,api_key_id);
CREATE INDEX warehouse_automatic_wz_operation_key ON warehouse_automatic_wz_operations(tenant_id,api_key_id);
CREATE INDEX warehouse_automatic_wz_admission_key ON warehouse_automatic_wz_admissions(tenant_id,api_key_id);
CREATE INDEX warehouse_automatic_wz_operation_revision ON warehouse_automatic_wz_operations(tenant_id,revision_id,warehouse_id);
CREATE INDEX warehouse_automatic_wz_config_revision ON warehouse_automatic_wz_configurations(tenant_id,revision_id,warehouse_id,version);
CREATE INDEX warehouse_automatic_wz_config_operation ON warehouse_automatic_wz_configurations(tenant_id,operation_id,warehouse_id);
CREATE INDEX warehouse_automatic_wz_admission_preview ON warehouse_automatic_wz_admissions(tenant_id,preview_id,warehouse_id);
CREATE INDEX warehouse_automatic_wz_admission_revision ON warehouse_automatic_wz_admissions(tenant_id,revision_id,warehouse_id);
CREATE INDEX warehouse_automatic_wz_operation_page ON warehouse_automatic_wz_operations(tenant_id,id DESC);
CREATE INDEX warehouse_automatic_wz_preview_page ON warehouse_automatic_wz_previews(tenant_id,id DESC);
DO $$DECLARE rel text;BEGIN
 FOR rel IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'warehouse_automatic_wz_%' LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',rel);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',rel);
  IF rel<>'warehouse_automatic_wz_manifest' THEN
   EXECUTE format('CREATE POLICY tenant_scope ON public.%I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
  END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',rel);
 END LOOP;
END $$;

CREATE FUNCTION warehouse_automatic_wz_preview(uid uuid,kid uuid,wh uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.warehouse_automatic_wz_previews;h text;sid uuid;stamp timestamptz:=clock_timestamp();sn jsonb;nonce uuid:=gen_random_uuid();
BEGIN
 PERFORM public.warehouse_automatic_wz_require();PERFORM public.warehouse_automatic_wz_access(uid,kid,true,false);
 IF NOT coalesce(public.warehouse_automatic_wz_request_valid(b,false),false) THEN RAISE EXCEPTION 'Niepoprawna konfiguracja WZ' USING ERRCODE='23514';END IF;
 h:=public.warehouse_automatic_wz_hash(jsonb_build_object('actor',uid,'key',kid,'warehouse',wh,'request',b));
 SELECT * INTO p FROM public.warehouse_automatic_wz_previews WHERE tenant_id=t AND actor_id=uid AND client_key=(b->>'client_key')::uuid;
 IF p.id IS NOT NULL THEN
  IF p.request_hash IS DISTINCT FROM h OR p.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Klucz próby WZ został użyty w innym zakresie' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('preview',to_jsonb(p),'reused',true);
 END IF;
 PERFORM public.warehouse_automatic_wz_lock(t,wh);
 -- Repeat after the genuinely serializing lock: concurrent exact requests
 -- return the stored command before fresh version/expiry eligibility.
 SELECT * INTO p FROM public.warehouse_automatic_wz_previews WHERE tenant_id=t AND actor_id=uid AND client_key=(b->>'client_key')::uuid;
 IF p.id IS NOT NULL THEN
  IF p.request_hash IS DISTINCT FROM h OR p.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Klucz próby WZ został użyty w innym zakresie' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('preview',to_jsonb(p),'reused',true);
 END IF;
 sid:=coalesce((public.warehouse_automatic_wz_current(t,wh)->>'series_id')::uuid,gen_random_uuid());sn:=public.warehouse_automatic_wz_frame(t,wh,b,sid);
 INSERT INTO public.warehouse_automatic_wz_previews(id,tenant_id,warehouse_id,actor_id,api_key_id,client_key,request,request_hash,snapshot,nonce,scope_hash,created_at,expires_at)
 VALUES(gen_random_uuid(),t,wh,uid,kid,(b->>'client_key')::uuid,b,h,sn,nonce,public.warehouse_automatic_wz_hash(jsonb_build_object('snapshot',sn,'nonce',nonce)),stamp,stamp+interval '900 seconds') RETURNING * INTO p;
 PERFORM public.warehouse_automatic_wz_budget(t);RETURN jsonb_build_object('preview',to_jsonb(p),'reused',false);
END $$;
CREATE FUNCTION warehouse_automatic_wz_commit(uid uuid,kid uuid,pid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.warehouse_automatic_wz_previews;o public.warehouse_automatic_wz_operations;h text;eid uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();stamp timestamptz:=clock_timestamp();
BEGIN
 PERFORM public.warehouse_automatic_wz_require();PERFORM public.warehouse_automatic_wz_access(uid,kid,true,false);
 IF NOT coalesce(public.warehouse_automatic_wz_request_valid(b,true),false) THEN RAISE EXCEPTION 'Niepoprawna zgoda WZ' USING ERRCODE='23514';END IF;
 h:=public.warehouse_automatic_wz_hash(jsonb_build_object('actor',uid,'key',kid,'preview',pid,'request',b));
 SELECT * INTO o FROM public.warehouse_automatic_wz_operations WHERE tenant_id=t AND actor_id=uid AND client_key=(b->>'client_key')::uuid;
 IF o.id IS NOT NULL THEN
  IF o.request_hash IS DISTINCT FROM h OR o.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Klucz zgody WZ został użyty w innym zakresie' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('operation',to_jsonb(o),'reused',true);
 END IF;
 SELECT * INTO p FROM public.warehouse_automatic_wz_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego podglądu WZ' USING ERRCODE='P0002';END IF;
 PERFORM public.warehouse_automatic_wz_lock(t,p.warehouse_id);
 SELECT * INTO o FROM public.warehouse_automatic_wz_operations WHERE tenant_id=t AND actor_id=uid AND client_key=(b->>'client_key')::uuid;
 IF o.id IS NOT NULL THEN
  IF o.request_hash IS DISTINCT FROM h OR o.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Klucz zgody WZ został użyty w innym zakresie' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('operation',to_jsonb(o),'reused',true);
 END IF;
 IF p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.scope_hash IS DISTINCT FROM b->>'scope_hash'
 OR p.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM public.warehouse_automatic_wz_operations WHERE tenant_id=t AND preview_id=pid)
 OR p.snapshot IS DISTINCT FROM public.warehouse_automatic_wz_frame(t,p.warehouse_id,p.request,(p.snapshot->'after'->>'series_id')::uuid)
 THEN RAISE EXCEPTION 'Podgląd konfiguracji WZ zmienił się lub wygasł' USING ERRCODE='23514';END IF;
 INSERT INTO public.warehouse_automatic_wz_admissions(id,tenant_id,warehouse_id,actor_id,api_key_id,preview_id,operation_id,revision_id,request)
 VALUES(gen_random_uuid(),t,p.warehouse_id,uid,kid,pid,eid,rid,b);
 INSERT INTO public.warehouse_automatic_wz_operations(id,tenant_id,warehouse_id,actor_id,api_key_id,preview_id,client_key,request,request_hash,scope_hash,snapshot,revision_id,created_at)
 VALUES(eid,t,p.warehouse_id,uid,kid,pid,(b->>'client_key')::uuid,b,h,p.scope_hash,p.snapshot,rid,stamp) RETURNING * INTO o;
 INSERT INTO public.warehouse_automatic_wz_revisions(id,tenant_id,warehouse_id,operation_id,series_id,version,settings,created_at)
 VALUES(rid,t,p.warehouse_id,eid,(p.snapshot->'after'->>'series_id')::uuid,(p.snapshot->'after'->>'version')::bigint,p.request->'settings',stamp);
 INSERT INTO public.warehouse_automatic_wz_configurations(tenant_id,warehouse_id,series_id,version,settings,revision_id,operation_id)
 VALUES(t,p.warehouse_id,(p.snapshot->'after'->>'series_id')::uuid,(p.snapshot->'after'->>'version')::bigint,p.request->'settings',rid,eid)
 ON CONFLICT(tenant_id,warehouse_id) DO UPDATE SET version=excluded.version,settings=excluded.settings,revision_id=excluded.revision_id,operation_id=excluded.operation_id;
 PERFORM public.warehouse_automatic_wz_budget(t);RETURN jsonb_build_object('operation',to_jsonb(o),'reused',false);
END $$;

CREATE FUNCTION warehouse_automatic_wz_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE j jsonb:=to_jsonb(NEW);a public.warehouse_automatic_wz_admissions;p public.warehouse_automatic_wz_previews;t uuid;wh uuid;before jsonb;
BEGIN
 IF TG_TABLE_NAME='warehouse_automatic_wz_manifest' THEN RAISE EXCEPTION 'Manifest WZ jest niezmienny' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND TG_TABLE_NAME NOT IN('warehouse_automatic_wz_configurations','warehouse_automatic_wz_admissions')) THEN RAISE EXCEPTION 'Dowód WZ jest niezmienny' USING ERRCODE='23514';END IF;
 t:=(j->>'tenant_id')::uuid;wh:=(j->>'warehouse_id')::uuid;
 IF t IS NULL OR t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obcy kontekst WZ' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='warehouse_automatic_wz_previews' THEN
  PERFORM public.warehouse_automatic_wz_access(NEW.actor_id,NEW.api_key_id,true,false);
  IF NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NOT coalesce(public.warehouse_automatic_wz_request_valid(NEW.request,false),false)
  OR NEW.request_hash IS DISTINCT FROM public.warehouse_automatic_wz_hash(jsonb_build_object('actor',NEW.actor_id,'key',NEW.api_key_id,'warehouse',wh,'request',NEW.request))
  OR NEW.snapshot IS DISTINCT FROM public.warehouse_automatic_wz_frame(t,wh,NEW.request,(NEW.snapshot->'after'->>'series_id')::uuid)
  OR NEW.scope_hash IS DISTINCT FROM public.warehouse_automatic_wz_hash(jsonb_build_object('snapshot',NEW.snapshot,'nonce',NEW.nonce))
  OR NEW.created_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Niepoprawny podgląd WZ' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='warehouse_automatic_wz_admissions' AND TG_OP='UPDATE' THEN
  IF OLD.txid IS DISTINCT FROM pg_current_xact_id() OR OLD.sealed OR NOT NEW.sealed OR (to_jsonb(OLD)-'sealed') IS DISTINCT FROM(j-'sealed')
  OR current_setting('warehouse_automatic_wz.sealing',true) IS DISTINCT FROM OLD.id::text THEN RAISE EXCEPTION 'Zgoda WZ jest zapieczętowana' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='warehouse_automatic_wz_admissions' THEN
  SELECT * INTO p FROM public.warehouse_automatic_wz_previews WHERE(tenant_id,id,warehouse_id)=(t,NEW.preview_id,wh);
  PERFORM public.warehouse_automatic_wz_access(NEW.actor_id,NEW.api_key_id,true,false);
  IF NEW.txid IS DISTINCT FROM pg_current_xact_id() OR NEW.sealed OR p.id IS NULL OR p.actor_id IS DISTINCT FROM NEW.actor_id OR p.api_key_id IS DISTINCT FROM NEW.api_key_id
  OR NOT coalesce(public.warehouse_automatic_wz_request_valid(NEW.request,true),false) OR NEW.request->>'scope_hash' IS DISTINCT FROM p.scope_hash OR p.expires_at<=clock_timestamp()
  OR p.snapshot IS DISTINCT FROM public.warehouse_automatic_wz_frame(t,wh,p.request,(p.snapshot->'after'->>'series_id')::uuid)
  THEN RAISE EXCEPTION 'Brak pełnej zgody konfiguracji WZ' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 SELECT * INTO a FROM public.warehouse_automatic_wz_admissions WHERE tenant_id=t AND warehouse_id=wh AND txid=pg_current_xact_id();
 IF a.id IS NULL OR a.sealed THEN RAISE EXCEPTION 'Brak aktualnej zgody WZ lub zakres zapieczętowany' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.warehouse_automatic_wz_previews WHERE(tenant_id,id)=(t,a.preview_id);
 IF TG_TABLE_NAME='warehouse_automatic_wz_operations' THEN
  IF NEW.id IS DISTINCT FROM a.operation_id OR NEW.preview_id IS DISTINCT FROM a.preview_id OR NEW.revision_id IS DISTINCT FROM a.revision_id
  OR NEW.actor_id IS DISTINCT FROM a.actor_id OR NEW.api_key_id IS DISTINCT FROM a.api_key_id OR NEW.request IS DISTINCT FROM a.request
  OR NEW.client_key IS DISTINCT FROM(a.request->>'client_key')::uuid OR NEW.scope_hash IS DISTINCT FROM p.scope_hash OR NEW.snapshot IS DISTINCT FROM p.snapshot
  OR NEW.request_hash IS DISTINCT FROM public.warehouse_automatic_wz_hash(jsonb_build_object('actor',a.actor_id,'key',a.api_key_id,'preview',p.id,'request',a.request))
  THEN RAISE EXCEPTION 'Receipt WZ nie odpowiada zgodzie' USING ERRCODE='23514';END IF;
 ELSE
  IF(j->>'operation_id')::uuid IS DISTINCT FROM a.operation_id OR j->>'series_id' IS DISTINCT FROM p.snapshot->'after'->>'series_id'
  OR j->>'version' IS DISTINCT FROM p.snapshot->'after'->>'version' OR j->'settings' IS DISTINCT FROM p.request->'settings'
  OR (CASE WHEN TG_TABLE_NAME='warehouse_automatic_wz_revisions' THEN(j->>'id')::uuid ELSE(j->>'revision_id')::uuid END) IS DISTINCT FROM a.revision_id
  THEN RAISE EXCEPTION 'Seria WZ nie odpowiada zgodzie' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='warehouse_automatic_wz_configurations' THEN
   before:=CASE WHEN TG_OP='UPDATE' THEN jsonb_build_object('warehouse_id',OLD.warehouse_id,'version',OLD.version::text,'series_id',OLD.series_id,'settings',OLD.settings) ELSE public.warehouse_automatic_wz_current(t,wh) END;
   IF before IS DISTINCT FROM p.snapshot->'before' OR(TG_OP='UPDATE' AND(NEW.tenant_id,NEW.warehouse_id,NEW.series_id) IS DISTINCT FROM(OLD.tenant_id,OLD.warehouse_id,OLD.series_id)) THEN RAISE EXCEPTION 'Niepoprawna wersja bazowa serii WZ' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION warehouse_automatic_wz_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.warehouse_automatic_wz_admissions;o public.warehouse_automatic_wz_operations;r public.warehouse_automatic_wz_revisions;c public.warehouse_automatic_wz_configurations;p public.warehouse_automatic_wz_previews;prior text:=current_setting('warehouse_automatic_wz.sealing',true);
BEGIN
 SELECT * INTO a FROM public.warehouse_automatic_wz_admissions WHERE id=NEW.id AND txid=pg_current_xact_id();
 IF a.id IS NULL THEN RAISE EXCEPTION 'Brak bieżącej zgody WZ' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM public.warehouse_automatic_wz_operations WHERE(tenant_id,id)=(a.tenant_id,a.operation_id);
 SELECT * INTO r FROM public.warehouse_automatic_wz_revisions WHERE(tenant_id,id)=(a.tenant_id,a.revision_id);
 SELECT * INTO c FROM public.warehouse_automatic_wz_configurations WHERE(tenant_id,warehouse_id)=(a.tenant_id,a.warehouse_id);
 SELECT * INTO p FROM public.warehouse_automatic_wz_previews WHERE(tenant_id,id)=(a.tenant_id,a.preview_id);
 IF o.id IS NULL OR r.id IS NULL OR c.operation_id IS DISTINCT FROM o.id OR c.revision_id IS DISTINCT FROM r.id OR r.operation_id IS DISTINCT FROM o.id
 OR(c.series_id,c.version,c.settings) IS DISTINCT FROM(r.series_id,r.version,r.settings) OR r.created_at IS DISTINCT FROM o.created_at OR o.snapshot IS DISTINCT FROM p.snapshot
 OR public.warehouse_automatic_wz_current(a.tenant_id,a.warehouse_id) IS DISTINCT FROM p.snapshot->'after'
 OR (SELECT jsonb_build_object('id',id,'name',name,'code',code) FROM public.warehouses WHERE(tenant_id,id)=(a.tenant_id,a.warehouse_id)) IS DISTINCT FROM p.snapshot->'warehouse'
 THEN RAISE EXCEPTION 'Niepełny wynik konfiguracji WZ' USING ERRCODE='23514';END IF;
 PERFORM public.warehouse_automatic_wz_access(a.actor_id,a.api_key_id,true,false);PERFORM public.warehouse_automatic_wz_budget(a.tenant_id);
 IF NOT a.sealed THEN
  PERFORM set_config('warehouse_automatic_wz.sealing',a.id::text,true);
  UPDATE public.warehouse_automatic_wz_admissions SET sealed=true WHERE id=a.id;
  PERFORM set_config('warehouse_automatic_wz.sealing',coalesce(prior,''),true);
 END IF;RETURN NULL;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('warehouse_automatic_wz.sealing',coalesce(prior,''),true);RAISE;
END $$;

CREATE FUNCTION warehouse_automatic_wz_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT encode(sha256(convert_to(j::text,'UTF8')),'hex')$$;
CREATE FUNCTION warehouse_automatic_wz_installed() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT true$$;
CREATE FUNCTION warehouse_automatic_wz_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k public.api_keys;manage boolean;
BEGIN
 IF t IS NULL OR uid IS NULL THEN RAISE EXCEPTION 'Brak własnego kontekstu WZ' USING ERRCODE='42501';END IF;
 IF pin THEN SELECT role INTO r FROM public.memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;
 ELSE SELECT role INTO r FROM public.memberships WHERE tenant_id=t AND user_id=uid;END IF;
 IF r IS NULL OR r NOT IN('admin','operator','viewer') THEN RAISE EXCEPTION 'Brak aktualnego dostępu WZ' USING ERRCODE='42501';END IF;
 manage:=r='admin';
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM public.api_keys WHERE tenant_id=t AND id=kid FOR SHARE;ELSE SELECT * INTO k FROM public.api_keys WHERE tenant_id=t AND id=kid;END IF;
  IF k.id IS NULL OR k.user_id IS DISTINCT FROM uid OR k.revoked_at IS NOT NULL OR(k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Klucz API został cofnięty lub wygasł' USING ERRCODE='28000';END IF;
  IF NOT('inventory:read'=ANY(k.scopes)) THEN RAISE EXCEPTION 'Brak zakresu odczytu WZ' USING ERRCODE='42501';END IF;
  manage:=manage AND 'inventory:write'=ANY(k.scopes);
 END IF;
 IF writing AND NOT manage THEN RAISE EXCEPTION 'Konfiguracja WZ wymaga administratora' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('current_role',r,'can_manage',manage);
END $$;
CREATE FUNCTION warehouse_automatic_wz_request_valid(b jsonb,consent boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(b->'client_key') IS DISTINCT FROM 'string' OR NOT(b->>'client_key'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RETURN false;END IF;
 IF consent THEN RETURN b-ARRAY['client_key','scope_hash','confirmed']='{}'::jsonb AND jsonb_typeof(b->'scope_hash')='string' AND b->>'scope_hash'~'^[a-f0-9]{64}$' AND b->'confirmed'='true'::jsonb;END IF;
 RETURN b-ARRAY['client_key','expected_version','settings']='{}'::jsonb
 AND jsonb_typeof(b->'expected_version')='string' AND b->>'expected_version'~'^(0|[1-9][0-9]{0,18})$' AND(b->>'expected_version')::numeric<9223372036854775807
 AND jsonb_typeof(b->'settings')='object' AND(b->'settings')-ARRAY['enabled','moment','series_name','prefix']='{}'::jsonb
 AND jsonb_typeof(b->'settings'->'enabled')='boolean' AND b->'settings'->>'moment'='physical_dispatch'
 AND jsonb_typeof(b->'settings'->'series_name')='string' AND jsonb_typeof(b->'settings'->'prefix')='string'
 AND length(b->'settings'->>'series_name') BETWEEN 2 AND 80 AND b->'settings'->>'series_name'=btrim(b->'settings'->>'series_name')
 AND b->'settings'->>'series_name'!~'[[:cntrl:]]' AND b->'settings'->>'prefix'~'^[A-Z0-9][A-Z0-9_-]{1,23}$';
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION warehouse_automatic_wz_current(t uuid,wh uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.warehouse_automatic_wz_configurations;
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR t IS NULL THEN RAISE EXCEPTION 'Obca firma WZ' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.warehouses WHERE(tenant_id,id)=(t,wh)) THEN RAISE EXCEPTION 'Nie znaleziono własnego magazynu' USING ERRCODE='P0002';END IF;
 SELECT * INTO c FROM public.warehouse_automatic_wz_configurations WHERE(tenant_id,warehouse_id)=(t,wh);
 RETURN jsonb_build_object('warehouse_id',wh,'version',coalesce(c.version,0)::text,'series_id',c.series_id,'settings',c.settings);
END $$;
CREATE FUNCTION warehouse_automatic_wz_lock(t uuid,wh uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR t IS NULL THEN RAISE EXCEPTION 'Obca firma WZ' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||t::text,0));
 PERFORM id FROM public.warehouses WHERE(tenant_id,id)=(t,wh) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Nie znaleziono własnego magazynu' USING ERRCODE='P0002';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('automatic-wz:'||t::text,0));
 PERFORM warehouse_id FROM public.warehouse_automatic_wz_configurations WHERE(tenant_id,warehouse_id)=(t,wh) FOR UPDATE;
END $$;
CREATE FUNCTION warehouse_automatic_wz_frame(t uuid,wh uuid,b jsonb,sid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE prior jsonb;w jsonb;
BEGIN
 IF NOT coalesce(public.warehouse_automatic_wz_request_valid(b,false),false) THEN RAISE EXCEPTION 'Niepoprawna konfiguracja WZ' USING ERRCODE='23514';END IF;
 prior:=public.warehouse_automatic_wz_current(t,wh);
 IF prior->>'version' IS DISTINCT FROM b->>'expected_version' THEN RAISE EXCEPTION 'Wersja konfiguracji WZ zmieniła się' USING ERRCODE='23514';END IF;
 IF prior->>'series_id' IS NOT NULL AND prior->>'series_id' IS DISTINCT FROM sid::text THEN RAISE EXCEPTION 'Tożsamość serii WZ jest stała' USING ERRCODE='23514';END IF;
 SELECT jsonb_build_object('id',id,'name',name,'code',code) INTO w FROM public.warehouses WHERE(tenant_id,id)=(t,wh);
 RETURN jsonb_build_object('warehouse',w,'before',prior,'after',jsonb_build_object('warehouse_id',wh,'series_id',sid,'version',((b->>'expected_version')::bigint+1)::text,'settings',b->'settings'));
END $$;
CREATE FUNCTION warehouse_automatic_wz_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n bigint;
BEGIN
 IF(SELECT count(*) FROM public.warehouse_automatic_wz_configurations WHERE tenant_id=t)>200 OR(SELECT count(*) FROM public.warehouse_automatic_wz_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM public.warehouse_automatic_wz_operations WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit konfiguracji WZ' USING ERRCODE='54000';END IF;
 SELECT coalesce(sum(pg_column_size(j)),0) INTO n FROM(SELECT to_jsonb(x) j FROM public.warehouse_automatic_wz_previews x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM public.warehouse_automatic_wz_operations x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM public.warehouse_automatic_wz_revisions x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM public.warehouse_automatic_wz_admissions x WHERE tenant_id=t UNION ALL SELECT to_jsonb(x) FROM public.warehouse_automatic_wz_configurations x WHERE tenant_id=t) s;
 IF n>67108864 THEN RAISE EXCEPTION 'Limit pamięci historii WZ' USING ERRCODE='54000';END IF;
END $$;

-- Portable complete metadata manifest: names/signatures and effective ACL,
-- never installation OIDs. Unrelated public objects are outside this manifest.
CREATE FUNCTION warehouse_automatic_wz_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.warehouse_automatic_wz_hash(jsonb_build_object(
 'tables',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
  'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(coalesce(pg_get_userbyid(a.grantee),'PUBLIC'),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),
  'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',attname,'type',format_type(atttypid,atttypmod),'notnull',attnotnull,'generated',attgenerated,'identity',attidentity,'acl',attacl::text,'default',pg_get_expr(d.adbin,d.adrelid,true)) ORDER BY attnum),'[]'::jsonb) FROM pg_attribute b LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(b.attrelid,b.attnum) WHERE b.attrelid=c.oid AND b.attnum>0 AND NOT b.attisdropped),
  'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_array(conname,contype,convalidated,pg_get_constraintdef(oid,true)) ORDER BY conname),'[]'::jsonb) FROM pg_constraint WHERE conrelid=c.oid),
  'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_array(i.relname,x.indisvalid,x.indisready,pg_get_indexdef(i.oid)) ORDER BY i.relname),'[]'::jsonb) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
  'policies',(SELECT coalesce(jsonb_agg(jsonb_build_array(polname,polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid,true),pg_get_expr(polwithcheck,polrelid,true)) ORDER BY polname),'[]'::jsonb) FROM pg_policy WHERE polrelid=c.oid),
  'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgname),'[]'::jsonb) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal)
 ) ORDER BY c.relname),'[]'::jsonb) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'warehouse_automatic_wz_%'),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'returns',pg_get_function_result(p.oid),'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),'kind',p.prokind,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'owner',pg_get_userbyid(p.proowner),'security',p.prosecdef,'volatile',p.provolatile,'config',p.proconfig,'body',p.prosrc,
  'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(coalesce(pg_get_userbyid(a.grantee),'PUBLIC'),pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)
 ) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'warehouse_automatic_wz_%')
 ))
$$;
CREATE FUNCTION warehouse_automatic_wz_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected text;
BEGIN
 IF to_regprocedure('public.warehouse_inventory_policy_guards()') IS NULL OR NOT public.warehouse_inventory_policy_guards() THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'warehouse_automatic_wz_%' AND a.grantee<>c.relowner)
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute b ON b.attrelid=c.oid CROSS JOIN LATERAL aclexplode(b.attacl) a
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname LIKE 'warehouse_automatic_wz_%' AND a.grantee<>c.relowner)
 OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'warehouse_automatic_wz_%' AND a.grantee<>p.proowner) THEN RETURN false;END IF;
 SELECT fingerprint INTO expected FROM public.warehouse_automatic_wz_manifest WHERE singleton;
 RETURN expected IS NOT NULL AND expected=public.warehouse_automatic_wz_fingerprint();
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_function THEN RETURN false;
END $$;
CREATE FUNCTION warehouse_automatic_wz_require() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF NOT public.warehouse_automatic_wz_guards() THEN RAISE EXCEPTION 'Niekompletny moduł automatycznych WZ' USING ERRCODE='55000';END IF;END $$;

DO $$DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['warehouse_automatic_wz_previews','warehouse_automatic_wz_operations','warehouse_automatic_wz_revisions','warehouse_automatic_wz_configurations','warehouse_automatic_wz_admissions'] LOOP
  EXECUTE format('CREATE TRIGGER warehouse_automatic_wz_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.warehouse_automatic_wz_record_guard()',rel);
 END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER warehouse_automatic_wz_complete AFTER INSERT ON warehouse_automatic_wz_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION warehouse_automatic_wz_complete();
-- Initial manifest is inserted after final ACLs and its immutable trigger exist;
-- temporarily no INSERT guard is necessary: only UPDATE/DELETE are forbidden.
CREATE TRIGGER warehouse_automatic_wz_manifest_guard BEFORE UPDATE OR DELETE ON warehouse_automatic_wz_manifest FOR EACH ROW EXECUTE FUNCTION warehouse_automatic_wz_record_guard();
DO $$DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'warehouse_automatic_wz_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);
 END LOOP;
END $$;
INSERT INTO warehouse_automatic_wz_manifest(singleton,fingerprint) VALUES(true,warehouse_automatic_wz_fingerprint());
