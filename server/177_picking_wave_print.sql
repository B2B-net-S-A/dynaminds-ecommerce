-- Compiled offline from exact canonical SQL129/156/167/172. Root installs once
-- through ordinary transaction runner only after isolated native acceptance.
SET LOCAL TimeZone='UTC';
DO $wave177$ BEGIN
 IF current_user IS DISTINCT FROM session_user OR
 current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='public.nested172_certificate'::regclass)
 OR public.pim_dictionary_valid() IS DISTINCT FROM true OR public.nested172_valid() IS DISTINCT FROM true
 OR public.operative_delivery_valid() IS DISTINCT FROM true
 OR EXISTS(SELECT FROM public.migrations WHERE name='177_picking_wave_print')
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_'))
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'wave_print177_'))
 OR to_regclass('public.picking_wave_print_assets') IS NOT NULL
 THEN RAISE EXCEPTION '177 requires intact172/167 owner and no successor remnants' USING ERRCODE='55000'; END IF;
END $wave177$;
-- Certificates are never rewritten. Fixed SHARE locks retain their original rows.
LOCK TABLE public.packed_label_print_manifest,public.buyer_address_manifest,public.operative_delivery_certificate,
 public.pim_dictionary_manifest,public.cooperation171_certificate,public.nested172_certificate IN SHARE MODE;
CREATE TEMP TABLE wave_print177_install_basis ON COMMIT DROP AS SELECT
 pg_current_xact_id()::text root_xid,transaction_timestamp() started_at,pg_backend_pid() backend_pid,current_user::text owner_name,
 jsonb_build_object('156',(SELECT to_jsonb(m) FROM public.packed_label_print_manifest m),'166',(SELECT to_jsonb(m) FROM public.buyer_address_manifest m),
 '167',(SELECT to_jsonb(m) FROM public.operative_delivery_certificate m),'170',(SELECT to_jsonb(m) FROM public.pim_dictionary_manifest m),
 '171',(SELECT to_jsonb(m) FROM public.cooperation171_certificate m),'172',(SELECT to_jsonb(m) FROM public.nested172_certificate m)) originals,
 (SELECT jsonb_object_agg(sig,public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) ORDER BY sig)
 FROM unnest(ARRAY['pim_dictionary_valid()','cooperation171_valid()','parcel_physical_wz_valid()','operative_delivery_valid()','nested172_valid()','packed_label_print_guards()','print_job_head(jsonb)','print_job_command(uuid,jsonb,uuid,uuid,text)','print_job_budget()','label_print_budget()']::text[]) names(sig) JOIN pg_proc p ON p.oid=to_regprocedure('public.'||sig)) functions_before,
 public.packed_label_print_fingerprint() packed_before,public.operative_delivery_fingerprint() operative_before;
REVOKE ALL ON pg_temp.wave_print177_install_basis FROM PUBLIC,dyna_app;
CREATE FUNCTION wave_print177_packed_metadata() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
 SELECT jsonb_build_object(
 'capture_trigger',(SELECT jsonb_build_object('definition',pg_get_triggerdef(g.oid),'enabled',g.tgenabled) FROM pg_trigger g WHERE g.tgrelid='packing_receipts'::regclass AND g.tgname='packed_label_print_capture' AND g.tgfoid='packed_label_print_capture_trigger()'::regprocedure),'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',x.attname,'type',format_type(x.atttypid,x.atttypmod),'notnull',x.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'acl',(SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(z.grantor),'grantee',CASE WHEN z.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(z.grantee) END,'privilege',z.privilege_type,'grantable',z.is_grantable) ORDER BY pg_get_userbyid(z.grantor),CASE WHEN z.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(z.grantee) END,z.privilege_type,z.is_grantable) FROM aclexplode(x.attacl) z)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'valid',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid),'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',g.tgname,'definition',pg_get_triggerdef(g.oid),'enabled',g.tgenabled) ORDER BY g.tgname) FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.oid=ANY(ARRAY['packed_label_print_previews','packed_label_print_configurations','packed_label_print_intents','packed_label_print_admissions','packed_label_print_manifest','print_printers','print_jobs','print_job_events','print_label_assets','print_label_previews','print_job_label_sources','packing_stations','packing_cartons','packing_policies','packing_sessions','packing_operations','packing_previews','packing_receipts','order_packing_profiles']::regclass[])),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'def',pg_get_functiondef(p.oid),'acl',(SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) ORDER BY p.proname,p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY['packed_label_print_require', 'packed_label_print_configuration_frame', 'packed_label_print_preview', 'packed_label_print_approve', 'packed_label_print_capture', 'packed_label_print_resolve_frame', 'packed_label_print_admit', 'packed_label_print_queue_allowed', 'packed_label_print_finish', 'packed_label_print_complete', 'packed_label_print_immutable', 'label_print_queue', 'label_print_guard', 'packed_label_print_capture_trigger', 'print_job_installed', 'print_job_access', 'print_job_require', 'print_job_hash', 'print_job_head', 'print_job_printer_head', 'print_job_lock', 'print_job_budget', 'print_job_content_valid', 'print_job_replay', 'print_job_event', 'print_job_printer_write', 'print_job_create', 'print_job_command', 'print_job_content', 'print_job_immutable', 'print_job_guard', 'print_job_complete', 'print_job_guards', 'label_print_installed', 'label_print_require', 'label_print_frame', 'label_print_configuration', 'label_print_preview_replay', 'label_print_store_preview', 'label_print_asset', 'label_print_queue_replay', 'label_print_budget', 'label_print_immutable', 'label_print_budget_trigger', 'label_print_seal', 'label_print_guards', 'packing_current_role', 'packing_key_grant', 'packing_operator_names', 'packing_fulfillment_snapshot', 'packing_fulfillment_hash', 'packing_row_guard', 'packing_budget_guard', 'packing_receipt_after_guard', 'packing_insert_admission', 'packing_scope_guard', 'packing_update_admission'])) )
$wave177$;
CREATE FUNCTION wave_print177_operative_metadata() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
 SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_') AND c.relkind IN('r','p')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',(SELECT collname FROM pg_collation WHERE oid=a.attcollation)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,'def',pg_get_constraintdef(c.oid,true),'validated',c.convalidated) ORDER BY t.relname,c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'operative_delivery_')),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',idx.relname,'def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY t.relname,idx.relname) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'operative_delivery_')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND(starts_with(t.tgname,'operative_delivery_') OR(c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_')))),
 'policies',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'operative_delivery_')),
 'app_role',(SELECT jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin) FROM pg_roles r WHERE rolname='dyna_app'),
 'app_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'select',has_table_privilege('dyna_app',c.oid,'SELECT'),'insert',has_table_privilege('dyna_app',c.oid,'INSERT'),'update',has_table_privilege('dyna_app',c.oid,'UPDATE'),'delete',has_table_privilege('dyna_app',c.oid,'DELETE')) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'operative_delivery_') AND c.relkind IN('r','p'))
 )
$wave177$;
ALTER TABLE pg_temp.wave_print177_install_basis ADD COLUMN packed_metadata jsonb;
UPDATE pg_temp.wave_print177_install_basis SET packed_metadata=public.wave_print177_packed_metadata();
CREATE TABLE public.wave_print177_certificate(
 singleton boolean PRIMARY KEY CHECK(singleton),profile text NOT NULL CHECK(profile='172-to177-full-wave-print/v1'),
 originals jsonb NOT NULL CHECK(jsonb_typeof(originals)='object'),functions_before jsonb NOT NULL CHECK(jsonb_typeof(functions_before)='object'),
 packed_metadata jsonb NOT NULL CHECK(jsonb_typeof(packed_metadata)='object'),
 packed_before text NOT NULL CHECK(packed_before~'^[a-f0-9]{64}$'),operative_before text NOT NULL CHECK(operative_before~'^[a-f0-9]{64}$'),
 metadata_after jsonb NOT NULL CHECK(jsonb_typeof(metadata_after)='object'),created_at timestamptz NOT NULL CHECK(isfinite(created_at)));
REVOKE ALL ON public.wave_print177_certificate FROM PUBLIC,dyna_app;

-- DATA-ONLY historical interpretations; their callers validate the complete live
-- successor first. They are private and never an IAM/admission substitute.
CREATE FUNCTION wave_print177_history_function_metadata(o oid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
 SELECT coalesce((SELECT (functions_before->(o::regprocedure::text))-'body' FROM public.wave_print177_certificate WHERE singleton),public.pim_dictionary_function_metadata(o))
$wave177$;
CREATE FUNCTION wave_print177_history_complete_metadata(o oid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
 SELECT coalesce((SELECT functions_before->(o::regprocedure::text) FROM public.wave_print177_certificate WHERE singleton),
 public.pim_dictionary_function_metadata(o)||(SELECT jsonb_build_object('body',prosrc) FROM pg_proc WHERE oid=o))
$wave177$;
CREATE FUNCTION wave_print177_history_map(v jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE x record;b jsonb;r jsonb:=v; BEGIN
 FOR x IN SELECT key,value FROM jsonb_each(v) LOOP
 SELECT functions_before->(CASE WHEN x.key~'\(' THEN x.key ELSE x.key||'()' END) INTO b FROM public.wave_print177_certificate WHERE singleton;
 IF b IS NOT NULL THEN r:=jsonb_set(r,ARRAY[x.key],CASE WHEN x.value?'body' THEN b ELSE b-'body' END); END IF;
 END LOOP; RETURN r;
END $wave177$;
-- SQL167 has an independent descriptor shape (ACL arrays, no PIM signatures).
-- Preserve every live entry except the one exact changed guard. Its original
-- descriptor comes from the locked original167 certificate, never a new map.
CREATE FUNCTION wave_print177_history_operative_functions() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE r jsonb:=public.operative_delivery_functions();b jsonb;BEGIN
 SELECT originals->'167'->'successor_functions'->'packed_label_print_guards' INTO STRICT b FROM public.wave_print177_certificate WHERE singleton;
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR NOT(r?'packed_label_print_guards') THEN RAISE EXCEPTION '177 original167 function binding' USING ERRCODE='55000';END IF;
 RETURN jsonb_set(r,'{packed_label_print_guards}',b,false);
END $wave177$;
CREATE FUNCTION wave_print177_history_metadata(v jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE f jsonb;b jsonb;arr jsonb:='[]';sig text;BEGIN
 FOR f IN SELECT value FROM jsonb_array_elements(v->'functions') LOOP
 sig:=coalesce(f->>'signature',f->>'name'); IF sig!~'\(' THEN sig:=sig||'()';END IF;
 SELECT functions_before->sig INTO b FROM public.wave_print177_certificate WHERE singleton;
 IF b IS NOT NULL THEN
 IF f?'signature' THEN f:=b-'body'; ELSE f:=jsonb_set(f,ARRAY['def'],b->'definition');END IF; END IF;
 arr:=arr||jsonb_build_array(f);
 END LOOP;RETURN jsonb_set(v,'{functions}',arr);
END $wave177$;
CREATE FUNCTION wave_print177_history_fingerprint(family text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE r text;BEGIN
 IF family NOT IN('packed','operative') THEN RAISE EXCEPTION '177 historical family' USING ERRCODE='55000';END IF;
 SELECT CASE WHEN family='packed' THEN packed_before ELSE operative_before END INTO STRICT r FROM public.wave_print177_certificate WHERE singleton;RETURN r;
END $wave177$;
CREATE FUNCTION wave_print177_history_nested172_historical171_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $nested172$
DECLARE c public.cooperation171_certificate;sig text;b jsonb;a jsonb;live jsonb;pred jsonb;r oid;
 expected_before jsonb:=$bodymap171${"parcel_physical_wz_terminal_prepare()":"47a44cb1bf9da5762a72965f89658fc9a9cde38a28c60a4cd4cda6662e8f18cb","parcel_physical_wz_valid()":"5b45c698ac39ef9cc217c9d721b9adb96242fdd360681bd74036f6bb7215bcbb","pim_dictionary_valid()":"d1b62c7f01376ee904327b69a7a8aea60b5530c7fbcac6d6fb87e7cdedd4e06c"}$bodymap171$::jsonb;
 expected_after jsonb:=$bodymap171${"parcel_physical_wz_terminal_prepare()":"7babdec6465f9fa8279fd24575531673028c7e1c550bfabe11d74ed19ce65db1","parcel_physical_wz_valid()":"bf2a1c9b3dee0fe87da6eba69920bfa42a6b33c65732fd77a7e6af6198987a75","pim_dictionary_valid()":"28ca41934632980b2f0c4e8387ab2aab0b77cf473d59031c5a8b2b2d6c80ae84"}$bodymap171$::jsonb;
BEGIN
 IF current_setting('session_replication_role')<>'origin' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.cooperation171_function_map()')) IS DISTINCT FROM 'bd023956225b12dc40cc7f0e44c76d9c27699832791627ecb03143faa03691e2' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_function_metadata(oid)')) IS DISTINCT FROM '0c28eea2eb88f0580540770447c3c5173657ee31f651e590e8e7985637e83f7d' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_acl_metadata(aclitem[])')) IS DISTINCT FROM '62f4174d660b9cda131e7f14c9227bc9b3798fa02c74a7c435280957e40ca8ec' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_metadata()')) IS DISTINCT FROM '5d88f934c1a50690c6b7d4ca65f63149b3c44c8d1f95d7b94bc99b919a9b6044' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_hash(jsonb)')) IS DISTINCT FROM '1c04aa00bc03107172b20fa2062483225222e72c7359c34ba29740294fa84502' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_fingerprint()')) IS DISTINCT FROM '7f2ef6dbab3e3797cf6ec21cb66e4fe378adfe7881494f9ca5233132d9e6b3d5' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_predecessor_metadata()')) IS DISTINCT FROM 'd87c40d718b01e962ba9f0520073793f2398bc704a1c8434edf28f48b59391fc' THEN RETURN false;END IF;
 IF(SELECT count(*) FROM public.cooperation171_certificate)<>1
 OR(SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'cooperation171_')) IS DISTINCT FROM ARRAY['cooperation171_certificate_seal()','cooperation171_function_map()','cooperation171_metadata()','cooperation171_physical_metadata()','cooperation171_project_metadata(jsonb,jsonb,boolean)','cooperation171_public_drain()','cooperation171_valid()']::text[]
 OR(SELECT array_agg(cl.relname::text ORDER BY cl.relname) FROM pg_class cl WHERE cl.relnamespace='public'::regnamespace AND starts_with(cl.relname,'cooperation171_') AND cl.relkind IN('r','p','v','m','S','f')) IS DISTINCT FROM ARRAY['cooperation171_certificate']::text[] THEN RETURN false;END IF;
 SELECT * INTO c FROM public.cooperation171_certificate WHERE singleton;
 IF c.profile<>'168+170-original-to171-cooperative-public-constraints/v1'
 OR c.original168 IS DISTINCT FROM(SELECT to_jsonb(x) FROM public.parcel_physical_wz_certificate x)
 OR c.original170 IS DISTINCT FROM(SELECT to_jsonb(x) FROM public.pim_dictionary_manifest x)
 OR c.module_functions IS DISTINCT FROM public.nested172_project_metadata(public.wave_print177_history_map(public.cooperation171_function_map()),'function_map')
 OR c.module_fingerprint IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_project_metadata(public.wave_print177_history_metadata(public.cooperation171_metadata()),'cooperation'))
 OR c.original168->'original151_manifest' IS DISTINCT FROM(SELECT to_jsonb(x) FROM public.warehouse_wz_issuer_manifest x)
 OR c.original168->'original167_certificate' IS DISTINCT FROM(SELECT to_jsonb(x) FROM public.operative_delivery_certificate x)
 OR c.original168->>'successor151_fingerprint' IS DISTINCT FROM public.warehouse_wz_issuer_fingerprint()
 OR c.original168->'predecessor_triggers' IS DISTINCT FROM public.parcel_physical_wz_predecessor_triggers()
 OR c.original168->'successor_functions' IS DISTINCT FROM public.parcel_physical_wz_predecessor_functions()
 OR c.original168->>'own_fingerprint' IS DISTINCT FROM public.pim_dictionary_hash(c.physical_before)
 OR c.original170->>'fingerprint' IS DISTINCT FROM public.pim_dictionary_hash(c.pim_before)
 OR c.original170->'predecessors' IS DISTINCT FROM c.predecessor_before
 THEN RETURN false;END IF;
 IF(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(c.functions_before) keys(key)) IS DISTINCT FROM ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']::text[]
 OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(c.functions_after) keys(key)) IS DISTINCT FROM ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']::text[] THEN RETURN false;END IF;
 FOR sig IN SELECT key FROM jsonb_object_keys(expected_before) keys(key) LOOP
  b:=c.functions_before->sig;a:=c.functions_after->sig;
  live:=public.nested172_legacy_function(sig);
  IF live IS DISTINCT FROM a OR (b-'body'-'definition') IS DISTINCT FROM(a-'body'-'definition')
  OR replace(a->>'definition',a->>'body',b->>'body') IS DISTINCT FROM b->>'definition'
  OR encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM expected_before->>sig
  OR encode(sha256(convert_to(a->>'body','UTF8')),'hex') IS DISTINCT FROM expected_after->>sig THEN RETURN false;END IF;
 END LOOP;
 IF public.cooperation171_project_metadata(public.nested172_project_metadata(public.wave_print177_history_metadata(public.cooperation171_physical_metadata()),'physical'),c.functions_before,true) IS DISTINCT FROM c.physical_before
 OR public.cooperation171_project_metadata(public.nested172_project_metadata(public.wave_print177_history_metadata(public.pim_dictionary_metadata()),'pim'),c.functions_before,false) IS DISTINCT FROM c.pim_before
 OR c.successor168_fingerprint IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_project_metadata(public.wave_print177_history_metadata(public.cooperation171_physical_metadata()),'physical'))
 OR c.successor170_fingerprint IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_project_metadata(public.wave_print177_history_metadata(public.pim_dictionary_metadata()),'pim')) THEN RETURN false;END IF;
 pred:=public.nested172_project_metadata(public.wave_print177_history_map(public.pim_dictionary_predecessor_metadata()),'predecessors');
 IF(SELECT count(*) FROM jsonb_object_keys(pred))<>25 OR EXISTS(SELECT FROM jsonb_each(pred) x(name,value) WHERE value='null'::jsonb)
 OR jsonb_set(pred,'{parcel_physical_wz_valid}',(c.functions_before->'parcel_physical_wz_valid()')-'body') IS DISTINCT FROM c.predecessor_before THEN RETURN false;END IF;
 -- Metadata-only leaf: never invoke full predecessor/PIM/physical/warehouse guards.
 IF EXISTS(SELECT FROM public.migrations WHERE name='171_pim_physical_cooperation') THEN RETURN true;END IF;
 r:=to_regclass('pg_temp.cooperation171_install_basis');IF r IS NULL THEN RETURN false;END IF;
 IF current_user IS DISTINCT FROM session_user OR NOT EXISTS(SELECT FROM pg_class cl WHERE cl.oid=r AND cl.relpersistence='t' AND cl.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT EXISTS(SELECT FROM aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) acl WHERE acl.grantee<>cl.relowner))
 OR(SELECT count(*) FROM pg_temp.cooperation171_install_basis)<>1 THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM pg_temp.cooperation171_install_basis x WHERE x.root_xid=pg_current_xact_id()::text AND x.start_at=transaction_timestamp() AND x.backend_pid=pg_backend_pid() AND x.owner_name=current_user AND x.original168=c.original168 AND x.original170=c.original170 AND x.physical_before=c.physical_before AND x.pim_before=c.pim_before AND x.predecessor_before=c.predecessor_before AND x.functions_before=c.functions_before);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $nested172$;
CREATE FUNCTION wave_print177_history_nested172_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $nested172$
DECLARE c public.nested172_certificate;sig text;b jsonb;a jsonb;live jsonb;r oid;pos integer;expected_body text;leaf_hash text;props jsonb;catalog_function record;owner_oid oid;
 expected_before jsonb:=$maps172${"cooperation171_valid()":"78d0a9370e952f558e103e17ecce97e597fb49c30388146a9272d33c91ea551c","parcel_physical_wz_valid()":"bf2a1c9b3dee0fe87da6eba69920bfa42a6b33c65732fd77a7e6af6198987a75","pim_dictionary_source_json_valid(jsonb)":"a1f31014172bd11735bf7987a4e6c95ae3fc92e00e0e57becd9783cd63c044ce","pim_dictionary_valid()":"28ca41934632980b2f0c4e8387ab2aab0b77cf473d59031c5a8b2b2d6c80ae84"}$maps172$::jsonb;
 expected_prefix text:=$prefix172$
 -- Explicit successor172: independent current metadata + bounded semantic certificate.
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'nested172_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json') THEN
  IF to_regclass('public.nested172_certificate') IS NULL OR to_regprocedure('public.nested172_valid()') IS NULL THEN RETURN false;END IF;
  IF(SELECT count(*) FROM public.nested172_certificate)<>1
  OR (SELECT functions FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.nested172_function_map()
  OR (SELECT metadata_hash FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_metadata())
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_function_map()'::regprocedure) IS DISTINCT FROM '453e0ed82a069fba0822490c818c2e2d3b6e29f8bb62a0e608ce10df7b2b4e16'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_metadata()'::regprocedure) IS DISTINCT FROM '5cbd5d4c412d66d0bd355bdf11c1b8726ea5f4954da23adcb654858d0d9ab1e1'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_valid()'::regprocedure) IS DISTINCT FROM '@VALID_SHA@'
  OR public.nested172_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
