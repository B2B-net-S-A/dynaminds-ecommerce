-- Migration 268_cancelled_label_relabel (Uwagi v3, automation catalogue row 19; registered after 267).
-- docs/parity/relabel268-generation-plan.md (decision of 11.11.2026: variant B).
--
-- "Anuluj etykietę" (server/shipment-cancel.ts) keeps the permanent shipment row with status 'canceled'. The sealed
-- order guards count every shipment row of an order (order_shipments_dispatch_guard on orders, 134/137), and that
-- trigger is hashed by the 158/159/160 fingerprints, so it stays as it is. Instead the new label takes over the
-- cancelled row: the order keeps one shipment row, and the former label identity is kept here.
-- 1. shipment268_replaced_labels: the identity of every cancelled label replaced by a new one (written only by
--    order_shipments_guard, immutable; the application reads it for the order history).
-- 2. order_shipments_guard() (last written by 234), byte for byte except four derived places:
--    a. a cancelled label that was never handed over may change its identity once to a new label (new tracking
--       number, same order, not dispatched); the old identity goes to shipment268_replaced_labels and the new
--       label passes the same checks as an inserted one (carrier plan admission, order status);
--    b. a cancelled label can never be handed over (any dispatch path, parcel dispatches included);
--    c. a new label (inserted or taking over a row) never carries a number of a replaced label: the replaced
--       number left shipments and with it shipments_tracking_identity / shipments_provider_identity (133);
--    d. the "another parcel" checks of a new label do not count the row that the new label replaces.
-- No change on orders, order_items or any other fingerprinted table; CREATE OR REPLACE keeps the trigger, its OID,
-- owner and ACL.
DO $dependency268$
BEGIN
 IF current_user <> 'postgres'
 OR to_regprocedure('public.order_shipments_guard()') IS NULL
 OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.shipments'::regclass AND tgname='order_shipments_guard' AND tgfoid='public.order_shipments_guard()'::regprocedure)
 OR NOT EXISTS(SELECT FROM public.migrations WHERE name='267_status_categories_automation_editors')
 OR to_regclass('public.shipment268_replaced_labels') IS NOT NULL
 THEN RAISE EXCEPTION 'Nowa etykieta po anulowaniu (268) wymaga zainstalowanych 133/134/234 i 267' USING ERRCODE='55000';END IF;
END
$dependency268$;

CREATE TABLE shipment268_replaced_labels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 shipment_id uuid NOT NULL,
 order_id uuid NOT NULL,
 carrier text NOT NULL,
 tracking_number text NOT NULL,
 mode text NOT NULL,
 channel_id uuid,
 external_id text,
 cod_expected integer NOT NULL,
 label_created_at timestamptz NOT NULL,
 replaced_by text NOT NULL,
 replaced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,shipment_id,tracking_number)
);
CREATE INDEX shipment268_replaced_labels_order ON shipment268_replaced_labels(tenant_id,order_id,replaced_at);
CREATE INDEX shipment268_replaced_labels_number ON shipment268_replaced_labels(tenant_id,tracking_number);
ALTER TABLE shipment268_replaced_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment268_replaced_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON shipment268_replaced_labels TO postgres USING(true) WITH CHECK(true);
CREATE POLICY tenant_scope ON shipment268_replaced_labels TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON shipment268_replaced_labels FROM PUBLIC,dyna_app;
GRANT SELECT ON shipment268_replaced_labels TO dyna_app;
CREATE FUNCTION shipment268_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Historia zastąpionych etykiet jest niezmienna' USING ERRCODE='23514';END$$;
REVOKE ALL ON FUNCTION shipment268_immutable() FROM PUBLIC,dyna_app;
CREATE TRIGGER shipment268_immutable BEFORE UPDATE OR DELETE ON shipment268_replaced_labels FOR EACH ROW EXECUTE FUNCTION shipment268_immutable();
CREATE TRIGGER shipment268_no_truncate BEFORE TRUNCATE ON shipment268_replaced_labels FOR EACH STATEMENT EXECUTE FUNCTION shipment268_immutable();

