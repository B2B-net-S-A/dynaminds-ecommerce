-- Additive local observations. No provider evidence, old parent triggers or price writes.
SET LOCAL TimeZone='UTC';
CREATE TABLE competitor_observation_profiles (
 tenant_id uuid NOT NULL,price_list_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 config_version integer NOT NULL CHECK(config_version>0),data_version integer NOT NULL CHECK(data_version>=0),
 source_namespace text NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 200 AND btrim(source_namespace)=source_namespace),
 own_seller_id text NOT NULL CHECK(length(own_seller_id) BETWEEN 1 AND 200 AND btrim(own_seller_id)=own_seller_id),
 rank integer NOT NULL CHECK(rank BETWEEN 1 AND 1000),own_delivery_gross_minor integer NOT NULL CHECK(own_delivery_gross_minor BETWEEN 0 AND 100000000),
 max_age_minutes integer NOT NULL CHECK(max_age_minutes BETWEEN 1 AND 10080),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,price_list_id),FOREIGN KEY(tenant_id,price_list_id) REFERENCES price_lists(tenant_id,id)
);
CREATE TABLE competitor_observation_batches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,price_list_id uuid NOT NULL,client_key uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),api_key_id uuid,
 profile_version integer NOT NULL CHECK(profile_version>0),profile_config_version integer NOT NULL CHECK(profile_config_version>0),profile_data_version integer NOT NULL CHECK(profile_data_version>=0),
 request_text text NOT NULL CHECK(octet_length(request_text)<=1000000),profile_snapshot jsonb NOT NULL CHECK(jsonb_typeof(profile_snapshot)='object'),list_currency text NOT NULL CHECK(list_currency ~ '^[A-Z]{3}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=1100000),
 count integer NOT NULL CHECK(count BETWEEN 1 AND 1000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,price_list_id,id),UNIQUE(tenant_id,price_list_id,client_key),
 FOREIGN KEY(tenant_id,price_list_id) REFERENCES competitor_observation_profiles(tenant_id,price_list_id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE competitor_observations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,price_list_id uuid NOT NULL,batch_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 1000),
 product_id uuid NOT NULL,source_namespace text NOT NULL CHECK(length(source_namespace) BETWEEN 1 AND 200),offer_id text NOT NULL CHECK(length(offer_id) BETWEEN 1 AND 200),seller_id text NOT NULL CHECK(length(seller_id) BETWEEN 1 AND 200),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),price_gross_minor integer NOT NULL CHECK(price_gross_minor BETWEEN 0 AND 100000000),delivery_gross_minor integer NOT NULL CHECK(delivery_gross_minor BETWEEN 0 AND 100000000),
 available boolean NOT NULL,observed_at timestamptz NOT NULL CHECK(observed_at>='1970-01-01T00:00:00Z'::timestamptz),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,batch_id,ordinal),UNIQUE(tenant_id,price_list_id,source_namespace,offer_id,observed_at,product_id),
 FOREIGN KEY(tenant_id,price_list_id,batch_id) REFERENCES competitor_observation_batches(tenant_id,price_list_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE INDEX competitor_observations_latest ON competitor_observations(tenant_id,price_list_id,product_id,source_namespace,offer_id,observed_at DESC,id DESC);
CREATE INDEX competitor_observations_page ON competitor_observations(tenant_id,price_list_id,id);
CREATE INDEX competitor_observation_batches_page ON competitor_observation_batches(tenant_id,price_list_id,id);
CREATE TABLE competitor_observation_manifest (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),profile text NOT NULL CHECK(profile='local-explicit-observations/v1'),fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),installed_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['competitor_observation_profiles','competitor_observation_batches','competitor_observations'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',tbl);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',tbl);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO dyna_app',tbl);
END LOOP;END $$;
GRANT UPDATE ON competitor_observation_profiles TO dyna_app;
REVOKE ALL ON competitor_observation_manifest FROM PUBLIC,dyna_app;
CREATE FUNCTION competitor_observation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Local observation evidence is append-only' USING ERRCODE='23514';END $$;
CREATE TRIGGER competitor_observation_batches_immutable BEFORE UPDATE OR DELETE ON competitor_observation_batches FOR EACH ROW EXECUTE FUNCTION competitor_observation_immutable();
CREATE TRIGGER competitor_observations_immutable BEFORE UPDATE OR DELETE ON competitor_observations FOR EACH ROW EXECUTE FUNCTION competitor_observation_immutable();
CREATE TRIGGER competitor_observation_manifest_immutable BEFORE UPDATE OR DELETE ON competitor_observation_manifest FOR EACH ROW EXECUTE FUNCTION competitor_observation_immutable();
CREATE FUNCTION competitor_observation_profile_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.config_version<>1 OR NEW.data_version<>0 THEN RAISE EXCEPTION 'Invalid first profile version' USING ERRCODE='23514';END IF;
 ELSE
  IF(NEW.tenant_id,NEW.price_list_id) IS DISTINCT FROM(OLD.tenant_id,OLD.price_list_id) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid profile transition' USING ERRCODE='23514';END IF;
  IF(NEW.source_namespace,NEW.own_seller_id,NEW.rank,NEW.own_delivery_gross_minor,NEW.max_age_minutes) IS DISTINCT FROM(OLD.source_namespace,OLD.own_seller_id,OLD.rank,OLD.own_delivery_gross_minor,OLD.max_age_minutes) THEN
   IF NEW.config_version<>OLD.config_version+1 OR NEW.data_version<>OLD.data_version THEN RAISE EXCEPTION 'Invalid profile definition version' USING ERRCODE='23514';END IF;
  ELSE
   IF NOT((NEW.config_version=OLD.config_version+1 AND NEW.data_version=OLD.data_version) OR(NEW.config_version=OLD.config_version AND NEW.data_version=OLD.data_version+1)) THEN RAISE EXCEPTION 'Invalid profile data version' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER competitor_observation_profile_guard BEFORE INSERT OR UPDATE ON competitor_observation_profiles FOR EACH ROW EXECUTE FUNCTION competitor_observation_profile_guard();
