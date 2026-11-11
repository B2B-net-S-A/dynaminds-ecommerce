CREATE TABLE ebay_fulfillment_plans (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,order_id uuid NOT NULL,shipment_id uuid NOT NULL,channel_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,local_hash text NOT NULL,connection_hash text NOT NULL,
 payload jsonb NOT NULL,remote jsonb NOT NULL,state text NOT NULL DEFAULT 'preview'
 CHECK(state IN ('preview','queued','done','conflict','failed','cancelled')),
 phase text NOT NULL DEFAULT 'ready' CHECK(phase IN ('ready','write_started','verify','done')),
 job_id uuid REFERENCES jobs,remote_id text,result jsonb,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE INDEX ebay_fulfillment_order_page ON ebay_fulfillment_plans(tenant_id,order_id,created_at DESC,id DESC);
CREATE INDEX ebay_fulfillment_channel_page ON ebay_fulfillment_plans(tenant_id,channel_id,state);
CREATE UNIQUE INDEX ebay_fulfillment_one_active ON ebay_fulfillment_plans(tenant_id,order_id)
 WHERE state='queued' OR (state IN ('failed','conflict') AND phase IN ('write_started','verify'));
CREATE TABLE ebay_fulfillment_simulations (
 tenant_id uuid NOT NULL,order_id uuid NOT NULL,fulfillments jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(tenant_id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['ebay_fulfillment_plans','ebay_fulfillment_simulations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP;END $$;
