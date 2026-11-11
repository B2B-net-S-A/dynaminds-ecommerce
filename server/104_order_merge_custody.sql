-- Explicit custody transfer: no stock, bin, position, movement or payment mutation.
ALTER TABLE reservations DROP CONSTRAINT reservations_state_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_state_check CHECK(state IN ('active','released','consumed','transferred'));
ALTER TABLE wms_reservation_layers DROP CONSTRAINT wms_reservation_layers_state_check;
ALTER TABLE wms_reservation_layers ADD CONSTRAINT wms_reservation_layers_state_check CHECK(state IN ('active','released','consumed','transferred'));

CREATE TABLE order_merge_custody_transfers (
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),
 source_ids uuid[] NOT NULL,target_order_id uuid NOT NULL,merge_mode text NOT NULL CHECK(merge_mode IN ('technical_merge','into_main_order')),
 transaction_id xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,
 before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),byte_count bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,execution_id),FOREIGN KEY(tenant_id,execution_id) REFERENCES order_merge_executions(tenant_id,id),
 FOREIGN KEY(tenant_id,target_order_id) REFERENCES orders(tenant_id,id),CHECK(cardinality(source_ids)>=2 AND cardinality(source_ids)<=100)
);
ALTER TABLE order_merge_custody_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_merge_custody_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON order_merge_custody_transfers TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN EXECUTE format('CREATE POLICY custody_owner ON order_merge_custody_transfers TO %I USING(true) WITH CHECK(true)',current_user);END $$;
REVOKE ALL ON order_merge_custody_transfers FROM PUBLIC,dyna_app;
GRANT SELECT ON order_merge_custody_transfers TO dyna_app;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON order_merge_custody_transfers FOR EACH ROW EXECUTE FUNCTION order_merge_immutable();
CREATE TRIGGER bytes BEFORE INSERT ON order_merge_custody_transfers FOR EACH ROW EXECUTE FUNCTION order_merge_bytes();

CREATE OR REPLACE FUNCTION order_merge_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t uuid;v bigint;n bigint;p record;BEGIN
 t:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF t IS NULL THEN RAISE EXCEPTION 'Brak firmy dla historii łączenia' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('order.merge.proof:'||t::text,0));
 SELECT (SELECT coalesce(sum(byte_count),0) FROM order_merge_previews WHERE tenant_id=t)+
  (SELECT coalesce(sum(byte_count),0) FROM order_merge_preview_rows WHERE tenant_id=t)+
  (SELECT coalesce(sum(byte_count),0) FROM order_merge_executions WHERE tenant_id=t)+
  (SELECT coalesce(sum(byte_count),0) FROM order_merge_execution_rows WHERE tenant_id=t)+
  (SELECT coalesce(sum(byte_count),0) FROM order_merge_claims WHERE tenant_id=t)+
  (SELECT coalesce(sum(byte_count),0) FROM order_merge_origins WHERE tenant_id=t)+
  (SELECT coalesce(sum(byte_count),0) FROM order_merge_custody_transfers WHERE tenant_id=t) INTO v;
 IF v>134217728 THEN RAISE EXCEPTION 'Limit historii łączenia zamówień';END IF;
 SELECT count(*) INTO n FROM order_merge_previews WHERE tenant_id=t;IF n>2000 THEN RAISE EXCEPTION 'Limit podglądów łączenia zamówień';END IF;
 SELECT count(*) INTO n FROM order_merge_executions WHERE tenant_id=t;IF n>2000 THEN RAISE EXCEPTION 'Limit wykonań łączenia zamówień';END IF;
 IF TG_TABLE_NAME IN ('order_merge_previews','order_merge_preview_rows') THEN
  FOR p IN SELECT h.id,h.byte_count+coalesce(sum(r.byte_count),0) bytes FROM order_merge_previews h LEFT JOIN order_merge_preview_rows r ON(r.tenant_id,r.preview_id)=(h.tenant_id,h.id) WHERE h.tenant_id=t GROUP BY h.id LOOP
   IF p.bytes>8388608 THEN RAISE EXCEPTION 'Limit rozmiaru podglądu łączenia zamówień';END IF;
  END LOOP;
 END IF;RETURN NULL;END $$;
