-- Immutable command results. Cancelling an unobserved command does not modify a configuration.
CREATE TABLE offer_sync_commands (
 tenant_id uuid NOT NULL REFERENCES tenants,client_key uuid NOT NULL,
 channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 request_body jsonb NOT NULL CHECK(jsonb_typeof(request_body)='object' AND octet_length(request_body::text)<=4096
   AND ((request_body->>'client_key')::uuid=client_key) IS TRUE),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND octet_length(response::text)<=16384
   AND (response->>'status' IN('OFFER_SYNC_CONFIGURATION_ACKNOWLEDGED','OFFER_SYNC_CONFIGURATION_CANCELLED')) IS TRUE
   AND ((response->>'channel_id')::uuid=channel_id) IS TRUE
   AND ((response->>'client_key')::uuid=client_key) IS TRUE),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,client_key),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
ALTER TABLE offer_sync_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_sync_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON offer_sync_commands TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON offer_sync_commands FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON offer_sync_commands FROM dyna_app;
GRANT SELECT,INSERT ON offer_sync_commands TO dyna_app;
