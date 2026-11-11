-- Versioned own-family upgrade from the accepted 163 SQL c000f23d144ddd21.
-- Root installs ledger 164_competitor_observation_batch_scale immediately after
-- this SQL in the SAME owner transaction. No parent metadata or price writes.
SET LOCAL TimeZone='UTC';
LOCK TABLE public.competitor_observation_manifest IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE competitor_observation_scale_basis ON COMMIT DROP AS
 SELECT to_jsonb(m) original_manifest,
  public.competitor_observation_fingerprint() predecessor_fingerprint,
  pg_current_xact_id()::text root_xid,transaction_timestamp() start_at,
  pg_backend_pid() backend_pid,current_user::text owner_name,
  NULL::jsonb predecessor_functions,NULL::jsonb predecessor_triggers,
  NULL::jsonb certificate
 FROM public.competitor_observation_manifest m;
REVOKE ALL ON pg_temp.competitor_observation_scale_basis FROM PUBLIC,dyna_app;
DO $$
DECLARE functions jsonb; triggers jsonb; owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='public.competitor_observation_manifest'::regclass;
 IF current_user IS DISTINCT FROM owner_name OR session_user IS DISTINCT FROM owner_name
  OR NOT EXISTS(SELECT FROM public.migrations WHERE name='163_competitor_observations')
  OR EXISTS(SELECT FROM public.migrations WHERE name='164_competitor_observation_batch_scale')
  OR NOT public.competitor_observation_guards()
  OR(SELECT count(*) FROM pg_temp.competitor_observation_scale_basis)<>1
  OR EXISTS(SELECT FROM pg_attribute WHERE attrelid='public.competitor_observation_manifest'::regclass AND attname='scale_upgrade' AND NOT attisdropped)
  OR to_regprocedure('public.competitor_observation_rows_match_request()') IS NOT NULL
  OR EXISTS(SELECT FROM pg_trigger WHERE tgname='competitor_observation_rows_match_request' AND NOT tgisinternal)
 THEN RAISE EXCEPTION '164 requires the exact installed owner-controlled 163 predecessor' USING ERRCODE='55000';END IF;
 SELECT jsonb_object_agg(p.proname,jsonb_build_object('definition',pg_get_functiondef(p.oid),'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))) INTO functions
 FROM pg_proc p WHERE p.oid IN('public.competitor_observation_complete()'::regprocedure,'public.competitor_observation_immutable()'::regprocedure,'public.competitor_observation_guards()'::regprocedure);
 IF functions->'competitor_observation_complete'->>'body_sha256' IS DISTINCT FROM '887cca9418516522c5ad736b59d8edb06f52062f83be89ead868b9c2763c7593'
  OR functions->'competitor_observation_immutable'->>'body_sha256' IS DISTINCT FROM '067fff6f8a7ab5569d03f157ab74ae71e9762d92bf655b58899c50b85ec452c7'
  OR functions->'competitor_observation_guards'->>'body_sha256' IS DISTINCT FROM '6aa13d57a08fe6d62f150ec1a3ef5193833a665da2b9d10791c49f22681fea1f'
 THEN RAISE EXCEPTION '164 predecessor function body mismatch' USING ERRCODE='55000';END IF;
 IF(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN('competitor_observation_rows_complete','competitor_observation_batch_complete','competitor_observation_manifest_immutable'))<>3
  OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.competitor_observations'::regclass AND tgname='competitor_observation_rows_complete' AND tgfoid='public.competitor_observation_complete()'::regprocedure AND tgtype=5 AND tgdeferrable AND tginitdeferred AND tgenabled='O' AND tgqual IS NULL AND tgnargs=0)
  OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.competitor_observation_batches'::regclass AND tgname='competitor_observation_batch_complete' AND tgfoid='public.competitor_observation_complete()'::regprocedure AND tgtype=5 AND tgdeferrable AND tginitdeferred AND tgenabled='O' AND tgqual IS NULL AND tgnargs=0)
  OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.competitor_observation_manifest'::regclass AND tgname='competitor_observation_manifest_immutable' AND tgfoid='public.competitor_observation_immutable()'::regprocedure AND tgtype=27 AND NOT tgdeferrable AND NOT tginitdeferred AND tgenabled='O' AND tgqual IS NULL AND tgnargs=0)
 THEN RAISE EXCEPTION '164 predecessor trigger mismatch' USING ERRCODE='55000';END IF;
 SELECT jsonb_object_agg(tgname,pg_get_triggerdef(oid)) INTO triggers FROM pg_trigger WHERE NOT tgisinternal AND tgname IN('competitor_observation_rows_complete','competitor_observation_batch_complete','competitor_observation_manifest_immutable');
 UPDATE pg_temp.competitor_observation_scale_basis SET predecessor_functions=functions,predecessor_triggers=triggers;
END $$;

ALTER TABLE public.competitor_observation_manifest ADD COLUMN scale_upgrade jsonb
 CHECK(scale_upgrade IS NULL OR jsonb_typeof(scale_upgrade)='object');
DROP TRIGGER competitor_observation_rows_complete ON public.competitor_observations;
CREATE FUNCTION competitor_observation_rows_match_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE unexpected boolean;
BEGIN
 WITH touched AS MATERIALIZED (
  SELECT DISTINCT tenant_id,price_list_id,batch_id FROM competitor_observation_new_rows
 ), expected AS MATERIALIZED (
  SELECT b.tenant_id,b.price_list_id,b.id batch_id,b.count batch_count,
   b.created_at batch_created_at,entry.ordinal::integer ordinal,entry.value
  FROM touched touched_batch JOIN public.competitor_observation_batches b
   ON(b.tenant_id,b.price_list_id,b.id)=(touched_batch.tenant_id,touched_batch.price_list_id,touched_batch.batch_id)
  CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(b.request->'observations')='array' THEN
    CASE WHEN jsonb_array_length(b.request->'observations') BETWEEN 1 AND 1000
     THEN b.request->'observations' ELSE '[]'::jsonb END
    ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS entry(value,ordinal)
 )
 SELECT EXISTS(
  SELECT FROM competitor_observation_new_rows inserted_row LEFT JOIN expected e
   ON(e.tenant_id,e.price_list_id,e.batch_id,e.ordinal)=
     (inserted_row.tenant_id,inserted_row.price_list_id,inserted_row.batch_id,inserted_row.ordinal)
  WHERE e.ordinal IS NULL OR inserted_row.ordinal>e.batch_count
   OR inserted_row.observed_at>e.batch_created_at
   OR e.value IS DISTINCT FROM jsonb_build_object(
    'product_id',inserted_row.product_id,'source_namespace',inserted_row.source_namespace,
    'offer_id',inserted_row.offer_id,'seller_id',inserted_row.seller_id,'currency',inserted_row.currency,
    'price_gross_minor',inserted_row.price_gross_minor::text,
    'delivery_gross_minor',inserted_row.delivery_gross_minor::text,
    'available',inserted_row.available,
    'observed_at',to_char(inserted_row.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
   )
 ) INTO unexpected;
 IF unexpected THEN RAISE EXCEPTION 'Observation rows differ from immutable batch request' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION competitor_observation_rows_match_request() FROM PUBLIC,dyna_app;
CREATE TRIGGER competitor_observation_rows_match_request AFTER INSERT ON public.competitor_observations
 REFERENCING NEW TABLE AS competitor_observation_new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION competitor_observation_rows_match_request();

-- Metadata-only, acyclic guard. The existing fingerprint includes the new column,
-- matcher and this body; certificate DATA is excluded from that fingerprint.
CREATE OR REPLACE FUNCTION competitor_observation_guards() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE manifest record; certificate jsonb; basis record; basis_relation oid; owner_name text; installed boolean;
BEGIN
 IF to_regclass('public.competitor_observation_manifest') IS NULL
  OR to_regclass('public.competitor_observation_batches') IS NULL
  OR to_regclass('public.competitor_observations') IS NULL
  OR to_regclass('public.migrations') IS NULL
  OR to_regprocedure('public.competitor_observation_fingerprint()') IS NULL
  OR to_regprocedure('public.competitor_observation_complete()') IS NULL
  OR to_regprocedure('public.competitor_observation_immutable()') IS NULL
  OR to_regprocedure('public.competitor_observation_rows_match_request()') IS NULL
  OR NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('public.competitor_observation_manifest') AND attname='scale_upgrade' AND NOT attisdropped)
 THEN RETURN false;END IF;
 IF(SELECT count(*) FROM public.competitor_observation_manifest)<>1 THEN RETURN false;END IF;
 SELECT * INTO manifest FROM public.competitor_observation_manifest;
 certificate:=manifest.scale_upgrade;
 IF manifest.profile IS DISTINCT FROM 'local-explicit-observations/v1'
  OR manifest.singleton IS DISTINCT FROM true
  OR jsonb_typeof(certificate) IS DISTINCT FROM 'object'
  OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(certificate) AS certificate_keys(key)) IS DISTINCT FROM ARRAY['original_manifest','predecessor_fingerprint','predecessor_functions','predecessor_triggers','profile','successor_fingerprint']::text[]
  OR certificate->>'profile' IS DISTINCT FROM '163-original-to164-batch-scale/v1'
  OR certificate->'original_manifest' IS DISTINCT FROM jsonb_build_object('singleton',manifest.singleton,'profile',manifest.profile,'fingerprint',certificate->>'predecessor_fingerprint','installed_at',manifest.installed_at)
  OR NOT coalesce(certificate->>'predecessor_fingerprint' ~ '^[a-f0-9]{64}$',false)
  OR certificate->>'successor_fingerprint' IS DISTINCT FROM manifest.fingerprint
  OR manifest.fingerprint IS DISTINCT FROM public.competitor_observation_fingerprint()
  OR certificate->'predecessor_functions'->'competitor_observation_complete'->>'body_sha256' IS DISTINCT FROM '887cca9418516522c5ad736b59d8edb06f52062f83be89ead868b9c2763c7593'
  OR certificate->'predecessor_functions'->'competitor_observation_immutable'->>'body_sha256' IS DISTINCT FROM '067fff6f8a7ab5569d03f157ab74ae71e9762d92bf655b58899c50b85ec452c7'
  OR certificate->'predecessor_functions'->'competitor_observation_guards'->>'body_sha256' IS DISTINCT FROM '6aa13d57a08fe6d62f150ec1a3ef5193833a665da2b9d10791c49f22681fea1f'
  OR certificate->'predecessor_functions'->'competitor_observation_complete'->>'definition' IS DISTINCT FROM pg_get_functiondef('public.competitor_observation_complete()'::regprocedure)
  OR certificate->'predecessor_functions'->'competitor_observation_immutable'->>'definition' IS DISTINCT FROM pg_get_functiondef('public.competitor_observation_immutable()'::regprocedure)
  OR certificate->'predecessor_triggers'->>'competitor_observation_batch_complete' IS DISTINCT FROM(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.competitor_observation_batches'::regclass AND tgname='competitor_observation_batch_complete' AND NOT tgisinternal)
  OR certificate->'predecessor_triggers'->>'competitor_observation_manifest_immutable' IS DISTINCT FROM(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.competitor_observation_manifest'::regclass AND tgname='competitor_observation_manifest_immutable' AND NOT tgisinternal)
  OR EXISTS(SELECT FROM pg_trigger WHERE NOT tgisinternal AND tgname='competitor_observation_rows_complete')
 THEN RETURN false;END IF;
 SELECT EXISTS(SELECT FROM public.migrations WHERE name='164_competitor_observation_batch_scale') INTO installed;
 IF NOT EXISTS(SELECT FROM public.migrations WHERE name='163_competitor_observations') THEN RETURN false;END IF;
 IF installed THEN RETURN true;END IF;
 -- Only the genuine owner transaction that captured the validated predecessor
 -- may verify before the managed migration loop appends the 164 ledger row.
 basis_relation:=to_regclass('pg_temp.competitor_observation_scale_basis');
 SELECT pg_get_userbyid(proowner) INTO owner_name FROM pg_proc WHERE oid='public.competitor_observation_guards()'::regprocedure;
 IF basis_relation IS NULL OR current_user IS DISTINCT FROM owner_name OR session_user IS DISTINCT FROM owner_name
  OR current_setting('role') NOT IN('none',owner_name)
  OR NOT EXISTS(SELECT FROM pg_class WHERE oid=basis_relation AND relkind='r' AND pg_get_userbyid(relowner)=owner_name)
 THEN RETURN false;END IF;
 EXECUTE 'SELECT count(*) count FROM pg_temp.competitor_observation_scale_basis' INTO basis;
 IF basis.count<>1 THEN RETURN false;END IF;
 EXECUTE 'SELECT * FROM pg_temp.competitor_observation_scale_basis' INTO basis;
 RETURN basis.root_xid IS NOT DISTINCT FROM pg_current_xact_id_if_assigned()::text
  AND basis.start_at IS NOT DISTINCT FROM transaction_timestamp()
  AND basis.backend_pid IS NOT DISTINCT FROM pg_backend_pid()
  AND basis.owner_name IS NOT DISTINCT FROM owner_name
  AND basis.original_manifest IS NOT DISTINCT FROM certificate->'original_manifest'
  AND basis.predecessor_fingerprint IS NOT DISTINCT FROM certificate->>'predecessor_fingerprint'
  AND basis.predecessor_functions IS NOT DISTINCT FROM certificate->'predecessor_functions'
  AND basis.predecessor_triggers IS NOT DISTINCT FROM certificate->'predecessor_triggers'
  AND basis.certificate IS NOT DISTINCT FROM certificate;
END $$;
-- CREATE OR REPLACE preserves the old guard's owner and ACL; state it explicitly.
REVOKE ALL ON FUNCTION competitor_observation_guards() FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION competitor_observation_guards() TO dyna_app;

DO $$
DECLARE basis record; successor text; upgrade_certificate jsonb; immutable_definition text;
BEGIN
 SELECT * INTO basis FROM pg_temp.competitor_observation_scale_basis;
 successor:=public.competitor_observation_fingerprint();
 upgrade_certificate:=jsonb_build_object('profile','163-original-to164-batch-scale/v1',
  'original_manifest',basis.original_manifest,'predecessor_fingerprint',basis.predecessor_fingerprint,
  'predecessor_functions',basis.predecessor_functions,'predecessor_triggers',basis.predecessor_triggers,
  'successor_fingerprint',successor);
 UPDATE pg_temp.competitor_observation_scale_basis SET certificate=upgrade_certificate;
 immutable_definition:=basis.predecessor_triggers->>'competitor_observation_manifest_immutable';
 DROP TRIGGER competitor_observation_manifest_immutable ON public.competitor_observation_manifest;
 UPDATE public.competitor_observation_manifest SET fingerprint=successor,scale_upgrade=upgrade_certificate;
 EXECUTE immutable_definition;
 IF NOT public.competitor_observation_guards() THEN RAISE EXCEPTION '164 successor metadata certification refused' USING ERRCODE='55000';END IF;
END $$;
-- No new public table, FK, parent trigger, observation/profile row or price edit.
-- Existing whole-batch complete() and batch_complete trigger are preserved.
