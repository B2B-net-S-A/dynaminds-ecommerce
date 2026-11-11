CREATE TABLE picking_waves (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),warehouse_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
 state text NOT NULL DEFAULT 'picking' CHECK(state IN ('picking','completed','cancelled')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL REFERENCES users(id),
 client_key uuid NOT NULL,input_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 CHECK((state='picking')=(finished_at IS NULL))
);
CREATE INDEX picking_waves_page ON picking_waves(tenant_id,state,created_at DESC,id DESC);
CREATE TABLE picking_wave_orders (
 tenant_id uuid NOT NULL,wave_id uuid NOT NULL,order_id uuid NOT NULL,slot integer NOT NULL CHECK(slot BETWEEN 1 AND 100),
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,wave_id,order_id),UNIQUE(tenant_id,wave_id,slot),
 FOREIGN KEY(tenant_id,wave_id) REFERENCES picking_waves(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE UNIQUE INDEX picking_wave_active_order ON picking_wave_orders(tenant_id,order_id) WHERE active;
CREATE TABLE picking_wave_scans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,wave_id uuid NOT NULL,order_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),
 client_key uuid NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,wave_id,order_id) REFERENCES picking_wave_orders(tenant_id,wave_id,order_id)
);
CREATE INDEX picking_wave_scans_page ON picking_wave_scans(tenant_id,wave_id,created_at DESC,id DESC);
CREATE INDEX orders_pick_candidates ON orders(tenant_id,warehouse_id,created_at,id)
 WHERE status IN ('paid','picking') OR (status='new' AND payment_mode='cod');
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['picking_waves','picking_wave_orders','picking_wave_scans'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',t);
END LOOP; END $$;

REVOKE UPDATE ON picking_wave_scans FROM dyna_app;
