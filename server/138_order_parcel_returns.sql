-- Explicit commercial origins for early returns. Historical physical plans are not inferred.
CREATE TABLE order_parcel_return_claims (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,origin_id uuid NOT NULL,dispatch_id uuid NOT NULL,item_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 499),quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
 PRIMARY KEY(tenant_id,return_id,origin_id),UNIQUE(tenant_id,return_id,ordinal),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,origin_id,order_id) REFERENCES order_parcel_commercial_origins(tenant_id,id,order_id),
 FOREIGN KEY(tenant_id,origin_id,dispatch_id) REFERENCES order_parcel_origin_issues(tenant_id,origin_id,dispatch_id),
 FOREIGN KEY(tenant_id,order_id,item_id) REFERENCES order_items(tenant_id,order_id,id)
);
CREATE TABLE order_parcel_return_receipts (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 body jsonb NOT NULL,payload jsonb NOT NULL,before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,return_id),FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE order_parcel_return_admissions (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('request','receive','decision')),
 transaction_id xid8 NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,body jsonb NOT NULL,payload jsonb NOT NULL,before_snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,return_id,kind),FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
DO $$DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['order_parcel_return_claims','order_parcel_return_receipts','order_parcel_return_admissions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',rel);
 END LOOP;
END $$;
GRANT SELECT ON order_parcel_return_claims,order_parcel_return_receipts TO dyna_app;

CREATE FUNCTION order_parcel_return_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT current_setting('session_replication_role')='origin' AND EXISTS(SELECT 1 FROM migrations WHERE name='138_order_parcel_returns')
 AND to_regclass('order_parcel_return_claims') IS NOT NULL AND to_regclass('order_parcel_return_receipts') IS NOT NULL AND to_regclass('order_parcel_return_admissions') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_return_claims','order_parcel_return_receipts','order_parcel_return_admissions']) n WHERE NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(n) AND relrowsecurity AND relforcerowsecurity))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_return_claims','order_parcel_return_receipts','order_parcel_return_admissions']) n WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(n) AND tgname='private_guard' AND tgfoid=to_regprocedure('order_parcel_return_private_guard()') AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(n) AND tgname='immutable' AND tgfoid=to_regprocedure('order_parcel_return_immutable()') AND tgenabled='O'))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_return_validate_request(uuid,uuid,uuid,uuid,jsonb)','order_parcel_return_validate_receive(uuid,uuid,uuid,jsonb,jsonb)','order_parcel_return_validate_physical(order_parcel_return_admissions)','order_parcel_return_complete()','order_parcel_return_snapshot(uuid)','order_parcel_return_lock(uuid,uuid,uuid)','order_parcel_return_budget()','order_parcel_return_guard()','order_parcel_return_private_guard()','order_parcel_return_immutable()','order_parcel_return_seal()','order_parcel_return_request(uuid,uuid,uuid,uuid,jsonb)','order_parcel_return_finish_request(uuid,uuid,uuid)','order_parcel_return_prepare_receive(uuid,uuid,uuid,jsonb,jsonb)','order_parcel_return_finish_receive(uuid,uuid,uuid)','order_parcel_return_decision(uuid,uuid,uuid,jsonb)']) f WHERE to_regprocedure(f) IS NULL)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('order_parcel_return_admissions') AND tgname='order_parcel_return_complete' AND tgfoid=to_regprocedure('order_parcel_return_complete()') AND tgdeferrable AND tginitdeferred AND tgenabled='O')
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['return_cases','return_items']) n WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(n) AND tgname='order_parcel_return_guard' AND tgfoid=to_regprocedure('order_parcel_return_guard()') AND tgenabled='O'))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['return_cases','return_items','orders','order_items','shipments','stock','stock_locations','stock_movements','stock_location_movements','wms_layer_positions','wms_layer_movements','wms_return_fragments','wms_operations','reservations','reservation_locations','wms_reservation_layers','payment_entries','documents']) n WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(n) AND tgname='order_parcel_return_seal' AND tgfoid=to_regprocedure('order_parcel_return_seal()') AND tgenabled='O'))
 AND to_regprocedure('b2b_return_local_snapshot(uuid)') IS NOT NULL
 AND to_regprocedure('order_parcel_return_shipping_limit(uuid,uuid,bigint)') IS NOT NULL
 AND to_regprocedure('order_parcel_return_request_head_matches(return_cases,uuid,jsonb)') IS NOT NULL
 AND NOT(has_table_privilege('dyna_app','order_parcel_return_admissions','SELECT') OR has_table_privilege('dyna_app','order_parcel_return_admissions','INSERT') OR has_table_privilege('dyna_app','order_parcel_return_admissions','UPDATE') OR has_table_privilege('dyna_app','order_parcel_return_admissions','DELETE'))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_return_claims','order_parcel_return_receipts']) n WHERE has_table_privilege('dyna_app',n,'INSERT') OR has_table_privilege('dyna_app',n,'UPDATE') OR has_table_privilege('dyna_app',n,'DELETE'))
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['order_parcel_return_claims','order_parcel_return_receipts','order_parcel_return_admissions']) n WHERE NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(n) AND contype='f' AND convalidated))
$$;
-- All callers hold the shared quota/order lock before checking the current shipping pool.
-- Requested cases reserve their claim; completed receipts consume only the accepted amount.
CREATE FUNCTION order_parcel_return_shipping_limit(oid uuid,rid uuid,amount bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;cost bigint;used bigint;BEGIN
 SELECT shipping_cost INTO cost FROM orders WHERE tenant_id=t AND id=oid;
 SELECT coalesce(sum(CASE WHEN state='requested' THEN requested_shipping WHEN state IN('refund_pending','closed') THEN refunded_shipping ELSE 0 END),0) INTO used
 FROM return_cases WHERE tenant_id=t AND order_id=oid AND id IS DISTINCT FROM rid;
 IF cost IS NULL OR amount IS NULL OR amount NOT BETWEEN 0 AND 1000000 OR used+amount>cost THEN RAISE EXCEPTION 'Zwrot dostawy przekracza bieżący koszt dostawy zamówienia' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION order_parcel_return_request_head_matches(r return_cases,oid uuid,b jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT r.tenant_id IS NOT DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid AND r.order_id IS NOT DISTINCT FROM oid
 AND r.request IS NOT DISTINCT FROM b AND r.client_key IS NOT DISTINCT FROM (b->>'client_key')::uuid
 AND r.kind IS NOT DISTINCT FROM b->>'kind' AND r.reason IS NOT DISTINCT FROM b->>'reason'
 AND r.requested_shipping IS NOT DISTINCT FROM (b->>'shipping_refund')::integer
 AND EXISTS(SELECT 1 FROM orders o WHERE o.tenant_id=r.tenant_id AND o.id=oid AND r.warehouse_id=coalesce((b->>'warehouse_id')::uuid,o.warehouse_id))
 AND r.legacy IS FALSE AND r.submitted_by='operator' AND r.remedy='refund' AND r.state='requested' AND r.version=1
 AND r.decision_note='' AND r.receipt IS NULL AND r.received_at IS NULL AND r.refund_amount=0 AND r.refunded_shipping=0
 AND r.settlement IS NULL AND r.receipt_sequence=0 AND r.refunded_at IS NULL
$$;
CREATE FUNCTION order_parcel_return_snapshot(rid uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
 SELECT b2b_return_local_snapshot(rid)||jsonb_build_object(
  'fulfillment',order_parcel_snapshot(r.order_id),
  'original_items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM order_items i WHERE i.tenant_id=r.tenant_id AND i.order_id=r.order_id),'[]'),
  'location_movements',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM stock_location_movements m WHERE(m.tenant_id,m.warehouse_id)=(r.tenant_id,r.warehouse_id) AND m.product_id IN(SELECT(comp->>'product_id')::uuid FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp WHERE(ri.tenant_id,ri.return_id)=(r.tenant_id,r.id))),'[]'),
  'payments',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM payment_entries i WHERE i.tenant_id=r.tenant_id AND i.order_id=r.order_id),'[]'),
  'documents',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM documents i WHERE i.tenant_id=r.tenant_id AND i.order_id=r.order_id),'[]'))
 FROM return_cases r WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND r.id=rid
