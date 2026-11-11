ALTER TABLE documents DROP CONSTRAINT documents_tenant_id_order_id_kind_key;
ALTER TABLE documents DROP CONSTRAINT documents_tenant_id_number_key;
ALTER TABLE documents ADD COLUMN channel_id uuid;
ALTER TABLE documents ADD COLUMN external_id text;
ALTER TABLE documents ADD UNIQUE(tenant_id,id);
ALTER TABLE documents ADD FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id);
CREATE UNIQUE INDEX document_order_mode ON documents(tenant_id,order_id,kind,mode);
CREATE UNIQUE INDEX document_external ON documents(tenant_id,channel_id,external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX document_demo_number ON documents(tenant_id,number) WHERE channel_id IS NULL;
CREATE INDEX documents_page ON documents(tenant_id,created_at DESC,id DESC);
CREATE TABLE invoice_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 kind text NOT NULL CHECK(kind IN ('invoice','correction')),
 mode text NOT NULL CHECK(mode IN ('simulation','external')),
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','done','failed','cancelled')),
 phase text NOT NULL DEFAULT 'ready' CHECK(phase IN ('ready','create_started','created')),
 input jsonb NOT NULL,payload jsonb NOT NULL,order_snapshot jsonb NOT NULL,
 remote_id text,document_id uuid,result jsonb,error text,job_id uuid REFERENCES jobs,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id)
);
CREATE UNIQUE INDEX invoice_active ON invoice_plans(tenant_id,order_id,kind,mode) WHERE state NOT IN ('preview','cancelled');
CREATE INDEX invoice_order_page ON invoice_plans(tenant_id,order_id,created_at DESC,id DESC);
ALTER TABLE invoice_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON invoice_plans TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON invoice_plans TO dyna_app;
