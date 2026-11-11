-- Migration 236_buyer_available_verdict (docs/parity/BUYER-ADDRESS236-20261027.md): the hot-path
-- answer to buyer_address_available() without re-running the full buyer_address_guards() (about
-- 0.35 s) on every call. server/buyer-address.ts calls buyer_available236() instead.
--
-- The full guard is a function of the catalogue, of twelve sealed data tables it reads and of the
-- shared role/tablespace catalogues. buyer_available236() reuses its last TRUE verdict only while
--  * the 182 runtime generation is cold-approved (startup ran the full native predicates under the
--    exclusive 982376 fence) and any owner DDL since then would have made it dirty, and
--  * the basis is unchanged: that generation row, (ctid, xmin) of every row of the twelve tables,
--    roles, memberships, tablespaces, event triggers and the buyer_address_ trigger names, and
--  * this session has no TEMP relation or type named like a public or pg_catalog one.
-- Otherwise (source/dev/test runtimes never approve a generation; any DDL; any changed basis; a TEMP shadow) it
-- runs buyer_address_available() itself: same result, same 55000 error. No buyer_address_ object is
-- created or changed, so the buyer fingerprint and every guard pin stay as they are.
CREATE TABLE buyer_available236_verdict (
 singleton boolean PRIMARY KEY CHECK(singleton),
 generation bigint,
 basis_sha256 text CHECK(basis_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz,
 CHECK((generation IS NULL)=(basis_sha256 IS NULL) AND (generation IS NULL)=(verified_at IS NULL))
);
ALTER TABLE buyer_available236_verdict ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyer_available236_verdict FORCE ROW LEVEL SECURITY;
INSERT INTO buyer_available236_verdict(singleton) VALUES(true);

-- Everything the full guard reads that DDL does not version. The twelve tables are exactly those
-- buyer_address_guards() scans (pg_stat_xact_all_tables, pinned by tests/buyer-available236.test.ts);
-- a new row version always has a new xmin, so (ctid, xmin) changes on any INSERT/UPDATE/DELETE,
-- also in replica mode, without reading the 55 MB of the 209 projection basis.
CREATE FUNCTION buyer_available236_basis() RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  -- Also its row version: an owner UPDATE that restores old values is a new generation basis too.
  'generation',(SELECT to_jsonb(g)||jsonb_build_object('ctid',g.ctid::text,'xmin',g.xmin::text) FROM public.ordinary182_runtime_generation g),
  'rows',jsonb_build_object(
   'b2b_credit_upgrade',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.b2b_credit_upgrade),
   'b2b_invoice_upgrade',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.b2b_invoice_upgrade),
   'buyer_address_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.buyer_address_manifest),
   'competitor_observation_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.competitor_observation_manifest),
   'credit_source_upgrade_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.credit_source_upgrade_certificate),
   'fa3_draft_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.fa3_draft_manifest),
   'financial_return_upgrade_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.financial_return_upgrade_certificate),
   'local_invoice_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.local_invoice_manifest),
   'manual_inventory_off_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.manual_inventory_off_certificate),
   'migrations',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.migrations),
   'order_merge_delivery209_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.order_merge_delivery209_manifest),
   'order_merge_delivery209_projection_basis',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.order_merge_delivery209_projection_basis)),
  -- Shared catalogues: ALTER ROLE, role grants and tablespace renames fire no event trigger.
  'roles',(SELECT jsonb_agg(jsonb_build_array(oid::text,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) ORDER BY oid) FROM pg_catalog.pg_roles),
  'memberships',(SELECT jsonb_agg(jsonb_build_array(roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option) ORDER BY roleid,member,grantor) FROM pg_catalog.pg_auth_members),
  'tablespaces',(SELECT jsonb_agg(jsonb_build_array(oid::text,spcname,spcowner::text,spcacl::text) ORDER BY oid) FROM pg_catalog.pg_tablespace),
  -- Event trigger DDL fires no event trigger; disabling ordinary182_schema_ddl must not go unseen.
  'event_triggers',(SELECT jsonb_agg(jsonb_build_array(oid::text,evtname,evtevent,evtowner::text,evtfoid::text,evtenabled,evttags) ORDER BY oid) FROM pg_catalog.pg_event_trigger),
  -- Runtime TEMP DDL does not move the generation; the guard rejects buyer_address_ triggers in any schema.
  'buyer_triggers',(SELECT jsonb_agg(jsonb_build_array(tgrelid::text,tgname,tgenabled,tgfoid::text) ORDER BY tgrelid,tgname) FROM pg_catalog.pg_trigger WHERE starts_with(tgname,'buyer_address_'))
 )::text,'UTF8')),'hex')
