-- Certified own-family portability successor. Preserve 163/164 files and all parents.
-- Root appends 165_competitor_observation_portability in this SAME owner transaction.
SET LOCAL TimeZone='UTC';
LOCK TABLE public.competitor_observation_manifest IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE competitor_observation_portability_basis ON COMMIT DROP AS
 SELECT to_jsonb(m) original_manifest,public.competitor_observation_fingerprint() predecessor_fingerprint,
 pg_current_xact_id()::text root_xid,transaction_timestamp() start_at,pg_backend_pid() backend_pid,current_user::text owner_name,
 NULL::jsonb predecessor_functions,NULL::jsonb predecessor_triggers,NULL::jsonb certificate
 FROM public.competitor_observation_manifest m;
REVOKE ALL ON pg_temp.competitor_observation_portability_basis FROM PUBLIC,dyna_app;
DO $$
DECLARE functions jsonb; expected_hashes jsonb:='{"competitor_observation_available":"a48ac8fe33588b7b4fc317c4c8c8e303bbb48fc81c46a24217161d04dda7a3bf","competitor_observation_complete":"887cca9418516522c5ad736b59d8edb06f52062f83be89ead868b9c2763c7593","competitor_observation_fingerprint":"ac1356982160955e490d130006f6f5a0d73f28343d78dfd5236e8adda51923f4","competitor_observation_guards":"f2bd683607433aeb40c4ccd7a185adb7c18ec45f812d11192e47ec934d9a4852","competitor_observation_identity":"f85516b1016ce888c4d8a1b74f6099301e6fb0f90aa6055ffbb9f9dd7d6bebf9","competitor_observation_immutable":"067fff6f8a7ab5569d03f157ab74ae71e9762d92bf655b58899c50b85ec452c7","competitor_observation_profile_guard":"bd61adc6b7fc19065442bfeeb64644b4f5937d5084edf7c032e2f9ebbd204597","competitor_observation_rank_terminal":"98c4333f885396e1161e4a0268c92bf1c52831b0d7f2251e026ae985a933efac","competitor_observation_rows_match_request":"434288d849bbbf27ebeaf1a4400ab33b196b9c8289639ab4b5723773fb47ba92","competitor_observation_terminal":"379399eb4aec1fcc097d55a6421e0eeaf78ff8ba24917aa9389d060a32839f55","competitor_observation_worker_identity":"8bec6824cf2423aee46f20ef8c76d027c0b209ceca63acb54f7aa7b7208a2bec","competitor_observation_worker_terminal":"be106f8be1ff3ca08e318d1a3f226a6dd48677cd72f6558c6f1bcc168f905b04"}'::jsonb; function_name text; owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid='public.competitor_observation_manifest'::regclass;
 IF current_user IS DISTINCT FROM owner_name OR session_user IS DISTINCT FROM owner_name OR current_setting('role') NOT IN('none',owner_name)
  OR NOT EXISTS(SELECT FROM public.migrations WHERE name='163_competitor_observations')
  OR NOT EXISTS(SELECT FROM public.migrations WHERE name='164_competitor_observation_batch_scale')
  OR EXISTS(SELECT FROM public.migrations WHERE name='165_competitor_observation_portability')
  OR EXISTS(SELECT FROM pg_attribute WHERE attrelid='public.competitor_observation_manifest'::regclass AND attname='portability_upgrade' AND NOT attisdropped)
  OR NOT public.competitor_observation_guards()
  OR (SELECT count(*) FROM pg_temp.competitor_observation_portability_basis)<>1
  OR EXISTS(SELECT FROM pg_temp.competitor_observation_portability_basis WHERE predecessor_fingerprint IS DISTINCT FROM original_manifest->>'fingerprint')
 THEN RAISE EXCEPTION '165 requires the exact valid owner-controlled 164 predecessor' USING ERRCODE='55000';END IF;
 functions:=(SELECT jsonb_object_agg(p.proname,jsonb_build_object('definition',pg_get_functiondef(p.oid),'body',p.prosrc,'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee=0,pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE'))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'competitor_observation%');
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(functions) keys(key)) IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected_hashes) keys(key)) THEN RAISE EXCEPTION '165 predecessor function inventory mismatch' USING ERRCODE='55000';END IF;
 FOR function_name IN SELECT jsonb_object_keys(expected_hashes) LOOP
  IF functions->function_name->>'body_sha256' IS DISTINCT FROM expected_hashes->>function_name THEN RAISE EXCEPTION '165 predecessor function body mismatch' USING ERRCODE='55000';END IF;
 END LOOP;
 UPDATE pg_temp.competitor_observation_portability_basis SET predecessor_functions=functions,predecessor_triggers=(SELECT jsonb_object_agg(t.tgname,pg_get_triggerdef(t.oid)) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'competitor_observation%');
