-- Successor to 233, registered in db.ts migrate() after 233 (26.10.2026).
-- Carriers beyond InPost and DPD (L3 step 0): DHL Parcel Polska (WebAPI2) and Poczta Polska (eNadawca).
-- 1. order_shipments_guard() (last defined by 134): the in-flight whole-order plan admits a shipment of a
--    queued DHL (shipping.dhl, carrier 'DHL Parcel Polska') or Poczta Polska (shipping.pocztapolska,
--    carrier 'Poczta Polska') plan exactly like DPD: the local example with a DEMO number in create_started,
--    otherwise numbers_ready with external_id = tracking_number = plan.remote_id. The InPost and DPD
--    branches and every other check are unchanged. CREATE OR REPLACE keeps the trigger and its OID.
-- 2. shopify_capture_dispatch() (last defined by 108): DHL and Poczta Polska plans take the receiver from
--    the validated plan input; only a plan without provider or with provider 'inpost' is read as InPost.
-- 3. Own table dhl234_pickups: DHL courier bookings (bookCourier) with the plan-style phases.
-- 131 (label cache) and the print source kinds are not changed: print_label_assets is pinned by the
-- 177 wave print certificate (ordinary187_valid, large_import173_valid, pim_dictionary_valid).
DO $dependency234$
BEGIN
 IF current_user <> 'postgres'
 OR to_regprocedure('public.order_shipments_guard()') IS NULL
 OR to_regprocedure('public.shopify_capture_dispatch()') IS NULL
 OR to_regclass('public.shipping_plans') IS NULL OR to_regclass('public.channels') IS NULL
 OR to_regclass('public.receipt233_receipts') IS NULL
 OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.shipments'::regclass AND tgname='order_shipments_guard' AND tgfoid='public.order_shipments_guard()'::regprocedure)
 OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.shipments'::regclass AND tgname='shopify_dispatch_evidence' AND tgfoid='public.shopify_capture_dispatch()'::regprocedure)
 THEN RAISE EXCEPTION 'Przewoźnicy DHL i Poczta Polska (234) wymagają zainstalowanych 133/134, 108 i 233' USING ERRCODE='55000';END IF;
END
$dependency234$;