CREATE TRIGGER budget AFTER INSERT ON order_merge_custody_transfers FOR EACH STATEMENT EXECUTE FUNCTION order_merge_budget();
CREATE FUNCTION order_merge_custody_required() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM order_merge_custody_transfers x WHERE
  (x.tenant_id,x.execution_id,x.actor_id,x.source_ids,x.target_order_id,x.merge_mode,x.before_snapshot)=
  (NEW.tenant_id,NEW.id,NEW.actor_id,NEW.source_ids,NEW.target_order_id,NEW.merge_mode,NEW.before_snapshot->'custody')) THEN
  RAISE EXCEPTION 'Wykonanie wymaga autentycznego przeniesienia odpowiedzialności za towar' USING ERRCODE='23514';END IF;
 RETURN NULL;END $$;
REVOKE ALL ON FUNCTION order_merge_custody_required() FROM PUBLIC,dyna_app;
CREATE CONSTRAINT TRIGGER order_merge_custody_required AFTER INSERT ON order_merge_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_merge_custody_required();

CREATE FUNCTION order_merge_custody_snapshot(ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE t uuid;answer jsonb;BEGIN
 t:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF t IS NULL OR ids IS NULL OR cardinality(ids)<1 OR cardinality(ids)>101 OR array_position(ids,NULL) IS NOT NULL OR
    cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) OR
    (SELECT count(DISTINCT x) FROM unnest(ids) x)<>(SELECT count(*) FROM orders WHERE tenant_id=t AND id=ANY(ids))
 THEN RAISE EXCEPTION 'Brak własnego zakresu odpowiedzialności za towar' USING ERRCODE='23514';END IF;
 WITH pairs AS MATERIALIZED (
  SELECT DISTINCT tenant_id,warehouse_id,product_id FROM reservations WHERE tenant_id=t AND order_id=ANY(ids)
 ) SELECT jsonb_build_object(
  'reservations',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.order_id,r.product_id) FROM reservations r WHERE r.tenant_id=t AND r.order_id=ANY(ids)),'[]'::jsonb),
  'locations',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.order_id,r.product_id,r.location) FROM reservation_locations r WHERE r.tenant_id=t AND r.order_id=ANY(ids)),'[]'::jsonb),
  'layers',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.order_id,r.product_id,r.location,r.layer_id) FROM wms_reservation_layers r WHERE r.tenant_id=t AND r.order_id=ANY(ids)),'[]'::jsonb),
  'picks',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.order_id,r.product_id) FROM order_pick_items r WHERE r.tenant_id=t AND r.order_id=ANY(ids)),'[]'::jsonb),
  'stock',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('version',r.version::text) ORDER BY r.warehouse_id,r.product_id) FROM stock r JOIN pairs p USING(tenant_id,warehouse_id,product_id)),'[]'::jsonb),
  'bins',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.warehouse_id,r.product_id,r.location) FROM stock_locations r JOIN pairs p USING(tenant_id,warehouse_id,product_id)),'[]'::jsonb),
  'positions',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('version',r.version::text) ORDER BY r.warehouse_id,r.product_id,r.location,r.layer_id) FROM wms_layer_positions r JOIN pairs p USING(tenant_id,warehouse_id,product_id)),'[]'::jsonb)
 ) INTO answer;
 RETURN answer;END $$;
