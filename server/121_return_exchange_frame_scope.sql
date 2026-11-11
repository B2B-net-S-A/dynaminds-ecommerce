-- Repair the frame's SQL alias collision with its PL/pgSQL receipt-item record.
-- Preserve the complete 120 frame, its locks, predicates, snapshot and scope hash.
CREATE OR REPLACE FUNCTION return_exchange_frame(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; r return_cases%ROWTYPE;o orders%ROWTYPE;
 g jsonb;ri record;decision jsonb;recipe jsonb;rows_json jsonb:='[]';stocks jsonb:='[]';physical jsonb;doc jsonb;scope text;
 p record;returnqty bigint;replaceqty bigint;st stock%ROWTYPE;policy jsonb;countqty bigint;component record;BEGIN
 g:=return_exchange_access(uid,kid,false);
 IF g->>'allowed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('return.exchange:'||t::text,0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||t::text,0));
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(t,rid);
 IF r.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono reklamacji' USING ERRCODE='P0002';END IF;
 SELECT * INTO o FROM orders WHERE(tenant_id,id)=(t,r.order_id) FOR UPDATE;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(t,rid) FOR UPDATE;
 IF r.kind<>'complaint' OR r.legacy OR r.state<>'requested' OR r.receipt IS NOT NULL OR r.remedy<>'refund'
 OR r.version IS DISTINCT FROM(body->>'version')::bigint OR r.requested_shipping<>0 OR o.fulfillment_kind<>'sale'
 OR o.source NOT IN('manual','demo') OR o.channel_id IS NOT NULL OR o.external_id IS NOT NULL
 OR to_jsonb(o)->'source_snapshot' IS NOT NULL AND to_jsonb(o)->'source_snapshot'<>'null'
 OR EXISTS(SELECT 1 FROM b2b_dropship_orders d WHERE(d.tenant_id,d.customer_order_id)=(t,o.id))
 OR EXISTS(SELECT 1 FROM b2b_dropship_orders d WHERE(d.supplier_tenant_id,d.supplier_order_id)=(t,o.id))
 OR EXISTS(SELECT 1 FROM b2b_external_order_intents WHERE(tenant_id,order_id)=(t,o.id))
 OR EXISTS(SELECT 1 FROM b2b_dropship_return_cases WHERE(tenant_id,return_id)=(t,rid))
 OR EXISTS(SELECT 1 FROM b2b_dropship_return_supplier_cases WHERE(tenant_id,return_id)=(t,rid))
 OR EXISTS(SELECT 1 FROM b2b_return_local_origins WHERE(tenant_id,return_id)=(t,rid))
 OR EXISTS(SELECT 1 FROM order_merge_claims WHERE tenant_id=t AND(source_order_id=o.id OR target_order_id=o.id))
 OR body ? 'origin_id' THEN RAISE EXCEPTION 'Wymiana wymaga niepowiązanej lokalnej reklamacji bez zwrotu dostawy' USING ERRCODE='P0001';END IF;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR body-ARRAY['version','warehouse_id','note','items','wms_lots']<>'{}'
 OR jsonb_typeof(body->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'items') NOT BETWEEN 1 AND 100
 OR length(body->>'note') NOT BETWEEN 3 AND 2000 OR NOT EXISTS(SELECT 1 FROM warehouses WHERE(tenant_id,id)=(t,(body->>'warehouse_id')::uuid))
 OR jsonb_array_length(body->'items')<>(SELECT count(*) FROM return_items WHERE(tenant_id,return_id)=(t,rid))
 OR (SELECT count(DISTINCT value->>'item_id') FROM jsonb_array_elements(body->'items'))<>jsonb_array_length(body->'items')
 THEN RAISE EXCEPTION 'Niepełna zgoda na wymianę' USING ERRCODE='P0001';END IF;
 PERFORM 1 FROM products WHERE tenant_id=t AND id IN(SELECT oi.product_id FROM order_items oi JOIN return_items rq
 ON(rq.tenant_id,rq.order_id,rq.item_id)=(oi.tenant_id,oi.order_id,oi.id) WHERE(rq.tenant_id,rq.return_id)=(t,rid)) ORDER BY id FOR SHARE;
 countqty:=0;
 FOR ri IN SELECT l.*,oi.product_id,oi.vat,oi.quantity original_quantity FROM return_items l JOIN order_items oi
 ON(oi.tenant_id,oi.order_id,oi.id)=(l.tenant_id,l.order_id,l.item_id) WHERE(l.tenant_id,l.return_id)=(t,rid) ORDER BY l.item_id LOOP
  SELECT value INTO decision FROM jsonb_array_elements(body->'items') WHERE value->>'item_id'=ri.item_id::text;
  IF decision IS NULL OR decision-ARRAY['item_id','accepted','restocked']<>'{}'
  OR decision->>'accepted' !~ '^(0|[1-9][0-9]{0,5})$' OR decision->>'restocked' !~ '^(0|[1-9][0-9]{0,5})$'
  OR (decision->>'accepted')::int>ri.requested OR (decision->>'restocked')::int>(decision->>'accepted')::int
  OR (decision->>'accepted')::int+(SELECT coalesce(sum(l.accepted),0) FROM return_items l JOIN return_cases rr
   ON(rr.tenant_id,rr.id)=(l.tenant_id,l.return_id) WHERE(l.tenant_id,l.order_id,l.item_id)=(t,o.id,ri.item_id)
    AND rr.id<>rid AND rr.state IN('refund_pending','closed'))>ri.original_quantity
  THEN RAISE EXCEPTION 'Ilości wymiany przekraczają zgłoszenie lub pozostałą sprzedaż' USING ERRCODE='P0001';END IF;
  SELECT * INTO p FROM products WHERE(tenant_id,id)=(t,ri.product_id);
  recipe:=CASE WHEN p.kind='bundle' THEN(SELECT jsonb_agg(jsonb_build_object('product_id',bc.product_id,'quantity',bc.quantity) ORDER BY bc.product_id)
    FROM bundle_components bc WHERE(bc.tenant_id,bc.bundle_id)=(t,p.id)) ELSE jsonb_build_array(jsonb_build_object('product_id',p.id,'quantity',1)) END;
  IF NOT p.active OR p.kind NOT IN('simple','variant','bundle') OR recipe IS NULL
    OR (SELECT jsonb_agg(value ORDER BY value->>'product_id') FROM jsonb_array_elements(ri.components)) IS DISTINCT FROM recipe
  THEN RAISE EXCEPTION 'Produkt lub receptura zmieniły się od pierwotnej sprzedaży' USING ERRCODE='P0001';END IF;
  countqty:=countqty+(decision->>'accepted')::int;
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('item_id',ri.item_id,'product_id',ri.product_id,
    'sku',ri.sku,'name',ri.name,'vat',ri.vat,'accepted',(decision->>'accepted')::int,'restocked',(decision->>'restocked')::int,'components',recipe));
 END LOOP;
 IF countqty=0 THEN RAISE EXCEPTION 'Wymiana wymaga przyjęcia przynajmniej jednej sztuki' USING ERRCODE='P0001';END IF;
 physical:=return_exchange_snapshot(rid,(body->>'warehouse_id')::uuid);
 FOR component IN SELECT (part->>'product_id')::uuid product_id,sum((row_json->>'accepted')::bigint*(part->>'quantity')::bigint) replacement_quantity,
  sum((row_json->>'restocked')::bigint*(part->>'quantity')::bigint) return_quantity
  FROM jsonb_array_elements(rows_json) row_json CROSS JOIN LATERAL jsonb_array_elements(row_json->'components') part GROUP BY 1 ORDER BY 1 LOOP
  SELECT * INTO p FROM products WHERE(tenant_id,id)=(t,component.product_id) FOR SHARE;
  IF p.id IS NULL OR NOT p.active OR p.kind NOT IN('simple','variant') THEN RAISE EXCEPTION 'Składnik nie jest aktywnym produktem fizycznym' USING ERRCODE='P0001';END IF;
  PERFORM 1 FROM stock WHERE tenant_id=t AND product_id=component.product_id AND warehouse_id IN(r.warehouse_id,(body->>'warehouse_id')::uuid) ORDER BY warehouse_id FOR UPDATE;
  SELECT * INTO st FROM stock WHERE(tenant_id,warehouse_id,product_id)=(t,(body->>'warehouse_id')::uuid,component.product_id);
  returnqty:=CASE WHEN r.warehouse_id=(body->>'warehouse_id')::uuid THEN component.return_quantity ELSE 0 END;
  replaceqty:=component.replacement_quantity;
  IF replaceqty>10000000 OR coalesce(st.on_hand,0)::bigint+returnqty>2147483647
   OR coalesce(st.on_hand,0)::bigint-coalesce(st.reserved,0)+returnqty<replaceqty THEN RAISE EXCEPTION 'Za mało własnego towaru do wymiany' USING ERRCODE='P0001';END IF;
  stocks:=stocks||jsonb_build_array(jsonb_build_object('product_id',p.id,'sku',p.sku,'on_hand',coalesce(st.on_hand,0),
   'reserved',coalesce(st.reserved,0),'available',coalesce(st.available,0),'version',st.version::text,
   'return_quantity',returnqty,'replacement_quantity',replaceqty,'after_on_hand',coalesce(st.on_hand,0)+returnqty,
   'after_reserved',coalesce(st.reserved,0)+replaceqty,'after_available',coalesce(st.available,0)+returnqty-replaceqty));
 END LOOP;
 SELECT jsonb_build_object('enabled',coalesce(w.enabled,false),'version',coalesce(w.version,0)::text) INTO policy FROM tenants tt LEFT JOIN wms_policies w ON w.tenant_id=tt.id WHERE tt.id=t;
 IF (policy->>'enabled')::boolean AND EXISTS(SELECT 1 FROM jsonb_array_elements(rows_json) x WHERE(x->>'restocked')::int>0) AND NOT body ? 'wms_lots'
 THEN RAISE EXCEPTION 'Przyjęcie wymiany wymaga fragmentów pierwotnego wydania WMS' USING ERRCODE='P0001';END IF;
 IF(policy->>'enabled')::boolean AND EXISTS(SELECT 1 FROM jsonb_array_elements(rows_json) x WHERE(x->>'restocked')::int>0)
 AND NOT EXISTS(SELECT 1 FROM wms_issue_fragments WHERE(tenant_id,order_id)=(t,o.id))
 THEN RAISE EXCEPTION 'Historyczne wydanie bez fragmentów WMS wymaga odrębnego procesu; wymiana nie przypisuje pochodzenia' USING ERRCODE='P0001';END IF;
 physical:=return_exchange_snapshot(rid,(body->>'warehouse_id')::uuid);
 doc:=jsonb_build_object('return',to_jsonb(r)||jsonb_build_object('version',r.version::text),'order',to_jsonb(o)||jsonb_build_object('version',o.version::text),
  'physical',physical,'rows',rows_json,'stock',stocks,'wms_policy',policy,'request',body);
 scope:=encode(digest(doc::text,'sha256'),'hex');
 RETURN jsonb_build_object('scope_hash',scope,'snapshot',doc,'public',jsonb_build_object('return_id',rid,'version',(body->>'version')::bigint,
  'warehouse_id',body->>'warehouse_id','note',body->>'note','items',body->'items','scope_hash',scope,'original_order_id',o.id,
  'receiver',jsonb_build_object('customer_name',o.customer_name,'address',o.address),'rows',rows_json,'stock',stocks,'wms_policy',policy,
  'refund_amount',0,'replacement_total',0,'shipping_cost',0,'can_execute',true));
END$$;
