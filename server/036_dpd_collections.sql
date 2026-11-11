ALTER TABLE shipping_plans ADD UNIQUE(tenant_id,id);
CREATE TABLE dpd_collections (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 kind text NOT NULL CHECK(kind IN ('pickup','protocol')),client_key uuid NOT NULL,fingerprint text NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','ready','failed','uncertain','cancel_queued','cancelled')),
 phase text NOT NULL DEFAULT 'ready',input jsonb NOT NULL,payload jsonb NOT NULL,connection_hash text NOT NULL,
 result jsonb,error text,job_id uuid REFERENCES jobs,remote_id text,checksum text,
 requested_number text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE TABLE dpd_collection_items (
 tenant_id uuid NOT NULL,collection_id uuid NOT NULL,plan_id uuid NOT NULL,snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,collection_id,plan_id),
 FOREIGN KEY(tenant_id,collection_id) REFERENCES dpd_collections(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES shipping_plans(tenant_id,id)
);
CREATE TABLE dpd_pickup_claims (
 tenant_id uuid NOT NULL,plan_id uuid NOT NULL,collection_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,plan_id),
 FOREIGN KEY(tenant_id,collection_id,plan_id) REFERENCES dpd_collection_items(tenant_id,collection_id,plan_id)
);
CREATE INDEX dpd_collection_history ON dpd_collections(tenant_id,channel_id,created_at DESC,id DESC);
CREATE INDEX dpd_collection_job ON dpd_collections(job_id) WHERE state IN ('queued','cancel_queued');
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['dpd_collections','dpd_collection_items','dpd_pickup_claims'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
