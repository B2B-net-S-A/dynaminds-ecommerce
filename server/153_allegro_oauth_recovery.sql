-- Connection-scoped durable submission barrier. No provider tokens/secrets are stored.
-- Fresh migration only; never rebase a manifest in an installed database.
CREATE TABLE public.allegro_oauth_recovery_attempts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 channel_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN ('session','api_key','job')),
 job_id uuid,
 grant_type text NOT NULL CHECK(grant_type IN ('refresh_token','authorization_code')),
 mode text NOT NULL CHECK(mode IN ('sandbox','live')),
 connection_id uuid,
 credentials_hash text NOT NULL CHECK(credentials_hash ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('may_have_been_sent','refused','committed','superseded')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 finished_at timestamptz,
 finished_xid xid8,
 result_connection_id uuid,
 result_credentials_hash text CHECK(result_credentials_hash ~ '^[0-9a-f]{64}$'),
 refusal_code text CHECK(refusal_code IN ('response_unknown','local_commit_refused')),
 UNIQUE(tenant_id,id),
 CHECK((actor_kind='job')=(job_id IS NOT NULL)),
 CHECK((state='may_have_been_sent' AND finished_at IS NULL AND finished_xid IS NULL
        AND result_connection_id IS NULL AND result_credentials_hash IS NULL AND refusal_code IS NULL)
    OR (state='refused' AND finished_at IS NOT NULL AND finished_xid IS NOT NULL
        AND result_connection_id IS NULL AND result_credentials_hash IS NULL AND refusal_code IS NOT NULL)
    OR (state='committed' AND finished_at IS NOT NULL AND finished_xid IS NOT NULL
        AND result_credentials_hash IS NOT NULL AND refusal_code IS NULL)
    OR (state='superseded' AND finished_at IS NOT NULL AND finished_xid IS NOT NULL
        AND result_connection_id IS NOT NULL AND result_credentials_hash IS NULL))
);
CREATE UNIQUE INDEX allegro_oauth_recovery_refresh_unresolved
 ON public.allegro_oauth_recovery_attempts(tenant_id,channel_id)
 WHERE grant_type='refresh_token' AND state IN ('may_have_been_sent','refused');
CREATE INDEX allegro_oauth_recovery_channel ON public.allegro_oauth_recovery_attempts(tenant_id,channel_id,id);
ALTER TABLE public.allegro_oauth_recovery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allegro_oauth_recovery_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.allegro_oauth_recovery_attempts FROM PUBLIC,dyna_app;
CREATE TABLE public.allegro_oauth_recovery_manifest (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), fingerprint text NOT NULL
 CHECK(fingerprint ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.allegro_oauth_recovery_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allegro_oauth_recovery_manifest FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.allegro_oauth_recovery_manifest FROM PUBLIC,dyna_app;

CREATE FUNCTION public.allegro_oauth_recovery_fingerprint() RETURNS text
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),
 'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),
 CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
 ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',x.attname,'type',format_type(x.atttypid,x.atttypmod),
 'null',x.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),
 'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),
 CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
 ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(x.attacl) a)) ORDER BY x.attnum)
 FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum)
 WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred)
 ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT coalesce(jsonb_agg(pg_get_expr(p.polqual,p.polrelid) ORDER BY p.polname),'[]'::jsonb)
 FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 AND c.relname IN ('allegro_oauth_recovery_attempts','allegro_oauth_recovery_manifest')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_get_function_identity_arguments(p.oid),
 'result',pg_get_function_result(p.oid),'body',p.prosrc,'defaults',pg_get_expr(p.proargdefaults,0),
 'owner',pg_get_userbyid(p.proowner),'config',p.proconfig,'sd',p.prosecdef,'volatility',p.provolatile,
 'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),
 CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
 ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a))
 ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'allegro_oauth_recovery_%'),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY ci.relname) FROM pg_index i
 JOIN pg_class ci ON ci.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
 JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
 AND t.relname IN ('allegro_oauth_recovery_attempts','allegro_oauth_recovery_manifest')),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,pg_get_triggerdef(t.oid),t.tgenabled)
 ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE NOT t.tgisinternal AND (c.oid IN ('public.allegro_oauth_recovery_attempts'::regclass,
 'public.allegro_oauth_recovery_manifest'::regclass) OR t.tgname='allegro_oauth_recovery_source_seal'))
 )::text,'UTF8')),'hex');