REVOKE ALL ON FUNCTION order_merge_custody_snapshot(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_merge_custody_snapshot(uuid[]) TO dyna_app;

-- The narrowly derived proof exists before the row changes. It is not a GUC bypass.
CREATE FUNCTION order_merge_custody_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;oid uuid;proof record;key text;expected jsonb;new_row jsonb;old_row jsonb;BEGIN
 new_row:=to_jsonb(NEW);old_row:=to_jsonb(OLD);
 t:=coalesce(NEW.tenant_id,OLD.tenant_id);oid:=coalesce(NEW.order_id,OLD.order_id);
 SELECT * INTO proof FROM order_merge_custody_transfers x WHERE x.tenant_id=t AND
  x.transaction_id=pg_current_xact_id() AND x.transaction_started_at=transaction_timestamp()
  AND (oid=x.target_order_id OR oid=ANY(x.source_ids));
 IF FOUND THEN
  key:=CASE TG_TABLE_NAME WHEN 'reservations' THEN 'reservations' WHEN 'reservation_locations' THEN 'locations' ELSE 'layers' END;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Przeniesienie nie usuwa historii rezerwacji' USING ERRCODE='23514';END IF;
  SELECT value INTO expected FROM jsonb_array_elements(proof.after_snapshot->key)
   WHERE (value->>'order_id')::uuid=NEW.order_id AND (value->>'product_id')::uuid=NEW.product_id
    AND (TG_TABLE_NAME='reservations' OR value->>'location'=new_row->>'location')
    AND (TG_TABLE_NAME<>'wms_reservation_layers' OR value->>'layer_id'=new_row->>'layer_id');
  IF expected IS NULL OR expected IS DISTINCT FROM to_jsonb(NEW) THEN
   RAISE EXCEPTION 'Zmiana rezerwacji nie odpowiada dowodowi przeniesienia' USING ERRCODE='23514';END IF;
 ELSE
  IF TG_TABLE_NAME IN ('reservations','wms_reservation_layers') AND
    (old_row->>'state'='transferred' OR new_row->>'state'='transferred') THEN
   RAISE EXCEPTION 'Przeniesiona rezerwacja jest niezmienna' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=t AND source_order_id=oid) THEN
   RAISE EXCEPTION 'Realizacja źródłowego zamówienia została przejęta' USING ERRCODE='23514';END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION order_merge_custody_row_guard() FROM PUBLIC,dyna_app;
CREATE TRIGGER order_merge_custody_guard BEFORE INSERT OR UPDATE OR DELETE ON reservations FOR EACH ROW EXECUTE FUNCTION order_merge_custody_row_guard();
CREATE TRIGGER order_merge_custody_guard BEFORE INSERT OR UPDATE OR DELETE ON reservation_locations FOR EACH ROW EXECUTE FUNCTION order_merge_custody_row_guard();
CREATE TRIGGER order_merge_custody_guard BEFORE INSERT OR UPDATE OR DELETE ON wms_reservation_layers FOR EACH ROW EXECUTE FUNCTION order_merge_custody_row_guard();

CREATE FUNCTION order_merge_custody_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_snapshot jsonb;e record;k text;prior_scope text;BEGIN
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 SELECT * INTO e FROM order_merge_executions WHERE (tenant_id,id)=(NEW.tenant_id,NEW.execution_id);
 IF NOT FOUND OR (NEW.actor_id,NEW.source_ids,NEW.target_order_id,NEW.merge_mode,NEW.before_snapshot) IS DISTINCT FROM
  (e.actor_id,e.source_ids,e.target_order_id,e.merge_mode,e.before_snapshot->'custody') THEN
  RAISE EXCEPTION 'Przeniesienie nie odpowiada wykonaniu' USING ERRCODE='23514';END IF;
 current_snapshot:=order_merge_custody_snapshot(ARRAY(SELECT DISTINCT x FROM unnest(NEW.source_ids||NEW.target_order_id) x));
 FOREACH k IN ARRAY ARRAY['reservations','locations','layers'] LOOP
  IF current_snapshot->k IS DISTINCT FROM NEW.after_snapshot->k THEN
   RAISE EXCEPTION 'Niepełne przeniesienie rezerwacji' USING ERRCODE='23514';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['stock','bins','positions'] LOOP
  IF current_snapshot->k IS DISTINCT FROM NEW.before_snapshot->k THEN
   RAISE EXCEPTION 'Przeniesienie zmieniło stan, lokalizacje lub warstwy WMS' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(
  WITH expected AS (SELECT product_id,sum(quantity)::bigint quantity,sum(scanned)::bigint scanned
   FROM jsonb_populate_recordset(NULL::order_pick_items,NEW.before_snapshot->'picks') GROUP BY product_id)
  SELECT 1 FROM expected a FULL JOIN (SELECT product_id,quantity,scanned FROM order_pick_items WHERE tenant_id=NEW.tenant_id AND order_id=NEW.target_order_id) b USING(product_id)
  WHERE (a.quantity,a.scanned) IS DISTINCT FROM (b.quantity::bigint,b.scanned::bigint)
 ) THEN RAISE EXCEPTION 'Docelowa kompletacja nie zachowuje ilości i skanów' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
REVOKE ALL ON FUNCTION order_merge_custody_complete() FROM PUBLIC,dyna_app;
CREATE CONSTRAINT TRIGGER order_merge_custody_complete AFTER INSERT ON order_merge_custody_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_merge_custody_complete();

