-- Explicit local provenance for an externally fulfilled retail RMA. No historical rewrites.
CREATE TABLE b2b_return_local_origins (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, return_id uuid NOT NULL, order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), api_key_id uuid, client_key uuid NOT NULL,
 request jsonb NOT NULL, scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,return_id), UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(jsonb_typeof(request)='object' AND jsonb_typeof(snapshot)='object')
);
CREATE TABLE b2b_return_local_proofs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, origin_id uuid NOT NULL, return_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), api_key_id uuid,
 transaction_id xid8 NOT NULL, transaction_started_at timestamptz NOT NULL,
 request jsonb NOT NULL, before_snapshot jsonb NOT NULL, after_snapshot jsonb,
 applied boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,return_id),
 FOREIGN KEY(tenant_id,origin_id) REFERENCES b2b_return_local_origins(tenant_id,id),
 FOREIGN KEY(tenant_id,return_id) REFERENCES return_cases(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['b2b_return_local_origins','b2b_return_local_proofs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
 END LOOP;
END $$;
GRANT SELECT ON b2b_return_local_origins TO dyna_app;

CREATE FUNCTION b2b_return_local_installed() RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM migrations WHERE name='112_b2b_return_local_origins')
$$;
CREATE FUNCTION b2b_return_local_auth(uid uuid,kid uuid,pin boolean) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result text; BEGIN
 IF nullif(current_setting('app.tenant_id',true),'') IS NULL OR uid IS NULL
 OR b2b_dropship_current_role(uid,pin) IS DISTINCT FROM 'admin' THEN
  RAISE EXCEPTION 'Brak aktualnej zgody administratora' USING ERRCODE='23514';
 END IF;
 IF kid IS NOT NULL THEN
  result:=b2b_dropship_return_key_grant(uid,kid,true,pin);
  IF result='invalid' THEN RAISE EXCEPTION 'Klucz został cofnięty lub wygasł' USING ERRCODE='23514'; END IF;
  IF result IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'Brak bieżących zakresów zwrotu' USING ERRCODE='23514'; END IF;
 END IF;
END $$;

-- Exact commercial identity; no product/SKU fallback can manufacture a local parcel.
CREATE FUNCTION b2b_return_local_external(rid uuid) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM return_items ri JOIN b2b_dropship_lines dl
 ON(dl.tenant_id,dl.customer_order_id,dl.customer_item_id)=(ri.tenant_id,ri.order_id,ri.item_id)
 JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(dl.tenant_id,dl.order_id)
 WHERE ri.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND ri.return_id=rid AND d.state='ordered')
$$;

CREATE FUNCTION b2b_return_local_choices(rid uuid,uid uuid,kid uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 r return_cases%ROWTYPE; ri return_items%ROWTYPE; oi order_items%ROWTYPE;
 manifest record; allocation integer; committed integer; available integer;
 sources jsonb:='[]'; evidence jsonb:='[]'; commercial jsonb:='[]'; scope_json jsonb; before_claims jsonb;
BEGIN
 IF t IS NULL OR uid IS NULL OR b2b_dropship_current_role(uid,false) IS NULL THEN RETURN NULL; END IF;
 IF kid IS NOT NULL AND b2b_dropship_return_key_grant(uid,kid,false,false) IS DISTINCT FROM 'ok' THEN RETURN NULL; END IF;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(t,rid);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM return_cases WHERE(tenant_id,order_id)=(t,r.order_id))>2000
 OR (SELECT count(*) FROM return_items WHERE(tenant_id,order_id)=(t,r.order_id))>10000 THEN
  RAISE EXCEPTION 'Za dużo wcześniejszych pozycji lokalnego RMA' USING ERRCODE='23514'; END IF;
 FOR ri IN SELECT * FROM return_items WHERE(tenant_id,return_id)=(t,rid) ORDER BY item_id LOOP
  SELECT * INTO oi FROM order_items WHERE(tenant_id,order_id,id)=(t,r.order_id,ri.item_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Niepełna oryginalna pozycja RMA' USING ERRCODE='23514'; END IF;
  IF ri.order_id IS DISTINCT FROM oi.order_id OR ri.sku IS DISTINCT FROM oi.sku OR ri.name IS DISTINCT FROM oi.name
  OR jsonb_typeof(oi.components) IS DISTINCT FROM 'array' OR jsonb_array_length(oi.components)=0
  OR ri.components IS DISTINCT FROM oi.components OR ri.requested<1 OR ri.requested>oi.quantity
  THEN RAISE EXCEPTION 'Brak jednoznacznej oryginalnej receptury lokalnego RMA' USING ERRCODE='23514'; END IF;
  IF r.state='requested' AND (ri.accepted<>0 OR ri.restocked<>0 OR ri.refund_amount<>0) THEN RAISE EXCEPTION 'Lokalne zgłoszenie nie ma pierwotnych zerowych ilości' USING ERRCODE='23514'; END IF;
  commercial:=commercial||jsonb_build_array(to_jsonb(oi));
  IF EXISTS(SELECT 1 FROM b2b_external_order_intents h WHERE(h.tenant_id,h.order_id)=(t,r.order_id)) THEN
   SELECT (alloc->>'local_quantity')::int INTO allocation FROM b2b_external_order_intents h
   CROSS JOIN LATERAL jsonb_array_elements(h.allocations) alloc
   WHERE(h.tenant_id,h.order_id)=(t,r.order_id) AND alloc->>'customer_item_id'=ri.item_id::text;
  ELSE
   SELECT oi.quantity-coalesce(sum(dl.quantity),0)::int INTO allocation FROM b2b_dropship_lines dl
   JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(dl.tenant_id,dl.order_id)
   WHERE(dl.tenant_id,dl.customer_order_id,dl.customer_item_id)=(t,r.order_id,ri.item_id) AND d.state='ordered';
  END IF;
  -- Historical physical receipts without an explicit origin consume a conservative local
  -- pool. Partner acceptances have no physical_received_at and cannot be guessed as local.
  SELECT coalesce(sum(CASE WHEN rc.state='requested' AND lo.id IS NOT NULL THEN x.requested
    WHEN rc.state IN('refund_pending','closed') AND (lo.id IS NOT NULL OR rc.received_at IS NOT NULL) THEN x.accepted ELSE 0 END),0)::int
  INTO committed FROM return_items x JOIN return_cases rc ON(rc.tenant_id,rc.id)=(x.tenant_id,x.return_id)
  LEFT JOIN b2b_return_local_origins lo ON(lo.tenant_id,lo.return_id)=(rc.tenant_id,rc.id)
  WHERE(x.tenant_id,x.order_id,x.item_id)=(t,r.order_id,ri.item_id) AND rc.id<>rid;
  FOR manifest IN SELECT e.shipment_id,e.dispatched_at,entry.value item
   FROM shopify_dispatch_evidence e JOIN shipments sh
   ON(sh.tenant_id,sh.id,sh.order_id)=(e.tenant_id,e.shipment_id,e.order_id)
   CROSS JOIN LATERAL jsonb_array_elements(e.items) entry
   WHERE(e.tenant_id,e.order_id)=(t,r.order_id) AND sh.dispatched_at IS NOT NULL
   AND entry.value->>'id'=ri.item_id::text ORDER BY e.shipment_id LIMIT 1001 LOOP
   IF jsonb_typeof(manifest.item->'quantity') IS DISTINCT FROM 'number'
    OR (manifest.item->>'quantity') !~ '^[1-9][0-9]*$'
    OR manifest.item->>'product_id' IS DISTINCT FROM oi.product_id::text
    OR manifest.item->'components' IS DISTINCT FROM to_jsonb(oi)->'components' THEN
     RAISE EXCEPTION 'Niejednoznaczna receptura lokalnej paczki' USING ERRCODE='23514';
   END IF;
   available:=greatest(0,least(coalesce(allocation,0),(manifest.item->>'quantity')::int)-committed);
   sources:=sources||jsonb_build_array(jsonb_build_object('customer_item_id',ri.item_id,'shipment_id',manifest.shipment_id,
    'sku',oi.sku,'name',oi.name,'requested',ri.requested,'issued_quantity',(manifest.item->>'quantity')::int,
    'quantity_available',available,'components',oi.components));
   evidence:=evidence||jsonb_build_array(jsonb_build_object('shipment_id',manifest.shipment_id,'item',manifest.item,'dispatched_at',manifest.dispatched_at,'local_quantity',allocation,'committed',committed));
   IF jsonb_array_length(sources)>1000 OR octet_length(evidence::text)>8388608 THEN RAISE EXCEPTION 'Za dużo źródeł lokalnego RMA' USING ERRCODE='23514'; END IF;
  END LOOP;
 END LOOP;
 IF jsonb_array_length(sources)>1000 OR jsonb_array_length(commercial)>100 THEN RAISE EXCEPTION 'Za dużo źródeł lokalnego RMA' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('head',to_jsonb(rc),'items',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.item_id) FROM return_items x WHERE(x.tenant_id,x.return_id)=(t,rc.id))) ORDER BY rc.id),'[]') INTO before_claims
 FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(t,r.order_id) AND rc.id<>rid;
 scope_json:=jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'head',to_jsonb(r),
  'items',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.item_id) FROM return_items x WHERE(x.tenant_id,x.return_id)=(t,rid)),
  'order',(SELECT to_jsonb(ord) FROM orders ord WHERE(ord.tenant_id,ord.id)=(t,r.order_id)),
  'commercial',commercial,'intent',(SELECT to_jsonb(h) FROM b2b_external_order_intents h WHERE(h.tenant_id,h.order_id)=(t,r.order_id)),
  'sources',sources,'evidence',evidence,'prior_returns',before_claims);
 IF octet_length(scope_json::text)>8388608 THEN RAISE EXCEPTION 'Za duży zakres lokalnego RMA' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('scope_hash',encode(sha256(convert_to(scope_json::text,'UTF8')),'hex'),'snapshot',scope_json,'sources',sources);
