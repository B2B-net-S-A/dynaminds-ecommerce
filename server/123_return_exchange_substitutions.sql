-- Additive selected-product warranty substitution. Historical receipts are untouched.
CREATE TABLE return_exchange_replacements(
 tenant_id uuid NOT NULL,exchange_id uuid NOT NULL,original_item_id uuid NOT NULL,
 replacement_order_id uuid NOT NULL,replacement_item_id uuid NOT NULL,replacement_product_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),components jsonb NOT NULL,product_snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,exchange_id,original_item_id),UNIQUE(tenant_id,replacement_item_id),
 FOREIGN KEY(tenant_id,exchange_id,original_item_id) REFERENCES return_exchange_items(tenant_id,exchange_id,original_item_id),
 FOREIGN KEY(tenant_id,replacement_order_id,replacement_item_id) REFERENCES order_items(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,replacement_product_id) REFERENCES products(tenant_id,id)
);
ALTER TABLE return_exchange_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_exchange_replacements FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON return_exchange_replacements TO CURRENT_USER USING(true) WITH CHECK(true);
CREATE POLICY tenant_scope ON return_exchange_replacements USING(
 tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON return_exchange_replacements TO dyna_app;
REVOKE ALL ON return_exchange_replacements FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE ON return_exchange_replacements FROM dyna_app;
CREATE FUNCTION return_exchange_substitution_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM migrations WHERE name='123_return_exchange_substitutions')
$$;
CREATE FUNCTION return_exchange_substitution_access(uid uuid,kid uuid,pin boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE grant_doc jsonb; permitted boolean;BEGIN
 grant_doc:=return_exchange_access(uid,kid,pin);
 permitted:=kid IS NULL OR EXISTS(SELECT 1 FROM api_keys k WHERE(k.tenant_id,k.id,k.user_id)=
 (nullif(current_setting('app.tenant_id',true),'')::uuid,kid,uid) AND k.scopes @> ARRAY['products:read']::text[]);
 RETURN grant_doc||jsonb_build_object('allowed',grant_doc->>'allowed'='true' AND permitted);
END$$;
CREATE FUNCTION return_exchange_receive_request(body jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT (body-ARRAY['client_key','scope_hash','confirmed','warehouse_id'])||
 jsonb_build_object('shipping_refund',0,'items',(SELECT jsonb_agg(v-'replacement_product_id' ORDER BY n)
 FROM jsonb_array_elements(body->'items') WITH ORDINALITY x(v,n)))
$$;
CREATE FUNCTION return_exchange_physical_scope(rows_doc jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'return_quantity',returned,'replacement_quantity',replaced) ORDER BY product_id),'[]')
 FROM(SELECT product_id,sum(returned) returned,sum(replaced) replaced FROM(
 SELECT (p->>'product_id')::uuid product_id,(r->>'restocked')::bigint*(p->>'quantity')::bigint returned,0::bigint replaced
 FROM jsonb_array_elements(rows_doc) r CROSS JOIN LATERAL jsonb_array_elements(r->'components') p
 UNION ALL
 SELECT (p->>'product_id')::uuid product_id,0::bigint returned,(r->>'accepted')::bigint*(p->>'quantity')::bigint replaced
 FROM jsonb_array_elements(rows_doc) r CROSS JOIN LATERAL jsonb_array_elements(r->'replacement'->'components') p
 ) quantities GROUP BY product_id) grouped
