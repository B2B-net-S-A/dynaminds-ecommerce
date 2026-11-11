-- Migration 239_wz_issuer_verdict (docs/parity/WZ-ISSUER239-20261027.md): the hot-path answer to
-- warehouse_wz_issuer_guards() without re-running it (about 1.9 s) on every call. The sealed
-- warehouse_wz_issuer_prepare/_finish keep their own full require; the TS call sites ask this verdict.
--
-- The full guard is a function of the catalogue, of 21 sealed data tables it reads, of the shared
-- role/role-setting/tablespace catalogues and of session state. wz_issuer239_verdict() reuses its last
-- TRUE result only while
--  * the transaction is READ COMMITTED (a REPEATABLE READ snapshot may predate committed owner DDL),
--  * the 182 runtime generation is cold-approved (startup ran the full native predicates under the
--    exclusive 982376 fence) and any owner DDL since then would have made it dirty,
--  * this session has no TEMP relation or type (182 admits runtime TEMP DDL; pg_temp is searched first), and
--  * the basis is unchanged: the generation row, (ctid, xmin) of every row of the 21 tables and of the
--    shared catalogues, event triggers, every session's TEMP catalogue rows, session_user and the settings
--    the guard's output depends on.
-- Otherwise it runs warehouse_wz_issuer_guards() itself: the same answer. No warehouse_wz_issuer_,
-- warehouse_automatic_wz_ or parcel_physical_wz_ object is created or changed (151 matches its own
-- functions with LIKE 'warehouse_wz_issuer_%', where _ is any character), so every fingerprint stays sealed.
CREATE TABLE wz_issuer239_verdict (
 singleton boolean PRIMARY KEY CHECK(singleton),
 generation bigint,
 basis_sha256 text CHECK(basis_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz,
 CHECK((generation IS NULL)=(basis_sha256 IS NULL) AND (generation IS NULL)=(verified_at IS NULL))
);
ALTER TABLE wz_issuer239_verdict ENABLE ROW LEVEL SECURITY;
ALTER TABLE wz_issuer239_verdict FORCE ROW LEVEL SECURITY;
INSERT INTO wz_issuer239_verdict(singleton) VALUES(true);

-- Everything the full guard reads that DDL does not version. The 21 tables and four shared catalogues are
-- exactly those warehouse_wz_issuer_guards() scans (pg_stat_xact_all_tables, pinned by
-- tests/wz-issuer239.test.ts); a new row version always has a new xmin, also in replica mode.
CREATE FUNCTION wz_issuer239_basis() RETURNS text
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
    'plpgsql.check_asserts','event_triggers']) n))
 )::text,'UTF8')),'hex')
$$;

CREATE FUNCTION wz_issuer239_verdict() RETURNS boolean
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
 IF ok AND current_setting('transaction_read_only')='off' AND public.wz_issuer239_basis()=b THEN
  PERFORM 1 FROM public.wz_issuer239_verdict WHERE singleton FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
   UPDATE public.wz_issuer239_verdict SET generation=v.generation,basis_sha256=b,verified_at=clock_timestamp() WHERE singleton;
  END IF;
 END IF;
 RETURN ok;
END $$;

-- warehouse_wz_issuer_prepare() (168) runs warehouse_wz_issuer_require() first and returns NULL, without any
-- lock or write, when the shipment is already dispatched or no enabled configuration covers the source's
-- warehouses. This proves exactly that outcome with the same reads in the same order; false means "run the
-- sealed prepare", which then raises its own refusal (55000, 28000, 42501, 23514, P0002) or admits.
CREATE FUNCTION wz_issuer239_prepare_skip(uid uuid,kid uuid,src jsonb) RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;oid uuid:=(src->>'order_id')::uuid;sid uuid:=(src->>'shipment_id')::uuid;products jsonb;commercial jsonb;g jsonb;
BEGIN
 IF NOT public.wz_issuer239_verdict() THEN RETURN false;END IF;
 g:=public.warehouse_wz_issuer_access(uid,kid,false);
 IF g->'key_valid' IS DISTINCT FROM 'true'::jsonb OR g->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;
 IF src->>'kind' IS NULL OR src->>'kind' NOT IN('demo','shipping_plan','parcel') OR oid IS NULL OR sid IS NULL THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM public.shipments WHERE tenant_id=t AND id=sid AND order_id=oid AND dispatched_at IS NOT NULL) THEN RETURN true;END IF;
 IF src->>'kind'='parcel' THEN
  SELECT payload->'products',payload->'items' INTO products,commercial FROM public.order_parcel_allocations
   WHERE tenant_id=t AND plan_id=(src->>'plan_id')::uuid AND order_id=oid AND index=(src->>'parcel_index')::integer AND shipment_id=sid;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'warehouse_id',warehouse_id,'quantity',quantity) ORDER BY product_id),'[]') INTO products FROM public.reservations WHERE tenant_id=t AND order_id=oid AND state='active';
 END IF;
 IF products IS NULL THEN RETURN false;END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.warehouse_automatic_wz_configurations c WHERE c.tenant_id=t AND c.settings->>'enabled'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements(products) p WHERE p->>'warehouse_id'=c.warehouse_id::text));
END $$;
REVOKE ALL ON TABLE wz_issuer239_verdict FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION wz_issuer239_basis() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION wz_issuer239_verdict() FROM PUBLIC,dyna_app;
REVOKE ALL ON FUNCTION wz_issuer239_prepare_skip(uuid,uuid,jsonb) FROM PUBLIC,dyna_app;
