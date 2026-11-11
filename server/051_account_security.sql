-- Account-wide authentication data is owned by the authentication service, never tenant SQL.
CREATE TABLE account_security (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
  secret_encrypted text,
  enabled_at timestamptz,
  last_step bigint NOT NULL DEFAULT -1,
  recovery_hashes jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(recovery_hashes)='array'),
  pending_encrypted text,
  pending_session_hash text,
  pending_expires_at timestamptz,
  failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
  locked_until timestamptz,
  CHECK((secret_encrypted IS NULL)=(enabled_at IS NULL)),
  CHECK((pending_encrypted IS NULL)=(pending_session_hash IS NULL)),
  CHECK((pending_encrypted IS NULL)=(pending_expires_at IS NULL))
);
REVOKE ALL ON account_security FROM PUBLIC,dyna_app;
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD CONSTRAINT sessions_id_unique UNIQUE(id);
ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN account_version bigint NOT NULL DEFAULT 0;
CREATE INDEX sessions_user ON sessions(user_id,expires_at);
REVOKE ALL ON sessions,users FROM PUBLIC,dyna_app;