DO $relabel268$
DECLARE definition text;edit text[];
-- Each edit replaces its anchor, which must occur exactly once in the installed body; a body that already names
-- shipment268_ is an unknown variant.
BEGIN
 definition:=pg_get_functiondef('public.order_shipments_guard()'::regprocedure);
 IF position('shipment268_' IN definition)>0 THEN RAISE EXCEPTION 'Nieznany wariant strażnika przesyłek zamówienia' USING ERRCODE='55000';END IF;
 FOREACH edit SLICE 1 IN ARRAY ARRAY[
  [E'DECLARE parent orders;\nBEGIN\n IF TG_OP<>''DELETE'' THEN\n',
   E'DECLARE parent orders;relabel boolean:=false;\nBEGIN\n IF TG_OP=''UPDATE'' AND NEW.status=''canceled'' AND OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL THEN\n  RAISE EXCEPTION ''Anulowanej etykiety nie można wydać'' USING ERRCODE=''23514'';\n END IF;\n IF TG_OP<>''DELETE'' THEN\n'],
  [E' IF TG_OP=''UPDATE'' THEN\n  IF (NEW.id,',
   E' IF TG_OP=''UPDATE'' AND OLD.status=''canceled'' AND NEW.status IS DISTINCT FROM ''canceled'' THEN\n  IF OLD.dispatched_at IS NOT NULL OR NEW.dispatched_at IS NOT NULL OR (NEW.id,NEW.tenant_id,NEW.order_id) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.order_id)\n   OR NEW.tracking_number IS NOT DISTINCT FROM OLD.tracking_number THEN\n   RAISE EXCEPTION ''Anulowaną etykietę zastępuje tylko nowa etykieta przed nadaniem'' USING ERRCODE=''23514'';\n  END IF;\n  INSERT INTO shipment268_replaced_labels(tenant_id,shipment_id,order_id,carrier,tracking_number,mode,channel_id,external_id,cod_expected,label_created_at,replaced_by)\n   VALUES(OLD.tenant_id,OLD.id,OLD.order_id,OLD.carrier,OLD.tracking_number,OLD.mode,OLD.channel_id,OLD.external_id,OLD.cod_expected,OLD.created_at,NEW.tracking_number);\n  relabel:=true;\n ELSIF TG_OP=''UPDATE'' THEN\n  IF (NEW.id,'],
  [E' IF TG_OP=''INSERT'' THEN\n  IF nullif(btrim(NEW.carrier)',
   E' IF TG_OP=''INSERT'' OR relabel THEN\n  IF EXISTS(SELECT 1 FROM shipment268_replaced_labels r WHERE r.tenant_id=NEW.tenant_id AND ((r.carrier,r.mode,r.tracking_number)=(NEW.carrier,NEW.mode,NEW.tracking_number) AND r.channel_id IS NOT DISTINCT FROM NEW.channel_id\n    OR NEW.channel_id IS NOT NULL AND nullif(NEW.external_id,'''') IS NOT NULL AND (r.channel_id,r.mode,r.external_id)=(NEW.channel_id,NEW.mode,NEW.external_id))) THEN\n   RAISE EXCEPTION ''Numer anulowanej etykiety nie wraca do obiegu'' USING ERRCODE=''23505'';\n  END IF;\n  IF nullif(btrim(NEW.carrier)'],
  ['IF EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id) THEN',
   'IF EXISTS(SELECT 1 FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND id<>NEW.id) THEN']
 ] LOOP
  IF (length(definition)-length(replace(definition,edit[1],'')))<>length(edit[1]) THEN
   RAISE EXCEPTION 'Nieznany wariant strażnika przesyłek zamówienia' USING ERRCODE='55000';END IF;
  definition:=replace(definition,edit[1],edit[2]);
 END LOOP;
 EXECUTE definition;
END
$relabel268$;