@ANCESTORS@
  RETURN true;
 END IF;
$prefix172$;
 expected_helpers jsonb:=$helperprops172${"nested172_function_map()":{"body_sha256":"453e0ed82a069fba0822490c818c2e2d3b6e29f8bb62a0e608ce10df7b2b4e16","language":"sql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"jsonb"},"nested172_metadata()":{"body_sha256":"5cbd5d4c412d66d0bd355bdf11c1b8726ea5f4954da23adcb654858d0d9ab1e1","language":"sql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"jsonb"},"nested172_json_valid(jsonb)":{"body_sha256":"c7ade40cb5364ffcc2e4d41046dec98b0bc12491dcf58ee80b0e06e9e6d22c67","language":"plpgsql","volatility":"i","security_definer":false,"configuration":["search_path=pg_catalog,public"],"argument_names":["tree"],"result":"boolean"},"nested172_legacy_function(text)":{"body_sha256":"dd6daca64315c5a0e10a16ed2b461d7ee789afd9014a88e1e9f3d764f7028070","language":"sql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public"],"argument_names":["sig"],"result":"jsonb"},"nested172_project_metadata(jsonb,text)":{"body_sha256":"bbc7b65aab433aaf227c5c477b34a721aec26e984af727d8657eb6ac517ebc0f","language":"plpgsql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public"],"argument_names":["actual","family"],"result":"jsonb"},"nested172_historical171_valid()":{"body_sha256":"cbd07394957d31370ec788d5cb6cf1ca72c37ca950c934d57d45d69ecc12933a","language":"plpgsql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"boolean"},"nested172_valid()":{"body_sha256":null,"language":"plpgsql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"boolean"},"nested172_certificate_seal()":{"body_sha256":"6a2e6a7e296259485fca14dae4d38f9edf655496d4913609d6125c0fc9be1276","language":"plpgsql","volatility":"v","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"trigger"},"nested172_validate_recovered()":{"body_sha256":"94d6f4150ba410657f67bbdcbe77b528001aebf010253ac6e404d394622cc414","language":"plpgsql","volatility":"v","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"jsonb"}}$helperprops172$::jsonb;
BEGIN
 IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' OR(SELECT count(*) FROM public.nested172_certificate)<>1 THEN RETURN false;END IF;
 SELECT * INTO STRICT c FROM public.nested172_certificate WHERE singleton;
 SELECT relowner INTO STRICT owner_oid FROM pg_class WHERE oid='public.nested172_certificate'::regclass;
 SELECT encode(sha256(convert_to(c.functions->'nested172_valid()'->>'body','UTF8')),'hex') INTO leaf_hash;
 IF pg_get_userbyid(owner_oid) IS DISTINCT FROM c.functions_before->'cooperation171_valid()'->>'owner'
 OR(SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'nested172_'))
 IS DISTINCT FROM(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected_helpers) keys(key)) THEN RETURN false;END IF;
 IF(SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_') AND relkind IN('r','p','v','m','S','f')) IS DISTINCT FROM ARRAY['nested172_certificate']::text[]
 OR NOT EXISTS(SELECT FROM pg_class WHERE oid='public.nested172_certificate'::regclass AND relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity)
 OR EXISTS(SELECT FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid='public.nested172_certificate'::regclass),acldefault('r',owner_oid))) acl WHERE acl.grantee<>owner_oid OR acl.grantor<>owner_oid OR acl.is_grantable)
 OR EXISTS(SELECT FROM pg_policy WHERE polrelid='public.nested172_certificate'::regclass)
 OR(SELECT count(*) FROM pg_attribute WHERE attrelid='public.nested172_certificate'::regclass AND attnum>0 AND NOT attisdropped)<>12
 OR(SELECT count(*) FROM pg_attribute WHERE attrelid='public.nested172_certificate'::regclass AND attnum>0 AND NOT attisdropped AND attnotnull)<>12
 OR(SELECT count(*) FROM pg_constraint WHERE conrelid='public.nested172_certificate'::regclass AND contype='c' AND convalidated AND NOT condeferrable)<>12
 OR(SELECT count(*) FROM pg_constraint WHERE conrelid='public.nested172_certificate'::regclass AND contype<>'n')<>13
 OR(SELECT count(*) FROM pg_constraint WHERE conrelid='public.nested172_certificate'::regclass AND contype='n')<>12
 OR(SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.nested172_certificate'::regclass AND attnum>0 AND NOT attisdropped)
 IS DISTINCT FROM ARRAY['singleton','profile','originals','functions_before','functions_after','pim_before','physical_before','cooperation_before','predecessors_before','functions','metadata_hash','created_at']::text[]
 OR EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid='public.nested172_certificate'::regclass AND a.attnum>0 AND NOT a.attisdropped
  AND(a.atttypid IS DISTINCT FROM(CASE WHEN a.attnum=1 THEN 'boolean'::regtype WHEN a.attnum IN(2,11) THEN 'text'::regtype WHEN a.attnum=12 THEN 'timestamptz'::regtype ELSE 'jsonb'::regtype END)::oid
   OR NOT a.attnotnull OR a.attidentity<>'' OR a.attgenerated<>'' OR a.atthasdef
   OR NOT EXISTS(SELECT FROM pg_constraint n WHERE n.conrelid=a.attrelid AND n.contype='n' AND n.conkey=ARRAY[a.attnum]::smallint[]
    AND(to_jsonb(n)-'oid') IS NOT DISTINCT FROM jsonb_build_object(
     'conname','nested172_certificate_'||a.attname||'_not_null','connamespace','public'::regnamespace::oid,'contype','n',
     'condeferrable',false,'condeferred',false,'conenforced',true,'convalidated',true,'conrelid',a.attrelid,'contypid',0::oid,
     'conindid',0::oid,'conparentid',0::oid,'confrelid',0::oid,'confupdtype',' ','confdeltype',' ','confmatchtype',' ',
     'conislocal',true,'coninhcount',0,'connoinherit',false,'conperiod',false,'conkey',ARRAY[a.attnum]::smallint[],
     'confkey',NULL,'conpfeqop',NULL,'conppeqop',NULL,'conffeqop',NULL,'confdelsetcols',NULL,'conexclop',NULL,'conbin',NULL)
    AND pg_get_constraintdef(n.oid,true) IS NOT DISTINCT FROM 'NOT NULL '||quote_ident(a.attname))))
 OR(SELECT count(*) FROM pg_index WHERE indrelid='public.nested172_certificate'::regclass AND indisprimary AND indisvalid AND indisready)<>1
 OR(SELECT count(*) FROM pg_index WHERE indrelid='public.nested172_certificate'::regclass)<>1
 OR(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND(starts_with(tgname,'nested172_') OR tgrelid='public.nested172_certificate'::regclass))<>1
 OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.nested172_certificate'::regclass AND tgname='nested172_certificate_seal' AND tgtype=31 AND tgenabled='O' AND tgfoid='public.nested172_certificate_seal()'::regprocedure AND tgqual IS NULL AND tgnargs=0)
 THEN RETURN false;END IF;
 FOR sig,props IN SELECT key,value FROM jsonb_each(expected_helpers) entries(key,value) LOOP
  SELECT p.*,l.lanname INTO STRICT catalog_function FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.'||sig);
  IF catalog_function.proowner IS DISTINCT FROM owner_oid OR catalog_function.lanname IS DISTINCT FROM props->>'language'
  OR catalog_function.provolatile::text IS DISTINCT FROM props->>'volatility' OR catalog_function.prosecdef IS DISTINCT FROM(props->>'security_definer')::boolean
  OR catalog_function.proisstrict OR catalog_function.proleakproof OR catalog_function.proparallel<>'u' OR catalog_function.prokind<>'f' OR catalog_function.proretset
  OR catalog_function.procost<>100 OR catalog_function.prorows<>0 OR catalog_function.proargmodes IS NOT NULL OR catalog_function.proargdefaults IS NOT NULL
  OR to_jsonb(catalog_function.proargnames) IS DISTINCT FROM nullif(props->'argument_names','null'::jsonb)
  OR pg_get_function_result(catalog_function.oid) IS DISTINCT FROM props->>'result'
  OR(SELECT jsonb_agg(replace(setting,' ','' ) ORDER BY ordinal) FROM unnest(catalog_function.proconfig) WITH ORDINALITY config(setting,ordinal)) IS DISTINCT FROM props->'configuration'
  OR(sig<>'nested172_valid()' AND encode(sha256(convert_to(catalog_function.prosrc,'UTF8')),'hex') IS DISTINCT FROM props->>'body_sha256')
  OR EXISTS(SELECT FROM aclexplode(coalesce(catalog_function.proacl,acldefault('f',owner_oid))) acl WHERE acl.grantee<>owner_oid OR acl.grantor<>owner_oid OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable)
  OR NOT EXISTS(SELECT FROM aclexplode(coalesce(catalog_function.proacl,acldefault('f',owner_oid))) acl WHERE acl.grantee=owner_oid AND acl.privilege_type='EXECUTE') THEN RETURN false;END IF;
 END LOOP;
 IF c.profile IS DISTINCT FROM '171-to172-nested-legacy-finite-json/v2' OR NOT isfinite(c.created_at)
 OR jsonb_typeof(c.functions_before) IS DISTINCT FROM 'object' OR jsonb_typeof(c.functions_after) IS DISTINCT FROM 'object'
 OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(c.functions_before) k(key)) IS DISTINCT FROM ARRAY['cooperation171_valid()','parcel_physical_wz_valid()','pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']::text[]
 OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(c.functions_after) k(key)) IS DISTINCT FROM ARRAY['cooperation171_valid()','parcel_physical_wz_valid()','pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']::text[]
 OR c.originals IS DISTINCT FROM jsonb_build_object('168',(SELECT to_jsonb(x) FROM public.parcel_physical_wz_certificate x),'170',(SELECT to_jsonb(x) FROM public.pim_dictionary_manifest x),'171',(SELECT to_jsonb(x) FROM public.cooperation171_certificate x))
 OR c.functions IS DISTINCT FROM public.wave_print177_history_map(public.nested172_function_map())
 OR c.metadata_hash IS DISTINCT FROM public.pim_dictionary_hash(public.wave_print177_history_metadata(public.nested172_metadata())) THEN RETURN false;END IF;
 FOR sig IN SELECT key FROM jsonb_object_keys(expected_before) k(key) LOOP
  b:=c.functions_before->sig;a:=c.functions_after->sig;
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
  OR jsonb_typeof(b->'body') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'body') IS DISTINCT FROM 'string'
  OR jsonb_typeof(b->'definition') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'definition') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  SELECT public.wave_print177_history_complete_metadata(p.oid) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||sig);
  IF sig='pim_dictionary_source_json_valid(jsonb)' THEN
   IF encode(sha256(convert_to(a->>'body','UTF8')),'hex') IS DISTINCT FROM '9e45af1a545bef9c6557f59df22223094d3ab3f056721924466eaccadeb8d512' THEN RETURN false;END IF;
  ELSE
   pos:=strpos(b->>'body','BEGIN');IF pos<1 THEN RETURN false;END IF;
   expected_body:=overlay(b->>'body' placing 'BEGIN'||replace(expected_prefix,'@VALID_SHA@',leaf_hash) from pos for 5);
   IF sig='pim_dictionary_valid()' THEN
    expected_body:=replace(expected_body,'@ANCESTORS@','  FOR guard_name IN SELECT key FROM jsonb_object_keys(public.pim_dictionary_predecessor_metadata()) keys(key) ORDER BY key LOOP EXECUTE format(''SELECT public.%I()'',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;');
   ELSE expected_body:=replace(expected_body,'@ANCESTORS@','');END IF;
   IF a->>'body' IS DISTINCT FROM expected_body THEN RETURN false;END IF;
  END IF;
  IF live IS DISTINCT FROM a OR(b-'body'-'definition') IS DISTINCT FROM(a-'body'-'definition')
  OR replace(a->>'definition',a->>'body',b->>'body') IS DISTINCT FROM b->>'definition'
  OR encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM expected_before->>sig THEN RETURN false;END IF;
 END LOOP;
 IF public.nested172_project_metadata(public.wave_print177_history_metadata(public.pim_dictionary_metadata()),'pim') IS DISTINCT FROM c.pim_before
 OR public.nested172_project_metadata(public.wave_print177_history_metadata(public.cooperation171_physical_metadata()),'physical') IS DISTINCT FROM c.physical_before
 OR public.nested172_project_metadata(public.wave_print177_history_metadata(public.cooperation171_metadata()),'cooperation') IS DISTINCT FROM c.cooperation_before
 OR public.nested172_project_metadata(public.wave_print177_history_map(public.pim_dictionary_predecessor_metadata()),'predecessors') IS DISTINCT FROM c.predecessors_before
 OR public.wave_print177_history_nested172_historical171_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
 -- This leaf NEVER calls a parent/full guard; PIM wrapper invokes all25 separately.
 IF EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json') THEN RETURN true;END IF;
 r:=to_regclass('pg_temp.nested172_install_basis');IF r IS NULL THEN RETURN false;END IF;
 IF current_user IS DISTINCT FROM session_user OR NOT EXISTS(SELECT FROM pg_class cl WHERE cl.oid=r AND cl.relpersistence='t' AND cl.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
 AND NOT EXISTS(SELECT FROM aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) a WHERE a.grantee<>cl.relowner))
 OR(SELECT count(*) FROM pg_temp.nested172_install_basis)<>1 THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM pg_temp.nested172_install_basis x WHERE x.root_xid=pg_current_xact_id()::text AND x.started_at=transaction_timestamp() AND x.backend_pid=pg_backend_pid() AND x.owner_name=current_user
 AND x.originals=c.originals AND x.functions_before=c.functions_before AND x.pim_before=c.pim_before AND x.physical_before=c.physical_before AND x.cooperation_before=c.cooperation_before AND x.predecessors_before=c.predecessors_before);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $nested172$;
CREATE FUNCTION wave_print177_history_operative_delivery_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE cert operative_delivery_certificate;basis record;o oid;n text;expected jsonb:='{"label_print_frame":"d191d4c1280acb4f6c5dec86c23ce72dfce2a5781ad0b0264ed544372454d0c4","order_parcel_source":"5d1ec193a5a147ca758682a3f15ca86c977797717642b833d657397bc4b80fec","packed_label_print_guards":"899a7420b798208ec7350370eb732b98984de00089ec534d7a73f83e1ffcfe0f"}'::jsonb;BEGIN
 IF current_setting('session_replication_role')<>'origin' OR to_regclass('public.operative_delivery_certificate') IS NULL OR to_regclass('public.operative_delivery_evidence') IS NULL
 OR to_regclass('public.buyer_address_manifest') IS NULL OR to_regclass('public.packed_label_print_manifest') IS NULL
 OR to_regclass('public.migrations') IS NULL
 OR to_regprocedure('public.operative_delivery_fingerprint()') IS NULL OR to_regprocedure('public.operative_delivery_functions()') IS NULL
 OR to_regprocedure('public.packed_label_print_fingerprint()') IS NULL
 OR to_regprocedure('public.buyer_address_fingerprint()') IS NULL OR to_regprocedure('public.buyer_address_predecessors()') IS NULL
 OR NOT EXISTS(SELECT FROM migrations WHERE name='156_packed_label_print') OR NOT EXISTS(SELECT FROM migrations WHERE name='166_buyer_address_sidecar')
 OR (SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'operative_delivery_') AND relkind IN('r','p')) IS DISTINCT FROM ARRAY['operative_delivery_certificate','operative_delivery_evidence']::text[]
 OR (SELECT count(*) FROM operative_delivery_certificate)<>1 THEN RETURN false;END IF;
 SELECT * INTO cert FROM operative_delivery_certificate;
 IF jsonb_typeof(cert.predecessor_functions) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.successor_functions) IS DISTINCT FROM 'object'
 OR jsonb_typeof(cert.original156_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.original166_manifest) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF cert.profile IS DISTINCT FROM '156-original-to167-operational-receiver/v1'
 OR cert.original156_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM packed_label_print_manifest m)
 OR cert.original166_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM buyer_address_manifest m)
 OR cert.original166_manifest->>'fingerprint' IS DISTINCT FROM buyer_address_fingerprint()
 OR cert.original166_manifest->'predecessor_certificates' IS DISTINCT FROM buyer_address_predecessors()
 OR cert.original156_fingerprint IS DISTINCT FROM cert.original156_manifest->>'fingerprint'
 OR cert.successor156_fingerprint IS DISTINCT FROM public.wave_print177_history_fingerprint('packed')
 OR cert.successor_functions IS DISTINCT FROM public.wave_print177_history_operative_functions()
 OR cert.own_fingerprint IS DISTINCT FROM public.wave_print177_history_fingerprint('operative')
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(cert.predecessor_functions) keys(key)) IS DISTINCT FROM ARRAY['label_print_frame','order_parcel_source','packed_label_print_fingerprint','packed_label_print_guards']::text[]
 THEN RETURN false;END IF;
 FOR n IN SELECT jsonb_object_keys(expected) LOOP
 IF encode(sha256(convert_to(cert.predecessor_functions->n->>'body','UTF8')),'hex') IS DISTINCT FROM expected->>n
 OR ((cert.predecessor_functions->n)-'definition'-'body') IS DISTINCT FROM((cert.successor_functions->n)-'definition'-'body')
 THEN RETURN false;END IF;END LOOP;
 IF cert.predecessor_functions->'packed_label_print_fingerprint' IS DISTINCT FROM cert.successor_functions->'packed_label_print_fingerprint' THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM migrations WHERE name='167_operational_delivery_consumers') THEN RETURN true;END IF;
 o:=to_regclass('pg_temp.operative_delivery_install_basis');IF o IS NULL THEN RETURN false;END IF;
 IF (SELECT relowner FROM pg_class WHERE oid=o) IS DISTINCT FROM(SELECT relowner FROM pg_class WHERE oid='public.operative_delivery_certificate'::regclass)
 OR current_user IS DISTINCT FROM session_user OR session_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=o)
 THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_temp.operative_delivery_install_basis)<>1 THEN RETURN false;END IF;
 SELECT * INTO basis FROM pg_temp.operative_delivery_install_basis;
 RETURN(basis.root_xid,basis.start_at,basis.backend_pid,basis.owner_name,basis.original156_manifest,basis.original166_manifest,basis.predecessor_functions)
 IS NOT DISTINCT FROM(pg_current_xact_id()::text,transaction_timestamp(),pg_backend_pid(),session_user::text,cert.original156_manifest,cert.original166_manifest,cert.predecessor_functions);
END $$;