END $$;

CREATE FUNCTION b2b_return_local_select(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; r return_cases%ROWTYPE;
 existing b2b_return_local_origins%ROWTYPE; choices jsonb; requested jsonb; selected jsonb;
 oid uuid:=gen_random_uuid(); item_count integer;
BEGIN
 PERFORM b2b_return_local_auth(uid,kid,false);
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR NOT(body ?& ARRAY['client_key','version','scope_hash','confirmed','items'])
 OR body-'client_key'-'version'-'scope_hash'-'confirmed'-'items'<>'{}'::jsonb OR body->'confirmed' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(body->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'items') NOT BETWEEN 1 AND 100
 OR jsonb_typeof(body->'version') IS DISTINCT FROM 'number' OR (body->>'version') !~ '^[1-9][0-9]*$'
 OR (body->>'scope_hash') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Niepoprawna zgoda na lokalne źródło' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.return.local:'||t::text,0));
 SELECT * INTO existing FROM b2b_return_local_origins WHERE tenant_id=t AND client_key=(body->>'client_key')::uuid;
 IF FOUND THEN
  IF existing.return_id IS DISTINCT FROM rid OR existing.actor_id IS DISTINCT FROM uid OR existing.api_key_id IS DISTINCT FROM kid OR existing.request IS DISTINCT FROM body THEN RAISE EXCEPTION 'Klucz lokalnego źródła dotyczy innej zgody' USING ERRCODE='23514'; END IF;
  PERFORM b2b_return_local_auth(uid,kid,true);
  RETURN jsonb_build_object('id',existing.id,'reused',true);
 END IF;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(t,rid);
 IF NOT FOUND THEN RAISE EXCEPTION 'Nie znaleziono własnego RMA' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM orders WHERE(tenant_id,id)=(t,r.order_id) FOR UPDATE;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(t,rid) FOR UPDATE;
 PERFORM b2b_return_local_auth(uid,kid,false);
 IF r.state<>'requested' OR r.legacy OR r.received_at IS NOT NULL OR r.receipt IS NOT NULL OR r.version IS DISTINCT FROM (body->>'version')::bigint
 OR NOT b2b_return_local_external(rid) OR EXISTS(SELECT 1 FROM b2b_return_local_origins WHERE(tenant_id,return_id)=(t,rid))
 OR EXISTS(SELECT 1 FROM b2b_dropship_return_cases WHERE(tenant_id,return_id)=(t,rid))
 OR EXISTS(SELECT 1 FROM b2b_dropship_return_supplier_cases WHERE(tenant_id,return_id)=(t,rid)) THEN RAISE EXCEPTION 'RMA nie dopuszcza wyboru lokalnego źródła' USING ERRCODE='23514'; END IF;
 choices:=b2b_return_local_choices(rid,uid,kid);
 IF choices IS NULL OR choices->>'scope_hash' IS DISTINCT FROM body->>'scope_hash' THEN RAISE EXCEPTION 'Zmienił się lokalny zakres RMA' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO item_count FROM return_items WHERE(tenant_id,return_id)=(t,rid);
 IF item_count<>jsonb_array_length(body->'items') OR (SELECT count(DISTINCT x->>'customer_item_id') FROM jsonb_array_elements(body->'items') x)<>item_count THEN RAISE EXCEPTION 'Wybierz dokładnie pełny zakres RMA' USING ERRCODE='23514'; END IF;
 FOR requested IN SELECT value FROM jsonb_array_elements(body->'items') LOOP
  IF jsonb_typeof(requested) IS DISTINCT FROM 'object' OR NOT(requested ?& ARRAY['customer_item_id','shipment_id','quantity'])
  OR requested-'customer_item_id'-'shipment_id'-'quantity'<>'{}'::jsonb OR jsonb_typeof(requested->'quantity') IS DISTINCT FROM 'number'
  OR (requested->>'quantity') !~ '^[1-9][0-9]*$' OR (requested->>'quantity')::numeric>100000 THEN RAISE EXCEPTION 'Niepoprawny lokalny udział RMA' USING ERRCODE='23514'; END IF;
  SELECT x.value INTO selected FROM jsonb_array_elements(choices->'sources') x WHERE x.value->>'customer_item_id'=requested->>'customer_item_id' AND x.value->>'shipment_id'=requested->>'shipment_id';
  IF selected IS NULL OR selected->'requested' IS DISTINCT FROM requested->'quantity' OR (selected->>'quantity_available')::int<(requested->>'quantity')::int
  OR (SELECT count(*) FROM jsonb_array_elements(choices->'sources') x WHERE x.value->>'customer_item_id'=requested->>'customer_item_id')<>1 THEN RAISE EXCEPTION 'Lokalna paczka nie pokrywa wolnego zakresu RMA' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM b2b_return_local_origins WHERE tenant_id=t)>=2000 THEN RAISE EXCEPTION 'Limit lokalnych źródeł RMA: 2000 zgód' USING ERRCODE='P0001'; END IF;
 INSERT INTO b2b_return_local_origins(id,tenant_id,return_id,order_id,actor_id,api_key_id,client_key,request,scope_hash,snapshot)
 VALUES(oid,t,rid,r.order_id,uid,kid,(body->>'client_key')::uuid,body,choices->>'scope_hash',choices->'snapshot');
 RETURN jsonb_build_object('id',oid,'reused',false);