CREATE FUNCTION order_merge_transfer_custody(p_execution uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid;e record;frozen jsonb;actual jsonb;planned jsonb;target uuid;k text;BEGIN
 t:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF t IS NULL THEN RAISE EXCEPTION 'Brak firmy' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM order_merge_executions WHERE (tenant_id,id)=(t,p_execution);
 IF NOT FOUND OR order_merge_current_role(e.actor_id,false) IS DISTINCT FROM 'admin' THEN
  RAISE EXCEPTION 'Brak własnego zatwierdzonego wykonania' USING ERRCODE='23514';END IF;
 target:=e.target_order_id;frozen:=e.before_snapshot->'custody';
 IF EXISTS(SELECT 1 FROM order_merge_custody_transfers WHERE (tenant_id,execution_id)=(t,p_execution)) THEN RETURN;END IF;
 IF jsonb_typeof(frozen) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=t AND source_order_id=ANY(e.source_ids)) THEN
  RAISE EXCEPTION 'Zakres realizacji już przejęty lub bez dowodu' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM order_merge_custody_transfers x WHERE x.tenant_id=t AND
   x.transaction_id=pg_current_xact_id() AND x.transaction_started_at=transaction_timestamp() AND
   (x.target_order_id=ANY(e.source_ids||target) OR x.source_ids && (e.source_ids||target))) THEN
  RAISE EXCEPTION 'Ten zakres ma już dowód przeniesienia w bieżącej transakcji' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM orders o JOIN orders dest ON dest.tenant_id=t AND dest.id=target
  WHERE o.tenant_id=t AND o.id=ANY(e.source_ids) AND (o.warehouse_id,o.currency,o.payment_mode) IS DISTINCT FROM (dest.warehouse_id,dest.currency,dest.payment_mode)) THEN
  RAISE EXCEPTION 'Scalanie wymaga wspólnego magazynu, waluty i sposobu płatności' USING ERRCODE='23514';END IF;
 PERFORM id FROM orders WHERE tenant_id=t AND id=ANY(e.source_ids||target) ORDER BY id FOR UPDATE;
 PERFORM s.product_id FROM stock s WHERE s.tenant_id=t AND EXISTS(SELECT 1 FROM reservations r WHERE r.tenant_id=t AND r.order_id=ANY(e.source_ids) AND (r.warehouse_id,r.product_id)=(s.warehouse_id,s.product_id)) ORDER BY s.warehouse_id,s.product_id FOR UPDATE;
 PERFORM product_id FROM reservations WHERE tenant_id=t AND order_id=ANY(e.source_ids||target) ORDER BY order_id,product_id FOR UPDATE;
 PERFORM product_id FROM reservation_locations WHERE tenant_id=t AND order_id=ANY(e.source_ids||target) ORDER BY order_id,product_id,location FOR UPDATE;
 PERFORM product_id FROM wms_reservation_layers WHERE tenant_id=t AND order_id=ANY(e.source_ids||target) ORDER BY order_id,product_id,location,layer_id FOR UPDATE;
 actual:=order_merge_custody_snapshot(e.source_ids);
 FOREACH k IN ARRAY ARRAY['reservations','locations','layers','stock','bins','positions'] LOOP
  IF actual->k IS DISTINCT FROM frozen->k THEN RAISE EXCEPTION 'Rezerwacje zmieniły się po podglądzie' USING ERRCODE='23514';END IF;
 END LOOP;
 IF (SELECT coalesce(jsonb_agg(value ORDER BY value->>'order_id',value->>'product_id'),'[]'::jsonb)
   FROM jsonb_array_elements(actual->'picks') WHERE (value->>'order_id')::uuid<>target) IS DISTINCT FROM
  (SELECT coalesce(jsonb_agg(value ORDER BY value->>'order_id',value->>'product_id'),'[]'::jsonb)
   FROM jsonb_array_elements(frozen->'picks') WHERE (value->>'order_id')::uuid<>target) THEN
  RAISE EXCEPTION 'Źródłowe skany zmieniły się po podglądzie' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM reservations WHERE tenant_id=t AND order_id=ANY(e.source_ids) AND state<>'active') OR
    EXISTS(SELECT 1 FROM wms_reservation_layers WHERE tenant_id=t AND order_id=ANY(e.source_ids) AND state<>'active') THEN
  RAISE EXCEPTION 'Scalanie wymaga aktywnych rezerwacji' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM reservations WHERE tenant_id=t AND order_id=target AND NOT target=ANY(e.source_ids)) OR
    EXISTS(SELECT 1 FROM reservation_locations WHERE tenant_id=t AND order_id=target AND NOT target=ANY(e.source_ids)) OR
    EXISTS(SELECT 1 FROM wms_reservation_layers WHERE tenant_id=t AND order_id=target AND NOT target=ANY(e.source_ids)) THEN
  RAISE EXCEPTION 'Nowy cel ma już własne rezerwacje' USING ERRCODE='23514';END IF;
 IF EXISTS(
  SELECT 1 FROM jsonb_populate_recordset(NULL::order_pick_items,frozen->'picks') i FULL JOIN
   jsonb_populate_recordset(NULL::reservations,frozen->'reservations') r USING(tenant_id,order_id,product_id)
   WHERE i.quantity IS DISTINCT FROM r.quantity OR r.state IS DISTINCT FROM 'active'
 ) THEN RAISE EXCEPTION 'Niepełne źródłowe rezerwacje' USING ERRCODE='23514';END IF;
 SELECT jsonb_build_object(
  'reservations',(WITH original AS (SELECT * FROM jsonb_populate_recordset(NULL::reservations,frozen->'reservations')),
   rows AS (SELECT to_jsonb(r)||jsonb_build_object('state','transferred') row FROM original r WHERE order_id<>target UNION ALL
    SELECT jsonb_build_object('tenant_id',t,'order_id',target,'product_id',product_id,'warehouse_id',warehouse_id,'quantity',sum(quantity),'state','active') FROM original GROUP BY product_id,warehouse_id)
   SELECT coalesce(jsonb_agg(row ORDER BY row->>'order_id',row->>'product_id'),'[]'::jsonb) FROM rows),
  'locations',(WITH original AS (SELECT * FROM jsonb_populate_recordset(NULL::reservation_locations,frozen->'locations')),
   rows AS (SELECT to_jsonb(r) row FROM original r WHERE order_id<>target UNION ALL
    SELECT jsonb_build_object('tenant_id',t,'order_id',target,'product_id',product_id,'warehouse_id',warehouse_id,'location',location,'quantity',sum(quantity),'scanned',sum(scanned)) FROM original GROUP BY product_id,warehouse_id,location)
   SELECT coalesce(jsonb_agg(row ORDER BY row->>'order_id',row->>'product_id',row->>'location'),'[]'::jsonb) FROM rows),
  'layers',(WITH original AS (SELECT * FROM jsonb_populate_recordset(NULL::wms_reservation_layers,frozen->'layers')),
   rows AS (SELECT to_jsonb(r)||jsonb_build_object('state','transferred') row FROM original r WHERE order_id<>target UNION ALL
    SELECT jsonb_build_object('tenant_id',t,'order_id',target,'product_id',product_id,'warehouse_id',warehouse_id,'location',location,'layer_id',layer_id,'quantity',sum(quantity),'scanned',sum(scanned),'state','active') FROM original GROUP BY product_id,warehouse_id,location,layer_id)
   SELECT coalesce(jsonb_agg(row ORDER BY row->>'order_id',row->>'product_id',row->>'location',row->>'layer_id'),'[]'::jsonb) FROM rows)
 ) INTO planned;
 SET CONSTRAINTS order_merge_custody_complete DEFERRED;
 INSERT INTO order_merge_custody_transfers(tenant_id,execution_id,actor_id,source_ids,target_order_id,merge_mode,transaction_id,transaction_started_at,before_snapshot,after_snapshot)
  VALUES(t,e.id,e.actor_id,e.source_ids,target,e.merge_mode,pg_current_xact_id(),transaction_timestamp(),frozen,planned);
 UPDATE reservations SET state='transferred' WHERE tenant_id=t AND order_id=ANY(e.source_ids) AND order_id<>target;
 INSERT INTO reservations SELECT * FROM jsonb_populate_recordset(NULL::reservations,planned->'reservations') WHERE order_id=target
  ON CONFLICT(tenant_id,order_id,product_id) DO UPDATE SET quantity=excluded.quantity,state=excluded.state;
 INSERT INTO reservation_locations SELECT * FROM jsonb_populate_recordset(NULL::reservation_locations,planned->'locations') WHERE order_id=target
  ON CONFLICT(tenant_id,order_id,product_id,location) DO UPDATE SET quantity=excluded.quantity,scanned=excluded.scanned;
 UPDATE wms_reservation_layers SET state='transferred' WHERE tenant_id=t AND order_id=ANY(e.source_ids) AND order_id<>target;
 INSERT INTO wms_reservation_layers SELECT * FROM jsonb_populate_recordset(NULL::wms_reservation_layers,planned->'layers') WHERE order_id=target
  ON CONFLICT(tenant_id,order_id,product_id,warehouse_id,location,layer_id) DO UPDATE SET quantity=excluded.quantity,scanned=excluded.scanned;
 SET CONSTRAINTS order_merge_custody_complete IMMEDIATE;
