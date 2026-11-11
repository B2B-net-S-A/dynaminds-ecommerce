ALTER TABLE orders ADD COLUMN portal_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE orders ADD COLUMN portal_expires_at timestamptz;
ALTER TABLE return_cases ADD COLUMN submitted_by text NOT NULL DEFAULT 'operator' CHECK(submitted_by IN ('operator','buyer'));
CREATE INDEX return_cases_page ON return_cases(tenant_id,created_at DESC,id DESC);
CREATE INDEX return_cases_kind_page ON return_cases(tenant_id,kind,created_at DESC,id DESC);
CREATE INDEX return_cases_origin_page ON return_cases(tenant_id,submitted_by,created_at DESC,id DESC);
CREATE INDEX return_cases_received ON return_cases(tenant_id,order_id,receipt_sequence) WHERE received_at IS NOT NULL;
