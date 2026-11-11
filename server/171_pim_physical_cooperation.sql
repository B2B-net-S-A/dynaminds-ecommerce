-- SOURCE_AUTHOR candidate171: NOT_RESERVED, NOT_REGISTERED, NOT_EXECUTED.
-- Exactly three existing same-OID body replacements; original168/170 certificates remain literal.
-- Built from actual source hashes in source-pins.json by offline author.py.
SET LOCAL TimeZone='UTC';
DO $cooperation171$ BEGIN
 IF current_user IS DISTINCT FROM session_user
 OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.parcel_physical_wz_certificate'::regclass)
 OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.pim_dictionary_manifest'::regclass)
 OR NOT EXISTS(SELECT FROM public.migrations WHERE name='168_physical_parcel_wz') OR NOT EXISTS(SELECT FROM public.migrations WHERE name='170_pim_dictionaries')
 OR NOT public.parcel_physical_wz_valid() OR NOT public.pim_dictionary_valid()
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'cooperation171_')) OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'cooperation171_')) OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'cooperation171_')) OR EXISTS(SELECT FROM migrations WHERE name='171_pim_physical_cooperation')
 THEN RAISE EXCEPTION 'Cooperation171 requires exact owner/intact168+170/no remnants' USING ERRCODE='55000';END IF;
END $cooperation171$;
LOCK TABLE public.parcel_physical_wz_certificate,public.pim_dictionary_manifest IN SHARE MODE;
CREATE TEMP TABLE cooperation171_install_basis ON COMMIT DROP AS SELECT
 pg_current_xact_id()::text root_xid,transaction_timestamp() start_at,pg_backend_pid() backend_pid,current_user::text owner_name,
 (SELECT to_jsonb(c) FROM public.parcel_physical_wz_certificate c) original168,
 (SELECT to_jsonb(m) FROM public.pim_dictionary_manifest m) original170,
 jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND c.relkind IN('r','p')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(a.attacl) x),'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',(SELECT collname FROM pg_collation WHERE oid=a.attcollation)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,'def',pg_get_constraintdef(c.oid,true),'validated',c.convalidated) ORDER BY t.relname,c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'parcel_physical_wz_')),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',idx.relname,'def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY t.relname,idx.relname) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'parcel_physical_wz_')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND(starts_with(t.tgname,'parcel_physical_wz_') OR(c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_')))),
 'policies',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'parcel_physical_wz_')),
 'app_role',(SELECT jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin) FROM pg_roles r WHERE rolname='dyna_app'),
 'app_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'select',has_table_privilege('dyna_app',c.oid,'SELECT'),'insert',has_table_privilege('dyna_app',c.oid,'INSERT'),'update',has_table_privilege('dyna_app',c.oid,'UPDATE'),'delete',has_table_privilege('dyna_app',c.oid,'DELETE')) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND c.relkind IN('r','p'))
 ) physical_before,
 public.pim_dictionary_metadata() pim_before,
 public.pim_dictionary_predecessor_metadata() predecessor_before,
 (SELECT jsonb_object_agg(signature, public.pim_dictionary_function_metadata(to_regprocedure('public.'||signature)) || jsonb_build_object('body',p.prosrc) ORDER BY signature) FROM unnest(ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']) wanted(signature) JOIN pg_proc p ON p.oid=to_regprocedure('public.'||signature)) functions_before,
 (SELECT jsonb_object_agg(signature,to_regprocedure('public.'||signature)::oid::text ORDER BY signature) FROM unnest(ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']) wanted(signature)) install_oids;
REVOKE ALL ON pg_temp.cooperation171_install_basis FROM PUBLIC,dyna_app;
CREATE TABLE cooperation171_certificate(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 profile text NOT NULL CHECK(profile='168+170-original-to171-cooperative-public-constraints/v1'),
 original168 jsonb NOT NULL CHECK(jsonb_typeof(original168)='object'),original170 jsonb NOT NULL CHECK(jsonb_typeof(original170)='object'),
 physical_before jsonb NOT NULL CHECK(jsonb_typeof(physical_before)='object'),pim_before jsonb NOT NULL CHECK(jsonb_typeof(pim_before)='object'),
 predecessor_before jsonb NOT NULL CHECK(jsonb_typeof(predecessor_before)='object'),functions_before jsonb NOT NULL CHECK(jsonb_typeof(functions_before)='object'),functions_after jsonb NOT NULL CHECK(jsonb_typeof(functions_after)='object'),
 successor168_fingerprint text NOT NULL CHECK(successor168_fingerprint~'^[a-f0-9]{64}$'),successor170_fingerprint text NOT NULL CHECK(successor170_fingerprint~'^[a-f0-9]{64}$'),
 module_functions jsonb NOT NULL CHECK(jsonb_typeof(module_functions)='object'),module_fingerprint text NOT NULL CHECK(module_fingerprint~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)));
REVOKE ALL ON public.cooperation171_certificate FROM PUBLIC,dyna_app;
CREATE FUNCTION cooperation171_function_map() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
 SELECT coalesce(jsonb_object_agg(p.oid::regprocedure::text, public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) ORDER BY p.oid::regprocedure::text),'{}'::jsonb)
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'cooperation171_')
$cooperation171$;
CREATE FUNCTION cooperation171_physical_metadata() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$ SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND c.relkind IN('r','p')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(a.attacl) x),'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',(SELECT collname FROM pg_collation WHERE oid=a.attcollation)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,'def',pg_get_constraintdef(c.oid,true),'validated',c.convalidated) ORDER BY t.relname,c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'parcel_physical_wz_')),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',idx.relname,'def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY t.relname,idx.relname) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid WHERE t.relnamespace='public'::regnamespace AND starts_with(t.relname,'parcel_physical_wz_')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND(starts_with(t.tgname,'parcel_physical_wz_') OR(c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_')))),
 'policies',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'parcel_physical_wz_')),
 'app_role',(SELECT jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin) FROM pg_roles r WHERE rolname='dyna_app'),
 'app_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'select',has_table_privilege('dyna_app',c.oid,'SELECT'),'insert',has_table_privilege('dyna_app',c.oid,'INSERT'),'update',has_table_privilege('dyna_app',c.oid,'UPDATE'),'delete',has_table_privilege('dyna_app',c.oid,'DELETE')) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'parcel_physical_wz_') AND c.relkind IN('r','p'))
 ) $cooperation171$;
