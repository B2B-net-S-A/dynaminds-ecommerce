CREATE TABLE stock_locations (
 tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,product_id uuid NOT NULL,
 location text NOT NULL CHECK(length(location)>=1 AND length(location)<=80 AND location=btrim(location)),
 quantity integer NOT NULL DEFAULT 0 CHECK(quantity>=0),
 PRIMARY KEY(tenant_id,warehouse_id,product_id,location),
 FOREIGN KEY(tenant_id,warehouse_id,product_id) REFERENCES stock(tenant_id,warehouse_id,product_id)
);
CREATE INDEX reservations_active_location ON reservations(tenant_id,warehouse_id,product_id,order_id) WHERE state='active';
ALTER TABLE reservations ADD UNIQUE(tenant_id,order_id,product_id,warehouse_id);
CREATE TABLE reservation_locations (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,product_id uuid NOT NULL,warehouse_id uuid NOT NULL,location text NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),scanned integer NOT NULL DEFAULT 0 CHECK(scanned BETWEEN 0 AND quantity),
 PRIMARY KEY(tenant_id,order_id,product_id,location),
 FOREIGN KEY(tenant_id,order_id,product_id,warehouse_id) REFERENCES reservations(tenant_id,order_id,product_id,warehouse_id),
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location) REFERENCES stock_locations(tenant_id,warehouse_id,product_id,location)
);
CREATE INDEX reservation_locations_bin ON reservation_locations(tenant_id,warehouse_id,product_id,location,order_id);
CREATE TABLE stock_location_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,product_id uuid NOT NULL,location text NOT NULL,
 delta integer NOT NULL CHECK(delta<>0),kind text NOT NULL,order_id uuid,operation_id uuid,note text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location) REFERENCES stock_locations(tenant_id,warehouse_id,product_id,location),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE INDEX stock_location_movements_history ON stock_location_movements(tenant_id,warehouse_id,product_id,created_at DESC,id DESC);
CREATE TABLE stock_location_operations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,idempotency_key uuid NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,idempotency_key)
);
INSERT INTO stock_locations SELECT tenant_id,warehouse_id,product_id,location,on_hand FROM stock;
INSERT INTO reservation_locations(tenant_id,order_id,product_id,warehouse_id,location,quantity,scanned)
 SELECT r.tenant_id,r.order_id,r.product_id,r.warehouse_id,s.location,r.quantity,coalesce(i.scanned,0)
 FROM reservations r JOIN stock s USING(tenant_id,warehouse_id,product_id)
 LEFT JOIN order_pick_items i USING(tenant_id,order_id,product_id) WHERE r.state='active';
CREATE FUNCTION stock_location_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE difference bigint; remaining bigint; piece integer; bin record; target text;
BEGIN
 SELECT NEW.on_hand-coalesce(sum(quantity),0) INTO difference FROM stock_locations WHERE (tenant_id,warehouse_id,product_id)=(NEW.tenant_id,NEW.warehouse_id,NEW.product_id);
 IF difference>0 THEN
  target:=coalesce(nullif(current_setting('app.stock_location',true),''),NEW.location);
  INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) VALUES(NEW.tenant_id,NEW.warehouse_id,NEW.product_id,target,difference)
   ON CONFLICT(tenant_id,warehouse_id,product_id,location) DO UPDATE SET quantity=stock_locations.quantity+excluded.quantity;
  INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind) VALUES(NEW.tenant_id,NEW.warehouse_id,NEW.product_id,target,difference,'stock_in');
 ELSIF difference<0 THEN
  remaining:=-difference;
  FOR bin IN SELECT l.location,l.quantity-coalesce((SELECT sum(a.quantity) FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE (a.tenant_id,a.warehouse_id,a.product_id,a.location)=(l.tenant_id,l.warehouse_id,l.product_id,l.location) AND r.state='active'),0) AS available
   FROM stock_locations l WHERE (l.tenant_id,l.warehouse_id,l.product_id)=(NEW.tenant_id,NEW.warehouse_id,NEW.product_id) ORDER BY l.location FOR UPDATE OF l LOOP
   piece:=least(remaining,greatest(0,bin.available));
   IF piece>0 THEN
    UPDATE stock_locations SET quantity=quantity-piece WHERE (tenant_id,warehouse_id,product_id,location)=(NEW.tenant_id,NEW.warehouse_id,NEW.product_id,bin.location);
    INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind) VALUES(NEW.tenant_id,NEW.warehouse_id,NEW.product_id,bin.location,-piece,'stock_out');
    remaining:=remaining-piece;
   END IF;
   EXIT WHEN remaining=0;
  END LOOP;
  IF remaining<>0 THEN RAISE EXCEPTION 'Zmiana stanu narusza rezerwacje lokalizacji' USING ERRCODE='23514'; END IF;
 ELSE
  INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) VALUES(NEW.tenant_id,NEW.warehouse_id,NEW.product_id,NEW.location,0) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_location_reconcile AFTER INSERT OR UPDATE OF on_hand ON stock FOR EACH ROW EXECUTE FUNCTION stock_location_reconcile();
CREATE FUNCTION stock_location_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t uuid; w uuid; p uuid; s record; held bigint;
BEGIN
 t:=coalesce(NEW.tenant_id,OLD.tenant_id); w:=coalesce(NEW.warehouse_id,OLD.warehouse_id); p:=coalesce(NEW.product_id,OLD.product_id);
 SELECT * INTO s FROM stock WHERE (tenant_id,warehouse_id,product_id)=(t,w,p);
 IF NOT FOUND THEN RETURN NULL; END IF;
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
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_location_stock_guard AFTER INSERT OR UPDATE OR DELETE ON stock DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_location_consistency();
CREATE CONSTRAINT TRIGGER stock_location_bin_guard AFTER INSERT OR UPDATE OR DELETE ON stock_locations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_location_consistency();
CREATE CONSTRAINT TRIGGER stock_location_allocation_guard AFTER INSERT OR UPDATE OR DELETE ON reservation_locations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_location_consistency();
CREATE CONSTRAINT TRIGGER stock_location_reservation_guard AFTER INSERT OR UPDATE OR DELETE ON reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_location_consistency();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['stock_locations','reservation_locations','stock_location_movements','stock_location_operations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 END LOOP;
END $$;
GRANT UPDATE ON stock_locations,reservation_locations TO dyna_app;
