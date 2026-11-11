CREATE TABLE tracking_configs (
 tenant_id uuid NOT NULL,channel_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES users,
 enabled boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 60 AND 86400),
 mark_delivered boolean NOT NULL DEFAULT false,external_authorized boolean NOT NULL DEFAULT false,
 connection_hash text NOT NULL,error text,updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
ALTER TABLE tracking_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tracking_configs TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON tracking_configs TO dyna_app;
ALTER TABLE shipments ADD COLUMN tracking_revision integer NOT NULL DEFAULT 0;
ALTER TABLE shipments ADD COLUMN tracking_next_at timestamptz;
ALTER TABLE shipments ADD COLUMN tracking_error text;
ALTER TABLE shipments ADD COLUMN tracking_job_id uuid REFERENCES jobs;
ALTER TABLE shipments ADD COLUMN tracking_provider_created_at timestamptz;
ALTER TABLE shipments ADD COLUMN tracking_demo_status text CHECK(tracking_demo_status IN ('confirmed','out_for_delivery','delivered','returned_to_sender'));
CREATE INDEX shipments_tracking_due ON shipments(tenant_id,channel_id,tracking_next_at,id) WHERE dispatched_at IS NOT NULL AND channel_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_one_tracking ON jobs(tenant_id,(payload->>'shipment_id')) WHERE kind='shipping.tracking' AND state IN ('pending','running');
CREATE INDEX jobs_tracking_channel_active ON jobs(tenant_id,(payload->>'channel_id')) WHERE kind='shipping.tracking' AND state IN ('pending','running');
