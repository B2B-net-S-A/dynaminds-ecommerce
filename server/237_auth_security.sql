-- Migration 237_auth_security (docs/parity/AUTH-SECURITY237-20261027.md): login event history with the
-- failed attempts (SEC-005), a durable failed-password lock per login (SEC-012) and the state of API keys
-- that the core api_keys row does not hold: rotation lineage and last use (API-001).
--
-- Own auth237_ objects only. No core table is altered, referenced by a foreign key (no RI trigger lands on
-- users or api_keys) or written, so no existing catalogue record, guard or fingerprint moves. Like
-- account_security, everything is owner-only: the authentication service reads and writes it; dyna_app and
-- PUBLIC get nothing, and RLS without a policy keeps any other role out.
--
-- A login is identified by subject_hash, an HMAC-SHA256 of the normalised e-mail with a key derived from the
-- installation's encryptionKey (computed in server/login-history.ts, never here). The same column serves
-- known and unknown addresses, so the lock and the answers do not reveal whether an account exists, and a
-- database copy alone cannot test which addresses were tried.

CREATE TABLE auth237_login_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- NULL: no account has this login; only the keyed hash is kept.
 user_id uuid,
 -- The organisation signed into; only a successful login has one.
 tenant_id uuid,
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('success','password_failed','mfa_failed','password_locked','mfa_locked','refused','password_reset')),
 status smallint NOT NULL CHECK(status BETWEEN 200 AND 599),
 ip text CHECK(char_length(ip)<=64),
 user_agent text CHECK(char_length(user_agent)<=300),
 CHECK(tenant_id IS NULL OR user_id IS NOT NULL),
 CHECK((outcome='success')=(tenant_id IS NOT NULL))
);
CREATE INDEX auth237_login_events_user ON auth237_login_events(user_id,created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX auth237_login_events_age ON auth237_login_events(created_at);

-- One row per login with recent failures. failures counts attempts not yet proven by the right password.
CREATE TABLE auth237_login_throttle (
 subject_hash text PRIMARY KEY CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
 locked_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth237_login_throttle_age ON auth237_login_throttle(updated_at);

-- Rotation lineage (one successor per key) and the last use, stamped at most once a minute.
CREATE TABLE auth237_api_key_state (
 key_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 rotated_from_id uuid UNIQUE,
 rotated_by uuid,
 rotated_at timestamptz,
 last_used_at timestamptz,
 last_used_ip text CHECK(char_length(last_used_ip)<=64),
 CHECK((rotated_from_id IS NULL)=(rotated_by IS NULL) AND (rotated_from_id IS NULL)=(rotated_at IS NULL)),
 CHECK(rotated_from_id IS DISTINCT FROM key_id)
);
CREATE INDEX auth237_api_key_state_tenant ON auth237_api_key_state(tenant_id);

ALTER TABLE auth237_login_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth237_login_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth237_api_key_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE auth237_login_events FROM PUBLIC,dyna_app;
REVOKE ALL ON TABLE auth237_login_throttle FROM PUBLIC,dyna_app;
REVOKE ALL ON TABLE auth237_api_key_state FROM PUBLIC,dyna_app;

-- Reserve one password attempt for a login before the password is checked. A locked login is refused
-- (allowed=false) without counting. Otherwise the attempt counts as a failure until the right password
-- deletes the row; the fifth failure within an hour locks for 5 minutes, each further one doubles the lock
-- up to 30 minutes. The row lock makes concurrent attempts from any number of instances count one by one.
CREATE FUNCTION auth237_login_attempt(subject text, OUT allowed boolean, OUT locked_until timestamptz)
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $auth237$
DECLARE r public.auth237_login_throttle; n integer; t timestamptz:=clock_timestamp();
BEGIN
 -- One statement creates or row-locks the counter, so a concurrent success (DELETE) or purge between a
 -- separate insert and read cannot leave this attempt without a row.
 INSERT INTO public.auth237_login_throttle AS x(subject_hash) VALUES(subject)
 ON CONFLICT(subject_hash) DO UPDATE SET subject_hash=x.subject_hash RETURNING x.* INTO STRICT r;
 IF r.locked_until>t THEN allowed:=false;locked_until:=r.locked_until;RETURN;END IF;
 -- A quiet hour forgets earlier failures.
 n:=CASE WHEN r.updated_at<t-interval '1 hour' THEN 0 ELSE r.failures END+1;
 locked_until:=CASE WHEN n>=5 THEN t+least(interval '5 minutes'*(2^least(n-5,3)),interval '30 minutes') END;
 UPDATE public.auth237_login_throttle x SET failures=n,locked_until=auth237_login_attempt.locked_until,updated_at=t WHERE x.subject_hash=subject;
 allowed:=true;
END
$auth237$;

-- Record one login event and keep the retention: events older than 90 days and idle unlocked counters older
-- than a day leave, at most 200 of each per call, so no worker is needed and no call does unbounded work.
CREATE FUNCTION auth237_record_login(p_user uuid,p_tenant uuid,p_subject text,p_outcome text,p_status integer,p_ip text,p_user_agent text) RETURNS uuid
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $auth237$
DECLARE id uuid;
BEGIN
 INSERT INTO public.auth237_login_events(user_id,tenant_id,subject_hash,outcome,status,ip,user_agent)
 VALUES(p_user,p_tenant,p_subject,p_outcome,p_status,left(p_ip,64),left(p_user_agent,300)) RETURNING auth237_login_events.id INTO id;
 DELETE FROM public.auth237_login_events WHERE auth237_login_events.id IN(SELECT e.id FROM public.auth237_login_events e
  WHERE created_at<clock_timestamp()-interval '90 days' ORDER BY created_at LIMIT 200);
 DELETE FROM public.auth237_login_throttle WHERE subject_hash IN(SELECT x.subject_hash FROM public.auth237_login_throttle x
  WHERE updated_at<clock_timestamp()-interval '1 day' AND (locked_until IS NULL OR locked_until<clock_timestamp()) ORDER BY updated_at LIMIT 200);
 RETURN id;
END
$auth237$;
REVOKE ALL ON FUNCTION auth237_login_attempt(text) FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION auth237_record_login(uuid,uuid,text,text,integer,text,text) FROM PUBLIC,dyna_app;
