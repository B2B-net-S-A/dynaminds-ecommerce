-- Local same-product warranty fulfillment. No historical acceptance is inferred.
ALTER TABLE orders ADD COLUMN fulfillment_kind text NOT NULL DEFAULT 'sale'
 CHECK(fulfillment_kind IN('sale','replacement'));
ALTER TABLE orders ADD COLUMN replacement_return_id uuid;
ALTER TABLE return_cases ADD COLUMN remedy text NOT NULL DEFAULT 'refund' CHECK(remedy IN('refund','exchange'));
ALTER TABLE orders ADD FOREIGN KEY(tenant_id,replacement_return_id) REFERENCES return_cases(tenant_id,id);
ALTER TABLE orders ADD CHECK((fulfillment_kind='replacement')=(replacement_return_id IS NOT NULL));
ALTER TABLE orders ADD CHECK(fulfillment_kind='sale' OR(total=0 AND shipping_cost=0 AND payment_mode='prepaid'
 AND source='manual' AND channel_id IS NULL AND external_id IS NULL AND price_list_id IS NULL));
ALTER TABLE return_cases ADD CHECK(remedy='refund' OR(kind='complaint' AND NOT legacy AND state='closed'
 AND refund_amount=0 AND refunded_shipping=0 AND settlement IS NULL AND refunded_at IS NULL
 AND received_at IS NOT NULL AND receipt IS NOT NULL));
CREATE TABLE return_exchanges(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,return_id uuid NOT NULL,original_order_id uuid NOT NULL,
 replacement_order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),request jsonb NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,return_id,original_order_id,replacement_order_id),UNIQUE(tenant_id,return_id),UNIQUE(tenant_id,replacement_order_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,original_order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,replacement_order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),CHECK(original_order_id<>replacement_order_id)
);
CREATE TABLE return_exchange_items(
 tenant_id uuid NOT NULL,exchange_id uuid NOT NULL,return_id uuid NOT NULL,original_order_id uuid NOT NULL,
 original_item_id uuid NOT NULL,replacement_order_id uuid NOT NULL,replacement_item_id uuid NOT NULL,
 product_id uuid NOT NULL,accepted integer NOT NULL CHECK(accepted>0),restocked integer NOT NULL CHECK(restocked BETWEEN 0 AND accepted),
 components jsonb NOT NULL,PRIMARY KEY(tenant_id,exchange_id,original_item_id),UNIQUE(tenant_id,replacement_item_id),
 FOREIGN KEY(tenant_id,exchange_id) REFERENCES return_exchanges(tenant_id,id),
 FOREIGN KEY(tenant_id,exchange_id,return_id,original_order_id,replacement_order_id) REFERENCES return_exchanges(tenant_id,id,return_id,original_order_id,replacement_order_id),
 FOREIGN KEY(tenant_id,original_order_id,original_item_id) REFERENCES order_items(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,replacement_order_id,replacement_item_id) REFERENCES order_items(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,return_id,original_item_id) REFERENCES return_items(tenant_id,return_id,item_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE return_exchange_admissions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,return_id uuid NOT NULL,original_order_id uuid NOT NULL,
 replacement_order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request jsonb NOT NULL,scope_hash text NOT NULL,frame jsonb NOT NULL,
 order_input jsonb NOT NULL,lines jsonb NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb,
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,return_id),
 FOREIGN KEY(tenant_id,original_order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,replacement_order_id) REFERENCES orders(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX return_exchange_original ON return_exchanges(tenant_id,original_order_id,created_at,id);
CREATE INDEX return_exchange_current_tx ON return_exchange_admissions(tenant_id,transaction_id,transaction_started_at);
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['return_exchanges','return_exchange_items','return_exchange_admissions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY owner ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 END LOOP;
END$$;
GRANT SELECT ON return_exchanges,return_exchange_items TO dyna_app;
CREATE FUNCTION return_exchange_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM migrations WHERE name='120_return_exchanges')
$$;
CREATE FUNCTION return_exchange_access(uid uuid,kid uuid,pin boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; r text;k api_keys%ROWTYPE;valid boolean:=true;allowed boolean;BEGIN
 IF pin THEN SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid FOR SHARE;
 ELSE SELECT role INTO r FROM memberships WHERE tenant_id=t AND user_id=uid;END IF;
 allowed:=r IS NOT DISTINCT FROM 'admin';
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;
  ELSE SELECT * INTO k FROM api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);END IF;
  valid:=k.id IS NOT NULL AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>clock_timestamp());
  allowed:=allowed AND valid AND k.scopes @> ARRAY['orders:read','orders:write','inventory:read','inventory:write','purchasing:write']::text[];
 END IF;
 RETURN jsonb_build_object('role',r,'key_valid',valid,'allowed',coalesce(allowed,false));
END$$;
CREATE FUNCTION return_exchange_snapshot(rid uuid,wh uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('physical',b2b_return_local_snapshot(rid),
 'stock',coalesce((SELECT jsonb_agg(to_jsonb(st)||jsonb_build_object('version',st.version::text) ORDER BY st.warehouse_id,st.product_id)
 FROM stock st WHERE st.tenant_id=r.tenant_id AND st.warehouse_id IN(r.warehouse_id,wh) AND st.product_id IN(
 SELECT (comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,rid))),'[]'),
 'bins',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.warehouse_id,b.product_id,b.location) FROM stock_locations b
 WHERE b.tenant_id=r.tenant_id AND b.warehouse_id IN(r.warehouse_id,wh) AND b.product_id IN(
 SELECT(comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,rid))),'[]'),
 'positions',coalesce((SELECT jsonb_agg(to_jsonb(lp)||jsonb_build_object('version',lp.version::text) ORDER BY lp.warehouse_id,lp.product_id,lp.location,lp.layer_id)
 FROM wms_layer_positions lp WHERE lp.tenant_id=r.tenant_id AND lp.warehouse_id IN(r.warehouse_id,wh) AND lp.product_id IN(
 SELECT(comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,rid))),'[]'))
 FROM return_cases r WHERE(tenant_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,rid)