$$;

CREATE FUNCTION buyer_available236() RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE v public.ordinary182_runtime_generation%ROWTYPE;seen public.buyer_available236_verdict%ROWTYPE;b text;
BEGIN
 SELECT * INTO v FROM public.ordinary182_runtime_generation WHERE singleton;
 IF NOT FOUND OR v.dirty OR v.validated_generation IS DISTINCT FROM v.generation THEN
  RETURN public.buyer_address_available(); -- no cold-approved schema: the full guard, as before 236
 END IF;
 -- Shared schema fence (ordinary182_require_generation): no owner DDL commits before this transaction ends.
 PERFORM pg_advisory_xact_lock_shared(982376);
 SELECT * INTO v FROM public.ordinary182_runtime_generation WHERE singleton;
 IF NOT FOUND OR v.dirty OR v.validated_generation IS DISTINCT FROM v.generation OR v.generation<1
  OR v.contract_id IS DISTINCT FROM 'ordinary182-cold-schema-runtime/v1'
  OR v.release_sha256 IS NULL OR v.release_sha256 !~ '^[a-f0-9]{64}$' OR v.native_sha256 IS NULL OR v.native_sha256 !~ '^[a-f0-9]{64}$'
  OR v.profile_native_sha256 IS NULL OR v.profile_native_sha256 !~ '^[a-f0-9]{64}$' THEN
  RETURN public.buyer_address_available();
 END IF;
 -- Runtime TEMP DDL (admitted by 182 for dyna_app) moves no generation, but this session's TEMP
 -- relations and types are searched before public (types: before pg_catalog) by every unqualified
 -- name the guard and the application resolve. Any such shadow: the full guard answers, nothing recorded.
 IF pg_catalog.pg_my_temp_schema()<>0 AND (
  EXISTS(SELECT FROM pg_catalog.pg_class t JOIN pg_catalog.pg_class p ON p.relname=t.relname
   AND p.relnamespace IN('pg_catalog'::regnamespace,'public'::regnamespace) WHERE t.relnamespace=pg_catalog.pg_my_temp_schema())
  OR EXISTS(SELECT FROM pg_catalog.pg_type t JOIN pg_catalog.pg_type p ON p.typname=t.typname
   AND p.typnamespace IN('pg_catalog'::regnamespace,'public'::regnamespace) WHERE t.typnamespace=pg_catalog.pg_my_temp_schema())) THEN
  RETURN public.buyer_address_available();
 END IF;
 b:=public.buyer_available236_basis();
 SELECT * INTO seen FROM public.buyer_available236_verdict WHERE singleton;
 IF seen.generation=v.generation AND seen.basis_sha256=b THEN RETURN true;END IF;
 PERFORM public.buyer_address_available(); -- raises 55000 'Incomplete buyer address module'
 -- Record only a verdict whose basis did not move while the guard ran, only from a read-write
 -- READ COMMITTED transaction and never by waiting for another recorder (SKIP LOCKED).
 IF current_setting('transaction_read_only')='off' AND current_setting('transaction_isolation')='read committed'
  AND public.buyer_available236_basis()=b THEN
  PERFORM 1 FROM public.buyer_available236_verdict WHERE singleton FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
   UPDATE public.buyer_available236_verdict SET generation=v.generation,basis_sha256=b,verified_at=clock_timestamp() WHERE singleton;
  END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON TABLE buyer_available236_verdict FROM PUBLIC;
REVOKE ALL ON FUNCTION buyer_available236_basis() FROM PUBLIC;
REVOKE ALL ON FUNCTION buyer_available236() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION buyer_available236() TO dyna_app;