-- Fixed native descriptor inverse. Only the explicit two nullable order columns,
-- two wave columns, source-kind check and two new named constraints may differ.
CREATE FUNCTION wave_print177_project_packed(actual jsonb,before jsonb,functions_before jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE r jsonb:=actual;rels jsonb:='[]';fs jsonb:='[]';rel jsonb;oldrel jsonb;col jsonb;cols jsonb:='[]';k jsonb;ks jsonb:='[]';f jsonb;b jsonb;found integer:=0;BEGIN
 FOR rel IN SELECT value FROM jsonb_array_elements(actual->'relations') LOOP
 IF rel->>'name'='print_jobs' THEN
 SELECT value INTO STRICT oldrel FROM jsonb_array_elements(before->'relations') WHERE value->>'name'='print_jobs';
 FOR col IN SELECT value FROM jsonb_array_elements(rel->'columns') LOOP
 IF col->>'name'=ANY(ARRAY['wave_id','wave_snapshot']) THEN
 IF col->>'type' IS DISTINCT FROM (CASE WHEN col->>'name'='wave_id' THEN 'uuid' ELSE 'jsonb' END)
 OR col->'notnull' IS DISTINCT FROM 'false'::jsonb OR col->'default' IS DISTINCT FROM 'null'::jsonb
 OR col->'acl' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('grantor',oldrel->>'owner','grantee','dyna_app','privilege','SELECT','grantable',false))
 THEN RAISE EXCEPTION '177 wave column drift' USING ERRCODE='55000';END IF;found:=found+1;
 ELSE IF col->>'name'=ANY(ARRAY['order_id','order_snapshot']) THEN
 IF col->'notnull' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION '177 nullable shape' USING ERRCODE='55000';END IF;
 col:=jsonb_set(col,'{notnull}','true');END IF;cols:=cols||jsonb_build_array(col);END IF;
 END LOOP;
 IF found<>2 THEN RAISE EXCEPTION '177 wave column cardinality' USING ERRCODE='55000';END IF;
 IF(SELECT count(*) FROM jsonb_array_elements(rel->'constraints') WHERE value->>'name'='wave_print177_source_shape')<>1
 OR(SELECT count(*) FROM jsonb_array_elements(rel->'constraints') WHERE value->>'name'='wave_print177_job_wave_fk')<>1
 THEN RAISE EXCEPTION '177 mandatory wave constraints missing/duplicate' USING ERRCODE='55000';END IF;
 FOR k IN SELECT value FROM jsonb_array_elements(rel->'constraints') LOOP
 IF k->>'name'=ANY(ARRAY['wave_print177_source_shape','wave_print177_job_wave_fk','print_jobs_source_kind_check']) AND k->'valid' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION '177 constraint not validated' USING ERRCODE='55000';END IF;
 IF k->>'name'='wave_print177_source_shape' THEN
 IF k->>'definition' IS DISTINCT FROM 'CHECK ((((source_kind = ''picking_wave''::text) AND (order_id IS NULL) AND (order_snapshot IS NULL) AND (wave_id IS NOT NULL) AND (wave_snapshot IS NOT NULL) AND (jsonb_typeof(wave_snapshot) = ''object''::text) AND (format = ''pdf''::text) AND (retry_of_job_id IS NULL)) OR ((source_kind = ANY (ARRAY[''manual''::text, ''shipment_label''::text])) AND (order_id IS NOT NULL) AND (order_snapshot IS NOT NULL) AND (wave_id IS NULL) AND (wave_snapshot IS NULL))))' THEN RAISE EXCEPTION '177 source check drift' USING ERRCODE='55000';END IF;
 ELSIF k->>'name'='wave_print177_job_wave_fk' THEN
 IF k->>'definition' IS DISTINCT FROM 'FOREIGN KEY (tenant_id, wave_id) REFERENCES picking_waves(tenant_id, id)' THEN RAISE EXCEPTION '177 wave FK drift' USING ERRCODE='55000';END IF;
 ELSIF k->>'name'='print_jobs_source_kind_check' THEN
 IF k->>'definition' IS DISTINCT FROM 'CHECK ((source_kind = ANY (ARRAY[''manual''::text, ''shipment_label''::text, ''picking_wave''::text])))' THEN RAISE EXCEPTION '177 kind drift' USING ERRCODE='55000';END IF;
 SELECT value INTO STRICT k FROM jsonb_array_elements(oldrel->'constraints') WHERE value->>'name'='print_jobs_source_kind_check';ks:=ks||jsonb_build_array(k);
 ELSE ks:=ks||jsonb_build_array(k);END IF;
 END LOOP;
 -- PG18 NOT NULL constraints disappear with DROP NOT NULL, preserve their old
 -- descriptors only after verifying the associated nullable attributes above.
 FOR k IN SELECT value FROM jsonb_array_elements(oldrel->'constraints') WHERE value->>'name'=ANY(ARRAY['print_jobs_order_id_not_null','print_jobs_order_snapshot_not_null']) LOOP ks:=ks||jsonb_build_array(k);END LOOP;
 SELECT jsonb_agg(value ORDER BY value->>'name') INTO ks FROM jsonb_array_elements(ks);
 rel:=jsonb_set(jsonb_set(rel,'{columns}',cols),'{constraints}',ks);
 END IF;rels:=rels||jsonb_build_array(rel);END LOOP;
 FOR f IN SELECT value FROM jsonb_array_elements(actual->'functions') LOOP
 b:=functions_before->(f->>'name');
 IF b IS NOT NULL THEN
 -- The valid() predicate verifies live new body+all properties independently.
 f:=jsonb_set(f,'{def}',b->'definition');END IF;fs:=fs||jsonb_build_array(f);END LOOP;
 r:=jsonb_set(jsonb_set(r,'{relations}',rels),'{functions}',fs);
 IF r IS DISTINCT FROM before THEN RAISE EXCEPTION '177 unlisted print metadata change' USING ERRCODE='55000';END IF;RETURN r;
END $wave177$;

CREATE FUNCTION wave_print177_project_operative(actual jsonb,before_hash text,functions_before jsonb) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE f jsonb;b jsonb;arr jsonb:='[]';sig text;r jsonb;BEGIN
 FOR f IN SELECT value FROM jsonb_array_elements(actual->'functions') LOOP
 sig:=coalesce(f->>'signature',f->>'name');IF sig!~'\(' THEN sig:=sig||'()';END IF;
 b:=functions_before->sig;
 IF b IS NOT NULL THEN IF f?'signature' THEN f:=b-'body';ELSE f:=jsonb_set(f,ARRAY['def'],b->'definition');END IF;END IF;
 arr:=arr||jsonb_build_array(f);END LOOP;r:=jsonb_set(actual,'{functions}',arr);
 IF public.pim_dictionary_hash(r) IS DISTINCT FROM before_hash THEN RAISE EXCEPTION '177 unlisted operative metadata change' USING ERRCODE='55000';END IF;
END $wave177$;

ALTER TABLE public.print_jobs ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE public.print_jobs ALTER COLUMN order_snapshot DROP NOT NULL;
ALTER TABLE public.print_jobs ADD COLUMN wave_id uuid;
ALTER TABLE public.print_jobs ADD COLUMN wave_snapshot jsonb;
ALTER TABLE public.print_jobs DROP CONSTRAINT print_jobs_source_kind_check;
ALTER TABLE public.print_jobs ADD CONSTRAINT print_jobs_source_kind_check CHECK(source_kind IN('manual','shipment_label','picking_wave'));
ALTER TABLE public.print_jobs ADD CONSTRAINT wave_print177_source_shape CHECK(
 (source_kind='picking_wave' AND order_id IS NULL AND order_snapshot IS NULL AND wave_id IS NOT NULL AND wave_snapshot IS NOT NULL AND jsonb_typeof(wave_snapshot)='object' AND format='pdf' AND retry_of_job_id IS NULL)
 OR(source_kind IN('manual','shipment_label') AND order_id IS NOT NULL AND order_snapshot IS NOT NULL AND wave_id IS NULL AND wave_snapshot IS NULL));
ALTER TABLE public.print_jobs ADD CONSTRAINT wave_print177_job_wave_fk FOREIGN KEY(tenant_id,wave_id) REFERENCES public.picking_waves(tenant_id,id);
GRANT SELECT(wave_id,wave_snapshot) ON public.print_jobs TO dyna_app;
CREATE TABLE public.picking_wave_print_assets(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id),wave_id uuid NOT NULL,
 basis jsonb NOT NULL CHECK(jsonb_typeof(basis)='object'),render_snapshot jsonb NOT NULL CHECK(jsonb_typeof(render_snapshot)='object'),
 content_encrypted text NOT NULL CHECK(length(content_encrypted) BETWEEN 40 AND 4000000),
 content_sha256 text NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'),content_bytes integer NOT NULL CHECK(content_bytes BETWEEN 1 AND 2097152),
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,wave_id) REFERENCES public.picking_waves(tenant_id,id));
CREATE TABLE public.picking_wave_print_previews(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id),wave_id uuid NOT NULL,asset_id uuid NOT NULL,
 station_id uuid NOT NULL,printer_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES public.users(id),api_key_id uuid,
 client_key uuid NOT NULL,request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,wave_id) REFERENCES public.picking_waves(tenant_id,id),
 FOREIGN KEY(tenant_id,asset_id) REFERENCES public.picking_wave_print_assets(tenant_id,id),
 FOREIGN KEY(tenant_id,station_id) REFERENCES public.packing_stations(tenant_id,id),FOREIGN KEY(tenant_id,printer_id) REFERENCES public.print_printers(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'));
CREATE TABLE public.print_job_wave_sources(
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),job_id uuid NOT NULL,preview_id uuid NOT NULL,asset_id uuid NOT NULL,wave_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.users(id),api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,request jsonb NOT NULL,
 top_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,job_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,job_id) REFERENCES public.print_jobs(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.picking_wave_print_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,asset_id) REFERENCES public.picking_wave_print_assets(tenant_id,id),
 FOREIGN KEY(tenant_id,wave_id) REFERENCES public.picking_waves(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id));
CREATE INDEX picking_wave_print_previews_page ON public.picking_wave_print_previews(tenant_id,wave_id,created_at DESC,id DESC);
DO $wave177$ DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['picking_wave_print_assets','picking_wave_print_previews','print_job_wave_sources'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',rel);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',rel);
 EXECUTE format('CREATE POLICY wave_print177_tenant ON public.%I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
 EXECUTE format('CREATE POLICY wave_print177_owner ON public.%I TO %I USING(true) WITH CHECK(true)',rel,current_user);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',rel);
 END LOOP;
END $wave177$;
GRANT SELECT(id,tenant_id,wave_id,basis,render_snapshot,content_sha256,content_bytes,snapshot_sha256,created_at) ON public.picking_wave_print_assets TO dyna_app;
GRANT SELECT ON public.picking_wave_print_previews,public.print_job_wave_sources TO dyna_app;

CREATE FUNCTION wave_print177_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
BEGIN
 IF public.wave_print177_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Moduł drukowania partii jest niekompletny' USING ERRCODE='55000';END IF;
 PERFORM public.print_job_require(uid,kid,writing,pin);
END $wave177$;
CREATE FUNCTION wave_print177_basis(wid uuid,uid uuid,kid uuid,writing boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;w public.picking_waves;members jsonb;lines jsonb;n integer;BEGIN
 PERFORM public.wave_print177_require(uid,kid,writing,false);
 IF writing THEN
 PERFORM public.print_job_lock();PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||t,0));
 SELECT * INTO w FROM public.picking_waves WHERE(tenant_id,id)=(t,wid) FOR UPDATE;
 PERFORM 1 FROM public.orders o JOIN public.picking_wave_orders m ON(m.tenant_id,m.order_id)=(o.tenant_id,o.id)
 WHERE(m.tenant_id,m.wave_id)=(t,wid) ORDER BY o.id FOR UPDATE OF o;
 ELSE SELECT * INTO w FROM public.picking_waves WHERE(tenant_id,id)=(t,wid);END IF;
 IF w.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono partii' USING ERRCODE='P0002';END IF;
 SELECT count(*) INTO n FROM public.picking_wave_orders WHERE(tenant_id,wave_id)=(t,wid);
 IF n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Niepełny skład partii' USING ERRCODE='23514';END IF;
 SELECT jsonb_agg(jsonb_build_object('id',o.id,'number',o.number,'version',o.version::text,'status',o.status,'payment_mode',o.payment_mode,'slot',m.slot,'active',m.active) ORDER BY m.slot,o.id)
 INTO members FROM public.picking_wave_orders m JOIN public.orders o ON(o.tenant_id,o.id)=(m.tenant_id,m.order_id) WHERE(m.tenant_id,m.wave_id)=(t,wid);
 IF jsonb_array_length(members) IS DISTINCT FROM n THEN RAISE EXCEPTION 'Niepełny skład zamówień partii' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM public.reservation_locations a JOIN public.picking_wave_orders m ON(m.tenant_id,m.order_id)=(a.tenant_id,a.order_id) WHERE(m.tenant_id,m.wave_id)=(t,wid);
 IF n>2000 THEN RAISE EXCEPTION 'Partia przekracza limit lokalizacji' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('order_id',a.order_id,'product_id',a.product_id,'location',a.location,'quantity',a.quantity,'scanned',a.scanned,
 'reservation_state',r.state,'order_sku',i.sku,'order_ean',i.ean,'pick_quantity',i.quantity,'pick_scanned',i.scanned,'sku',p.sku,'ean',p.ean,'name',p.name) ORDER BY a.order_id,a.product_id,a.location),'[]'::jsonb)
 INTO lines FROM public.reservation_locations a JOIN public.reservations r USING(tenant_id,order_id,product_id,warehouse_id)
 JOIN public.order_pick_items i USING(tenant_id,order_id,product_id) JOIN public.products p ON(p.tenant_id,p.id)=(a.tenant_id,a.product_id)
 JOIN public.picking_wave_orders m ON(m.tenant_id,m.order_id)=(a.tenant_id,a.order_id) WHERE(m.tenant_id,m.wave_id)=(t,wid);
 IF jsonb_array_length(lines) IS DISTINCT FROM n THEN RAISE EXCEPTION 'Niepełne źródło pozycji partii' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('wave',jsonb_build_object('id',w.id,'tenant_id',t,'name',w.name,'warehouse_id',w.warehouse_id,'state',w.state,'version',w.version::text),'orders',members,'lines',lines);
