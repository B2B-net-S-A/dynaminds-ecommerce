-- Migration 242_payu_sessions (docs/parity/PAYU242-20261027.md): PayU payment sessions for the customer portal
-- (COM-PORTAL-6, decision of 25.10.2026). Own tables only: the per-tenant PayU configuration (secrets encrypted by
-- the application), one session per payment attempt with its status machine and idempotency keys, the log of
-- received notifications with the signature result, and refunds. A completed session books exactly one
-- payment_entries receipt through the existing payment path (client_key 'payu:<PayU orderId>').
--
-- No core table is altered, referenced by a foreign key (no RI trigger lands on orders or payment_entries) or
-- written, so no existing catalogue record, guard or fingerprint moves. Identifiers are checked by the
-- application under the order lock. Personal data: none is stored here; the buyer e-mail and IP sent to PayU
-- are not kept, notifications keep only the body hash and the fields needed for settlement.

CREATE TABLE payu242_configs (
 tenant_id uuid PRIMARY KEY,
 id uuid NOT NULL UNIQUE,
 environment text NOT NULL CHECK (environment IN ('sandbox','production')),
 pos_id text NOT NULL CHECK (pos_id ~ '^[0-9]{1,12}$'),
 client_id text NOT NULL CHECK (client_id ~ '^[0-9]{1,12}$'),
 public_origin text NOT NULL CHECK (char_length(public_origin) BETWEEN 8 AND 200),
 -- AES-256-GCM (server/security.ts) of {client_secret, second_key, notify_token}; never returned by the API.
 credentials text NOT NULL CHECK (char_length(credentials) BETWEEN 16 AND 8000),
 enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payu242_sessions (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 config_id uuid NOT NULL,
 environment text NOT NULL CHECK (environment IN ('sandbox','production')),
 simulated boolean NOT NULL DEFAULT false,
 -- The buyer's idempotency key (one click = one session) and PayU's extOrderId (one session = one PayU order).
 client_key uuid NOT NULL,
 ext_order_id text NOT NULL CHECK (ext_order_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
 -- The order's open balance when the session started, in minor units; never taken from the buyer.
 amount integer NOT NULL CHECK (amount > 0),
 currency text NOT NULL CHECK (currency IN ('PLN','EUR')),
 status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','PENDING','WAITING_FOR_CONFIRMATION','COMPLETED','CANCELED','REJECTED')),
 phase text NOT NULL DEFAULT 'create_started' CHECK (phase IN ('create_started','created','recovered','absent','refused')),
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
 provider_order_id text CHECK (provider_order_id ~ '^[A-Za-z0-9]{6,64}$'),
 redirect_uri text CHECK (char_length(redirect_uri) <= 2048),
 payment_id text CHECK (payment_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
 receipt_entry_id uuid UNIQUE,
 return_secret_sha256 text NOT NULL CHECK (return_secret_sha256 ~ '^[0-9a-f]{64}$'),
 review text CHECK (review IN ('completed_after_canceled','amount_mismatch','booking_refused')),
 expires_at timestamptz NOT NULL,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, client_key),
 UNIQUE (tenant_id, ext_order_id),
 UNIQUE (tenant_id, provider_order_id),
 CHECK (receipt_entry_id IS NULL OR status = 'COMPLETED')
);
-- At most one open attempt per order; a new one starts only after the previous one is closed.
CREATE UNIQUE INDEX payu242_sessions_open ON payu242_sessions(tenant_id, order_id) WHERE status IN ('NEW','PENDING','WAITING_FOR_CONFIRMATION');
CREATE INDEX payu242_sessions_order ON payu242_sessions(tenant_id, order_id, created_at DESC, id DESC);

CREATE TABLE payu242_notifications (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 config_id uuid NOT NULL,
 session_id uuid,
 kind text NOT NULL CHECK (kind IN ('order','refund','unknown')),
 provider_order_id text CHECK (char_length(provider_order_id) <= 64),
 status text CHECK (char_length(status) <= 40),
 signature_algorithm text CHECK (signature_algorithm IN ('MD5','SHA-256')),
 signature_valid boolean NOT NULL,
 body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
 body_bytes integer NOT NULL CHECK (body_bytes >= 0),
 outcome text NOT NULL CHECK (outcome IN ('applied','booked','duplicate','ignored_terminal','ignored_out_of_order','conflict','amount_mismatch','foreign','unknown_session','invalid_signature','invalid','booking_refused','refund_applied','refund_booked','refund_duplicate','refund_unknown')),
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payu242_notifications_session ON payu242_notifications(tenant_id, session_id, received_at DESC);

CREATE TABLE payu242_refunds (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 session_id uuid NOT NULL,
 order_id uuid NOT NULL,
 client_key uuid NOT NULL,
 ext_refund_id text NOT NULL CHECK (ext_refund_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
 amount integer NOT NULL CHECK (amount > 0),
 currency text NOT NULL CHECK (currency IN ('PLN','EUR')),
 status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','PENDING','FINALIZED','CANCELED','refused')),
 provider_refund_id text CHECK (provider_refund_id ~ '^[A-Za-z0-9]{1,64}$'),
 refund_entry_id uuid UNIQUE,
 review text CHECK (review IN ('booking_refused','uncertain')),
 created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, client_key),
 UNIQUE (tenant_id, ext_refund_id),
 CHECK (refund_entry_id IS NULL OR status = 'FINALIZED')
);
CREATE INDEX payu242_refunds_session ON payu242_refunds(tenant_id, session_id, created_at);

ALTER TABLE payu242_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payu242_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payu242_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE payu242_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON payu242_configs USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON payu242_sessions USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON payu242_notifications USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON payu242_refunds USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE payu242_configs, payu242_sessions, payu242_notifications, payu242_refunds FROM PUBLIC,dyna_app;
-- No DELETE or TRUNCATE for the application role; the notification log is append-only for it.
GRANT SELECT,INSERT,UPDATE ON TABLE payu242_configs TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE payu242_sessions TO dyna_app;
GRANT SELECT,INSERT ON TABLE payu242_notifications TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE payu242_refunds TO dyna_app;
