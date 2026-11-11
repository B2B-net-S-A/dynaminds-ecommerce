-- Use native PostgreSQL SHA-256 over the exact existing UTF-8 text.
-- Retain 121 frame alias repair and all 120 admission/receipt/guard predicates.
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
 scope:=encode(sha256(convert_to(doc::text,'UTF8')),'hex');
 RETURN jsonb_build_object('scope_hash',scope,'snapshot',doc,'public',jsonb_build_object('return_id',rid,'version',(body->>'version')::bigint,
  'warehouse_id',body->>'warehouse_id','note',body->>'note','items',body->'items','scope_hash',scope,'original_order_id',o.id,
  'receiver',jsonb_build_object('customer_name',o.customer_name,'address',o.address),'rows',rows_json,'stock',stocks,'wms_policy',policy,
  'refund_amount',0,'replacement_total',0,'shipping_cost',0,'can_execute',true));
END$$;


CREATE OR REPLACE FUNCTION return_exchange_finish(aid uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a return_exchange_admissions%ROWTYPE;line jsonb;after_doc jsonb;e return_exchanges%ROWTYPE;BEGIN
 SELECT * INTO a FROM return_exchange_admissions WHERE(tenant_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,aid) FOR UPDATE;
 IF a.id IS NULL OR a.after_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Brak niezakończonego dowodu wymiany' USING ERRCODE='23514';END IF;
 after_doc:=return_exchange_snapshot(a.return_id,(a.order_input->>'warehouse_id')::uuid);
 INSERT INTO return_exchanges(id,tenant_id,return_id,original_order_id,replacement_order_id,actor_id,api_key_id,client_key,request_hash,scope_hash,request,snapshot)
 VALUES(a.id,a.tenant_id,a.return_id,a.original_order_id,a.replacement_order_id,a.actor_id,a.api_key_id,a.client_key,
  encode(sha256(convert_to(jsonb_build_object('tenant_id',a.tenant_id,'actor_id',a.actor_id,'api_key_id',a.api_key_id,'request',a.request)::text,'UTF8')),'hex'),a.scope_hash,a.request,
  jsonb_build_object('before',a.before_snapshot,'after',after_doc,'frame',a.frame,'order_input',a.order_input,'lines',a.lines,
   'replacement_order',(SELECT to_jsonb(o) FROM orders o WHERE(o.tenant_id,o.id)=(a.tenant_id,a.replacement_order_id)),
   'replacement_items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM order_items i WHERE(i.tenant_id,i.order_id)=(a.tenant_id,a.replacement_order_id)))) RETURNING * INTO e;
 FOR line IN SELECT value FROM jsonb_array_elements(a.lines) LOOP
  INSERT INTO return_exchange_items VALUES(a.tenant_id,a.id,a.return_id,a.original_order_id,(line->>'item_id')::uuid,
    a.replacement_order_id,(line->>'replacement_item_id')::uuid,(line->>'product_id')::uuid,(line->>'accepted')::int,(line->>'restocked')::int,line->'components');
 END LOOP;
 UPDATE return_exchange_admissions SET after_snapshot=after_doc WHERE id=a.id;
 RETURN to_jsonb(e)-ARRAY['tenant_id','actor_id','api_key_id','request','snapshot','request_hash','client_key'];
END$$;


CREATE OR REPLACE FUNCTION return_exchange_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a return_exchange_admissions%ROWTYPE;j jsonb:=to_jsonb(NEW);oldj jsonb:=to_jsonb(OLD);rid uuid;oid uuid;e return_exchanges%ROWTYPE;f jsonb;expected jsonb;BEGIN
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='return_exchange_admissions' OR(TG_TABLE_NAME='orders' AND oldj->>'fulfillment_kind'='replacement')
   OR(TG_TABLE_NAME='return_cases' AND oldj->>'remedy'='exchange')
   OR TG_TABLE_NAME='order_items' AND EXISTS(SELECT 1 FROM orders WHERE(tenant_id,id)=((oldj->>'tenant_id')::uuid,(oldj->>'order_id')::uuid) AND fulfillment_kind='replacement')
   OR TG_TABLE_NAME='return_items' AND EXISTS(SELECT 1 FROM return_cases WHERE(tenant_id,id)=((oldj->>'tenant_id')::uuid,(oldj->>'return_id')::uuid) AND remedy='exchange')
  THEN RAISE EXCEPTION 'Tożsamość wymiany jest niezmienna' USING ERRCODE='23514';END IF;
  RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='return_exchange_admissions' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR NEW.transaction_id<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp() OR NEW.after_snapshot IS NOT NULL
   THEN RAISE EXCEPTION 'Niepoprawne przyjęcie dowodu wymiany' USING ERRCODE='23514';END IF;
   f:=return_exchange_frame(NEW.return_id,NEW.actor_id,NEW.api_key_id,NEW.request-ARRAY['client_key','scope_hash','confirmed']);
   IF NEW.frame IS DISTINCT FROM f OR NEW.scope_hash IS DISTINCT FROM f->>'scope_hash'
    OR NEW.before_snapshot IS DISTINCT FROM f->'snapshot'->'physical' OR NEW.original_order_id IS DISTINCT FROM(f->'public'->>'original_order_id')::uuid
    OR NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request->'confirmed' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_array_length(NEW.lines)<>(SELECT count(*) FROM jsonb_array_elements(f->'public'->'rows') x WHERE(x->>'accepted')::int>0)
    OR(SELECT count(DISTINCT value->>'replacement_item_id') FROM jsonb_array_elements(NEW.lines))<>jsonb_array_length(NEW.lines)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.lines) l WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'public'->'rows') x
      WHERE x=l-'replacement_item_id' AND(x->>'accepted')::int>0))
   THEN RAISE EXCEPTION 'Sfałszowany zakres przyjęcia wymiany' USING ERRCODE='23514';END IF;
   expected:=jsonb_build_object('source','manual','currency',f->'snapshot'->'order'->>'currency','payment_mode','prepaid',
    'warehouse_id',NEW.request->>'warehouse_id','customer_name',f->'snapshot'->'order'->>'customer_name','email',f->'snapshot'->'order'->>'email',
    'address',f->'snapshot'->'order'->'address','shipping_cost',0,'note',NEW.request->>'note',
    'items',(SELECT jsonb_agg(jsonb_build_object('product_id',l->>'product_id','quantity',(l->>'accepted')::int) ORDER BY l->>'item_id') FROM jsonb_array_elements(NEW.lines) l));
   IF NEW.order_input IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Sfałszowany odbiorca realizacji zastępczej' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO e FROM return_exchanges WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);
   IF OLD.after_snapshot IS NOT NULL OR NEW.after_snapshot IS NULL OR to_jsonb(NEW)-'after_snapshot' IS DISTINCT FROM to_jsonb(OLD)-'after_snapshot'
    OR NEW.transaction_id<>pg_current_xact_id() OR NEW.transaction_started_at<>transaction_timestamp() OR e.id IS NULL
    OR e.snapshot->'after' IS DISTINCT FROM NEW.after_snapshot
    OR NEW.after_snapshot IS DISTINCT FROM return_exchange_snapshot(NEW.return_id,(NEW.order_input->>'warehouse_id')::uuid)
   THEN RAISE EXCEPTION 'Dowód zakończenia wymiany jest niezmienny' USING ERRCODE='23514';END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='return_exchanges' THEN
  SELECT * INTO a FROM return_exchange_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);
  IF a.id IS NULL OR a.after_snapshot IS NOT NULL OR(NEW.return_id,NEW.original_order_id,NEW.replacement_order_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.scope_hash,NEW.request)
   IS DISTINCT FROM(a.return_id,a.original_order_id,a.replacement_order_id,a.actor_id,a.api_key_id,a.client_key,a.scope_hash,a.request)
   OR NEW.request_hash IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_object('tenant_id',a.tenant_id,'actor_id',a.actor_id,'api_key_id',a.api_key_id,'request',a.request)::text,'UTF8')),'hex')
   OR NEW.snapshot->'before' IS DISTINCT FROM a.before_snapshot OR NEW.snapshot->'frame' IS DISTINCT FROM a.frame
   OR NEW.snapshot->'order_input' IS DISTINCT FROM a.order_input OR NEW.snapshot->'lines' IS DISTINCT FROM a.lines
   OR NEW.snapshot->'after' IS DISTINCT FROM return_exchange_snapshot(a.return_id,(a.order_input->>'warehouse_id')::uuid)
   OR NEW.snapshot->'replacement_order' IS DISTINCT FROM(SELECT to_jsonb(o) FROM orders o WHERE(o.tenant_id,o.id)=(a.tenant_id,a.replacement_order_id))
   OR NEW.snapshot->'replacement_items' IS DISTINCT FROM(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM order_items i WHERE(i.tenant_id,i.order_id)=(a.tenant_id,a.replacement_order_id))
  THEN RAISE EXCEPTION 'Receipt wymiany nie odpowiada prywatnemu dowodowi' USING ERRCODE='23514';END IF;
  PERFORM return_exchange_validate(a.id);RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='orders' THEN
  IF TG_OP='UPDATE' AND(NEW.fulfillment_kind,NEW.replacement_return_id,NEW.tenant_id,NEW.id) IS DISTINCT FROM(OLD.fulfillment_kind,OLD.replacement_return_id,OLD.tenant_id,OLD.id)
  THEN RAISE EXCEPTION 'Rodzaj realizacji zamówienia jest niezmienny' USING ERRCODE='23514';END IF;
  IF NEW.fulfillment_kind='replacement' THEN
   IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM return_exchange_admissions x WHERE(x.tenant_id,x.replacement_order_id,x.return_id)=(NEW.tenant_id,NEW.id,NEW.replacement_return_id)
    AND x.transaction_id=pg_current_xact_id() AND x.transaction_started_at=transaction_timestamp() AND return_exchange_order_admission(x.id) IS NOT NULL)
   THEN RAISE EXCEPTION 'Realizacja zastępcza wymaga bieżącego dowodu reklamacji' USING ERRCODE='23514';END IF;
   IF NEW.total<>0 OR NEW.shipping_cost<>0 OR NEW.payment_mode<>'prepaid' OR NEW.source<>'manual' OR NEW.external_id IS NOT NULL
    OR NEW.channel_id IS NOT NULL OR NEW.price_list_id IS NOT NULL OR NEW.pricing_snapshot IS NOT NULL
    OR(j->'source_snapshot' IS NOT NULL AND j->'source_snapshot'<>'null')
    OR TG_OP='UPDATE' AND(NEW.customer_name,NEW.email,NEW.address,NEW.currency,NEW.warehouse_id,NEW.note)
       IS DISTINCT FROM(OLD.customer_name,OLD.email,OLD.address,OLD.currency,OLD.warehouse_id,OLD.note)
   THEN RAISE EXCEPTION 'Realizacja zastępcza nie jest nową sprzedażą' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='order_items' THEN
  IF EXISTS(SELECT 1 FROM orders WHERE(tenant_id,id)=(NEW.tenant_id,NEW.order_id) AND fulfillment_kind='replacement')
   OR TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM orders WHERE(tenant_id,id)=(OLD.tenant_id,OLD.order_id) AND fulfillment_kind='replacement') THEN
   IF NEW.price<>0 OR NEW.line_total<>0 OR TG_OP='UPDATE' AND j-'scanned' IS DISTINCT FROM oldj-'scanned'
   THEN RAISE EXCEPTION 'Pozycja realizacji zastępczej jest niezmienna i bezpłatna' USING ERRCODE='23514';END IF;
   IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM return_exchange_admissions x CROSS JOIN LATERAL jsonb_array_elements(x.lines) l
    WHERE(x.tenant_id,x.replacement_order_id)=(NEW.tenant_id,NEW.order_id) AND x.transaction_id=pg_current_xact_id()
    AND x.transaction_started_at=transaction_timestamp() AND x.after_snapshot IS NULL
    AND(NEW.id,NEW.product_id,NEW.quantity,NEW.name,NEW.sku,NEW.vat,NEW.components)=
     ((l->>'replacement_item_id')::uuid,(l->>'product_id')::uuid,(l->>'accepted')::int,l->>'name',l->>'sku',(l->>'vat')::int,l->'components'))
   THEN RAISE EXCEPTION 'Pozycja zastępcza wymaga bieżącego dokładnego dowodu wymiany' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='return_cases' THEN
  IF TG_OP='UPDATE' AND OLD.remedy='exchange' AND j IS DISTINCT FROM oldj
  THEN RAISE EXCEPTION 'Przyjęta wymiana jest niezmienna' USING ERRCODE='23514';END IF;
  IF NEW.remedy='exchange' AND NOT EXISTS(SELECT 1 FROM return_exchange_admissions x WHERE(x.tenant_id,x.return_id)=(NEW.tenant_id,NEW.id)
    AND x.transaction_id=pg_current_xact_id() AND x.transaction_started_at=transaction_timestamp() AND x.after_snapshot IS NULL)
  THEN RAISE EXCEPTION 'Zmiana sposobu reklamacji wymaga dowodu wymiany' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='return_items' THEN
  IF EXISTS(SELECT 1 FROM return_cases WHERE(tenant_id,id)=(NEW.tenant_id,NEW.return_id) AND remedy='exchange')
    AND(NOT EXISTS(SELECT 1 FROM return_exchange_admissions x WHERE(x.tenant_id,x.return_id)=(NEW.tenant_id,NEW.return_id)
     AND x.transaction_id=pg_current_xact_id() AND x.transaction_started_at=transaction_timestamp() AND x.after_snapshot IS NULL) OR NEW.refund_amount<>0)
  THEN RAISE EXCEPTION 'Pozycje wymiany nie mogą otrzymać refundacji' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END$$;