END $wave177$;
CREATE FUNCTION wave_print177_configuration(v jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;st public.packing_stations;p public.print_printers;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR(v-ARRAY['client_key','wave_version','station_id','station_version','printer_id','printer_version','copies'])<>'{}'::jsonb
 OR NOT(v ?& ARRAY['client_key','wave_version','station_id','station_version','printer_id','printer_version','copies']) OR v->>'wave_version'!~'^[1-9][0-9]{0,18}$' OR v->>'station_version'!~'^[1-9][0-9]{0,18}$' OR v->>'printer_version'!~'^[1-9][0-9]{0,18}$'
 OR jsonb_typeof(v->'copies') IS DISTINCT FROM 'number' OR(v->>'copies')::numeric NOT BETWEEN 1 AND 10 OR(v->>'copies')::numeric<>trunc((v->>'copies')::numeric)
 THEN RAISE EXCEPTION 'Niepoprawna konfiguracja druku partii' USING ERRCODE='23514';END IF;
 SELECT * INTO st FROM public.packing_stations WHERE(tenant_id,id)=(t,(v->>'station_id')::uuid) FOR UPDATE;
 SELECT * INTO p FROM public.print_printers WHERE(tenant_id,id)=(t,(v->>'printer_id')::uuid) FOR UPDATE;
 IF st.id IS NULL OR p.id IS NULL OR NOT st.enabled OR NOT p.enabled OR p.station_id IS DISTINCT FROM st.id OR p.format IS DISTINCT FROM 'pdf'
 OR st.version::text IS DISTINCT FROM v->>'station_version' OR p.version::text IS DISTINCT FROM v->>'printer_version'
 THEN RAISE EXCEPTION 'Stanowisko lub drukarka zmieniły się' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('station_snapshot',jsonb_build_object('id',st.id,'code',st.code,'label',st.label,'version',st.version::text,'enabled',st.enabled),
 'printer_snapshot',public.print_job_printer_head(to_jsonb(p)),'copies',(v->>'copies')::integer);
END $wave177$;
CREATE FUNCTION wave_print177_prepare_frame(wid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE basis jsonb;cfg jsonb;BEGIN
 basis:=public.wave_print177_basis(wid,uid,kid,true);cfg:=public.wave_print177_configuration(v);
 IF basis->'wave'->>'version' IS DISTINCT FROM v->>'wave_version' THEN RAISE EXCEPTION 'Partia zmieniła się' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('basis',basis,'configuration',cfg);
END $wave177$;
-- Full renderer input provenance; array display ordering is presentation only.
CREATE FUNCTION wave_print177_render_matches(b jsonb,s jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE expected_orders jsonb;expected_groups jsonb;actual_groups jsonb;expected_progress jsonb;wn text;BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR(s-ARRAY['captured_at','wave','orders','groups','progress'])<>'{}'::jsonb
 OR NOT(s ?& ARRAY['captured_at','wave','orders','groups','progress']) OR jsonb_typeof(s->'groups') IS DISTINCT FROM 'array'
 OR jsonb_typeof(s->'orders') IS DISTINCT FROM 'array' OR jsonb_typeof(s->'captured_at') IS DISTINCT FROM 'string'
 OR NOT isfinite((s->>'captured_at')::timestamptz) THEN RETURN false;END IF;
 SELECT name INTO STRICT wn FROM public.warehouses WHERE(tenant_id,id)=((b->'wave'->>'tenant_id')::uuid,(b->'wave'->>'warehouse_id')::uuid);
 IF s->'wave' IS DISTINCT FROM(b->'wave'||jsonb_build_object('warehouse_name',wn)) THEN RETURN false;END IF;
 SELECT jsonb_agg(value-ARRAY['version','active'] ORDER BY (value->>'slot')::integer,value->>'id') INTO expected_orders FROM jsonb_array_elements(b->'orders');
 IF s->'orders' IS DISTINCT FROM expected_orders THEN RETURN false;END IF;
 WITH data AS(SELECT l.value l,o.value o FROM jsonb_array_elements(b->'lines') l JOIN jsonb_array_elements(b->'orders') o ON o.value->>'id'=l.value->>'order_id' WHERE o.value->>'status'<>'cancelled'),
 grouped AS(SELECT l->>'product_id' product_id,l->>'location' location,jsonb_build_object('product_id',l->'product_id','sku',l->'sku','ean',l->'ean','name',l->'name','location',l->'location',
 'quantity',sum((l->>'quantity')::bigint),'scanned',sum((l->>'scanned')::bigint),
 'destinations',jsonb_agg(jsonb_build_object('order_id',o->'id','number',o->'number','slot',o->'slot','quantity',l->'quantity','scanned',l->'scanned','status',o->'status') ORDER BY o->>'id')) g
 FROM data GROUP BY l->>'product_id',l->>'location',l->'product_id',l->'sku',l->'ean',l->'name',l->'location')
 SELECT coalesce(jsonb_agg(g ORDER BY product_id,location),'[]'::jsonb) INTO expected_groups FROM grouped;
 SELECT coalesce(jsonb_agg((g-ARRAY['destinations'])||jsonb_build_object('destinations',(SELECT jsonb_agg(d ORDER BY d->>'order_id') FROM jsonb_array_elements(g->'destinations') d)) ORDER BY g->>'product_id',g->>'location'),'[]'::jsonb)
 INTO actual_groups FROM jsonb_array_elements(s->'groups') g;
 IF actual_groups IS DISTINCT FROM expected_groups THEN RETURN false;END IF;
 SELECT jsonb_build_object('quantity',coalesce(sum((value->>'quantity')::bigint),0),'scanned',coalesce(sum((value->>'scanned')::bigint),0),'cancelled_orders',(SELECT count(*) FROM jsonb_array_elements(b->'orders') o WHERE o->>'status'='cancelled')) INTO expected_progress FROM jsonb_array_elements(expected_groups);
 RETURN s->'progress' IS NOT DISTINCT FROM expected_progress;
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $wave177$;
CREATE FUNCTION wave_print177_store(wid uuid,v jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a public.picking_wave_print_assets;p public.picking_wave_print_previews;basis jsonb;cfg jsonb;rh text;ts timestamptz:=clock_timestamp();BEGIN
 PERFORM public.wave_print177_require(uid,kid,true,false);PERFORM public.print_job_lock();
 rh:=public.print_job_hash(jsonb_build_object('tenant_id',t,'wave_id',wid,'actor_id',uid,'api_key_id',kid,'request',v->'request'));
 SELECT * INTO p FROM public.picking_wave_print_previews WHERE(tenant_id,client_key)=(t,(v->'request'->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN
 IF p.wave_id IS DISTINCT FROM wid OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid OR p.request_hash IS DISTINCT FROM rh THEN RAISE EXCEPTION 'Klucz podglądu ma inną treść' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('preview',p.payload||jsonb_build_object('scope_hash',p.scope_hash),'reused',true);END IF;
 basis:=public.wave_print177_basis(wid,uid,kid,true);cfg:=public.wave_print177_configuration(v->'request');
 IF basis->'wave'->>'version' IS DISTINCT FROM v->'request'->>'wave_version' OR basis IS DISTINCT FROM v->'basis'
 OR public.print_job_content_valid(v->>'content_base64','pdf') IS DISTINCT FROM true
 OR public.wave_print177_render_matches(basis,v->'render_snapshot') IS DISTINCT FROM true
 OR jsonb_typeof(v->'content_encrypted') IS DISTINCT FROM 'string' OR length(v->>'content_encrypted') NOT BETWEEN 40 AND 4000000
 THEN RAISE EXCEPTION 'Pełne źródło PDF zmieniło się' USING ERRCODE='23514';END IF;
 a.id:=gen_random_uuid();a.tenant_id:=t;a.wave_id:=wid;a.basis:=basis;a.render_snapshot:=v->'render_snapshot';a.content_encrypted:=v->>'content_encrypted';
 a.content_sha256:=encode(sha256(decode(v->>'content_base64','base64')),'hex');a.content_bytes:=octet_length(decode(v->>'content_base64','base64'));a.snapshot_sha256:=public.print_job_hash(a.render_snapshot);a.created_at:=ts;
 INSERT INTO public.picking_wave_print_assets SELECT a.*;
 p.id:=gen_random_uuid();p.tenant_id:=t;p.wave_id:=wid;p.asset_id:=a.id;p.station_id:=(v->'request'->>'station_id')::uuid;p.printer_id:=(v->'request'->>'printer_id')::uuid;
 p.actor_id:=uid;p.api_key_id:=kid;p.client_key:=(v->'request'->>'client_key')::uuid;p.request:=v->'request';p.request_hash:=rh;p.created_at:=ts;p.expires_at:=ts+interval '15 minutes';
 p.payload:=jsonb_build_object('id',p.id,'wave_id',wid,'wave_version',basis->'wave'->>'version','warehouse_id',basis->'wave'->'warehouse_id','source_kind','picking_wave','asset_id',a.id,
 'orders',basis->'orders','snapshot_sha256',a.snapshot_sha256,'content_sha256',a.content_sha256,'content_bytes',a.content_bytes,'format','pdf','created_at',ts,'expires_at',p.expires_at)||cfg;
 p.scope_hash:=public.print_job_hash(p.payload);INSERT INTO public.picking_wave_print_previews SELECT p.*;
 PERFORM public.wave_print177_budget();PERFORM public.wave_print177_require(uid,kid,true,true);
 RETURN jsonb_build_object('preview',p.payload||jsonb_build_object('scope_hash',p.scope_hash),'reused',false);
END $wave177$;
CREATE FUNCTION wave_print177_asset(pid uuid,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.picking_wave_print_previews;a public.picking_wave_print_assets;BEGIN
 PERFORM public.wave_print177_require(uid,kid,false,false);
 SELECT * INTO p FROM public.picking_wave_print_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL OR p.actor_id IS DISTINCT FROM uid OR p.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Nie znaleziono własnego podglądu' USING ERRCODE='P0002';END IF;
 SELECT * INTO STRICT a FROM public.picking_wave_print_assets WHERE(tenant_id,id)=(t,p.asset_id);
 RETURN jsonb_build_object('content_encrypted',a.content_encrypted,'content_sha256',a.content_sha256,'content_bytes',a.content_bytes);
END $wave177$;
CREATE FUNCTION wave_print177_queue(pid uuid,v jsonb,b64 text,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.picking_wave_print_previews;a public.picking_wave_print_assets;l public.print_job_wave_sources;j public.print_jobs;basis jsonb;cfg jsonb;rh text;r jsonb;ts timestamptz:=clock_timestamp();BEGIN
 PERFORM public.wave_print177_require(uid,kid,true,false);PERFORM public.print_job_lock();
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR(v-ARRAY['client_key','scope_hash','confirmed'])<>'{}'::jsonb OR NOT(v ?& ARRAY['client_key','scope_hash','confirmed']) OR v->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Wymagana zgoda na dokładny PDF' USING ERRCODE='23514';END IF;
 rh:=public.print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'preview_id',pid,'request',v));
 SELECT * INTO l FROM public.print_job_wave_sources WHERE(tenant_id,client_key)=(t,(v->>'client_key')::uuid);
 IF l.job_id IS NOT NULL THEN
 IF(l.preview_id,l.actor_id,l.api_key_id,l.request_hash) IS DISTINCT FROM(pid,uid,kid,rh) THEN RAISE EXCEPTION 'Klucz kolejki ma inną treść' USING ERRCODE='23514';END IF;
 r:=public.print_job_replay(l.client_key,rh,uid,kid,'job_create',l.job_id);IF r IS NULL THEN RAISE EXCEPTION 'Brak oryginalnego potwierdzenia kolejki' USING ERRCODE='23514';END IF;RETURN r||jsonb_build_object('preview_id',pid);END IF;
 SELECT * INTO p FROM public.picking_wave_print_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono podglądu' USING ERRCODE='P0002';END IF;
 IF(p.actor_id,p.api_key_id,p.scope_hash) IS DISTINCT FROM(uid,kid,v->>'scope_hash') OR p.expires_at<=clock_timestamp()
 OR EXISTS(SELECT FROM public.print_job_wave_sources WHERE(tenant_id,preview_id)=(t,pid)) THEN RAISE EXCEPTION 'Podgląd jest nieaktualny lub już użyty' USING ERRCODE='23514';END IF;
 basis:=public.wave_print177_basis(p.wave_id,uid,kid,true);cfg:=public.wave_print177_configuration(p.request);
 SELECT * INTO STRICT a FROM public.picking_wave_print_assets WHERE(tenant_id,id)=(t,p.asset_id);
 IF basis IS DISTINCT FROM a.basis OR cfg IS DISTINCT FROM(p.payload-ARRAY['id','wave_id','wave_version','warehouse_id','source_kind','asset_id','orders','snapshot_sha256','content_sha256','content_bytes','format','created_at','expires_at'])
 OR public.print_job_hash(p.payload) IS DISTINCT FROM p.scope_hash OR public.print_job_content_valid(b64,'pdf') IS DISTINCT FROM true
 OR encode(sha256(decode(b64,'base64')),'hex') IS DISTINCT FROM a.content_sha256 OR octet_length(decode(b64,'base64')) IS DISTINCT FROM a.content_bytes
 THEN RAISE EXCEPTION 'PDF lub pełny skład partii zmienił się' USING ERRCODE='23514';END IF;
 j.id:=gen_random_uuid();j.tenant_id:=t;j.wave_id:=p.wave_id;j.wave_snapshot:=a.basis;j.station_id:=p.station_id;j.printer_id:=p.printer_id;j.actor_id:=uid;j.api_key_id:=kid;
 j.client_key:=(v->>'client_key')::uuid;j.request_hash:=rh;j.station_snapshot:=cfg->'station_snapshot';j.printer_snapshot:=cfg->'printer_snapshot';j.source_kind:='picking_wave';j.format:='pdf';j.copies:=(cfg->>'copies')::integer;
 j.content_base64:=b64;j.content_sha256:=a.content_sha256;j.content_bytes:=a.content_bytes;j.version:=1;j.state:='queued';j.created_at:=ts;j.updated_at:=ts;
 INSERT INTO public.print_job_wave_sources(tenant_id,job_id,preview_id,asset_id,wave_id,actor_id,api_key_id,client_key,request_hash,request,created_at) VALUES(t,j.id,pid,a.id,p.wave_id,uid,kid,j.client_key,rh,v,ts);
 r:=public.print_job_event(gen_random_uuid(),j.id,NULL,uid,kid,j.client_key,rh,'job_create',NULL,public.print_job_head(to_jsonb(j)),jsonb_build_object('preview_id',pid,'wave_id',p.wave_id,'asset_id',a.id,'source_kind','picking_wave'));
 INSERT INTO public.print_jobs SELECT j.*;
 PERFORM public.wave_print177_budget();PERFORM public.wave_print177_require(uid,kid,true,true);RETURN r||jsonb_build_object('preview_id',pid);
END $wave177$;
CREATE FUNCTION wave_print177_job_source(jid uuid,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;j public.print_jobs;l public.print_job_wave_sources;p public.picking_wave_print_previews;a public.picking_wave_print_assets;BEGIN
 SELECT * INTO j FROM public.print_jobs WHERE(tenant_id,id)=(t,jid);
 SELECT * INTO l FROM public.print_job_wave_sources WHERE(tenant_id,job_id)=(t,jid);
 IF j.id IS NULL OR j.source_kind IS DISTINCT FROM 'picking_wave' OR l.job_id IS NULL THEN RAISE EXCEPTION 'Brak pełnego źródła zadania partii' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT p FROM public.picking_wave_print_previews WHERE(tenant_id,id)=(t,l.preview_id);
 SELECT * INTO STRICT a FROM public.picking_wave_print_assets WHERE(tenant_id,id)=(t,l.asset_id);
 IF(j.wave_id,j.wave_snapshot,j.content_sha256,j.content_bytes,j.actor_id,j.api_key_id,j.client_key,j.request_hash) IS DISTINCT FROM(l.wave_id,a.basis,a.content_sha256,a.content_bytes,l.actor_id,l.api_key_id,l.client_key,l.request_hash)
 OR(p.asset_id,p.wave_id,p.actor_id,p.api_key_id) IS DISTINCT FROM(a.id,l.wave_id,l.actor_id,l.api_key_id) OR j.order_id IS NOT NULL OR j.order_snapshot IS NOT NULL
 THEN RAISE EXCEPTION 'Niepoprawne powiązanie pełnej partii' USING ERRCODE='23514';END IF;
 IF pin THEN PERFORM 1 FROM public.picking_waves WHERE(tenant_id,id)=(t,j.wave_id) FOR UPDATE;
 PERFORM 1 FROM public.orders WHERE tenant_id=t AND id IN(SELECT(value->>'id')::uuid FROM jsonb_array_elements(j.wave_snapshot->'orders')) ORDER BY id FOR UPDATE;END IF;
 -- Claim binds the immutable printed snapshot, not a later mutable wave version.
END $wave177$;
CREATE FUNCTION wave_print177_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;n bigint;BEGIN IF (SELECT count(*) FROM shipment_label_batch_previews WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_batch_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii partii etykiet' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM shipment_label_cache_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_cache_acquisitions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit cache etykiet' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM print_label_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_label_previews WHERE tenant_id=t)>2000 OR EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND octet_length(payload::text)+octet_length(request::text)>4194304) THEN RAISE EXCEPTION 'Limit historii etykiet drukowania' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM print_printers WHERE tenant_id=t)>100 OR (SELECT count(*) FROM print_jobs WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_job_events WHERE tenant_id=t)>10000 THEN RAISE EXCEPTION 'Limit historii drukowania' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.picking_wave_print_assets WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM public.picking_wave_print_previews WHERE tenant_id=t)>2000
 THEN RAISE EXCEPTION 'Limit historii partii drukowania' USING ERRCODE='23514';END IF;
 SELECT coalesce((SELECT sum(octet_length(content_base64)+coalesce(octet_length(order_snapshot::text),0)+coalesce(octet_length(wave_snapshot::text),0)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM print_label_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM print_label_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+512) FROM print_job_label_sources WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM shipment_label_cache_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(source_frame::text)+1024) FROM shipment_label_cache_acquisitions WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(combined_content_encrypted)+octet_length(payload::text)+octet_length(request::text)+512) FROM shipment_label_batch_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+512) FROM shipment_label_batch_preview_rows WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM shipment_label_batch_executions WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+512) FROM shipment_label_batch_execution_rows WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(witnesses::text)+512) FROM shipment_label_batch_admissions WHERE tenant_id=t),0) +coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(basis::text)+octet_length(render_snapshot::text)+512) FROM public.picking_wave_print_assets WHERE tenant_id=t),0)
 +coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM public.picking_wave_print_previews WHERE tenant_id=t),0)
 +coalesce((SELECT sum(octet_length(request::text)+512) FROM public.print_job_wave_sources WHERE tenant_id=t),0) INTO n;
 IF n>67108864 THEN RAISE EXCEPTION 'Limit historii drukowania' USING ERRCODE='23514';END IF;
END $wave177$;
CREATE FUNCTION wave_print177_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $wave177$ BEGIN RAISE EXCEPTION 'Źródło partii drukowania jest niezmienne' USING ERRCODE='23514';END $wave177$;
CREATE FUNCTION wave_print177_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$ BEGIN
 IF NEW.top_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.transaction_started_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION 'Źródło wymaga bieżącej transakcji' USING ERRCODE='23514';END IF;
 PERFORM public.wave_print177_job_source(NEW.job_id,false);PERFORM public.wave_print177_require(NEW.actor_id,NEW.api_key_id,true,true);RETURN NEW;
END $wave177$;
DO $wave177$ DECLARE rel text;BEGIN FOREACH rel IN ARRAY ARRAY['picking_wave_print_assets','picking_wave_print_previews','print_job_wave_sources'] LOOP
 EXECUTE format('CREATE TRIGGER wave_print177_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.wave_print177_immutable()',rel);
 END LOOP;END $wave177$;
CREATE CONSTRAINT TRIGGER wave_print177_source_complete AFTER INSERT ON public.print_job_wave_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.wave_print177_complete();

CREATE OR REPLACE FUNCTION print_job_head(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN v->>'source_kind'='picking_wave' THEN jsonb_build_object('wave_id',v->'wave_id','wave_snapshot',v->'wave_snapshot') ELSE '{}'::jsonb END || jsonb_build_object('id',v->'id','order_id',v->'order_id','order_number',v->'order_snapshot'->'number','station_id',v->'station_id','printer_id',v->'printer_id','order_snapshot',v->'order_snapshot','station_snapshot',v->'station_snapshot','printer_snapshot',v->'printer_snapshot','source_kind',v->'source_kind','format',v->'format','copies',v->'copies','content_sha256',v->'content_sha256','content_bytes',v->'content_bytes','retry_of_job_id',v->'retry_of_job_id','version',v->>'version','state',v->'state','lease_expires_at',v->'lease_expires_at','created_at',v->'created_at','updated_at',v->'updated_at')
$$;
CREATE OR REPLACE FUNCTION print_job_command(jid uuid,v jsonb,uid uuid,kid uuid,op text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; j print_jobs; p print_printers; st packing_stations; oid uuid; rh text; old jsonb; beforeh jsonb; outv jsonb; ts timestamptz:=clock_timestamp();
BEGIN
 IF op NOT IN('claim','ack','reconcile') THEN RAISE EXCEPTION 'Niepoprawne polecenie drukowania' USING ERRCODE='23514'; END IF;
 PERFORM print_job_lock(); PERFORM print_job_require(uid,kid,true,false,op='reconcile');
 rh:=print_job_hash(jsonb_build_object('tenant_id',t,'actor_id',uid,'api_key_id',kid,'operation',op,'id',jid,'request',v));
 old:=print_job_replay((v->>'client_key')::uuid,rh,uid,kid,op,jid); IF old IS NOT NULL THEN RETURN old; END IF;
 SELECT order_id INTO oid FROM print_jobs WHERE tenant_id=t AND id=jid;
 IF NOT EXISTS(SELECT FROM print_jobs WHERE tenant_id=t AND id=jid) THEN RAISE EXCEPTION 'Nie znaleziono zadania drukowania' USING ERRCODE='P0002'; END IF;
 IF oid IS NULL THEN PERFORM public.wave_print177_job_source(jid,true); ELSE PERFORM 1 FROM orders WHERE tenant_id=t AND id=oid FOR UPDATE; END IF;
 SELECT * INTO j FROM print_jobs WHERE tenant_id=t AND id=jid;
 SELECT * INTO st FROM packing_stations WHERE tenant_id=t AND id=j.station_id FOR UPDATE;
 SELECT * INTO p FROM print_printers WHERE tenant_id=t AND id=j.printer_id FOR UPDATE;
 SELECT * INTO j FROM print_jobs WHERE tenant_id=t AND id=jid FOR UPDATE;
 IF j.version::text IS DISTINCT FROM v->>'version' THEN RAISE EXCEPTION 'Zadanie drukowania zmieniło się' USING ERRCODE='23514'; END IF;
 beforeh:=print_job_head(to_jsonb(j));
 IF op='claim' THEN
  IF (v-ARRAY['client_key','version','lease_token'])<>'{}'::jsonb OR j.state<>'queued' OR NOT p.enabled OR NOT st.enabled OR print_job_printer_head(to_jsonb(p)) IS DISTINCT FROM j.printer_snapshot OR jsonb_build_object('id',st.id,'code',st.code,'label',st.label,'version',st.version::text,'enabled',st.enabled) IS DISTINCT FROM j.station_snapshot THEN RAISE EXCEPTION 'Zadanie nie może zostać przejęte w tej konfiguracji' USING ERRCODE='23514'; END IF;
  j.lease_hash:=print_job_hash(to_jsonb((v->>'lease_token')::uuid)); j.claim_actor_id:=uid; j.claim_api_key_id:=kid; j.lease_expires_at:=clock_timestamp()+interval '90 seconds'; j.state:='claimed';
 ELSIF op='ack' THEN
  IF (v-ARRAY['client_key','version','lease_token','result','content_sha256','artifact_name','spool_job_id','error_code'])<>'{}'::jsonb OR j.state<>'claimed' OR j.claim_actor_id IS DISTINCT FROM uid OR j.claim_api_key_id IS DISTINCT FROM kid OR j.lease_hash IS DISTINCT FROM print_job_hash(to_jsonb((v->>'lease_token')::uuid)) OR j.lease_expires_at<=clock_timestamp() OR j.content_sha256 IS DISTINCT FROM v->>'content_sha256' THEN RAISE EXCEPTION 'Brak aktywnego własnego lease drukowania' USING ERRCODE='23514'; END IF;
  IF ((v->>'result'='file_saved' AND j.printer_snapshot->>'output_mode'='file' AND (v->>'artifact_name') ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' AND NOT(v?'spool_job_id') AND NOT(v?'error_code')) OR (v->>'result'='spool_submitted' AND j.printer_snapshot->>'output_mode'='cups' AND (v->>'spool_job_id') ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' AND NOT(v?'artifact_name') AND NOT(v?'error_code')) OR (v->>'result' IN('failed','unknown') AND v->>'error_code' IN('OUTPUT_FAILED','INTERRUPTED','UNCONFIRMED') AND NOT(v?'artifact_name') AND NOT(v?'spool_job_id'))) IS NOT TRUE THEN RAISE EXCEPTION 'Niepoprawne potwierdzenie drukowania' USING ERRCODE='23514'; END IF;
  -- ACK binds the frozen sink, not a later printer configuration.
  IF v->>'result'='file_saved' AND j.printer_snapshot->>'output_mode'<>'file' OR v->>'result'='spool_submitted' AND j.printer_snapshot->>'output_mode'<>'cups' THEN RAISE EXCEPTION 'Wynik nie odpowiada zamrożonemu wyjściu' USING ERRCODE='23514'; END IF;
  j.state:=v->>'result';
 ELSE
  IF (v-ARRAY['client_key','version','result','confirmed','note'])<>'{}'::jsonb OR v->'confirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v->'note') IS DISTINCT FROM 'string' OR length(v->>'note') NOT BETWEEN 3 AND 500 OR v->>'note' ~ '[[:cntrl:]]' OR ((j.state='queued' AND v->>'result'='cancelled') OR (j.state='claimed' AND j.lease_expires_at<=clock_timestamp() AND v->>'result' IN('unknown','cancelled'))) IS NOT TRUE THEN RAISE EXCEPTION 'Ręczne rozstrzygnięcie wymaga wygasłego lease lub anulowania kolejki' USING ERRCODE='23514'; END IF;
  j.state:=v->>'result';
 END IF;
 j.version:=j.version+1; j.updated_at:=clock_timestamp();
 outv:=print_job_event(gen_random_uuid(),j.id,NULL,uid,kid,(v->>'client_key')::uuid,rh,op,beforeh,print_job_head(to_jsonb(j)),v-ARRAY['client_key','version','lease_token']);
 UPDATE print_jobs SET state=j.state,version=j.version,lease_hash=j.lease_hash,claim_actor_id=j.claim_actor_id,claim_api_key_id=j.claim_api_key_id,lease_expires_at=j.lease_expires_at,updated_at=j.updated_at WHERE tenant_id=t AND id=j.id;
 PERFORM print_job_budget(); PERFORM print_job_require(uid,kid,true,false,op='reconcile'); RETURN outv;
END $$;
CREATE OR REPLACE FUNCTION print_job_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; BEGIN
 PERFORM public.wave_print177_budget();
 IF (SELECT count(*) FROM print_printers WHERE tenant_id=t)>100 OR (SELECT count(*) FROM print_jobs WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_job_events WHERE tenant_id=t)>10000 OR
  coalesce((SELECT sum(octet_length(content_base64)+coalesce(octet_length(order_snapshot::text),0)+coalesce(octet_length(wave_snapshot::text),0)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)>67108864 THEN RAISE EXCEPTION 'Limit historii drukowania' USING ERRCODE='23514'; END IF;
END $$;
CREATE OR REPLACE FUNCTION label_print_budget() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; n bigint; BEGIN
 PERFORM public.wave_print177_budget();
 PERFORM print_job_budget();
 IF (SELECT count(*) FROM shipment_label_batch_previews WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_batch_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii partii etykiet' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM shipment_label_cache_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_cache_acquisitions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit cache etykiet' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM print_label_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_label_previews WHERE tenant_id=t)>2000 OR EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND octet_length(payload::text)+octet_length(request::text)>4194304) THEN RAISE EXCEPTION 'Limit historii etykiet drukowania' USING ERRCODE='23514'; END IF;
 SELECT coalesce((SELECT sum(octet_length(content_base64)+coalesce(octet_length(order_snapshot::text),0)+coalesce(octet_length(wave_snapshot::text),0)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM print_label_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM print_label_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+512) FROM print_job_label_sources WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM shipment_label_cache_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(source_frame::text)+1024) FROM shipment_label_cache_acquisitions WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(combined_content_encrypted)+octet_length(payload::text)+octet_length(request::text)+512) FROM shipment_label_batch_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+512) FROM shipment_label_batch_preview_rows WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM shipment_label_batch_executions WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+512) FROM shipment_label_batch_execution_rows WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(witnesses::text)+512) FROM shipment_label_batch_admissions WHERE tenant_id=t),0) INTO n;
 IF n>67108864 THEN RAISE EXCEPTION 'Limit historii drukowania' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION wave_print177_metadata() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
 SELECT jsonb_build_object(
 'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'persistence',c.relpersistence,
  'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'replica_identity',c.relreplident,'options',c.reloptions,'access_method',am.amname,
  'acl',public.pim_dictionary_acl_metadata(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))),
  'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'storage',a.attstorage,'compression',a.attcompression,'statistics',a.attstattarget,'options',a.attoptions,'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END,'default',pg_get_expr(d.adbin,d.adrelid),'acl',public.pim_dictionary_acl_metadata(a.attacl)) ORDER BY a.attnum),'[]'::jsonb) FROM pg_attribute a LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',con.conname,'kind',con.contype,'validated',con.convalidated,'deferrable',con.condeferrable,'deferred',con.condeferred,'definition',pg_get_constraintdef(con.oid,true)) ORDER BY con.conname),'[]'::jsonb) FROM pg_constraint con WHERE con.conrelid=c.oid),
  'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',idx.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'clustered',i.indisclustered,'replica_identity',i.indisreplident,'options',idx.reloptions,'owner',pg_get_userbyid(idx.relowner),'access_method',iam.amname) ORDER BY idx.relname),'[]'::jsonb) FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid LEFT JOIN pg_am iam ON iam.oid=idx.relam WHERE i.indrelid=c.oid),
  'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',pol.polname,'command',pol.polcmd,'permissive',pol.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN role_id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_id) END ORDER BY CASE WHEN role_id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_id)::text END) FROM unnest(pol.polroles) roles(role_id)),'using',pg_get_expr(pol.polqual,pol.polrelid),'check',pg_get_expr(pol.polwithcheck,pol.polrelid)) ORDER BY pol.polname),'[]'::jsonb) FROM pg_policy pol WHERE pol.polrelid=c.oid),
  'user_triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',tr.tgname,'enabled',tr.tgenabled,'definition',pg_get_triggerdef(tr.oid,true),'function',tr.tgfoid::regprocedure::text,'parent',CASE WHEN tr.tgparentid=0 THEN NULL ELSE (SELECT parent_trigger.tgname FROM pg_trigger parent_trigger WHERE parent_trigger.oid=tr.tgparentid) END) ORDER BY tr.tgname),'[]'::jsonb) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal),
  'view',CASE WHEN c.relkind IN('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END,
  'sequence',(SELECT jsonb_build_object('type',format_type(s.seqtypid,NULL),'start',s.seqstart,'increment',s.seqincrement,'maximum',s.seqmax,'minimum',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle) FROM pg_sequence s WHERE s.seqrelid=c.oid)) ORDER BY c.relname),'[]'::jsonb)
  FROM pg_class c LEFT JOIN pg_am am ON am.oid=c.relam WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['wave_print177_certificate','picking_wave_print_assets','picking_wave_print_previews','print_job_wave_sources']) AND c.relkind IN('r','p','v','m','S','f')),
 'functions',(SELECT coalesce(jsonb_agg(public.pim_dictionary_function_metadata(p.oid) ORDER BY p.oid::regprocedure::text),'[]'::jsonb) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'wave_print177_')),
 'authority_roles',(WITH RECURSIVE reachable(role_oid) AS (
  SELECT r.oid FROM pg_roles r WHERE r.rolname='dyna_app' OR r.oid=(SELECT relowner FROM pg_class WHERE oid='public.wave_print177_certificate'::regclass)
  UNION SELECT membership.roleid FROM pg_auth_members membership JOIN reachable reachable_role ON reachable_role.role_oid=membership.member)
  SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(role_row)-'oid'-'rolpassword' ORDER BY role_row.rolname) FROM pg_roles role_row WHERE role_row.oid IN(SELECT role_oid FROM reachable)),
  'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),'member',pg_get_userbyid(m.member),'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY pg_get_userbyid(m.roleid)::text,pg_get_userbyid(m.member)::text,pg_get_userbyid(m.grantor)::text),'[]'::jsonb) FROM pg_auth_members m WHERE m.member IN(SELECT role_oid FROM reachable) OR m.roleid IN(SELECT role_oid FROM reachable)))),
 -- RI trigger names contain allocation OIDs. Capture exact semantic FK/function/flags,
 -- including the triggers added to existing parents, without generated names or OIDs.
 'ri',(SELECT coalesce(jsonb_agg(jsonb_build_object('relation',tr.tgrelid::regclass::text,'constraint_relation',con.conrelid::regclass::text,'constraint',con.conname,'definition',pg_get_constraintdef(con.oid,true),'type',tr.tgtype,'enabled',tr.tgenabled,'function',tr.tgfoid::regprocedure::text,'deferrable',tr.tgdeferrable,'deferred',tr.tginitdeferred) ORDER BY tr.tgrelid::regclass::text,con.conrelid::regclass::text,con.conname,tr.tgtype,tr.tgfoid::regprocedure::text),'[]'::jsonb)
 FROM pg_trigger tr JOIN pg_constraint con ON con.oid=tr.tgconstraint JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid WHERE tr.tgisinternal AND ((child.relnamespace='public'::regnamespace AND child.relname=ANY(ARRAY['picking_wave_print_assets','picking_wave_print_previews','print_job_wave_sources'])) OR(parent.relnamespace='public'::regnamespace AND parent.relname=ANY(ARRAY['picking_wave_print_assets','picking_wave_print_previews','print_job_wave_sources']))))
 )