CREATE FUNCTION cooperation171_metadata() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
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
  FROM pg_class c LEFT JOIN pg_am am ON am.oid=c.relam WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'cooperation171_') AND c.relkind IN('r','p','v','m','S','f')),
 'functions',(SELECT coalesce(jsonb_agg(public.pim_dictionary_function_metadata(p.oid) ORDER BY p.oid::regprocedure::text),'[]'::jsonb) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'cooperation171_')),
 'authority_roles',(WITH RECURSIVE reachable(role_oid) AS (
  SELECT r.oid FROM pg_roles r WHERE r.rolname='dyna_app' OR r.oid=(SELECT relowner FROM pg_class WHERE oid='public.cooperation171_certificate'::regclass)
  UNION SELECT membership.roleid FROM pg_auth_members membership JOIN reachable reachable_role ON reachable_role.role_oid=membership.member)
  SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(role_row)-'oid'-'rolpassword' ORDER BY role_row.rolname) FROM pg_roles role_row WHERE role_row.oid IN(SELECT role_oid FROM reachable)),
  'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),'member',pg_get_userbyid(m.member),'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY pg_get_userbyid(m.roleid)::text,pg_get_userbyid(m.member)::text,pg_get_userbyid(m.grantor)::text),'[]'::jsonb) FROM pg_auth_members m WHERE m.member IN(SELECT role_oid FROM reachable) OR m.roleid IN(SELECT role_oid FROM reachable)))),
 -- RI trigger names contain allocation OIDs. Capture exact semantic FK/function/flags,
 -- including the triggers added to existing parents, without generated names or OIDs.
 'ri',(SELECT coalesce(jsonb_agg(jsonb_build_object('relation',tr.tgrelid::regclass::text,'constraint_relation',con.conrelid::regclass::text,'constraint',con.conname,'definition',pg_get_constraintdef(con.oid,true),'type',tr.tgtype,'enabled',tr.tgenabled,'function',tr.tgfoid::regprocedure::text,'deferrable',tr.tgdeferrable,'deferred',tr.tginitdeferred) ORDER BY tr.tgrelid::regclass::text,con.conrelid::regclass::text,con.conname,tr.tgtype,tr.tgfoid::regprocedure::text),'[]'::jsonb)
 FROM pg_trigger tr JOIN pg_constraint con ON con.oid=tr.tgconstraint JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid WHERE tr.tgisinternal AND ((child.relnamespace='public'::regnamespace AND starts_with(child.relname,'cooperation171_')) OR(parent.relnamespace='public'::regnamespace AND starts_with(parent.relname,'cooperation171_'))))
 )