CREATE OR REPLACE FUNCTION public.order_shipments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE parent orders;
BEGIN
 IF TG_OP<>'DELETE' THEN
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM order_parcel_admissions a CROSS JOIN LATERAL jsonb_array_elements(a.payload->'parcels') x
   WHERE a.tenant_id=NEW.tenant_id AND a.transaction_id=pg_current_xact_id() AND a.kind='apply' AND a.order_id=NEW.order_id
    AND x->>'source_kind'='demo' AND x->>'shipment_id'=NEW.id::text AND NEW.carrier=x->>'carrier' AND NEW.tracking_number=x->>'tracking_number'
    AND NEW.mode='demo' AND NEW.channel_id IS NULL AND NEW.external_id IS NULL AND NEW.dispatched_at IS NULL AND NEW.cod_expected=(x->>'cod_minor')::integer)
   THEN RETURN NEW;END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'dispatched_at')=(to_jsonb(OLD)-'dispatched_at') AND OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM order_parcel_admissions a JOIN order_parcel_dispatches d ON(d.tenant_id,d.id)=(a.tenant_id,a.operation_id)
    WHERE a.tenant_id=NEW.tenant_id AND a.transaction_id=pg_current_xact_id() AND a.kind='dispatch' AND a.order_id=NEW.order_id AND d.shipment_id=NEW.id)
   THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Tożsamość przesyłki jest trwała' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.tenant_id,NEW.order_id,NEW.carrier,NEW.mode,NEW.channel_id,NEW.external_id,NEW.tracking_number,NEW.cod_expected)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.order_id,OLD.carrier,OLD.mode,OLD.channel_id,OLD.external_id,OLD.tracking_number,OLD.cod_expected) THEN
   RAISE EXCEPTION 'Tożsamość i kwota pobrania przesyłki są trwałe' USING ERRCODE='23514';
  END IF;
  IF NEW.dispatched_at IS NOT DISTINCT FROM OLD.dispatched_at THEN RETURN NEW;END IF;
  IF OLD.dispatched_at IS NOT NULL OR NEW.dispatched_at IS NULL THEN
   RAISE EXCEPTION 'Potwierdzone wydanie przesyłki jest trwałe' USING ERRCODE='23514';
  END IF;
 END IF;
 -- INSERT and first dispatch serialize with the existing order-first issue flow.
 -- Tracking/status-only updates return above, without a reverse parent lock.
 SELECT * INTO parent FROM orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id FOR UPDATE;
 IF parent.id IS NULL THEN RAISE EXCEPTION 'Przesyłka wymaga własnego zamówienia' USING ERRCODE='23503';END IF;
 IF TG_OP='INSERT' THEN
  IF nullif(btrim(NEW.carrier),'') IS NULL OR nullif(btrim(NEW.tracking_number),'') IS NULL THEN
   RAISE EXCEPTION 'Przesyłka wymaga jawnej tożsamości przewoźnika i trackingu' USING ERRCODE='23514';
  END IF;
  IF parent.status IN('shipped','delivered','completed','return_initiated','return_received','return_completed','cancelled')
   OR EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND dispatched_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Nowa paczka po wydaniu wymaga osobnego procesu przydziału paczek' USING ERRCODE='23514';
  END IF;
  -- A committed in-flight whole-order plan fences unrelated parcel insertion
  -- while its provider request runs outside a transaction. Do not take the
  -- worker's session advisory lock here: it belongs to another connection.
  IF EXISTS(SELECT 1 FROM shipping_plans WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id
    AND state NOT IN('preview','cancelled','dispatched')) THEN
   IF NOT EXISTS(
    SELECT 1 FROM shipping_plans plan JOIN channels channel
      ON(channel.tenant_id,channel.id)=(plan.tenant_id,plan.channel_id)
    JOIN jobs task ON task.tenant_id=plan.tenant_id AND task.id=plan.job_id
    WHERE plan.tenant_id=NEW.tenant_id AND plan.order_id=NEW.order_id
      AND plan.shipment_id IS NULL AND plan.channel_id=NEW.channel_id
      AND NEW.dispatched_at IS NULL
      AND NEW.cod_expected IS NOT DISTINCT FROM coalesce((plan.input->>'cod')::integer,0)
      AND task.state='running' AND task.lease_token IS NOT NULL
      AND task.payload->>'plan_id'=plan.id::text
      AND task.payload->>'actor_id'=plan.actor_id::text
      AND task.payload->>'channel_id'=plan.channel_id::text
      AND (
       (channel.provider='inpost' AND coalesce(plan.input->>'provider','inpost')='inpost'
        AND NEW.carrier='InPost ShipX' AND plan.state='buy_queued'
        AND plan.phase IN('buy_started','confirmed') AND task.kind='shipping'
        AND task.payload->>'action'='buy'
        AND nullif(plan.remote_id,'') IS NOT NULL AND NEW.external_id IS NOT DISTINCT FROM plan.remote_id
        AND ((channel.settings->>'simulation'='true' AND NEW.mode='demo'
          AND plan.remote_id='DEMO-'||plan.id::text
          AND NEW.tracking_number='DEMO-'||left(plan.id::text,12))
         OR (coalesce(channel.settings->>'simulation','false')<>'true' AND NEW.mode=channel.mode)))
       OR
       (channel.provider='dpd' AND plan.input->>'provider'='dpd'
        AND NEW.carrier='DPD Polska' AND plan.state='queued' AND task.kind='shipping.dpd'
        AND ((channel.settings->>'simulation'='true' AND NEW.mode='demo'
          AND plan.phase='create_started' AND NEW.external_id IS NULL
          AND NEW.tracking_number='DEMO-DPD-'||left(plan.id::text,12))
         OR (coalesce(channel.settings->>'simulation','false')<>'true' AND NEW.mode=channel.mode
          AND plan.phase='numbers_ready' AND nullif(plan.remote_id,'') IS NOT NULL
          AND NEW.external_id IS NOT DISTINCT FROM plan.remote_id
          AND NEW.tracking_number IS NOT DISTINCT FROM plan.remote_id)))
       OR
       (channel.provider='dhl' AND plan.input->>'provider'='dhl'
        AND NEW.carrier='DHL Parcel Polska' AND plan.state='queued' AND task.kind='shipping.dhl'
        AND ((channel.settings->>'simulation'='true' AND NEW.mode='demo'
          AND plan.phase='create_started' AND NEW.external_id IS NULL
          AND NEW.tracking_number='DEMO-DHL-'||left(plan.id::text,12))
         OR (coalesce(channel.settings->>'simulation','false')<>'true' AND NEW.mode=channel.mode
          AND plan.phase='numbers_ready' AND nullif(plan.remote_id,'') IS NOT NULL
          AND NEW.external_id IS NOT DISTINCT FROM plan.remote_id
          AND NEW.tracking_number IS NOT DISTINCT FROM plan.remote_id)))
       OR
       (channel.provider='pocztapolska' AND plan.input->>'provider'='pocztapolska'
        AND NEW.carrier='Poczta Polska' AND plan.state='queued' AND task.kind='shipping.pocztapolska'
        AND ((channel.settings->>'simulation'='true' AND NEW.mode='demo'
          AND plan.phase='create_started' AND NEW.external_id IS NULL
          AND NEW.tracking_number='DEMO-PP-'||left(plan.id::text,12))
         OR (coalesce(channel.settings->>'simulation','false')<>'true' AND NEW.mode=channel.mode
          AND plan.phase='numbers_ready' AND nullif(plan.remote_id,'') IS NOT NULL
          AND NEW.external_id IS NOT DISTINCT FROM plan.remote_id
          AND NEW.tracking_number IS NOT DISTINCT FROM plan.remote_id)))
      )
   ) THEN RAISE EXCEPTION 'Aktywny plan nadania blokuje inną paczkę' USING ERRCODE='23514';END IF;
   IF EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN
    RAISE EXCEPTION 'Plan całego zamówienia nie może utworzyć dodatkowej paczki' USING ERRCODE='23514';
   END IF;
  END IF;
  IF NEW.dispatched_at IS NOT NULL AND EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN
   RAISE EXCEPTION 'Wydanie wielu paczek wymaga jawnego przydziału pozycji' USING ERRCODE='23514';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND id<>NEW.id) THEN
   RAISE EXCEPTION 'Wydanie wielu paczek wymaga jawnego przydziału pozycji' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shopify_capture_dispatch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  ELSIF p.input->>'provider' IN('dhl','pocztapolska') THEN
   -- 234: DHL and Poczta Polska plans keep the validated DPD-shaped receiver in input; a pickup point does not prove a street recipient.
   IF p.input->>'service' IS DISTINCT FROM 'pocztex_punkt' THEN
    r:=p.input->'receiver';
    receiver:=jsonb_build_object('customer_name',r->>'name','email',r->>'email','address',jsonb_build_object('street',r->>'address','city',r->>'city','postal_code',r->>'postalCode','country',r->>'countryCode','phone',r->>'phone'));
   END IF;
  ELSIF coalesce(p.input->>'provider','inpost')='inpost' THEN
   r:=p.payload->'receiver';
   -- Parcel lockers do not prove a street recipient, so cannot confirm source courier delivery.
   IF p.input->>'service'='inpost_courier_standard' THEN
    receiver:=jsonb_build_object('customer_name',concat(r->>'first_name',' ',r->>'last_name'),'email',r->>'email','address',jsonb_build_object('street',concat(r#>>'{address,street}',' ',r#>>'{address,building_number}'),'city',r#>>'{address,city}','postal_code',r#>>'{address,post_code}','country',r#>>'{address,country_code}','phone',r->>'phone'));
   END IF;
  END IF;
 END IF;
 -- A local parcel contains only the local remainder of exact commercial lines.
 -- Historical dispatch records are never rewritten by this new factory.
 SELECT coalesce(jsonb_agg(CASE WHEN x.quantity>0 THEN to_jsonb(i)||jsonb_build_object(
   'quantity',i.quantity-x.quantity,'original_quantity',i.quantity,'external_quantity',x.quantity)
   ELSE to_jsonb(i) END ORDER BY i.id),'[]'::jsonb) INTO items
 FROM public.order_items i LEFT JOIN LATERAL(
  SELECT coalesce(sum(l.quantity),0)::integer quantity FROM public.b2b_dropship_lines l
  JOIN public.b2b_dropship_orders d ON(d.tenant_id,d.id)=(l.tenant_id,l.order_id)
  WHERE l.tenant_id=NEW.tenant_id AND l.customer_order_id=NEW.order_id
   AND l.customer_item_id=i.id AND d.state='ordered'
 ) x ON true WHERE i.tenant_id=NEW.tenant_id AND i.order_id=NEW.order_id
  AND i.quantity>x.quantity;
 -- Preserve the first dispatch witness when a mutable shipment stamp is restored.
 INSERT INTO public.shopify_dispatch_evidence(tenant_id,shipment_id,order_id,receiver,items,dispatched_at)
 VALUES(NEW.tenant_id,NEW.id,NEW.order_id,receiver,items,NEW.dispatched_at)
 ON CONFLICT(tenant_id,shipment_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shopify_capture_dispatch() FROM PUBLIC,dyna_app;

CREATE TABLE public.dhl234_pickups (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES public.users(id),
 client_key uuid NOT NULL,fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'preview' CHECK(state IN('preview','queued','booked','failed','uncertain','cancel_queued','cancelled')),
 phase text NOT NULL DEFAULT 'ready' CHECK(phase IN('ready','book_started','booked','cancel_started','cancelled','rejected')),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 connection_hash text NOT NULL CHECK(connection_hash ~ '^[a-f0-9]{64}$'),
 waybills text[] NOT NULL CHECK(cardinality(waybills) BETWEEN 1 AND 200),order_ids text[] CHECK(order_ids IS NULL OR cardinality(order_ids) BETWEEN 1 AND 20),
 requested_number text NOT NULL CHECK(requested_number ~ '^DHL-[A-Z0-9]{8,40}$'),
 result jsonb,error text CHECK(error IS NULL OR length(error)<=500),job_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,requested_number),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES public.channels(tenant_id,id),
 CHECK(state<>'booked' OR phase='booked'),CHECK((order_ids IS NOT NULL)=(phase IN('booked','cancel_started','cancelled')))
);
CREATE INDEX dhl234_pickup_history ON public.dhl234_pickups(tenant_id,channel_id,created_at DESC,id DESC);
CREATE INDEX dhl234_pickup_job ON public.dhl234_pickups(job_id) WHERE state IN('queued','cancel_queued');
-- The approved booking, its fingerprint and the DHL order numbers are durable; rows are never deleted.
CREATE FUNCTION public.dhl234_pickup_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Zlecenie odbioru DHL jest trwałe' USING ERRCODE='23514';END IF;
 IF (NEW.id,NEW.tenant_id,NEW.channel_id,NEW.actor_id,NEW.client_key,NEW.fingerprint,NEW.input,NEW.payload,NEW.connection_hash,NEW.waybills,NEW.requested_number,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.channel_id,OLD.actor_id,OLD.client_key,OLD.fingerprint,OLD.input,OLD.payload,OLD.connection_hash,OLD.waybills,OLD.requested_number,OLD.created_at)
  OR (OLD.order_ids IS NOT NULL AND NEW.order_ids IS DISTINCT FROM OLD.order_ids)
  OR OLD.state='cancelled' THEN
  RAISE EXCEPTION 'Zatwierdzone zlecenie odbioru DHL jest niezmienne' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dhl234_pickup_guard BEFORE UPDATE OR DELETE ON public.dhl234_pickups FOR EACH ROW EXECUTE FUNCTION public.dhl234_pickup_guard();
CREATE FUNCTION public.dhl234_pickup_no_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Zleceń odbioru DHL nie można usuwać' USING ERRCODE='23514';END $$;
CREATE TRIGGER dhl234_pickup_no_truncate BEFORE TRUNCATE ON public.dhl234_pickups FOR EACH STATEMENT EXECUTE FUNCTION public.dhl234_pickup_no_truncate();
ALTER TABLE public.dhl234_pickups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dhl234_pickups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.dhl234_pickups TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.dhl234_pickups FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT ON public.dhl234_pickups TO dyna_app;
GRANT UPDATE(state,phase,order_ids,result,error,job_id,updated_at) ON public.dhl234_pickups TO dyna_app;
REVOKE ALL ON FUNCTION public.dhl234_pickup_guard(),public.dhl234_pickup_no_truncate() FROM PUBLIC,dyna_app;
