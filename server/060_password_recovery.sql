-- Account-wide recovery belongs to the auth service, not to any tenant role.
CREATE TABLE account_password_resets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  password_fingerprint text NOT NULL CHECK(password_fingerprint ~ '^[a-f0-9]{64}$'),
  account_version bigint NOT NULL CHECK(account_version>=0),
  database_name text NOT NULL DEFAULT current_database(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(expires_at>created_at)
);
CREATE INDEX account_password_resets_expiry ON account_password_resets(expires_at);
CREATE TABLE account_reset_limits (
  email_hash text PRIMARY KEY CHECK(email_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL DEFAULT now(),
  last_request timestamptz NOT NULL DEFAULT now(),
  requests integer NOT NULL DEFAULT 1 CHECK(requests BETWEEN 1 AND 5)
);
CREATE INDEX account_reset_limits_expiry ON account_reset_limits(last_request);
CREATE TABLE account_local_mail (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('password_reset','password_changed')),
  body_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK(expires_at>created_at)
);
CREATE INDEX account_local_mail_user ON account_local_mail(user_id,created_at DESC,id);
CREATE INDEX account_local_mail_expiry ON account_local_mail(expires_at);
REVOKE ALL ON account_password_resets,account_reset_limits,account_local_mail FROM PUBLIC,dyna_app;
