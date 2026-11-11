-- Migration 248_guard_verdicts (prepared as 256, registered after 247_sales_dimensions_repricing; no object name
-- contains the number). docs/parity/GUARD-VERDICTS248-20261027.md.
-- The hot-path answer to three integrity guards the TS writers ask inside their own write transactions, 0.4-0.5 s
-- each even on an idle database (load dry run 27.10, docs/scale/LOAD-TEST-DRYRUN-20261027.md section 4.2):
-- catalog_stock_control_guards(), financial_return_guards() and fa3_draft_guards(). (local_invoice_guards(), ~50 ms,
-- stays on its full guard: its TS caller server/local-invoices.ts is hash-pinned by the scale HTTP bindings.)
-- Same model as 239 (wz_issuer239_verdict) with the 240/241 gates from the start:
--  * only READ COMMITTED (a REPEATABLE READ snapshot may predate committed owner DDL; its role rows are stale);
--  * the 182 runtime generation is cold-approved and stays so under the shared 982376 fence;
--  * the three 182 event triggers fire, and verdict241_ddl_intact() holds (their functions and the TEMP classifier by
--    content, the generation table without rule/policy/trigger, origin mode and event triggers on in this session, no
--    persistent event_triggers/session_replication_role setting, no public shadow of a pg_catalog function/operator);
--  * this session has no TEMP relation or type (182 admits runtime TEMP DDL; pg_temp is searched first);
--  * guard_verdict_basis() is unchanged: the generation row, (ctid, xmin) of every row of the 16 tables the three
--    guards read and of the shared catalogues, event triggers, every session's TEMP catalogue rows, session_user/role
--    and the settings their output depends on, the row version of every public function and of the generation
--    table's pg_class/trigger/rule rows.
-- Otherwise the full guard answers (the same value or error) and nothing is recorded. A true result is recorded
-- only from a read-write transaction, when the basis did not move while the guard ran, no 182 machinery row is newer
-- than the generation row (240) and verdict241_ddl_intact() still holds (241), and never by waiting (SKIP LOCKED).
-- No catalog_stock_, financial_return_, fa3_draft_, local_invoice_, buyer_address_, warehouse_ or ordinary18x_
-- object is created or changed, so no fingerprint or guard pin moves. Owner-only, like the 239 functions.
CREATE TABLE guard_verdicts (
 guard text PRIMARY KEY CHECK(guard IN('catalog_stock_control_guards','financial_return_guards','fa3_draft_guards')),
 generation bigint,
 basis_sha256 text CHECK(basis_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz,
 CHECK((generation IS NULL)=(basis_sha256 IS NULL) AND (generation IS NULL)=(verified_at IS NULL))
);
ALTER TABLE guard_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE guard_verdicts FORCE ROW LEVEL SECURITY;
INSERT INTO guard_verdicts(guard) VALUES('catalog_stock_control_guards'),('financial_return_guards'),('fa3_draft_guards');

-- Everything the three guards read that DDL does not version. The 16 tables and the shared catalogues are the union of
-- what each guard scans (pg_stat_xact_all_tables, pinned per guard by tests/guard-verdicts248.test.ts); a new row
-- version always has a new xmin, also in replica mode and also when the values are unchanged.
CREATE FUNCTION guard_verdict_basis() RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH tn AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname ~ '^pg_(toast_)?temp_[0-9]+$'),
 tc AS (SELECT oid FROM pg_catalog.pg_class WHERE relpersistence='t')
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'generation',(SELECT to_jsonb(g)||jsonb_build_object('ctid',g.ctid::text,'xmin',g.xmin::text) FROM public.ordinary182_runtime_generation g),
  'rows',jsonb_build_object(
   'b2b_credit_upgrade',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.b2b_credit_upgrade),
   'b2b_invoice_upgrade',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.b2b_invoice_upgrade),
   'buyer_address_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.buyer_address_manifest),
   'catalog_stock_control_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.catalog_stock_control_manifest),
   'catalog_stock_count_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.catalog_stock_count_manifest),
   'catalog_stock_legacy_group_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.catalog_stock_legacy_group_manifest),
   'catalog_stock_return_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.catalog_stock_return_manifest),
   'competitor_observation_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.competitor_observation_manifest),
   'credit_source_upgrade_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.credit_source_upgrade_certificate),
   'fa3_draft_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.fa3_draft_manifest),
   'financial_return_upgrade_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.financial_return_upgrade_certificate),
   'local_invoice_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.local_invoice_manifest),
   'manual_inventory_off_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.manual_inventory_off_certificate),
   'migrations',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.migrations),
   'order_merge_delivery209_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.order_merge_delivery209_manifest),
   'order_merge_delivery209_projection_basis',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.order_merge_delivery209_projection_basis)),
  -- Shared catalogues: ALTER ROLE, role grants, role settings and tablespaces fire no event trigger.
  'shared',jsonb_build_object(
   'pg_authid',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_authid),
   'pg_auth_members',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_auth_members),
   'pg_db_role_setting',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_db_role_setting),
   'pg_tablespace',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_tablespace)),
  -- Event trigger DDL fires no event trigger (the verdict also requires the three 182 ones as verdict241_ddl_intact() pins them).
  'event_triggers',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_event_trigger),
  -- Runtime TEMP DDL (182 admits relations, their triggers/constraints and types) moves no generation, and the
  -- catalogue scans of the guards see every session's TEMP rows.
  'temp',jsonb_build_object(
   'relations',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_class WHERE relpersistence='t'),
   'types',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_type WHERE typnamespace IN(SELECT oid FROM tn)),
   'attributes',(SELECT jsonb_agg(jsonb_build_array(attrelid::text,attnum,xmin::text) ORDER BY attrelid,attnum) FROM pg_catalog.pg_attribute WHERE attrelid IN(SELECT oid FROM tc)),
   'defaults',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_attrdef WHERE adrelid IN(SELECT oid FROM tc)),
   'triggers',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_trigger WHERE tgrelid IN(SELECT oid FROM tc)),
   'constraints',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM tc) OR connamespace IN(SELECT oid FROM tn)),
   'indexes',(SELECT jsonb_agg(jsonb_build_array(indexrelid::text,xmin::text) ORDER BY indexrelid) FROM pg_catalog.pg_index WHERE indrelid IN(SELECT oid FROM tc)),
   'rules',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_rewrite WHERE ev_class IN(SELECT oid FROM tc)),
   'policies',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_policy WHERE polrelid IN(SELECT oid FROM tc)),
   'sequences',(SELECT jsonb_agg(jsonb_build_array(seqrelid::text,xmin::text) ORDER BY seqrelid) FROM pg_catalog.pg_sequence WHERE seqrelid IN(SELECT oid FROM tc)),
   'comments',(SELECT jsonb_agg(jsonb_build_array(objoid::text,objsubid,xmin::text) ORDER BY objoid,objsubid) FROM pg_catalog.pg_description WHERE classoid='pg_catalog.pg_class'::regclass AND objoid IN(SELECT oid FROM tc))),
  -- Session state: the guards read role and session_replication_role, some compare session_user; output functions
  -- depend on these settings (the verdict itself sets only search_path, which every guard function sets too).
  'session',jsonb_build_object('session_user',session_user::text,'role',current_setting('role'),
   'settings',(SELECT jsonb_object_agg(n,current_setting(n,true)) FROM unnest(ARRAY['session_replication_role','TimeZone','DateStyle',
    'IntervalStyle','extra_float_digits','bytea_output','lc_monetary','lc_numeric','lc_time','quote_all_identifiers',
    'standard_conforming_strings','transform_null_equals','array_nulls','backslash_quote','row_security',
    'default_text_search_config','xmlbinary','xmloption','jit','plpgsql.variable_conflict','plpgsql.extra_errors',
    'plpgsql.check_asserts','event_triggers']) n)),
  -- 240/241: a function or a rule on the generation table swapped and restored while event triggers were off restores
  -- every content check, but not these row versions: a miss, and the full guard sees the state.
  'public_functions',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace),
  'generation_relation',jsonb_build_array(
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass),
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_trigger WHERE tgrelid='public.ordinary182_runtime_generation'::regclass),
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass))
 )::text,'UTF8')),'hex')
