-- Cross-firm reservation of one remote shop/order, retained across uncertain dispatch.
CREATE TABLE prestashop_status_claims (
 resource_hash text PRIMARY KEY CHECK(resource_hash~'^[a-f0-9]{64}$'),
 tenant_id uuid NOT NULL REFERENCES tenants(id),plan_id uuid NOT NULL,
 claimed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES order_status_plans(tenant_id,id)
);
ALTER TABLE prestashop_status_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE prestashop_status_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prestashop_status_claims TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON prestashop_status_claims TO dyna_app;
