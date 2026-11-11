CREATE TABLE ebay_api_buckets (
 scope_hash text PRIMARY KEY CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 app_hash text NOT NULL CHECK(app_hash ~ '^[a-f0-9]{64}$'),
 family text NOT NULL CHECK(family IN ('inventory','fulfillment','account','taxonomy','oauth','trading')),
 cooldown_until timestamptz NOT NULL DEFAULT '-infinity',
 last_429_at timestamptz, limited_responses bigint NOT NULL DEFAULT 0
);
CREATE INDEX ebay_api_application ON ebay_api_buckets(app_hash,family);
CREATE TABLE ebay_api_leases (
 id uuid PRIMARY KEY,scope_hash text NOT NULL REFERENCES ebay_api_buckets,
 expires_at timestamptz NOT NULL
);
CREATE INDEX ebay_api_active_leases ON ebay_api_leases(scope_hash,expires_at);
REVOKE ALL ON ebay_api_buckets,ebay_api_leases FROM PUBLIC,dyna_app;
ALTER TABLE jobs ADD COLUMN provider_wait_until timestamptz;
ALTER TABLE jobs ADD COLUMN provider_wait_reason text;
