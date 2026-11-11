-- Additive FIFO warehouse model. No historical tenant is enabled by this migration.
ALTER TABLE reservation_locations ADD UNIQUE(tenant_id,order_id,product_id,warehouse_id,location);
ALTER TABLE purchase_receipts ADD UNIQUE(tenant_id,id);
CREATE TABLE wms_operations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL,source text NOT NULL CHECK(source IN ('manual','api','system')),
 policy_version bigint NOT NULL CHECK(policy_version>0),
 order_id uuid,warehouse_document_id uuid,purchase_receipt_id uuid,return_id uuid,
 request jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_document_id) REFERENCES warehouse_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_receipt_id) REFERENCES purchase_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 CHECK(return_id IS NULL OR order_id IS NOT NULL)
);
CREATE UNIQUE INDEX wms_receipt_document_once ON wms_operations(tenant_id,warehouse_document_id)
 WHERE kind='receipt' AND warehouse_document_id IS NOT NULL;
CREATE UNIQUE INDEX wms_order_dispatch_once ON wms_operations(tenant_id,order_id,(request->>'product_id'))
 WHERE kind='dispatch' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX wms_return_once ON wms_operations(tenant_id,return_id)
 WHERE kind='return' AND return_id IS NOT NULL;
CREATE INDEX wms_operations_page ON wms_operations(tenant_id,created_at DESC,id DESC);
CREATE INDEX wms_operations_order_page ON wms_operations(tenant_id,order_id,created_at DESC,id DESC) WHERE order_id IS NOT NULL;
CREATE TABLE wms_policies (
 tenant_id uuid PRIMARY KEY REFERENCES tenants,enabled boolean NOT NULL CHECK(enabled),
 version bigint NOT NULL CHECK(version>0),method text NOT NULL CHECK(method='FIFO'),
 currency text NOT NULL CHECK(currency IN ('PLN','EUR','USD','GBP','CZK')),
 exponent integer NOT NULL CHECK(exponent=2),opening_operation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,version),
 FOREIGN KEY(tenant_id,opening_operation_id) REFERENCES wms_operations(tenant_id,id)
 DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE wms_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('opening','issue','transfer','bin_move','adjustment')),
 policy_version bigint NOT NULL CHECK(policy_version>=0),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL,snapshot jsonb NOT NULL,ready boolean NOT NULL,issues jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at),UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key)
);
CREATE INDEX wms_previews_page ON wms_previews(tenant_id,created_at DESC,id DESC);
CREATE TABLE wms_lots (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,product_id uuid NOT NULL,operation_id uuid NOT NULL,
 lot_code text NOT NULL CHECK(char_length(lot_code)>=1 AND char_length(lot_code)<=100 AND lot_code=btrim(lot_code)),
 origin text NOT NULL CHECK(origin IN ('opening','receipt','adjustment','legacy_return')),
 expiry_date date,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,product_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE wms_cost_layers (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,lot_id uuid NOT NULL,product_id uuid NOT NULL,
 operation_id uuid NOT NULL,fifo_sequence bigint GENERATED ALWAYS AS IDENTITY CHECK(fifo_sequence>0),
 quantity_received integer NOT NULL CHECK(quantity_received>0),unit_cost_minor bigint CHECK(unit_cost_minor>=0),
 currency text NOT NULL CHECK(currency IN ('PLN','EUR','USD','GBP','CZK')),exponent integer NOT NULL CHECK(exponent=2),
 purchase_receipt_id uuid,warehouse_document_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,product_id),UNIQUE(tenant_id,id,product_id,lot_id),
 FOREIGN KEY(tenant_id,lot_id,product_id) REFERENCES wms_lots(tenant_id,id,product_id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,purchase_receipt_id,product_id) REFERENCES purchase_receipt_lines(tenant_id,receipt_id,product_id),
 FOREIGN KEY(tenant_id,warehouse_document_id,product_id) REFERENCES warehouse_document_lines(tenant_id,document_id,product_id),
 CHECK(unit_cost_minor IS NULL OR quantity_received::numeric*unit_cost_minor<=9223372036854775807)
);
CREATE INDEX wms_layer_fifo ON wms_cost_layers(tenant_id,product_id,fifo_sequence,id);
CREATE INDEX wms_layer_operation ON wms_cost_layers(tenant_id,operation_id,id);
CREATE TABLE wms_layer_positions (
 tenant_id uuid NOT NULL,warehouse_id uuid NOT NULL,product_id uuid NOT NULL,location text NOT NULL,
 layer_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>=0),reserved integer NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),CHECK(reserved>=0 AND reserved<=quantity),
 PRIMARY KEY(tenant_id,warehouse_id,product_id,location,layer_id),
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location) REFERENCES stock_locations(tenant_id,warehouse_id,product_id,location),
 FOREIGN KEY(tenant_id,layer_id,product_id) REFERENCES wms_cost_layers(tenant_id,id,product_id)
);
CREATE INDEX wms_positions_layer ON wms_layer_positions(tenant_id,layer_id,warehouse_id,location);
CREATE TABLE wms_reservation_layers (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,product_id uuid NOT NULL,warehouse_id uuid NOT NULL,
 location text NOT NULL,layer_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 scanned integer NOT NULL DEFAULT 0 CHECK(scanned>=0 AND scanned<=quantity),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','released','consumed')),
 PRIMARY KEY(tenant_id,order_id,product_id,warehouse_id,location,layer_id),
 FOREIGN KEY(tenant_id,order_id,product_id,warehouse_id,location)
 REFERENCES reservation_locations(tenant_id,order_id,product_id,warehouse_id,location),
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location,layer_id)
 REFERENCES wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id)
);
CREATE TABLE wms_layer_movements (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,operation_id uuid NOT NULL,
 warehouse_id uuid NOT NULL,product_id uuid NOT NULL,location text NOT NULL,layer_id uuid NOT NULL,
 delta integer NOT NULL CHECK(delta<>0),value_delta bigint,kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location,layer_id)
 REFERENCES wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id)
);
CREATE INDEX wms_journal_layer ON wms_layer_movements(tenant_id,warehouse_id,product_id,location,layer_id);
CREATE INDEX wms_journal_operation ON wms_layer_movements(tenant_id,operation_id,id);
CREATE TABLE wms_issue_fragments (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,operation_id uuid NOT NULL,order_id uuid,
 warehouse_document_id uuid,warehouse_id uuid NOT NULL,product_id uuid NOT NULL,location text NOT NULL,
 layer_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),unit_cost_minor bigint CHECK(unit_cost_minor>=0),
 value_minor bigint CHECK(value_minor>=0),currency text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,order_id,product_id,layer_id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,order_id,product_id,warehouse_id) REFERENCES reservations(tenant_id,order_id,product_id,warehouse_id),
 FOREIGN KEY(tenant_id,warehouse_document_id,product_id) REFERENCES warehouse_document_lines(tenant_id,document_id,product_id),
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location,layer_id)
 REFERENCES wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id),
 CHECK((unit_cost_minor IS NULL AND value_minor IS NULL) OR
 (unit_cost_minor IS NOT NULL AND value_minor IS NOT NULL AND quantity::numeric*unit_cost_minor=value_minor))
);
CREATE INDEX wms_issue_order ON wms_issue_fragments(tenant_id,order_id,product_id,id);
CREATE INDEX wms_issue_operation ON wms_issue_fragments(tenant_id,operation_id,id);
CREATE TABLE wms_return_fragments (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,operation_id uuid NOT NULL,order_id uuid NOT NULL,
 return_id uuid NOT NULL,issue_fragment_id uuid NOT NULL,product_id uuid NOT NULL,layer_id uuid NOT NULL,
 warehouse_id uuid NOT NULL,location text NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 value_minor bigint CHECK(value_minor>=0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,issue_fragment_id,order_id,product_id,layer_id)
 REFERENCES wms_issue_fragments(tenant_id,id,order_id,product_id,layer_id),
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location,layer_id)
 REFERENCES wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id)
);
CREATE INDEX wms_return_issue ON wms_return_fragments(tenant_id,issue_fragment_id,id);
CREATE INDEX wms_return_operation ON wms_return_fragments(tenant_id,operation_id,id);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY[
 'wms_policies','wms_operations','wms_previews','wms_lots','wms_cost_layers','wms_layer_positions',
 'wms_reservation_layers','wms_layer_movements','wms_issue_fragments','wms_return_fragments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
END LOOP; END $$;
GRANT UPDATE ON wms_layer_positions,wms_reservation_layers TO dyna_app;
CREATE FUNCTION wms_current_role(p_user uuid,p_lock boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r text; BEGIN
 IF p_lock THEN SELECT role INTO r FROM memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user FOR SHARE;
 ELSE SELECT role INTO r FROM memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user;END IF;
 RETURN r;END $$;
CREATE FUNCTION wms_key_grant(p_user uuid,p_key uuid,p_cost boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k record;BEGIN
 SELECT * INTO k FROM api_keys WHERE (tenant_id,user_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,p_user,p_key) FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['inventory:read','inventory:write']::text[] OR
 (p_cost AND NOT k.scopes @> ARRAY['purchasing:read','purchasing:write']::text[]) THEN RETURN 'insufficient';END IF;
 RETURN 'ok';END $$;
REVOKE ALL ON FUNCTION wms_current_role(uuid,boolean),wms_key_grant(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_current_role(uuid,boolean),wms_key_grant(uuid,uuid,boolean) TO dyna_app;
CREATE FUNCTION wms_key_read_grant(p_user uuid,p_key uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k record;BEGIN
 SELECT * INTO k FROM api_keys WHERE (tenant_id,user_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,p_user,p_key) FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN 'invalid';END IF;
 IF NOT ('inventory:read'=ANY(k.scopes)) THEN RETURN 'insufficient';END IF;
 RETURN CASE WHEN 'purchasing:read'=ANY(k.scopes) THEN 'value' ELSE 'quantity_only' END;END $$;
REVOKE ALL ON FUNCTION wms_key_read_grant(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_key_read_grant(uuid,uuid) TO dyna_app;
CREATE FUNCTION wms_key_order_read_grant(p_user uuid,p_key uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k record;BEGIN
 SELECT * INTO k FROM api_keys WHERE (tenant_id,user_id,id)=(nullif(current_setting('app.tenant_id',true),'')::uuid,p_user,p_key) FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RETURN 'invalid';END IF;
 IF NOT k.scopes @> ARRAY['inventory:read','orders:read']::text[] THEN RETURN 'insufficient';END IF;
 RETURN 'ok';END $$;
REVOKE ALL ON FUNCTION wms_key_order_read_grant(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_key_order_read_grant(uuid,uuid) TO dyna_app;
CREATE FUNCTION wms_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l record;op record;f record;p record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Historia WMS jest nieusuwalna' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME NOT IN ('wms_layer_positions','wms_reservation_layers') THEN RAISE EXCEPTION 'Dowód WMS jest niezmienny' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='wms_layer_positions' THEN
   IF (NEW.tenant_id,NEW.warehouse_id,NEW.product_id,NEW.location,NEW.layer_id) IS DISTINCT FROM
      (OLD.tenant_id,OLD.warehouse_id,OLD.product_id,OLD.location,OLD.layer_id) OR NEW.version::numeric<>OLD.version::numeric+1
   THEN RAISE EXCEPTION 'Nieprawidłowa rewizja pozycji WMS' USING ERRCODE='23514';END IF;
  ELSE
   IF (NEW.tenant_id,NEW.order_id,NEW.product_id,NEW.warehouse_id,NEW.location,NEW.layer_id,NEW.quantity) IS DISTINCT FROM
      (OLD.tenant_id,OLD.order_id,OLD.product_id,OLD.warehouse_id,OLD.location,OLD.layer_id,OLD.quantity) OR
      OLD.state<>'active' OR NEW.scanned<OLD.scanned OR (NEW.state<>'active' AND NEW.scanned<>OLD.scanned)
   THEN RAISE EXCEPTION 'Nieprawidłowa zmiana przypisania WMS' USING ERRCODE='23514';END IF;
  END IF;RETURN NEW;
 END IF;
 IF TG_TABLE_NAME IN ('wms_layer_movements','wms_issue_fragments','wms_return_fragments') THEN
  SELECT * INTO l FROM wms_cost_layers WHERE (tenant_id,id,product_id)=(NEW.tenant_id,NEW.layer_id,NEW.product_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Brak własnej warstwy WMS' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='wms_layer_movements' THEN
   IF (l.unit_cost_minor IS NULL AND NEW.value_delta IS NOT NULL) OR (l.unit_cost_minor IS NOT NULL AND
      (NEW.value_delta IS NULL OR NEW.value_delta::numeric<>NEW.delta::numeric*l.unit_cost_minor))
   THEN RAISE EXCEPTION 'Ruch ma inny koszt niż warstwa' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='wms_issue_fragments' THEN
   IF (NEW.unit_cost_minor,NEW.currency) IS DISTINCT FROM (l.unit_cost_minor,l.currency)
   THEN RAISE EXCEPTION 'Wydanie ma inny koszt niż warstwa' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO f FROM wms_issue_fragments WHERE (tenant_id,id,order_id,product_id,layer_id)=
     (NEW.tenant_id,NEW.issue_fragment_id,NEW.order_id,NEW.product_id,NEW.layer_id);
   IF NOT FOUND OR NEW.value_minor IS DISTINCT FROM
      (CASE WHEN f.unit_cost_minor IS NULL THEN NULL ELSE NEW.quantity::bigint*f.unit_cost_minor END)
   THEN RAISE EXCEPTION 'Zwrot nie odtwarza kosztu wydania' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='wms_cost_layers' THEN
  SELECT * INTO p FROM wms_lots WHERE (tenant_id,id,product_id)=(NEW.tenant_id,NEW.lot_id,NEW.product_id);
  IF p.origin NOT IN ('opening','legacy_return') AND NEW.unit_cost_minor IS NULL
  THEN RAISE EXCEPTION 'Nowa dostawa wymaga znanego kosztu' USING ERRCODE='23514';END IF;
  IF NEW.purchase_receipt_id IS NOT NULL THEN
   SELECT po.currency,pl.unit_cost,rl.quantity,pr.document_id INTO f FROM purchase_receipt_lines rl
   JOIN purchase_receipts pr ON (pr.tenant_id,pr.id)=(rl.tenant_id,rl.receipt_id)
   JOIN purchase_orders po ON (po.tenant_id,po.id)=(rl.tenant_id,rl.order_id)
   JOIN purchase_order_lines pl ON (pl.tenant_id,pl.order_id,pl.product_id)=(rl.tenant_id,rl.order_id,rl.product_id)
   WHERE (rl.tenant_id,rl.receipt_id,rl.product_id)=(NEW.tenant_id,NEW.purchase_receipt_id,NEW.product_id);
   IF NOT FOUND OR (NEW.currency,NEW.unit_cost_minor,NEW.warehouse_document_id) IS DISTINCT FROM
      (f.currency,f.unit_cost::bigint,f.document_id)
   THEN RAISE EXCEPTION 'Koszt nie odpowiada rzeczywistemu przyjęciu PO' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY[
 'wms_policies','wms_operations','wms_previews','wms_lots','wms_cost_layers','wms_layer_positions',
 'wms_reservation_layers','wms_layer_movements','wms_issue_fragments','wms_return_fragments'] LOOP
 EXECUTE format('CREATE TRIGGER wms_row_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION wms_row_guard()',t);
END LOOP;END $$;
CREATE FUNCTION wms_consistency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t uuid;w uuid;p uuid;s record;stock_row record;prior_scope text;BEGIN
 prior_scope:=current_setting('app.tenant_id',true);
 t:=coalesce(NEW.tenant_id,OLD.tenant_id);
 -- Deferred events can originate in several authorized B2B tenants in one TX.
 -- Their INSERT/UPDATE has already passed RLS; never retain this event-local scope.
 PERFORM set_config('app.tenant_id',t::text,true);
 IF NOT EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=t AND enabled) THEN
  PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;END IF;
 IF TG_TABLE_NAME='wms_policies' THEN
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
  END LOOP;PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 END IF;
 w:=coalesce(NEW.warehouse_id,OLD.warehouse_id);p:=coalesce(NEW.product_id,OLD.product_id);
 SELECT * INTO s FROM stock WHERE (tenant_id,warehouse_id,product_id)=(t,w,p);
 IF NOT FOUND THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;END IF;
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
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY[
 'stock','stock_locations','reservations','reservation_locations','wms_layer_positions','wms_reservation_layers','wms_layer_movements'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER wms_consistency AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms_consistency_guard()',t);
END LOOP;END $$;
CREATE CONSTRAINT TRIGGER wms_policy_consistency AFTER INSERT ON wms_policies DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION wms_consistency_guard();
CREATE FUNCTION wms_fragment_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_issue record;return_case record;op record;prior_scope text;BEGIN
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 IF TG_TABLE_NAME='wms_return_fragments' THEN
  SELECT quantity INTO original_issue FROM wms_issue_fragments WHERE (tenant_id,id)=(NEW.tenant_id,NEW.issue_fragment_id);
  IF (SELECT sum(quantity) FROM wms_return_fragments WHERE (tenant_id,issue_fragment_id)=(NEW.tenant_id,NEW.issue_fragment_id))>original_issue.quantity
  THEN RAISE EXCEPTION 'Zwrócono więcej niż pierwotnie wydano' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO op FROM wms_operations WHERE (tenant_id,id)=(NEW.tenant_id,NEW.operation_id);
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
 PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE CONSTRAINT TRIGGER wms_journal_consistency AFTER INSERT ON wms_layer_movements DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION wms_fragment_consistency();
CREATE CONSTRAINT TRIGGER wms_return_consistency AFTER INSERT ON wms_return_fragments DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION wms_fragment_consistency();
CREATE CONSTRAINT TRIGGER wms_issue_consistency AFTER INSERT ON wms_issue_fragments DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION wms_fragment_consistency();
CREATE FUNCTION wms_source_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op record;pol record;source record;lot record;prior_scope text;BEGIN
 prior_scope:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 SELECT * INTO op FROM wms_operations WHERE (tenant_id,id)=(NEW.tenant_id,NEW.operation_id);
 SELECT * INTO pol FROM wms_policies WHERE tenant_id=NEW.tenant_id;
 SELECT * INTO lot FROM wms_lots WHERE (tenant_id,id)=(NEW.tenant_id,NEW.lot_id);
 IF NOT FOUND OR op.id IS NULL OR pol.tenant_id IS NULL OR NEW.currency<>pol.currency OR
    op.policy_version<>pol.version OR lot.operation_id<>NEW.operation_id
 THEN RAISE EXCEPTION 'Warstwa nie ma zgodnego właściciela i waluty polityki' USING ERRCODE='23514';END IF;
 IF (NEW.warehouse_document_id,NEW.purchase_receipt_id) IS DISTINCT FROM
    (op.warehouse_document_id,op.purchase_receipt_id)
 THEN RAISE EXCEPTION 'Warstwa nie odpowiada typed source operacji' USING ERRCODE='23514';END IF;
 IF NEW.purchase_receipt_id IS NOT NULL THEN
  SELECT quantity INTO source FROM purchase_receipt_lines WHERE
    (tenant_id,receipt_id,product_id)=(NEW.tenant_id,NEW.purchase_receipt_id,NEW.product_id);
  IF NOT FOUND OR (SELECT coalesce(sum(quantity_received),0) FROM wms_cost_layers WHERE
    (tenant_id,purchase_receipt_id,product_id)=(NEW.tenant_id,NEW.purchase_receipt_id,NEW.product_id))<>source.quantity
  THEN RAISE EXCEPTION 'Warstwy nie pokrywają dokładnej ilości przyjęcia PO' USING ERRCODE='23514';END IF;
 END IF;
 IF lot.origin='receipt' THEN
  IF op.kind<>'receipt' OR NEW.warehouse_document_id IS NULL THEN
   RAISE EXCEPTION 'Nowe przyjęcie nie ma rzeczywistego PZ' USING ERRCODE='23514';END IF;
  SELECT l.quantity,d.kind,d.status INTO source FROM warehouse_document_lines l JOIN warehouse_documents d
   ON (d.tenant_id,d.id)=(l.tenant_id,l.document_id) WHERE
   (l.tenant_id,l.document_id,l.product_id)=(NEW.tenant_id,NEW.warehouse_document_id,NEW.product_id);
  IF NOT FOUND OR source.kind<>'receipt' OR source.status<>'posted' OR
     (SELECT coalesce(sum(quantity_received),0) FROM wms_cost_layers WHERE
      (tenant_id,warehouse_document_id,product_id)=(NEW.tenant_id,NEW.warehouse_document_id,NEW.product_id))<>source.quantity
  THEN RAISE EXCEPTION 'Warstwy nie pokrywają dokładnej ilości zaksięgowanego PZ' USING ERRCODE='23514';END IF;
 ELSIF lot.origin='opening' AND op.kind<>'opening' THEN
  RAISE EXCEPTION 'Warstwa otwarcia ma inny typ operacji' USING ERRCODE='23514';
 ELSIF lot.origin='adjustment' AND op.kind<>'adjustment' THEN
  RAISE EXCEPTION 'Warstwa korekty ma inny typ operacji' USING ERRCODE='23514';
 ELSIF lot.origin='legacy_return' AND (op.kind<>'return' OR op.return_id IS NULL) THEN
  RAISE EXCEPTION 'Nieznany zwrot nie ma własnej sprawy' USING ERRCODE='23514';
 END IF;PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RETURN NULL;
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(prior_scope,''),true);RAISE;END $$;
CREATE CONSTRAINT TRIGGER wms_source_consistency AFTER INSERT ON wms_cost_layers DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION wms_source_consistency();
