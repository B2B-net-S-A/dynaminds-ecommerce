CREATE TABLE stocktakes (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,warehouse_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 3 AND 100),location_prefix text NOT NULL DEFAULT '',blind boolean NOT NULL DEFAULT true,
 state text NOT NULL DEFAULT 'counting' CHECK(state IN ('counting','review','posted','cancelled')),
 version bigint NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES users,client_key uuid NOT NULL,input_hash text NOT NULL,
 review_hash text,posted_by uuid REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),posted_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 CHECK((state='posted')=(posted_at IS NOT NULL)),CHECK((state='posted')=(posted_by IS NOT NULL))
);
CREATE INDEX stocktakes_page ON stocktakes(tenant_id,created_at DESC,id DESC);
CREATE INDEX stocktakes_open ON stocktakes(tenant_id,id) WHERE state IN ('counting','review');
CREATE TABLE stocktake_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,stocktake_id uuid NOT NULL,product_id uuid NOT NULL,
 sku text NOT NULL,name text NOT NULL,location text NOT NULL,original_quantity integer NOT NULL CHECK(original_quantity>=0),
 basis_quantity integer NOT NULL CHECK(basis_quantity>=0),basis_version bigint NOT NULL,
 counted integer CHECK(counted BETWEEN 0 AND 1000000),version bigint NOT NULL DEFAULT 1,counted_by uuid REFERENCES users,counted_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,stocktake_id,product_id,location),
 FOREIGN KEY(tenant_id,stocktake_id) REFERENCES stocktakes(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 CHECK((counted IS NULL)=(counted_at IS NULL)),CHECK((counted IS NULL)=(counted_by IS NULL))
);
CREATE INDEX stocktake_lines_page ON stocktake_lines(tenant_id,stocktake_id,product_id,location);
CREATE TABLE stocktake_measurements (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,stocktake_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,actor_name text NOT NULL,
 client_key uuid NOT NULL,input_hash text NOT NULL,inputs jsonb NOT NULL,result jsonb NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,stocktake_id) REFERENCES stocktakes(tenant_id,id)
);
CREATE INDEX stocktake_measurements_page ON stocktake_measurements(tenant_id,stocktake_id,created_at DESC,id DESC);
ALTER TABLE stock_movements ADD COLUMN stocktake_id uuid;
ALTER TABLE stock_location_movements ADD COLUMN stocktake_id uuid;
ALTER TABLE stock_movements ADD FOREIGN KEY(tenant_id,stocktake_id) REFERENCES stocktakes(tenant_id,id);
ALTER TABLE stock_location_movements ADD FOREIGN KEY(tenant_id,stocktake_id) REFERENCES stocktakes(tenant_id,id);
CREATE INDEX stock_movements_stocktake ON stock_movements(tenant_id,stocktake_id) WHERE stocktake_id IS NOT NULL;
CREATE INDEX stock_location_movements_stocktake ON stock_location_movements(tenant_id,stocktake_id) WHERE stocktake_id IS NOT NULL;
CREATE FUNCTION stocktake_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_state text;
BEGIN
 SELECT state INTO parent_state FROM stocktakes WHERE (tenant_id,id)=(NEW.tenant_id,NEW.stocktake_id) FOR SHARE;
 IF parent_state IS DISTINCT FROM 'counting' THEN RAISE EXCEPTION 'Pozycje spisu można zmieniać tylko podczas liczenia'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.tenant_id,NEW.stocktake_id,NEW.product_id,NEW.sku,NEW.name,NEW.location,NEW.original_quantity) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.stocktake_id,OLD.product_id,OLD.sku,OLD.name,OLD.location,OLD.original_quantity) THEN RAISE EXCEPTION 'Zakres spisu jest niezmienny'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stocktake_line_guard BEFORE INSERT OR UPDATE ON stocktake_lines FOR EACH ROW EXECUTE FUNCTION stocktake_line_guard();
CREATE FUNCTION stocktake_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state IN ('posted','cancelled') THEN RAISE EXCEPTION 'Zamknięty spis jest niezmienny'; END IF;
 IF ROW(NEW.id,NEW.tenant_id,NEW.warehouse_id,NEW.name,NEW.location_prefix,NEW.blind,NEW.created_by,NEW.client_key,NEW.input_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.warehouse_id,OLD.name,OLD.location_prefix,OLD.blind,OLD.created_by,OLD.client_key,OLD.input_hash,OLD.created_at) THEN RAISE EXCEPTION 'Zakres spisu jest niezmienny'; END IF;
 IF NEW.state='posted' AND OLD.state<>'review' THEN RAISE EXCEPTION 'Zatwierdzenie wymaga przeglądu'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stocktake_guard BEFORE UPDATE ON stocktakes FOR EACH ROW EXECUTE FUNCTION stocktake_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['stocktakes','stocktake_lines','stocktake_measurements'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',t);
 END LOOP; END $$;
GRANT UPDATE ON stocktakes,stocktake_lines TO dyna_app;