$$;
CREATE FUNCTION return_exchange_frame(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS jsonb
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
 PERFORM 1 FROM products WHERE tenant_id=t AND id IN(SELECT oi.product_id FROM order_items oi JOIN return_items ri
 ON(ri.tenant_id,ri.order_id,ri.item_id)=(oi.tenant_id,oi.order_id,oi.id) WHERE(ri.tenant_id,ri.return_id)=(t,rid)) ORDER BY id FOR SHARE;
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
CREATE FUNCTION return_exchange_prepare(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f jsonb;input jsonb;oid uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();lines_json jsonb;
BEGIN
 f:=return_exchange_frame(rid,uid,kid,body-ARRAY['client_key','scope_hash','confirmed']);
 IF body->>'scope_hash' IS DISTINCT FROM f->>'scope_hash' OR body->'confirmed' IS DISTINCT FROM 'true'::jsonb
 OR body-ARRAY['client_key','scope_hash','confirmed','version','warehouse_id','note','items','wms_lots','origin_id']<>'{}'
 THEN RAISE EXCEPTION 'Zakres wymiany zmienił się; odczytaj nowy podgląd' USING ERRCODE='P0001';END IF;
 SELECT jsonb_agg(value||jsonb_build_object('replacement_item_id',gen_random_uuid()) ORDER BY value->>'item_id') INTO lines_json
  FROM jsonb_array_elements(f->'public'->'rows') WHERE(value->>'accepted')::int>0;
 input:=jsonb_build_object('source','manual','currency',f->'snapshot'->'order'->>'currency','payment_mode','prepaid',
  'warehouse_id',body->>'warehouse_id','customer_name',f->'snapshot'->'order'->>'customer_name','email',f->'snapshot'->'order'->>'email',
  'address',f->'snapshot'->'order'->'address','shipping_cost',0,'note',body->>'note',
  'items',(SELECT jsonb_agg(jsonb_build_object('product_id',l->>'product_id','quantity',(l->>'accepted')::int) ORDER BY l->>'item_id') FROM jsonb_array_elements(lines_json) l));
 INSERT INTO return_exchange_admissions(id,tenant_id,return_id,original_order_id,replacement_order_id,actor_id,api_key_id,client_key,request,scope_hash,frame,order_input,lines,before_snapshot)
 VALUES(aid,t,rid,(f->'public'->>'original_order_id')::uuid,oid,uid,kid,(body->>'client_key')::uuid,body,f->>'scope_hash',f,input,lines_json,f->'snapshot'->'physical');
 RETURN jsonb_build_object('id',aid,'return_id',rid,'replacement_order_id',oid,'order_input',input);
END$$;
CREATE FUNCTION return_exchange_receive_admission(aid uuid,rid uuid,body jsonb) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM return_exchange_admissions a WHERE(a.tenant_id,a.id,a.return_id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,aid,rid)
 AND a.transaction_id=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp() AND a.after_snapshot IS NULL
 AND body=(a.request-ARRAY['client_key','scope_hash','confirmed','warehouse_id'])||jsonb_build_object('shipping_refund',0)
 AND return_exchange_access(a.actor_id,a.api_key_id,false)->>'allowed'='true')
$$;
CREATE FUNCTION return_exchange_order_admission(aid uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('return_id',a.return_id,'replacement_order_id',a.replacement_order_id,'actor_id',a.actor_id,'api_key_id',a.api_key_id,'order_input',a.order_input,'lines',a.lines)
 FROM return_exchange_admissions a JOIN return_cases r ON(r.tenant_id,r.id)=(a.tenant_id,a.return_id)
 WHERE(a.tenant_id,a.id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,aid) AND a.transaction_id=pg_current_xact_id()
 AND a.transaction_started_at=transaction_timestamp() AND a.after_snapshot IS NULL AND r.remedy='exchange' AND r.received_at IS NOT NULL
 AND return_exchange_access(a.actor_id,a.api_key_id,false)->>'allowed'='true'
$$;
CREATE FUNCTION return_exchange_validate(aid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a return_exchange_admissions%ROWTYPE;r return_cases%ROWTYPE;o orders%ROWTYPE;line jsonb;ri return_items%ROWTYPE;oi order_items%ROWTYPE;
 actual jsonb;before_doc jsonb;receipt jsonb;component record;st jsonb;prior jsonb;expected_on bigint;expected_reserved bigint;wh uuid;
 binrow jsonb;oldbin jsonb;gain bigint;op wms_operations%ROWTYPE;pick jsonb;fragment record;lm record;BEGIN
 SELECT * INTO a FROM return_exchange_admissions WHERE id=aid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF a.id IS NULL OR a.transaction_id<>pg_current_xact_id() OR a.transaction_started_at<>transaction_timestamp()
 OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'Brak bieżącego dowodu wymiany' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 receipt:=(a.request-ARRAY['client_key','scope_hash','confirmed','warehouse_id'])||jsonb_build_object('shipping_refund',0);
 IF r.remedy<>'exchange' OR r.state<>'closed' OR r.received_at IS NULL OR r.receipt IS DISTINCT FROM receipt
 OR r.refund_amount<>0 OR r.refunded_shipping<>0 OR r.refunded_at IS NOT NULL OR r.settlement IS NOT NULL
 OR r.version<>(a.request->>'version')::bigint+1 OR r.decision_note IS DISTINCT FROM a.request->>'note'
 OR to_jsonb(r)-ARRAY['remedy','state','receipt','received_at','receipt_sequence','version','updated_at','decision_note']
 IS DISTINCT FROM (a.frame->'snapshot'->'return')-ARRAY['remedy','state','receipt','received_at','receipt_sequence','version','updated_at','decision_note']
 THEN RAISE EXCEPTION 'Przyjęcie reklamacji nie odpowiada zgodzie wymiany' USING ERRCODE='23514';END IF;
 IF r.receipt_sequence<>(SELECT coalesce(max(rr.receipt_sequence),0)+1 FROM return_cases rr WHERE(rr.tenant_id,rr.order_id)=(a.tenant_id,a.original_order_id) AND rr.id<>r.id)
 THEN RAISE EXCEPTION 'Niepoprawna kolejność przyjęcia wymiany' USING ERRCODE='23514';END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(a.frame->'public'->'rows') LOOP
  SELECT * INTO ri FROM return_items WHERE(tenant_id,return_id,item_id)=(a.tenant_id,a.return_id,(line->>'item_id')::uuid);
  SELECT value INTO prior FROM jsonb_array_elements(a.before_snapshot->'physical'->'items') WHERE value->>'item_id'=line->>'item_id';
  IF ri.item_id IS NULL OR ri.accepted<>(line->>'accepted')::int OR ri.restocked<>(line->>'restocked')::int OR ri.refund_amount<>0
  OR to_jsonb(ri)-ARRAY['accepted','restocked','refund_amount'] IS DISTINCT FROM prior-ARRAY['accepted','restocked','refund_amount']
  THEN RAISE EXCEPTION 'Pozycje przyjęcia nie odpowiadają wymianie' USING ERRCODE='23514';END IF;
 END LOOP;
 IF(SELECT count(*) FROM return_items WHERE(tenant_id,return_id)=(a.tenant_id,a.return_id))<>jsonb_array_length(a.frame->'public'->'rows')
 THEN RAISE EXCEPTION 'Niepełna receptura przyjęcia wymiany' USING ERRCODE='23514';END IF;
 SELECT * INTO o FROM orders WHERE(tenant_id,id)=(a.tenant_id,a.replacement_order_id);
 IF o.id IS NULL OR o.fulfillment_kind<>'replacement' OR o.replacement_return_id IS DISTINCT FROM a.return_id
 OR o.total<>0 OR o.shipping_cost<>0 OR o.payment_mode<>'prepaid' OR o.status<>'paid' OR o.source<>'manual'
 OR o.channel_id IS NOT NULL OR o.external_id IS NOT NULL OR o.price_list_id IS NOT NULL OR o.pricing_snapshot IS NOT NULL
 OR o.currency IS DISTINCT FROM a.order_input->>'currency' OR o.customer_name IS DISTINCT FROM a.order_input->>'customer_name'
 OR o.email IS DISTINCT FROM a.order_input->>'email' OR o.address IS DISTINCT FROM a.order_input->'address'
 OR o.warehouse_id IS DISTINCT FROM (a.order_input->>'warehouse_id')::uuid OR o.note IS DISTINCT FROM a.order_input->>'note'
 OR (to_jsonb(o)->'source_snapshot' IS NOT NULL AND to_jsonb(o)->'source_snapshot'<>'null')
 THEN RAISE EXCEPTION 'Zamówienie zastępcze narusza zerowe rozliczenie lub zakres reklamacji' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM order_items WHERE(tenant_id,order_id)=(a.tenant_id,o.id))<>jsonb_array_length(a.lines)
 THEN RAISE EXCEPTION 'Niepełne pozycje zamówienia zastępczego' USING ERRCODE='23514';END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(a.lines) LOOP
  SELECT * INTO oi FROM order_items WHERE(tenant_id,order_id,id)=(a.tenant_id,o.id,(line->>'replacement_item_id')::uuid);
  IF oi.id IS NULL OR oi.product_id IS DISTINCT FROM(line->>'product_id')::uuid OR oi.quantity<>(line->>'accepted')::int
  OR oi.name IS DISTINCT FROM line->>'name' OR oi.sku IS DISTINCT FROM line->>'sku' OR oi.vat<>(line->>'vat')::int
  OR oi.price<>0 OR oi.line_total<>0 OR oi.components IS DISTINCT FROM line->'components' OR oi.scanned<>0
  THEN RAISE EXCEPTION 'Pozycja zastępcza nie odpowiada pierwotnemu UUID i recepturze' USING ERRCODE='23514';END IF;
 END LOOP;
 actual:=return_exchange_snapshot(a.return_id,o.warehouse_id);
 -- Every aggregate, bin and journal delta is derived from physical components.
 FOR component IN SELECT(part->>'product_id')::uuid product_id,sum((row_json->>'accepted')::bigint*(part->>'quantity')::bigint) replace_qty,
  sum((row_json->>'restocked')::bigint*(part->>'quantity')::bigint) return_qty
  FROM jsonb_array_elements(a.frame->'public'->'rows') row_json CROSS JOIN LATERAL jsonb_array_elements(row_json->'components') part GROUP BY 1 LOOP
  IF component.replace_qty>0 AND(NOT EXISTS(SELECT 1 FROM order_pick_items p WHERE(p.tenant_id,p.order_id,p.product_id)=(a.tenant_id,o.id,component.product_id)
   AND p.quantity=component.replace_qty AND p.scanned=0)
  OR NOT EXISTS(SELECT 1 FROM reservations rs WHERE(rs.tenant_id,rs.order_id,rs.product_id)=(a.tenant_id,o.id,component.product_id)
   AND rs.warehouse_id=o.warehouse_id AND rs.quantity=component.replace_qty AND rs.state='active'))
  THEN RAISE EXCEPTION 'Brak rzeczywistej rezerwacji wymiany' USING ERRCODE='23514';END IF;
  IF coalesce((SELECT sum(m.delta) FROM stock_movements m WHERE(m.tenant_id,m.return_id,m.product_id)=(a.tenant_id,r.id,component.product_id)
    AND m.order_id=a.original_order_id AND m.warehouse_id=r.warehouse_id AND m.kind='return'),0)<>component.return_qty
   OR EXISTS(SELECT 1 FROM stock_movements m WHERE(m.tenant_id,m.return_id,m.product_id)=(a.tenant_id,r.id,component.product_id)
    AND(m.order_id IS DISTINCT FROM a.original_order_id OR m.warehouse_id<>r.warehouse_id OR m.kind<>'return' OR m.delta<=0))
  THEN RAISE EXCEPTION 'Brak rzeczywistego dziennika przyjęcia wymiany' USING ERRCODE='23514';END IF;
  FOR wh IN SELECT DISTINCT v FROM unnest(ARRAY[r.warehouse_id,o.warehouse_id]) v LOOP
   SELECT value INTO prior FROM jsonb_array_elements(a.before_snapshot->'stock') WHERE(value->>'warehouse_id')::uuid=wh AND(value->>'product_id')::uuid=component.product_id;
   SELECT value INTO st FROM jsonb_array_elements(actual->'stock') WHERE(value->>'warehouse_id')::uuid=wh AND(value->>'product_id')::uuid=component.product_id;
   expected_on:=coalesce((prior->>'on_hand')::bigint,0)+CASE WHEN wh=r.warehouse_id THEN component.return_qty ELSE 0 END;
   expected_reserved:=coalesce((prior->>'reserved')::bigint,0)+CASE WHEN wh=o.warehouse_id THEN component.replace_qty ELSE 0 END;
   IF st IS NULL AND(expected_on<>0 OR expected_reserved<>0) OR st IS NOT NULL AND((st->>'on_hand')::bigint<>expected_on OR(st->>'reserved')::bigint<>expected_reserved)
    OR prior IS NOT NULL AND st-ARRAY['on_hand','reserved','available','version'] IS DISTINCT FROM prior-ARRAY['on_hand','reserved','available','version']
    OR prior IS NULL AND st IS NOT NULL AND(st->>'location' IS DISTINCT FROM 'ZWROT' OR wh<>r.warehouse_id OR component.return_qty=0)
   THEN RAISE EXCEPTION 'Zapas wymiany nie odpowiada przyjęciu i rezerwacji' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
 IF(SELECT count(*) FROM reservations WHERE(tenant_id,order_id)=(a.tenant_id,o.id))<>
  (SELECT count(*) FROM(SELECT part->>'product_id' FROM jsonb_array_elements(a.lines) l CROSS JOIN LATERAL jsonb_array_elements(l->'components') part GROUP BY 1) scope)
 OR(SELECT count(*) FROM order_pick_items WHERE(tenant_id,order_id)=(a.tenant_id,o.id))<>
  (SELECT count(*) FROM(SELECT part->>'product_id' FROM jsonb_array_elements(a.lines) l CROSS JOIN LATERAL jsonb_array_elements(l->'components') part GROUP BY 1) scope)
 THEN RAISE EXCEPTION 'Rezerwacja wymiany zawiera obcy zakres fizyczny' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM stock_movements m WHERE(m.tenant_id,m.return_id)=(a.tenant_id,r.id) AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(a.frame->'public'->'stock') s WHERE s->>'product_id'=m.product_id::text))
 THEN RAISE EXCEPTION 'Obcy produkt w dzienniku wymiany' USING ERRCODE='23514';END IF;
 FOR binrow IN SELECT value FROM jsonb_array_elements(actual->'bins') LOOP
  SELECT value INTO oldbin FROM jsonb_array_elements(a.before_snapshot->'bins')
    WHERE value->>'warehouse_id'=binrow->>'warehouse_id' AND value->>'product_id'=binrow->>'product_id' AND value->>'location'=binrow->>'location';
  gain:=0;
  IF binrow->>'warehouse_id'=r.warehouse_id::text THEN
   IF(a.frame->'public'->'wms_policy'->>'enabled')::boolean THEN
    SELECT coalesce(sum(f.quantity),0) INTO gain FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(a.tenant_id,r.id)
      AND f.product_id::text=binrow->>'product_id' AND f.location=binrow->>'location';
   ELSIF binrow->>'location'='ZWROT' THEN
    SELECT coalesce(sum((s->>'restocked')::bigint*(comp->>'quantity')::bigint),0) INTO gain
    FROM jsonb_array_elements(a.frame->'public'->'rows') s CROSS JOIN LATERAL jsonb_array_elements(s->'components') comp
    WHERE comp->>'product_id'=binrow->>'product_id';
   END IF;
  END IF;
  IF (binrow->>'quantity')::bigint<>coalesce((oldbin->>'quantity')::bigint,0)+gain
   OR oldbin IS NULL AND gain=0 OR oldbin IS NOT NULL AND binrow-'quantity' IS DISTINCT FROM oldbin-'quantity'
  THEN RAISE EXCEPTION 'Lokalizacje wymiany nie odpowiadają fizycznemu przyjęciu' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'bins') b WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'bins') n
  WHERE(n->>'warehouse_id',n->>'product_id',n->>'location')=(b->>'warehouse_id',b->>'product_id',b->>'location')))
 THEN RAISE EXCEPTION 'Usunięto lokalizację spoza zgody wymiany' USING ERRCODE='23514';END IF;
 IF(a.frame->'public'->'wms_policy'->>'enabled')::boolean AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.frame->'public'->'rows') l WHERE(l->>'restocked')::int>0) THEN
  SELECT * INTO op FROM wms_operations WHERE(tenant_id,return_id)=(a.tenant_id,r.id);
  IF op.id IS NULL OR op.kind<>'return' OR op.order_id<>a.original_order_id OR op.actor_id IS DISTINCT FROM a.actor_id
   OR op.client_key IS DISTINCT FROM(a.request->'wms_lots'->>'client_key')::uuid OR op.request IS DISTINCT FROM receipt
   OR op.policy_version IS DISTINCT FROM(a.request->'wms_lots'->>'policy_version')::bigint
   OR(SELECT count(*) FROM wms_operations WHERE(tenant_id,return_id)=(a.tenant_id,r.id))<>1
  THEN RAISE EXCEPTION 'Brak autentycznej operacji przyjęcia WMS' USING ERRCODE='23514';END IF;
  IF(SELECT count(*) FROM wms_return_fragments WHERE(tenant_id,return_id)=(a.tenant_id,r.id))<>jsonb_array_length(a.request->'wms_lots'->'picks')
  THEN RAISE EXCEPTION 'Wymiana wymaga dokładnych fragmentów wydania WMS' USING ERRCODE='23514';END IF;
  FOR pick IN SELECT value FROM jsonb_array_elements(a.request->'wms_lots'->'picks') LOOP
   SELECT f.*,i.unit_cost_minor,i.value_minor issue_value INTO fragment FROM wms_return_fragments f JOIN wms_issue_fragments i
   ON(i.tenant_id,i.id)=(f.tenant_id,f.issue_fragment_id) WHERE(f.tenant_id,f.return_id)=(a.tenant_id,r.id)
    AND f.issue_fragment_id=(pick->>'issue_fragment_id')::uuid;
   IF fragment.id IS NULL OR fragment.quantity<>(pick->>'quantity')::int OR fragment.location IS DISTINCT FROM pick->>'location'
    OR fragment.warehouse_id<>r.warehouse_id OR fragment.operation_id<>op.id OR fragment.order_id<>a.original_order_id
    OR fragment.value_minor IS DISTINCT FROM fragment.quantity::bigint*fragment.unit_cost_minor
    OR NOT EXISTS(SELECT 1 FROM wms_layer_movements m WHERE(m.tenant_id,m.operation_id,m.product_id,m.layer_id,m.warehouse_id,m.location)=
      (a.tenant_id,op.id,fragment.product_id,fragment.layer_id,r.warehouse_id,fragment.location) AND m.delta=fragment.quantity AND m.value_delta IS NOT DISTINCT FROM fragment.value_minor)
   THEN RAISE EXCEPTION 'Fragment lub koszt przyjęcia WMS nie odpowiada zgodzie' USING ERRCODE='23514';END IF;
  END LOOP;
  FOR component IN SELECT(part->>'product_id')::uuid product_id,sum((row_json->>'restocked')::bigint*(part->>'quantity')::bigint) qty
   FROM jsonb_array_elements(a.frame->'public'->'rows') row_json CROSS JOIN LATERAL jsonb_array_elements(row_json->'components') part GROUP BY 1 LOOP
   IF coalesce((SELECT sum(f.quantity) FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id,f.product_id)=(a.tenant_id,r.id,component.product_id)),0)<>component.qty
   THEN RAISE EXCEPTION 'Fizyczna ilość WMS nie odpowiada wymianie' USING ERRCODE='23514';END IF;
  END LOOP;
  IF actual->'physical'->'layers' IS DISTINCT FROM a.before_snapshot->'physical'->'layers'
   OR(SELECT count(*) FROM wms_layer_movements WHERE(tenant_id,operation_id)=(a.tenant_id,op.id))<>
    (SELECT count(DISTINCT (product_id,layer_id,warehouse_id,location)) FROM wms_return_fragments WHERE(tenant_id,return_id)=(a.tenant_id,r.id))
  THEN RAISE EXCEPTION 'Warstwy lub dziennik kosztu wymiany zawierają obcy zakres' USING ERRCODE='23514';END IF;
 ELSE
  IF actual->'physical'->'fragments' IS DISTINCT FROM a.before_snapshot->'physical'->'fragments'
   OR actual->'physical'->'operations' IS DISTINCT FROM a.before_snapshot->'physical'->'operations'
   OR actual->'physical'->'layer_movements' IS DISTINCT FROM a.before_snapshot->'physical'->'layer_movements'
   OR NOT(a.frame->'public'->'wms_policy'->>'enabled')::boolean AND(actual->'positions' IS DISTINCT FROM a.before_snapshot->'positions'
      OR actual->'physical'->'layers' IS DISTINCT FROM a.before_snapshot->'physical'->'layers')
  THEN RAISE EXCEPTION 'Nieautoryzowana operacja WMS przy wymianie bez przyjęcia partii' USING ERRCODE='23514';END IF;
 END IF;
 IF(a.frame->'public'->'wms_policy'->>'enabled')::boolean THEN
  FOR binrow IN SELECT value FROM jsonb_array_elements(actual->'positions') LOOP
   SELECT value INTO oldbin FROM jsonb_array_elements(a.before_snapshot->'positions')
   WHERE(value->>'warehouse_id',value->>'product_id',value->>'location',value->>'layer_id')=
     (binrow->>'warehouse_id',binrow->>'product_id',binrow->>'location',binrow->>'layer_id');
   SELECT coalesce(sum(f.quantity),0) INTO gain FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(a.tenant_id,r.id)
    AND(f.warehouse_id::text,f.product_id::text,f.location,f.layer_id::text)=
     (binrow->>'warehouse_id',binrow->>'product_id',binrow->>'location',binrow->>'layer_id');
   IF(binrow->>'quantity')::bigint<>coalesce((oldbin->>'quantity')::bigint,0)+gain
    OR(binrow->>'reserved')::bigint<>coalesce((oldbin->>'reserved')::bigint,0)+coalesce((SELECT sum(rl.quantity) FROM wms_reservation_layers rl
     WHERE(rl.tenant_id,rl.order_id)=(a.tenant_id,o.id) AND(rl.warehouse_id::text,rl.product_id::text,rl.location,rl.layer_id::text)=
      (binrow->>'warehouse_id',binrow->>'product_id',binrow->>'location',binrow->>'layer_id') AND rl.state='active'),0)
    OR oldbin IS NULL AND gain=0 OR oldbin IS NOT NULL AND binrow-ARRAY['quantity','reserved','version'] IS DISTINCT FROM oldbin-ARRAY['quantity','reserved','version']
   THEN RAISE EXCEPTION 'Stan warstwy wymiany nie odpowiada fragmentom i rezerwacji' USING ERRCODE='23514';END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(a.before_snapshot->'positions') b WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'positions') n
   WHERE(n->>'warehouse_id',n->>'product_id',n->>'location',n->>'layer_id')=(b->>'warehouse_id',b->>'product_id',b->>'location',b->>'layer_id')))
  THEN RAISE EXCEPTION 'Usunięto nieobjętą zgodą pozycję partii' USING ERRCODE='23514';END IF;
 END IF;
 IF return_exchange_access(a.actor_id,a.api_key_id,false)->>'allowed' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'Cofnięto bieżącą zgodę wymiany' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION return_exchange_finish(aid uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a return_exchange_admissions%ROWTYPE;line jsonb;after_doc jsonb;e return_exchanges%ROWTYPE;BEGIN
 SELECT * INTO a FROM return_exchange_admissions WHERE(tenant_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,aid) FOR UPDATE;
 IF a.id IS NULL OR a.after_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Brak niezakończonego dowodu wymiany' USING ERRCODE='23514';END IF;
 after_doc:=return_exchange_snapshot(a.return_id,(a.order_input->>'warehouse_id')::uuid);
 INSERT INTO return_exchanges(id,tenant_id,return_id,original_order_id,replacement_order_id,actor_id,api_key_id,client_key,request_hash,scope_hash,request,snapshot)
 VALUES(a.id,a.tenant_id,a.return_id,a.original_order_id,a.replacement_order_id,a.actor_id,a.api_key_id,a.client_key,
  encode(digest(jsonb_build_object('tenant_id',a.tenant_id,'actor_id',a.actor_id,'api_key_id',a.api_key_id,'request',a.request)::text,'sha256'),'hex'),a.scope_hash,a.request,
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
CREATE FUNCTION return_exchange_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Dowód wymiany jest niezmienny' USING ERRCODE='23514';END$$;
CREATE TRIGGER return_exchange_immutable BEFORE UPDATE OR DELETE ON return_exchanges FOR EACH ROW EXECUTE FUNCTION return_exchange_immutable();
CREATE TRIGGER return_exchange_immutable BEFORE UPDATE OR DELETE ON return_exchange_items FOR EACH ROW EXECUTE FUNCTION return_exchange_immutable();
CREATE FUNCTION return_exchange_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
   OR NEW.request_hash IS DISTINCT FROM encode(digest(jsonb_build_object('tenant_id',a.tenant_id,'actor_id',a.actor_id,'api_key_id',a.api_key_id,'request',a.request)::text,'sha256'),'hex')
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
CREATE TRIGGER return_exchange_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON return_exchange_admissions FOR EACH ROW EXECUTE FUNCTION return_exchange_guard();
CREATE TRIGGER return_exchange_receipt_guard BEFORE INSERT ON return_exchanges FOR EACH ROW EXECUTE FUNCTION return_exchange_guard();
CREATE TRIGGER return_exchange_order_guard BEFORE INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION return_exchange_guard();
CREATE TRIGGER return_exchange_item_guard BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION return_exchange_guard();
CREATE TRIGGER return_exchange_return_guard BEFORE INSERT OR UPDATE OR DELETE ON return_cases FOR EACH ROW EXECUTE FUNCTION return_exchange_guard();
CREATE TRIGGER return_exchange_line_guard BEFORE INSERT OR UPDATE OR DELETE ON return_items FOR EACH ROW EXECUTE FUNCTION return_exchange_guard();
CREATE FUNCTION return_exchange_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e return_exchanges%ROWTYPE;a return_exchange_admissions%ROWTYPE;j jsonb:=to_jsonb(NEW);rid uuid;BEGIN
 IF TG_TABLE_NAME='orders' THEN
  IF NEW.fulfillment_kind<>'replacement' THEN RETURN NULL;END IF;rid:=NEW.replacement_return_id;
 ELSIF TG_TABLE_NAME='return_cases' THEN
  IF NEW.remedy<>'exchange' THEN RETURN NULL;END IF;rid:=NEW.id;
 ELSE rid:=(j->>'return_id')::uuid;END IF;
 SELECT * INTO e FROM return_exchanges WHERE(tenant_id,return_id)=((j->>'tenant_id')::uuid,rid);
 IF e.id IS NULL THEN RAISE EXCEPTION 'Niezakończona wymiana bez receipt' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM return_exchange_admissions WHERE(tenant_id,id)=(e.tenant_id,e.id);
 -- Later scan/pack/ship transactions retain the durable lineage without reusing
 -- a creation-time transaction certificate or requiring an administrator.
 IF a.id IS NOT NULL AND(a.transaction_id<>pg_current_xact_id() OR a.transaction_started_at<>transaction_timestamp()) THEN
  IF NOT EXISTS(SELECT 1 FROM orders o JOIN return_cases r ON(r.tenant_id,r.id)=(o.tenant_id,o.replacement_return_id)
   WHERE(o.tenant_id,o.id)=(e.tenant_id,e.replacement_order_id) AND o.fulfillment_kind='replacement'
   AND r.id=e.return_id AND r.order_id=e.original_order_id AND r.remedy='exchange' AND r.state='closed'
   AND r.received_at IS NOT NULL AND r.refund_amount=0 AND r.refunded_shipping=0 AND r.settlement IS NULL
   AND o.total=0 AND o.shipping_cost=0 AND o.payment_mode='prepaid')
  THEN RAISE EXCEPTION 'Uszkodzona trwała relacja wymiany' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 IF a.id IS NULL OR a.after_snapshot IS NULL OR a.after_snapshot IS DISTINCT FROM e.snapshot->'after'
 OR a.transaction_id<>pg_current_xact_id() OR a.transaction_started_at<>transaction_timestamp()
 OR a.after_snapshot IS DISTINCT FROM return_exchange_snapshot(a.return_id,(a.order_input->>'warehouse_id')::uuid)
 OR(SELECT count(*) FROM return_exchange_items WHERE(tenant_id,exchange_id)=(e.tenant_id,e.id))<>jsonb_array_length(a.lines)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.lines) l WHERE NOT EXISTS(SELECT 1 FROM return_exchange_items i
  WHERE(i.tenant_id,i.exchange_id,i.original_item_id,i.replacement_item_id,i.product_id,i.accepted,i.restocked,i.components)=
   (e.tenant_id,e.id,(l->>'item_id')::uuid,(l->>'replacement_item_id')::uuid,(l->>'product_id')::uuid,(l->>'accepted')::int,(l->>'restocked')::int,l->'components')))
 OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'Niepełny niezmienny dowód wymiany' USING ERRCODE='23514';END IF;
 IF return_exchange_access(a.actor_id,a.api_key_id,true)->>'allowed' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'Cofnięto zgodę przed zakończeniem wymiany' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER return_exchange_complete AFTER INSERT ON return_exchanges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_exchange_complete();
