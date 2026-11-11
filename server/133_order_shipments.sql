-- Multiple independently identified label sources per packed order.
-- This does not introduce parcel assignments or partial inventory dispatch.
-- Historical rows and all referenced composite identities remain unchanged.
DO $$
DECLARE key_name text;key_columns smallint[];
BEGIN
 SELECT array_agg(attnum::smallint ORDER BY attnum) INTO key_columns
 FROM pg_attribute WHERE attrelid='shipments'::regclass AND attname IN('tenant_id','order_id') AND NOT attisdropped;
 SELECT conname INTO key_name FROM pg_constraint
 WHERE conrelid='shipments'::regclass AND contype='u'
 AND (SELECT array_agg(k ORDER BY k) FROM unnest(conkey) k)=key_columns;
 IF key_name IS NULL THEN
  RAISE EXCEPTION 'Brak oczekiwanego ograniczenia jednej przesyłki na zamówienie' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid='shipments'::regclass AND contype='f'
  AND (SELECT array_agg(k ORDER BY k) FROM unnest(confkey) k)=key_columns) THEN
  RAISE EXCEPTION 'Klucz jednej przesyłki jest nadal używany przez klucz obcy' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM shipments GROUP BY tenant_id,carrier,mode,channel_id,tracking_number HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Powtórzona historyczna tożsamość trackingu; migracja nie zmienia danych' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM shipments WHERE channel_id IS NOT NULL AND nullif(external_id,'') IS NOT NULL
  GROUP BY tenant_id,channel_id,mode,external_id HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Powtórzona historyczna tożsamość dostawcy; migracja nie zmienia danych' USING ERRCODE='23514';
 END IF;
 EXECUTE format('ALTER TABLE shipments DROP CONSTRAINT %I',key_name);
END $$;

-- Null channel is the local carrier namespace, not a uniqueness escape.
CREATE UNIQUE INDEX shipments_tracking_identity
 ON shipments(tenant_id,carrier,mode,channel_id,tracking_number) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX shipments_provider_identity
 ON shipments(tenant_id,channel_id,mode,external_id)
 WHERE channel_id IS NOT NULL AND nullif(external_id,'') IS NOT NULL;
CREATE INDEX shipments_order_page ON shipments(tenant_id,order_id,created_at,id);

CREATE FUNCTION order_shipments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE parent orders;
BEGIN
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
CREATE TRIGGER order_shipments_guard BEFORE INSERT OR UPDATE OR DELETE ON shipments
 FOR EACH ROW EXECUTE FUNCTION order_shipments_guard();

CREATE FUNCTION order_shipments_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status='shipped' AND NEW.status IS DISTINCT FROM OLD.status
  AND (SELECT count(*) FROM shipments WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id)>1 THEN
  RAISE EXCEPTION 'Wydanie wielu paczek wymaga jawnego przydziału pozycji' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_shipments_dispatch_guard BEFORE UPDATE ON orders
 FOR EACH ROW EXECUTE FUNCTION order_shipments_dispatch_guard();

CREATE FUNCTION order_shipments_installed() RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM migrations WHERE name='133_order_shipments')
$$;
CREATE FUNCTION order_shipments_guards() RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin'
 AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=to_regclass('shipments'))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_shipments_guard()','order_shipments_dispatch_guard()','order_shipments_installed()']) f WHERE to_regprocedure(f) IS NULL)
 AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('shipments') AND contype='u' AND cardinality(conkey)=2
  AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid=conrelid AND a.attnum=ANY(conkey))=ARRAY['order_id','tenant_id'])
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('shipments') AND contype='u' AND convalidated
  AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid=conrelid AND a.attnum=ANY(conkey))=ARRAY['id','tenant_id'])
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('shipments') AND contype='u' AND convalidated
  AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid=conrelid AND a.attnum=ANY(conkey))=ARRAY['id','order_id','tenant_id'])
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['shipments_tracking_identity','shipments_provider_identity','shipments_order_page']) n
  WHERE NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass(n) AND indrelid=to_regclass('shipments') AND indisvalid))
 AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('shipments_tracking_identity') AND indisunique AND indnullsnotdistinct)
 AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('shipments_provider_identity') AND indisunique)
 AND NOT EXISTS(SELECT 1 FROM (VALUES('shipments','order_shipments_guard','order_shipments_guard()'),('orders','order_shipments_dispatch_guard','order_shipments_dispatch_guard()')) g(rel,name,fn)
  WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(g.rel) AND tgname::text=g.name AND tgfoid=to_regprocedure(g.fn) AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable))
$$;
REVOKE ALL ON FUNCTION order_shipments_guard(),order_shipments_dispatch_guard(),order_shipments_installed(),order_shipments_guards() FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION order_shipments_installed(),order_shipments_guards() TO dyna_app;
