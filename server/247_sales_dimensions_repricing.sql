-- Migration 247_sales_dimensions_repricing (prepared as 252, registered after 246_b2b_trade_credit_directory).
-- Stage 4: DOM-ANALYTICS-002 (track S7) and DOM-REPRICE-004/-005 with the REPRICE-006 channel result column
-- (track S9). Own tables only:
--  * order_sales_dimensions: the delivery and payment group of an imported order, recorded by the channel importer
--    in the import transaction (or by the administrator backfill from inbound_orders.raw). Sales reports group by it.
--  * repricing_overrides: a manual exclusion or fixed price per price list and product, with author and time;
--    revoked rows stay as history. Previews and scheduled runs respect the active one.
--  * repricing_channel_results: one row per (scheduled run, listing) whose price the run changed; the reconcile
--    step links it to the offer-sync plan (sent, acknowledged, read price, mismatch).
--
-- No core table is altered, referenced by a foreign key (no RI trigger lands on orders, products, price_lists,
-- listings or offer_plans) or written, so no existing catalogue record, guard or fingerprint moves. Identifiers are
-- checked by the application under its own locks. Personal data: none (delivery and payment names of the channel only).

CREATE TABLE order_sales_dimensions (
 tenant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 delivery_method text NOT NULL CHECK (delivery_method IN ('parcel_locker','pickup_point','courier','post','personal_pickup','digital','other','unknown')),
 delivery_label text NOT NULL DEFAULT '' CHECK (char_length(delivery_label) <= 120),
 payment_method text NOT NULL CHECK (payment_method IN ('cod','transfer','card','online','cash','marketplace','other','unknown')),
 payment_label text NOT NULL DEFAULT '' CHECK (char_length(payment_label) <= 120),
 provider text NOT NULL CHECK (provider ~ '^[a-z0-9_]{2,40}$'),
 origin text NOT NULL CHECK (origin IN ('import','backfill')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, order_id)
);

CREATE TABLE repricing_overrides (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 price_list_id uuid NOT NULL,
 product_id uuid NOT NULL,
 mode text NOT NULL CHECK (mode IN ('exclude','fixed')),
 -- Gross price in the list currency, minor units; only for a fixed override.
 fixed_price integer CHECK (fixed_price BETWEEN 0 AND 100000000),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 replaces_id uuid,
 revoked_by uuid,
 revoked_at timestamptz,
 revoke_reason text CHECK (char_length(revoke_reason) <= 500),
 UNIQUE (tenant_id, id),
 CHECK ((mode = 'fixed') = (fixed_price IS NOT NULL)),
 CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
-- At most one active override per price list and product; a change revokes the previous row in the same transaction.
CREATE UNIQUE INDEX repricing_overrides_active ON repricing_overrides(tenant_id, price_list_id, product_id) WHERE revoked_at IS NULL;
CREATE INDEX repricing_overrides_page ON repricing_overrides(tenant_id, price_list_id, created_at DESC, id DESC);

CREATE TABLE repricing_channel_results (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 listing_id uuid NOT NULL,
 preview_id uuid NOT NULL,
 price_list_id uuid NOT NULL,
 product_id uuid NOT NULL,
 channel_id uuid NOT NULL,
 expected_price integer NOT NULL CHECK (expected_price BETWEEN 0 AND 100000000),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 applied_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','acknowledged','mismatch','failed','superseded')),
 plan_id uuid,
 remote_price integer CHECK (remote_price BETWEEN 0 AND 100000000),
 error text CHECK (char_length(error) <= 500),
 checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, run_id, listing_id),
 CHECK (status IN ('pending') OR plan_id IS NOT NULL),
 CHECK (remote_price IS NULL OR status = 'acknowledged')
);
CREATE INDEX repricing_channel_results_open ON repricing_channel_results(tenant_id, created_at, run_id) WHERE status IN ('pending','sent');
CREATE INDEX repricing_channel_results_preview ON repricing_channel_results(tenant_id, preview_id);

ALTER TABLE order_sales_dimensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE repricing_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE repricing_channel_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_sales_dimensions FORCE ROW LEVEL SECURITY;
ALTER TABLE repricing_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE repricing_channel_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON order_sales_dimensions USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON repricing_overrides USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON repricing_channel_results USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON TABLE order_sales_dimensions, repricing_overrides, repricing_channel_results FROM PUBLIC,dyna_app;
-- No DELETE or TRUNCATE for the application role; a recorded dimension is never rewritten by it.
GRANT SELECT,INSERT ON TABLE order_sales_dimensions TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE repricing_overrides TO dyna_app;
GRANT SELECT,INSERT,UPDATE ON TABLE repricing_channel_results TO dyna_app;