$cooperation171$;
CREATE FUNCTION cooperation171_project_metadata(actual jsonb,before_functions jsonb,physical boolean) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $cooperation171$
DECLARE f jsonb;sig text;arr jsonb:='[]'::jsonb;
BEGIN
 IF jsonb_typeof(actual) IS DISTINCT FROM 'object' OR jsonb_typeof(actual->'functions') IS DISTINCT FROM 'array' OR jsonb_typeof(before_functions) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Projection metadata shape' USING ERRCODE='55000';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(actual->'functions') LOOP
  IF physical AND f->>'name'=ANY(ARRAY['parcel_physical_wz_terminal_prepare','parcel_physical_wz_valid']) THEN
   sig:=(f->>'name')||'()';f:=jsonb_set(f,'{def}',before_functions->sig->'definition');
  ELSIF NOT physical AND f->>'signature'='pim_dictionary_valid()' THEN f:=(before_functions->'pim_dictionary_valid()')-'body';END IF;
  arr:=arr||jsonb_build_array(f);
 END LOOP;
 RETURN jsonb_set(actual,'{functions}',arr);
END $cooperation171$;
CREATE FUNCTION cooperation171_public_drain() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $cooperation171$
DECLARE targets text;
BEGIN
 SELECT string_agg(format('%I.%I',schema_name,constraint_name),',' ORDER BY schema_name,constraint_name) INTO targets FROM(
 SELECT DISTINCT ns.nspname::text schema_name,con.conname::text constraint_name FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace ns ON ns.oid=con.connamespace WHERE ns.nspname='public' AND con.condeferrable) public_constraints;
 IF targets IS NOT NULL THEN EXECUTE 'SET CONSTRAINTS '||targets||' IMMEDIATE';END IF;
END $cooperation171$;


CREATE FUNCTION cooperation171_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
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