END $$;

CREATE FUNCTION b2b_return_local_snapshot(rid uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('head',to_jsonb(r),
 'items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.item_id) FROM return_items i WHERE(i.tenant_id,i.return_id)=(r.tenant_id,r.id)),'[]'),
 'stock',coalesce((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.product_id) FROM stock st WHERE(st.tenant_id,st.warehouse_id)=(r.tenant_id,r.warehouse_id) AND st.product_id IN(SELECT(comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,r.id))),'[]'),
 'bins',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.product_id,b.location) FROM stock_locations b WHERE(b.tenant_id,b.warehouse_id)=(r.tenant_id,r.warehouse_id) AND b.product_id IN(SELECT(comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,r.id))),'[]'),
 'positions',coalesce((SELECT jsonb_agg(to_jsonb(lp) ORDER BY lp.product_id,lp.location,lp.layer_id) FROM wms_layer_positions lp WHERE(lp.tenant_id,lp.warehouse_id)=(r.tenant_id,r.warehouse_id) AND lp.product_id IN(SELECT(comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,r.id))),'[]'),
 'layers',coalesce((SELECT jsonb_agg(to_jsonb(cl) ORDER BY cl.id) FROM wms_cost_layers cl WHERE cl.tenant_id=r.tenant_id AND cl.product_id IN(SELECT(comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,r.id))),'[]'),
 'movements',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM stock_movements m WHERE(m.tenant_id,m.return_id)=(r.tenant_id,r.id)),'[]'),
 'fragments',coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(r.tenant_id,r.id)),'[]'),
 'operations',coalesce((SELECT jsonb_agg(to_jsonb(op) ORDER BY op.id) FROM wms_operations op WHERE(op.tenant_id,op.return_id)=(r.tenant_id,r.id)),'[]'),
 'layer_movements',coalesce((SELECT jsonb_agg(to_jsonb(lm) ORDER BY lm.id) FROM wms_layer_movements lm JOIN wms_operations op ON(op.tenant_id,op.id)=(lm.tenant_id,lm.operation_id) WHERE(op.tenant_id,op.return_id)=(r.tenant_id,r.id)),'[]'))
 FROM return_cases r WHERE(r.tenant_id,r.id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,rid)
$$;

