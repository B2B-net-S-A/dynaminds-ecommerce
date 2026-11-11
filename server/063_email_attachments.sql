ALTER TABLE email_templates ADD COLUMN attachment text NOT NULL DEFAULT 'none' CHECK(attachment IN('none','invoice','odoo_invoice'));
CREATE TABLE invoice_email_files (
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),
 filename text NOT NULL CHECK(filename~'^[A-Za-z0-9_-]+\.pdf$'),size integer NOT NULL CHECK(size BETWEEN 1 AND 2097152),
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),content_encrypted text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,document_id,source_hash),FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id)
);
CREATE TABLE email_message_files (
 tenant_id uuid NOT NULL,message_id uuid NOT NULL,filename text NOT NULL CHECK(filename~'^[A-Za-z0-9_-]+\.(pdf|html)$'),
 content_type text NOT NULL CHECK(content_type IN('application/pdf','text/html')),size integer NOT NULL CHECK(size BETWEEN 1 AND 2097152),
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),content_encrypted text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,message_id),FOREIGN KEY(tenant_id,message_id) REFERENCES email_messages(tenant_id,id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['invoice_email_files','email_message_files'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',tbl);
END LOOP; END $$;