CREATE FUNCTION competitor_observation_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE bid uuid; b record; p record; actual jsonb; n integer; lo integer; hi integer;
BEGIN
 IF TG_TABLE_NAME='competitor_observation_batches' THEN bid:=NEW.id;ELSE bid:=NEW.batch_id;END IF;
 SELECT * INTO b FROM public.competitor_observation_batches WHERE id=bid;
 SELECT jsonb_agg(jsonb_build_object('product_id',o.product_id,'source_namespace',o.source_namespace,'offer_id',o.offer_id,'seller_id',o.seller_id,'currency',o.currency,'price_gross_minor',o.price_gross_minor::text,'delivery_gross_minor',o.delivery_gross_minor::text,'available',o.available,'observed_at',to_char(o.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY o.ordinal) INTO actual FROM public.competitor_observations o WHERE(o.tenant_id,o.batch_id)=(b.tenant_id,b.id);
 SELECT * INTO p FROM public.competitor_observation_profiles WHERE(tenant_id,price_list_id)=(b.tenant_id,b.price_list_id);
 SELECT count(*),min(ordinal),max(ordinal) INTO n,lo,hi FROM public.competitor_observations WHERE(tenant_id,batch_id)=(b.tenant_id,b.id);
 IF b.id IS NULL OR n IS DISTINCT FROM b.count OR lo IS DISTINCT FROM 1 OR hi IS DISTINCT FROM b.count
  OR b.request_text::jsonb IS DISTINCT FROM b.request OR encode(sha256(convert_to(b.request_text,'UTF8')),'hex') IS DISTINCT FROM b.request_hash
  OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(b.request) AS keys(key)) IS DISTINCT FROM ARRAY['client_key','local_observations_confirmed','observations','profile_version']::text[]
  OR b.request->'observations' IS DISTINCT FROM actual OR b.request->>'client_key' IS DISTINCT FROM b.client_key::text
  OR b.request->'profile_version' IS DISTINCT FROM to_jsonb(b.profile_version) OR b.request->'local_observations_confirmed' IS DISTINCT FROM 'true'::jsonb
  OR p.version IS DISTINCT FROM b.profile_version+1 OR p.config_version IS DISTINCT FROM b.profile_config_version OR p.data_version IS DISTINCT FROM b.profile_data_version+1
  OR(b.profile_snapshot-'updated_at') IS DISTINCT FROM (to_jsonb(p)-'updated_at'-'version'-'data_version'||jsonb_build_object('version',b.profile_version,'data_version',b.profile_data_version))
 THEN RAISE EXCEPTION 'Incomplete observation batch or profile transition' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.competitor_observations o JOIN public.price_lists l ON(l.tenant_id,l.id)=(o.tenant_id,o.price_list_id) JOIN public.products pr ON(pr.tenant_id,pr.id)=(o.tenant_id,o.product_id)
  WHERE(o.tenant_id,o.batch_id)=(b.tenant_id,b.id) AND(o.currency IS DISTINCT FROM b.list_currency OR o.currency IS DISTINCT FROM l.currency OR pr.kind='group' OR o.source_namespace IS DISTINCT FROM b.profile_snapshot->>'source_namespace' OR o.observed_at>b.created_at))
 THEN RAISE EXCEPTION 'Invalid local product, observation time or list currency' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER competitor_observation_batch_complete AFTER INSERT ON competitor_observation_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION competitor_observation_complete();