END $$;
REVOKE ALL ON FUNCTION order_merge_transfer_custody(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_merge_transfer_custody(uuid) TO dyna_app;

-- A flush at SET CONSTRAINTS IMMEDIATE does not permit subsequent same-TX drift.
-- The timestamp distinguishes a historical restored xid from this transaction.
CREATE FUNCTION order_merge_custody_physical_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row_data jsonb;old_data jsonb;BEGIN
 row_data:=to_jsonb(NEW);old_data:=to_jsonb(OLD);
 IF TG_TABLE_NAME='order_pick_items' THEN
  IF EXISTS(SELECT 1 FROM order_merge_custody_transfers x WHERE
    x.tenant_id=coalesce(NEW.tenant_id,OLD.tenant_id) AND x.transaction_id=pg_current_xact_id() AND
    x.transaction_started_at=transaction_timestamp() AND
    (coalesce(NEW.order_id,OLD.order_id)=x.target_order_id OR coalesce(NEW.order_id,OLD.order_id)=ANY(x.source_ids))) OR
   EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=coalesce(NEW.tenant_id,OLD.tenant_id) AND source_order_id=coalesce(NEW.order_id,OLD.order_id)) THEN
   RAISE EXCEPTION 'Scalanie zamknęło źródłową kompletację i bieżący dowód ilości' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM order_merge_custody_transfers x CROSS JOIN LATERAL jsonb_array_elements(x.before_snapshot->'stock') s WHERE
   x.transaction_id=pg_current_xact_id() AND x.transaction_started_at=transaction_timestamp() AND
   ((x.tenant_id,s->>'warehouse_id',s->>'product_id')=(NEW.tenant_id,row_data->>'warehouse_id',row_data->>'product_id') OR
    (x.tenant_id,s->>'warehouse_id',s->>'product_id')=(OLD.tenant_id,old_data->>'warehouse_id',old_data->>'product_id'))) THEN
   RAISE EXCEPTION 'Przeniesienie rezerwacji nie pozwala zmienić zapasu, warstw ani księgi' USING ERRCODE='23514';END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION order_merge_custody_physical_guard() FROM PUBLIC,dyna_app;