CREATE OR REPLACE FUNCTION parcel_physical_wz_terminal_prepare() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x record;m parcel_physical_wz_mappings;f jsonb;BEGIN
 IF NOT parcel_physical_wz_context_owned() THEN RETURN true;END IF;
 PERFORM public.cooperation171_public_drain();
 FOR x IN SELECT * FROM pg_temp.parcel_physical_wz_context LOOP
 PERFORM buyer_address_identity(x.tenant_id,x.actor_id,x.api_key_id,x.credential_hash,x.role_name,false,true);PERFORM order_parcel_require(x.actor_id,x.api_key_id,x.writing,true);
 END LOOP;
 IF NOT parcel_physical_wz_valid() OR NOT warehouse_wz_issuer_guards() OR NOT operative_delivery_valid() THEN RAISE EXCEPTION 'Final typed WZ metadata changed' USING ERRCODE='55000';END IF;
 FOR x IN SELECT * FROM pg_temp.parcel_physical_wz_context LOOP
 IF x.expected_basis IS NOT NULL THEN
 IF x.mapping_id IS NOT NULL THEN SELECT * INTO m FROM parcel_physical_wz_mappings WHERE(tenant_id,id)=(x.tenant_id,x.mapping_id);f:=parcel_physical_wz_frame(m.plan_id,m.frame->'allocation');
 ELSE SELECT p.frame INTO f FROM parcel_physical_wz_previews p WHERE p.tenant_id=x.tenant_id AND p.plan_id=x.subject_id AND p.frame->'basis'=x.expected_basis ORDER BY p.created_at DESC,p.id LIMIT 1;f:=parcel_physical_wz_frame((f->'source'->>'plan_id')::uuid,f->'allocation');END IF;
 IF f->'basis' IS DISTINCT FROM x.expected_basis OR(x.expected_revision IS NOT NULL AND f->'source'->>'revision' IS DISTINCT FROM x.expected_revision) THEN RAISE EXCEPTION 'Physical WZ source changed after waits' USING ERRCODE='40001';END IF;
 END IF;
 IF x.admission_id IS NOT NULL THEN PERFORM parcel_physical_wz_validate_admission(x.admission_id);END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION parcel_physical_wz_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE cert parcel_physical_wz_certificate;saved jsonb;actual jsonb;n text;expected jsonb:='{"warehouse_wz_issuer_commercial":"ff3a360178eca1e85c623678290a79ca0daf06e0c4d0b6ddff95b2eb5089ab5e","warehouse_wz_issuer_effects":"9d1970aad9edaf4e7fcee867bf59df85184a494ecdfe5478940f7ffd08f660e6","warehouse_wz_issuer_finish":"8197d0956d44b0d1062f1072668a35a76b70b32fda15b5b8ebdc383f94b6d7dc","warehouse_wz_issuer_access":"8a94cd8ce10a17f7fcee6f57209f89619d604f31e31dd57896816b262ab7e1b4","warehouse_wz_issuer_snapshot":"9f07289798db9788263b03e884218faed506b38d127861328815731bae6a0365","warehouse_wz_issuer_prepare":"76ece3a21d4df401cf534ab79b5b14aa037cf30d6bb81fd99d9467a50f0fdd06","warehouse_wz_issuer_record_guard":"22fe527363c170f2fb1527db5193de620ba7be2db1cf9fe067f88c5d11e5d034","warehouse_wz_issuer_complete":"a5956e31f27adf662949905701153bbf4c2729b68b4a1caef8c8499712b5c4ad","warehouse_wz_issuer_source_seal":"3cde51f5df2b882f26474378974b64ed8daac1c6db8dcb0a900f69e35839eb52","warehouse_wz_issuer_hash":"68ce179ff3c4500519f3b13abd83717d93dd70b35bf57195a26e105b3763e013","warehouse_wz_issuer_installed":"813e2ffeefda8491a8ee4f56b43953894d82a0edba20f4803db1b5c0599e1785","warehouse_wz_issuer_fingerprint":"fb6ad23cafc0fc41f0889757bbf892fe4d8f008b00fadba86da411eebb3de663","warehouse_wz_issuer_guards":"d863e8454d576cd10559495dd55cf90eecbd9b58d68c952e443d1cc33ec7deaa","warehouse_wz_issuer_require":"38df95080d4dfded515349e8621b2f9ffae49f10070c9ebbc979478b788ac47e"}'::jsonb;r oid;BEGIN
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
CREATE OR REPLACE FUNCTION pim_dictionary_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE stored public.pim_dictionary_manifest%ROWTYPE;predecessors_json jsonb;guard_name text;guard_ok boolean;
BEGIN
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

