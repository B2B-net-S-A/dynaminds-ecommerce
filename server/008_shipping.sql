ALTER TABLE shipments ADD COLUMN channel_id uuid;
ALTER TABLE shipments ADD COLUMN external_id text;
ALTER TABLE shipments ADD COLUMN dispatched_at timestamptz;
ALTER TABLE shipments ADD COLUMN tracking_data jsonb;
ALTER TABLE shipments ADD COLUMN tracking_at timestamptz;
ALTER TABLE shipments ADD FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id);
ALTER TABLE shipments ADD UNIQUE(tenant_id,id);
UPDATE shipments SET dispatched_at=created_at WHERE mode='demo';
CREATE TABLE shipping_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','quoted','buy_queued','ready','failed','dispatched','cancelled','cancel_queued')),
 phase text NOT NULL DEFAULT 'ready',input jsonb NOT NULL,payload jsonb NOT NULL,order_snapshot jsonb NOT NULL,
 remote_id text,offers jsonb NOT NULL DEFAULT '[]',selected_offer jsonb,result jsonb,error text,shipment_id uuid,job_id uuid REFERENCES jobs,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id)
);
CREATE UNIQUE INDEX shipping_order_active ON shipping_plans(tenant_id,order_id) WHERE state NOT IN ('preview','cancelled','dispatched');
CREATE INDEX shipping_order_page ON shipping_plans(tenant_id,order_id,created_at DESC,id DESC);
ALTER TABLE shipping_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON shipping_plans TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON shipping_plans TO dyna_app;
