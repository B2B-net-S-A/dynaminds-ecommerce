-- Avoid collision with orders.total during deferred parcel completion.
-- Existing rows, receipts and original reservation quantities are unchanged.
CREATE OR REPLACE FUNCTION order_parcel_installed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM migrations WHERE name='134_order_parcels')
 AND EXISTS(SELECT 1 FROM migrations WHERE name='135_order_parcel_completion_fix')
$$;
CREATE OR REPLACE FUNCTION order_parcel_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=NEW.tenant_id;oid uuid:=NEW.order_id;p order_parcel_plans;d record;parcel_total integer;issued integer;BEGIN
 SELECT * INTO p FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid;
 IF TG_TABLE_NAME='order_parcel_previews' THEN PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM order_parcel_budget();RETURN NULL;END IF;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Niekompletny plan paczek' USING ERRCODE='23514';END IF;
 parcel_total:=jsonb_array_length(p.payload->'parcels');
 IF(SELECT count(*) FROM order_parcel_allocations WHERE tenant_id=t AND plan_id=p.id)<>parcel_total OR EXISTS(SELECT 1 FROM order_parcel_allocations x JOIN shipments s ON(s.tenant_id,s.id,s.order_id)=(x.tenant_id,x.shipment_id,x.order_id) WHERE x.tenant_id=t AND x.plan_id=p.id AND(x.payload IS DISTINCT FROM p.payload->'parcels'->x.index OR(s.carrier,s.mode,s.tracking_number,s.cod_expected) IS DISTINCT FROM(x.payload->>'carrier',x.payload->>'mode',x.payload->>'tracking_number',(x.payload->>'cod_minor')::integer))) THEN RAISE EXCEPTION 'Graf przydziału paczek nie jest kompletny' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO issued FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=p.id;
 IF NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=t AND id=oid AND status=CASE WHEN issued=parcel_total THEN 'shipped' ELSE 'packed' END) OR EXISTS(SELECT 1 FROM order_parcel_allocations l JOIN shipments s ON(s.tenant_id,s.id)=(l.tenant_id,l.shipment_id) WHERE l.tenant_id=t AND l.plan_id=p.id AND(s.dispatched_at IS NOT NULL) IS DISTINCT FROM EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND plan_id=p.id AND parcel_index=l.index)) THEN RAISE EXCEPTION 'Stan zamówienia nie odpowiada wydanym paczkom' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM reservations r LEFT JOIN LATERAL(SELECT coalesce(sum((pr->>'quantity')::integer),0) q FROM order_parcel_dispatches dd JOIN order_parcel_allocations l ON(l.tenant_id,l.plan_id,l.index)=(dd.tenant_id,dd.plan_id,dd.parcel_index) CROSS JOIN LATERAL jsonb_array_elements(l.payload->'products') pr WHERE dd.tenant_id=t AND dd.plan_id=p.id AND pr->>'product_id'=r.product_id::text) sums ON true WHERE r.tenant_id=t AND r.order_id=oid AND(r.consumed_quantity<>sums.q OR r.state<>CASE WHEN r.quantity=sums.q THEN 'consumed' ELSE 'active' END)) THEN RAISE EXCEPTION 'Rezerwacja nie odpowiada sumie rzeczywistych wydań' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='order_parcel_admissions' THEN
  IF NEW.kind='dispatch' AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=t AND id=NEW.operation_id) THEN RAISE EXCEPTION 'Zgoda wydania nie ma trwałego wyniku' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);PERFORM order_parcel_budget();RETURN NULL;
END $$;