$$;
CREATE FUNCTION return_exchange_snapshot_v2(rid uuid,wh uuid,rows_doc jsonb) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 WITH own_return AS(SELECT * FROM return_cases WHERE(tenant_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,rid)),
 physical_ids AS(SELECT (v->>'product_id')::uuid id FROM jsonb_array_elements(return_exchange_physical_scope(rows_doc)) v),
 catalog_ids AS(SELECT id FROM physical_ids UNION SELECT (v->>'product_id')::uuid FROM jsonb_array_elements(rows_doc) v
 UNION SELECT (v->'replacement'->>'product_id')::uuid FROM jsonb_array_elements(rows_doc) v)
 SELECT jsonb_build_object('physical',b2b_return_local_snapshot(rid),
 'stock',coalesce((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('version',s.version::text) ORDER BY s.warehouse_id,s.product_id)
 FROM stock s WHERE s.tenant_id=r.tenant_id AND s.warehouse_id IN(r.warehouse_id,wh) AND s.product_id IN(SELECT id FROM physical_ids)),'[]'),
 'bins',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.warehouse_id,b.product_id,b.location)
 FROM stock_locations b WHERE b.tenant_id=r.tenant_id AND b.warehouse_id IN(r.warehouse_id,wh) AND b.product_id IN(SELECT id FROM physical_ids)),'[]'),
 'positions',coalesce((SELECT jsonb_agg(to_jsonb(lp)||jsonb_build_object('version',lp.version::text) ORDER BY lp.warehouse_id,lp.product_id,lp.location,lp.layer_id)
 FROM wms_layer_positions lp WHERE lp.tenant_id=r.tenant_id AND lp.warehouse_id IN(r.warehouse_id,wh) AND lp.product_id IN(SELECT id FROM physical_ids)),'[]'),
 'catalog',coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('version',p.version::text) ORDER BY p.id)
 FROM products p WHERE p.tenant_id=r.tenant_id AND p.id IN(SELECT id FROM catalog_ids)),'[]'),
 'recipes',coalesce((SELECT jsonb_agg(to_jsonb(bc) ORDER BY bc.bundle_id,bc.product_id)
 FROM bundle_components bc WHERE bc.tenant_id=r.tenant_id AND bc.bundle_id IN(SELECT id FROM catalog_ids)),'[]'),
 'target_layers',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('unit_cost_minor',l.unit_cost_minor::text,'fifo_sequence',l.fifo_sequence::text) ORDER BY l.id)
 FROM wms_cost_layers l WHERE l.tenant_id=r.tenant_id AND l.product_id IN(SELECT id FROM physical_ids)),'[]'))
 FROM own_return r
