-- Forward-only orders reconciliation. The original 212 migration remains immutable.
-- No data rewrite, replay, lease reclaim or acknowledgement of a provider effect.
ALTER TABLE local_woo_read_occurrences DROP CONSTRAINT local_woo_read_occurrences_state_check;
ALTER TABLE local_woo_read_occurrences ADD CONSTRAINT local_woo_read_occurrences_state_check
 CHECK(state IN('queued','running','done','blocked','aborted')
       AND (state<>'aborted' OR (kind='orders.sync' AND finished_at IS NOT NULL)));
DROP INDEX local_woo_read_one_active;
CREATE UNIQUE INDEX local_woo_read_one_active ON local_woo_read_occurrences(tenant_id,channel_id,kind)
 WHERE state NOT IN('done','aborted');
-- These identities let the immutable receipt bind the whole original lineage.
ALTER TABLE local_woo_read_occurrences ADD CONSTRAINT local_woo_read_occurrence_reconciliation_identity
 UNIQUE(tenant_id,id,channel_id,kind,owner_id,job_id);
ALTER TABLE local_woo_read_dispatches ADD CONSTRAINT local_woo_read_dispatch_reconciliation_identity
 UNIQUE(tenant_id,id,occurrence_id);
CREATE TABLE local_woo_read_reconciliations (
 tenant_id uuid NOT NULL,client_key uuid NOT NULL,channel_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind='orders.sync'),actor_id uuid NOT NULL,
 occurrence_id uuid NOT NULL,job_id uuid NOT NULL,dispatch_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'
   AND (response->>'status'='LOCAL_WOO_READ_ATTEMPT_ABORTED') IS TRUE
   AND (response->>'kind'=kind) IS TRUE
   AND (response->'automatic_retry'='false'::jsonb) IS TRUE
   AND octet_length(response::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,client_key),UNIQUE(tenant_id,occurrence_id),
 CONSTRAINT local_woo_read_reconciliation_occurrence_fk
  FOREIGN KEY(tenant_id,occurrence_id,channel_id,kind,actor_id,job_id)
  REFERENCES local_woo_read_occurrences(tenant_id,id,channel_id,kind,owner_id,job_id),
 CONSTRAINT local_woo_read_reconciliation_dispatch_fk
  FOREIGN KEY(tenant_id,dispatch_id,occurrence_id)
  REFERENCES local_woo_read_dispatches(tenant_id,id,occurrence_id)
);
ALTER TABLE local_woo_read_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_woo_read_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON local_woo_read_reconciliations TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON local_woo_read_reconciliations FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON local_woo_read_reconciliations FROM dyna_app;
GRANT SELECT,INSERT ON local_woo_read_reconciliations TO dyna_app;
