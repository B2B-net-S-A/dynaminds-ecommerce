-- Migration 245_s5_comm (prepared as placeholder 253; the object names keep that prefix; see
-- docs/parity/S5-COMM245-20261027.md). The migration part of lane S5 (docs/parity/STAGE4-NONINTEGRATION-GAP-20261025.md,
-- area 1) after PORTAL-COMM-S5-20261026.md and COMMUNICATION-S5-20261027.md:
--  * COM-001 open item: per-order history of email_messages / sms_messages without a scan over the whole tenant;
--  * COM-PORTAL-4: a per-tenant default validity of the buyer portal link (applied by the application to
--    orders.portal_expires_at at order creation, on rotation and, on request, to existing links without a date);
--  * COM-005: a per-account IMAP schedule that runs as the administrator who enabled it, and the record of every
--    automatic match (In-Reply-To / References of our own Message-ID, order number in the subject);
--  * COM-008: one inbox for marketplace and helpdesk conversations: connections, threads with a channel and an
--    external thread id whose order is optional (questions before a purchase), and their messages.
--
-- Own objects only (prefixes comm253_, portal253_, inbound253_, channel253_; none matches a sealed fingerprint
-- pattern such as 'email_inbound_%', 'return_%' or 'order_parcel_%'). The only objects on existing tables are two
-- indexes. No column, constraint, trigger or function of an existing table changes, no foreign key points at a
-- core or sealed table (no RI trigger lands on orders, users, tenants or the 141 email_inbound_* tables), and the
-- migration writes no rows. Identifiers of orders, users and IMAP accounts are checked by the application inside
-- the tenant transaction. Personal data: channel253_threads.buyer_ref (marketplace login or helpdesk requester,
-- at most 200 characters) and message bodies; nothing else.

-- COM-001: GET /api/orders/:id/communication, the email and SMS history of the order card.
CREATE INDEX comm253_email_order ON email_messages(tenant_id, order_id, created_at DESC, id DESC);
CREATE INDEX comm253_sms_order ON sms_messages(tenant_id, order_id, created_at DESC, id DESC);

-- COM-PORTAL-4: default validity of new buyer links in days; NULL = links without an end date (as before 245).
CREATE TABLE portal253_link_policies (
 tenant_id uuid PRIMARY KEY,
 default_days integer CHECK (default_days BETWEEN 1 AND 365),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- COM-005: one schedule per IMAP account. actor_id is the administrator who enabled it; every run re-checks that
-- user's current access through the 141 functions, so a removed or demoted user stops the schedule.
CREATE TABLE inbound253_schedules (
 tenant_id uuid NOT NULL,
 account_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 interval_minutes integer NOT NULL DEFAULT 15 CHECK (interval_minutes BETWEEN 5 AND 1440),
 auto_bind boolean NOT NULL DEFAULT true,
 actor_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 next_run_at timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 last_run_at timestamptz,
 last_outcome text CHECK (last_outcome IN ('fetched','empty','failed','refused')),
 last_error text CHECK (char_length(last_error) <= 300),
 last_fetched integer CHECK (last_fetched >= 0),
 last_bound integer CHECK (last_bound >= 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, account_id),
 CHECK (NOT enabled OR next_run_at IS NOT NULL),
 CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX inbound253_schedules_due ON inbound253_schedules(next_run_at) WHERE enabled;

-- COM-005: the decision taken for each imported message by the automatic matcher (append-only for dyna_app).
-- 'bound': exactly one order matched and the 141 bind ran as the schedule's actor (binding_id is that binding);
-- 'ambiguous': more than one order matched, nothing bound; 'none': no evidence, left for a person.
CREATE TABLE inbound253_matches (
 tenant_id uuid NOT NULL,
 message_id uuid NOT NULL,
 account_id uuid NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('bound','ambiguous','none','failed')),
 method text CHECK (method IN ('in_reply_to','references','subject_number')),
 order_id uuid,
 binding_id uuid,
 candidates integer NOT NULL DEFAULT 0 CHECK (candidates BETWEEN 0 AND 100),
 evidence text NOT NULL DEFAULT '' CHECK (char_length(evidence) <= 300),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, message_id),
 CHECK ((outcome = 'bound') = (binding_id IS NOT NULL)),
 CHECK (outcome <> 'bound' OR (method IS NOT NULL AND order_id IS NOT NULL AND candidates = 1)),
 CHECK (outcome <> 'ambiguous' OR candidates > 1)
);
CREATE INDEX inbound253_matches_page ON inbound253_matches(tenant_id, created_at DESC, message_id);