CREATE CONSTRAINT TRIGGER return_exchange_complete AFTER INSERT ON return_exchange_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_exchange_complete();
CREATE CONSTRAINT TRIGGER return_exchange_complete AFTER INSERT OR UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_exchange_complete();
CREATE CONSTRAINT TRIGGER return_exchange_complete AFTER INSERT OR UPDATE ON return_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_exchange_complete();
CREATE FUNCTION return_exchange_financial_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb;field text;oid uuid;tid uuid;BEGIN
 FOR j IN SELECT to_jsonb(NEW) UNION ALL SELECT CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END LOOP
  IF j IS NULL THEN CONTINUE;END IF;tid:=(j->>'tenant_id')::uuid;
  FOREACH field IN ARRAY ARRAY['order_id','source_order_id','target_order_id','main_order_id','customer_order_id','supplier_order_id'] LOOP
   oid:=nullif(j->>field,'')::uuid;
   IF oid IS NOT NULL AND EXISTS(SELECT 1 FROM orders WHERE id=oid AND fulfillment_kind='replacement')
   THEN RAISE EXCEPTION 'Realizacja zastępcza nie może tworzyć płatności, dokumentu sprzedaży ani przekazania' USING ERRCODE='23514';END IF;
  END LOOP;
  IF j ? 'source_ids' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(j->'source_ids') sid JOIN orders o ON o.id=sid::uuid WHERE o.fulfillment_kind='replacement')
   OR j->>'return_id' IS NOT NULL AND EXISTS(SELECT 1 FROM return_cases WHERE(tenant_id,id)=(tid,(j->>'return_id')::uuid) AND remedy='exchange')
  THEN RAISE EXCEPTION 'Wymiana nie jest korektą sprzedaży ani refundacją' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NEW;
