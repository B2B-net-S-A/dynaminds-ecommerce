-- Transactional, trigger-only worklist. It contains no durable business data.
-- Original 025/090 validators remain intact in their historical migrations.
CREATE TABLE wms_validation_scopes (
 transaction_id xid8 NOT NULL,tenant_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('quantity','operation','policy')),
 scope_id text NOT NULL,warehouse_id uuid,product_id uuid,operation_id uuid,
 PRIMARY KEY(transaction_id,tenant_id,kind,scope_id),
 CHECK((kind='quantity' AND warehouse_id IS NOT NULL AND product_id IS NOT NULL AND operation_id IS NULL
   AND scope_id=warehouse_id::text||':'||product_id::text)
  OR (kind='operation' AND warehouse_id IS NULL AND product_id IS NULL AND operation_id IS NOT NULL AND scope_id=operation_id::text)
  OR (kind='policy' AND warehouse_id IS NULL AND product_id IS NULL AND operation_id IS NULL AND scope_id='tenant'))
);
ALTER TABLE wms_validation_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_validation_scopes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON wms_validation_scopes FROM PUBLIC,dyna_app;
DO $$ BEGIN
 EXECUTE format('CREATE POLICY validation_owner ON public.wms_validation_scopes TO %I USING(true) WITH CHECK(true)',current_user);
END $$;

