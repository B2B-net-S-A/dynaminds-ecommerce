-- Migration 266_accountant_order_settings (Uwagi v3, decision of 10.11.2026; registered after 265_wms_order_line_resize).
--
-- 1. The accountant ("Księgowa"). memberships.role keeps its CHECK (admin, operator, viewer): the sealed guards
--    fingerprint memberships (on a clone, adding 'accountant' to that CHECK turns 9 of the 18 named guards false),
--    and some thirty access functions read memberships.role with explicit IN-lists, so a new role value would also
--    lose read access a viewer has. An accountant is therefore a viewer membership plus a grant row here: every
--    reader treats them as a viewer, and only the payment section and payment imports (Przelewy i pobrania)
--    accept accountant266_is_member(). A grant without a viewer membership grants nothing.
CREATE TABLE accountant266_memberships (
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 granted_by uuid NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,user_id),
 FOREIGN KEY(user_id,tenant_id) REFERENCES memberships(user_id,tenant_id) ON DELETE CASCADE
);
-- A pending invitation for the accountant role (the invitation itself is a viewer invitation).
CREATE TABLE accountant266_invitations (
 invitation_id uuid PRIMARY KEY REFERENCES workspace_invitations(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL
);
-- Like memberships: private to authentication (owner connection); dyna_app asks only through the function below.
ALTER TABLE accountant266_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE accountant266_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE accountant266_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE accountant266_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON accountant266_memberships TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON accountant266_invitations TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON accountant266_memberships,accountant266_invitations FROM PUBLIC,dyna_app;

-- The current accountant of the current tenant: a viewer membership with a grant, membership row locked as
-- offer_sync_is_admin locks it.
CREATE FUNCTION accountant266_is_member(actor_id uuid) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT m.role='viewer' FROM public.memberships m JOIN public.accountant266_memberships g ON (g.tenant_id,g.user_id)=(m.tenant_id,m.user_id)
 WHERE m.user_id=actor_id AND m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR SHARE OF m),false)
$$;
REVOKE ALL ON FUNCTION accountant266_is_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accountant266_is_member(uuid) TO dyna_app;

-- The finance member of Przelewy i pobrania: the current administrator (as before) or the current accountant.
CREATE FUNCTION accountant266_finance_member(actor_id uuid) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(public.offer_sync_is_admin(actor_id),false) OR public.accountant266_is_member(actor_id)
$$;
REVOKE ALL ON FUNCTION accountant266_finance_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accountant266_finance_member(uuid) TO dyna_app;

-- Splitting a payment (124) re-checks the administrator in payment_allocation_access. Keep the installed body
-- byte-for-byte except one derived line (the 108 technique): a session accountant (no API key) is allowed too.
DO $$ DECLARE definition text;anchor text:='ok:=r IS NOT DISTINCT FROM ''admin'';';BEGIN
 definition:=pg_get_functiondef('public.payment_allocation_access(uuid,uuid,boolean)'::regprocedure);
 IF position(anchor IN definition)=0 OR position('accountant266_is_member' IN definition)>0 THEN
  RAISE EXCEPTION 'Nieznany wariant dostępu do podziału wpłat';END IF;
 definition:=replace(definition,anchor,'ok:=r IS NOT DISTINCT FROM ''admin'' OR(kid IS NULL AND accountant266_is_member(uid));');
 EXECUTE definition;END $$;

-- 2. Order settings per tenant (Rafał §7): print the label at packing, default off. When on, the order becoming
--    packed gets the DEMO label (demo carrier only); real carriers are never labelled automatically.
CREATE TABLE tenant_order_settings (
 tenant_id uuid PRIMARY KEY,
 print_label_at_packing boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 actor_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE tenant_order_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_order_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenant_order_settings TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON tenant_order_settings FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT,UPDATE ON tenant_order_settings TO dyna_app;