CREATE CONSTRAINT TRIGGER competitor_observation_rows_complete AFTER INSERT ON competitor_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION competitor_observation_complete();
CREATE FUNCTION competitor_observation_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%' AND c.relkind IN('r','p')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'collation',(SELECT collname FROM pg_collation WHERE oid=a.attcollation)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%' AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',c.conname,'def',pg_get_constraintdef(c.oid),'validated',c.convalidated) ORDER BY t.relname,c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace AND t.relname LIKE 'competitor_observation%'),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',t.relname,'name',idx.relname,'def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY t.relname,idx.relname) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class idx ON idx.oid=i.indexrelid WHERE t.relnamespace='public'::regnamespace AND t.relname LIKE 'competitor_observation%'),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND(t.tgname LIKE 'competitor_observation%' OR(c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%'))),
 'policies',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),pg_get_userbyid(x.grantor),x.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE')) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'competitor_observation%'),
 'app_role',(SELECT jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'create_role',r.rolcreaterole,'create_db',r.rolcreatedb,'login',r.rolcanlogin) FROM pg_roles r WHERE rolname='dyna_app'),
 'app_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'select',has_table_privilege('dyna_app',c.oid,'SELECT'),'insert',has_table_privilege('dyna_app',c.oid,'INSERT'),'update',has_table_privilege('dyna_app',c.oid,'UPDATE'),'delete',has_table_privilege('dyna_app',c.oid,'DELETE')) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'competitor_observation%' AND c.relkind IN('r','p'))
 )::text,'UTF8')),'hex')
$$;
CREATE FUNCTION competitor_observation_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF to_regclass('public.competitor_observation_manifest') IS NULL OR to_regprocedure('public.competitor_observation_fingerprint()') IS NULL THEN RETURN false;END IF;
 RETURN(SELECT count(*)=1 AND bool_and(profile='local-explicit-observations/v1' AND fingerprint=public.competitor_observation_fingerprint()) FROM public.competitor_observation_manifest);
END $$;
CREATE FUNCTION competitor_observation_available() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE installed boolean; artifacts boolean;
BEGIN
 SELECT EXISTS(SELECT FROM public.migrations WHERE name='163_competitor_observations') INTO installed;
 SELECT EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'competitor_observation%') OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'competitor_observation%') INTO artifacts;
 IF NOT installed AND NOT artifacts THEN RETURN false;END IF;
 IF NOT installed OR NOT public.competitor_observation_guards() THEN RAISE EXCEPTION 'Incomplete local competitor observations' USING ERRCODE='55000';END IF;RETURN true;