CREATE FUNCTION b2b_return_local_prepare(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; r return_cases%ROWTYPE;
 origin b2b_return_local_origins%ROWTYPE; ri return_items%ROWTYPE; decision jsonb; pid uuid:=gen_random_uuid(); product uuid; physical_before jsonb;
BEGIN
 PERFORM b2b_return_local_auth(uid,kid,false);
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.return.local:'||t::text,0));
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(t,rid);
 IF NOT FOUND THEN RAISE EXCEPTION 'Nie znaleziono własnego RMA' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM orders WHERE(tenant_id,id)=(t,r.order_id) FOR UPDATE;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(t,rid) FOR UPDATE;
 PERFORM b2b_return_local_auth(uid,kid,false);
 SELECT * INTO origin FROM b2b_return_local_origins WHERE(tenant_id,return_id)=(t,rid);
 IF origin.id IS NULL OR body->>'origin_id' IS DISTINCT FROM origin.id::text OR r.state<>'requested'
 OR r.received_at IS NOT NULL OR r.receipt IS NOT NULL OR r.version IS DISTINCT FROM (body->>'version')::bigint
 OR EXISTS(SELECT 1 FROM b2b_dropship_return_cases WHERE(tenant_id,return_id)=(t,rid)) THEN RAISE EXCEPTION 'Brak zatwierdzonego lokalnego źródła RMA' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR NOT(body ?& ARRAY['origin_id','version','shipping_refund','note','items'])
 OR body-ARRAY['origin_id','version','shipping_refund','note','items','wms_lots']<>'{}'::jsonb
 OR jsonb_typeof(body->'note') IS DISTINCT FROM 'string' OR length(body->>'note') NOT BETWEEN 3 AND 2000
 THEN RAISE EXCEPTION 'Niepoprawna zgoda na lokalne przyjęcie' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(body->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'items')<>(SELECT count(*) FROM return_items WHERE(tenant_id,return_id)=(t,rid))
 OR (SELECT count(DISTINCT d->>'item_id') FROM jsonb_array_elements(body->'items') d)<>jsonb_array_length(body->'items')
 OR (body->>'shipping_refund') IS NULL OR (body->>'shipping_refund') !~ '^[0-9]+$' OR (body->>'shipping_refund')::numeric>r.requested_shipping THEN RAISE EXCEPTION 'Niepełna zgoda na lokalne przyjęcie' USING ERRCODE='23514'; END IF;
 FOR ri IN SELECT * FROM return_items WHERE(tenant_id,return_id)=(t,rid) ORDER BY item_id FOR UPDATE LOOP
  SELECT d.value INTO decision FROM jsonb_array_elements(body->'items') d WHERE d.value->>'item_id'=ri.item_id::text;
  IF decision IS NULL OR jsonb_typeof(decision->'accepted') IS DISTINCT FROM 'number' OR jsonb_typeof(decision->'restocked') IS DISTINCT FROM 'number'
  OR (decision->>'accepted') !~ '^[0-9]+$' OR (decision->>'restocked') !~ '^[0-9]+$'
  OR (decision->>'accepted')::numeric>ri.requested OR (decision->>'restocked')::numeric>(decision->>'accepted')::numeric
  OR to_jsonb(ri) IS DISTINCT FROM (SELECT x.value FROM jsonb_array_elements(origin.snapshot->'items') x WHERE x.value->>'item_id'=ri.item_id::text)
  OR (SELECT to_jsonb(oi) FROM order_items oi WHERE(oi.tenant_id,oi.id)=(t,ri.item_id)) IS DISTINCT FROM (SELECT x.value FROM jsonb_array_elements(origin.snapshot->'commercial') x WHERE x.value->>'id'=ri.item_id::text)
  THEN RAISE EXCEPTION 'Lokalne przyjęcie przekracza zatwierdzoną pozycję' USING ERRCODE='23514'; END IF;
 END LOOP;
 -- Stock and all bin/position rows are locked before the physical before snapshot.
 FOR product IN SELECT DISTINCT(comp->>'product_id')::uuid FROM return_items source_item CROSS JOIN LATERAL jsonb_array_elements(source_item.components) comp WHERE(source_item.tenant_id,source_item.return_id)=(t,rid) ORDER BY 1 LOOP
  PERFORM 1 FROM stock WHERE(tenant_id,warehouse_id,product_id)=(t,r.warehouse_id,product) FOR UPDATE;
  PERFORM 1 FROM stock_locations WHERE(tenant_id,warehouse_id,product_id)=(t,r.warehouse_id,product) ORDER BY location FOR UPDATE;
  PERFORM 1 FROM wms_layer_positions WHERE(tenant_id,warehouse_id,product_id)=(t,r.warehouse_id,product) ORDER BY location,layer_id FOR UPDATE;
 END LOOP;
 PERFORM b2b_return_local_auth(uid,kid,false);
 physical_before:=b2b_return_local_snapshot(rid);
 IF physical_before->'operations'<>'[]'::jsonb OR physical_before->'fragments'<>'[]'::jsonb
 OR physical_before->'layer_movements'<>'[]'::jsonb OR physical_before->'movements'<>'[]'::jsonb THEN
  RAISE EXCEPTION 'Lokalne RMA posiada już niezatwierdzone operacje przyjęcia' USING ERRCODE='23514';
 END IF;
 INSERT INTO b2b_return_local_proofs(id,tenant_id,origin_id,return_id,actor_id,api_key_id,transaction_id,transaction_started_at,request,before_snapshot)
 VALUES(pid,t,origin.id,rid,uid,kid,pg_current_xact_id(),transaction_timestamp(),body,physical_before);
 RETURN pid;
END $$;

CREATE FUNCTION b2b_return_local_receive_replay(rid uuid,uid uuid,kid uuid,body jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; p b2b_return_local_proofs%ROWTYPE; BEGIN
 PERFORM b2b_return_local_auth(uid,kid,false);
 SELECT * INTO p FROM b2b_return_local_proofs WHERE(tenant_id,return_id)=(t,rid) AND applied;
 IF NOT FOUND OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.request IS DISTINCT FROM body
 OR (SELECT receipt FROM return_cases WHERE(tenant_id,id)=(t,rid)) IS DISTINCT FROM body
 THEN RAISE EXCEPTION 'Lokalny replay dotyczy innego aktora lub przyjęcia' USING ERRCODE='23514'; END IF;
 PERFORM b2b_return_local_auth(uid,kid,true); RETURN true;
END $$;

CREATE FUNCTION b2b_return_local_finish(pid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE p b2b_return_local_proofs%ROWTYPE; r return_cases%ROWTYPE; ri return_items%ROWTYPE;
 original order_items%ROWTYPE; old_item jsonb; decision jsonb; product uuid; delta integer;
 before_stock jsonb; after_stock jsonb; prior integer; credit bigint; total_credit bigint;
 actual jsonb; before_quantity bigint; after_quantity bigint; bin_row record; position_row record; expected bigint;
BEGIN
 SELECT * INTO p FROM b2b_return_local_proofs WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=pid
 AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp() AND NOT applied FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak prywatnego dowodu lokalnego przyjęcia' USING ERRCODE='23514'; END IF;
 PERFORM b2b_return_local_auth(p.actor_id,p.api_key_id,false);
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(p.tenant_id,p.return_id);
 IF r.id IS NULL OR r.state<>'refund_pending' OR r.received_at IS NULL OR r.receipt IS DISTINCT FROM p.request
 OR r.version IS DISTINCT FROM (p.before_snapshot->'head'->>'version')::bigint+1
 OR to_jsonb(r)-ARRAY['state','received_at','receipt','receipt_sequence','refunded_shipping','refund_amount','decision_note','version','updated_at']
 IS DISTINCT FROM (p.before_snapshot->'head')-ARRAY['state','received_at','receipt','receipt_sequence','refunded_shipping','refund_amount','decision_note','version','updated_at']
 OR r.refunded_shipping IS DISTINCT FROM (p.request->>'shipping_refund')::int OR r.decision_note IS DISTINCT FROM p.request->>'note'
 OR r.receipt_sequence IS DISTINCT FROM (SELECT coalesce(max(rc.receipt_sequence),0)+1 FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(p.tenant_id,r.order_id) AND rc.id<>r.id)
 THEN RAISE EXCEPTION 'Lokalna decyzja nie odpowiada zatwierdzonej zgodzie' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM return_items WHERE(tenant_id,return_id)=(p.tenant_id,r.id))<>jsonb_array_length(p.before_snapshot->'items') THEN RAISE EXCEPTION 'Zmienił się pełny zakres lokalnego RMA' USING ERRCODE='23514'; END IF;
 total_credit:=r.refunded_shipping;
 FOR ri IN SELECT * FROM return_items WHERE(tenant_id,return_id)=(p.tenant_id,r.id) LOOP
  SELECT x.value INTO old_item FROM jsonb_array_elements(p.before_snapshot->'items') x WHERE x.value->>'item_id'=ri.item_id::text;
  SELECT x.value INTO decision FROM jsonb_array_elements(p.request->'items') x WHERE x.value->>'item_id'=ri.item_id::text;
  IF old_item IS NULL OR decision IS NULL OR to_jsonb(ri)-ARRAY['accepted','restocked','refund_amount'] IS DISTINCT FROM old_item-ARRAY['accepted','restocked','refund_amount']
  OR ri.accepted IS DISTINCT FROM (decision->>'accepted')::int OR ri.restocked IS DISTINCT FROM (decision->>'restocked')::int
  OR ri.accepted>ri.requested OR ri.restocked>ri.accepted THEN RAISE EXCEPTION 'Ilości odbioru nie odpowiadają lokalnej zgodzie' USING ERRCODE='23514'; END IF;
  SELECT * INTO original FROM order_items WHERE(tenant_id,order_id,id)=(p.tenant_id,r.order_id,ri.item_id);
  SELECT coalesce(sum(x.accepted),0)::int INTO prior FROM return_items x JOIN return_cases rc ON(rc.tenant_id,rc.id)=(x.tenant_id,x.return_id)
  WHERE(x.tenant_id,x.order_id,x.item_id)=(p.tenant_id,r.order_id,ri.item_id) AND rc.id<>r.id AND rc.state IN('refund_pending','closed');
  IF prior+ri.accepted>original.quantity THEN RAISE EXCEPTION 'Przekroczono oryginalną detaliczną ilość' USING ERRCODE='23514'; END IF;
  credit:=floor(original.line_total::numeric*(prior+ri.accepted)/original.quantity)-floor(original.line_total::numeric*prior/original.quantity);
  IF ri.refund_amount IS DISTINCT FROM credit THEN RAISE EXCEPTION 'Lokalny kredyt nie zachowuje historycznej ceny' USING ERRCODE='23514'; END IF;
  total_credit:=total_credit+credit;
 END LOOP;
 IF r.refund_amount IS DISTINCT FROM total_credit THEN RAISE EXCEPTION 'Nieprawidłowa suma lokalnego kredytu' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM stock_movements m WHERE(m.tenant_id,m.return_id)=(p.tenant_id,r.id) AND
  (m.order_id IS DISTINCT FROM r.order_id OR m.warehouse_id<>r.warehouse_id OR m.kind<>'return' OR m.delta<=0
  OR NOT EXISTS(SELECT 1 FROM return_items x CROSS JOIN LATERAL jsonb_array_elements(x.components) c WHERE(x.tenant_id,x.return_id)=(p.tenant_id,r.id) AND c->>'product_id'=m.product_id::text)))
 THEN RAISE EXCEPTION 'Obcy ruch lokalnego przyjęcia' USING ERRCODE='23514'; END IF;
 FOR product IN SELECT DISTINCT(comp->>'product_id')::uuid FROM return_items x CROSS JOIN LATERAL jsonb_array_elements(x.components) comp WHERE(x.tenant_id,x.return_id)=(p.tenant_id,r.id) LOOP
  SELECT coalesce(sum(x.restocked*(comp->>'quantity')::int),0)::int INTO delta FROM return_items x CROSS JOIN LATERAL jsonb_array_elements(x.components) comp WHERE(x.tenant_id,x.return_id)=(p.tenant_id,r.id) AND comp->>'product_id'=product::text;
  SELECT x.value INTO before_stock FROM jsonb_array_elements(p.before_snapshot->'stock') x WHERE x.value->>'product_id'=product::text;
  SELECT to_jsonb(st) INTO after_stock FROM stock st WHERE(st.tenant_id,st.warehouse_id,st.product_id)=(p.tenant_id,r.warehouse_id,product);
  IF coalesce((after_stock->>'on_hand')::bigint,0)<>coalesce((before_stock->>'on_hand')::bigint,0)+delta
  OR coalesce((after_stock->>'reserved')::bigint,0)<>coalesce((before_stock->>'reserved')::bigint,0)
  OR (delta=0 AND after_stock IS DISTINCT FROM before_stock)
  OR (SELECT coalesce(sum(m.delta),0) FROM stock_movements m WHERE(m.tenant_id,m.return_id,m.product_id)=(p.tenant_id,r.id,product))<>delta
  OR (SELECT count(*) FROM stock_movements m WHERE(m.tenant_id,m.return_id,m.product_id)=(p.tenant_id,r.id,product))<>(CASE WHEN delta>0 THEN 1 ELSE 0 END)
  THEN RAISE EXCEPTION 'Brak rzeczywistego lokalnego przyjęcia stanu i dziennika' USING ERRCODE='23514'; END IF;
  FOR bin_row IN SELECT loc FROM (
   SELECT x.value->>'location' loc FROM jsonb_array_elements(p.before_snapshot->'bins') x WHERE x.value->>'product_id'=product::text
   UNION SELECT location FROM stock_locations WHERE(tenant_id,warehouse_id,product_id)=(p.tenant_id,r.warehouse_id,product)
  ) locations LOOP
   SELECT coalesce(sum((x.value->>'quantity')::bigint),0) INTO before_quantity FROM jsonb_array_elements(p.before_snapshot->'bins') x WHERE x.value->>'product_id'=product::text AND x.value->>'location'=bin_row.loc;
   SELECT coalesce(sum(quantity),0) INTO after_quantity FROM stock_locations WHERE(tenant_id,warehouse_id,product_id,location)=(p.tenant_id,r.warehouse_id,product,bin_row.loc);
   IF EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=p.tenant_id AND enabled) THEN
    SELECT coalesce(sum(f.quantity),0) INTO expected FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id,f.product_id,f.location)=(p.tenant_id,r.id,product,bin_row.loc);
   ELSE expected:=CASE WHEN bin_row.loc='ZWROT' THEN delta ELSE 0 END; END IF;
   IF after_quantity<>before_quantity+expected THEN RAISE EXCEPTION 'Lokacja odbioru nie odpowiada rzeczywistemu przyjęciu' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=p.tenant_id AND enabled) THEN
   IF delta>0 AND NOT(p.request ? 'wms_lots') THEN RAISE EXCEPTION 'Lokalny WMS wymaga rzeczywistych fragmentów odbioru' USING ERRCODE='23514'; END IF;
   IF (SELECT coalesce(sum(f.quantity),0) FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id,f.product_id)=(p.tenant_id,r.id,product))<>delta THEN RAISE EXCEPTION 'Brak rzeczywistych lokalnych fragmentów WMS' USING ERRCODE='23514'; END IF;
   FOR position_row IN SELECT loc,layer FROM (
    SELECT x.value->>'location' loc,(x.value->>'layer_id')::uuid layer FROM jsonb_array_elements(p.before_snapshot->'positions') x WHERE x.value->>'product_id'=product::text
    UNION SELECT location,layer_id FROM wms_layer_positions WHERE(tenant_id,warehouse_id,product_id)=(p.tenant_id,r.warehouse_id,product)
   ) positions LOOP
    SELECT coalesce(sum((x.value->>'quantity')::bigint),0) INTO before_quantity FROM jsonb_array_elements(p.before_snapshot->'positions') x WHERE x.value->>'product_id'=product::text AND x.value->>'location'=position_row.loc AND x.value->>'layer_id'=position_row.layer::text;
    SELECT coalesce(sum(quantity),0) INTO after_quantity FROM wms_layer_positions WHERE(tenant_id,warehouse_id,product_id,location,layer_id)=(p.tenant_id,r.warehouse_id,product,position_row.loc,position_row.layer);
    SELECT coalesce(sum(f.quantity),0) INTO expected FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id,f.product_id,f.location,f.layer_id)=(p.tenant_id,r.id,product,position_row.loc,position_row.layer);
    IF after_quantity<>before_quantity+expected THEN RAISE EXCEPTION 'Nieodtworzona lokalna pozycja kosztowa' USING ERRCODE='23514'; END IF;
   END LOOP;
  ELSE
   IF EXISTS(SELECT 1 FROM wms_return_fragments WHERE(tenant_id,return_id)=(p.tenant_id,r.id)) THEN RAISE EXCEPTION 'WMS OFF nie tworzy lokalnych fragmentów partii' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM wms_return_fragments f JOIN wms_issue_fragments iss ON(iss.tenant_id,iss.id)=(f.tenant_id,f.issue_fragment_id)
  JOIN wms_operations op ON(op.tenant_id,op.id)=(f.tenant_id,f.operation_id)
  WHERE(f.tenant_id,f.return_id)=(p.tenant_id,r.id) AND
  (iss.order_id IS DISTINCT FROM r.order_id OR f.order_id IS DISTINCT FROM r.order_id OR f.warehouse_id<>r.warehouse_id
   OR op.kind<>'return' OR op.actor_id IS DISTINCT FROM p.actor_id OR op.order_id IS DISTINCT FROM r.order_id OR op.return_id IS DISTINCT FROM r.id
   OR op.client_key IS DISTINCT FROM (p.request->'wms_lots'->>'client_key')::uuid OR op.policy_version IS DISTINCT FROM (p.request->'wms_lots'->>'policy_version')::bigint
   OR op.request IS DISTINCT FROM p.request OR f.product_id<>iss.product_id OR f.layer_id<>iss.layer_id
   OR f.value_minor IS DISTINCT FROM iss.unit_cost_minor*f.quantity
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.request->'wms_lots'->'picks') pick WHERE pick->>'issue_fragment_id'=f.issue_fragment_id::text AND pick->>'location'=f.location AND (pick->>'quantity')::int=f.quantity)
   OR NOT EXISTS(SELECT 1 FROM wms_layer_movements lm WHERE(lm.tenant_id,lm.operation_id,lm.layer_id,lm.product_id,lm.location)=(f.tenant_id,f.operation_id,f.layer_id,f.product_id,f.location) AND lm.delta=f.quantity AND lm.value_delta IS NOT DISTINCT FROM f.value_minor)))
 THEN RAISE EXCEPTION 'Lokalny koszt lub wybór partii nie odpowiada zgodzie' USING ERRCODE='23514'; END IF;
 IF p.request ? 'wms_lots' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.request->'wms_lots'->'picks') pick WHERE NOT EXISTS(SELECT 1 FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id,f.issue_fragment_id,f.location,f.quantity)=(p.tenant_id,r.id,(pick->>'issue_fragment_id')::uuid,pick->>'location',(pick->>'quantity')::int))) THEN RAISE EXCEPTION 'Brakuje zatwierdzonego lokalnego fragmentu' USING ERRCODE='23514'; END IF;
 actual:=b2b_return_local_snapshot(r.id);
 -- OFF cannot adopt arbitrary WMS evidence. ON may add exactly the typed return
 -- operation and a multiset of journal rows matching its genuine fragments.
 IF actual->'layers' IS DISTINCT FROM p.before_snapshot->'layers' THEN
  RAISE EXCEPTION 'Lokalny zwrot zmienił historyczne warstwy kosztowe' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=p.tenant_id AND enabled)
 OR NOT EXISTS(SELECT 1 FROM return_items WHERE(tenant_id,return_id)=(p.tenant_id,r.id) AND restocked>0) THEN
  IF actual->'operations' IS DISTINCT FROM p.before_snapshot->'operations'
  OR actual->'fragments' IS DISTINCT FROM p.before_snapshot->'fragments'
  OR actual->'layer_movements' IS DISTINCT FROM p.before_snapshot->'layer_movements'
  OR actual->'positions' IS DISTINCT FROM p.before_snapshot->'positions' THEN
   RAISE EXCEPTION 'WMS OFF lub odbiór bez stanu zmienił lokalne dowody partii' USING ERRCODE='23514';
  END IF;
 ELSE
  IF jsonb_array_length(actual->'operations')<>1 OR EXISTS(
   SELECT 1 FROM wms_operations op WHERE(op.tenant_id,op.return_id)=(p.tenant_id,r.id) AND
    (op.kind IS DISTINCT FROM 'return' OR op.actor_id IS DISTINCT FROM p.actor_id
     OR op.order_id IS DISTINCT FROM r.order_id OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL
     OR op.client_key IS DISTINCT FROM (p.request->'wms_lots'->>'client_key')::uuid
     OR op.policy_version IS DISTINCT FROM (p.request->'wms_lots'->>'policy_version')::bigint
     OR op.request IS DISTINCT FROM p.request)) THEN
   RAISE EXCEPTION 'Dodatkowa lub niezatwierdzona operacja lokalnego WMS' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
   (SELECT lm.operation_id,lm.warehouse_id,lm.product_id,lm.location,lm.layer_id,lm.delta,lm.value_delta,lm.kind
    FROM wms_layer_movements lm JOIN wms_operations op ON(op.tenant_id,op.id)=(lm.tenant_id,lm.operation_id)
    WHERE(op.tenant_id,op.return_id)=(p.tenant_id,r.id)
    EXCEPT ALL
    SELECT f.operation_id,f.warehouse_id,f.product_id,f.location,f.layer_id,f.quantity,f.value_minor,'return'::text
    FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(p.tenant_id,r.id))
   UNION ALL
   (SELECT f.operation_id,f.warehouse_id,f.product_id,f.location,f.layer_id,f.quantity,f.value_minor,'return'::text
    FROM wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(p.tenant_id,r.id)
    EXCEPT ALL
    SELECT lm.operation_id,lm.warehouse_id,lm.product_id,lm.location,lm.layer_id,lm.delta,lm.value_delta,lm.kind
    FROM wms_layer_movements lm JOIN wms_operations op ON(op.tenant_id,op.id)=(lm.tenant_id,lm.operation_id)
    WHERE(op.tenant_id,op.return_id)=(p.tenant_id,r.id))) THEN
   RAISE EXCEPTION 'Dodatkowy lub brakujący journal lokalnego WMS' USING ERRCODE='23514';
  END IF;
 END IF;
 IF octet_length(actual::text)+octet_length(p.before_snapshot::text)>8388608 THEN RAISE EXCEPTION 'Za duży fizyczny dowód lokalnego RMA' USING ERRCODE='23514'; END IF;
 UPDATE b2b_return_local_proofs SET applied=true,after_snapshot=actual WHERE id=p.id;
