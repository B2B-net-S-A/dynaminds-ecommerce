-- Migration 267_status_categories_automation_editors (Uwagi v3 §0, Sellasist-style statuses and automation rights;
-- registered after 266_accountant_order_settings).
--
-- 1. The category of a custom status (Nowe, W realizacji, Zrealizowane, Niezrealizowane, Pozostałe; the codes are in
--    shared/order-categories.ts). workflow_statuses and orders keep their columns and CHECKs; a status without a row
--    here reads the category of its stage.
CREATE TABLE workflow_status267_categories (
 tenant_id uuid NOT NULL,
 workflow_status_id uuid NOT NULL,
 category text NOT NULL CHECK(category IN ('new','in_progress','completed','not_completed','other')),
 PRIMARY KEY(tenant_id,workflow_status_id),
 FOREIGN KEY(tenant_id,workflow_status_id) REFERENCES workflow_statuses(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE workflow_status267_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_status267_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_status267_categories TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON workflow_status267_categories FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT,UPDATE ON workflow_status267_categories TO dyna_app;

-- 2. "Automatyzacje: edycja": who may create and change automation rules besides the administrator. memberships keeps
--    its CHECK (admin, operator, viewer), as in 266: the right is a grant row of an operator membership. A grant of a
--    membership that is not operator grants nothing. Like memberships and accountant266_memberships it is private to
--    authentication (owner connection); dyna_app never reads it.
CREATE TABLE automation267_editors (
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 granted_by uuid NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,user_id),
 FOREIGN KEY(user_id,tenant_id) REFERENCES memberships(user_id,tenant_id) ON DELETE CASCADE
);
ALTER TABLE automation267_editors ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation267_editors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON automation267_editors TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON automation267_editors FROM PUBLIC,dyna_app;