$cooperation171$;
CREATE FUNCTION wave_print177_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $wave177$
DECLARE c public.wave_print177_certificate;f record;b jsonb;live jsonb;expected_body text;leaf_sha text;BEGIN
 IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' OR(SELECT count(*) FROM public.wave_print177_certificate)<>1 THEN RETURN false;END IF;
 SELECT * INTO STRICT c FROM public.wave_print177_certificate WHERE singleton;
 SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO leaf_sha FROM pg_proc WHERE oid='public.wave_print177_valid()'::regprocedure;
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_') AND proname NOT IN('wave_print177_valid','wave_print177_certificate_seal'))<>26
 OR (SELECT jsonb_object_agg(proname,encode(sha256(convert_to(prosrc,'UTF8')),'hex')) FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_') AND proname NOT IN('wave_print177_valid','wave_print177_certificate_seal')) IS DISTINCT FROM '{"wave_print177_asset":"13ecd893f21e6dc69b9f209a9fb1314d0d8d20cfa24b03eda46e42f9548f09e0","wave_print177_basis":"6b4ecaaff76ef59c67ce2d08bc728a59063a974dae274eba2c6af31742ffa8a3","wave_print177_budget":"4d3c69d15632ed69be7e8e0c6d3cb5a73bd1d2aa26024e70a5601ea6fc2041f8","wave_print177_complete":"2801b9e91da64b1ed4c60016b6a02e4f13d55ed490c4869dc316600d5143643d","wave_print177_configuration":"39bdf8121d3f606f274f3bdd230b3cdbb0eb139edb28f7d2b3ae6ef1da357810","wave_print177_history_complete_metadata":"7fa5b2c92d282268416fd3cdaf2d69dbb88fa5a9496f8b620ce45910f9ed4f1d","wave_print177_history_fingerprint":"80d6f1821f5e12843a9345d4f0ccdbcd09d28bf8eb70572cd4d081f9e233af7b","wave_print177_history_function_metadata":"dba44ac4ff065a636ad555b1922e07fb69c1cf5ad52cb7e5723a74f21d81d5b5","wave_print177_history_map":"03c230ff27221510686bd605d2192484d70d18f18a1a6b6a29518abf08ab72e7","wave_print177_history_metadata":"c18c180816ade2952b0dd627432e6691e9a9ba2887c3dffd17f7f2c5b1b1a7de","wave_print177_history_nested172_historical171_valid":"55f4c8fe8faac0663672d954c0e1d9ca7619a86fa4d5ae071dd0f65471be9844","wave_print177_history_nested172_valid":"895db97c95c7d8991a5eef8857c202d458069188dd5c2118e92b9612913b66f2","wave_print177_history_operative_delivery_valid":"22601bec3112ee99b13be456587daf979592ce0c7946789ab7b7013415199b96","wave_print177_history_operative_functions":"d52143fbd2b2bca72f0072c9a2d42a5399134e9ffbf90ab18d4324b36eec8f94","wave_print177_immutable":"502f926d90ca9ba76947110956c572cf7fb95d77b33907591f224ae0360e095d","wave_print177_job_source":"7a0626a7ea1110ea383c9c80dd76b4bef3ffbf6c7b167c738ce5c86c8ab8c5fd","wave_print177_metadata":"196c1ae4f3a9d96189268d9336a7cafb3b6512b085c51370b27b763606fe2817","wave_print177_operative_metadata":"d380f6e027ef08f96701ea50ac6923f8c3446066e783b8ddc5359ad3aae5441a","wave_print177_packed_metadata":"a1913217e59550cc897acdfcef5c9603b8c75d803cd7cbe107787c83c52d8c4f","wave_print177_prepare_frame":"96151f5e5e7423936d06a12cc7eae290e995037342d26bdde0d18dcf9e225ba4","wave_print177_project_operative":"8f71c193014049faabf26cbaa6b20bfb49782d85dafdccbf5c84367049a49d2e","wave_print177_project_packed":"4071b4161a0cf9e71c7193148f6549ee935cc8f79a44f6788d302837c2ec9cc4","wave_print177_queue":"929bd1fc49d901145bddf509c84b36dcc88e2af527359813d1ec93e07ea3e550","wave_print177_render_matches":"807542e6bc941bdeec15eee6705930cf7582f7745451be5d3d55f72151c206a1","wave_print177_require":"7dbf29eaa99e2a371a0535d7f0f65e35dbae79a420d23b8e292ee3b1e3f02e1c","wave_print177_store":"5b7b0ab6344da02c4be7e833073c3fae5bca412cdec0aae9bccc28fd3162bfef"}'::jsonb THEN RETURN false; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.wave_print177_certificate_seal()'::regprocedure) IS DISTINCT FROM 'f0a211e256047a413031819f86acaa5dea7d8d6f1e594135d7947cde9a6e6d38' THEN RETURN false;END IF;
 IF c.profile IS DISTINCT FROM '172-to177-full-wave-print/v1' OR c.originals IS DISTINCT FROM
 jsonb_build_object('156',(SELECT to_jsonb(m) FROM public.packed_label_print_manifest m),'166',(SELECT to_jsonb(m) FROM public.buyer_address_manifest m),
 '167',(SELECT to_jsonb(m) FROM public.operative_delivery_certificate m),'170',(SELECT to_jsonb(m) FROM public.pim_dictionary_manifest m),
 '171',(SELECT to_jsonb(m) FROM public.cooperation171_certificate m),'172',(SELECT to_jsonb(m) FROM public.nested172_certificate m))
 OR c.metadata_after IS DISTINCT FROM jsonb_build_object('own',public.wave_print177_metadata(),'packed',public.wave_print177_packed_metadata(),'operative',public.wave_print177_operative_metadata(),'wrappers',
 (SELECT jsonb_object_agg(sig,public.pim_dictionary_function_metadata(to_regprocedure('public.'||sig))) FROM unnest(ARRAY['pim_dictionary_valid()','cooperation171_valid()','parcel_physical_wz_valid()','operative_delivery_valid()','nested172_valid()','packed_label_print_guards()']) names(sig))) THEN RETURN false;END IF;
 b:=c.functions_before->'pim_dictionary_valid()';
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '15e70233f2034a1b19b049711f24d94d64ea0080c90625bb44ebb1ce49560c7e' THEN RETURN false;END IF;
 expected_body:=overlay(b->>'body' placing 'BEGIN'||replace('
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass(''public.wave_print177_certificate'') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace=''public''::regnamespace AND starts_with(proname,''wave_print177_''))
 OR EXISTS(SELECT FROM public.migrations WHERE name=''177_picking_wave_print'') THEN
  IF to_regprocedure(''public.wave_print177_valid()'') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,''UTF8'')),''hex'') FROM pg_proc WHERE oid=to_regprocedure(''public.wave_print177_valid()'')) IS DISTINCT FROM ''@LEAF_SHA@''
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
 FOR guard_name IN SELECT key FROM jsonb_object_keys(public.pim_dictionary_predecessor_metadata()) keys(key) ORDER BY key LOOP EXECUTE format(''SELECT public.%I()'',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;
  RETURN true;
 END IF;
','@LEAF_SHA@',leaf_sha) from 114 for 5);
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_valid()');
 IF live->>'body' IS DISTINCT FROM expected_body OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'cooperation171_valid()';
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '550e10f6a3be197027f6c988acf6d5d9bd0b5fb7ca0fb1d3f862fdd0fcd08a02' THEN RETURN false;END IF;
 expected_body:=overlay(b->>'body' placing 'BEGIN'||replace('
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass(''public.wave_print177_certificate'') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace=''public''::regnamespace AND starts_with(proname,''wave_print177_''))
 OR EXISTS(SELECT FROM public.migrations WHERE name=''177_picking_wave_print'') THEN
  IF to_regprocedure(''public.wave_print177_valid()'') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,''UTF8'')),''hex'') FROM pg_proc WHERE oid=to_regprocedure(''public.wave_print177_valid()'')) IS DISTINCT FROM ''@LEAF_SHA@''
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;
','@LEAF_SHA@',leaf_sha) from 805 for 5);
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.cooperation171_valid()');
 IF live->>'body' IS DISTINCT FROM expected_body OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'parcel_physical_wz_valid()';
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM 'dffc9ec017d37346c8ae07a828c774ab59a056de102f6877c479e8a07d569443' THEN RETURN false;END IF;
 expected_body:=overlay(b->>'body' placing 'BEGIN'||replace('
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass(''public.wave_print177_certificate'') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace=''public''::regnamespace AND starts_with(proname,''wave_print177_''))
 OR EXISTS(SELECT FROM public.migrations WHERE name=''177_picking_wave_print'') THEN
  IF to_regprocedure(''public.wave_print177_valid()'') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,''UTF8'')),''hex'') FROM pg_proc WHERE oid=to_regprocedure(''public.wave_print177_valid()'')) IS DISTINCT FROM ''@LEAF_SHA@''
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;
','@LEAF_SHA@',leaf_sha) from 1483 for 5);
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.parcel_physical_wz_valid()');
 IF live->>'body' IS DISTINCT FROM expected_body OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'operative_delivery_valid()';
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '21c3d3e1e7ce9a3f34c227abe8ca6d4a588a70c24d9fa44bcfe1e134e0eb60b5' THEN RETURN false;END IF;
 expected_body:=overlay(b->>'body' placing 'BEGIN'||replace('
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass(''public.wave_print177_certificate'') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace=''public''::regnamespace AND starts_with(proname,''wave_print177_''))
 OR EXISTS(SELECT FROM public.migrations WHERE name=''177_picking_wave_print'') THEN
  IF to_regprocedure(''public.wave_print177_valid()'') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,''UTF8'')),''hex'') FROM pg_proc WHERE oid=to_regprocedure(''public.wave_print177_valid()'')) IS DISTINCT FROM ''@LEAF_SHA@''
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;
','@LEAF_SHA@',leaf_sha) from 370 for 5);
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.operative_delivery_valid()');
 IF live->>'body' IS DISTINCT FROM expected_body OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'nested172_valid()';
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '1d3e63bd885f67080c1853096fea874330c8ced95159d9281939121758ba411a' THEN RETURN false;END IF;
 expected_body:=overlay(b->>'body' placing 'BEGIN'||replace('
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass(''public.wave_print177_certificate'') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace=''public''::regnamespace AND starts_with(proname,''wave_print177_''))
 OR EXISTS(SELECT FROM public.migrations WHERE name=''177_picking_wave_print'') THEN
  IF to_regprocedure(''public.wave_print177_valid()'') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,''UTF8'')),''hex'') FROM pg_proc WHERE oid=to_regprocedure(''public.wave_print177_valid()'')) IS DISTINCT FROM ''@LEAF_SHA@''
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;
','@LEAF_SHA@',leaf_sha) from 4727 for 5);
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.nested172_valid()');
 IF live->>'body' IS DISTINCT FROM expected_body OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'packed_label_print_guards()';
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '2105b6b9d0b0b204ef855cae37a027cd38ce7f16211cfcf9ef9fa7d5392bcc5c' THEN RETURN false;END IF;
 expected_body:=overlay(b->>'body' placing 'BEGIN'||replace('
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass(''public.wave_print177_certificate'') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace=''public''::regnamespace AND starts_with(proname,''wave_print177_''))
 OR EXISTS(SELECT FROM public.migrations WHERE name=''177_picking_wave_print'') THEN
  IF to_regprocedure(''public.wave_print177_valid()'') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,''UTF8'')),''hex'') FROM pg_proc WHERE oid=to_regprocedure(''public.wave_print177_valid()'')) IS DISTINCT FROM ''@LEAF_SHA@''
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
 IF public.label_print_guards() IS DISTINCT FROM true OR public.print_job_guards() IS DISTINCT FROM true THEN RETURN false;END IF;
  RETURN true;
 END IF;
','@LEAF_SHA@',leaf_sha) from 1 for 5);
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.packed_label_print_guards()');
 IF live->>'body' IS DISTINCT FROM expected_body OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'print_job_head(jsonb)';
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.print_job_head(jsonb)');
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '1670cea1a6ba692b0a91ff90f336a7dc519a84368fe34d31154848350d93d42c' OR live->>'body' IS DISTINCT FROM '
 SELECT CASE WHEN v->>''source_kind''=''picking_wave'' THEN jsonb_build_object(''wave_id'',v->''wave_id'',''wave_snapshot'',v->''wave_snapshot'') ELSE ''{}''::jsonb END || jsonb_build_object(''id'',v->''id'',''order_id'',v->''order_id'',''order_number'',v->''order_snapshot''->''number'',''station_id'',v->''station_id'',''printer_id'',v->''printer_id'',''order_snapshot'',v->''order_snapshot'',''station_snapshot'',v->''station_snapshot'',''printer_snapshot'',v->''printer_snapshot'',''source_kind'',v->''source_kind'',''format'',v->''format'',''copies'',v->''copies'',''content_sha256'',v->''content_sha256'',''content_bytes'',v->''content_bytes'',''retry_of_job_id'',v->''retry_of_job_id'',''version'',v->>''version'',''state'',v->''state'',''lease_expires_at'',v->''lease_expires_at'',''created_at'',v->''created_at'',''updated_at'',v->''updated_at'')