$$;
CREATE FUNCTION public.allegro_oauth_recovery_guards() RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.migrations WHERE name='153_allegro_oauth_recovery')
 AND (SELECT count(*)=2 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('allegro_oauth_recovery_attempts','allegro_oauth_recovery_manifest')
 AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='postgres')
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
 LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 WHERE n.nspname='public' AND c.relname IN ('allegro_oauth_recovery_attempts','allegro_oauth_recovery_manifest')
 AND a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute x JOIN pg_class c ON c.oid=x.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace,
 LATERAL aclexplode(x.attacl) a WHERE n.nspname='public'
 AND c.relname IN ('allegro_oauth_recovery_attempts','allegro_oauth_recovery_manifest') AND a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
 LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE n.nspname='public' AND p.proname LIKE 'allegro_oauth_recovery_%' AND a.grantee<>p.proowner)
 AND (SELECT count(*)=8 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'allegro_oauth_recovery_%' AND pg_get_userbyid(p.proowner)='postgres')
 AND (SELECT fingerprint=public.allegro_oauth_recovery_fingerprint() FROM public.allegro_oauth_recovery_manifest WHERE singleton);
$$;
CREATE FUNCTION public.allegro_oauth_recovery_require() RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.allegro_oauth_recovery_guards() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Niekompletny moduł odzyskiwania OAuth Allegro' USING ERRCODE='55000';
 END IF;
END $$;
CREATE FUNCTION public.allegro_oauth_recovery_record_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE ch record;
BEGIN
 PERFORM public.allegro_oauth_recovery_require();
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Historia OAuth jest niezmienna' USING ERRCODE='23514'; END IF;
 IF current_user<>'postgres' OR NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true) THEN
  RAISE EXCEPTION 'Nieprawidłowa prywatna zgoda OAuth' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'may_have_been_sent' OR NEW.created_xid<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Nieprawidłowa faza zgłoszenia OAuth' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','finished_at','finished_xid','result_connection_id','result_credentials_hash','refusal_code'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','finished_at','finished_xid','result_connection_id','result_credentials_hash','refusal_code'])
   OR OLD.state NOT IN ('may_have_been_sent','refused') OR NEW.finished_xid<>pg_current_xact_id()
   OR NEW.state NOT IN ('refused','committed','superseded') THEN
    RAISE EXCEPTION 'Nieprawidłowa zmiana historii OAuth' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT c.*,c.xmin::text source_xid,encode(sha256(convert_to(c.credentials,'UTF8')),'hex') credentials_hash INTO ch
 FROM public.channels c WHERE(c.tenant_id,c.id)=(NEW.tenant_id,NEW.channel_id);
 IF ch.id IS NULL OR ch.provider<>'allegro' OR (NEW.state<>'superseded' AND ch.mode<>NEW.mode) OR coalesce((ch.settings->>'simulation')::boolean,false) THEN
  RAISE EXCEPTION 'Źródło zgłoszenia OAuth zmieniło się' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND ((ch.settings->>'oauth_connection_id')::uuid IS DISTINCT FROM NEW.connection_id
  OR ch.credentials_hash<>NEW.credentials_hash) THEN
  RAISE EXCEPTION 'Źródło zgłoszenia OAuth zmieniło się' USING ERRCODE='23514'; END IF;
 IF NEW.state='committed' AND (ch.source_xid::numeric<>mod(pg_current_xact_id()::text::numeric,4294967296)
  OR ch.credentials_hash IS NOT DISTINCT FROM NEW.credentials_hash
  OR ch.credentials_hash IS DISTINCT FROM NEW.result_credentials_hash
  OR (ch.settings->>'oauth_connection_id')::uuid IS DISTINCT FROM NEW.result_connection_id
  OR (NEW.grant_type='refresh_token' AND NEW.result_connection_id IS DISTINCT FROM NEW.connection_id)
  OR (NEW.grant_type='authorization_code' AND (NEW.result_connection_id IS NULL OR NEW.result_connection_id IS NOT DISTINCT FROM NEW.connection_id))) THEN
  RAISE EXCEPTION 'Brak rzeczywistego zapisu tokenów OAuth' USING ERRCODE='23514'; END IF;
 IF NEW.state='superseded' AND ((ch.settings->>'oauth_connection_id')::uuid IS DISTINCT FROM NEW.result_connection_id
  OR NEW.result_connection_id IS NOT DISTINCT FROM NEW.connection_id
  OR NOT EXISTS(SELECT 1 FROM public.allegro_oauth_recovery_attempts accepted WHERE accepted.tenant_id=NEW.tenant_id
   AND accepted.channel_id=NEW.channel_id AND accepted.state='committed' AND accepted.grant_type='authorization_code'
   AND accepted.finished_xid=pg_current_xact_id() AND accepted.result_connection_id=NEW.result_connection_id)) THEN
  RAISE EXCEPTION 'Brak nowego połączenia odzyskiwania OAuth' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.allegro_oauth_recovery_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.allegro_oauth_recovery_attempts; ch record;
