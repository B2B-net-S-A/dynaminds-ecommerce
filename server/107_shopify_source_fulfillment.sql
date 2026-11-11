-- Additive source-scoped fulfillment. Legacy whole-order plans/claims remain immutable.
CREATE TABLE shopify_source_fulfillment_requests (
 tenant_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,
 api_key_id uuid REFERENCES api_keys,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),plan_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,client_key),UNIQUE(tenant_id,plan_id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES shopify_fulfillment_plans(tenant_id,id)
);
CREATE TABLE shopify_dispatch_evidence (
 tenant_id uuid NOT NULL,shipment_id uuid NOT NULL,order_id uuid NOT NULL,receiver jsonb,
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),dispatched_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,shipment_id),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE FUNCTION shopify_source_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Shopify source evidence is immutable' USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['shopify_source_fulfillment_requests','shopify_dispatch_evidence'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 IF t='shopify_dispatch_evidence' THEN EXECUTE format('GRANT SELECT ON %I TO dyna_app',t);ELSE EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);END IF;
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION shopify_source_snapshot_immutable()',t);
END LOOP;END $$;
-- This is original shipment-time evidence, never a backfill from mutable current headers.
CREATE FUNCTION shopify_capture_dispatch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.orders%ROWTYPE; p public.shipping_plans%ROWTYPE; receiver jsonb; items jsonb; r jsonb;
BEGIN
 IF NEW.dispatched_at IS NULL OR (TG_OP='UPDATE' AND OLD.dispatched_at IS NOT NULL) THEN RETURN NEW; END IF;
 IF (current_setting('role',true)='dyna_app' OR nullif(current_setting('app.tenant_id',true),'') IS NOT NULL) AND NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Inna firma dowodu paczki';END IF;
 SELECT * INTO o FROM public.orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id;
 SELECT * INTO p FROM public.shipping_plans WHERE tenant_id=NEW.tenant_id AND shipment_id=NEW.id AND state IN('ready','dispatched') ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NEW.mode='demo' AND p.id IS NULL THEN receiver:=jsonb_build_object('customer_name',o.customer_name,'email',o.email,'address',o.address);
 ELSIF p.id IS NOT NULL THEN
  IF p.input->>'provider'='dpd' THEN
   r:=p.payload#>'{packages,0,receiver}';
   receiver:=jsonb_build_object('customer_name',r->>'name','email',r->>'email','address',jsonb_build_object('street',r->>'address','city',r->>'city','postal_code',r->>'postalCode','country',r->>'countryCode','phone',r->>'phone'));
  ELSE
   r:=p.payload->'receiver';
   -- Parcel lockers do not prove a street recipient, so cannot confirm source courier delivery.
   IF p.input->>'service'='inpost_courier_standard' THEN
    receiver:=jsonb_build_object('customer_name',concat(r->>'first_name',' ',r->>'last_name'),'email',r->>'email','address',jsonb_build_object('street',concat(r#>>'{address,street}',' ',r#>>'{address,building_number}'),'city',r#>>'{address,city}','postal_code',r#>>'{address,post_code}','country',r#>>'{address,country_code}','phone',r->>'phone'));
   END IF;
  END IF;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) INTO items FROM public.order_items i WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id;
 INSERT INTO public.shopify_dispatch_evidence(tenant_id,shipment_id,order_id,receiver,items,dispatched_at) VALUES(NEW.tenant_id,NEW.id,NEW.order_id,receiver,items,NEW.dispatched_at);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION shopify_capture_dispatch() FROM PUBLIC,dyna_app;
CREATE TRIGGER shopify_dispatch_evidence AFTER INSERT OR UPDATE OF dispatched_at ON shipments FOR EACH ROW EXECUTE FUNCTION shopify_capture_dispatch();
-- Global account/order principal remains exclusive across tenants and duplicate local imports.
CREATE TABLE shopify_source_fulfillment_principals (
 scope_hash text PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,source_order_id uuid NOT NULL,
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,source_order_id) REFERENCES orders(tenant_id,id)
);
CREATE TABLE shopify_source_fulfillment_capacity_ledger (
 scope_hash text NOT NULL,plan_id uuid NOT NULL REFERENCES shopify_fulfillment_plans(id),tenant_id uuid NOT NULL,
 remote_line_id text NOT NULL CHECK(remote_line_id ~ '^gid://shopify/LineItem/[1-9][0-9]{0,19}$'),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),maximum_quantity integer NOT NULL CHECK(maximum_quantity BETWEEN 1 AND 1000000),
 PRIMARY KEY(scope_hash,plan_id,remote_line_id)
);
CREATE TABLE shopify_source_fulfillment_confirmations (
 scope_hash text NOT NULL,remote_id text NOT NULL,plan_id uuid NOT NULL UNIQUE REFERENCES shopify_fulfillment_plans(id),
 tenant_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(scope_hash,remote_id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['shopify_source_fulfillment_principals','shopify_source_fulfillment_capacity_ledger','shopify_source_fulfillment_confirmations'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);END LOOP;END $$;
REVOKE ALL ON shopify_source_fulfillment_principals,shopify_source_fulfillment_capacity_ledger,shopify_source_fulfillment_confirmations FROM PUBLIC,dyna_app;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON shopify_source_fulfillment_confirmations FOR EACH ROW EXECUTE FUNCTION shopify_source_snapshot_immutable();
CREATE FUNCTION shopify_source_fulfillment_capacity(p_scope jsonb,p_exclude uuid DEFAULT NULL)
RETURNS TABLE(remote_line_id text,quantity bigint,confirmed_quantity bigint,reserved_quantity bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT l.remote_line_id,sum(l.quantity),coalesce(sum(l.quantity) FILTER(WHERE f.plan_id IS NOT NULL),0),coalesce(sum(l.quantity) FILTER(WHERE f.plan_id IS NULL),0) FROM public.shopify_source_fulfillment_capacity_ledger l LEFT JOIN public.shopify_source_fulfillment_confirmations f ON f.plan_id=l.plan_id
 WHERE l.scope_hash=encode(sha256(convert_to(p_scope::text,'UTF8')),'hex')
 AND l.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND l.plan_id IS DISTINCT FROM p_exclude GROUP BY l.remote_line_id
$$;
CREATE OR REPLACE FUNCTION shopify_fulfillment_claim(p_plan uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE k text;t uuid;p public.shopify_fulfillment_plans%ROWTYPE;s public.shopify_fulfillment_plans%ROWTYPE;principal public.shopify_source_fulfillment_principals%ROWTYPE;l jsonb;maximum integer;used bigint;sid uuid;
BEGIN
 k:=public.shopify_fulfillment_scope(p_plan);t:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF k IS NULL THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('shopify-fulfillment-claim:'||k,0));
 SELECT * INTO p FROM public.shopify_fulfillment_plans WHERE id=p_plan AND tenant_id=t;
 SELECT q.* INTO s FROM public.shopify_fulfillment_scopes x JOIN public.shopify_fulfillment_plans q ON q.id=x.plan_id WHERE x.scope_hash=k;
 IF p.payload ? 'partial' THEN
  sid:=(p.payload#>>'{partial,source_order_id}')::uuid;
  SELECT * INTO principal FROM public.shopify_source_fulfillment_principals WHERE scope_hash=k;
  IF principal.scope_hash IS NOT NULL AND (principal.tenant_id,principal.channel_id,principal.source_order_id) IS DISTINCT FROM (t,p.channel_id,sid) THEN RETURN false;END IF;
  IF s.id IS NOT NULL AND s.id<>p.id AND NOT(s.tenant_id=t AND s.channel_id=p.channel_id AND s.payload#>>'{partial,source_order_id}'=sid::text AND ((s.state='done' AND s.phase='done' AND EXISTS(SELECT 1 FROM public.shopify_source_fulfillment_confirmations f WHERE f.plan_id=s.id)) OR (s.phase='ready' AND s.state IN('failed','conflict','cancelled')))) THEN RETURN false;END IF;
  FOR l IN SELECT value FROM jsonb_array_elements(p.payload->'lines') LOOP
   SELECT b.quantity INTO maximum FROM public.order_source_lines b WHERE b.tenant_id=t AND b.source_order_id=sid AND b.channel_id=p.channel_id AND b.remote_line_id=l->>'id';
   IF maximum IS NULL THEN RETURN false;END IF;
   SELECT coalesce(sum(quantity),0) INTO used FROM public.shopify_source_fulfillment_capacity_ledger WHERE scope_hash=k AND remote_line_id=l->>'id' AND plan_id<>p.id;
   IF used+(l->>'quantity')::integer>maximum THEN RETURN false;END IF;
   IF EXISTS(SELECT 1 FROM public.shopify_source_fulfillment_capacity_ledger WHERE scope_hash=k AND remote_line_id=l->>'id' AND maximum_quantity<>maximum) THEN RETURN false;END IF;
  END LOOP;
  INSERT INTO public.shopify_source_fulfillment_principals VALUES(k,t,p.channel_id,sid) ON CONFLICT DO NOTHING;
  IF s.id IS NOT NULL AND s.id<>p.id THEN DELETE FROM public.shopify_fulfillment_scopes WHERE scope_hash=k;END IF;
  INSERT INTO public.shopify_fulfillment_scopes(scope_hash,tenant_id,plan_id) VALUES(k,t,p.id) ON CONFLICT DO NOTHING;
  INSERT INTO public.shopify_source_fulfillment_capacity_ledger(scope_hash,plan_id,tenant_id,remote_line_id,quantity,maximum_quantity)
  SELECT k,p.id,t,j.value->>'id',(j.value->>'quantity')::integer,b.quantity FROM jsonb_array_elements(p.payload->'lines') AS j(value) JOIN public.order_source_lines b ON b.tenant_id=t AND b.source_order_id=sid AND b.channel_id=p.channel_id AND b.remote_line_id=j.value->>'id' ON CONFLICT DO NOTHING;
 ELSE
  -- Legacy claim behavior, but never overwrite an established partial principal.
  IF EXISTS(SELECT 1 FROM public.shopify_source_fulfillment_principals WHERE scope_hash=k) THEN RETURN s.id=p.id;END IF;
  DELETE FROM public.shopify_fulfillment_scopes x USING public.shopify_fulfillment_plans q WHERE x.scope_hash=k AND x.plan_id=q.id AND q.id<>p.id AND q.phase='ready' AND q.state IN('failed','conflict','cancelled');
  INSERT INTO public.shopify_fulfillment_scopes(scope_hash,tenant_id,plan_id) VALUES(k,t,p.id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN EXISTS(SELECT 1 FROM public.shopify_fulfillment_scopes WHERE scope_hash=k AND tenant_id=t AND plan_id=p.id);
END $$;
CREATE OR REPLACE FUNCTION shopify_fulfillment_release(p_plan uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.shopify_fulfillment_plans%ROWTYPE;k text;
BEGIN
 SELECT * INTO p FROM public.shopify_fulfillment_plans WHERE id=p_plan AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF p.id IS NULL OR p.phase<>'ready' OR p.state NOT IN('failed','conflict','cancelled') THEN RETURN;END IF;
 k:=public.shopify_fulfillment_scope(p.id);
 PERFORM pg_advisory_xact_lock(hashtextextended('shopify-fulfillment-claim:'||k,0));
 DELETE FROM public.shopify_source_fulfillment_capacity_ledger WHERE plan_id=p.id;
 DELETE FROM public.shopify_fulfillment_scopes WHERE plan_id=p.id;
END $$;
CREATE FUNCTION shopify_source_fulfillment_confirm(p_plan uuid,p_remote text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.shopify_fulfillment_plans%ROWTYPE;k text;
BEGIN
 SELECT * INTO p FROM public.shopify_fulfillment_plans WHERE id=p_plan AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF p.id IS NULL OR NOT(p.payload ? 'partial') OR p.state<>'done' OR p.phase<>'done' OR p.remote_id<>p_remote THEN RAISE EXCEPTION 'Brak potwierdzonej części Shopify';END IF;
 k:=public.shopify_fulfillment_scope(p.id);
 IF NOT EXISTS(SELECT 1 FROM public.shopify_fulfillment_scopes WHERE scope_hash=k AND plan_id=p.id) THEN RAISE EXCEPTION 'Utracono wyłączność realizacji';END IF;
 INSERT INTO public.shopify_source_fulfillment_confirmations(scope_hash,remote_id,plan_id,tenant_id) VALUES(k,p_remote,p.id,p.tenant_id) ON CONFLICT(plan_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION shopify_source_fulfillment_capacity(jsonb,uuid),shopify_source_fulfillment_confirm(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_source_fulfillment_capacity(jsonb,uuid),shopify_source_fulfillment_confirm(uuid,text) TO dyna_app;

CREATE FUNCTION shopify_source_fulfillment_authority(p_actor uuid,p_key uuid,p_write boolean,p_lock boolean) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r text;k public.api_keys%ROWTYPE;
BEGIN
 IF p_lock THEN SELECT role INTO r FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_actor FOR SHARE;
 ELSE SELECT role INTO r FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_actor;END IF;
 IF p_key IS NOT NULL THEN
  IF p_lock THEN SELECT * INTO k FROM public.api_keys WHERE id=p_key AND user_id=p_actor AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR SHARE;
  ELSE SELECT * INTO k FROM public.api_keys WHERE id=p_key AND user_id=p_actor AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;END IF;
  IF k.id IS NULL OR k.revoked_at IS NOT NULL OR k.expires_at<=clock_timestamp() OR NOT('orders:read'=ANY(k.scopes)) OR (p_write AND NOT('orders:write'=ANY(k.scopes))) THEN RETURN NULL;END IF;
 END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION shopify_source_fulfillment_authority(uuid,uuid,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_source_fulfillment_authority(uuid,uuid,boolean,boolean) TO dyna_app;
