#!/bin/bash
# First start only: load the manifest settings and create the cluster role the restored template refers to.
set -euo pipefail
echo "include '/etc/postgresql/postgresql.scale.conf'" >> "$PGDATA/postgresql.conf"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyna_app') THEN CREATE ROLE dyna_app NOLOGIN; END IF;
END $$;
SQL
