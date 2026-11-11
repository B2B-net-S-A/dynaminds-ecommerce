ALTER TABLE order_items ADD COLUMN line_total integer CHECK(line_total>=0);
UPDATE order_items SET line_total=price*quantity;
ALTER TABLE order_items ALTER COLUMN line_total SET NOT NULL;
ALTER TABLE orders ADD COLUMN source_snapshot jsonb;
ALTER TABLE listings DROP CONSTRAINT listings_tenant_id_channel_id_product_id_key;
ALTER TABLE listings ADD CONSTRAINT listing_external_unique UNIQUE(tenant_id,channel_id,external_id);
CREATE INDEX listings_product ON listings(tenant_id,product_id);
CREATE TABLE inbound_orders (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, channel_id uuid NOT NULL, external_id text NOT NULL,
 raw jsonb NOT NULL, normalized jsonb, source_hash text NOT NULL, imported_hash text,
 state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','imported','error')),
 issues jsonb NOT NULL DEFAULT '[]', order_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,channel_id,external_id), FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id), FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE INDEX inbound_queue ON inbound_orders(tenant_id,channel_id,updated_at DESC,id);
ALTER TABLE inbound_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inbound_orders TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON inbound_orders TO dyna_app;
