-- Proposed successor to 388, install INSTEAD of its uninstalled sms-delivery.sql. NOT RUN.
ALTER TABLE sms_batches DROP CONSTRAINT sms_batches_mode_check;
ALTER TABLE sms_batches DROP CONSTRAINT sms_batches_check;
ALTER TABLE sms_batches ADD CONSTRAINT sms_batches_mode_check CHECK(mode IN('local','provider_test','provider_live'));
ALTER TABLE sms_batches ADD CONSTRAINT sms_batches_check CHECK((mode='local' AND channel_id IS NULL AND channel_hash IS NULL) OR(mode IN('provider_test','provider_live') AND channel_id IS NOT NULL AND channel_hash IS NOT NULL));
ALTER TABLE sms_messages DROP CONSTRAINT sms_messages_state_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_state_check CHECK(state IN('draft','invalid','queued','simulated','tested','submitted','uncertain','failed','cancelled'));
CREATE TABLE sms_delivery_endpoints(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,account_username text NOT NULL CHECK(length(account_username) BETWEEN 1 AND 200),
 callback_url text NOT NULL CHECK(callback_url~'^https://'),channel_hash text NOT NULL CHECK(channel_hash~'^[a-f0-9]{64}$'),enabled boolean NOT NULL DEFAULT true,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
ALTER TABLE sms_batches ADD COLUMN delivery_endpoint_id uuid;
ALTER TABLE sms_batches ADD FOREIGN KEY(tenant_id,delivery_endpoint_id) REFERENCES sms_delivery_endpoints(tenant_id,id);
ALTER TABLE sms_batches ADD CHECK((mode='provider_live')=(delivery_endpoint_id IS NOT NULL));
CREATE TABLE sms_live_queue_authorities(
 tenant_id uuid NOT NULL,batch_id uuid NOT NULL,actor_id uuid NOT NULL,session_hash text NOT NULL CHECK(session_hash~'^[a-f0-9]{64}$'),
 PRIMARY KEY(tenant_id,batch_id),FOREIGN KEY(tenant_id,batch_id) REFERENCES sms_batches(tenant_id,id)
);
CREATE TABLE sms_delivery_submissions(
 tenant_id uuid NOT NULL,message_id uuid NOT NULL,channel_id uuid NOT NULL,endpoint_id uuid NOT NULL,idx text NOT NULL,
 provider_id text CHECK(length(provider_id) BETWEEN 1 AND 32),provider_sent_at bigint CHECK(provider_sent_at>0),accepted_at timestamptz,
 status_code integer CHECK(status_code BETWEEN 401 AND 412),provider_done_at bigint NOT NULL DEFAULT 0 CHECK(provider_done_at>=0),
 needs_reconciliation boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((provider_id IS NULL)=(provider_sent_at IS NULL)),CHECK((provider_id IS NULL)=(accepted_at IS NULL)),
 PRIMARY KEY(tenant_id,message_id),UNIQUE(tenant_id,channel_id,provider_id),UNIQUE(tenant_id,channel_id,idx),
 FOREIGN KEY(tenant_id,message_id) REFERENCES sms_messages(tenant_id,id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,endpoint_id) REFERENCES sms_delivery_endpoints(tenant_id,id)
);
CREATE TABLE sms_delivery_events(
 tenant_id uuid NOT NULL,message_id uuid NOT NULL,event_hash text NOT NULL CHECK(event_hash~'^[a-f0-9]{64}$'),provider_id text NOT NULL,
 provider_sent_at bigint NOT NULL CHECK(provider_sent_at>0),status_code integer NOT NULL CHECK(status_code BETWEEN 401 AND 412),
 provider_done_at bigint NOT NULL CHECK(provider_done_at>=0),received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,message_id,event_hash),FOREIGN KEY(tenant_id,message_id) REFERENCES sms_delivery_submissions(tenant_id,message_id)
);
DO $$ DECLARE tbl text;BEGIN FOREACH tbl IN ARRAY ARRAY['sms_delivery_endpoints','sms_live_queue_authorities','sms_delivery_submissions','sms_delivery_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dyna_app',tbl);
END LOOP;END $$;