-- Preserve the complete old quantity/bin/reservation/scanned checks, including
-- the OFF path from 025. Only scheduling frequency changes.
CREATE FUNCTION wms_validate_quantity_scope(t uuid,w uuid,p uuid,policy_scope boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s record;stock_row record;held bigint;prior_scope text;
BEGIN
 prior_scope:=current_setting('app.tenant_id',true);

 -- Deferred events can originate in several authorized B2B tenants in one TX.
 -- Their INSERT/UPDATE has already passed RLS; never retain this event-local scope.
 PERFORM set_config('app.tenant_id',t::text,true);
 IF NOT policy_scope THEN
  SELECT * INTO s FROM stock WHERE (tenant_id,warehouse_id,product_id)=(t,w,p);
  IF FOUND THEN
 IF (SELECT coalesce(sum(quantity),0) FROM stock_locations WHERE (tenant_id,warehouse_id,product_id)=(t,w,p))<>s.on_hand THEN
  RAISE EXCEPTION 'Suma lokalizacji nie zgadza sie ze stanem magazynu' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(a.quantity),0) INTO held FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE (a.tenant_id,a.warehouse_id,a.product_id)=(t,w,p) AND r.state='active';
 IF held<>s.reserved OR EXISTS(
  SELECT 1 FROM reservations r LEFT JOIN reservation_locations a USING(tenant_id,order_id,product_id,warehouse_id) WHERE (r.tenant_id,r.warehouse_id,r.product_id)=(t,w,p) AND r.state='active' GROUP BY r.order_id,r.quantity HAVING coalesce(sum(a.quantity),0)<>r.quantity
 ) OR EXISTS(
  SELECT 1 FROM stock_locations l JOIN reservation_locations a USING(tenant_id,warehouse_id,product_id,location) JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE (l.tenant_id,l.warehouse_id,l.product_id)=(t,w,p) AND r.state='active' GROUP BY l.location,l.quantity HAVING sum(a.quantity)>l.quantity
 ) OR EXISTS(
  SELECT 1 FROM reservations r JOIN order_pick_items i USING(tenant_id,order_id,product_id) LEFT JOIN reservation_locations a USING(tenant_id,order_id,product_id,warehouse_id) WHERE (r.tenant_id,r.warehouse_id,r.product_id)=(t,w,p) AND r.state='active' GROUP BY r.order_id,i.scanned HAVING coalesce(sum(a.scanned),0)<>i.scanned
 ) THEN RAISE EXCEPTION 'Rezerwacje lokalizacji nie zgadzaja sie ze stanem' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled) THEN
  PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;END IF;
 IF policy_scope THEN
  IF EXISTS(SELECT 1 FROM reservations WHERE tenant_id=t AND state='active') OR
     EXISTS(SELECT 1 FROM stock WHERE tenant_id=t AND reserved<>0) OR
     EXISTS(SELECT 1 FROM picking_waves WHERE tenant_id=t AND state='picking') OR
     EXISTS(SELECT 1 FROM packing_sessions WHERE tenant_id=t AND state='active') OR
     EXISTS(SELECT 1 FROM wms_layer_positions WHERE tenant_id=t AND reserved<>0) OR
     EXISTS(SELECT 1 FROM wms_reservation_layers WHERE tenant_id=t AND state='active') OR
     EXISTS(SELECT 1 FROM wms_layer_positions l WHERE l.tenant_id=t AND l.quantity<>
      (SELECT coalesce(sum(delta),0) FROM wms_layer_movements m WHERE
       (m.tenant_id,m.warehouse_id,m.product_id,m.location,m.layer_id)=(l.tenant_id,l.warehouse_id,l.product_id,l.location,l.layer_id)))
  THEN RAISE EXCEPTION 'Otwarcie wymaga uzgodnionej księgi bez aktywnych rezerwacji i realizacji' USING ERRCODE='23514';END IF;
  FOR stock_row IN SELECT warehouse_id,product_id FROM stock WHERE tenant_id=t LOOP
   IF (SELECT on_hand FROM stock WHERE (tenant_id,warehouse_id,product_id)=(t,stock_row.warehouse_id,stock_row.product_id))<>
      (SELECT coalesce(sum(quantity),0) FROM wms_layer_positions WHERE (tenant_id,warehouse_id,product_id)=(t,stock_row.warehouse_id,stock_row.product_id)) OR
      EXISTS(SELECT 1 FROM stock_locations b WHERE (b.tenant_id,b.warehouse_id,b.product_id)=(t,stock_row.warehouse_id,stock_row.product_id)
    AND b.quantity<>(SELECT coalesce(sum(quantity),0) FROM wms_layer_positions l WHERE
     (l.tenant_id,l.warehouse_id,l.product_id,l.location)=(b.tenant_id,b.warehouse_id,b.product_id,b.location)))
   THEN RAISE EXCEPTION 'Otwarcie nie obejmuje całego stanu WMS' USING ERRCODE='23514';END IF;
  END LOOP;PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;
 END IF;

 SELECT * INTO s FROM stock WHERE (tenant_id,warehouse_id,product_id)=(t,w,p);
 IF NOT FOUND THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;END IF;
 IF s.on_hand<>(SELECT coalesce(sum(quantity),0) FROM wms_layer_positions WHERE (tenant_id,warehouse_id,product_id)=(t,w,p)) OR
 s.reserved<>(SELECT coalesce(sum(reserved),0) FROM wms_layer_positions WHERE (tenant_id,warehouse_id,product_id)=(t,w,p)) OR
 EXISTS(SELECT 1 FROM stock_locations b WHERE (b.tenant_id,b.warehouse_id,b.product_id)=(t,w,p) AND
  b.quantity<>(SELECT coalesce(sum(quantity),0) FROM wms_layer_positions l WHERE
   (l.tenant_id,l.warehouse_id,l.product_id,l.location)=(b.tenant_id,b.warehouse_id,b.product_id,b.location))) OR
 EXISTS(SELECT 1 FROM wms_layer_positions l WHERE (l.tenant_id,l.warehouse_id,l.product_id)=(t,w,p) AND
  (l.quantity<>(SELECT coalesce(sum(delta),0) FROM wms_layer_movements m WHERE
   (m.tenant_id,m.warehouse_id,m.product_id,m.location,m.layer_id)=(l.tenant_id,l.warehouse_id,l.product_id,l.location,l.layer_id)) OR
   l.reserved<>(SELECT coalesce(sum(quantity),0) FROM wms_reservation_layers a WHERE a.state='active' AND
   (a.tenant_id,a.warehouse_id,a.product_id,a.location,a.layer_id)=(l.tenant_id,l.warehouse_id,l.product_id,l.location,l.layer_id)))) OR
 EXISTS(SELECT 1 FROM reservation_locations b JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id)
  WHERE (b.tenant_id,b.warehouse_id,b.product_id)=(t,w,p) AND r.state='active' AND
  ((b.quantity::bigint,b.scanned::bigint) IS DISTINCT FROM (SELECT ROW(coalesce(sum(a.quantity),0),coalesce(sum(a.scanned),0))
   FROM wms_reservation_layers a WHERE a.state='active' AND
   (a.tenant_id,a.order_id,a.product_id,a.warehouse_id,a.location)=(b.tenant_id,b.order_id,b.product_id,b.warehouse_id,b.location))))
 THEN RAISE EXCEPTION 'WMS nie zgadza się ze stanem, lokalizacjami, rezerwacją lub skanami' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;

