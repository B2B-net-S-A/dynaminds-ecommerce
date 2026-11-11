CREATE TABLE ebay_fulfillment_configs (
 tenant_id uuid NOT NULL,channel_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 external_authorized boolean NOT NULL DEFAULT false,connection_hash text NOT NULL,
 carrier_mappings jsonb NOT NULL,shipped_since timestamptz NOT NULL,
 next_run_at timestamptz,last_run_at timestamptz,last_job_id uuid REFERENCES jobs,error text,
 updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,channel_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
ALTER TABLE ebay_fulfillment_plans ADD COLUMN config_version integer;
CREATE TABLE ebay_fulfillment_receipts (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,config_version integer NOT NULL,
 order_id uuid NOT NULL,shipment_id uuid NOT NULL,plan_id uuid,
 state text NOT NULL CHECK(state IN ('queued','skipped','conflict')),error text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,channel_id,config_version,order_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 FOREIGN KEY(tenant_id,shipment_id) REFERENCES shipments(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES ebay_fulfillment_plans(tenant_id,id)
);
CREATE INDEX ebay_fulfillment_receipt_page ON ebay_fulfillment_receipts(tenant_id,channel_id,created_at DESC,order_id DESC);
CREATE INDEX ebay_fulfillment_due ON ebay_fulfillment_configs(next_run_at,channel_id) WHERE enabled;
CREATE INDEX ebay_fulfillment_scan_orders ON orders(tenant_id,channel_id,id) WHERE source='ebay' AND status IN ('shipped','delivered','completed');
CREATE UNIQUE INDEX jobs_one_ebay_fulfillment_scan ON jobs(tenant_id,(payload->>'channel_id')) WHERE kind='ebay.fulfillment.scan' AND state IN ('pending','running');
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['ebay_fulfillment_configs','ebay_fulfillment_receipts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO dyna_app',tbl);
END LOOP;END $$;
