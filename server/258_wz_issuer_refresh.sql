-- Migration 258_wz_issuer_refresh (prepared as 273, registered after 257_order_merge_snapshot_index_paths; object names keep 273; docs/parity/WZ-ISSUER-GEN273-20261029.md).
-- The 239 WZ issuer verdict did not short-circuit the ship path under load because its record was stale, not because a
-- gate bypassed it: every release start (ordinary187_approve in each process) rewrites the generation row, which is part
-- of wz_issuer239_basis(). A stale record is healed only by a caller whose full warehouse_wz_issuer_guards() finishes and
-- whose transaction commits. On the ship path that caller is a request with an 8 s statement budget; under load the full
-- guard takes longer, is cancelled (57014) and records nothing, so every later ship-demo missed as well (load test
-- 28.10: 59 misses, 0 updates of the record, every guard cancelled).
--
-- 273 changes no sealed object and no answer:
--  * wz_issuer273_refresh(): owner-only, the TimeZone of wz_issuer239_prepare_skip() (the basis lists TimeZone), only in a
--    READ COMMITTED read-write transaction (elsewhere the verdict could not record: NULL), behind an advisory lock it
--    never waits for (another refresher: NULL), and then exactly wz_issuer239_verdict(). The TS callers run it in their own
--    transaction with the finite cold budget at startup and after a request's 57014.
--  * wz_issuer239_verdict(): the 241 body plus the 240 record guard of buyer_available236() and a relhasrules check on the
--    generation table. It refuses to record in more states, never to answer: the two hidden rule windows documented in
--    241 no longer give a stale true, also when window 1 comes from a transaction older than the cold approval.
-- No warehouse_wz_issuer_, warehouse_automatic_wz_, parcel_physical_wz_ or ordinary18x_ object is created or changed
-- (151 matches LIKE 'warehouse_wz_issuer_%', where _ is any character; wz_issuer273_ matches none of these).
CREATE OR REPLACE FUNCTION wz_issuer239_verdict() RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.ordinary182_runtime_generation%ROWTYPE;seen public.wz_issuer239_verdict%ROWTYPE;b text;ok boolean;
BEGIN
 -- Only READ COMMITTED re-reads the generation row and the basis after the fence below.
 IF current_setting('transaction_isolation')<>'read committed' THEN RETURN public.warehouse_wz_issuer_guards();END IF;
 SELECT * INTO v FROM public.ordinary182_runtime_generation WHERE singleton;
 IF NOT FOUND OR v.dirty OR v.validated_generation IS DISTINCT FROM v.generation THEN
  RETURN public.warehouse_wz_issuer_guards(); -- no cold-approved schema: the full guard, as before 239
 END IF;
 -- Shared schema fence (ordinary182_require_generation): no owner DDL commits before this transaction ends.
 PERFORM pg_advisory_xact_lock_shared(982376);
 SELECT * INTO v FROM public.ordinary182_runtime_generation WHERE singleton;
 IF NOT FOUND OR v.dirty OR v.validated_generation IS DISTINCT FROM v.generation OR v.generation<1
  OR v.contract_id IS DISTINCT FROM 'ordinary182-cold-schema-runtime/v1'
  OR v.release_sha256 IS NULL OR v.release_sha256 !~ '^[a-f0-9]{64}$' OR v.native_sha256 IS NULL OR v.native_sha256 !~ '^[a-f0-9]{64}$'
  OR v.profile_native_sha256 IS NULL OR v.profile_native_sha256 !~ '^[a-f0-9]{64}$' THEN
  RETURN public.warehouse_wz_issuer_guards();
 END IF;
 -- Security review 27.10: the generation is only a schema version while the three 182 event triggers fire. A
 -- disabled, replica-only or replaced one (or event_triggers=off here) changes the basis, but a miss must not
 -- re-baseline it: the full guard does not look at event triggers. Any such state: the full guard, nothing recorded.
 IF current_setting('event_triggers',true) IS NOT DISTINCT FROM 'off' OR (SELECT count(*) FROM pg_catalog.pg_event_trigger e
  WHERE e.evtenabled='O' AND e.evttags IS NULL AND (
   (e.evtname='ordinary182_schema_ddl' AND e.evtevent='ddl_command_start' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_invalidate()'))
   OR (e.evtname='ordinary182_temp_ddl_end' AND e.evtevent='ddl_command_end' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_temp_ddl_end()'))
   OR (e.evtname='ordinary182_temp_drop' AND e.evtevent='sql_drop' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_temp_drop()'))))<>3 THEN
  RETURN public.warehouse_wz_issuer_guards();
 END IF;
 -- 241: the content behind those three triggers, not only their pg_event_trigger rows. An ALTER EVENT TRIGGER round
 -- trip restores the rows while the invalidator is neutered or a rule sits on the generation table, and the miss would
 -- record the full guard's true over it (security review of 240, confirmed here). A caller in replica mode, or a
 -- persistent setting that turns event triggers off in other sessions, also makes the generation no schema version.
 -- Any of these: the full guard, nothing recorded (docs/parity/VERDICT-GATES241-20261027.md).
 IF public.verdict241_ddl_intact() IS DISTINCT FROM true THEN
  RETURN public.warehouse_wz_issuer_guards();
 END IF;
 -- The guard functions do not list pg_temp, so this session's TEMP relations and types are searched before
 -- public (types: before pg_catalog), also by explicit pg_temp. probes. Any of them: the full guard answers.
 IF pg_catalog.pg_my_temp_schema()<>0 AND (
  EXISTS(SELECT FROM pg_catalog.pg_class WHERE relnamespace=pg_catalog.pg_my_temp_schema())
  OR EXISTS(SELECT FROM pg_catalog.pg_type WHERE typnamespace=pg_catalog.pg_my_temp_schema())) THEN
  RETURN public.warehouse_wz_issuer_guards();
 END IF;
 b:=public.wz_issuer239_basis();
 SELECT * INTO seen FROM public.wz_issuer239_verdict WHERE singleton;
 IF seen.generation=v.generation AND seen.basis_sha256=b THEN RETURN true;END IF;
 ok:=public.warehouse_wz_issuer_guards();
 -- Record only a true verdict whose basis did not move while the guard ran, only from a read-write
 -- transaction (READ COMMITTED above) and never by waiting for another recorder (SKIP LOCKED).
 IF ok AND current_setting('transaction_read_only')='off' AND public.wz_issuer239_basis()=b
  -- 273: the 240 record guard of buyer_available236(), verbatim. No event trigger, ordinary182_ function or
  -- rule/trigger/row of the generation table was written after the generation row (the cold approval; DDL in between
  -- leaves it dirty). A rule created and dropped while event triggers were off sets relhasrules (a newer generation-table
  -- row): nothing is recorded until the next cold approval, so a second such window cannot hide behind a recorded basis
  -- (docs/parity/VERDICT-GATES241-20261027.md, two windows). Fail-safe: a generation row older than 10^9 transactions
  -- (age wraps at 2^31) records nothing either.
  AND (SELECT pg_catalog.age(g.xmin) FROM public.ordinary182_runtime_generation g WHERE g.singleton) BETWEEN 0 AND 1000000000
  AND NOT EXISTS(SELECT FROM (SELECT xmin FROM pg_catalog.pg_event_trigger
    UNION ALL SELECT xmin FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'ordinary182_')
    UNION ALL SELECT xmin FROM pg_catalog.pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass
    UNION ALL SELECT xmin FROM pg_catalog.pg_trigger WHERE tgrelid='public.ordinary182_runtime_generation'::regclass
    UNION ALL SELECT xmin FROM pg_catalog.pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass) w
   WHERE pg_catalog.age(w.xmin) BETWEEN 0 AND (SELECT pg_catalog.age(g.xmin) FROM public.ordinary182_runtime_generation g WHERE g.singleton)-1)
  -- 273 (security review): and no rule was put on the generation table since its last VACUUM. relhasrules stays true
  -- after DROP RULE; a window-1 transaction whose xid predates the cold approval leaves a pg_class row that the age
  -- guard above counts as older than the generation row.
  AND NOT (SELECT c.relhasrules FROM pg_catalog.pg_class c WHERE c.oid='public.ordinary182_runtime_generation'::regclass)
  -- 241: and the 182 machinery is still intact now that the guard has run.
  AND public.verdict241_ddl_intact() THEN
  PERFORM 1 FROM public.wz_issuer239_verdict WHERE singleton FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
   UPDATE public.wz_issuer239_verdict SET generation=v.generation,basis_sha256=b,verified_at=clock_timestamp() WHERE singleton;
  END IF;
 END IF;
 RETURN ok;
END $$;

CREATE FUNCTION wz_issuer273_refresh() RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 -- The verdict records only from a READ COMMITTED read-write transaction: anywhere else a refresh has nothing to do.
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RETURN NULL;END IF;
 -- One refresher at a time: the others return at once instead of running a second full guard (or waiting for one).
 IF NOT pg_catalog.pg_try_advisory_xact_lock(273,239) THEN RETURN NULL;END IF;
 RETURN public.wz_issuer239_verdict();
END $$;
REVOKE ALL ON FUNCTION wz_issuer239_verdict() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION wz_issuer273_refresh() FROM PUBLIC,dyna_app;