END $$;

CREATE FUNCTION b2b_return_local_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Lokalne pochodzenie RMA jest niezmienne' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON b2b_return_local_origins FOR EACH ROW EXECUTE FUNCTION b2b_return_local_immutable();
CREATE FUNCTION b2b_return_local_private_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Prywatny lokalny dowód jest niezmienny' USING ERRCODE='23514'; END IF;
 IF OLD.applied OR NOT NEW.applied OR NEW.after_snapshot IS NULL OR to_jsonb(NEW)-ARRAY['applied','after_snapshot'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['applied','after_snapshot'] THEN RAISE EXCEPTION 'Prywatny lokalny dowód jest niezmienny' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON b2b_return_local_proofs FOR EACH ROW EXECUTE FUNCTION b2b_return_local_private_guard();

CREATE FUNCTION b2b_return_local_budget() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE subject uuid:=NEW.tenant_id; bytes bigint; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.return.local:'||subject::text,0));
 IF (SELECT count(*) FROM b2b_return_local_origins WHERE tenant_id=subject)>2000 THEN RAISE EXCEPTION 'Limit lokalnych źródeł RMA: 2000 zgód' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(sum(octet_length(body::text)),0) INTO bytes FROM (
  SELECT to_jsonb(o) body FROM b2b_return_local_origins o WHERE o.tenant_id=subject
  UNION ALL SELECT to_jsonb(p) FROM b2b_return_local_proofs p WHERE p.tenant_id=subject
 ) all_proofs;
 IF bytes>134217728 THEN RAISE EXCEPTION 'Limit lokalnych źródeł RMA: 128 MiB dowodów' USING ERRCODE='P0001'; END IF;
 IF octet_length(to_jsonb(NEW)::text)>8388608 THEN RAISE EXCEPTION 'Za duży pełny dowód lokalnego RMA' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER budget AFTER INSERT ON b2b_return_local_origins FOR EACH ROW EXECUTE FUNCTION b2b_return_local_budget();
CREATE TRIGGER budget AFTER INSERT OR UPDATE ON b2b_return_local_proofs FOR EACH ROW EXECUTE FUNCTION b2b_return_local_budget();

CREATE FUNCTION b2b_return_local_origin_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE saved_scope text; choices jsonb; BEGIN
 saved_scope:=current_setting('app.tenant_id',true); PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 PERFORM b2b_return_local_auth(NEW.actor_id,NEW.api_key_id,false);
 choices:=b2b_return_local_choices(NEW.return_id,NEW.actor_id,NEW.api_key_id);
 IF choices IS NULL OR NEW.snapshot IS DISTINCT FROM choices->'snapshot' OR NEW.scope_hash IS DISTINCT FROM choices->>'scope_hash'
 OR EXISTS(SELECT 1 FROM b2b_dropship_return_cases WHERE(tenant_id,return_id)=(NEW.tenant_id,NEW.return_id)) THEN RAISE EXCEPTION 'Niekompletny wybór lokalnego pochodzenia' USING ERRCODE='23514'; END IF;
 PERFORM b2b_return_local_auth(NEW.actor_id,NEW.api_key_id,true);
 PERFORM set_config('app.tenant_id',coalesce(saved_scope,''),true); RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete AFTER INSERT ON b2b_return_local_origins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_return_local_origin_complete();

CREATE FUNCTION b2b_return_local_proof_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE saved_scope text; p b2b_return_local_proofs%ROWTYPE; BEGIN
 SELECT * INTO p FROM b2b_return_local_proofs WHERE id=NEW.id;
 saved_scope:=current_setting('app.tenant_id',true); PERFORM set_config('app.tenant_id',p.tenant_id::text,true);
 IF NOT p.applied OR p.after_snapshot IS NULL OR b2b_return_local_snapshot(p.return_id) IS DISTINCT FROM p.after_snapshot THEN RAISE EXCEPTION 'Niekompletny fizyczny dowód lokalnego RMA' USING ERRCODE='23514'; END IF;
 PERFORM b2b_return_local_auth(p.actor_id,p.api_key_id,true);
 PERFORM set_config('app.tenant_id',coalesce(saved_scope,''),true); RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER proof_complete AFTER INSERT ON b2b_return_local_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_return_local_proof_complete();

-- An origin's original RMA and commercial scope cannot be rewritten. Decisions may
-- release an unreceived local reservation; acceptance always needs a private proof.
CREATE FUNCTION b2b_return_local_rma_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old_json jsonb; new_json jsonb; t uuid; rid uuid; origin b2b_return_local_origins%ROWTYPE; proof b2b_return_local_proofs%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN new_json:=to_jsonb(NEW); ELSE old_json:=to_jsonb(OLD); END IF;
 IF TG_OP='UPDATE' THEN new_json:=to_jsonb(NEW); END IF;
 t:=coalesce(new_json->>'tenant_id',old_json->>'tenant_id')::uuid;
 rid:=(CASE WHEN TG_TABLE_NAME='return_cases' THEN coalesce(new_json->>'id',old_json->>'id') ELSE coalesce(new_json->>'return_id',old_json->>'return_id') END)::uuid;
 IF to_regclass('public.b2b_return_local_origins') IS NULL THEN RAISE EXCEPTION 'Niekompletna kopia lokalnego pochodzenia RMA' USING ERRCODE='23514'; END IF;
 -- Existing111 typed partner guards remain authoritative and unchanged.
 IF EXISTS(SELECT 1 FROM b2b_dropship_return_cases WHERE(tenant_id,return_id)=(t,rid)) OR EXISTS(SELECT 1 FROM b2b_dropship_return_supplier_cases WHERE(tenant_id,return_id)=(t,rid)) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 SELECT * INTO origin FROM b2b_return_local_origins WHERE(tenant_id,return_id)=(t,rid);
 IF origin.id IS NULL THEN
  IF TG_OP='INSERT' THEN
   IF TG_TABLE_NAME='return_cases' THEN
    IF EXISTS(SELECT 1 FROM b2b_dropship_orders d WHERE(d.tenant_id,d.customer_order_id)=(t,(new_json->>'order_id')::uuid) AND d.state='ordered')
    AND (new_json->>'state' IS DISTINCT FROM 'requested' OR new_json->'received_at' IS DISTINCT FROM 'null'::jsonb
     OR new_json->'receipt' IS DISTINCT FROM 'null'::jsonb OR new_json->'settlement' IS DISTINCT FROM 'null'::jsonb
     OR new_json->'refunded_at' IS DISTINCT FROM 'null'::jsonb OR new_json->'refund_amount' IS DISTINCT FROM '0'::jsonb
     OR new_json->'refunded_shipping' IS DISTINCT FROM '0'::jsonb OR new_json->'receipt_sequence' IS DISTINCT FROM '0'::jsonb)
    THEN RAISE EXCEPTION 'Nowe zewnętrzne RMA nie może zawierać fizycznego przyjęcia' USING ERRCODE='23514'; END IF;
   ELSE
    IF EXISTS(SELECT 1 FROM b2b_dropship_lines dl JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(dl.tenant_id,dl.order_id)
     WHERE(dl.tenant_id,dl.customer_order_id,dl.customer_item_id)=(t,(new_json->>'order_id')::uuid,(new_json->>'item_id')::uuid) AND d.state='ordered')
    AND (new_json->'accepted' IS DISTINCT FROM '0'::jsonb OR new_json->'restocked' IS DISTINCT FROM '0'::jsonb OR new_json->'refund_amount' IS DISTINCT FROM '0'::jsonb)
    THEN RAISE EXCEPTION 'Nowa zewnętrzna pozycja RMA nie może zawierać przyjęcia' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
   IF (TG_TABLE_NAME='return_cases' AND new_json->'received_at' IS DISTINCT FROM old_json->'received_at' AND new_json->'received_at'<>'null'::jsonb)
   OR (TG_TABLE_NAME='return_items' AND (new_json->'accepted' IS DISTINCT FROM old_json->'accepted' OR new_json->'restocked' IS DISTINCT FROM old_json->'restocked')) THEN
    IF EXISTS(SELECT 1 FROM return_items ri JOIN b2b_dropship_lines dl ON(dl.tenant_id,dl.customer_order_id,dl.customer_item_id)=(ri.tenant_id,ri.order_id,ri.item_id) JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(dl.tenant_id,dl.order_id) WHERE(ri.tenant_id,ri.return_id)=(t,rid) AND d.state='ordered') THEN RAISE EXCEPTION 'Zewnętrzny zwrot wymaga jawnego pochodzenia lub przyjęcia partnera' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END IF;
 IF TG_OP IN('INSERT','DELETE') THEN RAISE EXCEPTION 'Nie wolno zmieniać wybranego zakresu lokalnego RMA' USING ERRCODE='23514'; END IF;
 SELECT * INTO proof FROM b2b_return_local_proofs WHERE(tenant_id,return_id)=(t,rid) AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 IF proof.id IS NOT NULL AND NOT proof.applied THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='return_cases' THEN
  IF old_json->>'state'='requested' AND new_json->>'state' IN('cancelled','rejected')
  AND new_json-ARRAY['state','decision_note','version','updated_at'] IS NOT DISTINCT FROM old_json-ARRAY['state','decision_note','version','updated_at'] THEN RETURN NEW; END IF;
  IF old_json->>'state'='refund_pending' AND new_json->>'state'='closed' AND new_json->'settlement'<>'null'::jsonb
  AND new_json-ARRAY['state','settlement','refunded_at','version','updated_at'] IS NOT DISTINCT FROM old_json-ARRAY['state','settlement','refunded_at','version','updated_at'] THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Lokalne przyjęcie wymaga prywatnego dowodu' USING ERRCODE='23514';
END $$;
CREATE TRIGGER local_origin_guard BEFORE INSERT OR UPDATE OR DELETE ON return_cases FOR EACH ROW EXECUTE FUNCTION b2b_return_local_rma_guard();
CREATE TRIGGER local_origin_guard BEFORE INSERT OR UPDATE OR DELETE ON return_items FOR EACH ROW EXECUTE FUNCTION b2b_return_local_rma_guard();

-- Insertion ordering cannot hide a future external item behind a head without rows.
-- This checks the final complete RMA, not just the row visible to its INSERT trigger.
CREATE FUNCTION b2b_return_local_initial_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE row_json jsonb:=to_jsonb(NEW); t uuid:=(row_json->>'tenant_id')::uuid; rid uuid;
 r return_cases%ROWTYPE; p b2b_return_local_proofs%ROWTYPE; BEGIN
 rid:=(CASE WHEN TG_TABLE_NAME='return_cases' THEN row_json->>'id' ELSE row_json->>'return_id' END)::uuid;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(t,rid);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM return_items ri JOIN b2b_dropship_lines dl
  ON(dl.tenant_id,dl.customer_order_id,dl.customer_item_id)=(ri.tenant_id,ri.order_id,ri.item_id)
  JOIN b2b_dropship_orders d ON(d.tenant_id,d.id)=(dl.tenant_id,dl.order_id)
  WHERE(ri.tenant_id,ri.return_id)=(t,rid) AND d.state='ordered')
 AND NOT EXISTS(SELECT 1 FROM b2b_return_local_origins WHERE(tenant_id,return_id)=(t,rid)) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM b2b_dropship_return_proofs bp WHERE(bp.tenant_id,bp.return_id)=(t,rid)
  AND bp.applied AND bp.transaction_id=pg_current_xact_id() AND bp.transaction_started_at=transaction_timestamp()) THEN RETURN NULL; END IF;
 SELECT * INTO p FROM b2b_return_local_proofs WHERE(tenant_id,return_id)=(t,rid)
 AND applied AND transaction_id=pg_current_xact_id() AND transaction_started_at=transaction_timestamp();
 IF p.id IS NOT NULL THEN RETURN NULL; END IF;
 IF r.state NOT IN('requested','cancelled','rejected') OR r.received_at IS NOT NULL OR r.receipt IS NOT NULL
 OR r.settlement IS NOT NULL OR r.refunded_at IS NOT NULL OR r.refund_amount<>0 OR r.refunded_shipping<>0 OR r.receipt_sequence<>0
 OR EXISTS(SELECT 1 FROM return_items ri WHERE(ri.tenant_id,ri.return_id)=(t,rid) AND(ri.accepted<>0 OR ri.restocked<>0 OR ri.refund_amount<>0))
 THEN RAISE EXCEPTION 'Brak pełnego dowodu przyjęcia nowego zewnętrznego RMA' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(r.request->'items') IS DISTINCT FROM 'array'
 OR jsonb_array_length(r.request->'items')<>(SELECT count(*) FROM return_items WHERE(tenant_id,return_id)=(t,rid))
 OR EXISTS(SELECT 1 FROM return_items ri JOIN order_items oi ON(oi.tenant_id,oi.order_id,oi.id)=(ri.tenant_id,ri.order_id,ri.item_id)
 WHERE(ri.tenant_id,ri.return_id)=(t,rid) AND(ri.sku IS DISTINCT FROM oi.sku OR ri.name IS DISTINCT FROM oi.name
 OR ri.components IS DISTINCT FROM (CASE WHEN jsonb_array_length(oi.components)>0 THEN oi.components ELSE jsonb_build_array(jsonb_build_object('product_id',oi.product_id,'quantity',1)) END)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.request->'items') req WHERE req->>'item_id'=ri.item_id::text AND req->'quantity'=to_jsonb(ri.requested))))
 THEN RAISE EXCEPTION 'Niekompletny pierwotny zakres zewnętrznego RMA' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER local_origin_complete AFTER INSERT ON return_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_return_local_initial_complete();