'
 OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'print_job_command(uuid,jsonb,uuid,uuid,text)';
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.print_job_command(uuid,jsonb,uuid,uuid,text)');
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '8e53ad582fe4b77d1da31d409b814a0b4f2033089f5209ee1784877a422e9549' OR live->>'body' IS DISTINCT FROM '
DECLARE t uuid:=nullif(current_setting(''app.tenant_id'',true),'''')::uuid; j print_jobs; p print_printers; st packing_stations; oid uuid; rh text; old jsonb; beforeh jsonb; outv jsonb; ts timestamptz:=clock_timestamp();
BEGIN
 IF op NOT IN(''claim'',''ack'',''reconcile'') THEN RAISE EXCEPTION ''Niepoprawne polecenie drukowania'' USING ERRCODE=''23514''; END IF;
 PERFORM print_job_lock(); PERFORM print_job_require(uid,kid,true,false,op=''reconcile'');
 rh:=print_job_hash(jsonb_build_object(''tenant_id'',t,''actor_id'',uid,''api_key_id'',kid,''operation'',op,''id'',jid,''request'',v));
 old:=print_job_replay((v->>''client_key'')::uuid,rh,uid,kid,op,jid); IF old IS NOT NULL THEN RETURN old; END IF;
 SELECT order_id INTO oid FROM print_jobs WHERE tenant_id=t AND id=jid;
 IF NOT EXISTS(SELECT FROM print_jobs WHERE tenant_id=t AND id=jid) THEN RAISE EXCEPTION ''Nie znaleziono zadania drukowania'' USING ERRCODE=''P0002''; END IF;
 IF oid IS NULL THEN PERFORM public.wave_print177_job_source(jid,true); ELSE PERFORM 1 FROM orders WHERE tenant_id=t AND id=oid FOR UPDATE; END IF;
 SELECT * INTO j FROM print_jobs WHERE tenant_id=t AND id=jid;
 SELECT * INTO st FROM packing_stations WHERE tenant_id=t AND id=j.station_id FOR UPDATE;
 SELECT * INTO p FROM print_printers WHERE tenant_id=t AND id=j.printer_id FOR UPDATE;
 SELECT * INTO j FROM print_jobs WHERE tenant_id=t AND id=jid FOR UPDATE;
 IF j.version::text IS DISTINCT FROM v->>''version'' THEN RAISE EXCEPTION ''Zadanie drukowania zmieniło się'' USING ERRCODE=''23514''; END IF;
 beforeh:=print_job_head(to_jsonb(j));
 IF op=''claim'' THEN
  IF (v-ARRAY[''client_key'',''version'',''lease_token''])<>''{}''::jsonb OR j.state<>''queued'' OR NOT p.enabled OR NOT st.enabled OR print_job_printer_head(to_jsonb(p)) IS DISTINCT FROM j.printer_snapshot OR jsonb_build_object(''id'',st.id,''code'',st.code,''label'',st.label,''version'',st.version::text,''enabled'',st.enabled) IS DISTINCT FROM j.station_snapshot THEN RAISE EXCEPTION ''Zadanie nie może zostać przejęte w tej konfiguracji'' USING ERRCODE=''23514''; END IF;
  j.lease_hash:=print_job_hash(to_jsonb((v->>''lease_token'')::uuid)); j.claim_actor_id:=uid; j.claim_api_key_id:=kid; j.lease_expires_at:=clock_timestamp()+interval ''90 seconds''; j.state:=''claimed'';
 ELSIF op=''ack'' THEN
  IF (v-ARRAY[''client_key'',''version'',''lease_token'',''result'',''content_sha256'',''artifact_name'',''spool_job_id'',''error_code''])<>''{}''::jsonb OR j.state<>''claimed'' OR j.claim_actor_id IS DISTINCT FROM uid OR j.claim_api_key_id IS DISTINCT FROM kid OR j.lease_hash IS DISTINCT FROM print_job_hash(to_jsonb((v->>''lease_token'')::uuid)) OR j.lease_expires_at<=clock_timestamp() OR j.content_sha256 IS DISTINCT FROM v->>''content_sha256'' THEN RAISE EXCEPTION ''Brak aktywnego własnego lease drukowania'' USING ERRCODE=''23514''; END IF;
  IF ((v->>''result''=''file_saved'' AND j.printer_snapshot->>''output_mode''=''file'' AND (v->>''artifact_name'') ~ ''^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'' AND NOT(v?''spool_job_id'') AND NOT(v?''error_code'')) OR (v->>''result''=''spool_submitted'' AND j.printer_snapshot->>''output_mode''=''cups'' AND (v->>''spool_job_id'') ~ ''^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'' AND NOT(v?''artifact_name'') AND NOT(v?''error_code'')) OR (v->>''result'' IN(''failed'',''unknown'') AND v->>''error_code'' IN(''OUTPUT_FAILED'',''INTERRUPTED'',''UNCONFIRMED'') AND NOT(v?''artifact_name'') AND NOT(v?''spool_job_id''))) IS NOT TRUE THEN RAISE EXCEPTION ''Niepoprawne potwierdzenie drukowania'' USING ERRCODE=''23514''; END IF;
  -- ACK binds the frozen sink, not a later printer configuration.
  IF v->>''result''=''file_saved'' AND j.printer_snapshot->>''output_mode''<>''file'' OR v->>''result''=''spool_submitted'' AND j.printer_snapshot->>''output_mode''<>''cups'' THEN RAISE EXCEPTION ''Wynik nie odpowiada zamrożonemu wyjściu'' USING ERRCODE=''23514''; END IF;
  j.state:=v->>''result'';
 ELSE
  IF (v-ARRAY[''client_key'',''version'',''result'',''confirmed'',''note''])<>''{}''::jsonb OR v->''confirmed'' IS DISTINCT FROM ''true''::jsonb OR jsonb_typeof(v->''note'') IS DISTINCT FROM ''string'' OR length(v->>''note'') NOT BETWEEN 3 AND 500 OR v->>''note'' ~ ''[[:cntrl:]]'' OR ((j.state=''queued'' AND v->>''result''=''cancelled'') OR (j.state=''claimed'' AND j.lease_expires_at<=clock_timestamp() AND v->>''result'' IN(''unknown'',''cancelled''))) IS NOT TRUE THEN RAISE EXCEPTION ''Ręczne rozstrzygnięcie wymaga wygasłego lease lub anulowania kolejki'' USING ERRCODE=''23514''; END IF;
  j.state:=v->>''result'';
 END IF;
 j.version:=j.version+1; j.updated_at:=clock_timestamp();
 outv:=print_job_event(gen_random_uuid(),j.id,NULL,uid,kid,(v->>''client_key'')::uuid,rh,op,beforeh,print_job_head(to_jsonb(j)),v-ARRAY[''client_key'',''version'',''lease_token'']);
 UPDATE print_jobs SET state=j.state,version=j.version,lease_hash=j.lease_hash,claim_actor_id=j.claim_actor_id,claim_api_key_id=j.claim_api_key_id,lease_expires_at=j.lease_expires_at,updated_at=j.updated_at WHERE tenant_id=t AND id=j.id;
 PERFORM print_job_budget(); PERFORM print_job_require(uid,kid,true,false,op=''reconcile''); RETURN outv;
END '
 OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'print_job_budget()';
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.print_job_budget()');
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '920e60f719f783e88ced895779bab75a0b9e0faa708ab1bd63825f82b355a73a' OR live->>'body' IS DISTINCT FROM '
DECLARE t uuid:=nullif(current_setting(''app.tenant_id'',true),'''')::uuid; BEGIN
 PERFORM public.wave_print177_budget();
 IF (SELECT count(*) FROM print_printers WHERE tenant_id=t)>100 OR (SELECT count(*) FROM print_jobs WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_job_events WHERE tenant_id=t)>10000 OR
  coalesce((SELECT sum(octet_length(content_base64)+coalesce(octet_length(order_snapshot::text),0)+coalesce(octet_length(wave_snapshot::text),0)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)>67108864 THEN RAISE EXCEPTION ''Limit historii drukowania'' USING ERRCODE=''23514''; END IF;
END '
 OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
b:=c.functions_before->'label_print_budget()';
 SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.label_print_budget()');
 IF encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM '136a3063d0200728f38c4f06af4a1150879ccff4dd82c51b9f2027be67bbc83c' OR live->>'body' IS DISTINCT FROM '
DECLARE t uuid:=nullif(current_setting(''app.tenant_id'',true),'''')::uuid; n bigint; BEGIN
 PERFORM public.wave_print177_budget();
 PERFORM print_job_budget();
 IF (SELECT count(*) FROM shipment_label_batch_previews WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_batch_executions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION ''Limit historii partii etykiet'' USING ERRCODE=''23514'';END IF;
 IF (SELECT count(*) FROM shipment_label_cache_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM shipment_label_cache_acquisitions WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION ''Limit cache etykiet'' USING ERRCODE=''23514''; END IF;
 IF (SELECT count(*) FROM print_label_assets WHERE tenant_id=t)>2000 OR (SELECT count(*) FROM print_label_previews WHERE tenant_id=t)>2000 OR EXISTS(SELECT 1 FROM print_label_previews WHERE tenant_id=t AND octet_length(payload::text)+octet_length(request::text)>4194304) THEN RAISE EXCEPTION ''Limit historii etykiet drukowania'' USING ERRCODE=''23514''; END IF;
 SELECT coalesce((SELECT sum(octet_length(content_base64)+coalesce(octet_length(order_snapshot::text),0)+coalesce(octet_length(wave_snapshot::text),0)+octet_length(station_snapshot::text)+octet_length(printer_snapshot::text)+512) FROM print_jobs WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(result::text)+octet_length(coalesce(before_head::text,''''))+512) FROM print_job_events WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(to_jsonb(p)::text)) FROM print_printers p WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM print_label_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM print_label_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+512) FROM print_job_label_sources WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(content_encrypted)+octet_length(source_frame::text)+512) FROM shipment_label_cache_assets WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(source_frame::text)+1024) FROM shipment_label_cache_acquisitions WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(combined_content_encrypted)+octet_length(payload::text)+octet_length(request::text)+512) FROM shipment_label_batch_previews WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+512) FROM shipment_label_batch_preview_rows WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+octet_length(request::text)+512) FROM shipment_label_batch_executions WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(payload::text)+512) FROM shipment_label_batch_execution_rows WHERE tenant_id=t),0)+coalesce((SELECT sum(octet_length(request::text)+octet_length(witnesses::text)+512) FROM shipment_label_batch_admissions WHERE tenant_id=t),0) INTO n;
 IF n>67108864 THEN RAISE EXCEPTION ''Limit historii drukowania'' USING ERRCODE=''23514''; END IF;
END '
 OR(live-'body'-'definition') IS DISTINCT FROM(b-'body'-'definition')
 OR replace(live->>'definition',live->>'body',b->>'body') IS DISTINCT FROM b->>'definition' THEN RETURN false;END IF;
 PERFORM public.wave_print177_project_packed(public.wave_print177_packed_metadata(),c.packed_metadata,c.functions_before);
 PERFORM public.wave_print177_project_operative(public.wave_print177_operative_metadata(),c.operative_before,c.functions_before);
 RETURN public.wave_print177_history_nested172_valid() IS TRUE AND public.wave_print177_history_operative_delivery_valid() IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$wave177$;
CREATE OR REPLACE FUNCTION pim_dictionary_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE stored public.pim_dictionary_manifest%ROWTYPE;predecessors_json jsonb;guard_name text;guard_ok boolean;
BEGIN
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass('public.wave_print177_certificate') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='177_picking_wave_print') THEN
  IF to_regprocedure('public.wave_print177_valid()') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.wave_print177_valid()')) IS DISTINCT FROM 'cd77c1cd4b1b4be9d8fbfb1b225299508f9724cc552cb045f5ba710cc84fd666'
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
 FOR guard_name IN SELECT key FROM jsonb_object_keys(public.pim_dictionary_predecessor_metadata()) keys(key) ORDER BY key LOOP EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;
  RETURN true;
 END IF;

 -- Explicit successor172: independent current metadata + bounded semantic certificate.
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'nested172_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json') THEN
  IF to_regclass('public.nested172_certificate') IS NULL OR to_regprocedure('public.nested172_valid()') IS NULL THEN RETURN false;END IF;
  IF(SELECT count(*) FROM public.nested172_certificate)<>1
  OR (SELECT functions FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.nested172_function_map()
  OR (SELECT metadata_hash FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_metadata())
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_function_map()'::regprocedure) IS DISTINCT FROM '453e0ed82a069fba0822490c818c2e2d3b6e29f8bb62a0e608ce10df7b2b4e16'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_metadata()'::regprocedure) IS DISTINCT FROM '5cbd5d4c412d66d0bd355bdf11c1b8726ea5f4954da23adcb654858d0d9ab1e1'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_valid()'::regprocedure) IS DISTINCT FROM '1d3e63bd885f67080c1853096fea874330c8ced95159d9281939121758ba411a'
  OR public.nested172_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
  FOR guard_name IN SELECT key FROM jsonb_object_keys(public.pim_dictionary_predecessor_metadata()) keys(key) ORDER BY key LOOP EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;
  RETURN true;
 END IF;

 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'cooperation171_')) OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'cooperation171_')) OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'cooperation171_')) OR EXISTS(SELECT FROM migrations WHERE name='171_pim_physical_cooperation') THEN

 IF to_regclass('public.cooperation171_certificate') IS NULL OR to_regprocedure('public.cooperation171_valid()') IS NULL
 OR to_regprocedure('public.cooperation171_function_map()') IS NULL THEN RETURN false;END IF;
 IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.cooperation171_function_map()')) IS DISTINCT FROM 'bd023956225b12dc40cc7f0e44c76d9c27699832791627ecb03143faa03691e2' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_function_metadata(oid)')) IS DISTINCT FROM '0c28eea2eb88f0580540770447c3c5173657ee31f651e590e8e7985637e83f7d' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_acl_metadata(aclitem[])')) IS DISTINCT FROM '62f4174d660b9cda131e7f14c9227bc9b3798fa02c74a7c435280957e40ca8ec' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_metadata()')) IS DISTINCT FROM '5d88f934c1a50690c6b7d4ca65f63149b3c44c8d1f95d7b94bc99b919a9b6044' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_hash(jsonb)')) IS DISTINCT FROM '1c04aa00bc03107172b20fa2062483225222e72c7359c34ba29740294fa84502' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_fingerprint()')) IS DISTINCT FROM '7f2ef6dbab3e3797cf6ec21cb66e4fe378adfe7881494f9ca5233132d9e6b3d5' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_predecessor_metadata()')) IS DISTINCT FROM 'd87c40d718b01e962ba9f0520073793f2398bc704a1c8434edf28f48b59391fc' THEN RETURN false;END IF;
 IF(SELECT count(*) FROM public.cooperation171_certificate)<>1 OR(SELECT module_functions FROM public.cooperation171_certificate WHERE singleton) IS DISTINCT FROM public.cooperation171_function_map() THEN RETURN false;END IF;

 IF NOT public.cooperation171_valid() THEN RETURN false;END IF;
 FOR guard_name IN SELECT key FROM jsonb_object_keys(public.pim_dictionary_predecessor_metadata()) keys(key) ORDER BY key LOOP EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;
 RETURN true;END IF;

 IF to_regprocedure('public.pim_dictionary_validate_preview(uuid,uuid)') IS NULL OR to_regprocedure('public.pim_dictionary_validate_operation(uuid,uuid,boolean)') IS NULL THEN RETURN false;END IF;
 SELECT * INTO stored FROM public.pim_dictionary_manifest WHERE singleton;
 IF stored.singleton IS NULL OR (SELECT count(*) FROM public.pim_dictionary_manifest)<>1 OR stored.fingerprint IS DISTINCT FROM public.pim_dictionary_fingerprint() THEN RETURN false;END IF;
 predecessors_json:=public.pim_dictionary_predecessor_metadata();
 IF stored.predecessors IS DISTINCT FROM predecessors_json OR (SELECT count(*) FROM jsonb_object_keys(predecessors_json))<>25 OR EXISTS(SELECT FROM jsonb_each(predecessors_json) predecessor(name,body) WHERE body='null'::jsonb) THEN RETURN false;END IF;
 FOR guard_name IN SELECT key FROM jsonb_object_keys(predecessors_json) keys(key) ORDER BY key LOOP
  EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION cooperation171_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
DECLARE c public.cooperation171_certificate;sig text;b jsonb;a jsonb;live jsonb;pred jsonb;r oid;
 expected_before jsonb:=$bodymap171${"parcel_physical_wz_terminal_prepare()":"47a44cb1bf9da5762a72965f89658fc9a9cde38a28c60a4cd4cda6662e8f18cb","parcel_physical_wz_valid()":"5b45c698ac39ef9cc217c9d721b9adb96242fdd360681bd74036f6bb7215bcbb","pim_dictionary_valid()":"d1b62c7f01376ee904327b69a7a8aea60b5530c7fbcac6d6fb87e7cdedd4e06c"}$bodymap171$::jsonb;
 expected_after jsonb:=$bodymap171${"parcel_physical_wz_terminal_prepare()":"7babdec6465f9fa8279fd24575531673028c7e1c550bfabe11d74ed19ce65db1","parcel_physical_wz_valid()":"bf2a1c9b3dee0fe87da6eba69920bfa42a6b33c65732fd77a7e6af6198987a75","pim_dictionary_valid()":"28ca41934632980b2f0c4e8387ab2aab0b77cf473d59031c5a8b2b2d6c80ae84"}$bodymap171$::jsonb;
BEGIN
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass('public.wave_print177_certificate') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='177_picking_wave_print') THEN
  IF to_regprocedure('public.wave_print177_valid()') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.wave_print177_valid()')) IS DISTINCT FROM 'cd77c1cd4b1b4be9d8fbfb1b225299508f9724cc552cb045f5ba710cc84fd666'
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;

 -- Explicit successor172: independent current metadata + bounded semantic certificate.
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'nested172_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json') THEN
  IF to_regclass('public.nested172_certificate') IS NULL OR to_regprocedure('public.nested172_valid()') IS NULL THEN RETURN false;END IF;
  IF(SELECT count(*) FROM public.nested172_certificate)<>1
  OR (SELECT functions FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.nested172_function_map()
  OR (SELECT metadata_hash FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_metadata())
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_function_map()'::regprocedure) IS DISTINCT FROM '453e0ed82a069fba0822490c818c2e2d3b6e29f8bb62a0e608ce10df7b2b4e16'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_metadata()'::regprocedure) IS DISTINCT FROM '5cbd5d4c412d66d0bd355bdf11c1b8726ea5f4954da23adcb654858d0d9ab1e1'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_valid()'::regprocedure) IS DISTINCT FROM '1d3e63bd885f67080c1853096fea874330c8ced95159d9281939121758ba411a'
  OR public.nested172_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;

 IF current_setting('session_replication_role')<>'origin' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.cooperation171_function_map()')) IS DISTINCT FROM 'bd023956225b12dc40cc7f0e44c76d9c27699832791627ecb03143faa03691e2' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_function_metadata(oid)')) IS DISTINCT FROM '0c28eea2eb88f0580540770447c3c5173657ee31f651e590e8e7985637e83f7d' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_acl_metadata(aclitem[])')) IS DISTINCT FROM '62f4174d660b9cda131e7f14c9227bc9b3798fa02c74a7c435280957e40ca8ec' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_metadata()')) IS DISTINCT FROM '5d88f934c1a50690c6b7d4ca65f63149b3c44c8d1f95d7b94bc99b919a9b6044' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_hash(jsonb)')) IS DISTINCT FROM '1c04aa00bc03107172b20fa2062483225222e72c7359c34ba29740294fa84502' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_fingerprint()')) IS DISTINCT FROM '7f2ef6dbab3e3797cf6ec21cb66e4fe378adfe7881494f9ca5233132d9e6b3d5' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_predecessor_metadata()')) IS DISTINCT FROM 'd87c40d718b01e962ba9f0520073793f2398bc704a1c8434edf28f48b59391fc' THEN RETURN false;END IF;
 IF(SELECT count(*) FROM public.cooperation171_certificate)<>1
 OR(SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'cooperation171_')) IS DISTINCT FROM ARRAY['cooperation171_certificate_seal()','cooperation171_function_map()','cooperation171_metadata()','cooperation171_physical_metadata()','cooperation171_project_metadata(jsonb,jsonb,boolean)','cooperation171_public_drain()','cooperation171_valid()']::text[]
 OR(SELECT array_agg(cl.relname::text ORDER BY cl.relname) FROM pg_class cl WHERE cl.relnamespace='public'::regnamespace AND starts_with(cl.relname,'cooperation171_') AND cl.relkind IN('r','p','v','m','S','f')) IS DISTINCT FROM ARRAY['cooperation171_certificate']::text[] THEN RETURN false;END IF;
 SELECT * INTO c FROM public.cooperation171_certificate WHERE singleton;
 IF c.profile<>'168+170-original-to171-cooperative-public-constraints/v1'
 OR c.original168 IS DISTINCT FROM(SELECT to_jsonb(x) FROM public.parcel_physical_wz_certificate x)
 OR c.original170 IS DISTINCT FROM(SELECT to_jsonb(x) FROM public.pim_dictionary_manifest x)
 OR c.module_functions IS DISTINCT FROM public.cooperation171_function_map()
 OR c.module_fingerprint IS DISTINCT FROM public.pim_dictionary_hash(public.cooperation171_metadata())
 OR c.original168->'original151_manifest' IS DISTINCT FROM(SELECT to_jsonb(x) FROM public.warehouse_wz_issuer_manifest x)
 OR c.original168->'original167_certificate' IS DISTINCT FROM(SELECT to_jsonb(x) FROM public.operative_delivery_certificate x)
 OR c.original168->>'successor151_fingerprint' IS DISTINCT FROM public.warehouse_wz_issuer_fingerprint()
 OR c.original168->'predecessor_triggers' IS DISTINCT FROM public.parcel_physical_wz_predecessor_triggers()
 OR c.original168->'successor_functions' IS DISTINCT FROM public.parcel_physical_wz_predecessor_functions()
 OR c.original168->>'own_fingerprint' IS DISTINCT FROM public.pim_dictionary_hash(c.physical_before)
 OR c.original170->>'fingerprint' IS DISTINCT FROM public.pim_dictionary_hash(c.pim_before)
 OR c.original170->'predecessors' IS DISTINCT FROM c.predecessor_before
 THEN RETURN false;END IF;
 IF(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(c.functions_before) keys(key)) IS DISTINCT FROM ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']::text[]
 OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(c.functions_after) keys(key)) IS DISTINCT FROM ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']::text[] THEN RETURN false;END IF;
 FOR sig IN SELECT key FROM jsonb_object_keys(expected_before) keys(key) LOOP
  b:=c.functions_before->sig;a:=c.functions_after->sig;
  live:=public.pim_dictionary_function_metadata(to_regprocedure('public.'||sig))||(SELECT jsonb_build_object('body',p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||sig));
  IF live IS DISTINCT FROM a OR (b-'body'-'definition') IS DISTINCT FROM(a-'body'-'definition')
  OR replace(a->>'definition',a->>'body',b->>'body') IS DISTINCT FROM b->>'definition'
  OR encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM expected_before->>sig
  OR encode(sha256(convert_to(a->>'body','UTF8')),'hex') IS DISTINCT FROM expected_after->>sig THEN RETURN false;END IF;
 END LOOP;
 IF public.cooperation171_project_metadata(public.cooperation171_physical_metadata(),c.functions_before,true) IS DISTINCT FROM c.physical_before
 OR public.cooperation171_project_metadata(public.pim_dictionary_metadata(),c.functions_before,false) IS DISTINCT FROM c.pim_before
 OR c.successor168_fingerprint IS DISTINCT FROM public.parcel_physical_wz_fingerprint()
 OR c.successor170_fingerprint IS DISTINCT FROM public.pim_dictionary_fingerprint() THEN RETURN false;END IF;
 pred:=public.pim_dictionary_predecessor_metadata();
 IF(SELECT count(*) FROM jsonb_object_keys(pred))<>25 OR EXISTS(SELECT FROM jsonb_each(pred) x(name,value) WHERE value='null'::jsonb)
 OR jsonb_set(pred,'{parcel_physical_wz_valid}',(c.functions_before->'parcel_physical_wz_valid()')-'body') IS DISTINCT FROM c.predecessor_before THEN RETURN false;END IF;
 -- Metadata-only leaf: never invoke full predecessor/PIM/physical/warehouse guards.
 IF EXISTS(SELECT FROM public.migrations WHERE name='171_pim_physical_cooperation') THEN RETURN true;END IF;
 r:=to_regclass('pg_temp.cooperation171_install_basis');IF r IS NULL THEN RETURN false;END IF;
 IF current_user IS DISTINCT FROM session_user OR NOT EXISTS(SELECT FROM pg_class cl WHERE cl.oid=r AND cl.relpersistence='t' AND cl.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT EXISTS(SELECT FROM aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) acl WHERE acl.grantee<>cl.relowner))
 OR(SELECT count(*) FROM pg_temp.cooperation171_install_basis)<>1 THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM pg_temp.cooperation171_install_basis x WHERE x.root_xid=pg_current_xact_id()::text AND x.start_at=transaction_timestamp() AND x.backend_pid=pg_backend_pid() AND x.owner_name=current_user AND x.original168=c.original168 AND x.original170=c.original170 AND x.physical_before=c.physical_before AND x.pim_before=c.pim_before AND x.predecessor_before=c.predecessor_before AND x.functions_before=c.functions_before);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $cooperation171$;