END $$;
CREATE FUNCTION competitor_observation_identity(t uuid,u uuid,k uuid,h text,r text,w boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x record;
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';END IF;
 IF pin THEN PERFORM 1 FROM public.users WHERE id=u FOR SHARE;PERFORM 1 FROM public.tenants WHERE id=t FOR SHARE;PERFORM 1 FROM public.account_security WHERE user_id=u FOR SHARE;PERFORM 1 FROM public.workspace_security_policies WHERE tenant_id=t FOR SHARE;PERFORM 1 FROM public.memberships WHERE(user_id,tenant_id)=(u,t) FOR SHARE;
  IF k IS NULL THEN PERFORM 1 FROM public.sessions WHERE(token_hash,user_id,tenant_id)=(h,u,t) FOR SHARE;ELSE PERFORM 1 FROM public.api_keys WHERE(id,user_id,tenant_id)=(k,u,t) FOR SHARE;END IF;
 END IF;
 IF k IS NULL THEN
  SELECT m.role,coalesce(a.version,0)::text account_version,to_jsonb(p) policy,true scope_ok,
   coalesce(p.require_mfa,false) AND NOT(coalesce(a.enabled_at IS NOT NULL AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>clock_timestamp()-interval '8 hours',false)) mfa_required INTO x
  FROM public.sessions s JOIN public.users z ON z.id=s.user_id JOIN public.tenants n ON n.id=s.tenant_id JOIN public.memberships m ON(m.user_id,m.tenant_id)=(z.id,n.id) LEFT JOIN public.account_security a ON a.user_id=z.id LEFT JOIN public.workspace_security_policies p ON p.tenant_id=n.id
  WHERE(s.token_hash,s.user_id,s.tenant_id)=(h,u,t) AND s.expires_at>clock_timestamp() AND s.account_version=coalesce(a.version,0);
 ELSE
  SELECT m.role,coalesce(a.version,0)::text account_version,to_jsonb(p) policy,k0.scopes,
   k0.scopes@>CASE WHEN w THEN ARRAY['products:read','products:write']::text[] ELSE ARRAY['products:read']::text[] END scope_ok,coalesce(p.require_mfa,false) AND a.enabled_at IS NULL mfa_required INTO x
  FROM public.api_keys k0 JOIN public.users z ON z.id=k0.user_id JOIN public.tenants n ON n.id=k0.tenant_id JOIN public.memberships m ON(m.user_id,m.tenant_id)=(z.id,n.id) LEFT JOIN public.account_security a ON a.user_id=z.id LEFT JOIN public.workspace_security_policies p ON p.tenant_id=n.id
  WHERE(k0.id,k0.token_hash,k0.user_id,k0.tenant_id)=(k,h,u,t) AND k0.revoked_at IS NULL AND k0.expires_at>clock_timestamp();
 END IF;
 IF x.role IS NULL THEN RAISE EXCEPTION 'Expired local authority' USING ERRCODE='28000';END IF;
 IF x.role<>r THEN RAISE EXCEPTION 'Local role changed' USING ERRCODE='40001';END IF;
 IF NOT coalesce(x.scope_ok,false) OR coalesce(x.mfa_required,true) OR(w AND x.role<>'admin') THEN RAISE EXCEPTION 'Missing current local authority' USING ERRCODE='42501';END IF;
 RETURN to_jsonb(x);
END $$;
CREATE FUNCTION competitor_observation_terminal(t uuid,u uuid,k uuid,h text,r text,w boolean,valid_until timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.competitor_observation_identity(t,u,k,h,r,w,true);
 IF NOT public.competitor_observation_available() THEN RAISE EXCEPTION 'Missing local observation module' USING ERRCODE='55000';END IF;
 PERFORM public.competitor_observation_identity(t,u,k,h,r,w,false);IF valid_until IS NOT NULL AND clock_timestamp()>=valid_until THEN RAISE EXCEPTION 'Ranking observations expired during transaction' USING ERRCODE='40001';END IF;RETURN true;
END $$;
CREATE FUNCTION competitor_observation_worker_identity(t uuid,u uuid,lists uuid[],pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x record;
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Worker tenant mismatch' USING ERRCODE='42501';END IF;
 IF pin THEN PERFORM 1 FROM public.users WHERE id=u FOR SHARE;PERFORM 1 FROM public.tenants WHERE id=t FOR SHARE;PERFORM 1 FROM public.account_security WHERE user_id=u FOR SHARE;PERFORM 1 FROM public.workspace_security_policies WHERE tenant_id=t FOR SHARE;PERFORM 1 FROM public.memberships WHERE(user_id,tenant_id)=(u,t) FOR SHARE;END IF;
 SELECT m.role,coalesce(a.version,0)::text account_version,to_jsonb(p) policy,coalesce(p.require_mfa,false) AND a.enabled_at IS NULL mfa_required INTO x FROM public.memberships m JOIN public.users z ON z.id=m.user_id JOIN public.tenants n ON n.id=m.tenant_id LEFT JOIN public.account_security a ON a.user_id=z.id LEFT JOIN public.workspace_security_policies p ON p.tenant_id=n.id WHERE(m.tenant_id,m.user_id)=(t,u);
 IF x.role IS DISTINCT FROM 'admin' OR coalesce(x.mfa_required,true) THEN RAISE EXCEPTION 'Current schedule administrator required' USING ERRCODE='42501';END IF;
 IF lists IS NULL THEN IF NOT EXISTS(SELECT FROM public.repricing_schedules s WHERE(s.tenant_id,s.actor_id)=(t,u)) THEN RAISE EXCEPTION 'Missing native schedule author' USING ERRCODE='42501';END IF;
 ELSE
  IF cardinality(lists) NOT BETWEEN 1 AND 1000 OR EXISTS(SELECT FROM unnest(lists) id WHERE NOT EXISTS(SELECT FROM public.repricing_schedules s WHERE(s.tenant_id,s.price_list_id,s.actor_id)=(t,id,u))) THEN RAISE EXCEPTION 'Native schedule author changed' USING ERRCODE='42501';END IF;
 END IF;RETURN to_jsonb(x);
END $$;
CREATE FUNCTION competitor_observation_worker_terminal(t uuid,u uuid,lists uuid[],valid_until timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.competitor_observation_worker_identity(t,u,lists,true);IF NOT public.competitor_observation_available() THEN RAISE EXCEPTION 'Missing observations module' USING ERRCODE='55000';END IF;PERFORM public.competitor_observation_worker_identity(t,u,lists,false);IF valid_until IS NOT NULL AND clock_timestamp()>=valid_until THEN RAISE EXCEPTION 'Worker ranking expired' USING ERRCODE='40001';END IF;RETURN true;END $$;
CREATE FUNCTION competitor_observation_rank_terminal(valid_until timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF NOT public.competitor_observation_available() THEN RAISE EXCEPTION 'Missing observations module' USING ERRCODE='55000';END IF;IF valid_until IS NOT NULL AND clock_timestamp()>=valid_until THEN RAISE EXCEPTION 'Ranking observations expired during transaction' USING ERRCODE='40001';END IF;RETURN true;END $$;
REVOKE ALL ON FUNCTION competitor_observation_immutable(),competitor_observation_profile_guard(),competitor_observation_complete(),competitor_observation_fingerprint(),competitor_observation_guards(),competitor_observation_available(),competitor_observation_identity(uuid,uuid,uuid,text,text,boolean,boolean),competitor_observation_terminal(uuid,uuid,uuid,text,text,boolean,timestamptz),competitor_observation_rank_terminal(timestamptz),competitor_observation_worker_identity(uuid,uuid,uuid[],boolean),competitor_observation_worker_terminal(uuid,uuid,uuid[],timestamptz) FROM PUBLIC,dyna_app;
GRANT EXECUTE ON FUNCTION competitor_observation_guards(),competitor_observation_available(),competitor_observation_identity(uuid,uuid,uuid,text,text,boolean,boolean),competitor_observation_terminal(uuid,uuid,uuid,text,text,boolean,timestamptz),competitor_observation_rank_terminal(timestamptz),competitor_observation_worker_identity(uuid,uuid,uuid[],boolean),competitor_observation_worker_terminal(uuid,uuid,uuid[],timestamptz) TO dyna_app;
INSERT INTO competitor_observation_manifest(singleton,profile,fingerprint) VALUES(true,'local-explicit-observations/v1',competitor_observation_fingerprint());
DO $$ BEGIN IF NOT competitor_observation_guards() THEN RAISE EXCEPTION 'Observation metadata installation refused';END IF;END $$;
