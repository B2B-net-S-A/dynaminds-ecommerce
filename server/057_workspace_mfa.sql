-- Policies are owned by the authentication service; tenant SQL cannot weaken them.
CREATE TABLE workspace_security_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  require_mfa boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  changed_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON workspace_security_policies FROM PUBLIC,dyna_app;
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;
-- Existing sessions are intentionally unproven; no timestamp backfill.
ALTER TABLE sessions ADD CONSTRAINT sessions_mfa_proof_expiry CHECK(mfa_verified_at IS NULL OR mfa_verified_at<=expires_at);