$$;
CREATE FUNCTION return_exchange_frame_v1(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS jsonb
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


CREATE FUNCTION return_exchange_frame_v2(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; r return_cases%ROWTYPE;o orders%ROWTYPE;
 g jsonb;ri record;decision jsonb;recipe jsonb;target_recipe jsonb;target_doc jsonb;target_id uuid;target_product products%ROWTYPE;rows_json jsonb:='[]';stocks jsonb:='[]';physical jsonb;doc jsonb;scope text;
 p record;returnqty bigint;replaceqty bigint;st stock%ROWTYPE;policy jsonb;countqty bigint;component record;BEGIN
 g:=return_exchange_substitution_access(uid,kid,false);
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
 PERFORM 1 FROM products WHERE tenant_id=t AND id IN(
 SELECT oi.product_id FROM order_items oi JOIN return_items rq
 ON(rq.tenant_id,rq.order_id,rq.item_id)=(oi.tenant_id,oi.order_id,oi.id) WHERE(rq.tenant_id,rq.return_id)=(t,rid)
 UNION SELECT (v->>'replacement_product_id')::uuid FROM jsonb_array_elements(body->'items') v WHERE v ? 'replacement_product_id'
 ) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM bundle_components bc WHERE bc.tenant_id=t AND bc.bundle_id IN(
 SELECT oi.product_id FROM order_items oi JOIN return_items rq
 ON(rq.tenant_id,rq.order_id,rq.item_id)=(oi.tenant_id,oi.order_id,oi.id) WHERE(rq.tenant_id,rq.return_id)=(t,rid)
 UNION SELECT (v->>'replacement_product_id')::uuid FROM jsonb_array_elements(body->'items') v WHERE v ? 'replacement_product_id')
 ORDER BY bc.bundle_id,bc.product_id FOR SHARE;
 countqty:=0;
 FOR ri IN SELECT l.*,oi.product_id,oi.vat,oi.quantity original_quantity FROM return_items l JOIN order_items oi
 ON(oi.tenant_id,oi.order_id,oi.id)=(l.tenant_id,l.order_id,l.item_id) WHERE(l.tenant_id,l.return_id)=(t,rid) ORDER BY l.item_id LOOP
  SELECT value INTO decision FROM jsonb_array_elements(body->'items') WHERE value->>'item_id'=ri.item_id::text;
  IF decision IS NULL OR decision-ARRAY['item_id','accepted','restocked','replacement_product_id']<>'{}'
  OR jsonb_typeof(decision->'accepted') IS DISTINCT FROM 'number' OR jsonb_typeof(decision->'restocked') IS DISTINCT FROM 'number'
  OR decision ? 'replacement_product_id' AND (jsonb_typeof(decision->'replacement_product_id') IS DISTINCT FROM 'string' OR decision->>'replacement_product_id' IS NULL)
  OR decision->>'accepted' !~ '^(0|[1-9][0-9]{0,5})$' OR decision->>'restocked' !~ '^(0|[1-9][0-9]{0,5})$'
  OR decision ? 'replacement_product_id' AND (decision->>'accepted')::int=0
  OR (decision->>'accepted')::int>ri.requested OR (decision->>'restocked')::int>(decision->>'accepted')::int
  OR (decision->>'accepted')::int+(SELECT coalesce(sum(l.accepted),0) FROM return_items l JOIN return_cases rr
   ON(rr.tenant_id,rr.id)=(l.tenant_id,l.return_id) WHERE(l.tenant_id,l.order_id,l.item_id)=(t,o.id,ri.item_id)
    AND rr.id<>rid AND rr.state IN('refund_pending','closed'))>ri.original_quantity
  THEN RAISE EXCEPTION 'Ilości wymiany przekraczają zgłoszenie lub pozostałą sprzedaż' USING ERRCODE='P0001';END IF;
  target_id:=coalesce((decision->>'replacement_product_id')::uuid,ri.product_id);
  SELECT * INTO target_product FROM products WHERE(tenant_id,id)=(t,target_id);
  IF target_product.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego zamiennika' USING ERRCODE='P0001';END IF;
  IF (decision->>'accepted')::int>0 THEN
   target_recipe:=CASE WHEN target_product.kind='bundle' THEN(SELECT jsonb_agg(jsonb_build_object('product_id',bc.product_id,'quantity',bc.quantity) ORDER BY bc.product_id)
    FROM bundle_components bc WHERE(bc.tenant_id,bc.bundle_id)=(t,target_id))
    ELSE jsonb_build_array(jsonb_build_object('product_id',target_id,'quantity',1)) END;
   IF NOT target_product.active OR target_product.kind NOT IN('simple','variant','bundle') OR target_recipe IS NULL
    OR target_id=ri.product_id AND (SELECT jsonb_agg(v ORDER BY v->>'product_id') FROM jsonb_array_elements(ri.components) v) IS DISTINCT FROM target_recipe
   THEN RAISE EXCEPTION 'Zamiennik lub receptura zmieniły się; wybierz aktywny własny produkt' USING ERRCODE='P0001';END IF;
  ELSE target_recipe:=ri.components;END IF;
  recipe:=ri.components;
  target_doc:=jsonb_build_object('product_id',target_id,'product_version',target_product.version::text,
   'sku',CASE WHEN target_id=ri.product_id THEN ri.sku ELSE target_product.sku END,
   'name',CASE WHEN target_id=ri.product_id THEN ri.name ELSE target_product.name END,
   'vat',CASE WHEN target_id=ri.product_id THEN ri.vat ELSE target_product.vat END,'components',target_recipe);
  countqty:=countqty+(decision->>'accepted')::int;
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('item_id',ri.item_id,'product_id',ri.product_id,
    'sku',ri.sku,'name',ri.name,'vat',ri.vat,'accepted',(decision->>'accepted')::int,'restocked',(decision->>'restocked')::int,'components',recipe,'replacement',target_doc));
 END LOOP;
 IF countqty=0 THEN RAISE EXCEPTION 'Wymiana wymaga przyjęcia przynajmniej jednej sztuki' USING ERRCODE='P0001';END IF;
 physical:=return_exchange_snapshot_v2(rid,(body->>'warehouse_id')::uuid,rows_json);
 FOR component IN SELECT (v->>'product_id')::uuid product_id,(v->>'replacement_quantity')::bigint replacement_quantity,
 (v->>'return_quantity')::bigint return_quantity FROM jsonb_array_elements(return_exchange_physical_scope(rows_json)) v ORDER BY 1 LOOP
  SELECT * INTO p FROM products WHERE(tenant_id,id)=(t,component.product_id) FOR SHARE;
  IF p.id IS NULL OR component.replacement_quantity>0 AND(NOT p.active OR p.kind NOT IN('simple','variant')) THEN RAISE EXCEPTION 'Składnik nie jest aktywnym produktem fizycznym' USING ERRCODE='P0001';END IF;
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
 physical:=return_exchange_snapshot_v2(rid,(body->>'warehouse_id')::uuid,rows_json);
 doc:=jsonb_build_object('proof_version',2,'return',to_jsonb(r)||jsonb_build_object('version',r.version::text),'order',to_jsonb(o)||jsonb_build_object('version',o.version::text),
  'physical',physical,'rows',rows_json,'stock',stocks,'wms_policy',policy,'request',body);
 scope:=encode(sha256(convert_to(doc::text,'UTF8')),'hex');
 RETURN jsonb_build_object('proof_version',2,'scope_hash',scope,'snapshot',doc,'public',jsonb_build_object('return_id',rid,'version',(body->>'version')::bigint,
  'warehouse_id',body->>'warehouse_id','note',body->>'note','items',body->'items','scope_hash',scope,'original_order_id',o.id,
  'receiver',jsonb_build_object('customer_name',o.customer_name,'address',o.address),'rows',rows_json,'stock',stocks,'wms_policy',policy,
  'refund_amount',0,'replacement_total',0,'shipping_cost',0,'can_execute',true));
END$$;


CREATE FUNCTION return_exchange_snapshot_v1(rid uuid,wh uuid) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION return_exchange_snapshot(rid uuid,wh uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows_doc jsonb;BEGIN
 SELECT a.frame->'public'->'rows' INTO rows_doc FROM return_exchange_admissions a WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.return_id=rid AND a.frame->>'proof_version'='2';
 IF rows_doc IS NOT NULL THEN RETURN return_exchange_snapshot_v2(rid,wh,rows_doc);END IF;
 RETURN return_exchange_snapshot_v1(rid,wh);
END$$;
CREATE OR REPLACE FUNCTION return_exchange_frame(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(body->'items') d WHERE d ? 'replacement_product_id') THEN RETURN return_exchange_frame_v2(rid,uid,kid,body);END IF;
 RETURN return_exchange_frame_v1(rid,uid,kid,body);
END$$;

CREATE OR REPLACE FUNCTION return_exchange_prepare(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS jsonb
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
  'items',(SELECT jsonb_agg(jsonb_build_object('product_id',coalesce(l->'replacement'->>'product_id',l->>'product_id'),'quantity',(l->>'accepted')::int) ORDER BY l->>'item_id') FROM jsonb_array_elements(lines_json) l));
 INSERT INTO return_exchange_admissions(id,tenant_id,return_id,original_order_id,replacement_order_id,actor_id,api_key_id,client_key,request,scope_hash,frame,order_input,lines,before_snapshot)
 VALUES(aid,t,rid,(f->'public'->>'original_order_id')::uuid,oid,uid,kid,(body->>'client_key')::uuid,body,f->>'scope_hash',f,input,lines_json,f->'snapshot'->'physical');
 RETURN jsonb_build_object('id',aid,'return_id',rid,'replacement_order_id',oid,'order_input',input);
END$$;


CREATE OR REPLACE FUNCTION return_exchange_receive_admission(aid uuid,rid uuid,body jsonb) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM return_exchange_admissions a WHERE(a.tenant_id,a.id,a.return_id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,aid,rid)
 AND a.transaction_id=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp() AND a.after_snapshot IS NULL
 AND body=return_exchange_receive_request(a.request)
 AND (CASE WHEN a.frame->>'proof_version'='2' THEN return_exchange_substitution_access(a.actor_id,a.api_key_id,false) ELSE return_exchange_access(a.actor_id,a.api_key_id,false) END)->>'allowed'='true')
$$;

CREATE OR REPLACE FUNCTION return_exchange_order_admission(aid uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('proof_version',coalesce((a.frame->>'proof_version')::int,1),'return_id',a.return_id,'replacement_order_id',a.replacement_order_id,'actor_id',a.actor_id,'api_key_id',a.api_key_id,'order_input',a.order_input,'lines',a.lines)
 FROM return_exchange_admissions a JOIN return_cases r ON(r.tenant_id,r.id)=(a.tenant_id,a.return_id)
 WHERE(a.tenant_id,a.id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,aid) AND a.transaction_id=pg_current_xact_id()
 AND a.transaction_started_at=transaction_timestamp() AND a.after_snapshot IS NULL AND r.remedy='exchange' AND r.received_at IS NOT NULL
 AND (CASE WHEN a.frame->>'proof_version'='2' THEN return_exchange_substitution_access(a.actor_id,a.api_key_id,false) ELSE return_exchange_access(a.actor_id,a.api_key_id,false) END)->>'allowed'='true'
$$;

CREATE FUNCTION return_exchange_validate_v1(aid uuid) RETURNS void
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


CREATE FUNCTION return_exchange_validate_v2(aid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a return_exchange_admissions%ROWTYPE;r return_cases%ROWTYPE;o orders%ROWTYPE;line jsonb;ri return_items%ROWTYPE;oi order_items%ROWTYPE;
 actual jsonb;before_doc jsonb;receipt jsonb;component record;st jsonb;prior jsonb;expected_on bigint;expected_reserved bigint;wh uuid;
 binrow jsonb;oldbin jsonb;gain bigint;op wms_operations%ROWTYPE;pick jsonb;fragment record;lm record;BEGIN
 SELECT * INTO a FROM return_exchange_admissions WHERE id=aid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF a.id IS NULL OR a.transaction_id<>pg_current_xact_id() OR a.transaction_started_at<>transaction_timestamp()
 OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'Brak bieżącego dowodu wymiany' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 receipt:=return_exchange_receive_request(a.request);
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
 FOR line IN SELECT value || (value->'replacement') FROM jsonb_array_elements(a.lines) LOOP
  SELECT * INTO oi FROM order_items WHERE(tenant_id,order_id,id)=(a.tenant_id,o.id,(line->>'replacement_item_id')::uuid);
  IF oi.id IS NULL OR oi.product_id IS DISTINCT FROM(line->>'product_id')::uuid OR oi.quantity<>(line->>'accepted')::int
  OR oi.name IS DISTINCT FROM line->>'name' OR oi.sku IS DISTINCT FROM line->>'sku' OR oi.vat<>(line->>'vat')::int
  OR oi.price<>0 OR oi.line_total<>0 OR oi.components IS DISTINCT FROM line->'components' OR oi.scanned<>0
  THEN RAISE EXCEPTION 'Pozycja zastępcza nie odpowiada pierwotnemu UUID i recepturze' USING ERRCODE='23514';END IF;
 END LOOP;
 actual:=return_exchange_snapshot(a.return_id,o.warehouse_id);
 -- Every aggregate, bin and journal delta is derived from physical components.
 FOR component IN SELECT (scope_row->>'product_id')::uuid product_id,(scope_row->>'replacement_quantity')::bigint replace_qty,(scope_row->>'return_quantity')::bigint return_qty
 FROM jsonb_array_elements(return_exchange_physical_scope(a.frame->'public'->'rows')) scope_row LOOP
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
  (SELECT count(*) FROM(SELECT part->>'product_id' FROM jsonb_array_elements(a.lines) l CROSS JOIN LATERAL jsonb_array_elements(l->'replacement'->'components') part GROUP BY 1) scope)
 OR(SELECT count(*) FROM order_pick_items WHERE(tenant_id,order_id)=(a.tenant_id,o.id))<>
  (SELECT count(*) FROM(SELECT part->>'product_id' FROM jsonb_array_elements(a.lines) l CROSS JOIN LATERAL jsonb_array_elements(l->'replacement'->'components') part GROUP BY 1) scope)
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
 IF actual->'catalog' IS DISTINCT FROM a.before_snapshot->'catalog' OR actual->'recipes' IS DISTINCT FROM a.before_snapshot->'recipes' OR actual->'target_layers' IS DISTINCT FROM a.before_snapshot->'target_layers' THEN RAISE EXCEPTION 'Receptura lub katalog zamiennika zmieniły się podczas wymiany' USING ERRCODE='23514';END IF;
 IF return_exchange_substitution_access(a.actor_id,a.api_key_id,false)->>'allowed' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'Cofnięto bieżącą zgodę wymiany' USING ERRCODE='23514';END IF;
END$$;


CREATE OR REPLACE FUNCTION return_exchange_validate(aid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM return_exchange_admissions a WHERE a.id=aid AND a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.frame->>'proof_version'='2')
 THEN PERFORM return_exchange_validate_v2(aid);ELSE PERFORM return_exchange_validate_v1(aid);END IF;
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
  IF a.frame->>'proof_version'='2' THEN
   INSERT INTO return_exchange_replacements(tenant_id,exchange_id,original_item_id,replacement_order_id,replacement_item_id,replacement_product_id,quantity,components,product_snapshot)
   SELECT a.tenant_id,a.id,(line->>'item_id')::uuid,a.replacement_order_id,(line->>'replacement_item_id')::uuid,
    (line->'replacement'->>'product_id')::uuid,(line->>'accepted')::int,line->'replacement'->'components',
    jsonb_build_object('id',pp.id,'version',pp.version::text,'sku',line->'replacement'->>'sku','name',line->'replacement'->>'name',
     'vat',(line->'replacement'->>'vat')::int,'kind',pp.kind,'components',line->'replacement'->'components')
   FROM products pp WHERE(pp.tenant_id,pp.id)=(a.tenant_id,(line->'replacement'->>'product_id')::uuid);
  END IF;
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
    'items',(SELECT jsonb_agg(jsonb_build_object('product_id',coalesce(l->'replacement'->>'product_id',l->>'product_id'),'quantity',(l->>'accepted')::int) ORDER BY l->>'item_id') FROM jsonb_array_elements(NEW.lines) l));
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
     ((l->>'replacement_item_id')::uuid,coalesce(l->'replacement'->>'product_id',l->>'product_id')::uuid,(l->>'accepted')::int,coalesce(l->'replacement'->>'name',l->>'name'),coalesce(l->'replacement'->>'sku',l->>'sku'),coalesce(l->'replacement'->>'vat',l->>'vat')::int,coalesce(l->'replacement'->'components',l->'components')))
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



CREATE FUNCTION return_exchange_replacements_valid(eid uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN a.frame->>'proof_version'='2' THEN
 (SELECT count(*) FROM return_exchange_replacements z WHERE(z.tenant_id,z.exchange_id)=(a.tenant_id,a.id))=jsonb_array_length(a.lines)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.lines) ln WHERE NOT EXISTS(
 SELECT 1 FROM return_exchange_replacements z WHERE(z.tenant_id,z.exchange_id,z.original_item_id,z.replacement_order_id,z.replacement_item_id,z.replacement_product_id,z.quantity,z.components)=
 (a.tenant_id,a.id,(ln->>'item_id')::uuid,a.replacement_order_id,(ln->>'replacement_item_id')::uuid,
 (ln->'replacement'->>'product_id')::uuid,(ln->>'accepted')::int,ln->'replacement'->'components')
 AND z.product_snapshot=jsonb_build_object('id',ln->'replacement'->'product_id','version',ln->'replacement'->'product_version',
 'sku',ln->'replacement'->'sku','name',ln->'replacement'->'name','vat',ln->'replacement'->'vat','components',ln->'replacement'->'components',
 'kind',(SELECT pv->'kind' FROM jsonb_array_elements(a.before_snapshot->'catalog') pv WHERE pv->>'id'=ln->'replacement'->>'product_id'))))
 ELSE a.frame->>'proof_version' IS NULL AND NOT EXISTS(SELECT 1 FROM return_exchange_replacements z WHERE(z.tenant_id,z.exchange_id)=(a.tenant_id,a.id)) END
 FROM return_exchange_admissions a WHERE a.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND a.id=eid