CREATE CONSTRAINT TRIGGER local_origin_complete AFTER INSERT ON return_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_return_local_initial_complete();

CREATE FUNCTION b2b_return_local_bridge_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF to_regclass('public.b2b_return_local_origins') IS NULL THEN RAISE EXCEPTION 'Niekompletna kopia lokalnego pochodzenia RMA' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM b2b_return_local_origins WHERE(tenant_id,return_id)=(NEW.tenant_id,NEW.return_id)) THEN RAISE EXCEPTION 'Lokalne RMA nie może stać się przekazaniem partnerowym' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER local_origin_guard BEFORE INSERT ON b2b_dropship_return_previews FOR EACH ROW EXECUTE FUNCTION b2b_return_local_bridge_guard();
CREATE TRIGGER local_origin_guard BEFORE INSERT ON b2b_dropship_return_cases FOR EACH ROW EXECUTE FUNCTION b2b_return_local_bridge_guard();

-- Savepoint-safe, durable terminal seal. Historic restored xid coincidence cannot block
-- a new transaction because the original transaction timestamp must match as well.
CREATE FUNCTION b2b_return_local_seal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actual_tenant uuid; row_json jsonb; BEGIN
 row_json:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 actual_tenant:=(row_json->>'tenant_id')::uuid;
 IF to_regclass('public.b2b_return_local_proofs') IS NULL THEN RAISE EXCEPTION 'Niekompletna kopia fizycznego dowodu lokalnego RMA' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM b2b_return_local_proofs p WHERE p.tenant_id=actual_tenant AND p.applied AND p.transaction_id=pg_current_xact_id() AND p.transaction_started_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Końcowy dowód lokalnego RMA zamknął zapisy w tej transakcji' USING ERRCODE='23514'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['stock','stock_locations','stock_movements','wms_layer_positions','wms_layer_movements','wms_return_fragments','wms_operations','return_cases','return_items','orders','order_items','shipments'] LOOP
  EXECUTE format('CREATE TRIGGER local_return_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_return_local_seal()',tab);
 END LOOP;
