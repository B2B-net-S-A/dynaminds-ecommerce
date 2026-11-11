-- SOURCE208 CANDIDATE ONLY: not registered, compiled, benchmarked or accepted.
-- Frozen SQL188/206/207, their manifests and business documents remain unchanged.
-- Caller owns one exclusive982376 owner transaction. Supported runtime keeps
-- its genuine shared schema-generation fence and all early/late/deferred requires.
-- No IAM/result/session cache, no quota or timeout change.
DO $pre208$ BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres' OR current_setting('session_replication_role')<>'origin'
 OR current_setting('TimeZone')<>'UTC' OR current_setting('server_version_num')::integer/10000<>18
 OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION '208 owner origin PG18 context required' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=0 AND objid=982376 AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN RAISE EXCEPTION '208 caller-held exclusive schema fence required' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'return_credit208_'))
 OR EXISTS(SELECT FROM pg_type WHERE typnamespace='public'::regnamespace AND(starts_with(typname,'return_credit208_') OR starts_with(typname,'_return_credit208_')))
 OR EXISTS(SELECT FROM pg_proc WHERE(pronamespace='public'::regnamespace AND starts_with(proname,'return_credit208_')) OR(pronamespace='pg_catalog'::regnamespace AND proname LIKE 'return_credit20%'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='@@MIGRATION@@') THEN RAISE EXCEPTION '208 unexpected existing namespace or marker' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM public.migrations WHERE name='207_consumer_return_credit')
 OR public.return_credit206_guards() IS DISTINCT FROM true OR public.local_consumer_credit_guards() IS DISTINCT FROM true
 OR public.ordinary188_structure_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '208 complete genuine207 predecessor required' USING ERRCODE='55000';END IF;
 IF(SELECT coalesce(jsonb_agg(record ORDER BY record->>'kind',record->>'key' COLLATE "C"),'[]'::jsonb) FROM(
@@RECORDS@@
 ) original207) IS DISTINCT FROM $expected207$@@EXPECTED207@@$expected207$::jsonb THEN RAISE EXCEPTION '208 exact independently source-compiled539 predecessor descriptors required' USING ERRCODE='55000';END IF;
END $pre208$;
CREATE TABLE public.return_credit208_manifest(
 id boolean PRIMARY KEY CHECK(id),profile text NOT NULL CHECK(profile='207-to208-consumer-credit-deduplicated/v1'),
 original207 jsonb NOT NULL CHECK(jsonb_typeof(original207)='object' AND octet_length(original207::text)<=65536),
 successor207_fingerprint text NOT NULL CHECK(successor207_fingerprint~'^[a-f0-9]{64}$'),
 fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE public.return_credit208_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_credit208_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON public.return_credit208_manifest TO postgres USING(true) WITH CHECK(true);
CREATE TRIGGER return_credit208_immutable BEFORE UPDATE OR DELETE ON public.return_credit208_manifest FOR EACH ROW EXECUTE FUNCTION public.return_credit206_immutable();
CREATE TRIGGER return_credit208_no_truncate BEFORE TRUNCATE ON public.return_credit208_manifest FOR EACH STATEMENT EXECUTE FUNCTION public.return_credit206_immutable();
CREATE FUNCTION public.return_credit208_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $fingerprint208$@@FINGERPRINT@@$fingerprint208$;
-- Close inherited default grants on these NEW objects only; no global role,
-- default privilege, old manifest or existing function ACL is modified.
DO $acl208$ DECLARE r record;BEGIN
 FOR r IN SELECT DISTINCT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='public.return_credit208_manifest'::regclass AND a.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.return_credit208_manifest FROM %s',CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END);
 END LOOP;
 FOR r IN SELECT DISTINCT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.return_credit208_fingerprint()'::regprocedure AND a.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.return_credit208_fingerprint() FROM %s',CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r.grantee)) END);
 END LOOP;
END $acl208$;
CREATE OR REPLACE FUNCTION public.return_credit206_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $guard208$@@GUARD@@$guard208$;
CREATE OR REPLACE FUNCTION public.return_credit206_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $require208$@@REQUIRE@@$require208$;
INSERT INTO public.return_credit208_manifest(id,profile,original207,successor207_fingerprint,fingerprint)
 SELECT true,'207-to208-consumer-credit-deduplicated/v1',to_jsonb(m),public.return_credit206_fingerprint(),public.return_credit208_fingerprint() FROM public.return_credit206_manifest m WHERE id;
DO $close208$ BEGIN
 IF public.return_credit206_guards() IS DISTINCT FROM true OR public.local_consumer_credit_guards() IS DISTINCT FROM true OR public.ordinary188_structure_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '208 full successor refused' USING ERRCODE='55000';END IF;
END $close208$;