$$;
CREATE FUNCTION order_parcel_return_validate_request(oid uuid,rid uuid,uid uuid,kid uuid,b jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;x jsonb;i jsonb;origin order_parcel_commercial_origins;issued integer;used bigint;BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_lock(oid);
 IF NOT order_parcel_return_installed() THEN RAISE EXCEPTION 'Niekompletny moduł pochodzenia zwrotów' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid AND payload->>'protocol'='commercial_v1') THEN RAISE EXCEPTION 'Brak handlowego pochodzenia paczek' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR b-ARRAY['client_key','parcel_origins','kind','reason','warehouse_id','shipping_refund','items']<>'{}'::jsonb
 OR jsonb_typeof(b->'client_key') IS DISTINCT FROM 'string' OR coalesce(b->>'client_key','')!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR jsonb_typeof(b->'kind') IS DISTINCT FROM 'string' OR b->>'kind' NOT IN('return','complaint')
 OR jsonb_typeof(b->'reason') IS DISTINCT FROM 'string' OR char_length(b->>'reason') NOT BETWEEN 3 AND 2000 OR b->>'reason' IS DISTINCT FROM btrim(b->>'reason')
 OR (b?'warehouse_id' AND (jsonb_typeof(b->'warehouse_id') IS DISTINCT FROM 'string' OR coalesce(b->>'warehouse_id','')!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
 OR jsonb_typeof(b->'shipping_refund') IS DISTINCT FROM 'number' OR coalesce(b->>'shipping_refund','')!~ '^[0-9]+$'
 THEN RAISE EXCEPTION 'Nagłówek żądania RMA nie odpowiada kontraktowi' USING ERRCODE='23514';END IF;
 IF (b->>'shipping_refund')::numeric>1000000 THEN RAISE EXCEPTION 'Zwrot dostawy przekracza bieżący koszt dostawy zamówienia' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_return_shipping_limit(oid,rid,(b->>'shipping_refund')::bigint);
 IF EXISTS(SELECT 1 FROM return_cases WHERE tenant_id=t AND id=rid) OR jsonb_typeof(b->'parcel_origins') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'parcel_origins') NOT BETWEEN 1 AND 500
 OR jsonb_typeof(b->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'items') NOT BETWEEN 1 AND 100
 OR (SELECT count(DISTINCT value->>'item_id') FROM jsonb_array_elements(b->'items'))<>jsonb_array_length(b->'items')
 OR (SELECT count(DISTINCT (value->>'item_id',value->>'dispatch_id')) FROM jsonb_array_elements(b->'parcel_origins'))<>jsonb_array_length(b->'parcel_origins')
 THEN RAISE EXCEPTION 'Nieprawidłowy zakres pochodzenia zwrotu' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM return_cases WHERE tenant_id=t AND order_id=oid)>=2000 OR (SELECT count(*) FROM order_parcel_return_claims WHERE tenant_id=t AND order_id=oid)+jsonb_array_length(b->'parcel_origins')>10000 THEN RAISE EXCEPTION 'Historia pochodzenia zwrotów przekracza limit' USING ERRCODE='23514';END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(b->'items') LOOP
  IF (i->>'quantity')::integer NOT BETWEEN 1 AND 100000 OR NOT EXISTS(SELECT 1 FROM order_items WHERE tenant_id=t AND order_id=oid AND id=(i->>'item_id')::uuid)
  OR (i->>'quantity')::bigint IS DISTINCT FROM(SELECT sum((value->>'quantity')::integer) FROM jsonb_array_elements(b->'parcel_origins') WHERE value->>'item_id'=i->>'item_id') THEN RAISE EXCEPTION 'Źródła nie pokrywają dokładnej pozycji zwrotu' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR x IN SELECT value FROM jsonb_array_elements(b->'parcel_origins') LOOP
  SELECT * INTO origin FROM order_parcel_commercial_origins WHERE tenant_id=t AND order_id=oid AND item_id=(x->>'item_id')::uuid AND id IN(SELECT origin_id FROM order_parcel_origin_issues WHERE tenant_id=t AND dispatch_id=(x->>'dispatch_id')::uuid);
  SELECT quantity INTO issued FROM order_parcel_origin_issues WHERE tenant_id=t AND origin_id=origin.id AND dispatch_id=(x->>'dispatch_id')::uuid;
  SELECT coalesce(sum(CASE WHEN rc.state='requested' THEN cl.quantity WHEN rc.state IN('refund_pending','closed') THEN (SELECT coalesce(sum((d->>'accepted')::integer),0) FROM order_parcel_return_receipts rr CROSS JOIN LATERAL jsonb_array_elements(rr.payload->'decisions') d WHERE rr.tenant_id=t AND rr.return_id=cl.return_id AND d->>'origin_id'=cl.origin_id::text) ELSE 0 END),0) INTO used
  FROM order_parcel_return_claims cl JOIN return_cases rc ON(rc.tenant_id,rc.id)=(cl.tenant_id,cl.return_id) WHERE cl.tenant_id=t AND cl.origin_id=origin.id;
  IF origin.id IS NULL OR issued IS NULL OR (x->>'quantity')::integer NOT BETWEEN 1 AND 100000 OR (x->>'quantity')::bigint+used>issued OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'items') z WHERE z->>'item_id'=x->>'item_id') THEN RAISE EXCEPTION 'Zwrot przekracza rzeczywiście wydane źródło' USING ERRCODE='23514';END IF;
 END LOOP;

