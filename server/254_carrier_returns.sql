-- Migration 254_carrier_returns (prepared as 261, registered after 253_mirakl_webhook_retention; object names keep the
-- carrier261_ prefix; docs/parity/CARRIER-DPD-INPOST-L3-20261028.md).
-- L3: return labels for dispatched DPD Polska and InPost ShipX shipments. A return is a separate carrier
-- shipment from the buyer back to the merchant, so it is NOT a row of public.shipments: order_shipments_guard
-- (134/234) refuses a new parcel after dispatch and the whole-order stock issue stays untouched.
-- Own table only: no core table is altered; foreign keys to channels and users as in 234 (dhl234_pickups).
-- The order and the original shipment are bound by the application under the tenant policy.
DO $dependency261$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.channels') IS NULL OR to_regclass('public.users') IS NULL
 OR to_regclass('public.shipments') IS NULL OR to_regclass('public.dhl234_pickups') IS NULL
 THEN RAISE EXCEPTION 'Etykiety zwrotne przewoźników (261) wymagają zainstalowanej 234' USING ERRCODE='55000';END IF;
END
$dependency261$;

CREATE TABLE public.carrier261_returns (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,shipment_id uuid NOT NULL,channel_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.users(id),
 provider text NOT NULL CHECK(provider IN('dpd','inpost')),
 client_key uuid NOT NULL,fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'preview' CHECK(state IN('preview','queued','label_ready','failed','uncertain','cancelled')),
 phase text NOT NULL DEFAULT 'ready' CHECK(phase IN('ready','create_started','created','buy_started','numbers_ready','confirmed','rejected')),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 connection_hash text NOT NULL CHECK(connection_hash ~ '^[a-f0-9]{64}$'),
 reference text NOT NULL CHECK(reference ~ '^DYNA-[0-9a-f-]{36}$'),
 remote_id text CHECK(remote_id IS NULL OR remote_id ~ '^[A-Za-z0-9-]{1,64}$'),
 tracking_number text CHECK(tracking_number IS NULL OR tracking_number ~ '^[A-Za-z0-9-]{1,64}$'),
 label_base64 text CHECK(label_base64 IS NULL OR length(label_base64) BETWEEN 8 AND 6291456),
 result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object'),
 error text CHECK(error IS NULL OR length(error)<=500),job_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,reference),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES public.channels(tenant_id,id),
 CHECK(state<>'label_ready' OR (phase='confirmed' AND tracking_number IS NOT NULL AND label_base64 IS NOT NULL)),
 CHECK(state<>'queued' OR job_id IS NOT NULL)
);
-- One live return label per original shipment; a failed or cancelled attempt does not block a new one.
CREATE UNIQUE INDEX carrier261_return_live ON public.carrier261_returns(tenant_id,shipment_id) WHERE state IN('queued','label_ready','uncertain');
CREATE INDEX carrier261_return_history ON public.carrier261_returns(tenant_id,shipment_id,created_at DESC,id DESC);
CREATE INDEX carrier261_return_job ON public.carrier261_returns(job_id) WHERE state='queued';
-- The approved request is durable: identity, payload and fingerprint never change, rows are never deleted,
-- a confirmed label and a cancellation are final.
CREATE FUNCTION public.carrier261_return_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Etykieta zwrotna jest trwała' USING ERRCODE='23514';END IF;
 IF (NEW.id,NEW.tenant_id,NEW.order_id,NEW.shipment_id,NEW.channel_id,NEW.actor_id,NEW.provider,NEW.client_key,NEW.fingerprint,NEW.input,NEW.payload,NEW.connection_hash,NEW.reference,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.order_id,OLD.shipment_id,OLD.channel_id,OLD.actor_id,OLD.provider,OLD.client_key,OLD.fingerprint,OLD.input,OLD.payload,OLD.connection_hash,OLD.reference,OLD.created_at)
  OR OLD.state IN('label_ready','cancelled')
  OR (OLD.remote_id IS NOT NULL AND NEW.remote_id IS DISTINCT FROM OLD.remote_id)
  OR (OLD.tracking_number IS NOT NULL AND NEW.tracking_number IS DISTINCT FROM OLD.tracking_number) THEN
  RAISE EXCEPTION 'Zatwierdzona etykieta zwrotna jest niezmienna' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER carrier261_return_guard BEFORE UPDATE OR DELETE ON public.carrier261_returns FOR EACH ROW EXECUTE FUNCTION public.carrier261_return_guard();
CREATE FUNCTION public.carrier261_return_no_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Etykiet zwrotnych nie można usuwać' USING ERRCODE='23514';END $$;
CREATE TRIGGER carrier261_return_no_truncate BEFORE TRUNCATE ON public.carrier261_returns FOR EACH STATEMENT EXECUTE FUNCTION public.carrier261_return_no_truncate();
ALTER TABLE public.carrier261_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carrier261_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.carrier261_returns TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.carrier261_returns FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT ON public.carrier261_returns TO dyna_app;
GRANT UPDATE(state,phase,remote_id,tracking_number,label_base64,result,error,job_id,updated_at) ON public.carrier261_returns TO dyna_app;
REVOKE ALL ON FUNCTION public.carrier261_return_guard(),public.carrier261_return_no_truncate() FROM PUBLIC,dyna_app;