CREATE OR REPLACE FUNCTION parcel_physical_wz_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE cert parcel_physical_wz_certificate;saved jsonb;actual jsonb;n text;expected jsonb:='{"warehouse_wz_issuer_commercial":"ff3a360178eca1e85c623678290a79ca0daf06e0c4d0b6ddff95b2eb5089ab5e","warehouse_wz_issuer_effects":"9d1970aad9edaf4e7fcee867bf59df85184a494ecdfe5478940f7ffd08f660e6","warehouse_wz_issuer_finish":"8197d0956d44b0d1062f1072668a35a76b70b32fda15b5b8ebdc383f94b6d7dc","warehouse_wz_issuer_access":"8a94cd8ce10a17f7fcee6f57209f89619d604f31e31dd57896816b262ab7e1b4","warehouse_wz_issuer_snapshot":"9f07289798db9788263b03e884218faed506b38d127861328815731bae6a0365","warehouse_wz_issuer_prepare":"76ece3a21d4df401cf534ab79b5b14aa037cf30d6bb81fd99d9467a50f0fdd06","warehouse_wz_issuer_record_guard":"22fe527363c170f2fb1527db5193de620ba7be2db1cf9fe067f88c5d11e5d034","warehouse_wz_issuer_complete":"a5956e31f27adf662949905701153bbf4c2729b68b4a1caef8c8499712b5c4ad","warehouse_wz_issuer_source_seal":"3cde51f5df2b882f26474378974b64ed8daac1c6db8dcb0a900f69e35839eb52","warehouse_wz_issuer_hash":"68ce179ff3c4500519f3b13abd83717d93dd70b35bf57195a26e105b3763e013","warehouse_wz_issuer_installed":"813e2ffeefda8491a8ee4f56b43953894d82a0edba20f4803db1b5c0599e1785","warehouse_wz_issuer_fingerprint":"fb6ad23cafc0fc41f0889757bbf892fe4d8f008b00fadba86da411eebb3de663","warehouse_wz_issuer_guards":"d863e8454d576cd10559495dd55cf90eecbd9b58d68c952e443d1cc33ec7deaa","warehouse_wz_issuer_require":"38df95080d4dfded515349e8621b2f9ffae49f10070c9ebbc979478b788ac47e"}'::jsonb;r oid;BEGIN
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass('public.wave_print177_certificate') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='177_picking_wave_print') THEN
  IF to_regprocedure('public.wave_print177_valid()') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.wave_print177_valid()')) IS DISTINCT FROM 'cd77c1cd4b1b4be9d8fbfb1b225299508f9724cc552cb045f5ba710cc84fd666'
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;

 -- Explicit successor172: independent current metadata + bounded semantic certificate.
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'nested172_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json') THEN
  IF to_regclass('public.nested172_certificate') IS NULL OR to_regprocedure('public.nested172_valid()') IS NULL THEN RETURN false;END IF;
  IF(SELECT count(*) FROM public.nested172_certificate)<>1
  OR (SELECT functions FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.nested172_function_map()
  OR (SELECT metadata_hash FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_metadata())
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_function_map()'::regprocedure) IS DISTINCT FROM '453e0ed82a069fba0822490c818c2e2d3b6e29f8bb62a0e608ce10df7b2b4e16'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_metadata()'::regprocedure) IS DISTINCT FROM '5cbd5d4c412d66d0bd355bdf11c1b8726ea5f4954da23adcb654858d0d9ab1e1'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_valid()'::regprocedure) IS DISTINCT FROM '1d3e63bd885f67080c1853096fea874330c8ced95159d9281939121758ba411a'
  OR public.nested172_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;

 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'cooperation171_')) OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'cooperation171_')) OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'cooperation171_')) OR EXISTS(SELECT FROM migrations WHERE name='171_pim_physical_cooperation') THEN

 IF to_regclass('public.cooperation171_certificate') IS NULL OR to_regprocedure('public.cooperation171_valid()') IS NULL
 OR to_regprocedure('public.cooperation171_function_map()') IS NULL THEN RETURN false;END IF;
 IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.cooperation171_function_map()')) IS DISTINCT FROM 'bd023956225b12dc40cc7f0e44c76d9c27699832791627ecb03143faa03691e2' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_function_metadata(oid)')) IS DISTINCT FROM '0c28eea2eb88f0580540770447c3c5173657ee31f651e590e8e7985637e83f7d' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_acl_metadata(aclitem[])')) IS DISTINCT FROM '62f4174d660b9cda131e7f14c9227bc9b3798fa02c74a7c435280957e40ca8ec' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_metadata()')) IS DISTINCT FROM '5d88f934c1a50690c6b7d4ca65f63149b3c44c8d1f95d7b94bc99b919a9b6044' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_hash(jsonb)')) IS DISTINCT FROM '1c04aa00bc03107172b20fa2062483225222e72c7359c34ba29740294fa84502' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_fingerprint()')) IS DISTINCT FROM '7f2ef6dbab3e3797cf6ec21cb66e4fe378adfe7881494f9ca5233132d9e6b3d5' OR (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure('public.pim_dictionary_predecessor_metadata()')) IS DISTINCT FROM 'd87c40d718b01e962ba9f0520073793f2398bc704a1c8434edf28f48b59391fc' THEN RETURN false;END IF;
 IF(SELECT count(*) FROM public.cooperation171_certificate)<>1 OR(SELECT module_functions FROM public.cooperation171_certificate WHERE singleton) IS DISTINCT FROM public.cooperation171_function_map() THEN RETURN false;END IF;

 IF NOT public.cooperation171_valid() THEN RETURN false;END IF;
 RETURN true;END IF;

 IF current_setting('session_replication_role')<>'origin' OR to_regclass('public.parcel_physical_wz_certificate') IS NULL
 OR to_regclass('public.warehouse_wz_issuer_manifest') IS NULL OR to_regclass('public.operative_delivery_certificate') IS NULL
 OR to_regprocedure('public.warehouse_wz_issuer_fingerprint()') IS NULL OR to_regprocedure('public.parcel_physical_wz_fingerprint()') IS NULL
 OR (SELECT count(*) FROM parcel_physical_wz_certificate)<>1
 OR (SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'parcel_physical_wz_') AND relkind IN('r','p'))
 IS DISTINCT FROM ARRAY['parcel_physical_wz_bindings','parcel_physical_wz_certificate','parcel_physical_wz_mappings','parcel_physical_wz_previews']::text[] THEN RETURN false;END IF;
 SELECT * INTO cert FROM parcel_physical_wz_certificate;
 IF jsonb_typeof(cert.original151_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.original167_certificate) IS DISTINCT FROM 'object'
 OR jsonb_typeof(cert.predecessor_functions) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.successor_functions) IS DISTINCT FROM 'object'
 OR jsonb_typeof(cert.predecessor_triggers) IS DISTINCT FROM 'array'
 THEN RETURN false;END IF;
 IF cert.profile<>'151-original-physical-component-successor/v1'
 OR cert.original151_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM warehouse_wz_issuer_manifest m)
 OR cert.original167_certificate IS DISTINCT FROM(SELECT to_jsonb(c) FROM operative_delivery_certificate c)
 OR cert.predecessor_fingerprint IS DISTINCT FROM cert.original151_manifest->>'fingerprint'
 OR cert.successor151_fingerprint IS DISTINCT FROM warehouse_wz_issuer_fingerprint()
 OR cert.own_fingerprint IS DISTINCT FROM parcel_physical_wz_fingerprint()
 OR cert.predecessor_triggers IS DISTINCT FROM parcel_physical_wz_predecessor_triggers()
 OR cert.successor_functions IS DISTINCT FROM parcel_physical_wz_predecessor_functions()
 THEN RETURN false;END IF;
 IF(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(cert.predecessor_functions) k(key)) IS DISTINCT FROM(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected) k(key))
 OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(cert.successor_functions) k(key)) IS DISTINCT FROM(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected) k(key)) THEN RETURN false;END IF;
 FOR n IN SELECT jsonb_object_keys(expected) LOOP
 saved:=cert.predecessor_functions->n;actual:=cert.successor_functions->n;
 IF jsonb_typeof(saved) IS DISTINCT FROM 'object' OR jsonb_typeof(actual) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF encode(sha256(convert_to(saved->>'body','UTF8')),'hex') IS DISTINCT FROM expected->>n THEN RETURN false;END IF;
 IF n=ANY(ARRAY['warehouse_wz_issuer_prepare','warehouse_wz_issuer_commercial','warehouse_wz_issuer_complete','warehouse_wz_issuer_guards']) THEN
 IF(saved-'body'-'definition') IS DISTINCT FROM(actual-'body'-'definition')
 OR replace(actual->>'definition',actual->>'body',saved->>'body') IS DISTINCT FROM saved->>'definition' THEN RETURN false;END IF;
 ELSE IF saved IS DISTINCT FROM actual THEN RETURN false;END IF;END IF;
 END LOOP;
 -- Metadata-only leaf: no ancestor/full guard calls; guarded parent151 invokes it.
 IF EXISTS(SELECT FROM migrations WHERE name='168_physical_parcel_wz') THEN RETURN true;END IF;
 r:=to_regclass('pg_temp.parcel_physical_wz_install_basis');IF r IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM pg_class WHERE oid=r AND relpersistence='t' AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) OR EXISTS(SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=r AND a.grantee<>c.relowner) OR(SELECT count(*) FROM pg_temp.parcel_physical_wz_install_basis)<>1 THEN RETURN false;END IF;
 RETURN current_user=session_user AND EXISTS(SELECT FROM pg_temp.parcel_physical_wz_install_basis b WHERE b.root_xid=pg_current_xact_id()::text AND b.start_at=transaction_timestamp() AND b.backend_pid=pg_backend_pid() AND b.owner_name=current_user
 AND b.original151_manifest=cert.original151_manifest AND b.predecessor_functions=cert.predecessor_functions AND b.predecessor_triggers=cert.predecessor_triggers AND b.original167_certificate=cert.original167_certificate);
EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION operative_delivery_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE cert operative_delivery_certificate;basis record;o oid;n text;expected jsonb:='{"label_print_frame":"d191d4c1280acb4f6c5dec86c23ce72dfce2a5781ad0b0264ed544372454d0c4","order_parcel_source":"5d1ec193a5a147ca758682a3f15ca86c977797717642b833d657397bc4b80fec","packed_label_print_guards":"899a7420b798208ec7350370eb732b98984de00089ec534d7a73f83e1ffcfe0f"}'::jsonb;BEGIN
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass('public.wave_print177_certificate') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='177_picking_wave_print') THEN
  IF to_regprocedure('public.wave_print177_valid()') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.wave_print177_valid()')) IS DISTINCT FROM 'cd77c1cd4b1b4be9d8fbfb1b225299508f9724cc552cb045f5ba710cc84fd666'
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;

 IF current_setting('session_replication_role')<>'origin' OR to_regclass('public.operative_delivery_certificate') IS NULL OR to_regclass('public.operative_delivery_evidence') IS NULL
 OR to_regclass('public.buyer_address_manifest') IS NULL OR to_regclass('public.packed_label_print_manifest') IS NULL
 OR to_regclass('public.migrations') IS NULL
 OR to_regprocedure('public.operative_delivery_fingerprint()') IS NULL OR to_regprocedure('public.operative_delivery_functions()') IS NULL
 OR to_regprocedure('public.packed_label_print_fingerprint()') IS NULL
 OR to_regprocedure('public.buyer_address_fingerprint()') IS NULL OR to_regprocedure('public.buyer_address_predecessors()') IS NULL
 OR NOT EXISTS(SELECT FROM migrations WHERE name='156_packed_label_print') OR NOT EXISTS(SELECT FROM migrations WHERE name='166_buyer_address_sidecar')
 OR (SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'operative_delivery_') AND relkind IN('r','p')) IS DISTINCT FROM ARRAY['operative_delivery_certificate','operative_delivery_evidence']::text[]
 OR (SELECT count(*) FROM operative_delivery_certificate)<>1 THEN RETURN false;END IF;
 SELECT * INTO cert FROM operative_delivery_certificate;
 IF jsonb_typeof(cert.predecessor_functions) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.successor_functions) IS DISTINCT FROM 'object'
 OR jsonb_typeof(cert.original156_manifest) IS DISTINCT FROM 'object' OR jsonb_typeof(cert.original166_manifest) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF cert.profile IS DISTINCT FROM '156-original-to167-operational-receiver/v1'
 OR cert.original156_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM packed_label_print_manifest m)
 OR cert.original166_manifest IS DISTINCT FROM(SELECT to_jsonb(m) FROM buyer_address_manifest m)
 OR cert.original166_manifest->>'fingerprint' IS DISTINCT FROM buyer_address_fingerprint()
 OR cert.original166_manifest->'predecessor_certificates' IS DISTINCT FROM buyer_address_predecessors()
 OR cert.original156_fingerprint IS DISTINCT FROM cert.original156_manifest->>'fingerprint'
 OR cert.successor156_fingerprint IS DISTINCT FROM packed_label_print_fingerprint()
 OR cert.successor_functions IS DISTINCT FROM operative_delivery_functions()
 OR cert.own_fingerprint IS DISTINCT FROM operative_delivery_fingerprint()
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(cert.predecessor_functions) keys(key)) IS DISTINCT FROM ARRAY['label_print_frame','order_parcel_source','packed_label_print_fingerprint','packed_label_print_guards']::text[]
 THEN RETURN false;END IF;
 FOR n IN SELECT jsonb_object_keys(expected) LOOP
 IF encode(sha256(convert_to(cert.predecessor_functions->n->>'body','UTF8')),'hex') IS DISTINCT FROM expected->>n
 OR ((cert.predecessor_functions->n)-'definition'-'body') IS DISTINCT FROM((cert.successor_functions->n)-'definition'-'body')
 THEN RETURN false;END IF;END LOOP;
 IF cert.predecessor_functions->'packed_label_print_fingerprint' IS DISTINCT FROM cert.successor_functions->'packed_label_print_fingerprint' THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM migrations WHERE name='167_operational_delivery_consumers') THEN RETURN true;END IF;
 o:=to_regclass('pg_temp.operative_delivery_install_basis');IF o IS NULL THEN RETURN false;END IF;
 IF (SELECT relowner FROM pg_class WHERE oid=o) IS DISTINCT FROM(SELECT relowner FROM pg_class WHERE oid='public.operative_delivery_certificate'::regclass)
 OR current_user IS DISTINCT FROM session_user OR session_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=o)
 THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_temp.operative_delivery_install_basis)<>1 THEN RETURN false;END IF;
 SELECT * INTO basis FROM pg_temp.operative_delivery_install_basis;
 RETURN(basis.root_xid,basis.start_at,basis.backend_pid,basis.owner_name,basis.original156_manifest,basis.original166_manifest,basis.predecessor_functions)
 IS NOT DISTINCT FROM(pg_current_xact_id()::text,transaction_timestamp(),pg_backend_pid(),session_user::text,cert.original156_manifest,cert.original166_manifest,cert.predecessor_functions);
END $$;
CREATE OR REPLACE FUNCTION nested172_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $nested172$
DECLARE c public.nested172_certificate;sig text;b jsonb;a jsonb;live jsonb;r oid;pos integer;expected_body text;leaf_hash text;props jsonb;catalog_function record;owner_oid oid;
 expected_before jsonb:=$maps172${"cooperation171_valid()":"78d0a9370e952f558e103e17ecce97e597fb49c30388146a9272d33c91ea551c","parcel_physical_wz_valid()":"bf2a1c9b3dee0fe87da6eba69920bfa42a6b33c65732fd77a7e6af6198987a75","pim_dictionary_source_json_valid(jsonb)":"a1f31014172bd11735bf7987a4e6c95ae3fc92e00e0e57becd9783cd63c044ce","pim_dictionary_valid()":"28ca41934632980b2f0c4e8387ab2aab0b77cf473d59031c5a8b2b2d6c80ae84"}$maps172$::jsonb;
 expected_prefix text:=$prefix172$
 -- Explicit successor172: independent current metadata + bounded semantic certificate.
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'nested172_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json') THEN
  IF to_regclass('public.nested172_certificate') IS NULL OR to_regprocedure('public.nested172_valid()') IS NULL THEN RETURN false;END IF;
  IF(SELECT count(*) FROM public.nested172_certificate)<>1
  OR (SELECT functions FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.nested172_function_map()
  OR (SELECT metadata_hash FROM public.nested172_certificate WHERE singleton) IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_metadata())
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_function_map()'::regprocedure) IS DISTINCT FROM '453e0ed82a069fba0822490c818c2e2d3b6e29f8bb62a0e608ce10df7b2b4e16'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_metadata()'::regprocedure) IS DISTINCT FROM '5cbd5d4c412d66d0bd355bdf11c1b8726ea5f4954da23adcb654858d0d9ab1e1'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.nested172_valid()'::regprocedure) IS DISTINCT FROM '@VALID_SHA@'
  OR public.nested172_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
@ANCESTORS@
  RETURN true;
 END IF;