$$;
CREATE FUNCTION return_exchange_replacement_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE admission return_exchange_admissions%ROWTYPE;source_line jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Mapa zamienników jest niezmienna' USING ERRCODE='23514';END IF;
 SELECT * INTO admission FROM return_exchange_admissions a WHERE(a.tenant_id,a.id)=(NEW.tenant_id,NEW.exchange_id);
 SELECT ln INTO source_line FROM jsonb_array_elements(admission.lines) ln WHERE ln->>'item_id'=NEW.original_item_id::text;
 IF admission.id IS NULL OR admission.frame->>'proof_version' IS DISTINCT FROM '2' OR admission.after_snapshot IS NOT NULL
 OR admission.transaction_id<>pg_current_xact_id() OR admission.transaction_started_at<>transaction_timestamp()
 OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR source_line IS NULL
 OR (NEW.replacement_order_id,NEW.replacement_item_id,NEW.replacement_product_id,NEW.quantity,NEW.components) IS DISTINCT FROM
 (admission.replacement_order_id,(source_line->>'replacement_item_id')::uuid,(source_line->'replacement'->>'product_id')::uuid,
 (source_line->>'accepted')::int,source_line->'replacement'->'components')
 OR NEW.product_snapshot IS DISTINCT FROM jsonb_build_object('id',source_line->'replacement'->'product_id',
 'version',source_line->'replacement'->'product_version','sku',source_line->'replacement'->'sku',
 'name',source_line->'replacement'->'name','vat',source_line->'replacement'->'vat','components',source_line->'replacement'->'components',
 'kind',(SELECT pv->'kind' FROM jsonb_array_elements(admission.before_snapshot->'catalog') pv WHERE pv->>'id'=source_line->'replacement'->>'product_id'))
 OR NOT EXISTS(SELECT 1 FROM return_exchanges e WHERE(e.tenant_id,e.id)=(NEW.tenant_id,NEW.exchange_id))
 THEN RAISE EXCEPTION 'Mapa zamiennika nie odpowiada bieżącej zgodzie' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER return_exchange_replacement_guard BEFORE INSERT OR UPDATE OR DELETE ON return_exchange_replacements FOR EACH ROW EXECUTE FUNCTION return_exchange_replacement_guard();

