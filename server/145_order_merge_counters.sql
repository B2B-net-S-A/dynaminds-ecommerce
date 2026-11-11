-- Additive repair of104 after134/137 added immutable reservation counters.
-- No table/row backfill, counter reset, stock movement or historical proof rewrite.
CREATE OR REPLACE FUNCTION order_merge_transfer_custody(p_execution uuid) RETURNS void
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
 -- Whole-order custody cannot erase or duplicate an accepted parcel allocation.
 IF EXISTS(SELECT 1 FROM order_parcel_plans WHERE tenant_id=t AND order_id=ANY(e.source_ids||target)) OR
    EXISTS(SELECT 1 FROM reservations WHERE tenant_id=t AND order_id=ANY(e.source_ids||target) AND(consumed_quantity<>0 OR released_quantity<>0)) OR
    EXISTS(SELECT 1 FROM reservation_locations WHERE tenant_id=t AND order_id=ANY(e.source_ids||target) AND(consumed_quantity<>0 OR released_quantity<>0)) OR
    EXISTS(SELECT 1 FROM wms_reservation_layers WHERE tenant_id=t AND order_id=ANY(e.source_ids||target) AND(consumed_quantity<>0 OR released_quantity<>0)) THEN
  RAISE EXCEPTION 'Scalanie wymaga pierwotnych rezerwacji bez wydania, zwolnienia i planu paczek' USING ERRCODE='23514';END IF;
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
    SELECT jsonb_build_object('tenant_id',t,'order_id',target,'product_id',product_id,'warehouse_id',warehouse_id,'quantity',sum(quantity),'state','active','consumed_quantity',sum(consumed_quantity),'released_quantity',sum(released_quantity)) FROM original GROUP BY product_id,warehouse_id)
   SELECT coalesce(jsonb_agg(row ORDER BY row->>'order_id',row->>'product_id'),'[]'::jsonb) FROM rows),
  'locations',(WITH original AS (SELECT * FROM jsonb_populate_recordset(NULL::reservation_locations,frozen->'locations')),
   rows AS (SELECT to_jsonb(r) row FROM original r WHERE order_id<>target UNION ALL
    SELECT jsonb_build_object('tenant_id',t,'order_id',target,'product_id',product_id,'warehouse_id',warehouse_id,'location',location,'quantity',sum(quantity),'scanned',sum(scanned),'consumed_quantity',sum(consumed_quantity),'released_quantity',sum(released_quantity)) FROM original GROUP BY product_id,warehouse_id,location)
   SELECT coalesce(jsonb_agg(row ORDER BY row->>'order_id',row->>'product_id',row->>'location'),'[]'::jsonb) FROM rows),
  'layers',(WITH original AS (SELECT * FROM jsonb_populate_recordset(NULL::wms_reservation_layers,frozen->'layers')),
   rows AS (SELECT to_jsonb(r)||jsonb_build_object('state','transferred') row FROM original r WHERE order_id<>target UNION ALL
    SELECT jsonb_build_object('tenant_id',t,'order_id',target,'product_id',product_id,'warehouse_id',warehouse_id,'location',location,'layer_id',layer_id,'quantity',sum(quantity),'scanned',sum(scanned),'state','active','consumed_quantity',sum(consumed_quantity),'released_quantity',sum(released_quantity)) FROM original GROUP BY product_id,warehouse_id,location,layer_id)
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
-- CREATE OR REPLACE preserves the original OID, owner, grants and dependencies.
