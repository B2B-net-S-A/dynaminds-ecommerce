ALTER TABLE offer_plans DROP CONSTRAINT offer_plans_operation_check;
ALTER TABLE offer_plans ADD CONSTRAINT offer_plans_operation_check CHECK(operation IN ('create_draft','create_group','create_variant','publish','sync'));
CREATE TABLE variant_offer_batches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,group_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,input_hash text NOT NULL,connection_hash text NOT NULL,input jsonb NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL DEFAULT 'preparing' CHECK(state IN('preparing','review','queued','done','partial','failed','cancelled')),
 job_id uuid REFERENCES jobs,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel_id,client_key),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),FOREIGN KEY(tenant_id,group_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE variant_offer_batch_items (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,batch_id uuid NOT NULL,product_id uuid NOT NULL,plan_id uuid,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','preview','queued','done','failed','skipped')),
 error text,result jsonb,UNIQUE(tenant_id,batch_id,product_id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES variant_offer_batches(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,plan_id) REFERENCES offer_plans(tenant_id,id)
);
CREATE INDEX variant_offer_batches_channel ON variant_offer_batches(tenant_id,channel_id,created_at DESC,id DESC);
CREATE INDEX variant_offer_items_page ON variant_offer_batch_items(tenant_id,batch_id,id);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['variant_offer_batches','variant_offer_batch_items'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP;END $$;
