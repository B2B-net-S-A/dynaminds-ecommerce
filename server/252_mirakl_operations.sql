-- Migration 252_mirakl_operations (prepared as 262, registered after 251_b2b_network_lifecycle; object names keep the
-- mirakl262_ prefix; docs/parity/MIRAKL252-20261028.md):
-- integration track L4 Mirakl Seller. Own tables only: the durable OR11 order schedule per channel (checkpoint of
-- server/mirakl-order-sync.ts, window, watermark, job binding), the write outbox for offers (OF24 + OF02/OF03
-- readback) and fulfilment (OR21 accept, OR23 tracking, OR24 ship) with idempotency keys, phases and
-- reconciliation after a lost acknowledgement, and the webhook endpoints (secret path token, stored as SHA-256)
-- with the deduplicated event log.
--
-- No core table is altered, referenced by a foreign key (no RI trigger lands on channels, orders, products or jobs)
-- or written by this file, so no existing catalogue record, guard or fingerprint moves. Channel, order, product and
-- job identifiers are checked by the application inside the tenant transaction. Personal data: none; offers keep
-- SKU, price and quantity, fulfilment keeps the carrier and tracking number, webhook events keep the body hash,
-- the event id and type, never the body or the token.

CREATE TABLE mirakl262_schedules (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 channel_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 interval_minutes integer NOT NULL CHECK (interval_minutes BETWEEN 15 AND 1440),
 -- The administrator whose current admin role every page re-checks (offer_sync_is_admin) before staging.
 actor_id uuid NOT NULL,
 -- miraklChannelConnectionHash of the channel when the schedule was saved; a changed key/settings stops the run.
 connection_hash text NOT NULL CHECK (connection_hash ~ '^[0-9a-f]{64}$'),
 -- Lower bound of the next OR11 window; the watermark is the end of the last completed window.
 window_start timestamptz NOT NULL,
 watermark timestamptz,
 -- mirakl-order-sync-checkpoint/v1 of the window in progress; NULL between windows.
 checkpoint jsonb CHECK (checkpoint IS NULL OR jsonb_typeof(checkpoint) = 'object'),
 state text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','queued','deferred','failed')),
 reason text CHECK (char_length(reason) <= 200),
 job_id uuid,
 next_run_at timestamptz NOT NULL DEFAULT now(),
 last_run_at timestamptz,
 pages integer NOT NULL DEFAULT 0 CHECK (pages >= 0),
 staged integer NOT NULL DEFAULT 0 CHECK (staged >= 0),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, channel_id),
 CHECK (state <> 'queued' OR job_id IS NOT NULL)
);
CREATE INDEX mirakl262_schedules_due ON mirakl262_schedules(next_run_at) WHERE enabled AND state IN ('idle','deferred');

CREATE TABLE mirakl262_operations (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 channel_id uuid NOT NULL,
 connection_hash text NOT NULL CHECK (connection_hash ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL CHECK (kind IN ('offers','accept','tracking','ship')),
 -- 'offers' for OF24, otherwise the Mirakl order_id; the local order (tracking/ship) or staged row (accept).
 target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 160),
 order_id uuid,
 inbound_id uuid,
 -- One click = one operation; a replay with the same key and body returns it, another body is refused.
 client_key uuid NOT NULL,
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','uncertain','applied','partial','failed')),
 -- How the final state was learned: the acknowledgement itself, OF02/OF03, or a readback after a lost answer.
 outcome text CHECK (outcome IN ('acknowledged','import_report','reconciled','replayed','refused','conflict')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
 job_id uuid,
 import_id text CHECK (import_id ~ '^[1-9][0-9]{0,18}$'),
 result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
 reason text CHECK (char_length(reason) <= 300),
 next_attempt_at timestamptz,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, client_key),
 CHECK (kind = 'offers' OR import_id IS NULL),
 CHECK (state <> 'sent' OR import_id IS NOT NULL)
);
-- At most one open write per channel, kind and target: a second click waits for the first to settle.
CREATE UNIQUE INDEX mirakl262_operations_open ON mirakl262_operations(tenant_id, channel_id, kind, target) WHERE state IN ('queued','sending','sent','uncertain');
CREATE INDEX mirakl262_operations_channel ON mirakl262_operations(tenant_id, channel_id, created_at DESC, id DESC);

CREATE TABLE mirakl262_webhook_endpoints (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 channel_id uuid NOT NULL,
 token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
 enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, channel_id)
);

CREATE TABLE mirakl262_webhook_events (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 endpoint_id uuid NOT NULL,
 event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
 event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 80),
 body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
 outcome text NOT NULL CHECK (outcome IN ('sync_requested','recorded')),
 received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, endpoint_id, event_id)
);
CREATE INDEX mirakl262_webhook_events_recent ON mirakl262_webhook_events(tenant_id, endpoint_id, received_at DESC);

ALTER TABLE mirakl262_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirakl262_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirakl262_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirakl262_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON mirakl262_schedules USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON mirakl262_operations USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON mirakl262_webhook_endpoints USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON mirakl262_webhook_events USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE mirakl262_schedules, mirakl262_operations, mirakl262_webhook_endpoints, mirakl262_webhook_events FROM PUBLIC,dyna_app;
-- No DELETE or TRUNCATE for the application role; the webhook event log is append-only for it.
GRANT SELECT,INSERT,UPDATE ON TABLE mirakl262_schedules TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE mirakl262_operations TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE mirakl262_webhook_endpoints TO dyna_app;
GRANT SELECT,INSERT ON TABLE mirakl262_webhook_events TO dyna_app;
