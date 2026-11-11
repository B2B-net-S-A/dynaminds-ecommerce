-- Separate explicit consent for future local Woo observations. Read212 is not import consent.
-- No backfill, job replay or updates of historical orders/inbound business rows.
ALTER TABLE inbound_orders ADD CONSTRAINT inbound_order_import216_identity UNIQUE(tenant_id,id,channel_id);
CREATE TABLE local_woo_order_import_controls (
 tenant_id uuid NOT NULL,channel_id uuid NOT NULL,owner_id uuid NOT NULL REFERENCES users,fixture_id uuid NOT NULL,
 version bigint NOT NULL CHECK(version>0),enabled boolean NOT NULL DEFAULT false,warehouse_id uuid NOT NULL,
 connection_hash text NOT NULL CHECK(connection_hash~'^[a-f0-9]{64}$'),enabled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,channel_id),FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),CHECK(NOT enabled OR enabled_at IS NOT NULL)
);
CREATE TABLE local_woo_order_import_commands (
 tenant_id uuid NOT NULL REFERENCES tenants,client_key uuid NOT NULL,channel_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 request_body jsonb NOT NULL CHECK(jsonb_typeof(request_body)='object' AND octet_length(request_body::text)<=4096
  AND ((request_body->>'client_key')::uuid=client_key) IS TRUE),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND octet_length(response::text)<=16384
  AND (response->>'status' IN('LOCAL_WOO_ORDER_IMPORT_CONFIGURED','LOCAL_WOO_ORDER_IMPORT_CANCELLED')) IS TRUE
  AND ((response->>'channel_id')::uuid=channel_id) IS TRUE AND ((response->>'client_key')::uuid=client_key) IS TRUE),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,client_key),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id)
);
CREATE TABLE local_woo_order_import_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,channel_id uuid NOT NULL,owner_id uuid NOT NULL REFERENCES users,
 control_version bigint NOT NULL CHECK(control_version>0),warehouse_id uuid NOT NULL,
 connection_hash text NOT NULL CHECK(connection_hash~'^[a-f0-9]{64}$'),
 kind text NOT NULL DEFAULT 'orders.sync' CHECK(kind='orders.sync'),occurrence_id uuid NOT NULL,dispatch_id uuid NOT NULL,read_job_id uuid NOT NULL,
 inbound_id uuid NOT NULL,source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','started','done')),lease_token uuid,
 order_id uuid,response jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,inbound_id),
 FOREIGN KEY(tenant_id,channel_id) REFERENCES local_woo_order_import_controls(tenant_id,channel_id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,inbound_id,channel_id) REFERENCES inbound_orders(tenant_id,id,channel_id),
 FOREIGN KEY(tenant_id,occurrence_id,channel_id,kind,owner_id,read_job_id)
  REFERENCES local_woo_read_occurrences(tenant_id,id,channel_id,kind,owner_id,job_id),
 FOREIGN KEY(tenant_id,dispatch_id,occurrence_id) REFERENCES local_woo_read_dispatches(tenant_id,id,occurrence_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id),
 CHECK((state='queued' AND lease_token IS NULL AND order_id IS NULL AND response IS NULL AND completed_at IS NULL)
  OR (state='started' AND lease_token IS NOT NULL AND order_id IS NULL AND response IS NULL AND completed_at IS NULL)
  OR (state='done' AND lease_token IS NOT NULL AND order_id IS NOT NULL AND completed_at IS NOT NULL AND response IS NOT NULL
    AND jsonb_typeof(response)='object' AND octet_length(response::text)<=16384
    AND (response->>'status'='LOCAL_WOO_ORDER_IMPORTED') IS TRUE AND ((response->>'order_id')::uuid=order_id) IS TRUE
    AND ((response->>'inbound_id')::uuid=inbound_id) IS TRUE AND (response->>'source_hash'=source_hash) IS TRUE))
);
CREATE INDEX local_woo_order_import_queue ON local_woo_order_import_receipts(tenant_id,channel_id,created_at,id) WHERE state='queued';
CREATE INDEX local_woo_order_import_unknown ON local_woo_order_import_receipts(tenant_id,channel_id) WHERE state='started';
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['local_woo_order_import_controls','local_woo_order_import_commands','local_woo_order_import_receipts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',tbl);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dyna_app',tbl);
 END LOOP;
END $$;
GRANT UPDATE(version,enabled,warehouse_id,connection_hash,enabled_at,updated_at) ON local_woo_order_import_controls TO dyna_app;
GRANT UPDATE(state,lease_token,order_id,response,completed_at) ON local_woo_order_import_receipts TO dyna_app;
REVOKE UPDATE,DELETE,TRUNCATE ON local_woo_order_import_commands FROM dyna_app;
REVOKE DELETE,TRUNCATE ON local_woo_order_import_controls,local_woo_order_import_receipts FROM dyna_app;
-- Receipt identity/history cannot be reset to queued or rewritten after DONE.
CREATE FUNCTION local_woo_order_import216_receipt_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.state='queued' AND NEW.state='started'
  AND (to_jsonb(NEW)-ARRAY['state','lease_token'])=(to_jsonb(OLD)-ARRAY['state','lease_token']) THEN RETURN NEW; END IF;
 IF OLD.state='started' AND NEW.state='done' AND NEW.lease_token=OLD.lease_token
  AND (to_jsonb(NEW)-ARRAY['state','order_id','response','completed_at'])=(to_jsonb(OLD)-ARRAY['state','order_id','response','completed_at']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Immutable local Woo import receipt' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION local_woo_order_import216_receipt_guard() FROM PUBLIC;
CREATE TRIGGER local_woo_order_import216_receipt_guard BEFORE UPDATE ON local_woo_order_import_receipts
 FOR EACH ROW EXECUTE FUNCTION local_woo_order_import216_receipt_guard();
