-- Migration 238_audit_log (docs/parity/AUDIT-LOG238-20261027.md): the API key behind an audited action
-- (SEC-009). audit_events keeps who (user_id); an action done with an API key also records which key here,
-- keyed by the audit event id, so the log can name "key X of user Y" and be filtered by key.
--
-- An own side table instead of a column on the core audit_events: the application role holds UPDATE and
-- DELETE on audit_events (RODO 228 scrubs its detail), so a column there could be rewritten by the app;
-- here dyna_app may only read and insert. No core table is altered, referenced by a foreign key (no RI
-- trigger lands on audit_events or api_keys) or written, so no existing catalogue record, guard or
-- fingerprint moves. Rows hold identifiers only, no personal values.

CREATE TABLE audit238_event_keys (
 event_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 api_key_id uuid NOT NULL,
 -- The event's own created_at (same transaction), so a key filter pages in the log's order.
 created_at timestamptz NOT NULL
);
CREATE INDEX audit238_event_keys_key ON audit238_event_keys(tenant_id,api_key_id,created_at DESC,event_id DESC);

ALTER TABLE audit238_event_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON audit238_event_keys USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE audit238_event_keys FROM PUBLIC,dyna_app;
GRANT SELECT,INSERT ON TABLE audit238_event_keys TO dyna_app;
