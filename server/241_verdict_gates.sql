-- Migration 241_verdict_gates (docs/parity/VERDICT-GATES241-20261027.md): content-based gates for the two cached
-- integrity verdicts, buyer_available236() (as 240 left it) and wz_issuer239_verdict() (239).
-- Both trust the 182 generation as a schema version, which holds only while the 182 machinery fires and writes it.
-- They checked the three event triggers' pg_event_trigger rows, and 240 refused to record over 182 machinery whose
-- xmin was newer than the generation row. xid order is not commit order: a transaction that took its xid before the
-- cold approval and committed after it (open, idle in transaction or prepared) could neuter ordinary182_invalidate()
-- or put a rule on the generation table during an ALTER EVENT TRIGGER round trip; the miss then recorded the full
-- guard's true and later owner DDL went unseen (security review of 240, reproduced for both verdicts). A forged
-- generation UPDATE laundered the same, a caller in replica mode was answered from the cache, and a persistent
-- ALTER ROLE/DATABASE ... SET event_triggers or session_replication_role fires no event trigger at all.
--
-- verdict241_ddl_intact() checks the content instead: this session's event_triggers and session_replication_role, no
-- such persistent setting for this database while it exists (a setting already reset leaves no trace: the documented
-- class of DDL in another session with event triggers off), exactly the three 182 event triggers as before, their
-- functions and the TEMP classifier exactly as ordinary182_valid() pins them (body sha256, header, owner,
-- configuration, ACL), the generation table as 182 pins it with no rule, policy or trigger of its own, and no public
-- function or comparison operator that could shadow a pg_catalog one these checks and the bases resolve. Both
-- verdicts call it before the TEMP check (false: the full guard answers, nothing recorded) and again just before
-- recording. The 240 xmin record guard stays as an extra layer for buyer_available236(). wz_issuer239_basis() gains
-- the 240 row versions (every public function, the generation table's pg_class/trigger/rule rows), so a function or
-- rule swapped and restored while event triggers were off is a miss for the WZ verdict too (security review of 241).
-- Everything else in the three functions is unchanged; no
-- buyer_address_, warehouse_wz_issuer_, warehouse_automatic_wz_, parcel_physical_wz_ or ordinary182_ object is
-- created or changed, so no fingerprint or guard pin moves. Owner-only, like the 239/236 basis functions.
CREATE FUNCTION verdict241_ddl_intact() RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT
  -- This session: event triggers on and origin mode (its own uncommitted DDL is otherwise unseen by the invalidator).
  current_setting('event_triggers',true) IS DISTINCT FROM 'off' AND current_setting('session_replication_role')='origin'
  -- No persistent setting that turns them off in later sessions of this database, while it exists (ALTER ROLE/DATABASE
  -- ... SET fires no event trigger).
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c(v)
   WHERE s.setdatabase IN(0,(SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname=current_database()))
    AND (strpos(lower(c.v),'event_triggers')>0 OR strpos(lower(c.v),'session_replication_role')>0))
  -- Exactly the three 182 event triggers (an extra one may run around them, e.g. at login or ddl_command_end), each
  -- origin-enabled, untagged, owned by postgres, on its expected event and function.
  AND (SELECT count(*) FROM pg_catalog.pg_event_trigger)=3
  AND (SELECT count(*) FROM pg_catalog.pg_event_trigger e WHERE e.evtenabled='O' AND e.evttags IS NULL AND pg_catalog.pg_get_userbyid(e.evtowner)='postgres' AND (
   (e.evtname='ordinary182_schema_ddl' AND e.evtevent='ddl_command_start' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_invalidate()'))
   OR (e.evtname='ordinary182_temp_ddl_end' AND e.evtevent='ddl_command_end' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_temp_ddl_end()'))
   OR (e.evtname='ordinary182_temp_drop' AND e.evtevent='sql_drop' AND e.evtfoid=pg_catalog.to_regprocedure('public.ordinary182_temp_drop()'))))=3
  -- Their functions and the TEMP classifier ordinary182_temp_ddl_end() calls, exactly as ordinary182_valid() pins them
  -- (body sha256, header, owner, configuration, ACL): a replaced body is seen whatever its xmin.
  AND EXISTS(SELECT FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.ordinary182_invalidate()') AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='36e95a42f9eb92117ce2f74fd8ffc3b7ae07ba0882c799f3c6eaa7c26c83c968' AND pg_get_function_result(p.oid)='event_trigger' AND pg_get_function_identity_arguments(p.oid)='' AND p.proargnames IS NOT DISTINCT FROM NULL::text[] AND p.proargmodes IS NULL AND p.pronargdefaults=0 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.procost=100 AND p.prorows=0 AND p.provolatile='v' AND l.lanname='plpgsql' AND p.proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC'] AND p.proargdefaults IS NULL AND (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)='[["postgres","postgres","EXECUTE",false]]'::jsonb)
  AND EXISTS(SELECT FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.ordinary182_temp_ddl_end()') AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='1287fd20b3324b2748e898b9551c1d432f8d95b76b7f4847854e42ffbe3ba0c3' AND pg_get_function_result(p.oid)='event_trigger' AND pg_get_function_identity_arguments(p.oid)='' AND p.proargnames IS NOT DISTINCT FROM NULL::text[] AND p.proargmodes IS NULL AND p.pronargdefaults=0 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.procost=100 AND p.prorows=0 AND p.provolatile='v' AND l.lanname='plpgsql' AND p.proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC'] AND p.proargdefaults IS NULL AND (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)='[["postgres","postgres","EXECUTE",false]]'::jsonb)
  AND EXISTS(SELECT FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.ordinary182_temp_drop()') AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='53308234d72f6a3e2ca8f048aa8c74df98898d8badd52eb6fe56e837fccedbb0' AND pg_get_function_result(p.oid)='event_trigger' AND pg_get_function_identity_arguments(p.oid)='' AND p.proargnames IS NOT DISTINCT FROM NULL::text[] AND p.proargmodes IS NULL AND p.pronargdefaults=0 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.procost=100 AND p.prorows=0 AND p.provolatile='v' AND l.lanname='plpgsql' AND p.proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC'] AND p.proargdefaults IS NULL AND (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)='[["postgres","postgres","EXECUTE",false]]'::jsonb)
  AND EXISTS(SELECT FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.ordinary182_is_temp_object(oid,oid)') AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='395c4580acd93dcdb2c77d8df55fdf11f90f801680eeea2a2b72981a4d3916c2' AND pg_get_function_result(p.oid)='boolean' AND pg_get_function_identity_arguments(p.oid)='class_id oid, object_id oid' AND p.proargnames IS NOT DISTINCT FROM ARRAY['class_id','object_id']::text[] AND p.proargmodes IS NULL AND p.pronargdefaults=0 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.procost=100 AND p.prorows=0 AND p.provolatile='s' AND l.lanname='plpgsql' AND p.proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC'] AND p.proargdefaults IS NULL AND (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)='[["postgres","postgres","EXECUTE",false]]'::jsonb)
  -- The generation table as 182 pins it, and nothing that rewrites or intercepts the invalidator's UPDATE: no rule
  -- (ordinary182_valid() does not look at pg_rewrite), no policy, no trigger of its own.
  AND EXISTS(SELECT FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.ordinary182_runtime_generation') AND relkind='r' AND pg_catalog.pg_get_userbyid(relowner)='postgres' AND relrowsecurity AND relforcerowsecurity AND relacl IS NOT NULL AND NOT EXISTS(SELECT FROM pg_catalog.aclexplode(relacl) a WHERE a.grantee<>relowner))
  AND (SELECT array_agg(attname::text||':'||pg_catalog.format_type(atttypid,atttypmod)||':'||attnotnull::text ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.ordinary182_runtime_generation') AND attnum>0 AND NOT attisdropped) IS NOT DISTINCT FROM ARRAY['singleton:boolean:true','generation:bigint:true','validated_generation:bigint:false','dirty:boolean:true','contract_id:text:false','release_sha256:text:false','native_sha256:text:false','profile_native_sha256:text:false']::text[]
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_rewrite WHERE ev_class=pg_catalog.to_regclass('public.ordinary182_runtime_generation'))
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_policy WHERE polrelid=pg_catalog.to_regclass('public.ordinary182_runtime_generation'))
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_trigger WHERE tgrelid=pg_catalog.to_regclass('public.ordinary182_runtime_generation') AND NOT tgisinternal)
  -- No public function named like a pg_catalog one and no public comparison/concatenation/arithmetic operator: with
  -- search_path pg_catalog,public an exact-type public overload wins over a pg_catalog candidate that needs a cast (e.g.
  -- public.convert_to(text,text) over pg_catalog.convert_to(text,name)) and could blind the pins above and the bases
  -- (security review of 241). These two checks use only qualified operators themselves.
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.pronamespace OPERATOR(pg_catalog.=) 'public'::regnamespace::oid
   AND EXISTS(SELECT FROM pg_catalog.pg_proc c WHERE c.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::regnamespace::oid AND c.proname OPERATOR(pg_catalog.=) p.proname))
  AND NOT EXISTS(SELECT FROM pg_catalog.pg_operator o WHERE o.oprnamespace OPERATOR(pg_catalog.=) 'public'::regnamespace::oid
   AND o.oprname OPERATOR(pg_catalog.=) ANY(ARRAY['=','<>','<','>','<=','>=','||','~','!~','~~','!~~','+','-']::name[]))
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
 -- 241: the content behind those three triggers, not only their pg_event_trigger rows. The record guard below orders
 -- by xid, not by commit: a transaction that took its xid before the cold approval and committed after it (open,
 -- idle in transaction or prepared) could neuter the invalidator or put a rule on the generation table unseen. A
 -- caller in replica mode, or a persistent setting that turns event triggers off in other sessions, also makes the
 -- generation no schema version. Any of these: the full guard, nothing recorded (docs/parity/VERDICT-GATES241-20261027.md).
 IF public.verdict241_ddl_intact() IS DISTINCT FROM true THEN
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
   WHERE pg_catalog.age(w.xmin) BETWEEN 0 AND (SELECT pg_catalog.age(g.xmin) FROM public.ordinary182_runtime_generation g WHERE g.singleton)-1)
  -- 241: and the 182 machinery is still intact now that the guard has run.
  AND public.verdict241_ddl_intact() THEN
  PERFORM 1 FROM public.buyer_available236_verdict WHERE singleton FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
   UPDATE public.buyer_available236_verdict SET generation=v.generation,basis_sha256=b,verified_at=clock_timestamp() WHERE singleton;
  END IF;
 END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION wz_issuer239_basis() RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH tn AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname ~ '^pg_(toast_)?temp_[0-9]+$'),
 tc AS (SELECT oid FROM pg_catalog.pg_class WHERE relpersistence='t')
 SELECT encode(sha256(convert_to(jsonb_build_object(
  -- Also its row version: an owner UPDATE that restores old values is a new generation basis too.
  'generation',(SELECT to_jsonb(g)||jsonb_build_object('ctid',g.ctid::text,'xmin',g.xmin::text) FROM public.ordinary182_runtime_generation g),
  'rows',jsonb_build_object(
   'b2b_credit_upgrade',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.b2b_credit_upgrade),
   'b2b_invoice_upgrade',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.b2b_invoice_upgrade),
   'buyer_address_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.buyer_address_manifest),
   'competitor_observation_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.competitor_observation_manifest),
   'cooperation171_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.cooperation171_certificate),
   'credit_source_upgrade_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.credit_source_upgrade_certificate),
   'fa3_draft_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.fa3_draft_manifest),
   'financial_return_upgrade_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.financial_return_upgrade_certificate),
   'local_invoice_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.local_invoice_manifest),
   'manual_inventory_off_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.manual_inventory_off_certificate),
   'migrations',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.migrations),
   'nested172_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.nested172_certificate),
   'operative_delivery_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.operative_delivery_certificate),
   'order_merge_delivery209_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.order_merge_delivery209_manifest),
   'order_merge_delivery209_projection_basis',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.order_merge_delivery209_projection_basis),
   'packed_label_print_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.packed_label_print_manifest),
   'parcel_physical_wz_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.parcel_physical_wz_certificate),
   'pim_dictionary_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.pim_dictionary_manifest),
   'warehouse_automatic_wz_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.warehouse_automatic_wz_manifest),
   'warehouse_wz_issuer_manifest',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.warehouse_wz_issuer_manifest),
   'wave_print177_certificate',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM public.wave_print177_certificate)),
  -- Shared catalogues: ALTER ROLE, role grants, role settings and tablespaces fire no event trigger.
  'shared',jsonb_build_object(
   'pg_authid',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_authid),
   'pg_auth_members',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_auth_members),
   'pg_db_role_setting',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_db_role_setting),
   'pg_tablespace',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_tablespace)),
  -- Event trigger DDL fires no event trigger (the verdict also requires the three 182 ones enabled).
  'event_triggers',(SELECT jsonb_agg(jsonb_build_array(ctid::text,xmin::text) ORDER BY ctid) FROM pg_catalog.pg_event_trigger),
  -- Runtime TEMP DDL (182 admits relations, their triggers/constraints and types) moves no generation, and the
  -- guard scans some names (e.g. parcel_physical_wz_ triggers) in every schema: every session's TEMP rows.
  'temp',jsonb_build_object(
   'relations',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_class WHERE relpersistence='t'),
   'types',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_type WHERE typnamespace IN(SELECT oid FROM tn)),
   'attributes',(SELECT jsonb_agg(jsonb_build_array(attrelid::text,attnum,xmin::text) ORDER BY attrelid,attnum) FROM pg_catalog.pg_attribute WHERE attrelid IN(SELECT oid FROM tc)),
   'defaults',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_attrdef WHERE adrelid IN(SELECT oid FROM tc)),
   'triggers',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_trigger WHERE tgrelid IN(SELECT oid FROM tc)),
   'constraints',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM tc) OR connamespace IN(SELECT oid FROM tn)),
   'indexes',(SELECT jsonb_agg(jsonb_build_array(indexrelid::text,xmin::text) ORDER BY indexrelid) FROM pg_catalog.pg_index WHERE indrelid IN(SELECT oid FROM tc)),
   'rules',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_rewrite WHERE ev_class IN(SELECT oid FROM tc)),
   'sequences',(SELECT jsonb_agg(jsonb_build_array(seqrelid::text,xmin::text) ORDER BY seqrelid) FROM pg_catalog.pg_sequence WHERE seqrelid IN(SELECT oid FROM tc)),
   'comments',(SELECT jsonb_agg(jsonb_build_array(objoid::text,objsubid,xmin::text) ORDER BY objoid,objsubid) FROM pg_catalog.pg_description WHERE classoid='pg_catalog.pg_class'::regclass AND objoid IN(SELECT oid FROM tc))),
  -- Session state: some guards require session_user=postgres and origin replication; output functions depend
  -- on these settings (the verdict itself sets only search_path, which every guard function sets too).
  'session',jsonb_build_object('session_user',session_user::text,'role',current_setting('role'),
   'settings',(SELECT jsonb_object_agg(n,current_setting(n,true)) FROM unnest(ARRAY['session_replication_role','TimeZone','DateStyle',
    'IntervalStyle','extra_float_digits','bytea_output','lc_monetary','lc_numeric','lc_time','quote_all_identifiers',
    'standard_conforming_strings','transform_null_equals','array_nulls','backslash_quote','row_security',
    'default_text_search_config','xmlbinary','xmloption','jit','plpgsql.variable_conflict','plpgsql.extra_errors',
    'plpgsql.check_asserts','event_triggers']) n)),
  -- 241: the 240 row versions too (security review of 241). A function or a rule on the generation table swapped and
  -- restored while event triggers were off (the invalidator neutered meanwhile) restores every content check, but
  -- not these xmins: a miss, and the full guard sees the state.
  'public_functions',(SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace),
  'generation_relation',jsonb_build_array(
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_class WHERE oid='public.ordinary182_runtime_generation'::regclass),
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_trigger WHERE tgrelid='public.ordinary182_runtime_generation'::regclass),
   (SELECT jsonb_agg(jsonb_build_array(oid::text,xmin::text) ORDER BY oid) FROM pg_catalog.pg_rewrite WHERE ev_class='public.ordinary182_runtime_generation'::regclass))
 )::text,'UTF8')),'hex')
$$;

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
  -- 241: and the 182 machinery is still intact now that the guard has run.
  AND public.verdict241_ddl_intact() THEN
  PERFORM 1 FROM public.wz_issuer239_verdict WHERE singleton FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
   UPDATE public.wz_issuer239_verdict SET generation=v.generation,basis_sha256=b,verified_at=clock_timestamp() WHERE singleton;
  END IF;
 END IF;
 RETURN ok;
END $$;
REVOKE ALL ON FUNCTION verdict241_ddl_intact() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION buyer_available236() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION buyer_available236() TO dyna_app;
REVOKE ALL ON FUNCTION wz_issuer239_basis() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION wz_issuer239_verdict() FROM PUBLIC,dyna_app;