END $$;
CREATE FUNCTION order_parcel_return_request(oid uuid,rid uuid,uid uuid,kid uuid,b jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN PERFORM order_parcel_return_validate_request(oid,rid,uid,kid,b);INSERT INTO order_parcel_return_admissions VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,oid,rid,'request',pg_current_xact_id(),uid,kid,b,'{}',order_parcel_snapshot(oid)); END $$;
CREATE FUNCTION order_parcel_return_finish_request(rid uuid,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a order_parcel_return_admissions;x record;oid uuid;BEGIN
 SELECT * INTO a FROM order_parcel_return_admissions WHERE tenant_id=t AND return_id=rid AND kind='request' AND transaction_id=pg_current_xact_id() AND actor_id=uid AND api_key_id IS NOT DISTINCT FROM kid;
 IF a.return_id IS NULL THEN RAISE EXCEPTION 'Brak bieżącej zgody na źródła RMA' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_require(uid,kid,true,false);
 IF NOT EXISTS(SELECT 1 FROM return_cases r WHERE tenant_id=t AND id=rid AND order_parcel_return_request_head_matches(r,a.order_id,a.body) IS TRUE) THEN RAISE EXCEPTION 'Zgłoszenie nie odpowiada wybranemu pochodzeniu' USING ERRCODE='23514';END IF;
 FOR x IN SELECT value,ordinality FROM jsonb_array_elements(a.body->'parcel_origins') WITH ORDINALITY LOOP
  SELECT o.id INTO oid FROM order_parcel_commercial_origins o JOIN order_parcel_origin_issues d ON(d.tenant_id,d.origin_id)=(o.tenant_id,o.id) WHERE o.tenant_id=t AND o.order_id=a.order_id AND o.item_id=(x.value->>'item_id')::uuid AND d.dispatch_id=(x.value->>'dispatch_id')::uuid;
  INSERT INTO order_parcel_return_claims VALUES(t,a.order_id,rid,oid,(x.value->>'dispatch_id')::uuid,(x.value->>'item_id')::uuid,x.ordinality-1,(x.value->>'quantity')::integer);
 END LOOP;
END $$;

CREATE FUNCTION order_parcel_return_validate_receive(rid uuid,uid uuid,kid uuid,b jsonb,p jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r return_cases;cl order_parcel_return_claims;decision jsonb;i jsonb;x jsonb;comp jsonb;accepted_left integer;restocked_left integer;n integer;used bigint;cap integer;expected jsonb:='[]';BEGIN
 PERFORM order_parcel_require(uid,kid,true,false);SELECT * INTO r FROM return_cases WHERE tenant_id=t AND id=rid;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono sprawy zwrotowej' USING ERRCODE='P0002';END IF;
 PERFORM order_parcel_lock(r.order_id);SELECT * INTO r FROM return_cases WHERE tenant_id=t AND id=rid FOR UPDATE;
 IF NOT order_parcel_return_installed() OR NOT EXISTS(SELECT 1 FROM order_parcel_return_claims WHERE tenant_id=t AND return_id=rid) THEN RAISE EXCEPTION 'Brak zatwierdzonego pochodzenia RMA' USING ERRCODE='23514';END IF;
 IF r.state<>'requested' OR r.receipt IS NOT NULL OR r.legacy OR r.remedy='exchange' OR r.version<>(b->>'version')::bigint THEN RAISE EXCEPTION 'Sprawa zwrotu zmieniła się' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(b->'shipping_refund') IS DISTINCT FROM 'number' OR coalesce(b->>'shipping_refund','')!~ '^[0-9]+$' OR (b->>'shipping_refund')::numeric>r.requested_shipping THEN RAISE EXCEPTION 'Zwrot dostawy przekracza zgłoszenie' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_return_shipping_limit(r.order_id,r.id,(b->>'shipping_refund')::bigint);
 IF jsonb_typeof(b->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'items')<>(SELECT count(*) FROM return_items WHERE tenant_id=t AND return_id=rid)
 OR (SELECT count(DISTINCT value->>'item_id') FROM jsonb_array_elements(b->'items'))<>jsonb_array_length(b->'items') THEN RAISE EXCEPTION 'Rozpatrz dokładny zakres zgłoszenia' USING ERRCODE='23514';END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(b->'items') LOOP
  accepted_left:=(i->>'accepted')::integer;restocked_left:=(i->>'restocked')::integer;
  IF accepted_left<0 OR restocked_left<0 OR restocked_left>accepted_left OR NOT EXISTS(SELECT 1 FROM return_items WHERE tenant_id=t AND return_id=rid AND item_id=(i->>'item_id')::uuid AND requested>=accepted_left) THEN RAISE EXCEPTION 'Przyjęcie przekracza zgłoszone sztuki' USING ERRCODE='23514';END IF;
  FOR cl IN SELECT * FROM order_parcel_return_claims WHERE tenant_id=t AND return_id=rid AND item_id=(i->>'item_id')::uuid ORDER BY ordinal LOOP
   n:=least(cl.quantity,accepted_left);cap:=least(n,restocked_left);accepted_left:=accepted_left-n;restocked_left:=restocked_left-cap;
   expected:=expected||jsonb_build_array(jsonb_build_object('origin_id',cl.origin_id,'item_id',cl.item_id,'dispatch_id',cl.dispatch_id,'requested',cl.quantity,'accepted',n,'restocked',cap));
  END LOOP;
  IF accepted_left<>0 OR restocked_left<>0 THEN RAISE EXCEPTION 'Przyjęcie nie odpowiada źródłom' USING ERRCODE='23514';END IF;
 END LOOP;
 IF (SELECT coalesce(jsonb_agg(value ORDER BY value->>'origin_id'),'[]') FROM jsonb_array_elements(expected)) IS DISTINCT FROM(SELECT coalesce(jsonb_agg(value ORDER BY value->>'origin_id'),'[]') FROM jsonb_array_elements(p->'decisions')) THEN RAISE EXCEPTION 'Decyzja zmienia przypisanie wydanych sztuk' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(p->'fragments') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'fragments')>10000 OR (SELECT count(DISTINCT(value->>'origin_id',value->>'fragment_id')) FROM jsonb_array_elements(p->'fragments'))<>jsonb_array_length(p->'fragments') THEN RAISE EXCEPTION 'Nieprawidłowe przypisanie partii zwrotu' USING ERRCODE='23514';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p->'fragments') LOOP
  SELECT m.quantity INTO cap FROM order_parcel_origin_fragments m JOIN order_parcel_return_claims c ON(c.tenant_id,c.origin_id,c.dispatch_id)=(m.tenant_id,m.origin_id,m.dispatch_id) WHERE c.tenant_id=t AND c.return_id=rid AND m.origin_id=(x->>'origin_id')::uuid AND m.fragment_id=(x->>'fragment_id')::uuid AND m.product_id=(x->>'product_id')::uuid;
  SELECT coalesce(sum((f->>'quantity')::integer),0) INTO used FROM order_parcel_return_receipts rr CROSS JOIN LATERAL jsonb_array_elements(rr.payload->'fragments') f WHERE rr.tenant_id=t AND f->>'origin_id'=x->>'origin_id' AND f->>'fragment_id'=x->>'fragment_id';
  IF cap IS NULL OR (x->>'quantity')::integer<=0 OR (x->>'quantity')::bigint+used>cap THEN RAISE EXCEPTION 'Partia przekracza własne źródło wydania' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled) THEN
  FOR decision IN SELECT value FROM jsonb_array_elements(expected) LOOP
   FOR comp IN SELECT value FROM order_parcel_commercial_origins o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'components') WHERE o.tenant_id=t AND o.id=(decision->>'origin_id')::uuid LOOP
    IF (SELECT coalesce(sum((f->>'quantity')::integer),0) FROM jsonb_array_elements(p->'fragments') f WHERE f->>'origin_id'=decision->>'origin_id' AND f->>'product_id'=comp->>'product_id') IS DISTINCT FROM (decision->>'restocked')::bigint*(comp->>'quantity')::integer THEN RAISE EXCEPTION 'Partie nie pokrywają całych jednostek handlowych' USING ERRCODE='23514';END IF;
   END LOOP;
  END LOOP;
  IF (SELECT coalesce(jsonb_agg(jsonb_build_object('fragment_id',id,'quantity',qty) ORDER BY id),'[]') FROM(SELECT f->>'fragment_id' id,sum((f->>'quantity')::integer) qty FROM jsonb_array_elements(p->'fragments') f GROUP BY 1) z) IS DISTINCT FROM(SELECT coalesce(jsonb_agg(jsonb_build_object('fragment_id',f->>'issue_fragment_id','quantity',(f->>'quantity')::integer) ORDER BY f->>'issue_fragment_id'),'[]') FROM jsonb_array_elements(coalesce(b->'wms_lots'->'picks','[]')) f) THEN RAISE EXCEPTION 'Wybór partii nie odpowiada pochodzeniu zwrotu' USING ERRCODE='23514';END IF;
 ELSE IF p->'fragments'<>'[]'::jsonb OR b?'wms_lots' THEN RAISE EXCEPTION 'Tryb OFF nie przyjmuje partii WMS' USING ERRCODE='23514';END IF;END IF;

