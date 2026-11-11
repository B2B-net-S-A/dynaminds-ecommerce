CREATE TABLE price_lists (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120),
 currency text NOT NULL CHECK(currency IN ('PLN','EUR','USD','GBP','CZK')),active boolean NOT NULL DEFAULT true,
 fallback boolean NOT NULL DEFAULT false,adjustment_bps integer NOT NULL DEFAULT 0 CHECK(adjustment_bps BETWEEN -9000 AND 100000),
 adjustment_amount integer NOT NULL DEFAULT 0 CHECK(adjustment_amount BETWEEN -100000000 AND 100000000),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE INDEX price_lists_page ON price_lists(tenant_id,id);
CREATE TABLE price_list_items (
 tenant_id uuid NOT NULL,price_list_id uuid NOT NULL,product_id uuid NOT NULL,price integer NOT NULL CHECK(price BETWEEN 0 AND 100000000),
 PRIMARY KEY(tenant_id,price_list_id,product_id),FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['price_lists','price_list_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP; END $$;
ALTER TABLE orders ADD COLUMN price_list_id uuid;
ALTER TABLE orders ADD COLUMN pricing_snapshot jsonb;
ALTER TABLE orders ADD FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id);
ALTER TABLE listings ADD COLUMN price_currency text;
UPDATE listings l SET price_currency=t.currency FROM tenants t WHERE l.tenant_id=t.id;
ALTER TABLE listings ALTER COLUMN price_currency SET NOT NULL;
CREATE FUNCTION listing_price_currency() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.price_currency IS NULL THEN SELECT currency INTO NEW.price_currency FROM tenants WHERE id=NEW.tenant_id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_price_currency BEFORE INSERT ON listings FOR EACH ROW EXECUTE FUNCTION listing_price_currency();