DO $$ DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['stock','stock_locations','wms_layer_positions','stock_movements','stock_location_movements','wms_layer_movements','order_pick_items'] LOOP
 EXECUTE format('CREATE TRIGGER order_merge_custody_physical_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_merge_custody_physical_guard()',tab);
END LOOP;END $$;

-- Preserve every original 090 check outside the narrowly authorized target row.
CREATE OR REPLACE FUNCTION wms_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l record;op record;f record;p record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Historia WMS jest nieusuwalna' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME NOT IN ('wms_layer_positions','wms_reservation_layers') THEN RAISE EXCEPTION 'Dowód WMS jest niezmienny' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='wms_layer_positions' THEN
   IF (NEW.tenant_id,NEW.warehouse_id,NEW.product_id,NEW.location,NEW.layer_id) IS DISTINCT FROM
      (OLD.tenant_id,OLD.warehouse_id,OLD.product_id,OLD.location,OLD.layer_id) OR NEW.version::numeric<>OLD.version::numeric+1
   THEN RAISE EXCEPTION 'Nieprawidłowa rewizja pozycji WMS' USING ERRCODE='23514';END IF;
  ELSE
   -- Only the exact target row in this current transaction's immutable transfer.
   IF EXISTS(SELECT 1 FROM order_merge_custody_transfers x WHERE
     x.tenant_id=NEW.tenant_id AND x.target_order_id=NEW.order_id AND
     x.transaction_id=pg_current_xact_id() AND x.transaction_started_at=transaction_timestamp() AND
     x.after_snapshot->'layers' @> jsonb_build_array(to_jsonb(NEW)))
   THEN RETURN NEW;END IF;
   IF (NEW.tenant_id,NEW.order_id,NEW.product_id,NEW.warehouse_id,NEW.location,NEW.layer_id,NEW.quantity) IS DISTINCT FROM
      (OLD.tenant_id,OLD.order_id,OLD.product_id,OLD.warehouse_id,OLD.location,OLD.layer_id,OLD.quantity) OR
      OLD.state<>'active' OR NEW.scanned<OLD.scanned OR (NEW.state<>'active' AND NEW.scanned<>OLD.scanned)
   THEN RAISE EXCEPTION 'Nieprawidłowa zmiana przypisania WMS' USING ERRCODE='23514';END IF;
  END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME IN ('wms_layer_movements','wms_issue_fragments','wms_return_fragments') THEN
  SELECT * INTO l FROM wms_cost_layers WHERE (tenant_id,id,product_id)=(NEW.tenant_id,NEW.layer_id,NEW.product_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Brak własnej warstwy WMS' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='wms_layer_movements' THEN
   IF (l.unit_cost_minor IS NULL AND NEW.value_delta IS NOT NULL) OR (l.unit_cost_minor IS NOT NULL AND
      (NEW.value_delta IS NULL OR NEW.value_delta::numeric<>NEW.delta::numeric*l.unit_cost_minor))
   THEN RAISE EXCEPTION 'Ruch ma inny koszt niż warstwa' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='wms_issue_fragments' THEN
   IF (NEW.unit_cost_minor,NEW.currency) IS DISTINCT FROM (l.unit_cost_minor,l.currency)
   THEN RAISE EXCEPTION 'Wydanie ma inny koszt niż warstwa' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO f FROM wms_issue_fragments WHERE (tenant_id,id,order_id,product_id,layer_id)=
     (NEW.tenant_id,NEW.issue_fragment_id,NEW.order_id,NEW.product_id,NEW.layer_id);
   IF NOT FOUND OR NEW.value_minor IS DISTINCT FROM
      (CASE WHEN f.unit_cost_minor IS NULL THEN NULL ELSE NEW.quantity::bigint*f.unit_cost_minor END)
   THEN RAISE EXCEPTION 'Zwrot nie odtwarza kosztu wydania' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='wms_cost_layers' THEN
  SELECT * INTO p FROM wms_lots WHERE (tenant_id,id,product_id)=(NEW.tenant_id,NEW.lot_id,NEW.product_id);
  IF p.origin NOT IN ('opening','legacy_return') AND NEW.unit_cost_minor IS NULL
  THEN RAISE EXCEPTION 'Nowa dostawa wymaga znanego kosztu' USING ERRCODE='23514';END IF;
  IF NEW.purchase_receipt_id IS NOT NULL THEN
   SELECT po.currency,pl.unit_cost,rl.quantity,pr.document_id INTO f FROM purchase_receipt_lines rl
   JOIN purchase_receipts pr ON (pr.tenant_id,pr.id)=(rl.tenant_id,rl.receipt_id)
   JOIN purchase_orders po ON (po.tenant_id,po.id)=(rl.tenant_id,rl.order_id)
   JOIN purchase_order_lines pl ON (pl.tenant_id,pl.order_id,pl.product_id)=(rl.tenant_id,rl.order_id,rl.product_id)
   WHERE (rl.tenant_id,rl.receipt_id,rl.product_id)=(NEW.tenant_id,NEW.purchase_receipt_id,NEW.product_id);
   IF NOT FOUND OR (NEW.currency,NEW.unit_cost_minor,NEW.warehouse_document_id) IS DISTINCT FROM
      (f.currency,f.unit_cost::bigint,f.document_id)
   THEN RAISE EXCEPTION 'Koszt nie odpowiada rzeczywistemu przyjęciu PO' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;END $$;
