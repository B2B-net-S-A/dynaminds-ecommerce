-- Saved export configuration only; no product scope, credentials or feed URLs.
CREATE FUNCTION catalog_export_profile_definition_valid(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text; v jsonb; effective text; names text[]:=ARRAY[]::text[]; chosen text[]; BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?& ARRAY['format','columns','headers','spreadsheet_safe']
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) x WHERE x NOT IN ('format','columns','headers','spreadsheet_safe'))
 OR jsonb_typeof(d->'format') IS DISTINCT FROM 'string' OR d->>'format' NOT IN ('csv','xml') OR jsonb_typeof(d->'spreadsheet_safe') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(d->'columns') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'headers') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF jsonb_array_length(d->'columns')<1 OR jsonb_array_length(d->'columns')>20 THEN RETURN false; END IF;
 chosen:=ARRAY(SELECT jsonb_array_elements_text(d->'columns'));
 IF cardinality(chosen)<>(SELECT count(DISTINCT x) FROM unnest(chosen) x) THEN RETURN false; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(d->'columns') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR NOT (v#>>'{}')=ANY(ARRAY['id','sku','ean','name','description','price_minor','vat_rate','category','active','kind','weight_g','length_mm','width_mm','height_mm','manufacturer','attributes_json','images_json','variants_json','bundle_components_json','translations_json']) THEN RETURN false; END IF;
 END LOOP;
 FOR k,v IN SELECT key,value FROM jsonb_each(d->'headers') LOOP
  IF NOT k=ANY(chosen) OR jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  effective:=v#>>'{}';
  IF char_length(effective)<1 OR char_length(effective)>80 OR effective<>btrim(effective)
  OR effective ~ '[[:cntrl:]]' OR effective ~ ('['||chr(127)||'-'||chr(159)||']')
  OR position(chr(65534) IN effective)>0 OR position(chr(65535) IN effective)>0 THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY chosen LOOP
  effective:=coalesce(d->'headers'->>k,k);
  IF lower(effective)=ANY(names) THEN RETURN false; END IF;
  IF d->>'format'='xml' AND (effective !~ '^[A-Za-z_][A-Za-z0-9_.-]*$' OR lower(effective) LIKE 'xml%') THEN RETURN false; END IF;
  names:=array_append(names,lower(effective));
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION catalog_export_profile_definition_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_export_profile_definition_valid(jsonb) TO dyna_app;

CREATE TABLE catalog_export_profiles (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 initial_request jsonb NOT NULL CHECK(jsonb_typeof(initial_request)='object'),
 name text NOT NULL CHECK(char_length(name)>=1 AND char_length(name)<=120 AND name=btrim(name) AND name !~ '[[:cntrl:]]'
 AND name !~ ('['||chr(127)||'-'||chr(159)||']') AND position(chr(65534) IN name)=0 AND position(chr(65535) IN name)=0),
 definition jsonb NOT NULL CHECK(catalog_export_profile_definition_valid(definition)),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 CHECK(octet_length(initial_request::text)<=65536),
 CHECK(initial_request ?& ARRAY['name','definition'] AND jsonb_typeof(initial_request->'name')='string' AND catalog_export_profile_definition_valid(initial_request->'definition'))
);
CREATE UNIQUE INDEX catalog_export_profiles_active_name ON catalog_export_profiles(tenant_id,lower(name)) WHERE NOT archived;
CREATE INDEX catalog_export_profiles_history ON catalog_export_profiles(tenant_id,created_at DESC,id DESC);
ALTER TABLE catalog_export_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_export_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON catalog_export_profiles TO dyna_app
 USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON catalog_export_profiles TO dyna_app;

CREATE FUNCTION catalog_export_profile_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Export profile identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.archived OR NEW.initial_request IS DISTINCT FROM jsonb_build_object('name',NEW.name,'definition',NEW.definition) THEN
   RAISE EXCEPTION 'Export profile initial request mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.tenant_id,NEW.actor_id,NEW.client_key,NEW.request_hash,NEW.initial_request,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.actor_id,OLD.client_key,OLD.request_hash,OLD.initial_request,OLD.created_at)
   OR NEW.version::bigint<>OLD.version::bigint+1 OR NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION 'Export profile identity and revision are immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_export_profile_scope BEFORE INSERT OR UPDATE OR DELETE ON catalog_export_profiles FOR EACH ROW EXECUTE FUNCTION catalog_export_profile_scope();

CREATE FUNCTION catalog_export_profile_quota() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog-export-profiles:'||NEW.tenant_id::text,0));
 IF (SELECT count(*) FROM public.catalog_export_profiles WHERE tenant_id=NEW.tenant_id)>=200 THEN
  RAISE EXCEPTION 'Export profile limit includes archived profiles' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_export_profile_quota BEFORE INSERT ON catalog_export_profiles FOR EACH ROW EXECUTE FUNCTION catalog_export_profile_quota();

-- No role pin before profile/audit/FK waits. Final authorization is member -> key.
CREATE FUNCTION catalog_export_profile_role(p_user uuid,p_lock boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE r text; BEGIN
 IF p_lock THEN
  SELECT role INTO r FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user FOR SHARE;
 ELSE
  SELECT role INTO r FROM public.memberships WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user;
 END IF; RETURN r;
END $$;
CREATE FUNCTION catalog_export_profile_key_grant(p_user uuid,p_key uuid,p_write boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE k record; BEGIN
 SELECT revoked_at,expires_at,scopes INTO k FROM public.api_keys
 WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND user_id=p_user AND id=p_key FOR SHARE;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR k.expires_at<=clock_timestamp() THEN RETURN 'invalid'; END IF;
 IF NOT k.scopes @> ARRAY['products:read']::text[] OR (p_write AND NOT k.scopes @> ARRAY['products:write']::text[]) THEN RETURN 'insufficient'; END IF;
 IF NOT k.scopes @> ARRAY['products:write']::text[] THEN RETURN 'read_only'; END IF;
 RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION catalog_export_profile_role(uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog_export_profile_key_grant(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_export_profile_role(uuid,boolean),catalog_export_profile_key_grant(uuid,uuid,boolean) TO dyna_app;