END $$;
-- Helpers not exposed to callers cannot be used as cross-firm proof oracles.
REVOKE ALL ON FUNCTION b2b_return_local_auth(uuid,uuid,boolean),b2b_return_local_snapshot(uuid),b2b_return_local_origin_complete(),b2b_return_local_proof_complete(),b2b_return_local_rma_guard(),b2b_return_local_bridge_guard(),b2b_return_local_seal() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION b2b_return_local_immutable(),b2b_return_local_private_guard(),b2b_return_local_budget() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION b2b_return_local_initial_complete() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION b2b_return_local_installed(),b2b_return_local_external(uuid),b2b_return_local_choices(uuid,uuid,uuid),b2b_return_local_select(uuid,uuid,uuid,jsonb),b2b_return_local_prepare(uuid,uuid,uuid,jsonb),b2b_return_local_finish(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_return_local_installed(),b2b_return_local_external(uuid),b2b_return_local_choices(uuid,uuid,uuid),b2b_return_local_select(uuid,uuid,uuid,jsonb),b2b_return_local_prepare(uuid,uuid,uuid,jsonb),b2b_return_local_finish(uuid) TO dyna_app;
REVOKE ALL ON FUNCTION b2b_return_local_receive_replay(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION b2b_return_local_receive_replay(uuid,uuid,uuid,jsonb) TO dyna_app;
