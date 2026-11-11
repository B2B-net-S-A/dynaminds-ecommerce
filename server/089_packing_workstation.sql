CREATE TABLE packing_stations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL CHECK(code=btrim(code) AND char_length(code)>=1 AND char_length(code)<=40),label text NOT NULL CHECK(label=btrim(label) AND char_length(label)>=1 AND char_length(label)<=120),enabled boolean NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count integer NOT NULL DEFAULT 0,UNIQUE(tenant_id,id),UNIQUE(tenant_id,code)
);
CREATE TABLE packing_cartons (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL CHECK(code=btrim(code) AND char_length(code)>=1 AND char_length(code)<=40),label text NOT NULL CHECK(label=btrim(label) AND char_length(label)>=1 AND char_length(label)<=120),enabled boolean NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),inner_dimensions jsonb NOT NULL,outer_dimensions jsonb NOT NULL,tare_grams integer NOT NULL CHECK(tare_grams BETWEEN 0 AND 1000000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count integer NOT NULL DEFAULT 0,UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),CHECK(jsonb_typeof(inner_dimensions)='object' AND jsonb_typeof(outer_dimensions)='object')
);
CREATE TABLE packing_policies (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),version bigint NOT NULL CHECK(version>0),require_parcel_profile boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count integer NOT NULL DEFAULT 0
);
CREATE TABLE packing_sessions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),order_id uuid NOT NULL,warehouse_id uuid NOT NULL,station_id uuid NOT NULL,owner_id uuid NOT NULL REFERENCES users(id),state text NOT NULL CHECK(state IN ('active','finished','cancelled')),version bigint NOT NULL DEFAULT 1 CHECK(version>0),lease_generation bigint NOT NULL DEFAULT 1 CHECK(lease_generation>0),lease_token_hash text NOT NULL CHECK(lease_token_hash~'^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,byte_count integer NOT NULL DEFAULT 0,budget_bytes integer NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),FOREIGN KEY(tenant_id,station_id) REFERENCES packing_stations(tenant_id,id),CHECK(isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at),CHECK((state='active')=(finished_at IS NULL)),CHECK(finished_at IS NULL OR isfinite(finished_at))
);
CREATE UNIQUE INDEX packing_session_active_order ON packing_sessions(tenant_id,order_id) WHERE state='active';
CREATE TABLE packing_operations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid NOT NULL REFERENCES users(id),client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN ('manual','api')),kind text NOT NULL CHECK(kind IN ('config_create','config_edit','policy','start','renew','takeover','cancel','scan')),target_id uuid NOT NULL,session_id uuid,result jsonb NOT NULL,safe_request jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count integer NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,session_id) REFERENCES packing_sessions(tenant_id,id)
);
CREATE TABLE packing_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid NOT NULL REFERENCES users(id),client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN ('manual','api')),kind text NOT NULL CHECK(kind IN ('finish','remeasure')),session_id uuid,order_id uuid NOT NULL,scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,ready boolean NOT NULL,issues jsonb NOT NULL CHECK(jsonb_typeof(issues)='array'),full_snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count integer NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,order_id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,session_id,order_id) REFERENCES packing_sessions(tenant_id,id,order_id),CHECK((kind='finish')=(session_id IS NOT NULL)),CHECK(octet_length(full_snapshot::text)<=5242880),CHECK(isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at)
);
CREATE TABLE packing_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),actor_id uuid NOT NULL REFERENCES users(id),preview_id uuid NOT NULL,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),source text NOT NULL CHECK(source IN ('manual','api')),kind text NOT NULL CHECK(kind IN ('finish','remeasure')),order_id uuid NOT NULL,replaces_receipt_id uuid,profile_revision bigint NOT NULL CHECK(profile_revision>0),before_order_version bigint NOT NULL CHECK(before_order_version>0),after_order_version bigint NOT NULL CHECK(after_order_version>0),before_fulfillment_hash text NOT NULL CHECK(before_fulfillment_hash~'^[a-f0-9]{64}$'),after_fulfillment_hash text NOT NULL CHECK(after_fulfillment_hash~'^[a-f0-9]{64}$'),full_snapshot jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count integer NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,order_id),UNIQUE(tenant_id,id,order_id,profile_revision),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,preview_id,order_id) REFERENCES packing_previews(tenant_id,id,order_id),FOREIGN KEY(tenant_id,replaces_receipt_id,order_id) REFERENCES packing_receipts(tenant_id,id,order_id),CHECK(octet_length(full_snapshot::text)<=5242880),CHECK((kind='finish' AND after_order_version::numeric=before_order_version::numeric+1) OR (kind='remeasure' AND after_order_version=before_order_version AND before_fulfillment_hash=after_fulfillment_hash))
);
CREATE TABLE order_packing_profiles (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,receipt_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),byte_count integer NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),FOREIGN KEY(tenant_id,receipt_id,order_id,revision) REFERENCES packing_receipts(tenant_id,id,order_id,profile_revision)
);
CREATE INDEX packing_operations_page ON packing_operations(tenant_id,created_at DESC,id DESC);
CREATE INDEX packing_previews_page ON packing_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX packing_receipts_page ON packing_receipts(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX packing_sessions_page ON packing_sessions(tenant_id,order_id,state);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['packing_stations','packing_cartons','packing_policies','packing_sessions','packing_operations','packing_previews','packing_receipts','order_packing_profiles'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
END LOOP; END $$;
GRANT UPDATE ON packing_stations,packing_cartons,packing_policies,packing_sessions,order_packing_profiles TO dyna_app;
CREATE FUNCTION packing_current_role(p_user uuid,p_lock boolean DEFAULT false) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r text; BEGIN
 IF p_lock THEN SELECT role INTO r FROM memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user FOR SHARE;
 ELSE SELECT role INTO r FROM memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user; END IF; RETURN r;
END $$;
CREATE FUNCTION packing_key_grant(p_user uuid,p_key uuid,p_products boolean DEFAULT false) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k record; BEGIN SELECT * INTO k FROM api_keys WHERE (tenant_id,user_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,p_user,p_key) FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN 'invalid';END IF;
 IF NOT (k.scopes @> ARRAY['orders:read','orders:write']::text[]) OR (p_products AND NOT ('products:read'=ANY(k.scopes))) THEN RETURN 'insufficient';END IF;RETURN 'ok';END $$;
CREATE FUNCTION packing_operator_names(p_users uuid[]) RETURNS TABLE(id uuid,name text) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND u.id=ANY(p_users) $$;
REVOKE ALL ON FUNCTION packing_current_role(uuid,boolean),packing_key_grant(uuid,uuid,boolean),packing_operator_names(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION packing_current_role(uuid,boolean),packing_key_grant(uuid,uuid,boolean),packing_operator_names(uuid[]) TO dyna_app;
CREATE FUNCTION packing_fulfillment_snapshot(p_order uuid,p_status text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('order_id',o.id,'warehouse_id',o.warehouse_id,'status',coalesce(p_status,o.status),
 'order_items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'product_id',i.product_id,'quantity',i.quantity,'components',i.components) ORDER BY i.id) FROM order_items i WHERE (i.tenant_id,i.order_id)=(o.tenant_id,o.id)),'[]'::jsonb),
 'physical',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',i.product_id,'order_sku',i.sku,'order_ean',i.ean,'name',i.name,'quantity',i.quantity,'scanned',i.scanned) ORDER BY i.product_id) FROM order_pick_items i WHERE (i.tenant_id,i.order_id)=(o.tenant_id,o.id)),'[]'::jsonb),
 'reservations',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',r.product_id,'warehouse_id',r.warehouse_id,'quantity',r.quantity,'state',r.state) ORDER BY r.product_id) FROM reservations r WHERE (r.tenant_id,r.order_id)=(o.tenant_id,o.id)),'[]'::jsonb),
 'allocations',coalesce((SELECT jsonb_agg(jsonb_build_object('product_id',r.product_id,'warehouse_id',r.warehouse_id,'location',r.location,'quantity',r.quantity,'scanned',r.scanned) ORDER BY r.product_id,r.location) FROM reservation_locations r WHERE (r.tenant_id,r.order_id)=(o.tenant_id,o.id)),'[]'::jsonb))
 FROM orders o WHERE o.id=p_order AND o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
CREATE FUNCTION packing_fulfillment_hash(p_order uuid,p_status text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT encode(sha256(convert_to(packing_fulfillment_snapshot(p_order,p_status)::text,'UTF8')),'hex') $$;
REVOKE ALL ON FUNCTION packing_fulfillment_snapshot(uuid,text),packing_fulfillment_hash(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION packing_fulfillment_snapshot(uuid,text),packing_fulfillment_hash(uuid,text) TO dyna_app;
CREATE FUNCTION packing_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; d jsonb; prev record; prior record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Historia pakowania jest nieusuwalna' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME IN ('packing_operations','packing_previews','packing_receipts') AND TG_OP='UPDATE' THEN RAISE EXCEPTION 'Dowód pakowania jest niezmienny' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='packing_sessions' AND TG_OP='UPDATE' THEN
  IF OLD.state<>'active' OR (NEW.id,NEW.tenant_id,NEW.order_id,NEW.warehouse_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.order_id,OLD.warehouse_id,OLD.created_at) OR NEW.version::numeric<>OLD.version::numeric+1 OR NEW.lease_generation::numeric NOT BETWEEN OLD.lease_generation::numeric AND OLD.lease_generation::numeric+1 OR (NEW.lease_generation=OLD.lease_generation AND (NEW.owner_id,NEW.station_id,NEW.lease_token_hash,NEW.expires_at) IS DISTINCT FROM (OLD.owner_id,OLD.station_id,OLD.lease_token_hash,OLD.expires_at)) OR (NEW.lease_generation>OLD.lease_generation AND (NEW.state<>'active' OR NEW.expires_at<OLD.expires_at)) THEN RAISE EXCEPTION 'Nieprawidłowa rewizja sesji' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME IN ('packing_stations','packing_cartons','packing_policies') AND TG_OP='UPDATE' THEN
  IF NEW.tenant_id<>OLD.tenant_id OR (to_jsonb(NEW)->'id') IS DISTINCT FROM (to_jsonb(OLD)->'id') OR (to_jsonb(NEW)->'created_at') IS DISTINCT FROM (to_jsonb(OLD)->'created_at') OR NEW.version::numeric<>OLD.version::numeric+1 THEN RAISE EXCEPTION 'Nieprawidłowa rewizja konfiguracji' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='packing_cartons' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.inner_dimensions))<>3 OR (SELECT count(*) FROM jsonb_object_keys(NEW.outer_dimensions))<>3 THEN RAISE EXCEPTION 'Nieprawidłowe wymiary kartonu' USING ERRCODE='23514';END IF;
  FOREACH k IN ARRAY ARRAY['length_mm','width_mm','height_mm'] LOOP
   IF NOT (NEW.inner_dimensions ? k AND NEW.outer_dimensions ? k) OR jsonb_typeof(NEW.inner_dimensions->k)<>'number' OR jsonb_typeof(NEW.outer_dimensions->k)<>'number' OR (NEW.inner_dimensions->>k)!~'^[0-9]+$' OR (NEW.outer_dimensions->>k)!~'^[0-9]+$' OR (NEW.inner_dimensions->>k)::numeric NOT BETWEEN 1 AND 3000 OR (NEW.outer_dimensions->>k)::numeric NOT BETWEEN 1 AND 3000 OR (NEW.inner_dimensions->>k)::numeric>(NEW.outer_dimensions->>k)::numeric THEN RAISE EXCEPTION 'Nieprawidłowe wymiary kartonu' USING ERRCODE='23514';END IF;
  END LOOP;
 END IF;
 IF TG_TABLE_NAME='packing_receipts' THEN
  SELECT * INTO prev FROM packing_previews WHERE (tenant_id,id,order_id)=(NEW.tenant_id,NEW.preview_id,NEW.order_id);
  IF NOT FOUND OR NOT prev.ready OR prev.actor_id<>NEW.actor_id OR prev.source<>NEW.source OR prev.kind<>NEW.kind OR prev.full_snapshot IS DISTINCT FROM NEW.full_snapshot OR (NEW.full_snapshot#>>'{order,version}')::bigint IS DISTINCT FROM NEW.before_order_version OR NEW.before_fulfillment_hash IS DISTINCT FROM NEW.full_snapshot->>'fulfillment_hash' THEN RAISE EXCEPTION 'Dowód nie odpowiada zatwierdzonemu podglądowi' USING ERRCODE='23514';END IF;
  IF NEW.replaces_receipt_id IS NULL THEN IF NEW.profile_revision<>1 THEN RAISE EXCEPTION 'Pierwsza rewizja profilu musi wynosić 1' USING ERRCODE='23514';END IF;
  ELSE SELECT * INTO prior FROM packing_receipts WHERE (tenant_id,id,order_id)=(NEW.tenant_id,NEW.replaces_receipt_id,NEW.order_id);IF NOT FOUND OR NEW.profile_revision::numeric<>prior.profile_revision::numeric+1 THEN RAISE EXCEPTION 'Nieprawidłowy poprzedni dowód' USING ERRCODE='23514';END IF;END IF;
 END IF;
 IF TG_TABLE_NAME='packing_sessions' AND TG_OP='INSERT' THEN NEW.budget_bytes:=0;END IF;
 NEW.byte_count:=0; LOOP d:=to_jsonb(NEW); EXIT WHEN NEW.byte_count=octet_length(d::text);NEW.byte_count:=octet_length(d::text);END LOOP;
 IF TG_TABLE_NAME='packing_sessions' THEN
  IF TG_OP='INSERT' THEN NEW.budget_bytes:=NEW.byte_count+256;NEW.byte_count:=0;LOOP EXIT WHEN NEW.byte_count=octet_length(to_jsonb(NEW)::text);NEW.byte_count:=octet_length(to_jsonb(NEW)::text);END LOOP;
  ELSIF NEW.budget_bytes<>OLD.budget_bytes OR NEW.byte_count>OLD.budget_bytes THEN RAISE EXCEPTION 'Przekroczono zarezerwowany slot sesji' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION packing_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t text; n bigint; bytes bigint:=0; part bigint; lim integer;
BEGIN
 -- INSERT admission precedes FK waits. UPDATE callers already hold admission;
 -- order cancellation intentionally does not acquire it after its order lock.
 IF TG_OP='INSERT' THEN PERFORM pg_advisory_xact_lock(hashtextextended('packing.admission:'||NEW.tenant_id,0));END IF;
 FOREACH t IN ARRAY ARRAY['packing_stations','packing_cartons','packing_policies','packing_sessions','packing_operations','packing_previews','packing_receipts','order_packing_profiles'] LOOP
  EXECUTE format('SELECT count(*),coalesce(sum(%I),0) FROM %I WHERE tenant_id=$1',CASE WHEN t='packing_sessions' THEN 'budget_bytes' ELSE 'byte_count' END,t) INTO n,part USING NEW.tenant_id;
  bytes:=bytes+part;
  IF t=TG_TABLE_NAME THEN
   lim:=CASE t WHEN 'packing_stations' THEN 100 WHEN 'packing_cartons' THEN 500 WHEN 'packing_sessions' THEN 2000 WHEN 'packing_operations' THEN 100000 WHEN 'packing_previews' THEN 2000 WHEN 'packing_receipts' THEN 2000 ELSE 2147483647 END;
   IF n>lim THEN RAISE EXCEPTION 'Limit historii pakowania' USING ERRCODE='P0001';END IF;
  END IF;
 END LOOP;
 IF bytes>134217728 THEN RAISE EXCEPTION 'Limit pamięci pakowania' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM packing_sessions WHERE tenant_id=NEW.tenant_id AND state='active')>500 THEN RAISE EXCEPTION 'Limit aktywnych sesji' USING ERRCODE='P0001';END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['packing_stations','packing_cartons','packing_policies','packing_sessions','packing_operations','packing_previews','packing_receipts','order_packing_profiles'] LOOP
 EXECUTE format('CREATE TRIGGER packing_row_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION packing_row_guard()',t);
 EXECUTE format('CREATE TRIGGER packing_budget_guard AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION packing_budget_guard()',t);
END LOOP; END $$;
CREATE FUNCTION packing_receipt_after_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record; p record; s record; pointer record;
BEGIN
 SELECT * INTO o FROM orders WHERE (tenant_id,id)=(NEW.tenant_id,NEW.order_id);
 SELECT * INTO p FROM packing_previews WHERE (tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
 SELECT * INTO pointer FROM order_packing_profiles WHERE (tenant_id,order_id)=(NEW.tenant_id,NEW.order_id);
 IF o.status<>'packed' OR o.version<>NEW.after_order_version OR packing_fulfillment_hash(o.id) IS DISTINCT FROM NEW.after_fulfillment_hash OR (pointer.receipt_id,pointer.revision) IS DISTINCT FROM (NEW.id,NEW.profile_revision) OR NEW.result->>'receipt_id' IS DISTINCT FROM NEW.id::text OR NEW.result->>'order_id' IS DISTINCT FROM NEW.order_id::text OR (NEW.result->>'after_order_version')::bigint IS DISTINCT FROM NEW.after_order_version OR (NEW.result->>'before_order_version')::bigint IS DISTINCT FROM NEW.before_order_version OR NEW.result->>'status' IS DISTINCT FROM 'packed' OR (NEW.result->>'profile_revision')::bigint IS DISTINCT FROM NEW.profile_revision THEN RAISE EXCEPTION 'Pakowanie nie osiągnęło zatwierdzonego stanu końcowego' USING ERRCODE='23514';END IF;
 IF NEW.kind='finish' THEN SELECT * INTO s FROM packing_sessions WHERE (tenant_id,id,order_id)=(NEW.tenant_id,p.session_id,NEW.order_id);IF NOT FOUND OR s.state<>'finished' OR s.owner_id<>NEW.actor_id THEN RAISE EXCEPTION 'Brak zakończonej sesji' USING ERRCODE='23514';END IF;END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER packing_receipt_after_guard AFTER INSERT ON packing_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION packing_receipt_after_guard();

CREATE FUNCTION packing_insert_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('packing.admission:'||NEW.tenant_id,0));RETURN NEW;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['packing_stations','packing_cartons','packing_policies','packing_sessions','packing_operations','packing_previews','packing_receipts','order_packing_profiles'] LOOP EXECUTE format('CREATE TRIGGER aaa_packing_insert_admission BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION packing_insert_admission()',t);END LOOP;END $$;
-- CHECK validity of own actor references without pinning membership before FK waits.
CREATE FUNCTION packing_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;r record;live record;
BEGIN
 IF TG_TABLE_NAME='packing_sessions' THEN
  IF ((TG_OP='INSERT' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id) AND NOT EXISTS(SELECT 1 FROM memberships WHERE (tenant_id,user_id)=(NEW.tenant_id,NEW.owner_id))) OR NOT EXISTS(SELECT 1 FROM orders WHERE (tenant_id,id,warehouse_id)=(NEW.tenant_id,NEW.order_id,NEW.warehouse_id)) THEN RAISE EXCEPTION 'Sesja nie należy do własnego zamówienia i operatora' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME IN ('packing_operations','packing_previews','packing_receipts') THEN
  IF TG_TABLE_NAME='packing_previews' THEN
   IF NEW.full_snapshot#>>'{order,id}' IS DISTINCT FROM NEW.order_id::text OR NEW.full_snapshot#>>'{input,kind}' IS DISTINCT FROM NEW.kind OR NEW.full_snapshot#>>'{session,id}' IS DISTINCT FROM NEW.session_id::text OR NEW.issues IS DISTINCT FROM NEW.full_snapshot->'issues' THEN RAISE EXCEPTION 'Podgląd nie odpowiada własnemu scope' USING ERRCODE='23514';END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM memberships WHERE (tenant_id,user_id)=(NEW.tenant_id,NEW.actor_id)) THEN RAISE EXCEPTION 'Autor nie należy do firmy' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_packing_profiles' THEN
  IF TG_OP='UPDATE' AND ((NEW.tenant_id,NEW.order_id) IS DISTINCT FROM (OLD.tenant_id,OLD.order_id) OR NEW.revision::numeric<>OLD.revision::numeric+1) THEN RAISE EXCEPTION 'Profil nie zachowuje następnej rewizji' USING ERRCODE='23514';END IF;
  SELECT * INTO r FROM packing_receipts WHERE (tenant_id,id,order_id,profile_revision)=(NEW.tenant_id,NEW.receipt_id,NEW.order_id,NEW.revision);
  IF NOT FOUND THEN RAISE EXCEPTION 'Profil nie odpowiada nowemu dowodowi' USING ERRCODE='23514';END IF;
  IF TG_OP='INSERT' THEN
   SELECT * INTO live FROM order_packing_profiles WHERE (tenant_id,order_id)=(NEW.tenant_id,NEW.order_id);
   IF FOUND THEN IF NEW.revision::numeric<>live.revision::numeric+1 OR r.replaces_receipt_id IS DISTINCT FROM live.receipt_id THEN RAISE EXCEPTION 'Profil nie zastępuje najnowszego dowodu' USING ERRCODE='23514';END IF;
   ELSIF NEW.revision<>1 OR r.replaces_receipt_id IS NOT NULL THEN RAISE EXCEPTION 'Pierwszy profil wymaga rewizji 1' USING ERRCODE='23514';END IF;
  ELSIF r.replaces_receipt_id IS DISTINCT FROM OLD.receipt_id THEN RAISE EXCEPTION 'Profil nie zastępuje najnowszego dowodu' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
-- Membership is not normally readable by dyna_app; keep this checker narrow to trigger NEW.
ALTER FUNCTION packing_scope_guard() SECURITY DEFINER;
ALTER FUNCTION packing_scope_guard() SET search_path=public,pg_temp;
REVOKE ALL ON FUNCTION packing_scope_guard() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['packing_sessions','packing_operations','packing_previews','packing_receipts','order_packing_profiles'] LOOP EXECUTE format('CREATE TRIGGER aab_packing_scope_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION packing_scope_guard()',t);END LOOP;END $$;

CREATE FUNCTION packing_update_admission() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE tenant uuid;BEGIN tenant:=nullif(current_setting('app.tenant_id',true),'')::uuid;IF tenant IS NULL THEN RAISE EXCEPTION 'Brak firmy dla edycji konfiguracji pakowania' USING ERRCODE='23514';END IF;PERFORM pg_advisory_xact_lock(hashtextextended('packing.admission:'||tenant,0));RETURN NULL;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['packing_stations','packing_cartons','packing_policies','order_packing_profiles'] LOOP EXECUTE format('CREATE TRIGGER aaa_packing_update_admission BEFORE UPDATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION packing_update_admission()',t);END LOOP;END $$;
