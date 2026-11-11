CREATE TABLE odoo_invoice_exports (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,document_id uuid NOT NULL,order_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,input_hash text NOT NULL,source_hash text NOT NULL,connection_hash text NOT NULL,credentials_hash text NOT NULL,
 reference text NOT NULL,input jsonb NOT NULL,snapshot jsonb NOT NULL,payload jsonb NOT NULL,
 mode text NOT NULL CHECK(mode IN ('simulation','external')),
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','failed','done','cancelled')),
 phase text NOT NULL DEFAULT 'ready' CHECK(phase IN ('ready','create_started','draft_saved','post_started','posted','verified')),
 remote_id text,result jsonb,error text,job_id uuid REFERENCES jobs,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id,client_key),
 FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE UNIQUE INDEX odoo_invoice_export_active ON odoo_invoice_exports(tenant_id,document_id,mode) WHERE state NOT IN ('preview','cancelled');
CREATE INDEX odoo_invoice_export_order_page ON odoo_invoice_exports(tenant_id,order_id,created_at DESC,id DESC);
ALTER TABLE odoo_invoice_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE odoo_invoice_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON odoo_invoice_exports TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON odoo_invoice_exports TO dyna_app;