END$$;
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['payment_entries','documents','invoice_plans','odoo_invoice_exports','order_merge_previews','order_merge_executions','order_merge_claims','b2b_dropship_orders','b2b_external_order_intents'] LOOP
 EXECUTE format('CREATE TRIGGER return_exchange_financial_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION return_exchange_financial_guard()',tab);
END LOOP;END$$;
CREATE FUNCTION return_exchange_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb;e return_exchanges%ROWTYPE;a return_exchange_admissions%ROWTYPE;tid uuid;BEGIN
 FOR j IN SELECT CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END UNION ALL SELECT CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END LOOP
  IF j IS NULL THEN CONTINUE;END IF;tid:=(j->>'tenant_id')::uuid;
  FOR e IN SELECT ee.* FROM return_exchanges ee JOIN return_exchange_admissions aa ON(aa.tenant_id,aa.id)=(ee.tenant_id,ee.id)
   WHERE ee.tenant_id=tid AND aa.transaction_id=pg_current_xact_id() AND aa.transaction_started_at=transaction_timestamp() LOOP
   SELECT * INTO a FROM return_exchange_admissions WHERE id=e.id;
   IF TG_TABLE_NAME IN('orders','order_items','order_pick_items','reservations','reservation_locations','wms_reservation_layers')
    AND coalesce(j->>'order_id',j->>'id') IN(e.original_order_id::text,e.replacement_order_id::text)
    OR TG_TABLE_NAME IN('return_cases','return_items','wms_return_fragments') AND coalesce(j->>'return_id',j->>'id')=e.return_id::text
    OR TG_TABLE_NAME IN('stock','stock_locations','wms_layer_positions') AND j->>'warehouse_id' IN(a.order_input->>'warehouse_id',a.frame->'snapshot'->'return'->>'warehouse_id')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.frame->'public'->'stock') s WHERE s->>'product_id'=j->>'product_id')
    OR TG_TABLE_NAME IN('wms_operations','stock_movements') AND(j->>'return_id'=e.return_id::text OR j->>'order_id'=e.replacement_order_id::text)
    OR TG_TABLE_NAME='wms_layer_movements' AND EXISTS(SELECT 1 FROM wms_operations op WHERE op.id=(j->>'operation_id')::uuid AND(op.return_id=e.return_id OR op.order_id=e.replacement_order_id))
   THEN RAISE EXCEPTION 'Zakres zakończonej wymiany jest zapieczętowany w tej transakcji' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END$$;
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['orders','order_items','order_pick_items','return_cases','return_items','stock','stock_locations','reservations','reservation_locations','wms_operations','wms_layer_positions','wms_reservation_layers','wms_return_fragments','wms_layer_movements','stock_movements'] LOOP
 EXECUTE format('CREATE TRIGGER return_exchange_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION return_exchange_seal()',tab);
