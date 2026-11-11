-- Offline placeholders are expanded by author.py. Execute only in root-managed
-- transaction after a genuine intact171 preflight; ledger append is root-owned.
SET LOCAL TimeZone='UTC';
DO $nested172$ BEGIN
 IF current_user IS DISTINCT FROM session_user
 OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.cooperation171_certificate'::regclass)
 OR public.cooperation171_valid() IS DISTINCT FROM true OR public.pim_dictionary_valid() IS DISTINCT FROM true
 OR public.parcel_physical_wz_valid() IS DISTINCT FROM true
 OR NOT EXISTS(SELECT FROM public.migrations WHERE name='171_pim_physical_cooperation')
 OR EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json')
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'nested172_'))
 OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'nested172_'))
 THEN RAISE EXCEPTION '172 requires intact171 owner/no remnants' USING ERRCODE='55000';END IF;
END $nested172$;
LOCK TABLE public.cooperation171_certificate,public.parcel_physical_wz_certificate,public.pim_dictionary_manifest IN SHARE MODE;
CREATE TEMP TABLE nested172_install_basis ON COMMIT DROP AS SELECT
 pg_current_xact_id()::text root_xid,transaction_timestamp() started_at,pg_backend_pid() backend_pid,current_user::text owner_name,
 jsonb_build_object('168',(SELECT to_jsonb(x) FROM public.parcel_physical_wz_certificate x),'170',(SELECT to_jsonb(x) FROM public.pim_dictionary_manifest x),'171',(SELECT to_jsonb(x) FROM public.cooperation171_certificate x)) originals,
 public.pim_dictionary_metadata() pim_before,public.cooperation171_physical_metadata() physical_before,
 public.cooperation171_metadata() cooperation_before,public.pim_dictionary_predecessor_metadata() predecessors_before,
 (SELECT jsonb_object_agg(sig,public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) ORDER BY sig) FROM unnest(ARRAY['cooperation171_valid()','parcel_physical_wz_valid()','pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']::text[]) signatures(sig) JOIN pg_proc p ON p.oid=to_regprocedure('public.'||sig)) functions_before,
 (SELECT jsonb_object_agg(sig,p.oid::text ORDER BY sig) FROM unnest(ARRAY['cooperation171_valid()','parcel_physical_wz_valid()','pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']::text[]) signatures(sig) JOIN pg_proc p ON p.oid=to_regprocedure('public.'||sig)) install_oids;
REVOKE ALL ON pg_temp.nested172_install_basis FROM PUBLIC,dyna_app;
CREATE TABLE public.nested172_certificate(
 singleton boolean PRIMARY KEY CHECK(singleton),profile text NOT NULL CHECK(profile='171-to172-nested-legacy-finite-json/v2'),
 originals jsonb NOT NULL CHECK(jsonb_typeof(originals)='object'),
 functions_before jsonb NOT NULL CHECK(jsonb_typeof(functions_before)='object'),functions_after jsonb NOT NULL CHECK(jsonb_typeof(functions_after)='object'),
 pim_before jsonb NOT NULL CHECK(jsonb_typeof(pim_before)='object'),physical_before jsonb NOT NULL CHECK(jsonb_typeof(physical_before)='object'),
 cooperation_before jsonb NOT NULL CHECK(jsonb_typeof(cooperation_before)='object'),predecessors_before jsonb NOT NULL CHECK(jsonb_typeof(predecessors_before)='object'),
 functions jsonb NOT NULL CHECK(jsonb_typeof(functions)='object'),metadata_hash text NOT NULL CHECK(metadata_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)));
REVOKE ALL ON TABLE public.nested172_certificate FROM PUBLIC,dyna_app;