CREATE OR REPLACE FUNCTION return_exchange_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e return_exchanges%ROWTYPE;a return_exchange_admissions%ROWTYPE;j jsonb:=to_jsonb(NEW);rid uuid;BEGIN
 IF TG_TABLE_NAME='orders' THEN
  IF NEW.fulfillment_kind<>'replacement' THEN RETURN NULL;END IF;rid:=NEW.replacement_return_id;
 ELSIF TG_TABLE_NAME='return_cases' THEN
  IF NEW.remedy<>'exchange' THEN RETURN NULL;END IF;rid:=NEW.id;
 ELSIF TG_TABLE_NAME='return_exchange_replacements' THEN SELECT e0.return_id INTO rid FROM return_exchanges e0 WHERE(e0.tenant_id,e0.id)=((j->>'tenant_id')::uuid,(j->>'exchange_id')::uuid);
 ELSE rid:=(j->>'return_id')::uuid;END IF;
 SELECT * INTO e FROM return_exchanges WHERE(tenant_id,return_id)=((j->>'tenant_id')::uuid,rid);
 IF e.id IS NULL THEN RAISE EXCEPTION 'Niezakończona wymiana bez receipt' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM return_exchange_admissions WHERE(tenant_id,id)=(e.tenant_id,e.id);
 IF return_exchange_replacements_valid(e.id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Niepełna trwała mapa zamienników' USING ERRCODE='23514';END IF;
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
 IF (CASE WHEN a.frame->>'proof_version'='2' THEN return_exchange_substitution_access(a.actor_id,a.api_key_id,true) ELSE return_exchange_access(a.actor_id,a.api_key_id,true) END)->>'allowed' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'Cofnięto zgodę przed zakończeniem wymiany' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;

CREATE OR REPLACE FUNCTION return_exchange_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=NEW.tenant_id;bytes bigint;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('return.exchange:'||t::text,0));
 SELECT coalesce(sum(octet_length(to_jsonb(e)::text)),0) INTO bytes FROM return_exchanges e WHERE tenant_id=t;
 bytes:=bytes+coalesce((SELECT sum(octet_length(to_jsonb(a)::text)) FROM return_exchange_admissions a WHERE tenant_id=t),0)
 +coalesce((SELECT sum(octet_length(to_jsonb(i)::text)) FROM return_exchange_items i WHERE tenant_id=t),0)
 +coalesce((SELECT sum(octet_length(to_jsonb(z)::text)) FROM return_exchange_replacements z WHERE tenant_id=t),0);
 IF octet_length(to_jsonb(NEW)::text)>8388608 OR bytes+octet_length(to_jsonb(NEW)::text)>134217728
  OR TG_TABLE_NAME='return_exchanges' AND(SELECT count(*) FROM return_exchanges WHERE tenant_id=t)>=2000
 THEN RAISE EXCEPTION 'Limit niezmiennej historii wymian' USING ERRCODE='P0001';END IF;RETURN NEW;