END $$;
CREATE FUNCTION order_parcel_return_prepare_receive(rid uuid,uid uuid,kid uuid,b jsonb,p jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN PERFORM order_parcel_return_validate_receive(rid,uid,kid,b,p);INSERT INTO order_parcel_return_admissions VALUES(nullif(current_setting('app.tenant_id',true),'')::uuid,(SELECT order_id FROM return_cases WHERE id=rid),rid,'receive',pg_current_xact_id(),uid,kid,b,p,order_parcel_return_snapshot(rid)); END $$;
CREATE FUNCTION order_parcel_return_validate_physical(a order_parcel_return_admissions) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p record;r return_cases;ri return_items;original order_items;old_item jsonb;decision jsonb;product uuid;delta integer;
 before_stock jsonb;after_stock jsonb;prior integer;credit bigint;total_credit bigint;actual jsonb;before_quantity bigint;after_quantity bigint;bin_row record;position_row record;expected bigint;expected_updates bigint;name text;
BEGIN
 SELECT a.tenant_id tenant_id,a.return_id return_id,a.actor_id actor_id,a.api_key_id api_key_id,a.body request,a.before_snapshot before_snapshot INTO p;
 SELECT * INTO r FROM return_cases WHERE(tenant_id,id)=(p.tenant_id,p.return_id);
 IF r.id IS NULL OR r.state<>'refund_pending' OR r.received_at IS NULL OR r.receipt IS DISTINCT FROM p.request
 OR r.version IS DISTINCT FROM (p.before_snapshot->'head'->>'version')::bigint+1
 OR to_jsonb(r)-ARRAY['state','received_at','receipt','receipt_sequence','refunded_shipping','refund_amount','decision_note','version','updated_at']
 IS DISTINCT FROM (p.before_snapshot->'head')-ARRAY['state','received_at','receipt','receipt_sequence','refunded_shipping','refund_amount','decision_note','version','updated_at']
 OR r.refunded_shipping IS DISTINCT FROM (p.request->>'shipping_refund')::int OR r.decision_note IS DISTINCT FROM p.request->>'note'
 OR r.receipt_sequence IS DISTINCT FROM (SELECT coalesce(max(rc.receipt_sequence),0)+1 FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(p.tenant_id,r.order_id) AND rc.id<>r.id)
 THEN RAISE EXCEPTION 'Lokalna decyzja nie odpowiada zatwierdzonej zgodzie' USING ERRCODE='23514'; END IF;
 IF r.refunded_shipping>r.requested_shipping THEN RAISE EXCEPTION 'Zwrot dostawy przekracza zgłoszenie' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_return_shipping_limit(r.order_id,r.id,r.refunded_shipping::bigint);
 actual:=order_parcel_return_snapshot(r.id);
 IF octet_length(actual::text)+octet_length(p.before_snapshot::text)>8388608 THEN RAISE EXCEPTION 'Za duży fizyczny dowód lokalnego RMA' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(p.before_snapshot->'location_movements') IS DISTINCT FROM 'array' OR jsonb_typeof(actual->'location_movements') IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.before_snapshot->'location_movements') prior_row WHERE NOT EXISTS(SELECT 1 FROM stock_location_movements existing_movement WHERE existing_movement.id=(prior_row.value->>'id')::uuid AND to_jsonb(existing_movement)=prior_row.value))
 THEN RAISE EXCEPTION 'Zmieniła się wcześniejsza historia lokalizacji zwrotu' USING ERRCODE='23514';END IF;
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
  IF EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=p.tenant_id AND enabled) THEN
   SELECT count(DISTINCT location) INTO expected_updates FROM wms_return_fragments WHERE(tenant_id,return_id,product_id)=(p.tenant_id,r.id,product) AND quantity>0;
  ELSE expected_updates:=CASE WHEN delta>0 THEN 1 ELSE 0 END;END IF;
  IF (before_stock IS NOT NULL AND after_stock-ARRAY['on_hand','available','version'] IS DISTINCT FROM before_stock-ARRAY['on_hand','available','version'])
  OR (delta>0 AND (after_stock->>'version')::bigint IS DISTINCT FROM coalesce((before_stock->>'version')::bigint,0)+expected_updates)
  OR coalesce((after_stock->>'on_hand')::bigint,0)<>coalesce((before_stock->>'on_hand')::bigint,0)+delta
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
 -- stock_location_reconcile emits one stock_in row for each positive destination
 -- update. Its real IDs/timestamps remain in the snapshot; no caller supplies them.
 -- Compare a multiset, so two smaller rows cannot replace one approved bin delta.
 IF EXISTS(
  WITH new_rows AS (
   SELECT current_row.value AS movement FROM jsonb_array_elements(actual->'location_movements') current_row
   WHERE (current_row.value->>'id')::uuid NOT IN(SELECT(prior_row.value->>'id')::uuid FROM jsonb_array_elements(p.before_snapshot->'location_movements') prior_row)
  ), destinations AS (
   SELECT f.product_id,f.location,sum(f.quantity)::bigint AS quantity FROM wms_return_fragments f
   WHERE(f.tenant_id,f.return_id)=(p.tenant_id,r.id) AND EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=p.tenant_id AND enabled)
   GROUP BY f.product_id,f.location HAVING sum(f.quantity)>0
   UNION ALL
   SELECT (comp->>'product_id')::uuid,'ZWROT'::text,sum(case_item.restocked*(comp->>'quantity')::bigint) FROM return_items case_item CROSS JOIN LATERAL jsonb_array_elements(case_item.components) comp
   WHERE(case_item.tenant_id,case_item.return_id)=(p.tenant_id,r.id) AND NOT EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=p.tenant_id AND enabled)
   GROUP BY (comp->>'product_id')::uuid HAVING sum(case_item.restocked*(comp->>'quantity')::bigint)>0
  ), observed AS (
   SELECT (movement->>'tenant_id')::uuid AS tenant_id,(movement->>'warehouse_id')::uuid AS warehouse_id,(movement->>'product_id')::uuid AS product_id,movement->>'location' AS location,
    (movement->>'delta')::bigint AS delta,movement->>'kind' AS kind,(movement->>'order_id')::uuid AS order_id,(movement->>'operation_id')::uuid AS operation_id,movement->>'note' AS note,(movement->>'stocktake_id')::uuid AS stocktake_id FROM new_rows
  ), approved AS (
   SELECT p.tenant_id AS tenant_id,r.warehouse_id AS warehouse_id,product_id,location,quantity AS delta,'stock_in'::text AS kind,NULL::uuid AS order_id,NULL::uuid AS operation_id,''::text AS note,NULL::uuid AS stocktake_id FROM destinations
  )
  (SELECT * FROM observed EXCEPT ALL SELECT * FROM approved)
  UNION ALL
  (SELECT * FROM approved EXCEPT ALL SELECT * FROM observed)
 ) THEN RAISE EXCEPTION 'Dziennik lokalizacji nie odpowiada rzeczywistemu przyjęciu' USING ERRCODE='23514';END IF;
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

 FOREACH name IN ARRAY ARRAY['original_items','payments','documents'] LOOP
  IF actual->name IS DISTINCT FROM p.before_snapshot->name THEN RAISE EXCEPTION 'Przyjęcie zmieniło oryginalną sprzedaż lub finanse' USING ERRCODE='23514';END IF;
 END LOOP;
 IF actual->'fulfillment'->'reservations' IS DISTINCT FROM p.before_snapshot->'fulfillment'->'reservations' OR actual->'fulfillment'->'locations' IS DISTINCT FROM p.before_snapshot->'fulfillment'->'locations' OR actual->'fulfillment'->'holds' IS DISTINCT FROM p.before_snapshot->'fulfillment'->'holds' THEN RAISE EXCEPTION 'Zwrot nie może ponownie otwierać rezerwacji' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION order_parcel_return_finish_receive(rid uuid,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a order_parcel_return_admissions;BEGIN
 SELECT * INTO a FROM order_parcel_return_admissions WHERE tenant_id=t AND return_id=rid AND kind='receive' AND transaction_id=pg_current_xact_id() AND actor_id=uid AND api_key_id IS NOT DISTINCT FROM kid;
 IF a.return_id IS NULL THEN RAISE EXCEPTION 'Brak bieżącej zgody przyjęcia z paczek' USING ERRCODE='23514';END IF;
 PERFORM order_parcel_require(uid,kid,true,false);
 INSERT INTO order_parcel_return_receipts(tenant_id,order_id,return_id,actor_id,api_key_id,body,payload,before_snapshot,after_snapshot) VALUES(t,a.order_id,rid,uid,kid,a.body,a.payload,a.before_snapshot,order_parcel_return_snapshot(rid));
END $$;

CREATE FUNCTION order_parcel_return_private_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a order_parcel_return_admissions;x jsonb;BEGIN
 IF TG_TABLE_NAME='order_parcel_return_admissions' THEN
  IF NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Zgoda nie pochodzi z bieżącej transakcji' USING ERRCODE='23514';END IF;
  IF NEW.kind='request' THEN
   PERFORM order_parcel_return_validate_request(NEW.order_id,NEW.return_id,NEW.actor_id,NEW.api_key_id,NEW.body);
   IF NEW.payload<>'{}'::jsonb OR NEW.before_snapshot IS DISTINCT FROM order_parcel_snapshot(NEW.order_id) THEN RAISE EXCEPTION 'Zgłoszenie nie przyjmuje fizycznych dowodów' USING ERRCODE='23514';END IF;
  ELSIF NEW.kind='receive' THEN
   PERFORM order_parcel_return_validate_receive(NEW.return_id,NEW.actor_id,NEW.api_key_id,NEW.body,NEW.payload);
   IF NEW.before_snapshot IS DISTINCT FROM order_parcel_return_snapshot(NEW.return_id) THEN RAISE EXCEPTION 'Zgoda nie odpowiada rzeczywistemu stanowi przed przyjęciem' USING ERRCODE='23514';END IF;
  ELSE
   PERFORM order_parcel_require(NEW.actor_id,NEW.api_key_id,true,false);
   IF NOT EXISTS(SELECT 1 FROM return_cases WHERE tenant_id=NEW.tenant_id AND order_id=NEW.order_id AND id=NEW.return_id AND state='requested' AND version=(NEW.body->>'version')::bigint AND receipt IS NULL) OR NEW.body->>'decision' NOT IN('reject','cancel') THEN RAISE EXCEPTION 'Nieaktualna decyzja zwrotu' USING ERRCODE='23514';END IF;
  END IF;
 ELSE
  SELECT * INTO a FROM order_parcel_return_admissions WHERE tenant_id=NEW.tenant_id AND return_id=NEW.return_id AND transaction_id=pg_current_xact_id() AND kind=CASE WHEN TG_TABLE_NAME='order_parcel_return_claims' THEN 'request' ELSE 'receive' END;
  IF a.return_id IS NULL THEN RAISE EXCEPTION 'Brak bieżącej zgody pochodzenia zwrotu' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='order_parcel_return_claims' THEN
   x:=a.body->'parcel_origins'->NEW.ordinal;
   IF (NEW.order_id,NEW.item_id,NEW.dispatch_id,NEW.quantity) IS DISTINCT FROM(a.order_id,(x->>'item_id')::uuid,(x->>'dispatch_id')::uuid,(x->>'quantity')::integer) OR NOT EXISTS(SELECT 1 FROM order_parcel_commercial_origins WHERE tenant_id=NEW.tenant_id AND id=NEW.origin_id AND order_id=NEW.order_id AND item_id=NEW.item_id) THEN RAISE EXCEPTION 'Pochodzenie nie odpowiada jawnej pozycji zgłoszenia' USING ERRCODE='23514';END IF;
  ELSE
   IF (NEW.order_id,NEW.actor_id,NEW.api_key_id,NEW.body,NEW.payload,NEW.before_snapshot,NEW.after_snapshot) IS DISTINCT FROM(a.order_id,a.actor_id,a.api_key_id,a.body,a.payload,a.before_snapshot,order_parcel_return_snapshot(a.return_id)) THEN RAISE EXCEPTION 'Dowód przyjęcia nie odpowiada bieżącej zgodzie' USING ERRCODE='23514';END IF;
   PERFORM order_parcel_return_validate_physical(a);
  END IF;
 END IF;RETURN NEW;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_return_admissions','order_parcel_return_claims','order_parcel_return_receipts'] LOOP EXECUTE format('CREATE TRIGGER private_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_return_private_guard()',rel);END LOOP;END $$;
CREATE FUNCTION order_parcel_return_decision(rid uuid,uid uuid,kid uuid,b jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;oid uuid;BEGIN
 SELECT order_id INTO oid FROM return_cases WHERE tenant_id=t AND id=rid;PERFORM order_parcel_lock(oid);PERFORM order_parcel_require(uid,kid,true,false);
 INSERT INTO order_parcel_return_admissions VALUES(t,oid,rid,'decision',pg_current_xact_id(),uid,kid,b,'{}','{}');
END $$;

CREATE FUNCTION order_parcel_return_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Pochodzenie zwrotu jest niezmienne' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['order_parcel_return_claims','order_parcel_return_receipts','order_parcel_return_admissions'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_return_immutable()',rel);
END LOOP;END $$;

CREATE FUNCTION order_parcel_return_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;o jsonb;rid uuid;oid uuid;t uuid;a order_parcel_return_admissions;BEGIN
 t:=(n->>'tenant_id')::uuid;oid:=(n->>'order_id')::uuid;rid:=(CASE WHEN TG_TABLE_NAME='return_cases' THEN n->>'id' ELSE n->>'return_id' END)::uuid;
 IF NOT EXISTS(SELECT 1 FROM order_parcel_plans WHERE tenant_id=t AND order_id=oid AND payload->>'protocol'='commercial_v1') THEN RETURN coalesce(NEW,OLD);END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Nie wolno usuwać historii pochodzenia zwrotu' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO a FROM order_parcel_return_admissions WHERE tenant_id=t AND return_id=rid AND kind='request' AND transaction_id=pg_current_xact_id();
  IF a.return_id IS NULL THEN RAISE EXCEPTION 'Zgłoszenie wymaga jawnego wydanego źródła' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='return_cases' THEN
   IF order_parcel_return_request_head_matches(NEW,a.order_id,a.body) IS NOT TRUE THEN RAISE EXCEPTION 'Nieprawidłowe nowe zgłoszenie z paczek' USING ERRCODE='23514';END IF;
  ELSE
   IF NEW.accepted<>0 OR NEW.restocked<>0 OR NEW.refund_amount<>0 OR NOT EXISTS(SELECT 1 FROM order_items i WHERE i.tenant_id=t AND i.order_id=oid AND i.id=NEW.item_id AND i.sku=NEW.sku AND i.name=NEW.name AND CASE WHEN jsonb_array_length(i.components)>0 THEN i.components ELSE jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',1)) END=NEW.components)
   OR NEW.requested IS DISTINCT FROM(SELECT(value->>'quantity')::integer FROM jsonb_array_elements(a.body->'items') WHERE value->>'item_id'=NEW.item_id::text) THEN RAISE EXCEPTION 'Pozycja RMA nie odpowiada oryginalnej sprzedaży' USING ERRCODE='23514';END IF;
  END IF;
 ELSE
  o:=to_jsonb(OLD);
  IF TG_TABLE_NAME='return_cases' THEN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
   IF OLD.state='requested' AND NEW.state IN('rejected','cancelled') THEN
    IF NOT EXISTS(SELECT 1 FROM order_parcel_return_admissions WHERE tenant_id=t AND return_id=rid AND transaction_id=pg_current_xact_id() AND kind='decision' AND body->>'decision'=(CASE WHEN NEW.state='rejected' THEN 'reject' ELSE 'cancel' END) AND body->>'note'=NEW.decision_note AND (body->>'version')::bigint=OLD.version) THEN RAISE EXCEPTION 'Decyzja zwrotu wymaga bieżącej zgody operatora' USING ERRCODE='23514';END IF;
   ELSIF OLD.state='requested' AND NEW.state='refund_pending' THEN
    IF NOT EXISTS(SELECT 1 FROM order_parcel_return_admissions WHERE tenant_id=t AND return_id=rid AND transaction_id=pg_current_xact_id() AND kind='receive') THEN RAISE EXCEPTION 'Przyjęcie wymaga pochodzenia' USING ERRCODE='23514';END IF;
   ELSIF OLD.state='refund_pending' AND NEW.state='closed' AND EXISTS(SELECT 1 FROM order_parcel_return_receipts WHERE tenant_id=t AND return_id=rid) THEN NULL;
   ELSE RAISE EXCEPTION 'Niedozwolone przejście stanu zwrotu z paczek' USING ERRCODE='23514';END IF;
  END IF;
  END IF;
  IF TG_TABLE_NAME='return_items' THEN
   IF n-ARRAY['accepted','restocked','refund_amount'] IS DISTINCT FROM o-ARRAY['accepted','restocked','refund_amount'] THEN RAISE EXCEPTION 'Pozycja pochodzenia zwrotu jest trwała' USING ERRCODE='23514';END IF;
  ELSE
   IF n-ARRAY['state','decision_note','version','updated_at','receipt','received_at','receipt_sequence','refunded_shipping','refund_amount','settlement','refunded_at'] IS DISTINCT FROM o-ARRAY['state','decision_note','version','updated_at','receipt','received_at','receipt_sequence','refunded_shipping','refund_amount','settlement','refunded_at'] THEN RAISE EXCEPTION 'Zgłoszone pochodzenie zwrotu jest trwałe' USING ERRCODE='23514';END IF;
  END IF;
  IF(TG_TABLE_NAME='return_items' AND n IS DISTINCT FROM o) OR(TG_TABLE_NAME='return_cases' AND n-ARRAY['state','decision_note','version','updated_at','settlement','refunded_at'] IS DISTINCT FROM o-ARRAY['state','decision_note','version','updated_at','settlement','refunded_at']) THEN
   SELECT * INTO a FROM order_parcel_return_admissions WHERE tenant_id=t AND return_id=rid AND kind='receive' AND transaction_id=pg_current_xact_id();
   IF a.return_id IS NULL THEN RAISE EXCEPTION 'Przyjęcie wymaga bieżącego dowodu pochodzenia paczek' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER order_parcel_return_guard BEFORE INSERT OR UPDATE OR DELETE ON return_cases FOR EACH ROW EXECUTE FUNCTION order_parcel_return_guard();
CREATE TRIGGER order_parcel_return_guard BEFORE INSERT OR UPDATE OR DELETE ON return_items FOR EACH ROW EXECUTE FUNCTION order_parcel_return_guard();

CREATE FUNCTION order_parcel_return_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;bytes bigint;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('order.parcels.quota:'||t::text,0));
 SELECT coalesce(sum(octet_length(data::text)),0) INTO bytes FROM(SELECT to_jsonb(a) data FROM order_parcel_previews a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_plans a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_allocations a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_dispatches a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_admissions a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_commercial_origins a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_origin_issues a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_origin_fragments a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_release_previews a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_releases a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_release_admissions a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_return_admissions a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_return_receipts a WHERE tenant_id=t UNION ALL SELECT to_jsonb(a) FROM order_parcel_return_claims a WHERE tenant_id=t) q;
 IF bytes>67108864 THEN RAISE EXCEPTION 'Wspólna historia paczek i zwrotów przekracza 64 MiB' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION order_parcel_return_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a order_parcel_return_admissions:=NEW;r return_cases;cl order_parcel_return_claims;issued_qty bigint;used bigint;rr order_parcel_return_receipts;BEGIN
 IF a.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Nieprawidłowa transakcja pochodzenia RMA' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM return_cases WHERE tenant_id=a.tenant_id AND id=a.return_id AND order_id=a.order_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Brak zgłoszenia dla dowodu pochodzenia' USING ERRCODE='23514';END IF;
 IF a.kind='request' THEN
  IF a.before_snapshot IS DISTINCT FROM order_parcel_snapshot(a.order_id) THEN RAISE EXCEPTION 'Zgłoszenie nie może zmieniać stanów ani rezerwacji' USING ERRCODE='23514';END IF;
  IF order_parcel_return_request_head_matches(r,a.order_id,a.body) IS NOT TRUE OR (SELECT count(*) FROM order_parcel_return_claims WHERE tenant_id=a.tenant_id AND return_id=r.id)<>jsonb_array_length(a.body->'parcel_origins') OR (SELECT count(*) FROM return_items WHERE tenant_id=a.tenant_id AND return_id=r.id)<>jsonb_array_length(a.body->'items') THEN RAISE EXCEPTION 'Niekompletny graf zgłoszonego pochodzenia' USING ERRCODE='23514';END IF;
  PERFORM order_parcel_return_shipping_limit(r.order_id,r.id,r.requested_shipping::bigint);
 ELSIF a.kind='receive' THEN
  PERFORM order_parcel_return_validate_physical(a);
  SELECT * INTO rr FROM order_parcel_return_receipts WHERE tenant_id=a.tenant_id AND return_id=r.id;
  IF rr.return_id IS NULL OR rr.body IS DISTINCT FROM a.body OR rr.payload IS DISTINCT FROM a.payload OR r.receipt IS DISTINCT FROM a.body OR r.state<>'refund_pending' OR r.received_at IS NULL OR EXISTS(SELECT 1 FROM return_items i WHERE i.tenant_id=a.tenant_id AND i.return_id=r.id AND (i.accepted,i.restocked) IS DISTINCT FROM(SELECT ROW(sum((d->>'accepted')::integer)::integer,sum((d->>'restocked')::integer)::integer) FROM jsonb_array_elements(a.payload->'decisions') d WHERE d->>'item_id'=i.item_id::text)) THEN RAISE EXCEPTION 'Niekompletny odbiór pochodzenia zwrotu' USING ERRCODE='23514';END IF;
  IF (SELECT coalesce(jsonb_agg(jsonb_build_object('fragment_id',id,'quantity',qty) ORDER BY id),'[]') FROM(SELECT f->>'fragment_id' id,sum((f->>'quantity')::integer) qty FROM jsonb_array_elements(a.payload->'fragments') f GROUP BY 1) z) IS DISTINCT FROM(SELECT coalesce(jsonb_agg(jsonb_build_object('fragment_id',issue_fragment_id,'quantity',qty) ORDER BY issue_fragment_id),'[]') FROM(SELECT issue_fragment_id::text,sum(quantity) qty FROM wms_return_fragments WHERE tenant_id=a.tenant_id AND return_id=r.id GROUP BY 1) z) THEN RAISE EXCEPTION 'Świeże partie przyjęcia nie odpowiadają pochodzeniu' USING ERRCODE='23514';END IF;
 ELSIF a.kind='decision' THEN
  IF r.state IS DISTINCT FROM (CASE WHEN a.body->>'decision'='reject' THEN 'rejected' ELSE 'cancelled' END) OR r.decision_note IS DISTINCT FROM a.body->>'note' OR r.version IS DISTINCT FROM (a.body->>'version')::bigint+1 OR r.receipt IS NOT NULL THEN RAISE EXCEPTION 'Decyzja nie ma trwałego wyniku' USING ERRCODE='23514';END IF;
 END IF;
 FOR cl IN SELECT * FROM order_parcel_return_claims WHERE tenant_id=a.tenant_id AND return_id=r.id LOOP
  SELECT quantity INTO issued_qty FROM order_parcel_origin_issues WHERE tenant_id=cl.tenant_id AND origin_id=cl.origin_id AND dispatch_id=cl.dispatch_id;
  SELECT coalesce(sum(CASE WHEN rc.state='requested' THEN cc.quantity WHEN rc.state IN('refund_pending','closed') THEN(SELECT coalesce(sum((d->>'accepted')::integer),0) FROM order_parcel_return_receipts z CROSS JOIN LATERAL jsonb_array_elements(z.payload->'decisions') d WHERE z.tenant_id=cc.tenant_id AND z.return_id=cc.return_id AND d->>'origin_id'=cc.origin_id::text) ELSE 0 END),0) INTO used FROM order_parcel_return_claims cc JOIN return_cases rc ON(rc.tenant_id,rc.id)=(cc.tenant_id,cc.return_id) WHERE cc.tenant_id=cl.tenant_id AND cc.origin_id=cl.origin_id;
  IF issued_qty IS NULL OR used>issued_qty THEN RAISE EXCEPTION 'Źródło ma więcej zwrotów niż wydań' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM order_parcel_require(a.actor_id,a.api_key_id,true,false);PERFORM order_parcel_return_budget();RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_parcel_return_complete AFTER INSERT ON order_parcel_return_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_parcel_return_complete();
CREATE FUNCTION order_parcel_return_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid;old_t uuid;new_t uuid;BEGIN
 IF TG_OP<>'INSERT' THEN old_t:=(to_jsonb(OLD)->>'tenant_id')::uuid;END IF;
 IF TG_OP<>'DELETE' THEN new_t:=(to_jsonb(NEW)->>'tenant_id')::uuid;END IF;
 FOR t IN SELECT DISTINCT tenant FROM unnest(ARRAY[old_t,new_t]) tenant WHERE tenant IS NOT NULL LOOP
 IF EXISTS(SELECT 1 FROM order_parcel_return_admissions a WHERE a.tenant_id=t AND a.transaction_id=pg_current_xact_id() AND
  ((a.kind='receive' AND EXISTS(SELECT 1 FROM order_parcel_return_receipts WHERE tenant_id=t AND return_id=a.return_id)) OR
   (a.kind='request' AND EXISTS(SELECT 1 FROM order_parcel_return_claims WHERE tenant_id=t AND return_id=a.return_id)))) THEN RAISE EXCEPTION 'Dowód pochodzenia RMA zamknął zapisy tej transakcji' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['return_cases','return_items','orders','order_items','shipments','stock','stock_locations','stock_movements','stock_location_movements','wms_layer_positions','wms_layer_movements','wms_return_fragments','wms_operations','reservations','reservation_locations','wms_reservation_layers','payment_entries','documents'] LOOP EXECUTE format('CREATE TRIGGER order_parcel_return_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION order_parcel_return_seal()',rel);END LOOP;END $$;
CREATE FUNCTION order_parcel_return_lock(oid uuid,uid uuid,kid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN PERFORM order_parcel_require(uid,kid,true,false);PERFORM order_parcel_lock(oid);PERFORM order_parcel_require(uid,kid,true,false);END $$;
ALTER FUNCTION order_parcel_budget() RENAME TO order_parcel_budget_pre_returns;
CREATE FUNCTION order_parcel_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN PERFORM order_parcel_budget_pre_returns();PERFORM order_parcel_return_budget();END $$;
ALTER FUNCTION order_parcel_guards() RENAME TO order_parcel_guards_pre_returns;
CREATE FUNCTION order_parcel_guards() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT order_parcel_guards_pre_returns() AND order_parcel_return_installed() $$;
REVOKE ALL ON FUNCTION order_parcel_budget(),order_parcel_guards() FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION order_parcel_guards() TO dyna_app;
DO $$DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'order_parcel_return_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.sig);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION order_parcel_return_installed(),order_parcel_return_lock(uuid,uuid,uuid),order_parcel_return_request(uuid,uuid,uuid,uuid,jsonb),order_parcel_return_finish_request(uuid,uuid,uuid),order_parcel_return_prepare_receive(uuid,uuid,uuid,jsonb,jsonb),order_parcel_return_finish_receive(uuid,uuid,uuid),order_parcel_return_decision(uuid,uuid,uuid,jsonb) TO dyna_app;
