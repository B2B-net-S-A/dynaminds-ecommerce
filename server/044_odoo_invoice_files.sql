CREATE TABLE odoo_invoice_files (
 tenant_id uuid NOT NULL,export_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 filename text NOT NULL CHECK(filename~'^[A-Za-z0-9_-]+\.pdf$'),size integer NOT NULL CHECK(size BETWEEN 1 AND 2097152),
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),content_encrypted text NOT NULL,
 remote_attachment_id text NOT NULL,remote_write_date text,mode text NOT NULL CHECK(mode IN('simulation','external')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,export_id),
 FOREIGN KEY(tenant_id,export_id) REFERENCES odoo_invoice_exports(tenant_id,id)
);
ALTER TABLE odoo_invoice_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE odoo_invoice_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON odoo_invoice_files TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON odoo_invoice_files TO dyna_app;
CREATE FUNCTION odoo_pdf_authorized(actor_id uuid,writing boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE member_role text;
BEGIN
 SELECT role INTO member_role FROM memberships WHERE user_id=actor_id AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR SHARE;
 RETURN member_role IS NOT NULL AND (NOT writing OR member_role IN('admin','operator'));
END $$;
REVOKE ALL ON FUNCTION odoo_pdf_authorized(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION odoo_pdf_authorized(uuid,boolean) TO dyna_app;