END$$;


CREATE CONSTRAINT TRIGGER return_exchange_complete AFTER INSERT ON return_exchange_replacements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_exchange_complete();
CREATE TRIGGER return_exchange_budget BEFORE INSERT ON return_exchange_replacements FOR EACH ROW EXECUTE FUNCTION return_exchange_budget();
CREATE FUNCTION return_exchange_substitution_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE fact jsonb;BEGIN
 FOR fact IN SELECT CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END UNION ALL SELECT CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END LOOP
 IF fact IS NULL THEN CONTINUE;END IF;
 IF EXISTS(SELECT 1 FROM return_exchanges ee JOIN return_exchange_admissions aa ON(aa.tenant_id,aa.id)=(ee.tenant_id,ee.id)
 WHERE ee.tenant_id=(fact->>'tenant_id')::uuid AND aa.transaction_id=pg_current_xact_id() AND aa.transaction_started_at=transaction_timestamp()
 AND aa.frame->>'proof_version'='2' AND EXISTS(SELECT 1 FROM jsonb_array_elements(aa.before_snapshot->'catalog') pv
 WHERE pv->>'id'=CASE WHEN TG_TABLE_NAME='products' THEN fact->>'id' ELSE fact->>'bundle_id' END))
 THEN RAISE EXCEPTION 'Katalog zakończonej wymiany jest zapieczętowany w tej transakcji' USING ERRCODE='23514';END IF;
 END LOOP;IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END$$;
CREATE TRIGGER return_exchange_substitution_seal BEFORE INSERT OR UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION return_exchange_substitution_seal();
CREATE TRIGGER return_exchange_substitution_seal BEFORE INSERT OR UPDATE OR DELETE ON bundle_components FOR EACH ROW EXECUTE FUNCTION return_exchange_substitution_seal();
DO $$DECLARE proc record;BEGIN
 FOR proc IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'return_exchange_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',proc.signature);
 IF proc.signature::text ~ '^return_exchange_(installed|substitution_installed|access|substitution_access|frame|prepare|receive_admission|order_admission|finish)\(' THEN
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO dyna_app',proc.signature);END IF;
 END LOOP;
END$$;