-- Resolve admission-only fields only for the admission relation.
CREATE OR REPLACE FUNCTION order_parcel_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a order_parcel_admissions;p order_parcel_previews;pl order_parcel_plans;f jsonb;BEGIN
 IF TG_OP='INSERT' THEN PERFORM pg_advisory_xact_lock(hashtextextended('order.parcels.quota:'||NEW.tenant_id::text,0));END IF;
 IF TG_OP<>'INSERT' THEN
  IF TG_TABLE_NAME='order_parcel_admissions' AND TG_OP='UPDATE' THEN
   IF pg_trigger_depth()>=2 AND OLD.kind='dispatch' AND OLD.transaction_id=pg_current_xact_id() AND NOT EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=OLD.tenant_id AND id=OLD.operation_id) AND(to_jsonb(NEW)-'payload')=(to_jsonb(OLD)-'payload') AND(NEW.payload-'witnesses')=(OLD.payload-'witnesses') AND jsonb_array_length(NEW.payload->'witnesses')=coalesce(jsonb_array_length(OLD.payload->'witnesses'),0)+1 AND NEW.payload->'witnesses' @> coalesce(OLD.payload->'witnesses','[]') THEN RETURN NEW;END IF;
  END IF;
  RAISE EXCEPTION 'Dowód przydziału paczek jest niezmienny' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='order_parcel_previews' THEN
  PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);f:=order_parcel_frame(NEW.id,NEW.order_id,NEW.request,NEW.actor_id,NEW.api_key_id);
  IF NEW.payload IS DISTINCT FROM f OR NEW.scope_hash IS DISTINCT FROM order_parcel_hash(f) OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM order_parcel_hash(jsonb_build_object('tenant_id',NEW.tenant_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'kind','preview','order_id',NEW.order_id,'request',NEW.request)) THEN RAISE EXCEPTION 'Podgląd nie odpowiada źródłu paczek' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_parcel_admissions' THEN
  IF NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.opened_at>clock_timestamp() OR NEW.payload?'witnesses' THEN RAISE EXCEPTION 'Niepoprawna transakcja paczek' USING ERRCODE='23514';END IF;
  PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);
  IF NEW.before_snapshot IS DISTINCT FROM order_parcel_snapshot(NEW.order_id) THEN RAISE EXCEPTION 'Zgoda wymaga rzeczywistych bieżących rezerwacji' USING ERRCODE='23514';END IF;
  IF NEW.kind='apply' THEN
   SELECT * INTO p FROM order_parcel_previews WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND actor_id=NEW.actor_id AND api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND payload=NEW.payload AND scope_hash=NEW.scope_hash AND expires_at>clock_timestamp();
   IF p.id IS NULL OR NEW.operation_id IS DISTINCT FROM NEW.plan_id OR NEW.parcel_index IS NOT NULL OR NEW.payload IS DISTINCT FROM order_parcel_frame(p.id,p.order_id,p.request,NEW.actor_id,NEW.api_key_id) THEN RAISE EXCEPTION 'Zgoda planu wymaga pełnego aktualnego podglądu' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO pl FROM order_parcel_plans WHERE tenant_id=NEW.tenant_id AND id=NEW.plan_id AND order_id=NEW.order_id;
   IF pl.id IS NULL OR NEW.scope_hash IS DISTINCT FROM pl.scope_hash OR NEW.payload->'parcel' IS DISTINCT FROM pl.payload->'parcels'->NEW.parcel_index OR NEW.payload->'request'->>'scope_hash' IS DISTINCT FROM pl.scope_hash OR NEW.payload->'request'->'confirmed' IS DISTINCT FROM 'true'::jsonb OR NEW.payload->>'request_hash' IS DISTINCT FROM order_parcel_hash(jsonb_build_object('tenant_id',NEW.tenant_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'kind','dispatch','plan_id',NEW.plan_id,'index',NEW.parcel_index,'request',NEW.payload->'request')) OR NOT EXISTS(SELECT 1 FROM orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id AND status='packed') OR EXISTS(SELECT 1 FROM order_parcel_dispatches WHERE tenant_id=NEW.tenant_id AND plan_id=NEW.plan_id AND parcel_index=NEW.parcel_index) THEN RAISE EXCEPTION 'Zgoda wydania nie odpowiada istniejącej paczce planu' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='order_parcel_plans' THEN
  SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND operation_id=NEW.id AND kind='apply';
  SELECT * INTO p FROM order_parcel_previews WHERE tenant_id=NEW.tenant_id AND id=NEW.preview_id;
  IF a.operation_id IS NULL OR p.id IS NULL OR(NEW.order_id,NEW.actor_id,NEW.api_key_id,NEW.scope_hash,NEW.payload) IS DISTINCT FROM(p.order_id,p.actor_id,p.api_key_id,p.scope_hash,p.payload) OR NEW.payload IS DISTINCT FROM a.payload OR NEW.request->>'scope_hash' IS DISTINCT FROM p.scope_hash OR NEW.request->'confirmed' IS DISTINCT FROM 'true'::jsonb OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM order_parcel_hash(jsonb_build_object('tenant_id',NEW.tenant_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'kind','apply','preview_id',NEW.preview_id,'request',NEW.request)) THEN RAISE EXCEPTION 'Plan nie odpowiada przyjętej zgodzie' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='order_parcel_allocations' THEN
  SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND plan_id=NEW.plan_id AND kind='apply';
  IF a.operation_id IS NULL OR NEW.order_id IS DISTINCT FROM a.order_id OR NEW.payload IS DISTINCT FROM a.payload->'parcels'->NEW.index OR NEW.shipment_id IS DISTINCT FROM(NEW.payload->>'shipment_id')::uuid THEN RAISE EXCEPTION 'Paczka nie odpowiada planowi' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO a FROM order_parcel_admissions WHERE tenant_id=NEW.tenant_id AND transaction_id=pg_current_xact_id() AND operation_id=NEW.id AND kind='dispatch';
  IF a.operation_id IS NULL OR(NEW.plan_id,NEW.order_id,NEW.parcel_index,NEW.actor_id,NEW.api_key_id,NEW.scope_hash,NEW.request,NEW.before_snapshot) IS DISTINCT FROM(a.plan_id,a.order_id,a.parcel_index,a.actor_id,a.api_key_id,a.scope_hash,a.payload->'request',a.before_snapshot) OR NEW.after_snapshot IS DISTINCT FROM order_parcel_snapshot(a.order_id) OR NEW.request_hash IS DISTINCT FROM a.payload->>'request_hash' OR NEW.shipment_id IS DISTINCT FROM(a.payload->'parcel'->>'shipment_id')::uuid OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid THEN RAISE EXCEPTION 'Niepoprawny dowód wydania paczki' USING ERRCODE='23514';END IF;
  PERFORM order_parcel_validate_dispatch(a,NEW.after_snapshot,NEW.receipt);
  IF (SELECT coalesce(jsonb_agg(jsonb_build_object('table',facts.tab,'id',facts.id) ORDER BY facts.tab COLLATE "C",facts.id),'[]') FROM(SELECT 'stock_movements' tab,value->>'id' id FROM jsonb_array_elements(NEW.receipt->'stock_movements') UNION ALL SELECT 'stock_location_movements',value->>'id' FROM jsonb_array_elements(NEW.receipt->'location_movements') UNION ALL SELECT 'wms_issue_fragments',value#>>'{}' FROM jsonb_array_elements(coalesce(NEW.receipt->'wms'->'fragment_ids','[]'))) facts) IS DISTINCT FROM(SELECT coalesce(jsonb_agg(value ORDER BY value->>'table' COLLATE "C",value->>'id'),'[]') FROM jsonb_array_elements(a.payload->'witnesses')) THEN RAISE EXCEPTION 'Wydanie wymaga dokładnej bijekcji świeżych rzeczywistych ruchów' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