CREATE FUNCTION nested172_function_map() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
 SELECT coalesce(jsonb_object_agg(p.oid::regprocedure::text, public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) ORDER BY p.oid::regprocedure::text),'{}'::jsonb)
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'nested172_')
$cooperation171$;
CREATE FUNCTION nested172_metadata() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
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
  FROM pg_class c LEFT JOIN pg_am am ON am.oid=c.relam WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'nested172_') AND c.relkind IN('r','p','v','m','S','f')),
 'functions',(SELECT coalesce(jsonb_agg(public.pim_dictionary_function_metadata(p.oid) ORDER BY p.oid::regprocedure::text),'[]'::jsonb) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'nested172_')),
 'authority_roles',(WITH RECURSIVE reachable(role_oid) AS (
  SELECT r.oid FROM pg_roles r WHERE r.rolname='dyna_app' OR r.oid=(SELECT relowner FROM pg_class WHERE oid='public.nested172_certificate'::regclass)
  UNION SELECT membership.roleid FROM pg_auth_members membership JOIN reachable reachable_role ON reachable_role.role_oid=membership.member)
  SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(role_row)-'oid'-'rolpassword' ORDER BY role_row.rolname) FROM pg_roles role_row WHERE role_row.oid IN(SELECT role_oid FROM reachable)),
  'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),'member',pg_get_userbyid(m.member),'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY pg_get_userbyid(m.roleid)::text,pg_get_userbyid(m.member)::text,pg_get_userbyid(m.grantor)::text),'[]'::jsonb) FROM pg_auth_members m WHERE m.member IN(SELECT role_oid FROM reachable) OR m.roleid IN(SELECT role_oid FROM reachable)))),
 -- RI trigger names contain allocation OIDs. Capture exact semantic FK/function/flags,
 -- including the triggers added to existing parents, without generated names or OIDs.
 'ri',(SELECT coalesce(jsonb_agg(jsonb_build_object('relation',tr.tgrelid::regclass::text,'constraint_relation',con.conrelid::regclass::text,'constraint',con.conname,'definition',pg_get_constraintdef(con.oid,true),'type',tr.tgtype,'enabled',tr.tgenabled,'function',tr.tgfoid::regprocedure::text,'deferrable',tr.tgdeferrable,'deferred',tr.tginitdeferred) ORDER BY tr.tgrelid::regclass::text,con.conrelid::regclass::text,con.conname,tr.tgtype,tr.tgfoid::regprocedure::text),'[]'::jsonb)
 FROM pg_trigger tr JOIN pg_constraint con ON con.oid=tr.tgconstraint JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid WHERE tr.tgisinternal AND ((child.relnamespace='public'::regnamespace AND starts_with(child.relname,'nested172_')) OR(parent.relnamespace='public'::regnamespace AND starts_with(parent.relname,'nested172_'))))
 )
$cooperation171$;

