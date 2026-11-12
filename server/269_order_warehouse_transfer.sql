-- Migration 269_order_warehouse_transfer (Uwagi v3 §0, "Zmień magazyn" on the order card and the rule effect
-- "Przypisz magazyn"; registered after 267_status_categories_automation_editors).
--
-- An order's reservations are keyed (tenant, order, product) and the warehouse of a reservation row is sealed
-- (146: "Tożsamość fizycznego stanu magazynu jest stała"); the app role cannot delete location rows. The move is
-- therefore one owner function that never changes a row's identity: in one transaction it gives the reserved stock
-- and the location rows back in the old warehouse (stock.reserved down, reservation_locations and reservations rows
-- deleted), changes orders.warehouse_id, and reserves the same quantities in the new warehouse as createOrder does
-- (stock.reserved up, a new reservations row, location rows taken bin by bin in location order). All or nothing:
-- any refusal rolls back the whole move. 146, 104, 134 and 137 keep their bodies; their triggers see a DELETE and
-- an INSERT, which they admit.
--
-- 1. The log of moves: one row per move with the lines (product, quantity, old and new locations). Owner-private
--    like the other custody logs; dyna_app writes and reads it only through the function below.
CREATE TABLE order_warehouse269_transfers (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL,
 from_warehouse_id uuid NOT NULL,
 to_warehouse_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('manual','api','automation')),
 lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 CHECK(from_warehouse_id<>to_warehouse_id)
);
CREATE INDEX order_warehouse269_transfers_order ON order_warehouse269_transfers(tenant_id,order_id,created_at);
ALTER TABLE order_warehouse269_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_warehouse269_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON order_warehouse269_transfers TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON order_warehouse269_transfers FROM PUBLIC,dyna_app;