END LOOP;END$$;
CREATE FUNCTION return_exchange_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=NEW.tenant_id;bytes bigint;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('return.exchange:'||t::text,0));
 SELECT coalesce(sum(octet_length(to_jsonb(e)::text)),0) INTO bytes FROM return_exchanges e WHERE tenant_id=t;
 bytes:=bytes+coalesce((SELECT sum(octet_length(to_jsonb(a)::text)) FROM return_exchange_admissions a WHERE tenant_id=t),0)
 +coalesce((SELECT sum(octet_length(to_jsonb(i)::text)) FROM return_exchange_items i WHERE tenant_id=t),0);
 IF octet_length(to_jsonb(NEW)::text)>8388608 OR bytes+octet_length(to_jsonb(NEW)::text)>134217728
  OR TG_TABLE_NAME='return_exchanges' AND(SELECT count(*) FROM return_exchanges WHERE tenant_id=t)>=2000
 THEN RAISE EXCEPTION 'Limit niezmiennej historii wymian' USING ERRCODE='P0001';END IF;RETURN NEW;
END$$;
CREATE TRIGGER return_exchange_budget BEFORE INSERT ON return_exchanges FOR EACH ROW EXECUTE FUNCTION return_exchange_budget();
CREATE TRIGGER return_exchange_budget BEFORE INSERT OR UPDATE ON return_exchange_admissions FOR EACH ROW EXECUTE FUNCTION return_exchange_budget();
CREATE TRIGGER return_exchange_budget BEFORE INSERT ON return_exchange_items FOR EACH ROW EXECUTE FUNCTION return_exchange_budget();
DO $$DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure proc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'return_exchange_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.proc);
  IF f.proc::text ~ '^return_exchange_(installed|access|frame|prepare|receive_admission|order_admission|finish)\('
  THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO dyna_app',f.proc);END IF;
 END LOOP;
END$$;
