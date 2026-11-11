-- Migration 246_b2b_trade_credit_directory (prepared as placeholder 254; object names keep the b2b254_ prefix).
-- B2B-007 trade credit: a per-account credit line (currency, limit in minor units, payment term) and the
-- append-only list of orders charged to it. The open exposure is not stored: it is the open balance
-- (payments.ts paymentBalance().amount_due, the figure of the order card and of the settlement report) of
-- the charged orders, so a payment or a return credit settles the credit without a second ledger.
-- B2B-008 supplier directory: the supplier's opt-in public profile (no prices, no catalogue) and the
-- seller's connection request, answered by the supplier through the existing network invitation.
-- Security review M6: FORCE ROW LEVEL SECURITY on the PayU (242) tables, audit238_event_keys and the two
-- custom-event tables of 244 (custom_event_defs, custom_event_calls).
--
-- No core table is created, altered (apart from the FORCE flag of the seven tables above), referenced by a
-- foreign key or written: accounts, orders and tenants are checked by the application under its locks, so
-- no RI trigger lands on b2b_accounts, orders or tenants. Personal data: the request keeps the requesting
-- administrator's business e-mail (the invitation is addressed to it), nothing else.

CREATE TABLE b2b254_trade_lines (
 tenant_id uuid NOT NULL,
 account_id uuid NOT NULL,
 id uuid NOT NULL UNIQUE,
 currency text NOT NULL CHECK (currency IN ('PLN','EUR','USD','GBP','CZK')),
 -- Minor units (grosze); at most 1 000 000 000.00.
 limit_minor bigint NOT NULL CHECK (limit_minor BETWEEN 0 AND 100000000000),
 term_days integer NOT NULL CHECK (term_days BETWEEN 1 AND 365),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE b2b254_trade_charges (
 tenant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 account_id uuid NOT NULL,
 line_id uuid NOT NULL,
 channel text NOT NULL CHECK (channel IN ('portal','network','dropship')),
 currency text NOT NULL CHECK (currency IN ('PLN','EUR','USD','GBP','CZK')),
 -- The order's open balance when it was placed on credit, and the exposure and limit it was admitted against.
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 exposure_before_minor bigint NOT NULL CHECK (exposure_before_minor >= 0),
 limit_minor bigint NOT NULL CHECK (limit_minor >= 0),
 due_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, order_id),
 CHECK (exposure_before_minor + amount_minor <= limit_minor),
 CHECK (due_at > created_at),
 FOREIGN KEY (tenant_id, account_id) REFERENCES b2b254_trade_lines(tenant_id, account_id)
);
CREATE INDEX b2b254_trade_charges_account ON b2b254_trade_charges(tenant_id, account_id, due_at, order_id);

CREATE TABLE b2b254_directory_profiles (
 tenant_id uuid PRIMARY KEY,
 display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 120),
 description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
 city text NOT NULL DEFAULT '' CHECK (char_length(city) <= 100),
 country text NOT NULL DEFAULT 'PL' CHECK (country ~ '^[A-Z]{2}$'),
 categories text[] NOT NULL DEFAULT '{}' CHECK (cardinality(categories) <= 10),
 -- Opt-in: only a listed profile is visible to other companies.
 listed boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX b2b254_directory_profiles_listed ON b2b254_directory_profiles(lower(display_name), tenant_id) WHERE listed;

CREATE TABLE b2b254_directory_requests (
 id uuid PRIMARY KEY,
 -- The requesting seller; the supplier answers.
 tenant_id uuid NOT NULL,
 supplier_tenant_id uuid NOT NULL,
 client_key uuid NOT NULL,
 requester_name text NOT NULL CHECK (char_length(requester_name) BETWEEN 1 AND 200),
 supplier_name text NOT NULL CHECK (char_length(supplier_name) BETWEEN 2 AND 120),
 recipient_email text NOT NULL CHECK (char_length(recipient_email) BETWEEN 3 AND 320 AND position('@' IN recipient_email) > 1),
 message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 1000),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','declined','withdrawn')),
 account_id uuid,
 invitation_id uuid UNIQUE,
 requested_by uuid NOT NULL,
 decided_by uuid,
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, client_key),
 CHECK (tenant_id <> supplier_tenant_id),
 CHECK ((state = 'accepted') = (account_id IS NOT NULL AND invitation_id IS NOT NULL)),
 CHECK ((state = 'pending') = (decided_at IS NULL)),
 FOREIGN KEY (supplier_tenant_id) REFERENCES b2b254_directory_profiles(tenant_id)
);
-- One open request per seller and supplier.
CREATE UNIQUE INDEX b2b254_directory_requests_open ON b2b254_directory_requests(tenant_id, supplier_tenant_id) WHERE state = 'pending';
CREATE INDEX b2b254_directory_requests_inbox ON b2b254_directory_requests(supplier_tenant_id, created_at DESC, id DESC);
CREATE INDEX b2b254_directory_requests_outbox ON b2b254_directory_requests(tenant_id, created_at DESC, id DESC);

ALTER TABLE b2b254_trade_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b254_trade_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b254_directory_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b254_directory_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b254_trade_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b254_trade_charges FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b254_directory_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE b2b254_directory_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON b2b254_trade_lines USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON b2b254_trade_charges USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON b2b254_directory_profiles USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- Any company reads a listed profile (public fields only; the table has no price or catalogue column).
CREATE POLICY directory_read ON b2b254_directory_profiles FOR SELECT TO dyna_app USING (listed);
CREATE POLICY tenant_scope ON b2b254_directory_requests USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- The addressed supplier reads its inbox and records its decision.
CREATE POLICY supplier_read ON b2b254_directory_requests FOR SELECT TO dyna_app USING (supplier_tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY supplier_decide ON b2b254_directory_requests FOR UPDATE TO dyna_app USING (supplier_tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (supplier_tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE b2b254_trade_lines, b2b254_trade_charges, b2b254_directory_profiles, b2b254_directory_requests FROM PUBLIC,dyna_app;
-- No DELETE or TRUNCATE for the application role; charges are append-only; a request changes only its decision.
GRANT SELECT,INSERT,UPDATE ON TABLE b2b254_trade_lines TO dyna_app;
GRANT SELECT,INSERT ON TABLE b2b254_trade_charges TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE b2b254_directory_profiles TO dyna_app;
GRANT SELECT,INSERT ON TABLE b2b254_directory_requests TO dyna_app;
GRANT UPDATE (state, account_id, invitation_id, decided_by, decided_at, updated_at) ON TABLE b2b254_directory_requests TO dyna_app;

-- M6: the table owner is subject to the policies too. The application's owner pool (server/db.ts `pool`)
-- logs in as the role that owns every table; on this installation it is a superuser, which bypasses RLS
-- with or without FORCE, exactly like the 610 tables that already have FORCE (docs/parity/B2B-CREDIT246-20261027.md).
ALTER TABLE payu242_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE payu242_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE payu242_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE payu242_refunds FORCE ROW LEVEL SECURITY;
ALTER TABLE audit238_event_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_event_defs FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_event_calls FORCE ROW LEVEL SECURITY;
