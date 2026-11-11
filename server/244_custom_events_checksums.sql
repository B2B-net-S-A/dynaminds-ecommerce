-- Migration 244_custom_events_checksums (docs/parity/CUSTOM-EVENTS244-20261027.md). Two Stage-4 items
-- (docs/parity/STAGE4-NONINTEGRATION-GAP-20261025.md):
--
-- AUTO-07 (DOM-AUTO-008), own events: a tenant defines an event by key; raising it for an order (from the order
-- panel, the API, a rule, a schedule or a batch) writes one order event `custom.<key>`, which starts the rules
-- listening to it through the existing durable `automation` job, and one row of the append-only call history.
-- The idempotency key is unique per tenant; the same key returns the same call.
--
-- MIG-2, migration checksums: migrate() records the sha256 of every executed migration file (main file and its
-- companions) and refuses to start when an applied migration's file no longer matches. Owner-only: the
-- application role has no access at all; there is no tenant data in it.
--
-- No core table is altered, referenced by a foreign key (no RI trigger lands on orders, order_events or the
-- migration ledger) or written, so no existing catalogue record, guard or fingerprint moves. Names avoid every
-- sealed LIKE family (`_` is a wildcard there). Personal data: none.

CREATE TABLE custom_event_defs (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80),
 description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
 active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, key)
);

CREATE TABLE custom_event_calls (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 definition_id uuid NOT NULL,
 definition_version bigint NOT NULL CHECK (definition_version > 0),
 event_key text NOT NULL CHECK (event_key ~ '^[a-z][a-z0-9_]{1,39}$'),
 -- The order and its order_events row are checked by the application under the order lock (no FK to core).
 order_id uuid NOT NULL,
 order_event_id uuid NOT NULL UNIQUE,
 source text NOT NULL CHECK (source IN ('ui','api','rule','schedule','batch')),
 -- '<source>:<caller key>' or '<rule|schedule|batch>:<operation id>:<action index>:<order id>'.
 client_key text NOT NULL CHECK (client_key ~ '^[A-Za-z0-9._:-]{8,200}$'),
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
 actor_id uuid,
 api_key_id uuid,
 -- The rule run, schedule run or batch that raised the event.
 operation_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, client_key),
 FOREIGN KEY (tenant_id, definition_id) REFERENCES custom_event_defs(tenant_id, id),
 CHECK ((source IN ('rule','schedule','batch')) = (operation_id IS NOT NULL))
);
CREATE INDEX custom_event_calls_history ON custom_event_calls(tenant_id, definition_id, created_at DESC, id DESC);
CREATE INDEX custom_event_calls_order ON custom_event_calls(tenant_id, order_id, created_at DESC);

ALTER TABLE custom_event_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_event_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON custom_event_defs USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON custom_event_calls USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

CREATE TABLE migration_checksums (
 name text NOT NULL CHECK (name ~ '^[0-9]{3}_[a-z0-9_]+$'),
 file text NOT NULL CHECK (file ~ '^[A-Za-z0-9_-]+\.sql$'),
 bytes integer NOT NULL CHECK (bytes > 0),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 -- applied: executed in the run that recorded it; baseline: applied before the register existed, recorded from
 -- the release's file at the first start with the register.
 origin text NOT NULL CHECK (origin IN ('applied','baseline')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (name, file)
);

REVOKE ALL ON TABLE custom_event_defs, custom_event_calls, migration_checksums FROM PUBLIC,dyna_app;
-- Definitions are deactivated, never deleted; the call history is append-only; the checksum register is owner-only.
GRANT SELECT,INSERT,UPDATE ON TABLE custom_event_defs TO dyna_app;
GRANT SELECT,INSERT ON TABLE custom_event_calls TO dyna_app;