$prefix172$;
 expected_helpers jsonb:=$helperprops172${"nested172_function_map()":{"body_sha256":"453e0ed82a069fba0822490c818c2e2d3b6e29f8bb62a0e608ce10df7b2b4e16","language":"sql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"jsonb"},"nested172_metadata()":{"body_sha256":"5cbd5d4c412d66d0bd355bdf11c1b8726ea5f4954da23adcb654858d0d9ab1e1","language":"sql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"jsonb"},"nested172_json_valid(jsonb)":{"body_sha256":"c7ade40cb5364ffcc2e4d41046dec98b0bc12491dcf58ee80b0e06e9e6d22c67","language":"plpgsql","volatility":"i","security_definer":false,"configuration":["search_path=pg_catalog,public"],"argument_names":["tree"],"result":"boolean"},"nested172_legacy_function(text)":{"body_sha256":"dd6daca64315c5a0e10a16ed2b461d7ee789afd9014a88e1e9f3d764f7028070","language":"sql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public"],"argument_names":["sig"],"result":"jsonb"},"nested172_project_metadata(jsonb,text)":{"body_sha256":"bbc7b65aab433aaf227c5c477b34a721aec26e984af727d8657eb6ac517ebc0f","language":"plpgsql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public"],"argument_names":["actual","family"],"result":"jsonb"},"nested172_historical171_valid()":{"body_sha256":"cbd07394957d31370ec788d5cb6cf1ca72c37ca950c934d57d45d69ecc12933a","language":"plpgsql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"boolean"},"nested172_valid()":{"body_sha256":null,"language":"plpgsql","volatility":"s","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"boolean"},"nested172_certificate_seal()":{"body_sha256":"6a2e6a7e296259485fca14dae4d38f9edf655496d4913609d6125c0fc9be1276","language":"plpgsql","volatility":"v","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"trigger"},"nested172_validate_recovered()":{"body_sha256":"94d6f4150ba410657f67bbdcbe77b528001aebf010253ac6e404d394622cc414","language":"plpgsql","volatility":"v","security_definer":true,"configuration":["search_path=pg_catalog,public","TimeZone=UTC"],"argument_names":null,"result":"jsonb"}}$helperprops172$::jsonb;
BEGIN
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass('public.wave_print177_certificate') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='177_picking_wave_print') THEN
  IF to_regprocedure('public.wave_print177_valid()') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.wave_print177_valid()')) IS DISTINCT FROM 'cd77c1cd4b1b4be9d8fbfb1b225299508f9724cc552cb045f5ba710cc84fd666'
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;

  RETURN true;
 END IF;

 IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' OR(SELECT count(*) FROM public.nested172_certificate)<>1 THEN RETURN false;END IF;
 SELECT * INTO STRICT c FROM public.nested172_certificate WHERE singleton;
 SELECT relowner INTO STRICT owner_oid FROM pg_class WHERE oid='public.nested172_certificate'::regclass;
 SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO leaf_hash FROM pg_proc WHERE oid='public.nested172_valid()'::regprocedure;
 IF pg_get_userbyid(owner_oid) IS DISTINCT FROM c.functions_before->'cooperation171_valid()'->>'owner'
 OR(SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'nested172_'))
 IS DISTINCT FROM(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(expected_helpers) keys(key)) THEN RETURN false;END IF;
 IF(SELECT array_agg(relname::text ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_') AND relkind IN('r','p','v','m','S','f')) IS DISTINCT FROM ARRAY['nested172_certificate']::text[]
 OR NOT EXISTS(SELECT FROM pg_class WHERE oid='public.nested172_certificate'::regclass AND relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity)
 OR EXISTS(SELECT FROM aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid='public.nested172_certificate'::regclass),acldefault('r',owner_oid))) acl WHERE acl.grantee<>owner_oid OR acl.grantor<>owner_oid OR acl.is_grantable)
 OR EXISTS(SELECT FROM pg_policy WHERE polrelid='public.nested172_certificate'::regclass)
 OR(SELECT count(*) FROM pg_attribute WHERE attrelid='public.nested172_certificate'::regclass AND attnum>0 AND NOT attisdropped)<>12
 OR(SELECT count(*) FROM pg_attribute WHERE attrelid='public.nested172_certificate'::regclass AND attnum>0 AND NOT attisdropped AND attnotnull)<>12
 OR(SELECT count(*) FROM pg_constraint WHERE conrelid='public.nested172_certificate'::regclass AND contype='c' AND convalidated AND NOT condeferrable)<>12
 OR(SELECT count(*) FROM pg_constraint WHERE conrelid='public.nested172_certificate'::regclass AND contype<>'n')<>13
 OR(SELECT count(*) FROM pg_constraint WHERE conrelid='public.nested172_certificate'::regclass AND contype='n')<>12
 OR(SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.nested172_certificate'::regclass AND attnum>0 AND NOT attisdropped)
 IS DISTINCT FROM ARRAY['singleton','profile','originals','functions_before','functions_after','pim_before','physical_before','cooperation_before','predecessors_before','functions','metadata_hash','created_at']::text[]
 OR EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid='public.nested172_certificate'::regclass AND a.attnum>0 AND NOT a.attisdropped
  AND(a.atttypid IS DISTINCT FROM(CASE WHEN a.attnum=1 THEN 'boolean'::regtype WHEN a.attnum IN(2,11) THEN 'text'::regtype WHEN a.attnum=12 THEN 'timestamptz'::regtype ELSE 'jsonb'::regtype END)::oid
   OR NOT a.attnotnull OR a.attidentity<>'' OR a.attgenerated<>'' OR a.atthasdef
   OR NOT EXISTS(SELECT FROM pg_constraint n WHERE n.conrelid=a.attrelid AND n.contype='n' AND n.conkey=ARRAY[a.attnum]::smallint[]
    AND(to_jsonb(n)-'oid') IS NOT DISTINCT FROM jsonb_build_object(
     'conname','nested172_certificate_'||a.attname||'_not_null','connamespace','public'::regnamespace::oid,'contype','n',
     'condeferrable',false,'condeferred',false,'conenforced',true,'convalidated',true,'conrelid',a.attrelid,'contypid',0::oid,
     'conindid',0::oid,'conparentid',0::oid,'confrelid',0::oid,'confupdtype',' ','confdeltype',' ','confmatchtype',' ',
     'conislocal',true,'coninhcount',0,'connoinherit',false,'conperiod',false,'conkey',ARRAY[a.attnum]::smallint[],
     'confkey',NULL,'conpfeqop',NULL,'conppeqop',NULL,'conffeqop',NULL,'confdelsetcols',NULL,'conexclop',NULL,'conbin',NULL)
    AND pg_get_constraintdef(n.oid,true) IS NOT DISTINCT FROM 'NOT NULL '||quote_ident(a.attname))))
 OR(SELECT count(*) FROM pg_index WHERE indrelid='public.nested172_certificate'::regclass AND indisprimary AND indisvalid AND indisready)<>1
 OR(SELECT count(*) FROM pg_index WHERE indrelid='public.nested172_certificate'::regclass)<>1
 OR(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND(starts_with(tgname,'nested172_') OR tgrelid='public.nested172_certificate'::regclass))<>1
 OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.nested172_certificate'::regclass AND tgname='nested172_certificate_seal' AND tgtype=31 AND tgenabled='O' AND tgfoid='public.nested172_certificate_seal()'::regprocedure AND tgqual IS NULL AND tgnargs=0)
 THEN RETURN false;END IF;
 FOR sig,props IN SELECT key,value FROM jsonb_each(expected_helpers) entries(key,value) LOOP
  SELECT p.*,l.lanname INTO STRICT catalog_function FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.'||sig);
  IF catalog_function.proowner IS DISTINCT FROM owner_oid OR catalog_function.lanname IS DISTINCT FROM props->>'language'
  OR catalog_function.provolatile::text IS DISTINCT FROM props->>'volatility' OR catalog_function.prosecdef IS DISTINCT FROM(props->>'security_definer')::boolean
  OR catalog_function.proisstrict OR catalog_function.proleakproof OR catalog_function.proparallel<>'u' OR catalog_function.prokind<>'f' OR catalog_function.proretset
  OR catalog_function.procost<>100 OR catalog_function.prorows<>0 OR catalog_function.proargmodes IS NOT NULL OR catalog_function.proargdefaults IS NOT NULL
  OR to_jsonb(catalog_function.proargnames) IS DISTINCT FROM nullif(props->'argument_names','null'::jsonb)
  OR pg_get_function_result(catalog_function.oid) IS DISTINCT FROM props->>'result'
  OR(SELECT jsonb_agg(replace(setting,' ','' ) ORDER BY ordinal) FROM unnest(catalog_function.proconfig) WITH ORDINALITY config(setting,ordinal)) IS DISTINCT FROM props->'configuration'
  OR(sig<>'nested172_valid()' AND encode(sha256(convert_to(catalog_function.prosrc,'UTF8')),'hex') IS DISTINCT FROM props->>'body_sha256')
  OR EXISTS(SELECT FROM aclexplode(coalesce(catalog_function.proacl,acldefault('f',owner_oid))) acl WHERE acl.grantee<>owner_oid OR acl.grantor<>owner_oid OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable)
  OR NOT EXISTS(SELECT FROM aclexplode(coalesce(catalog_function.proacl,acldefault('f',owner_oid))) acl WHERE acl.grantee=owner_oid AND acl.privilege_type='EXECUTE') THEN RETURN false;END IF;
 END LOOP;
 IF c.profile IS DISTINCT FROM '171-to172-nested-legacy-finite-json/v2' OR NOT isfinite(c.created_at)
 OR jsonb_typeof(c.functions_before) IS DISTINCT FROM 'object' OR jsonb_typeof(c.functions_after) IS DISTINCT FROM 'object'
 OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(c.functions_before) k(key)) IS DISTINCT FROM ARRAY['cooperation171_valid()','parcel_physical_wz_valid()','pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']::text[]
 OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(c.functions_after) k(key)) IS DISTINCT FROM ARRAY['cooperation171_valid()','parcel_physical_wz_valid()','pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']::text[]
 OR c.originals IS DISTINCT FROM jsonb_build_object('168',(SELECT to_jsonb(x) FROM public.parcel_physical_wz_certificate x),'170',(SELECT to_jsonb(x) FROM public.pim_dictionary_manifest x),'171',(SELECT to_jsonb(x) FROM public.cooperation171_certificate x))
 OR c.functions IS DISTINCT FROM public.nested172_function_map()
 OR c.metadata_hash IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_metadata()) THEN RETURN false;END IF;
 FOR sig IN SELECT key FROM jsonb_object_keys(expected_before) k(key) LOOP
  b:=c.functions_before->sig;a:=c.functions_after->sig;
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
  OR jsonb_typeof(b->'body') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'body') IS DISTINCT FROM 'string'
  OR jsonb_typeof(b->'definition') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'definition') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  SELECT public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||sig);
  IF sig='pim_dictionary_source_json_valid(jsonb)' THEN
   IF encode(sha256(convert_to(a->>'body','UTF8')),'hex') IS DISTINCT FROM '9e45af1a545bef9c6557f59df22223094d3ab3f056721924466eaccadeb8d512' THEN RETURN false;END IF;
  ELSE
   pos:=strpos(b->>'body','BEGIN');IF pos<1 THEN RETURN false;END IF;
   expected_body:=overlay(b->>'body' placing 'BEGIN'||replace(expected_prefix,'@VALID_SHA@',leaf_hash) from pos for 5);
   IF sig='pim_dictionary_valid()' THEN
    expected_body:=replace(expected_body,'@ANCESTORS@','  FOR guard_name IN SELECT key FROM jsonb_object_keys(public.pim_dictionary_predecessor_metadata()) keys(key) ORDER BY key LOOP EXECUTE format(''SELECT public.%I()'',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;');
   ELSE expected_body:=replace(expected_body,'@ANCESTORS@','');END IF;
   IF a->>'body' IS DISTINCT FROM expected_body THEN RETURN false;END IF;
  END IF;
  IF live IS DISTINCT FROM a OR(b-'body'-'definition') IS DISTINCT FROM(a-'body'-'definition')
  OR replace(a->>'definition',a->>'body',b->>'body') IS DISTINCT FROM b->>'definition'
  OR encode(sha256(convert_to(b->>'body','UTF8')),'hex') IS DISTINCT FROM expected_before->>sig THEN RETURN false;END IF;
 END LOOP;
 IF public.nested172_project_metadata(public.pim_dictionary_metadata(),'pim') IS DISTINCT FROM c.pim_before
 OR public.nested172_project_metadata(public.cooperation171_physical_metadata(),'physical') IS DISTINCT FROM c.physical_before
 OR public.nested172_project_metadata(public.cooperation171_metadata(),'cooperation') IS DISTINCT FROM c.cooperation_before
 OR public.nested172_project_metadata(public.pim_dictionary_predecessor_metadata(),'predecessors') IS DISTINCT FROM c.predecessors_before
 OR public.nested172_historical171_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
 -- This leaf NEVER calls a parent/full guard; PIM wrapper invokes all25 separately.
 IF EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json') THEN RETURN true;END IF;
 r:=to_regclass('pg_temp.nested172_install_basis');IF r IS NULL THEN RETURN false;END IF;
 IF current_user IS DISTINCT FROM session_user OR NOT EXISTS(SELECT FROM pg_class cl WHERE cl.oid=r AND cl.relpersistence='t' AND cl.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
 AND NOT EXISTS(SELECT FROM aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) a WHERE a.grantee<>cl.relowner))
 OR(SELECT count(*) FROM pg_temp.nested172_install_basis)<>1 THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM pg_temp.nested172_install_basis x WHERE x.root_xid=pg_current_xact_id()::text AND x.started_at=transaction_timestamp() AND x.backend_pid=pg_backend_pid() AND x.owner_name=current_user
 AND x.originals=c.originals AND x.functions_before=c.functions_before AND x.pim_before=c.pim_before AND x.physical_before=c.physical_before AND x.cooperation_before=c.cooperation_before AND x.predecessors_before=c.predecessors_before);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $nested172$;
CREATE OR REPLACE FUNCTION packed_label_print_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 -- Explicit177 successor; never a cached current IAM/data decision.
 IF to_regclass('public.wave_print177_certificate') IS NOT NULL
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_'))
 OR EXISTS(SELECT FROM public.migrations WHERE name='177_picking_wave_print') THEN
  IF to_regprocedure('public.wave_print177_valid()') IS NULL
  OR(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.wave_print177_valid()')) IS DISTINCT FROM 'cd77c1cd4b1b4be9d8fbfb1b225299508f9724cc552cb045f5ba710cc84fd666'
  OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;
 IF public.label_print_guards() IS DISTINCT FROM true OR public.print_job_guards() IS DISTINCT FROM true THEN RETURN false;END IF;
  RETURN true;
 END IF;

 IF current_setting('session_replication_role')<>'origin' OR NOT EXISTS(SELECT 1 FROM migrations WHERE name='156_packed_label_print') OR EXISTS(SELECT 1 FROM unnest(ARRAY['packed_label_print_previews','packed_label_print_configurations','packed_label_print_intents','packed_label_print_admissions','packed_label_print_manifest','print_printers','print_jobs','print_job_events','print_label_assets','print_label_previews','print_job_label_sources','packing_stations','packing_cartons','packing_policies','packing_sessions','packing_operations','packing_previews','packing_receipts','order_packing_profiles']) n WHERE to_regclass(n) IS NULL) OR EXISTS(SELECT 1 FROM unnest(ARRAY['packed_label_print_require', 'packed_label_print_configuration_frame', 'packed_label_print_preview', 'packed_label_print_approve', 'packed_label_print_capture', 'packed_label_print_resolve_frame', 'packed_label_print_admit', 'packed_label_print_queue_allowed', 'packed_label_print_finish', 'packed_label_print_complete', 'packed_label_print_immutable', 'label_print_queue', 'label_print_guard', 'packed_label_print_capture_trigger', 'print_job_installed', 'print_job_access', 'print_job_require', 'print_job_hash', 'print_job_head', 'print_job_printer_head', 'print_job_lock', 'print_job_budget', 'print_job_content_valid', 'print_job_replay', 'print_job_event', 'print_job_printer_write', 'print_job_create', 'print_job_command', 'print_job_content', 'print_job_immutable', 'print_job_guard', 'print_job_complete', 'print_job_guards', 'label_print_installed', 'label_print_require', 'label_print_frame', 'label_print_configuration', 'label_print_preview_replay', 'label_print_store_preview', 'label_print_asset', 'label_print_queue_replay', 'label_print_budget', 'label_print_immutable', 'label_print_budget_trigger', 'label_print_seal', 'label_print_guards', 'packing_current_role', 'packing_key_grant', 'packing_operator_names', 'packing_fulfillment_snapshot', 'packing_fulfillment_hash', 'packing_row_guard', 'packing_budget_guard', 'packing_receipt_after_guard', 'packing_insert_admission', 'packing_scope_guard', 'packing_update_admission','packed_label_print_fingerprint','packed_label_print_guards']) n WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=n)) THEN RETURN false;END IF;
 RETURN label_print_guards() AND print_job_guards() AND operative_delivery_valid();END $$;

CREATE FUNCTION wave_print177_certificate_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $wave177$
DECLARE x record;BEGIN
 IF TG_OP<>'INSERT' OR EXISTS(SELECT FROM public.wave_print177_certificate) OR to_regclass('pg_temp.wave_print177_install_basis') IS NULL
 OR current_user IS DISTINCT FROM session_user OR NOT EXISTS(SELECT FROM pg_class WHERE oid='pg_temp.wave_print177_install_basis'::regclass AND relpersistence='t' AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 THEN RAISE EXCEPTION '177 certificate is immutable/install-owned' USING ERRCODE='55000';END IF;
 SELECT * INTO STRICT x FROM pg_temp.wave_print177_install_basis;
 IF(x.root_xid,x.started_at,x.backend_pid,x.owner_name) IS DISTINCT FROM(pg_current_xact_id()::text,transaction_timestamp(),pg_backend_pid(),current_user::text)
 OR(NEW.originals,NEW.functions_before,NEW.packed_metadata,NEW.packed_before,NEW.operative_before) IS DISTINCT FROM(x.originals,x.functions_before,x.packed_metadata,x.packed_before,x.operative_before)
 OR NEW.metadata_after IS DISTINCT FROM jsonb_build_object('own',public.wave_print177_metadata(),'packed',public.wave_print177_packed_metadata(),'operative',public.wave_print177_operative_metadata(),'wrappers',
 (SELECT jsonb_object_agg(sig,public.pim_dictionary_function_metadata(to_regprocedure('public.'||sig))) FROM unnest(ARRAY['pim_dictionary_valid()','cooperation171_valid()','parcel_physical_wz_valid()','operative_delivery_valid()','nested172_valid()','packed_label_print_guards()']) names(sig)))
 THEN RAISE EXCEPTION '177 install custody mismatch' USING ERRCODE='55000';END IF;
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_') AND proname NOT IN('wave_print177_valid','wave_print177_certificate_seal'))<>26
 OR (SELECT jsonb_object_agg(proname,encode(sha256(convert_to(prosrc,'UTF8')),'hex')) FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_') AND proname NOT IN('wave_print177_valid','wave_print177_certificate_seal')) IS DISTINCT FROM '{"wave_print177_asset":"13ecd893f21e6dc69b9f209a9fb1314d0d8d20cfa24b03eda46e42f9548f09e0","wave_print177_basis":"6b4ecaaff76ef59c67ce2d08bc728a59063a974dae274eba2c6af31742ffa8a3","wave_print177_budget":"4d3c69d15632ed69be7e8e0c6d3cb5a73bd1d2aa26024e70a5601ea6fc2041f8","wave_print177_complete":"2801b9e91da64b1ed4c60016b6a02e4f13d55ed490c4869dc316600d5143643d","wave_print177_configuration":"39bdf8121d3f606f274f3bdd230b3cdbb0eb139edb28f7d2b3ae6ef1da357810","wave_print177_history_complete_metadata":"7fa5b2c92d282268416fd3cdaf2d69dbb88fa5a9496f8b620ce45910f9ed4f1d","wave_print177_history_fingerprint":"80d6f1821f5e12843a9345d4f0ccdbcd09d28bf8eb70572cd4d081f9e233af7b","wave_print177_history_function_metadata":"dba44ac4ff065a636ad555b1922e07fb69c1cf5ad52cb7e5723a74f21d81d5b5","wave_print177_history_map":"03c230ff27221510686bd605d2192484d70d18f18a1a6b6a29518abf08ab72e7","wave_print177_history_metadata":"c18c180816ade2952b0dd627432e6691e9a9ba2887c3dffd17f7f2c5b1b1a7de","wave_print177_history_nested172_historical171_valid":"55f4c8fe8faac0663672d954c0e1d9ca7619a86fa4d5ae071dd0f65471be9844","wave_print177_history_nested172_valid":"895db97c95c7d8991a5eef8857c202d458069188dd5c2118e92b9612913b66f2","wave_print177_history_operative_delivery_valid":"22601bec3112ee99b13be456587daf979592ce0c7946789ab7b7013415199b96","wave_print177_history_operative_functions":"d52143fbd2b2bca72f0072c9a2d42a5399134e9ffbf90ab18d4324b36eec8f94","wave_print177_immutable":"502f926d90ca9ba76947110956c572cf7fb95d77b33907591f224ae0360e095d","wave_print177_job_source":"7a0626a7ea1110ea383c9c80dd76b4bef3ffbf6c7b167c738ce5c86c8ab8c5fd","wave_print177_metadata":"196c1ae4f3a9d96189268d9336a7cafb3b6512b085c51370b27b763606fe2817","wave_print177_operative_metadata":"d380f6e027ef08f96701ea50ac6923f8c3446066e783b8ddc5359ad3aae5441a","wave_print177_packed_metadata":"a1913217e59550cc897acdfcef5c9603b8c75d803cd7cbe107787c83c52d8c4f","wave_print177_prepare_frame":"96151f5e5e7423936d06a12cc7eae290e995037342d26bdde0d18dcf9e225ba4","wave_print177_project_operative":"8f71c193014049faabf26cbaa6b20bfb49782d85dafdccbf5c84367049a49d2e","wave_print177_project_packed":"4071b4161a0cf9e71c7193148f6549ee935cc8f79a44f6788d302837c2ec9cc4","wave_print177_queue":"929bd1fc49d901145bddf509c84b36dcc88e2af527359813d1ec93e07ea3e550","wave_print177_render_matches":"807542e6bc941bdeec15eee6705930cf7582f7745451be5d3d55f72151c206a1","wave_print177_require":"7dbf29eaa99e2a371a0535d7f0f65e35dbae79a420d23b8e292ee3b1e3f02e1c","wave_print177_store":"5b7b0ab6344da02c4be7e833073c3fae5bca412cdec0aae9bccc28fd3162bfef"}'::jsonb THEN RAISE EXCEPTION '177 source body custody' USING ERRCODE='55000'; END IF;
 PERFORM public.wave_print177_project_packed(public.wave_print177_packed_metadata(),x.packed_metadata,x.functions_before);
 PERFORM public.wave_print177_project_operative(public.wave_print177_operative_metadata(),x.operative_before,x.functions_before);RETURN NEW;
END $wave177$;
CREATE TRIGGER wave_print177_certificate_seal BEFORE INSERT OR UPDATE OR DELETE ON public.wave_print177_certificate FOR EACH ROW EXECUTE FUNCTION public.wave_print177_certificate_seal();
DO $wave177$ DECLARE p regprocedure;BEGIN FOR p IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'wave_print177_') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p);END LOOP;END $wave177$;
GRANT EXECUTE ON FUNCTION wave_print177_valid(),wave_print177_require(uuid,uuid,boolean,boolean),wave_print177_prepare_frame(uuid,jsonb,uuid,uuid),wave_print177_basis(uuid,uuid,uuid,boolean),wave_print177_store(uuid,jsonb,uuid,uuid),wave_print177_asset(uuid,uuid,uuid),wave_print177_queue(uuid,jsonb,text,uuid,uuid) TO dyna_app;
INSERT INTO public.wave_print177_certificate SELECT true,'172-to177-full-wave-print/v1',originals,functions_before,packed_metadata,packed_before,operative_before,
 jsonb_build_object('own',public.wave_print177_metadata(),'packed',public.wave_print177_packed_metadata(),'operative',public.wave_print177_operative_metadata(),'wrappers',
 (SELECT jsonb_object_agg(sig,public.pim_dictionary_function_metadata(to_regprocedure('public.'||sig))) FROM unnest(ARRAY['pim_dictionary_valid()','cooperation171_valid()','parcel_physical_wz_valid()','operative_delivery_valid()','nested172_valid()','packed_label_print_guards()']) names(sig))),transaction_timestamp()
 FROM pg_temp.wave_print177_install_basis;
DO $wave177$ BEGIN IF public.wave_print177_valid() IS DISTINCT FROM true OR public.pim_dictionary_valid() IS DISTINCT FROM true OR public.nested172_valid() IS DISTINCT FROM true
 THEN RAISE EXCEPTION '177 full successor final check refused' USING ERRCODE='55000';END IF;END $wave177$;