-- COM-008: a marketplace or helpdesk connection. No provider is called by this migration's code: messages enter
-- through the connector port (server/channel-inbox253.ts ingestChannelMessages), replies are kept as pending
-- intents until a connector for that channel exists.
CREATE TABLE channel253_connections (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 channel text NOT NULL CHECK (channel IN ('allegro','ebay','amazon','helpdesk')),
 name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
 enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, channel, name)
);
CREATE TABLE channel253_threads (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 channel text NOT NULL CHECK (channel IN ('allegro','ebay','amazon','helpdesk')),
 external_thread_id text NOT NULL CHECK (char_length(external_thread_id) BETWEEN 1 AND 200),
 -- NULL: a question before a purchase or an order not identified yet; set by a person or by the order number.
 order_id uuid,
 subject text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 300),
 buyer_ref text NOT NULL DEFAULT '' CHECK (char_length(buyer_ref) <= 200),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
 assigned_user_id uuid,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 message_count integer NOT NULL DEFAULT 0 CHECK (message_count BETWEEN 0 AND 10000),
 last_message_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, connection_id, external_thread_id),
 FOREIGN KEY (tenant_id, connection_id) REFERENCES channel253_connections(tenant_id, id)
);
CREATE INDEX channel253_threads_inbox ON channel253_threads(tenant_id, last_message_at DESC, id DESC);
CREATE INDEX channel253_threads_status ON channel253_threads(tenant_id, status, last_message_at DESC, id DESC);
CREATE INDEX channel253_threads_order ON channel253_threads(tenant_id, order_id) WHERE order_id IS NOT NULL;
CREATE TABLE channel253_messages (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 thread_id uuid NOT NULL,
 -- inbound: from the buyer through the connector port; reply: staff answer kept as a pending intent (no connector
 -- sends it yet); note: private staff note, never sent.
 kind text NOT NULL CHECK (kind IN ('inbound','reply','note')),
 state text NOT NULL CHECK (state IN ('received','pending','note')),
 external_message_id text CHECK (char_length(external_message_id) BETWEEN 1 AND 200),
 actor_id uuid,
 client_key uuid NOT NULL,
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
 sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, thread_id, client_key),
 FOREIGN KEY (tenant_id, thread_id) REFERENCES channel253_threads(tenant_id, id),
 CHECK ((kind = 'inbound') = (actor_id IS NULL)),
 CHECK ((kind = 'inbound') = (external_message_id IS NOT NULL)),
 CHECK (state = CASE kind WHEN 'inbound' THEN 'received' WHEN 'reply' THEN 'pending' ELSE 'note' END)
);
CREATE UNIQUE INDEX channel253_messages_external ON channel253_messages(tenant_id, thread_id, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX channel253_messages_thread ON channel253_messages(tenant_id, thread_id, created_at DESC, id DESC);

ALTER TABLE portal253_link_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound253_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound253_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel253_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel253_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel253_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON portal253_link_policies USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON inbound253_schedules USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON inbound253_matches USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON channel253_connections USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON channel253_threads USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON channel253_messages USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE portal253_link_policies, inbound253_schedules, inbound253_matches, channel253_connections, channel253_threads, channel253_messages FROM PUBLIC,dyna_app;
-- No DELETE or TRUNCATE for the application role; matches and channel messages are append-only for it.
GRANT SELECT,INSERT,UPDATE ON TABLE portal253_link_policies TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE inbound253_schedules TO dyna_app;
GRANT SELECT,INSERT ON TABLE inbound253_matches TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE channel253_connections TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE channel253_threads TO dyna_app;
GRANT SELECT,INSERT ON TABLE channel253_messages TO dyna_app;