CREATE FUNCTION cooperation171_certificate_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
DECLARE x record;r oid;actual_oids jsonb;
BEGIN
 IF TG_OP<>'INSERT' OR current_user IS DISTINCT FROM session_user OR EXISTS(SELECT FROM public.cooperation171_certificate) OR EXISTS(SELECT FROM public.migrations WHERE name='171_pim_physical_cooperation') THEN RAISE EXCEPTION 'Immutable cooperation171 certificate' USING ERRCODE='42501';END IF;
 r:=to_regclass('pg_temp.cooperation171_install_basis');IF r IS NULL THEN RAISE EXCEPTION 'No cooperation171 root basis' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM pg_class cl WHERE cl.oid=r AND cl.relpersistence='t' AND cl.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT EXISTS(SELECT FROM aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) acl WHERE acl.grantee<>cl.relowner)) OR(SELECT count(*) FROM pg_temp.cooperation171_install_basis)<>1 THEN RAISE EXCEPTION 'False cooperation171 basis' USING ERRCODE='55000';END IF;
 SELECT * INTO STRICT x FROM pg_temp.cooperation171_install_basis;
 SELECT jsonb_object_agg(signature,to_regprocedure('public.'||signature)::oid::text ORDER BY signature) INTO actual_oids FROM unnest(ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']) wanted(signature);
 IF x.root_xid<>pg_current_xact_id()::text OR x.start_at<>transaction_timestamp() OR x.backend_pid<>pg_backend_pid() OR x.owner_name<>current_user OR x.install_oids IS DISTINCT FROM actual_oids
 OR(NEW.original168,NEW.original170,NEW.physical_before,NEW.pim_before,NEW.predecessor_before,NEW.functions_before) IS DISTINCT FROM(x.original168,x.original170,x.physical_before,x.pim_before,x.predecessor_before,x.functions_before)
 OR NEW.functions_after IS DISTINCT FROM (SELECT jsonb_object_agg(signature, public.pim_dictionary_function_metadata(to_regprocedure('public.'||signature)) || jsonb_build_object('body',p.prosrc) ORDER BY signature) FROM unnest(ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']) wanted(signature) JOIN pg_proc p ON p.oid=to_regprocedure('public.'||signature))
 OR NEW.successor168_fingerprint IS DISTINCT FROM public.parcel_physical_wz_fingerprint() OR NEW.successor170_fingerprint IS DISTINCT FROM public.pim_dictionary_fingerprint()
 OR NEW.module_functions IS DISTINCT FROM public.cooperation171_function_map() OR NEW.module_fingerprint IS DISTINCT FROM public.pim_dictionary_hash(public.cooperation171_metadata())
 THEN RAISE EXCEPTION 'Cooperation171 certificate differs from native before/after transcript' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $cooperation171$;
CREATE TRIGGER cooperation171_certificate_seal BEFORE INSERT OR UPDATE OR DELETE ON public.cooperation171_certificate FOR EACH ROW EXECUTE FUNCTION public.cooperation171_certificate_seal();
DO $cooperation171$ DECLARE f record;BEGIN FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'cooperation171_') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);END LOOP;END $cooperation171$;
INSERT INTO public.cooperation171_certificate(singleton,profile,original168,original170,physical_before,pim_before,predecessor_before,functions_before,functions_after,successor168_fingerprint,successor170_fingerprint,module_functions,module_fingerprint,created_at)
 SELECT true,'168+170-original-to171-cooperative-public-constraints/v1',original168,original170,physical_before,pim_before,predecessor_before,functions_before,
 (SELECT jsonb_object_agg(signature, public.pim_dictionary_function_metadata(to_regprocedure('public.'||signature)) || jsonb_build_object('body',p.prosrc) ORDER BY signature) FROM unnest(ARRAY['parcel_physical_wz_terminal_prepare()','parcel_physical_wz_valid()','pim_dictionary_valid()']) wanted(signature) JOIN pg_proc p ON p.oid=to_regprocedure('public.'||signature)),public.parcel_physical_wz_fingerprint(),public.pim_dictionary_fingerprint(),public.cooperation171_function_map(),public.pim_dictionary_hash(public.cooperation171_metadata()),clock_timestamp() FROM pg_temp.cooperation171_install_basis;
DO $cooperation171$ BEGIN IF NOT public.cooperation171_valid() OR NOT public.parcel_physical_wz_valid() OR NOT public.pim_dictionary_valid() OR NOT public.warehouse_wz_issuer_guards() THEN RAISE EXCEPTION 'Certified cooperative successor refused' USING ERRCODE='55000';END IF;END $cooperation171$;
-- Root appends171_pim_physical_cooperation in this SAME owner managed transaction.