BEGIN
 PERFORM public.allegro_oauth_recovery_require();
 SELECT * INTO a FROM public.allegro_oauth_recovery_attempts WHERE id=NEW.id;
 IF a.state='committed' AND a.finished_xid=pg_current_xact_id() THEN
  SELECT encode(sha256(convert_to(c.credentials,'UTF8')),'hex') hash,(c.settings->>'oauth_connection_id')::uuid conn INTO ch
   FROM public.channels c WHERE(c.tenant_id,c.id)=(a.tenant_id,a.channel_id);
  IF ch.hash IS DISTINCT FROM a.result_credentials_hash OR ch.conn IS DISTINCT FROM a.result_connection_id THEN
   RAISE EXCEPTION 'Zapis tokenów OAuth zmienił się przed zatwierdzeniem' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION public.allegro_oauth_recovery_statement_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.allegro_oauth_recovery_require(); RETURN NULL; END $$;
CREATE FUNCTION public.allegro_oauth_recovery_manifest_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Manifest OAuth jest niezmienny' USING ERRCODE='23514'; END $$;
CREATE FUNCTION public.allegro_oauth_recovery_source_seal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.allegro_oauth_recovery_attempts a
 WHERE ((a.tenant_id,a.channel_id)=(OLD.tenant_id,OLD.id)
 OR (TG_OP='UPDATE' AND (a.tenant_id,a.channel_id)=(NEW.tenant_id,NEW.id)))
 AND a.state='committed' AND a.finished_xid=pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Źródło zapisu OAuth jest już zamknięte' USING ERRCODE='23514'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER allegro_oauth_recovery_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public.allegro_oauth_recovery_attempts
 FOR EACH ROW EXECUTE FUNCTION public.allegro_oauth_recovery_record_guard();
CREATE CONSTRAINT TRIGGER allegro_oauth_recovery_complete AFTER INSERT OR UPDATE ON public.allegro_oauth_recovery_attempts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.allegro_oauth_recovery_complete();
CREATE TRIGGER allegro_oauth_recovery_before BEFORE INSERT OR UPDATE OR DELETE ON public.allegro_oauth_recovery_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION public.allegro_oauth_recovery_statement_guard();
CREATE TRIGGER allegro_oauth_recovery_after AFTER INSERT OR UPDATE OR DELETE ON public.allegro_oauth_recovery_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION public.allegro_oauth_recovery_statement_guard();
CREATE TRIGGER allegro_oauth_recovery_manifest_immutable BEFORE UPDATE OR DELETE ON public.allegro_oauth_recovery_manifest
 FOR EACH ROW EXECUTE FUNCTION public.allegro_oauth_recovery_manifest_immutable();
CREATE TRIGGER allegro_oauth_recovery_source_seal BEFORE UPDATE OR DELETE ON public.channels
 FOR EACH ROW EXECUTE FUNCTION public.allegro_oauth_recovery_source_seal();
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'allegro_oauth_recovery_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);
 END LOOP;
END $$;
INSERT INTO public.allegro_oauth_recovery_manifest(fingerprint) VALUES(public.allegro_oauth_recovery_fingerprint());
