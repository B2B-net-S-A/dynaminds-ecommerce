-- Migration 240_buyer_available_events (docs/parity/BUYER-ADDRESS240-20261027.md): the 239 event-trigger
-- pre-check (commit 1bbacef) for buyer_available236(), and no re-baselining after an event-trigger round trip.
-- 236's basis includes the pg_event_trigger values, so a committed ALTER EVENT TRIGGER ordinary182_schema_ddl
-- DISABLE caused one miss; buyer_address_guards() (which does not look at event triggers) was still true and was
-- recorded with the "trigger disabled" basis. From then on owner DDL, e.g. CREATE OR REPLACE of buyer_address_hash,
-- moved neither the 182 generation nor the basis (pg_proc is not in it): buyer_available236() said true while
-- buyer_address_available() raised 55000. The same with DISABLE, DDL, ENABLE (values restored), and with a no-op
-- ordinary182_invalidate() put in place while the trigger was off.
--
-- buyer_available236() keeps the 236 text plus (a) after the generation re-check, before the TEMP shadow check: all
-- three 182 event triggers present, origin-enabled, untagged, on their expected event and function, and
-- event_triggers not off here, else buyer_address_available() and nothing recorded; (b) on the miss path, nothing is
-- recorded while an event trigger, ordinary182_ function or the generation table's pg_class/trigger/rule row is newer
-- than the generation row (the cold approval). buyer_available236_basis() keeps the 236 text plus the row versions
-- of pg_event_trigger, of every public function and of the generation table's pg_class/trigger/rule rows.
-- Everything else (fence, re-check, TEMP shadow check, recording rules, SECURITY DEFINER, search_path, TimeZone,
-- EXECUTE only for dyna_app) is unchanged. Neither is a buyer_address_ object, so no buyer fingerprint or guard pin
-- moves; 236 itself stays byte-for-byte as applied.
CREATE OR REPLACE FUNCTION buyer_available236_basis() RETURNS text
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
  'buyer_triggers',(SELECT jsonb_agg(jsonb_build_array(tgrelid::text,tgname,tgenabled,tgfoid::text) ORDER BY tgrelid,tgname) FROM pg_catalog.pg_trigger WHERE starts_with(tgname,'buyer_address_')),
  -- 240: row versions too. An ALTER EVENT TRIGGER round trip (DISABLE, DDL, ENABLE) restores the values above but not
  -- the xmin; a function replaced while no event trigger fired (replica mode, event_triggers=off) has a new xmin; so
  -- has a rule or trigger put on the generation table. Each is a miss, and the miss path below refuses to record.
  'event_trigger_rows',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_event_trigger),
  'public_functions',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace),
  'generation_relation',jsonb_build_array(
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass),
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_trigger WHERE tgrelid='public.ordinary182_runtime_generation'::regclass),
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass))
 )::text,'UTF8')),'hex')
$$;

CREATE OR REPLACE FUNCTION buyer_available236() RETURNS boolean
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
 -- 240: the generation is only a schema version while the three 182 event triggers fire. A disabled,
 -- replica-only, replaced, tagged or dropped one (or event_triggers=off here) changes the basis, but a miss must
 -- not re-baseline it: the full guard does not look at event triggers. Any such state: the full guard, nothing recorded.
 IF current_setting('event_triggers',true) IS NOT DISTINCT FROM 'off' OR (SELECT count(*) FROM pg_catalog.pg_event_trigger e
  WHERE e.evtenabled='O' AND e.evttags IS NULL AND (
   (e.evtname='ordinary182_schema_ddl' AND e.evtevent='ddl_command_start' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_invalidate()'))
   OR (e.evtname='ordinary182_temp_ddl_end' AND e.evtevent='ddl_command_end' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_temp_ddl_end()'))
   OR (e.evtname='ordinary182_temp_drop' AND e.evtevent='sql_drop' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_temp_drop()'))))<>3 THEN
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
  AND public.buyer_available236_basis()=b
  -- 240: and no event trigger, ordinary182_ function or rule/trigger/row of the generation table was written after
  -- the generation row (the cold approval; DDL in between leaves it dirty). A healthy-looking state after an ALTER
  -- EVENT TRIGGER round trip or a replaced invalidator is never re-baselined. Fail-safe: a generation row older than
  -- 10^9 transactions (age wraps at 2^31) records nothing either.
  AND (SELECT pg_catalog.age(g.xmin) FROM public.ordinary182_runtime_generation g WHERE g.singleton) BETWEEN 0 AND 1000000000
  AND NOT EXISTS(SELECT FROM (SELECT xmin FROM pg_catalog.pg_event_trigger
    UNION ALL SELECT xmin FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'ordinary182_')
    UNION ALL SELECT xmin FROM pg_catalog.pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass
    UNION ALL SELECT xmin FROM pg_catalog.pg_trigger WHERE tgrelid='public.ordinary182_runtime_generation'::regclass
    UNION ALL SELECT xmin FROM pg_catalog.pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass) w
   WHERE pg_catalog.age(w.xmin) BETWEEN 0 AND (SELECT pg_catalog.age(g.xmin) FROM public.ordinary182_runtime_generation g WHERE g.singleton)-1) THEN
  PERFORM 1 FROM public.buyer_available236_verdict WHERE singleton FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
   UPDATE public.buyer_available236_verdict SET generation=v.generation,basis_sha256=b,verified_at=clock_timestamp() WHERE singleton;
  END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION buyer_available236_basis() FROM PUBLIC;
REVOKE ALL ON FUNCTION buyer_available236() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION buyer_available236() TO dyna_app;