END $$;
ALTER TABLE public.competitor_observation_manifest ADD COLUMN portability_upgrade jsonb CHECK(portability_upgrade IS NULL OR jsonb_typeof(portability_upgrade)='object');

CREATE OR REPLACE FUNCTION competitor_observation_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%' AND c.relkind IN('r','p')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',(SELECT collname FROM pg_collation WHERE oid=a.attcollation)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%' AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,'def',pg_get_constraintdef(c.oid,true),'validated',c.convalidated) ORDER BY t.relname,c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace AND t.relname LIKE 'competitor_observation%'),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',idx.relname,'def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY t.relname,idx.relname) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid WHERE t.relnamespace='public'::regnamespace AND t.relname LIKE 'competitor_observation%'),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND(t.tgname LIKE 'competitor_observation%' OR(c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%'))),
 'policies',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'competitor_observation%'),
 'app_role',(SELECT jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin) FROM pg_roles r WHERE rolname='dyna_app'),
 'app_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'select',has_table_privilege('dyna_app',c.oid,'SELECT'),'insert',has_table_privilege('dyna_app',c.oid,'INSERT'),'update',has_table_privilege('dyna_app',c.oid,'UPDATE'),'delete',has_table_privilege('dyna_app',c.oid,'DELETE')) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%' AND c.relkind IN('r','p'))
 )::text,'UTF8')),'hex')
$$;

