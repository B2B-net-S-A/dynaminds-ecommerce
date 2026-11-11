ALTER TABLE channels ADD COLUMN oauth_scopes text NOT NULL DEFAULT '';
UPDATE channels SET oauth_scopes='allegro:api:orders:read allegro:api:sale:offers:read' WHERE provider='allegro' AND status='authorized_read';
ALTER TABLE oauth_states ADD COLUMN scope text NOT NULL DEFAULT 'allegro:api:orders:read allegro:api:sale:offers:read';
ALTER TABLE listings ADD COLUMN warehouse_id uuid;
ALTER TABLE listings ADD COLUMN parent_external_id text;
ALTER TABLE listings ADD COLUMN last_result jsonb;
ALTER TABLE listings ADD UNIQUE(tenant_id,id);
ALTER TABLE listings ADD FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id);
CREATE TABLE offer_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,product_id uuid NOT NULL,listing_id uuid,
 actor_id uuid NOT NULL REFERENCES users,warehouse_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('create_draft','publish','sync')),
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','done','conflict','failed')),
 input jsonb NOT NULL,local_snapshot jsonb NOT NULL,remote_snapshot jsonb,payload jsonb NOT NULL,
 result jsonb,phase text NOT NULL DEFAULT 'ready',remote_id text,operation_id uuid,error text,
 job_id uuid REFERENCES jobs,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,listing_id) REFERENCES listings(tenant_id,id)
);
CREATE INDEX offer_plans_page ON offer_plans(tenant_id,channel_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX offer_plan_active ON offer_plans(tenant_id,channel_id,product_id) WHERE state='queued';
ALTER TABLE offer_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON offer_plans TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON offer_plans TO dyna_app;