$$;

-- The full guard by name, from a fixed list only (no dynamic SQL).
CREATE FUNCTION guard_verdict_full(g text) RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 CASE g
  WHEN 'catalog_stock_control_guards' THEN RETURN public.catalog_stock_control_guards();
  WHEN 'financial_return_guards' THEN RETURN public.financial_return_guards();
  WHEN 'fa3_draft_guards' THEN RETURN public.fa3_draft_guards();
  ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='248 unknown guard';
 END CASE;
END $$;

CREATE FUNCTION guard_verdict(g text) RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.ordinary182_runtime_generation%ROWTYPE;seen public.guard_verdicts%ROWTYPE;b text;ok boolean;
BEGIN
 IF g IS NULL OR g NOT IN('catalog_stock_control_guards','financial_return_guards','fa3_draft_guards') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='248 unknown guard';
 END IF;
 -- Only READ COMMITTED re-reads the generation row and the basis after the fence below.
 IF current_setting('transaction_isolation')<>'read committed' THEN RETURN public.guard_verdict_full(g);END IF;
 SELECT * INTO v FROM public.ordinary182_runtime_generation WHERE singleton;
 IF NOT FOUND OR v.dirty OR v.validated_generation IS DISTINCT FROM v.generation THEN
  RETURN public.guard_verdict_full(g); -- no cold-approved schema: the full guard, as before 248
 END IF;
 -- Shared schema fence (ordinary182_require_generation): no owner DDL commits before this transaction ends.
 PERFORM pg_advisory_xact_lock_shared(982376);
 SELECT * INTO v FROM public.ordinary182_runtime_generation WHERE singleton;
 IF NOT FOUND OR v.dirty OR v.validated_generation IS DISTINCT FROM v.generation OR v.generation<1
  OR v.contract_id IS DISTINCT FROM 'ordinary182-cold-schema-runtime/v1'
  OR v.release_sha256 IS NULL OR v.release_sha256 !~ '^[a-f0-9]{64}$' OR v.native_sha256 IS NULL OR v.native_sha256 !~ '^[a-f0-9]{64}$'
  OR v.profile_native_sha256 IS NULL OR v.profile_native_sha256 !~ '^[a-f0-9]{64}$' THEN
  RETURN public.guard_verdict_full(g);
 END IF;
 -- 239/240: the generation is only a schema version while the three 182 event triggers fire. A disabled,
 -- replica-only, replaced, tagged or dropped one (or event_triggers=off here): the full guard, nothing recorded.
 IF current_setting('event_triggers',true) IS NOT DISTINCT FROM 'off' OR (SELECT count(*) FROM pg_catalog.pg_event_trigger e
  WHERE e.evtenabled='O' AND e.evttags IS NULL AND (
   (e.evtname='ordinary182_schema_ddl' AND e.evtevent='ddl_command_start' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_invalidate()'))
   OR (e.evtname='ordinary182_temp_ddl_end' AND e.evtevent='ddl_command_end' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_temp_ddl_end()'))
   OR (e.evtname='ordinary182_temp_drop' AND e.evtevent='sql_drop' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_temp_drop()'))))<>3 THEN
  RETURN public.guard_verdict_full(g);
 END IF;
 -- 241: the content behind those three triggers (an ALTER EVENT TRIGGER round trip restores their rows while the
 -- invalidator is neutered or a rule sits on the generation table), origin mode and event triggers on in this session,
 -- no persistent setting turning them off, no public shadow of a pg_catalog function/operator.
 IF public.verdict241_ddl_intact() IS DISTINCT FROM true THEN
  RETURN public.guard_verdict_full(g);
 END IF;
 -- The guard functions do not list pg_temp, so this session's TEMP relations and types are searched before
 -- public (types: before pg_catalog). Any of them: the full guard answers, nothing recorded.
 IF pg_catalog.pg_my_temp_schema()<>0 AND (
  EXISTS(SELECT FROM pg_catalog.pg_class WHERE relnamespace=pg_catalog.pg_my_temp_schema())
  OR EXISTS(SELECT FROM pg_catalog.pg_type WHERE typnamespace=pg_catalog.pg_my_temp_schema())) THEN
  RETURN public.guard_verdict_full(g);
 END IF;
 b:=public.guard_verdict_basis();
 SELECT * INTO seen FROM public.guard_verdicts WHERE guard=g;
 IF seen.generation=v.generation AND seen.basis_sha256=b THEN RETURN true;END IF;
 ok:=public.guard_verdict_full(g);
 -- Record only a true verdict whose basis did not move while the guard ran, only from a read-write
 -- transaction (READ COMMITTED above) and never by waiting for another recorder (SKIP LOCKED).
 IF ok AND current_setting('transaction_read_only')='off' AND public.guard_verdict_basis()=b
  -- 240: and no event trigger, ordinary182_ function or rule/trigger/row of the generation table was written after
  -- the generation row (an extra layer; a generation row older than 10^9 transactions records nothing either).
  AND (SELECT pg_catalog.age(x.xmin) FROM public.ordinary182_runtime_generation x WHERE x.singleton) BETWEEN 0 AND 1000000000
  AND NOT EXISTS(SELECT FROM (SELECT xmin FROM pg_catalog.pg_event_trigger
    UNION ALL SELECT xmin FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'ordinary182_')
    UNION ALL SELECT xmin FROM pg_catalog.pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass
    UNION ALL SELECT xmin FROM pg_catalog.pg_trigger WHERE tgrelid='public.ordinary182_runtime_generation'::regclass
    UNION ALL SELECT xmin FROM pg_catalog.pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass) w
   WHERE pg_catalog.age(w.xmin) BETWEEN 0 AND (SELECT pg_catalog.age(x.xmin) FROM public.ordinary182_runtime_generation x WHERE x.singleton)-1)
  -- 241: and the 182 machinery is still intact now that the guard has run.
  AND public.verdict241_ddl_intact() THEN
  PERFORM 1 FROM public.guard_verdicts WHERE guard=g FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
   UPDATE public.guard_verdicts SET generation=v.generation,basis_sha256=b,verified_at=clock_timestamp() WHERE guard=g;
  END IF;
 END IF;
 RETURN ok;
END $$;
REVOKE ALL ON TABLE guard_verdicts FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION guard_verdict_basis() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION guard_verdict_full(text) FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION guard_verdict(text) FROM PUBLIC,dyna_app;