CREATE OR REPLACE FUNCTION competitor_observation_guards() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE predecessor record; original jsonb; portability jsonb; actual_functions jsonb; saved_function jsonb; actual_function jsonb; function_name text; expected_hashes jsonb:='{"competitor_observation_available":"a48ac8fe33588b7b4fc317c4c8c8e303bbb48fc81c46a24217161d04dda7a3bf","competitor_observation_complete":"887cca9418516522c5ad736b59d8edb06f52062f83be89ead868b9c2763c7593","competitor_observation_fingerprint":"ac1356982160955e490d130006f6f5a0d73f28343d78dfd5236e8adda51923f4","competitor_observation_guards":"f2bd683607433aeb40c4ccd7a185adb7c18ec45f812d11192e47ec934d9a4852","competitor_observation_identity":"f85516b1016ce888c4d8a1b74f6099301e6fb0f90aa6055ffbb9f9dd7d6bebf9","competitor_observation_immutable":"067fff6f8a7ab5569d03f157ab74ae71e9762d92bf655b58899c50b85ec452c7","competitor_observation_profile_guard":"bd61adc6b7fc19065442bfeeb64644b4f5937d5084edf7c032e2f9ebbd204597","competitor_observation_rank_terminal":"98c4333f885396e1161e4a0268c92bf1c52831b0d7f2251e026ae985a933efac","competitor_observation_rows_match_request":"434288d849bbbf27ebeaf1a4400ab33b196b9c8289639ab4b5723773fb47ba92","competitor_observation_terminal":"379399eb4aec1fcc097d55a6421e0eeaf78ff8ba24917aa9389d060a32839f55","competitor_observation_worker_identity":"8bec6824cf2423aee46f20ef8c76d027c0b209ceca63acb54f7aa7b7208a2bec","competitor_observation_worker_terminal":"be106f8be1ff3ca08e318d1a3f226a6dd48677cd72f6558c6f1bcc168f905b04"}'::jsonb; manifest record; certificate jsonb; basis record; basis_relation oid; owner_name text; installed boolean;
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
  OR NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('public.competitor_observation_manifest') AND attname='portability_upgrade' AND NOT attisdropped)
 THEN RETURN false;END IF;
 IF(SELECT count(*) FROM public.competitor_observation_manifest)<>1 THEN RETURN false;END IF;
 SELECT * INTO manifest FROM public.competitor_observation_manifest;

 portability:=manifest.portability_upgrade; original:=portability->'original_manifest';
 IF jsonb_typeof(portability) IS DISTINCT FROM 'object' OR jsonb_typeof(original) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(portability) keys(key)) IS DISTINCT FROM ARRAY['original_manifest','predecessor_fingerprint','predecessor_functions','predecessor_triggers','profile','successor_fingerprint']::text[]
  OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(original) keys(key)) IS DISTINCT FROM ARRAY['fingerprint','installed_at','profile','scale_upgrade','singleton']::text[]
  OR portability->>'profile' IS DISTINCT FROM '164-original-to165-portable-constraints/v1'
  OR (to_jsonb(manifest)-'portability_upgrade') IS DISTINCT FROM original
  OR portability->>'predecessor_fingerprint' IS DISTINCT FROM original->>'fingerprint'
  OR NOT coalesce(portability->>'predecessor_fingerprint' ~ '^[a-f0-9]{64}$',false)
  OR portability->>'successor_fingerprint' IS DISTINCT FROM public.competitor_observation_fingerprint()
  OR jsonb_typeof(portability->'predecessor_functions') IS DISTINCT FROM 'object'
  OR jsonb_typeof(portability->'predecessor_triggers') IS DISTINCT FROM 'object'
 THEN RETURN false;END IF;
 actual_functions:=(SELECT jsonb_object_agg(p.proname,jsonb_build_object('definition',pg_get_functiondef(p.oid),'body',p.prosrc,'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee=0,pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE'))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'competitor_observation%');
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(actual_functions) keys(key)) IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected_hashes) keys(key))
  OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(portability->'predecessor_functions') keys(key)) IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected_hashes) keys(key))
  OR portability->'predecessor_triggers' IS DISTINCT FROM (SELECT jsonb_object_agg(t.tgname,pg_get_triggerdef(t.oid)) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'competitor_observation%')
 THEN RETURN false;END IF;
 FOR function_name IN SELECT jsonb_object_keys(expected_hashes) LOOP
  saved_function:=portability->'predecessor_functions'->function_name;
  actual_function:=actual_functions->function_name;
  IF jsonb_typeof(saved_function) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(saved_function) keys(key)) IS DISTINCT FROM ARRAY['acl','app_execute','body','body_sha256','definition','owner']::text[]
   OR saved_function->>'body_sha256' IS DISTINCT FROM expected_hashes->>function_name
   OR encode(sha256(convert_to(saved_function->>'body','UTF8')),'hex') IS DISTINCT FROM expected_hashes->>function_name
   OR (saved_function-'definition'-'body'-'body_sha256') IS DISTINCT FROM (actual_function-'definition'-'body'-'body_sha256')
  THEN RETURN false;END IF;
  IF function_name='competitor_observation_fingerprint' THEN
   IF replace(saved_function->>'body','pg_get_constraintdef(c.oid)','pg_get_constraintdef(c.oid,true)') IS DISTINCT FROM actual_function->>'body'
    OR replace(saved_function->>'definition','pg_get_constraintdef(c.oid)','pg_get_constraintdef(c.oid,true)') IS DISTINCT FROM actual_function->>'definition'
   THEN RETURN false;END IF;
  ELSIF function_name='competitor_observation_guards' THEN
   IF replace(actual_function->>'definition',actual_function->>'body',saved_function->>'body') IS DISTINCT FROM saved_function->>'definition' THEN RETURN false;END IF;
  ELSIF saved_function IS DISTINCT FROM actual_function THEN RETURN false;
  END IF;
 END LOOP;
 SELECT * INTO predecessor FROM jsonb_populate_record(NULL::public.competitor_observation_manifest,original);
 certificate:=predecessor.scale_upgrade;
 IF manifest.profile IS DISTINCT FROM 'local-explicit-observations/v1'
  OR manifest.singleton IS DISTINCT FROM true
  OR jsonb_typeof(certificate) IS DISTINCT FROM 'object'
  OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(certificate) AS certificate_keys(key)) IS DISTINCT FROM ARRAY['original_manifest','predecessor_fingerprint','predecessor_functions','predecessor_triggers','profile','successor_fingerprint']::text[]
  OR certificate->>'profile' IS DISTINCT FROM '163-original-to164-batch-scale/v1'
  OR certificate->'original_manifest' IS DISTINCT FROM jsonb_build_object('singleton',manifest.singleton,'profile',manifest.profile,'fingerprint',certificate->>'predecessor_fingerprint','installed_at',predecessor.installed_at)
  OR NOT coalesce(certificate->>'predecessor_fingerprint' ~ '^[a-f0-9]{64}$',false)
  OR certificate->>'successor_fingerprint' IS DISTINCT FROM predecessor.fingerprint
  OR certificate->'predecessor_functions'->'competitor_observation_complete'->>'body_sha256' IS DISTINCT FROM '887cca9418516522c5ad736b59d8edb06f52062f83be89ead868b9c2763c7593'
  OR certificate->'predecessor_functions'->'competitor_observation_immutable'->>'body_sha256' IS DISTINCT FROM '067fff6f8a7ab5569d03f157ab74ae71e9762d92bf655b58899c50b85ec452c7'
  OR certificate->'predecessor_functions'->'competitor_observation_guards'->>'body_sha256' IS DISTINCT FROM '6aa13d57a08fe6d62f150ec1a3ef5193833a665da2b9d10791c49f22681fea1f'
  OR certificate->'predecessor_functions'->'competitor_observation_complete'->>'definition' IS DISTINCT FROM pg_get_functiondef('public.competitor_observation_complete()'::regprocedure)
  OR certificate->'predecessor_functions'->'competitor_observation_immutable'->>'definition' IS DISTINCT FROM pg_get_functiondef('public.competitor_observation_immutable()'::regprocedure)
  OR certificate->'predecessor_triggers'->>'competitor_observation_batch_complete' IS DISTINCT FROM(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.competitor_observation_batches'::regclass AND tgname='competitor_observation_batch_complete' AND NOT tgisinternal)
  OR certificate->'predecessor_triggers'->>'competitor_observation_manifest_immutable' IS DISTINCT FROM(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.competitor_observation_manifest'::regclass AND tgname='competitor_observation_manifest_immutable' AND NOT tgisinternal)
  OR EXISTS(SELECT FROM pg_trigger WHERE NOT tgisinternal AND tgname='competitor_observation_rows_complete')
 THEN RETURN false;END IF;
 SELECT EXISTS(SELECT FROM public.migrations WHERE name='165_competitor_observation_portability') INTO installed;
 IF NOT EXISTS(SELECT FROM public.migrations WHERE name='164_competitor_observation_batch_scale') THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM public.migrations WHERE name='163_competitor_observations') THEN RETURN false;END IF;
 IF installed THEN RETURN true;END IF;
 -- Only the genuine owner transaction that captured the validated predecessor
 -- may verify before the managed migration loop appends the 165 ledger row.
 basis_relation:=to_regclass('pg_temp.competitor_observation_portability_basis');
 SELECT pg_get_userbyid(proowner) INTO owner_name FROM pg_proc WHERE oid='public.competitor_observation_guards()'::regprocedure;
 IF basis_relation IS NULL OR current_user IS DISTINCT FROM owner_name OR session_user IS DISTINCT FROM owner_name
  OR current_setting('role') NOT IN('none',owner_name)
  OR NOT EXISTS(SELECT FROM pg_class WHERE oid=basis_relation AND relkind='r' AND pg_get_userbyid(relowner)=owner_name)
 THEN RETURN false;END IF;
 EXECUTE 'SELECT count(*) count FROM pg_temp.competitor_observation_portability_basis' INTO basis;
 IF basis.count<>1 THEN RETURN false;END IF;
 EXECUTE 'SELECT * FROM pg_temp.competitor_observation_portability_basis' INTO basis;
 RETURN basis.root_xid IS NOT DISTINCT FROM pg_current_xact_id_if_assigned()::text
  AND basis.start_at IS NOT DISTINCT FROM transaction_timestamp()
  AND basis.backend_pid IS NOT DISTINCT FROM pg_backend_pid()
  AND basis.owner_name IS NOT DISTINCT FROM owner_name
  AND basis.original_manifest IS NOT DISTINCT FROM portability->'original_manifest'
  AND basis.predecessor_fingerprint IS NOT DISTINCT FROM portability->>'predecessor_fingerprint'
  AND basis.predecessor_functions IS NOT DISTINCT FROM portability->'predecessor_functions'
  AND basis.predecessor_triggers IS NOT DISTINCT FROM portability->'predecessor_triggers'
  AND basis.certificate IS NOT DISTINCT FROM portability;
END $$;

REVOKE ALL ON FUNCTION competitor_observation_guards() FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION competitor_observation_guards() TO dyna_app;
DO $$
DECLARE basis record; successor text; upgrade_certificate jsonb; immutable_definition text;
BEGIN
 SELECT * INTO basis FROM pg_temp.competitor_observation_portability_basis;
 successor:=public.competitor_observation_fingerprint();
 upgrade_certificate:=jsonb_build_object('profile','164-original-to165-portable-constraints/v1','original_manifest',basis.original_manifest,'predecessor_fingerprint',basis.predecessor_fingerprint,'predecessor_functions',basis.predecessor_functions,'predecessor_triggers',basis.predecessor_triggers,'successor_fingerprint',successor);
 UPDATE pg_temp.competitor_observation_portability_basis SET certificate=upgrade_certificate;
 immutable_definition:=basis.predecessor_triggers->>'competitor_observation_manifest_immutable';
 DROP TRIGGER competitor_observation_manifest_immutable ON public.competitor_observation_manifest;
 UPDATE public.competitor_observation_manifest SET portability_upgrade=upgrade_certificate;
 EXECUTE immutable_definition;
 IF NOT public.competitor_observation_guards() THEN RAISE EXCEPTION '165 successor metadata certification refused' USING ERRCODE='55000';END IF;
END $$;
-- No new persistent table, price/observation/profile mutation, parent metadata change,
-- or original scale_upgrade rewrite. Both original manifests remain in the chain.
