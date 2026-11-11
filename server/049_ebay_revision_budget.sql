-- Service-only ledger: a seller may connect the same account in several tenants/channels.
-- Never expose or allow a tenant to reset another connection's shared budget.
CREATE TABLE ebay_revision_attempts (
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 listing_id text NOT NULL CHECK(length(listing_id) BETWEEN 1 AND 160),
 plan_id uuid NOT NULL, attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope_hash,listing_id,plan_id)
);
CREATE INDEX ebay_revision_window ON ebay_revision_attempts(scope_hash,listing_id,attempted_at);
REVOKE ALL ON ebay_revision_attempts FROM PUBLIC,dyna_app;