-- Complete 090 operation checks: exact issue/return fragments, unknown costs,
-- cumulative partial-return ceiling, physical case quantity, conserved transfers.
CREATE FUNCTION wms_validate_operation_scope(t uuid,operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE return_case record;op record;prior_scope text;
BEGIN
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',t::text,true);
 IF EXISTS(
  SELECT 1 FROM wms_return_fragments affected JOIN wms_issue_fragments original
   ON (original.tenant_id,original.id)=(affected.tenant_id,affected.issue_fragment_id)
  WHERE (affected.tenant_id,affected.operation_id)=(t,operation)
   AND (SELECT sum(quantity) FROM wms_return_fragments all_returns
    WHERE (all_returns.tenant_id,all_returns.issue_fragment_id)=(original.tenant_id,original.id))>original.quantity
 ) THEN RAISE EXCEPTION 'Zwrócono więcej niż pierwotnie wydano' USING ERRCODE='23514';END IF;
 SELECT * INTO op FROM wms_operations WHERE (tenant_id,id)=(t,operation);
 IF NOT FOUND THEN RAISE EXCEPTION 'Brak trwałego właściciela ruchu WMS' USING ERRCODE='23514';END IF;
 IF op.kind IN ('transfer','bin_move') AND EXISTS(SELECT 1 FROM wms_layer_movements m
  WHERE (m.tenant_id,m.operation_id)=(op.tenant_id,op.id) GROUP BY m.product_id,m.layer_id
  HAVING sum(m.delta)<>0 OR coalesce(sum(m.value_delta),0)<>0)
 THEN RAISE EXCEPTION 'Transfer nie zachowuje ilości i wartości partii' USING ERRCODE='23514';END IF;
 -- Both sides are append-only. Check the completed operation, not insertion order.
 -- NULL means an unknown source cost, and is never converted into zero.
 IF op.kind IN ('dispatch','issue','adjustment') THEN
  IF EXISTS(SELECT 1 FROM wms_issue_fragments f WHERE (f.tenant_id,f.operation_id)=(op.tenant_id,op.id)
    AND (f.order_id,f.warehouse_document_id) IS DISTINCT FROM (op.order_id,op.warehouse_document_id)) OR
   EXISTS(WITH j AS (
    SELECT warehouse_id,product_id,layer_id,location,sum(-delta::bigint) quantity,
      sum(-value_delta::numeric) value_minor
    FROM wms_layer_movements WHERE (tenant_id,operation_id)=(op.tenant_id,op.id) AND delta<0
    GROUP BY warehouse_id,product_id,layer_id,location
   ), f AS (
    SELECT warehouse_id,product_id,layer_id,location,sum(quantity::bigint) quantity,sum(value_minor::numeric) value_minor
    FROM wms_issue_fragments WHERE (tenant_id,operation_id)=(op.tenant_id,op.id)
    GROUP BY warehouse_id,product_id,layer_id,location
   ) SELECT 1 FROM j FULL JOIN f USING(warehouse_id,product_id,layer_id,location)
   WHERE j.quantity IS DISTINCT FROM f.quantity OR j.value_minor IS DISTINCT FROM f.value_minor)
  THEN RAISE EXCEPTION 'Fragmenty wydania nie odpowiadają dokładnemu rozchodowi warstw' USING ERRCODE='23514';END IF;
 ELSIF EXISTS(SELECT 1 FROM wms_issue_fragments f WHERE (f.tenant_id,f.operation_id)=(op.tenant_id,op.id)) THEN
  RAISE EXCEPTION 'Ta operacja nie jest wydaniem partii' USING ERRCODE='23514';
 END IF;
 IF op.kind='return' THEN
  SELECT * INTO return_case FROM return_cases WHERE (tenant_id,id,order_id)=(op.tenant_id,op.return_id,op.order_id);
  IF NOT FOUND OR return_case.received_at IS NULL OR
   EXISTS(SELECT 1 FROM wms_return_fragments r WHERE (r.tenant_id,r.operation_id)=(op.tenant_id,op.id)
    AND (r.order_id,r.return_id,r.warehouse_id) IS DISTINCT FROM (op.order_id,op.return_id,return_case.warehouse_id)) OR
   EXISTS(SELECT 1 FROM wms_layer_movements m WHERE (m.tenant_id,m.operation_id)=(op.tenant_id,op.id)
    AND (m.delta<0 OR m.warehouse_id<>return_case.warehouse_id)) OR
   EXISTS(WITH actual AS (
    SELECT (component->>'product_id')::uuid product_id,
      sum(i.restocked::numeric*(component->>'quantity')::numeric) quantity
    FROM return_items i CROSS JOIN LATERAL jsonb_array_elements(i.components) component
    WHERE (i.tenant_id,i.return_id,i.order_id)=(op.tenant_id,op.return_id,op.order_id)
    GROUP BY (component->>'product_id')::uuid HAVING sum(i.restocked::numeric*(component->>'quantity')::numeric)>0
   ), journal AS (
    SELECT product_id,sum(delta::numeric) quantity FROM wms_layer_movements
    WHERE (tenant_id,operation_id)=(op.tenant_id,op.id) GROUP BY product_id
   ) SELECT 1 FROM actual FULL JOIN journal USING(product_id) WHERE actual.quantity IS DISTINCT FROM journal.quantity) OR
   EXISTS(WITH journal AS (
    SELECT warehouse_id,product_id,layer_id,location,sum(delta::bigint) quantity,sum(value_delta::numeric) value_minor
    FROM wms_layer_movements WHERE (tenant_id,operation_id)=(op.tenant_id,op.id)
    GROUP BY warehouse_id,product_id,layer_id,location
   ), evidence AS (
    SELECT warehouse_id,product_id,layer_id,location,sum(quantity::bigint) quantity,sum(value_minor::numeric) value_minor
    FROM wms_return_fragments WHERE (tenant_id,operation_id)=(op.tenant_id,op.id)
    GROUP BY warehouse_id,product_id,layer_id,location
    UNION ALL
    SELECT j.warehouse_id,l.product_id,l.id,j.location,l.quantity_received::bigint,NULL::numeric
    FROM wms_cost_layers l JOIN wms_lots lot ON (lot.tenant_id,lot.id)=(l.tenant_id,l.lot_id)
    JOIN wms_layer_movements j ON (j.tenant_id,j.operation_id,j.layer_id)=(l.tenant_id,l.operation_id,l.id)
    WHERE (l.tenant_id,l.operation_id)=(op.tenant_id,op.id) AND lot.origin='legacy_return'
   ) SELECT 1 FROM journal FULL JOIN evidence USING(warehouse_id,product_id,layer_id,location)
   WHERE journal.quantity IS DISTINCT FROM evidence.quantity OR journal.value_minor IS DISTINCT FROM evidence.value_minor)
  THEN RAISE EXCEPTION 'Zwrot nie odpowiada fizycznej ilości sprawy i pierwotnej wartości warstw' USING ERRCODE='23514';END IF;
 ELSIF EXISTS(SELECT 1 FROM wms_return_fragments r WHERE (r.tenant_id,r.operation_id)=(op.tenant_id,op.id)) THEN
  RAISE EXCEPTION 'Fragment zwrotu ma inny typ operacji' USING ERRCODE='23514';
 END IF;
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;

-- Transition relations belong to this genuine trigger invocation, never to a
-- request body. Enqueue AFTER STATEMENT preserves IMMEDIATE multirow semantics.
CREATE FUNCTION wms_enqueue_validation_scopes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY (CASE TG_OP WHEN 'INSERT' THEN ARRAY['wms_new_rows']
  WHEN 'DELETE' THEN ARRAY['wms_old_rows'] ELSE ARRAY['wms_old_rows','wms_new_rows'] END) LOOP
  IF TG_TABLE_NAME='wms_policies' THEN
   EXECUTE format('INSERT INTO public.wms_validation_scopes(transaction_id,tenant_id,kind,scope_id)
    SELECT pg_current_xact_id(),tenant_id,''policy'',''tenant'' FROM %I GROUP BY tenant_id ON CONFLICT DO NOTHING',relation_name);
  ELSE
   IF TG_TABLE_NAME IN ('stock','stock_locations','reservations','reservation_locations','wms_layer_positions','wms_reservation_layers','wms_layer_movements') THEN
    EXECUTE format('INSERT INTO public.wms_validation_scopes(transaction_id,tenant_id,kind,scope_id,warehouse_id,product_id)
     SELECT pg_current_xact_id(),tenant_id,''quantity'',warehouse_id::text||'':''||product_id::text,warehouse_id,product_id
     FROM %I GROUP BY tenant_id,warehouse_id,product_id ON CONFLICT DO NOTHING',relation_name);
   END IF;
   IF TG_TABLE_NAME IN ('wms_layer_movements','wms_issue_fragments','wms_return_fragments') THEN
    EXECUTE format('INSERT INTO public.wms_validation_scopes(transaction_id,tenant_id,kind,scope_id,operation_id)
     SELECT pg_current_xact_id(),tenant_id,''operation'',operation_id::text,operation_id FROM %I
     GROUP BY tenant_id,operation_id ON CONFLICT DO NOTHING',relation_name);
   END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END $$;

CREATE FUNCTION wms_flush_validation_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pending public.wms_validation_scopes%ROWTYPE;
BEGIN
 IF NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
  RAISE EXCEPTION 'Obcy właściciel walidacji WMS' USING ERRCODE='23514';
 END IF;
 SELECT * INTO pending FROM public.wms_validation_scopes WHERE
  (transaction_id,tenant_id,kind,scope_id)=(NEW.transaction_id,NEW.tenant_id,NEW.kind,NEW.scope_id);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF pending.kind='operation' THEN
  PERFORM public.wms_validate_operation_scope(pending.tenant_id,pending.operation_id);
 ELSE
  PERFORM public.wms_validate_quantity_scope(pending.tenant_id,pending.warehouse_id,pending.product_id,pending.kind='policy');
 END IF;
 -- Deletion is transactional. Future writes recreate the scope; savepoint
 -- rollback restores both dirty registrations and any earlier flush deletion.
 DELETE FROM public.wms_validation_scopes WHERE
  (transaction_id,tenant_id,kind,scope_id)=(pending.transaction_id,pending.tenant_id,pending.kind,pending.scope_id);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wms_validation_flush AFTER INSERT ON wms_validation_scopes
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms_flush_validation_scope();
REVOKE ALL ON FUNCTION wms_validate_quantity_scope(uuid,uuid,uuid,boolean),wms_validate_operation_scope(uuid,uuid),
 wms_enqueue_validation_scopes(),wms_flush_validation_scope() FROM PUBLIC,dyna_app;

-- Retain all FK/source/provenance/immutable/stocktake guards. Replace only the
-- duplicated 025/090 deferred quantity and operation trigger wiring.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['stock','stock_locations','reservations','reservation_locations'] LOOP
  EXECUTE format('DROP TRIGGER %I ON public.%I',CASE tab WHEN 'stock' THEN 'stock_location_stock_guard'
   WHEN 'stock_locations' THEN 'stock_location_bin_guard' WHEN 'reservations' THEN 'stock_location_reservation_guard'
   ELSE 'stock_location_allocation_guard' END,tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['stock','stock_locations','reservations','reservation_locations','wms_layer_positions','wms_reservation_layers','wms_layer_movements'] LOOP
  EXECUTE format('DROP TRIGGER wms_consistency ON public.%I',tab);
 END LOOP;
END $$;
DROP TRIGGER wms_policy_consistency ON wms_policies;
DROP TRIGGER wms_journal_consistency ON wms_layer_movements;
DROP TRIGGER wms_return_consistency ON wms_return_fragments;
DROP TRIGGER wms_issue_consistency ON wms_issue_fragments;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['stock','stock_locations','reservations','reservation_locations','wms_layer_positions','wms_reservation_layers','wms_layer_movements','wms_issue_fragments','wms_return_fragments'] LOOP
  EXECUTE format('CREATE TRIGGER wms_scope_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS wms_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.wms_enqueue_validation_scopes()',tab);
  EXECUTE format('CREATE TRIGGER wms_scope_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS wms_old_rows NEW TABLE AS wms_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.wms_enqueue_validation_scopes()',tab);
  EXECUTE format('CREATE TRIGGER wms_scope_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS wms_old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.wms_enqueue_validation_scopes()',tab);
 END LOOP;
END $$;
CREATE TRIGGER wms_scope_policy_insert AFTER INSERT ON wms_policies REFERENCING NEW TABLE AS wms_new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION public.wms_enqueue_validation_scopes();
CREATE INDEX wms_reservations_position_active ON wms_reservation_layers(tenant_id,warehouse_id,product_id,location,layer_id,order_id)
 INCLUDE(quantity,scanned) WHERE state='active';