-- New native v2 predicate only. No writer, IAM, CAS or hash implementation.
-- JSONB has already normalized numeric lexical spelling; never claims raw-byte fidelity.
CREATE FUNCTION nested172_json_valid(tree jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog,public AS $nested172$
DECLARE item jsonb;level integer;nodes integer:=0;entry record;number_value numeric;transport_number double precision;kind text;
BEGIN
 IF tree IS NULL OR jsonb_typeof(tree) IS DISTINCT FROM 'object' OR octet_length(tree::text)>2097152 THEN RETURN false;END IF;
 -- A bounded recursive relation avoids repeated O(n^2) array copies on broad trees.
 FOR item,level IN
  WITH RECURSIVE walk(value,depth) AS (
   SELECT tree,0
   UNION ALL
   SELECT child.value,parent.depth+1 FROM walk parent CROSS JOIN LATERAL (
    SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(parent.value)='object' THEN parent.value ELSE '{}'::jsonb END)
    UNION ALL
    SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.value)='array' THEN parent.value ELSE '[]'::jsonb END)
   ) child(value) WHERE parent.depth<=16
  ) SELECT value,depth FROM walk
 LOOP
  nodes:=nodes+1;
  IF nodes>100000 OR level>16 THEN RETURN false;END IF;
  kind:=jsonb_typeof(item);
  IF kind='object' THEN
   FOR entry IN SELECT key,value FROM jsonb_each(item) LOOP
    IF entry.key=ANY(ARRAY['__proto__','prototype','constructor']) THEN RETURN false;END IF;
   END LOOP;
  ELSIF kind='array' THEN NULL;
  ELSIF kind='number' THEN
   number_value:=item::text::numeric;
   -- Entire original tree preserves normalized parser semantics, including
   -- unmapped fractions/exponents/large finite numbers. Never rewrite a number.
   -- Exact integer_decimal projection is separately restricted to safe integers.
   BEGIN transport_number:=number_value::double precision;
   EXCEPTION WHEN numeric_value_out_of_range THEN
    -- JS parses tiny magnitudes to finite zero. PG may report float underflow;
    -- retain the original JSONB numeric spelling/value rather than replace it.
    IF abs(number_value)<1e-307::numeric THEN transport_number:=0;
    ELSE RETURN false;END IF;
   END;
   IF transport_number=ANY(ARRAY['Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision]) THEN RETURN false;END IF;
  ELSIF kind IS NULL OR kind<>ALL(ARRAY['string','boolean','null']) THEN RETURN false;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $nested172$;
REVOKE ALL ON FUNCTION nested172_json_valid(jsonb) FROM PUBLIC,dyna_app;

-- Private historical interpretation, never an admission/authorization API.
CREATE FUNCTION nested172_legacy_function(sig text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $nested172$
 SELECT coalesce((SELECT functions_before->sig FROM public.nested172_certificate WHERE singleton),
 public.pim_dictionary_function_metadata(to_regprocedure('public.'||sig))||
 (SELECT jsonb_build_object('body',prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.'||sig)))
$nested172$;
CREATE FUNCTION nested172_project_metadata(actual jsonb,family text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $nested172$
DECLARE saved jsonb;result jsonb:=actual;f jsonb;sig text;arr jsonb:='[]'::jsonb;
BEGIN
 SELECT functions_before INTO STRICT saved FROM public.nested172_certificate WHERE singleton;
 IF jsonb_typeof(actual) IS DISTINCT FROM 'object' OR jsonb_typeof(saved) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '172 projection shape' USING ERRCODE='55000';END IF;
 IF family='function_map' THEN
  RETURN jsonb_set(actual,'{cooperation171_valid()}',saved->'cooperation171_valid()');
 ELSIF family='predecessors' THEN
  RETURN jsonb_set(actual,'{parcel_physical_wz_valid}',(saved->'parcel_physical_wz_valid()')-'body');
 END IF;
 IF family<>ALL(ARRAY['physical','pim','cooperation']) OR jsonb_typeof(actual->'functions') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '172 projection family' USING ERRCODE='55000';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(actual->'functions') LOOP
  IF family='physical' AND f->>'name'='parcel_physical_wz_valid' THEN f:=jsonb_set(f,'{def}',saved->'parcel_physical_wz_valid()'->'definition');
  ELSE
   sig:=f->>'signature';
   IF (family='pim' AND sig=ANY(ARRAY['pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']))
   OR (family='cooperation' AND sig='cooperation171_valid()') THEN f:=(saved->sig)-'body';END IF;
  END IF;
  arr:=arr||jsonb_build_array(f);
 END LOOP;
 RETURN jsonb_set(result,'{functions}',arr);
END $nested172$;

CREATE FUNCTION nested172_historical171_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $nested172$
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
 OR c.module_functions IS DISTINCT FROM public.nested172_project_metadata(public.cooperation171_function_map(),'function_map')
 OR c.module_fingerprint IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_project_metadata(public.cooperation171_metadata(),'cooperation'))
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
 IF public.cooperation171_project_metadata(public.nested172_project_metadata(public.cooperation171_physical_metadata(),'physical'),c.functions_before,true) IS DISTINCT FROM c.physical_before
 OR public.cooperation171_project_metadata(public.nested172_project_metadata(public.pim_dictionary_metadata(),'pim'),c.functions_before,false) IS DISTINCT FROM c.pim_before
 OR c.successor168_fingerprint IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_project_metadata(public.cooperation171_physical_metadata(),'physical'))
 OR c.successor170_fingerprint IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_project_metadata(public.pim_dictionary_metadata(),'pim')) THEN RETURN false;END IF;
 pred:=public.nested172_project_metadata(public.pim_dictionary_predecessor_metadata(),'predecessors');
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

CREATE OR REPLACE FUNCTION cooperation171_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $cooperation171$
DECLARE c public.cooperation171_certificate;sig text;b jsonb;a jsonb;live jsonb;pred jsonb;r oid;
 expected_before jsonb:=$bodymap171${"parcel_physical_wz_terminal_prepare()":"47a44cb1bf9da5762a72965f89658fc9a9cde38a28c60a4cd4cda6662e8f18cb","parcel_physical_wz_valid()":"5b45c698ac39ef9cc217c9d721b9adb96242fdd360681bd74036f6bb7215bcbb","pim_dictionary_valid()":"d1b62c7f01376ee904327b69a7a8aea60b5530c7fbcac6d6fb87e7cdedd4e06c"}$bodymap171$::jsonb;
 expected_after jsonb:=$bodymap171${"parcel_physical_wz_terminal_prepare()":"7babdec6465f9fa8279fd24575531673028c7e1c550bfabe11d74ed19ce65db1","parcel_physical_wz_valid()":"bf2a1c9b3dee0fe87da6eba69920bfa42a6b33c65732fd77a7e6af6198987a75","pim_dictionary_valid()":"28ca41934632980b2f0c4e8387ab2aab0b77cf473d59031c5a8b2b2d6c80ae84"}$bodymap171$::jsonb;
BEGIN
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

CREATE OR REPLACE FUNCTION pim_dictionary_source_json_valid(frame_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source_row jsonb;canonical_row jsonb;revision_json jsonb;legacy_value jsonb;seen_ids text[]:='{}'::text[];
BEGIN
 IF jsonb_typeof(frame_json) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF(SELECT array_agg(shape_key.key ORDER BY shape_key.key) FROM jsonb_object_keys(frame_json) shape_key(key)) IS DISTINCT FROM ARRAY['catalog_id','dictionary','revision','sources']::text[] OR jsonb_typeof(frame_json->'catalog_id') IS DISTINCT FROM 'string' OR NOT coalesce(frame_json->>'catalog_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR NOT public.pim_dictionary_validate_dictionary(frame_json->'dictionary') THEN RETURN false;END IF;
 revision_json:=frame_json->'revision';IF jsonb_typeof(revision_json) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF(SELECT array_agg(shape_key.key ORDER BY shape_key.key) FROM jsonb_object_keys(revision_json) shape_key(key)) IS DISTINCT FROM ARRAY['catalog_version','dictionary_version','schema_hash']::text[] OR jsonb_typeof(revision_json->'catalog_version') IS DISTINCT FROM 'string' OR NOT coalesce(revision_json->>'catalog_version'~'^[1-9][0-9]{0,18}$',false) OR jsonb_typeof(revision_json->'dictionary_version') IS DISTINCT FROM 'string' OR NOT coalesce(revision_json->>'dictionary_version'~'^(0|[1-9][0-9]{0,18})$',false) OR jsonb_typeof(revision_json->'schema_hash') IS DISTINCT FROM 'string' OR revision_json->>'schema_hash' IS DISTINCT FROM public.pim_dictionary_hash(frame_json->'dictionary') THEN RETURN false;END IF;
 IF(revision_json->>'catalog_version')::numeric>9223372036854775807 OR(revision_json->>'dictionary_version')::numeric>9223372036854775807 OR(revision_json->>'dictionary_version'='0' AND frame_json->'dictionary' IS DISTINCT FROM jsonb_build_object('categories','[]'::jsonb,'definitions','[]'::jsonb)) THEN RETURN false;END IF;
 IF jsonb_typeof(frame_json->'sources') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(frame_json->'sources')>500 OR octet_length(frame_json::text)>2097152 OR frame_json->'sources' IS DISTINCT FROM coalesce((SELECT jsonb_agg(native_source.value ORDER BY native_source.value->>'product_id') FROM jsonb_array_elements(frame_json->'sources') native_source(value)),'[]'::jsonb) THEN RETURN false;END IF;
 FOR source_row IN SELECT native_source.value FROM jsonb_array_elements(frame_json->'sources') native_source(value) LOOP
  IF jsonb_typeof(source_row) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF(SELECT array_agg(shape_key.key ORDER BY shape_key.key) FROM jsonb_object_keys(source_row) shape_key(key)) IS DISTINCT FROM ARRAY['catalog_id','category_id','legacy','name','product_id','product_version','sku','source_hash','state_version','values']::text[] OR source_row->'catalog_id' IS DISTINCT FROM frame_json->'catalog_id' OR jsonb_typeof(source_row->'sku') IS DISTINCT FROM 'string' OR jsonb_typeof(source_row->'name') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  canonical_row:=public.pim_dictionary_canonical_row(jsonb_build_object('product_id',source_row->'product_id','product_version',source_row->'product_version','state_version',source_row->'state_version','source_hash',source_row->'source_hash','category_id',source_row->'category_id','values',source_row->'values'));
  IF canonical_row->'values' IS DISTINCT FROM source_row->'values' OR source_row->>'product_id'=ANY(seen_ids) OR source_row->>'source_hash' IS DISTINCT FROM public.pim_dictionary_hash(source_row-'source_hash') THEN RETURN false;END IF;seen_ids:=seen_ids||ARRAY[source_row->>'product_id'];
  IF jsonb_typeof(source_row->'legacy') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF(SELECT array_agg(shape_key.key ORDER BY shape_key.key) FROM jsonb_object_keys(source_row->'legacy') shape_key(key)) IS DISTINCT FROM ARRAY['attributes','category']::text[] OR jsonb_typeof(source_row->'legacy'->'category') IS DISTINCT FROM 'string' OR jsonb_typeof(source_row->'legacy'->'attributes') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  -- String-only legacy is unchanged v1. Non-string tree invokes bounded v2.
  IF EXISTS(SELECT FROM jsonb_each(source_row->'legacy'->'attributes') entry(key,value) WHERE jsonb_typeof(value) IS DISTINCT FROM 'string')
  AND public.nested172_json_valid(source_row->'legacy'->'attributes') IS DISTINCT FROM true THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION pim_dictionary_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE stored public.pim_dictionary_manifest%ROWTYPE;predecessors_json jsonb;guard_name text;guard_ok boolean;
BEGIN
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


CREATE FUNCTION nested172_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $nested172$
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

CREATE FUNCTION nested172_certificate_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $nested172$
DECLARE x record;actual_oids jsonb;actual_functions jsonb;r oid;
BEGIN
 IF TG_OP IS DISTINCT FROM 'INSERT' OR current_user IS DISTINCT FROM session_user OR EXISTS(SELECT FROM public.nested172_certificate)
 OR EXISTS(SELECT FROM public.migrations WHERE name='172_pim_nested_json') THEN RAISE EXCEPTION 'Immutable172 certificate' USING ERRCODE='42501';END IF;
 r:=to_regclass('pg_temp.nested172_install_basis');
 IF r IS NULL OR NOT EXISTS(SELECT FROM pg_class cl WHERE cl.oid=r AND cl.relpersistence='t' AND cl.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
 AND NOT EXISTS(SELECT FROM aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) a WHERE a.grantee<>cl.relowner))
 OR(SELECT count(*) FROM pg_temp.nested172_install_basis)<>1 THEN RAISE EXCEPTION 'False172 install basis' USING ERRCODE='55000';END IF;
 SELECT * INTO STRICT x FROM pg_temp.nested172_install_basis;
 SELECT jsonb_object_agg(sig,p.oid::text ORDER BY sig),jsonb_object_agg(sig,public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) ORDER BY sig)
 INTO actual_oids,actual_functions FROM unnest(ARRAY['cooperation171_valid()','parcel_physical_wz_valid()','pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']::text[]) signatures(sig) JOIN pg_proc p ON p.oid=to_regprocedure('public.'||sig);
 IF x.root_xid IS DISTINCT FROM pg_current_xact_id()::text OR x.started_at IS DISTINCT FROM transaction_timestamp() OR x.backend_pid IS DISTINCT FROM pg_backend_pid() OR x.owner_name IS DISTINCT FROM current_user
 OR x.install_oids IS DISTINCT FROM actual_oids
 OR (NEW.originals,NEW.functions_before,NEW.pim_before,NEW.physical_before,NEW.cooperation_before,NEW.predecessors_before) IS DISTINCT FROM(x.originals,x.functions_before,x.pim_before,x.physical_before,x.cooperation_before,x.predecessors_before)
 OR NEW.functions_after IS DISTINCT FROM actual_functions OR NEW.functions IS DISTINCT FROM public.nested172_function_map()
 OR NEW.metadata_hash IS DISTINCT FROM public.pim_dictionary_hash(public.nested172_metadata()) THEN RAISE EXCEPTION '172 native transcript mismatch' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $nested172$;
CREATE TRIGGER nested172_certificate_seal BEFORE INSERT OR UPDATE OR DELETE ON public.nested172_certificate FOR EACH ROW EXECUTE FUNCTION public.nested172_certificate_seal();
CREATE FUNCTION nested172_validate_recovered() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $nested172$
DECLARE p record;o record;previews bigint:=0;operations bigint:=0;
BEGIN
 IF public.nested172_valid() IS DISTINCT FROM true OR public.pim_dictionary_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '172 recovery metadata incomplete' USING ERRCODE='55000';END IF;
 FOR p IN SELECT tenant_id,id FROM public.pim_dictionary_previews ORDER BY tenant_id,id LOOP PERFORM public.pim_dictionary_validate_preview(p.tenant_id,p.id);previews:=previews+1;END LOOP;
 FOR o IN SELECT tenant_id,id FROM public.pim_dictionary_operations ORDER BY tenant_id,id LOOP PERFORM public.pim_dictionary_validate_operation(o.tenant_id,o.id,true);operations:=operations+1;END LOOP;
 RETURN jsonb_build_object('codec','nested172/v2','previews',previews,'operations',operations);
END $nested172$;
DO $nested172$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'nested172_') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.sig);END LOOP;END $nested172$;
INSERT INTO public.nested172_certificate(singleton,profile,originals,functions_before,functions_after,pim_before,physical_before,cooperation_before,predecessors_before,functions,metadata_hash,created_at)
 SELECT true,'171-to172-nested-legacy-finite-json/v2',originals,functions_before,
 (SELECT jsonb_object_agg(sig,public.pim_dictionary_function_metadata(p.oid)||jsonb_build_object('body',p.prosrc) ORDER BY sig) FROM unnest(ARRAY['cooperation171_valid()','parcel_physical_wz_valid()','pim_dictionary_source_json_valid(jsonb)','pim_dictionary_valid()']::text[]) signatures(sig) JOIN pg_proc p ON p.oid=to_regprocedure('public.'||sig)),
 pim_before,physical_before,cooperation_before,predecessors_before,public.nested172_function_map(),public.pim_dictionary_hash(public.nested172_metadata()),clock_timestamp() FROM pg_temp.nested172_install_basis;
DO $nested172$ BEGIN
 IF public.nested172_valid() IS DISTINCT FROM true OR public.cooperation171_valid() IS DISTINCT FROM true OR public.pim_dictionary_valid() IS DISTINCT FROM true OR public.parcel_physical_wz_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '172 complete certificate final check failed' USING ERRCODE='55000';END IF;
END $nested172$;
-- Root-managed migrator alone appends172 and commits; no fake ledger insertion here.