-- 2. The move. The tenant is the caller's app.tenant_id; the actor must be an admin or operator of it. Refused in
--    Polish (P0001, the API answers 409 with the message): another company's or the same warehouse, an order past
--    "Nowe"/"Opłacone", a replacement, split or merge order, an order with a shipment, documents, WZ, stock
--    movements, picking, scans, WMS lots or a reservation that is not wholly active, and a new warehouse without
--    enough free stock or free location stock for any line.
CREATE FUNCTION order_warehouse269_transfer(p_order uuid,p_warehouse uuid,p_actor uuid,p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o public.orders;w_from public.warehouses;w_to public.warehouses;
 r record;b record;s public.stock;sku text;remaining integer;take integer;moved jsonb:='[]';line jsonb;bins jsonb;transfer uuid;short text[]:='{}';
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Brak kontekstu firmy' USING ERRCODE='42501';END IF;
 IF p_source IS NULL OR p_source NOT IN('manual','api','automation') THEN RAISE EXCEPTION 'Nieprawidłowe źródło zmiany magazynu' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.tenant_id=t AND m.user_id=p_actor AND m.role IN('admin','operator')) THEN
  RAISE EXCEPTION 'Brak uprawnień do zmiany magazynu zamówienia' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM public.orders WHERE tenant_id=t AND id=p_order FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Nie znaleziono zamówienia' USING ERRCODE='P0002';END IF;
 SELECT * INTO w_to FROM public.warehouses WHERE tenant_id=t AND id=p_warehouse;
 IF NOT FOUND THEN RAISE EXCEPTION 'Magazyn nie należy do tej firmy';END IF;
 IF o.warehouse_id=p_warehouse THEN RAISE EXCEPTION 'Zamówienie jest już przypisane do magazynu „%”',w_to.name;END IF;
 SELECT * INTO w_from FROM public.warehouses WHERE tenant_id=t AND id=o.warehouse_id;
 IF o.status NOT IN('new','paid') THEN RAISE EXCEPTION 'Magazyn można zmienić tylko przed rozpoczęciem kompletacji';END IF;
 IF o.fulfillment_kind IS DISTINCT FROM 'sale' THEN RAISE EXCEPTION 'Magazynu wymiany reklamacyjnej nie można zmienić';END IF;
 IF o.source IN('order_split','order_merge') THEN RAISE EXCEPTION 'Magazynu zamówienia powstałego z podziału lub łączenia nie można zmienić';END IF;
 IF EXISTS(SELECT 1 FROM public.shipments WHERE tenant_id=t AND order_id=p_order) THEN RAISE EXCEPTION 'Nie można zmienić magazynu, bo zamówienie ma przesyłkę';END IF;
 IF EXISTS(SELECT 1 FROM public.documents WHERE tenant_id=t AND order_id=p_order)
 OR EXISTS(SELECT 1 FROM public.warehouse_wz_issuer_admissions WHERE tenant_id=t AND order_id=p_order)
 OR EXISTS(SELECT 1 FROM public.warehouse_wz_issuer_receipts WHERE tenant_id=t AND order_id=p_order)
 OR EXISTS(SELECT 1 FROM public.parcel_physical_wz_bindings WHERE tenant_id=t AND order_id=p_order) THEN
  RAISE EXCEPTION 'Nie można zmienić magazynu, bo zamówienie ma wystawione dokumenty lub WZ';END IF;
 IF EXISTS(SELECT 1 FROM public.stock_movements WHERE tenant_id=t AND order_id=p_order)
 OR EXISTS(SELECT 1 FROM public.picking_wave_orders WHERE tenant_id=t AND order_id=p_order)
 OR EXISTS(SELECT 1 FROM public.packing_sessions WHERE tenant_id=t AND order_id=p_order)
 OR EXISTS(SELECT 1 FROM public.order_batch_items WHERE tenant_id=t AND order_id=p_order)
 OR EXISTS(SELECT 1 FROM public.order_pick_items WHERE tenant_id=t AND order_id=p_order AND scanned>0)
 OR EXISTS(SELECT 1 FROM public.reservation_locations WHERE tenant_id=t AND order_id=p_order AND scanned>0) THEN
  RAISE EXCEPTION 'Nie można zmienić magazynu, bo zamówienie ma kompletację lub ruchy magazynowe';END IF;
 IF EXISTS(SELECT 1 FROM public.wms_reservation_layers WHERE tenant_id=t AND order_id=p_order)
 OR EXISTS(SELECT 1 FROM public.wms_policies WHERE tenant_id=t AND enabled) THEN
  RAISE EXCEPTION 'Przy partiach WMS magazynu zamówienia nie można zmienić';END IF;
 IF EXISTS(SELECT 1 FROM public.reservations WHERE tenant_id=t AND order_id=p_order
  AND(state<>'active' OR warehouse_id<>o.warehouse_id OR consumed_quantity<>0 OR released_quantity<>0)) THEN
  RAISE EXCEPTION 'Nie można zmienić magazynu, bo rezerwacja zamówienia nie jest w pełni aktywna; najpierw zarezerwuj stan ponownie';END IF;
 IF EXISTS(SELECT 1 FROM public.order_pick_items p WHERE p.tenant_id=t AND p.order_id=p_order AND NOT EXISTS(
  SELECT 1 FROM public.reservations x WHERE(x.tenant_id,x.order_id,x.product_id)=(t,p_order,p.product_id) AND x.quantity=p.quantity)) THEN
  RAISE EXCEPTION 'Nie można zmienić magazynu, bo pozycje zamówienia nie są w pełni zarezerwowane; najpierw zarezerwuj stan';END IF;
 -- The stock rows of both warehouses are locked before any write, in one statement and one global order (warehouse,
 -- product): two moves in opposite directions over the same product wait for each other instead of deadlocking.
 PERFORM 1 FROM public.stock x JOIN public.reservations y ON(y.tenant_id,y.product_id)=(x.tenant_id,x.product_id)
  WHERE y.tenant_id=t AND y.order_id=p_order AND x.warehouse_id IN(o.warehouse_id,p_warehouse) ORDER BY x.warehouse_id,x.product_id FOR UPDATE OF x;
 FOR r IN SELECT y.product_id,y.quantity,p.sku FROM public.reservations y JOIN public.products p ON(p.tenant_id,p.id)=(y.tenant_id,y.product_id)
  WHERE y.tenant_id=t AND y.order_id=p_order ORDER BY y.product_id LOOP
  SELECT * INTO s FROM public.stock WHERE(tenant_id,warehouse_id,product_id)=(t,p_warehouse,r.product_id);
  IF s.product_id IS NULL OR s.available<r.quantity THEN
   short:=short||format('%s (dostępne %s, potrzebne %s)',r.sku,coalesce(s.available,0),r.quantity);END IF;
 END LOOP;
 IF cardinality(short)>0 THEN
  RAISE EXCEPTION 'Za mało towaru w magazynie „%”: %',w_to.name,array_to_string(short,', ');END IF;
 -- Old warehouse: the reserved stock and the location rows go back.
 FOR r IN SELECT y.product_id,y.quantity,p.sku FROM public.reservations y JOIN public.products p ON(p.tenant_id,p.id)=(y.tenant_id,y.product_id)
  WHERE y.tenant_id=t AND y.order_id=p_order ORDER BY y.product_id LOOP
  SELECT coalesce(jsonb_agg(jsonb_build_object('location',l.location,'quantity',l.quantity) ORDER BY l.location),'[]') INTO bins
   FROM public.reservation_locations l WHERE(l.tenant_id,l.order_id,l.product_id)=(t,p_order,r.product_id);
  moved:=moved||jsonb_build_array(jsonb_build_object('product_id',r.product_id,'sku',r.sku,'quantity',r.quantity,'from_locations',bins));
  UPDATE public.stock SET reserved=reserved-r.quantity WHERE(tenant_id,warehouse_id,product_id)=(t,o.warehouse_id,r.product_id);
  DELETE FROM public.reservation_locations WHERE(tenant_id,order_id,product_id)=(t,p_order,r.product_id);
  DELETE FROM public.reservations WHERE(tenant_id,order_id,product_id)=(t,p_order,r.product_id);
 END LOOP;
 UPDATE public.orders SET warehouse_id=p_warehouse,updated_at=now() WHERE tenant_id=t AND id=p_order;
 -- New warehouse: reserved as createOrder reserves (stock, reservation, free bins in location order).
 FOR line IN SELECT value FROM jsonb_array_elements(moved) LOOP
  UPDATE public.stock SET reserved=reserved+(line->>'quantity')::integer WHERE(tenant_id,warehouse_id,product_id)=(t,p_warehouse,(line->>'product_id')::uuid);
  INSERT INTO public.reservations(tenant_id,order_id,product_id,warehouse_id,quantity) VALUES(t,p_order,(line->>'product_id')::uuid,p_warehouse,(line->>'quantity')::integer);
  remaining:=(line->>'quantity')::integer;bins:='[]';
  FOR b IN SELECT l.location,(l.quantity-coalesce((SELECT sum(a.quantity-a.consumed_quantity) FROM public.reservation_locations a JOIN public.reservations x USING(tenant_id,order_id,product_id,warehouse_id)
    WHERE(a.tenant_id,a.warehouse_id,a.product_id,a.location)=(l.tenant_id,l.warehouse_id,l.product_id,l.location) AND x.state='active'),0))::integer available
   FROM public.stock_locations l WHERE(l.tenant_id,l.warehouse_id,l.product_id)=(t,p_warehouse,(line->>'product_id')::uuid) ORDER BY l.location LOOP
   take:=least(remaining,greatest(b.available,0));
   IF take>0 THEN
    INSERT INTO public.reservation_locations(tenant_id,order_id,product_id,warehouse_id,location,quantity) VALUES(t,p_order,(line->>'product_id')::uuid,p_warehouse,b.location,take);
    bins:=bins||jsonb_build_array(jsonb_build_object('location',b.location,'quantity',take));remaining:=remaining-take;
   END IF;
   EXIT WHEN remaining=0;
  END LOOP;
  IF remaining>0 THEN RAISE EXCEPTION 'Brak dostępnego towaru w lokalizacjach magazynu „%”: %',w_to.name,line->>'sku';END IF;
  moved:=(SELECT jsonb_agg(CASE WHEN e->>'product_id'=line->>'product_id' THEN e||jsonb_build_object('to_locations',bins) ELSE e END ORDER BY n) FROM jsonb_array_elements(moved) WITH ORDINALITY q(e,n));
 END LOOP;
 INSERT INTO public.order_warehouse269_transfers(tenant_id,order_id,from_warehouse_id,to_warehouse_id,actor_id,source,lines)
  VALUES(t,p_order,o.warehouse_id,p_warehouse,p_actor,p_source,moved) RETURNING id INTO transfer;
 RETURN jsonb_build_object('transfer_id',transfer,'order_id',p_order,'from_warehouse_id',o.warehouse_id,'from_warehouse_name',w_from.name,
  'to_warehouse_id',p_warehouse,'to_warehouse_name',w_to.name,'lines',moved);
END $$;
REVOKE ALL ON FUNCTION order_warehouse269_transfer(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_warehouse269_transfer(uuid,uuid,uuid,text) TO dyna_app;
