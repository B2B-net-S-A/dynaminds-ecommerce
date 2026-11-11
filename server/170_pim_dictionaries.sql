-- Local native PIM170 migration candidate. Root assembled exact reviewed units.
-- Capture all25 native predecessors before any PIM DDL, verify before sealing.
CREATE TEMP TABLE dyna_pim_predecessor_capture ON COMMIT DROP AS SELECT jsonb_object_agg(p.proname,jsonb_build_object('catalog_row',to_jsonb(p),'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname) value FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.pronargs=0 AND p.proname=ANY(ARRAY['allegro_oauth_recovery_guards','b2b_credit_guards','b2b_invoice_guards','buyer_address_guards','catalog_stock_control_guards','catalog_stock_count_guards','catalog_stock_legacy_group_guards','catalog_stock_return_guards','competitor_observation_guards','credit_source_upgrade_valid','fa3_draft_guards','financial_return_guards','financial_return_upgrade_valid','label_print_guards','local_invoice_guards','manual_inventory_off_valid','operative_delivery_valid','packed_label_print_guards','parcel_physical_wz_valid','print_job_guards','product_rule_price_tags_guards','product_rule_schedule_guards','stocktake_adjustment_guards','warehouse_automatic_wz_guards','warehouse_wz_issuer_guards']::text[]);
REVOKE ALL ON pg_temp.dyna_pim_predecessor_capture FROM PUBLIC,dyna_app;
-- Source unit schema.sql SHA256 a9981af928ae1f1a766c861453546bad32d30477a86908c74bba7a7e42108373
-- UNNUMBERED PRIVATE CANDIDATE / NOT_APPLY_READY / NOT_EXECUTED.
-- Nine sidecars. No parent DDL or old function/guard/certificate replacement.
-- No application grants or sealing in this candidate; managed producer/fingerprint
-- and all25 predecessor/install/recovery gates must finish before root adoption.
SET LOCAL TimeZone='UTC';
DO $$ BEGIN
 IF current_user IS DISTINCT FROM session_user OR NOT public.manual_inventory_off_valid()
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'pim_dictionary_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pim_dictionary_'))
 THEN RAISE EXCEPTION 'PIM requires intact169, native owner and no remnants' USING ERRCODE='55000';END IF;
END $$;
CREATE TABLE pim_dictionary_heads(tenant_id uuid NOT NULL,catalog_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),last_operation_id uuid NOT NULL,PRIMARY KEY(tenant_id,catalog_id),FOREIGN KEY(tenant_id,catalog_id) REFERENCES product_catalogs(tenant_id,id));
CREATE TABLE pim_dictionary_categories(tenant_id uuid NOT NULL,catalog_id uuid NOT NULL,id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),parent_id uuid,name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120 AND name=btrim(name)),active boolean NOT NULL,PRIMARY KEY(tenant_id,catalog_id,id),FOREIGN KEY(tenant_id,catalog_id) REFERENCES product_catalogs(tenant_id,id),FOREIGN KEY(tenant_id,catalog_id,parent_id) REFERENCES pim_dictionary_categories(tenant_id,catalog_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX pim_dictionary_categories_parent ON pim_dictionary_categories(tenant_id,catalog_id,parent_id);
CREATE TABLE pim_dictionary_definitions(tenant_id uuid NOT NULL,catalog_id uuid NOT NULL,id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120 AND name=btrim(name)),active boolean NOT NULL,shape jsonb NOT NULL CHECK(jsonb_typeof(shape)='object'),PRIMARY KEY(tenant_id,catalog_id,id),FOREIGN KEY(tenant_id,catalog_id) REFERENCES product_catalogs(tenant_id,id));
CREATE TABLE pim_dictionary_bindings(tenant_id uuid NOT NULL,catalog_id uuid NOT NULL,category_id uuid NOT NULL,definition_id uuid NOT NULL,required boolean NOT NULL,PRIMARY KEY(tenant_id,catalog_id,category_id,definition_id),FOREIGN KEY(tenant_id,catalog_id,category_id) REFERENCES pim_dictionary_categories(tenant_id,catalog_id,id),FOREIGN KEY(tenant_id,catalog_id,definition_id) REFERENCES pim_dictionary_definitions(tenant_id,catalog_id,id));
CREATE INDEX pim_dictionary_bindings_definition ON pim_dictionary_bindings(tenant_id,catalog_id,definition_id,category_id);
CREATE TABLE pim_dictionary_product_states(tenant_id uuid NOT NULL,product_id uuid NOT NULL,catalog_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),category_id uuid,typed_values jsonb NOT NULL CHECK(jsonb_typeof(typed_values)='array' AND jsonb_array_length(typed_values)<=50 AND(category_id IS NOT NULL OR typed_values='[]'::jsonb)),last_operation_id uuid NOT NULL,PRIMARY KEY(tenant_id,product_id),FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,catalog_id) REFERENCES product_catalogs(tenant_id,id),FOREIGN KEY(tenant_id,catalog_id,category_id) REFERENCES pim_dictionary_categories(tenant_id,catalog_id,id));
CREATE INDEX pim_dictionary_product_states_category ON pim_dictionary_product_states(tenant_id,catalog_id,category_id,product_id);
CREATE TABLE pim_dictionary_previews(tenant_id uuid NOT NULL,catalog_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),kind text NOT NULL CHECK(kind IN('dictionary','product_values')),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=1048576),frame jsonb NOT NULL CHECK(jsonb_typeof(frame)='object' AND octet_length(frame::text)<=2097152),projection jsonb NOT NULL CHECK(jsonb_typeof(projection)='object' AND octet_length(projection::text)<=2097152),ready boolean NOT NULL,errors jsonb NOT NULL CHECK(jsonb_typeof(errors)='array'),created_at timestamptz NOT NULL CHECK(isfinite(created_at)),expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at=created_at+interval '15 minutes'),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,actor_id,client_key),FOREIGN KEY(tenant_id,catalog_id) REFERENCES product_catalogs(tenant_id,id),FOREIGN KEY(actor_id) REFERENCES users(id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id));
CREATE INDEX pim_dictionary_previews_history ON pim_dictionary_previews(tenant_id,catalog_id,created_at DESC,id DESC);
CREATE TABLE pim_dictionary_admissions(tenant_id uuid NOT NULL,id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),root_xid text NOT NULL,start_at timestamptz NOT NULL CHECK(isfinite(start_at)),backend_pid integer NOT NULL,identity jsonb NOT NULL CHECK(jsonb_typeof(identity)='object'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=2097152),created_at timestamptz NOT NULL CHECK(isfinite(created_at)),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,preview_id),FOREIGN KEY(tenant_id,preview_id) REFERENCES pim_dictionary_previews(tenant_id,id));
CREATE TABLE pim_dictionary_operations(tenant_id uuid NOT NULL,id uuid NOT NULL,preview_id uuid NOT NULL,catalog_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),kind text NOT NULL CHECK(kind IN('dictionary','product_values')),changed_count integer NOT NULL CHECK(changed_count BETWEEN 0 AND 500),body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND octet_length(body::text)<=2097152),created_at timestamptz NOT NULL CHECK(isfinite(created_at)),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,actor_id,client_key),FOREIGN KEY(tenant_id,id) REFERENCES pim_dictionary_admissions(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,preview_id) REFERENCES pim_dictionary_previews(tenant_id,id),FOREIGN KEY(tenant_id,catalog_id) REFERENCES product_catalogs(tenant_id,id));
ALTER TABLE pim_dictionary_admissions ADD CONSTRAINT pim_dictionary_admission_operation FOREIGN KEY(tenant_id,id) REFERENCES pim_dictionary_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE pim_dictionary_heads ADD CONSTRAINT pim_dictionary_head_operation FOREIGN KEY(tenant_id,last_operation_id) REFERENCES pim_dictionary_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE pim_dictionary_product_states ADD CONSTRAINT pim_dictionary_state_operation FOREIGN KEY(tenant_id,last_operation_id) REFERENCES pim_dictionary_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE pim_dictionary_manifest(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),predecessors jsonb NOT NULL CHECK(jsonb_typeof(predecessors)='object'),created_at timestamptz NOT NULL CHECK(isfinite(created_at)));
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['pim_dictionary_heads','pim_dictionary_categories','pim_dictionary_definitions','pim_dictionary_bindings','pim_dictionary_product_states','pim_dictionary_previews','pim_dictionary_admissions','pim_dictionary_operations'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation_name);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation_name);
 EXECUTE format($policy$CREATE POLICY tenant_scope ON public.%I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$,relation_name);
 EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,dyna_app',relation_name);
 END LOOP;
 REVOKE ALL ON pim_dictionary_manifest FROM PUBLIC,dyna_app;
END $$;
CREATE FUNCTION pim_dictionary_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$ SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') $$;
CREATE FUNCTION pim_dictionary_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Immutable PIM evidence' USING ERRCODE='23514';END $$;
CREATE TRIGGER pim_dictionary_preview_immutable BEFORE UPDATE OR DELETE ON pim_dictionary_previews FOR EACH ROW EXECUTE FUNCTION pim_dictionary_immutable();
CREATE TRIGGER pim_dictionary_admission_immutable BEFORE UPDATE OR DELETE ON pim_dictionary_admissions FOR EACH ROW EXECUTE FUNCTION pim_dictionary_immutable();
CREATE TRIGGER pim_dictionary_operation_immutable BEFORE UPDATE OR DELETE ON pim_dictionary_operations FOR EACH ROW EXECUTE FUNCTION pim_dictionary_immutable();
CREATE TRIGGER pim_dictionary_manifest_immutable BEFORE UPDATE OR DELETE ON pim_dictionary_manifest FOR EACH ROW EXECUTE FUNCTION pim_dictionary_immutable();
CREATE FUNCTION pim_dictionary_frame(t uuid,cid uuid,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE catalog_row public.product_catalogs%ROWTYPE;head_row public.pim_dictionary_heads%ROWTYPE;categories_json jsonb;definitions_json jsonb;dictionary_json jsonb;
BEGIN
 PERFORM public.pim_dictionary_custody(t);
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PIM tenant mismatch' USING ERRCODE='42501';END IF;
 IF pin THEN PERFORM pg_advisory_xact_lock(hashtextextended('pim_dictionary:'||t::text||':'||cid::text,0));SELECT * INTO catalog_row FROM public.product_catalogs pc WHERE(pc.tenant_id,pc.id)=(t,cid) FOR SHARE;PERFORM 1 FROM public.pim_dictionary_heads ph WHERE(ph.tenant_id,ph.catalog_id)=(t,cid) FOR UPDATE;
 ELSE SELECT * INTO catalog_row FROM public.product_catalogs pc WHERE(pc.tenant_id,pc.id)=(t,cid);END IF;
 IF catalog_row.id IS NULL THEN RAISE EXCEPTION 'Unknown own catalog' USING ERRCODE='P0002';END IF;
 SELECT * INTO head_row FROM public.pim_dictionary_heads ph WHERE(ph.tenant_id,ph.catalog_id)=(t,cid);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',pc.id,'version',pc.version::text,'parent_id',pc.parent_id,'name',pc.name,'active',pc.active,'bindings',coalesce((SELECT jsonb_agg(jsonb_build_object('definition_id',pb.definition_id,'required',pb.required) ORDER BY pb.definition_id) FROM public.pim_dictionary_bindings pb WHERE(pb.tenant_id,pb.catalog_id,pb.category_id)=(t,cid,pc.id)),'[]'::jsonb)) ORDER BY pc.id),'[]'::jsonb) INTO categories_json FROM public.pim_dictionary_categories pc WHERE(pc.tenant_id,pc.catalog_id)=(t,cid);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',pd.id,'version',pd.version::text,'name',pd.name,'active',pd.active,'shape',pd.shape) ORDER BY pd.id),'[]'::jsonb) INTO definitions_json FROM public.pim_dictionary_definitions pd WHERE(pd.tenant_id,pd.catalog_id)=(t,cid);
 dictionary_json:=jsonb_build_object('categories',categories_json,'definitions',definitions_json);
 IF head_row.version IS NULL AND(dictionary_json->'categories'<>'[]'::jsonb OR dictionary_json->'definitions'<>'[]'::jsonb) THEN RAISE EXCEPTION 'PIM torn namespace' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('catalog_id',cid,'revision',jsonb_build_object('catalog_version',catalog_row.version::text,'dictionary_version',coalesce(head_row.version,0)::text,'schema_hash',public.pim_dictionary_hash(dictionary_json)),'dictionary',dictionary_json);
END $$;
CREATE FUNCTION pim_dictionary_product_frame(t uuid,cid uuid,pid uuid,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE product_row public.products%ROWTYPE;state_row public.pim_dictionary_product_states%ROWTYPE;result_json jsonb;
BEGIN
 PERFORM public.pim_dictionary_custody(t);
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PIM tenant mismatch' USING ERRCODE='42501';END IF;
 IF pin THEN SELECT * INTO product_row FROM public.products pp WHERE(pp.tenant_id,pp.id,pp.catalog_id)=(t,pid,cid) FOR SHARE;PERFORM 1 FROM public.pim_dictionary_product_states ps WHERE(ps.tenant_id,ps.product_id)=(t,pid) FOR UPDATE;
 ELSE SELECT * INTO product_row FROM public.products pp WHERE(pp.tenant_id,pp.id,pp.catalog_id)=(t,pid,cid);END IF;
 IF product_row.id IS NULL THEN RAISE EXCEPTION 'Unknown catalog product' USING ERRCODE='P0002';END IF;
 SELECT * INTO state_row FROM public.pim_dictionary_product_states ps WHERE(ps.tenant_id,ps.product_id)=(t,pid);
 IF state_row.product_id IS NOT NULL AND state_row.catalog_id<>cid THEN RAISE EXCEPTION 'PIM product catalog drift' USING ERRCODE='23514';END IF;
 result_json:=jsonb_build_object('catalog_id',cid,'product_id',pid,'sku',product_row.sku,'name',product_row.name,'product_version',product_row.version::text,'state_version',coalesce(state_row.version,0)::text,'category_id',state_row.category_id,'values',coalesce(state_row.typed_values,'[]'::jsonb),'legacy',jsonb_build_object('category',product_row.category,'attributes',product_row.attributes));
 RETURN result_json||jsonb_build_object('source_hash',public.pim_dictionary_hash(result_json));
END $$;
-- Owner-only until native semantic producer, deferred delta closure, portable
-- manifest, source/final-IAM terminal and exact grants are reviewed together.
REVOKE ALL ON FUNCTION pim_dictionary_hash(jsonb),pim_dictionary_immutable(),pim_dictionary_frame(uuid,uuid,boolean),pim_dictionary_product_frame(uuid,uuid,uuid,boolean) FROM PUBLIC,dyna_app;

-- Source unit identity.sql SHA256 be33c60cf26729db10b70a92fd0ccc1f0c7d5464deed72ed565fa3ccf6cd7272
-- PRIVATE UNNUMBERED CANDIDATE: exact166 fresh credential semantics, scoped to products.
-- No existing function/ACL changed. Owner bridge and final seal still required.
CREATE FUNCTION pim_dictionary_identity(t uuid,u uuid,k uuid,h text,r text,w boolean,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE x record;
BEGIN
 PERFORM public.pim_dictionary_begin();
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';END IF;
 IF pin THEN PERFORM 1 FROM public.users WHERE id=u FOR SHARE;PERFORM 1 FROM public.tenants WHERE id=t FOR SHARE;PERFORM 1 FROM public.account_security WHERE user_id=u FOR SHARE;PERFORM 1 FROM public.workspace_security_policies WHERE tenant_id=t FOR SHARE;PERFORM 1 FROM public.memberships WHERE(user_id,tenant_id)=(u,t) FOR SHARE;
  IF k IS NULL THEN PERFORM 1 FROM public.sessions WHERE(token_hash,user_id,tenant_id)=(h,u,t) FOR SHARE;ELSE PERFORM 1 FROM public.api_keys WHERE(id,user_id,tenant_id)=(k,u,t) FOR SHARE;END IF;
 END IF;
 IF k IS NULL THEN
  SELECT m.role,coalesce(a.version,0)::text account_version,to_jsonb(p) policy,true scope_ok,least(s.expires_at,CASE WHEN coalesce(p.require_mfa,false) THEN s.mfa_verified_at+interval '8 hours' ELSE s.expires_at END) deadline,
   coalesce(p.require_mfa,false) AND NOT(coalesce(a.enabled_at IS NOT NULL AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>clock_timestamp()-interval '8 hours',false)) mfa_required INTO x
  FROM public.sessions s JOIN public.users z ON z.id=s.user_id JOIN public.tenants n ON n.id=s.tenant_id JOIN public.memberships m ON(m.user_id,m.tenant_id)=(z.id,n.id) LEFT JOIN public.account_security a ON a.user_id=z.id LEFT JOIN public.workspace_security_policies p ON p.tenant_id=n.id
  WHERE(s.token_hash,s.user_id,s.tenant_id)=(h,u,t) AND s.expires_at>clock_timestamp() AND s.account_version=coalesce(a.version,0);
 ELSE
  SELECT m.role,coalesce(a.version,0)::text account_version,to_jsonb(p) policy,k0.scopes,k0.expires_at deadline,
   k0.scopes@>CASE WHEN w THEN ARRAY['products:read','products:write']::text[] ELSE ARRAY['products:read']::text[] END scope_ok,coalesce(p.require_mfa,false) AND a.enabled_at IS NULL mfa_required INTO x
  FROM public.api_keys k0 JOIN public.users z ON z.id=k0.user_id JOIN public.tenants n ON n.id=k0.tenant_id JOIN public.memberships m ON(m.user_id,m.tenant_id)=(z.id,n.id) LEFT JOIN public.account_security a ON a.user_id=z.id LEFT JOIN public.workspace_security_policies p ON p.tenant_id=n.id
  WHERE(k0.id,k0.token_hash,k0.user_id,k0.tenant_id)=(k,h,u,t) AND k0.revoked_at IS NULL AND k0.expires_at>clock_timestamp();
 END IF;
 IF x.role IS NULL OR x.deadline IS NULL OR NOT isfinite(x.deadline) THEN RAISE EXCEPTION 'Expired local authority' USING ERRCODE='28000';END IF;
 IF x.role<>r THEN RAISE EXCEPTION 'Local role changed' USING ERRCODE='40001';END IF;
 IF NOT coalesce(x.scope_ok,false) OR coalesce(x.mfa_required,true) OR(w AND x.role<>'admin') THEN RAISE EXCEPTION 'Missing current local authority' USING ERRCODE='42501';END IF;
 RETURN to_jsonb(x);
END $$;

REVOKE ALL ON FUNCTION pim_dictionary_identity(uuid,uuid,uuid,text,text,boolean,boolean) FROM PUBLIC,dyna_app;

CREATE FUNCTION pim_dictionary_identity_json_valid(proof_json jsonb,key_mode boolean,created_clock timestamptz) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE expected_keys text[];
BEGIN
 IF jsonb_typeof(proof_json) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 expected_keys:=CASE WHEN key_mode THEN ARRAY['account_version','deadline','mfa_required','policy','role','scope_ok','scopes']::text[] ELSE ARRAY['account_version','deadline','mfa_required','policy','role','scope_ok']::text[] END;
 IF(SELECT array_agg(proof_key.key ORDER BY proof_key.key) FROM jsonb_object_keys(proof_json) proof_key(key)) IS DISTINCT FROM expected_keys OR proof_json->'role' IS DISTINCT FROM '"admin"'::jsonb OR proof_json->'scope_ok' IS DISTINCT FROM 'true'::jsonb OR proof_json->'mfa_required' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(proof_json->'deadline') IS DISTINCT FROM 'string' OR jsonb_typeof(proof_json->'account_version') IS DISTINCT FROM 'string' OR NOT coalesce(proof_json->>'account_version'~'^(0|[1-9][0-9]{0,18})$',false) OR jsonb_typeof(proof_json->'policy') NOT IN('null','object') THEN RETURN false;END IF;
 IF NOT coalesce(proof_json->>'deadline'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?\+00:00$',false) OR(proof_json->>'account_version')::numeric>9223372036854775807 OR NOT isfinite((proof_json->>'deadline')::timestamptz) OR(proof_json->>'deadline')::timestamptz<=created_clock THEN RETURN false;END IF;
 IF key_mode THEN
  IF jsonb_typeof(proof_json->'scopes') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(proof_json->'scopes') scope_entry(value) WHERE jsonb_typeof(scope_entry.value) IS DISTINCT FROM 'string') OR NOT(proof_json->'scopes'@>'["products:read","products:write"]'::jsonb) THEN RETURN false;END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_identity_json_valid(jsonb,boolean,timestamptz) FROM PUBLIC,dyna_app;

-- Source unit validation.sql SHA256 3c584b692202a9239ad6edda2a8d220e51c4c7a72ff5971b63267f111b45a6b1
-- Native actual-dictionary validation candidate. Private/no app execute grant.
CREATE FUNCTION pim_dictionary_utf16_length(value text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$ SELECT coalesce(sum(CASE WHEN octet_length(substring(value FROM pos FOR 1))=4 THEN 2 ELSE 1 END),0)::integer FROM generate_series(1,length(value)) positions(pos) $$;
CREATE FUNCTION pim_dictionary_blank(value text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$ SELECT translate(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF','')='' $$;
CREATE FUNCTION pim_dictionary_validate_values(t uuid,cid uuid,category uuid,typed_values jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE chain_ids uuid[];chain_ok boolean;entry_json jsonb;definition_row public.pim_dictionary_definitions%ROWTYPE;entry_kind text;codec_scale integer;numeric_value numeric;minimum_value numeric;maximum_value numeric;required_ids uuid[];seen_ids uuid[]:=ARRAY[]::uuid[];selected_definition uuid;expected_keys text[];
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PIM tenant mismatch' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(typed_values) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(typed_values)>50 THEN RETURN false;END IF;
 IF typed_values IS DISTINCT FROM coalesce((SELECT jsonb_agg(values_row.value ORDER BY values_row.value->>'definition_id') FROM jsonb_array_elements(typed_values) values_row(value)),'[]'::jsonb) THEN RETURN false;END IF;
 IF category IS NULL THEN RETURN typed_values='[]'::jsonb;END IF;
 WITH RECURSIVE ancestry AS(SELECT c.id,c.parent_id,c.active,ARRAY[c.id] visited,1 depth FROM public.pim_dictionary_categories c WHERE(c.tenant_id,c.catalog_id,c.id)=(t,cid,category)
 UNION ALL SELECT c.id,c.parent_id,c.active,a.visited||c.id,a.depth+1 FROM ancestry a JOIN public.pim_dictionary_categories c ON(c.tenant_id,c.catalog_id,c.id)=(t,cid,a.parent_id) WHERE a.depth<16 AND NOT c.id=ANY(a.visited))
 SELECT array_agg(a.id ORDER BY a.depth),bool_and(a.active) AND bool_or(a.parent_id IS NULL) INTO chain_ids,chain_ok FROM ancestry a;
 IF NOT coalesce(chain_ok,false) THEN RETURN false;END IF;
 IF(SELECT count(DISTINCT b.definition_id) FROM public.pim_dictionary_bindings b WHERE b.tenant_id=t AND b.catalog_id=cid AND b.category_id=ANY(chain_ids))>50 THEN RETURN false;END IF;
 SELECT coalesce(array_agg(DISTINCT b.definition_id),'{}'::uuid[]) INTO required_ids FROM public.pim_dictionary_bindings b WHERE b.tenant_id=t AND b.catalog_id=cid AND b.category_id=ANY(chain_ids) AND b.required;
 FOR entry_json IN SELECT values_row.value FROM jsonb_array_elements(typed_values) values_row(value) LOOP
  IF jsonb_typeof(entry_json) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF jsonb_typeof(entry_json->'definition_id') IS DISTINCT FROM 'string' OR NOT coalesce(entry_json->>'definition_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RETURN false;END IF;
  selected_definition:=(entry_json->>'definition_id')::uuid;IF selected_definition=ANY(seen_ids) THEN RETURN false;END IF;seen_ids:=seen_ids||selected_definition;
  SELECT * INTO definition_row FROM public.pim_dictionary_definitions d WHERE(d.tenant_id,d.catalog_id,d.id)=(t,cid,selected_definition) AND d.active;
  IF definition_row.id IS NULL OR NOT EXISTS(SELECT FROM public.pim_dictionary_bindings b WHERE b.tenant_id=t AND b.catalog_id=cid AND b.category_id=ANY(chain_ids) AND b.definition_id=selected_definition) THEN RETURN false;END IF;
  entry_kind:=definition_row.shape->>'kind';IF(entry_json->>'kind') IS DISTINCT FROM entry_kind THEN RETURN false;END IF;
  expected_keys:=CASE WHEN entry_kind='enum' THEN ARRAY['definition_id','kind','option_id'] ELSE ARRAY['definition_id','kind','value'] END;
  IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(entry_json) object_key(key)) IS DISTINCT FROM expected_keys THEN RETURN false;END IF;
  IF entry_kind='boolean' THEN IF jsonb_typeof(entry_json->'value') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  ELSIF entry_kind='text' THEN
   IF jsonb_typeof(entry_json->'value') IS DISTINCT FROM 'string' OR public.pim_dictionary_utf16_length(entry_json->>'value')>(definition_row.shape->>'max_length')::integer OR(entry_json->>'value')~'[\x01-\x1f\x7f]' OR(selected_definition=ANY(required_ids) AND public.pim_dictionary_blank(entry_json->>'value')) THEN RETURN false;END IF;
  ELSIF entry_kind='enum' THEN
   IF jsonb_typeof(entry_json->'option_id') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT FROM jsonb_array_elements(definition_row.shape->'options') option_row(value) WHERE option_row.value->>'id'=entry_json->>'option_id' AND option_row.value->'active'='true'::jsonb) THEN RETURN false;END IF;
  ELSIF entry_kind='decimal' THEN
   codec_scale:=(definition_row.shape->>'scale')::integer;IF codec_scale NOT BETWEEN 0 AND 6 OR jsonb_typeof(entry_json->'value') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
   IF NOT(entry_json->>'value' ~ ('^-?(0|[1-9][0-9]{0,17})'||CASE WHEN codec_scale=0 THEN '' ELSE '\.[0-9]{'||codec_scale::text||'}' END||'$')) THEN RETURN false;END IF;
   numeric_value:=(entry_json->>'value')::numeric;IF left(entry_json->>'value',1)='-' AND numeric_value=0 THEN RETURN false;END IF;
   minimum_value:=(definition_row.shape->>'minimum')::numeric;maximum_value:=(definition_row.shape->>'maximum')::numeric;
   IF(minimum_value IS NOT NULL AND numeric_value<minimum_value) OR(maximum_value IS NOT NULL AND numeric_value>maximum_value) THEN RETURN false;END IF;
  ELSE RETURN false;END IF;
 END LOOP;
 RETURN required_ids<@seen_ids;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_validate_values(uuid,uuid,uuid,jsonb) FROM PUBLIC,dyna_app;

REVOKE ALL ON FUNCTION pim_dictionary_utf16_length(text),pim_dictionary_blank(text) FROM PUBLIC,dyna_app;

-- Source unit dictionary-validation.sql SHA256 a82d524d94eb77d5294543248092dbd3d2433ca94e71de2a74c386d8387158a3
-- Native canonical dictionary validator; no mutable current-state authority.
CREATE FUNCTION pim_dictionary_clean_label(value text,minimum integer,maximum integer) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$ SELECT public.pim_dictionary_utf16_length(value) BETWEEN minimum AND maximum AND value !~ '[\x01-\x1f\x7f]' AND NOT public.pim_dictionary_blank(left(value,1)) AND NOT public.pim_dictionary_blank(right(value,1)) $$;
CREATE FUNCTION pim_dictionary_decimal_valid(value text,scale integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$ BEGIN
 IF scale NOT BETWEEN 0 AND 6 OR value !~ ('^-?(0|[1-9][0-9]{0,17})'||CASE WHEN scale=0 THEN '' ELSE '\.[0-9]{'||scale::text||'}' END||'$') THEN RETURN false;END IF;
 RETURN NOT(left(value,1)='-' AND value::numeric=0);
END $$;
CREATE FUNCTION pim_dictionary_validate_dictionary(dictionary_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE definition_node jsonb;category_node jsonb;shape_node jsonb;option_node jsonb;binding_node jsonb;ancestor_node jsonb;shape_kind text;scale_value integer;total_options integer:=0;depth_value integer;seen_categories text[];definition_ids text[];category_ids text[];enum_ids text[];
BEGIN
 IF jsonb_typeof(dictionary_json) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(dictionary_json) object_key(key)) IS DISTINCT FROM ARRAY['categories','definitions']::text[] OR jsonb_typeof(dictionary_json->'categories') IS DISTINCT FROM 'array' OR jsonb_typeof(dictionary_json->'definitions') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(dictionary_json->'categories')>500 OR jsonb_array_length(dictionary_json->'definitions')>500 OR octet_length(dictionary_json::text)>2097152 THEN RETURN false;END IF;
 SELECT coalesce(array_agg(nodes.value->>'id'),'{}'::text[]) INTO definition_ids FROM jsonb_array_elements(dictionary_json->'definitions') nodes(value);
 SELECT coalesce(array_agg(nodes.value->>'id'),'{}'::text[]) INTO category_ids FROM jsonb_array_elements(dictionary_json->'categories') nodes(value);
 IF(dictionary_json->'categories') IS DISTINCT FROM coalesce((SELECT jsonb_agg(nodes.value ORDER BY nodes.value->>'id') FROM jsonb_array_elements(dictionary_json->'categories') nodes(value)),'[]'::jsonb) OR(dictionary_json->'definitions') IS DISTINCT FROM coalesce((SELECT jsonb_agg(nodes.value ORDER BY nodes.value->>'id') FROM jsonb_array_elements(dictionary_json->'definitions') nodes(value)),'[]'::jsonb) THEN RETURN false;END IF;
 IF cardinality(definition_ids)<>(SELECT count(DISTINCT assigned.id) FROM unnest(definition_ids) assigned(id)) OR cardinality(category_ids)<>(SELECT count(DISTINCT assigned.id) FROM unnest(category_ids) assigned(id)) THEN RETURN false;END IF;
 FOR definition_node IN SELECT nodes.value FROM jsonb_array_elements(dictionary_json->'definitions') nodes(value) LOOP
  IF jsonb_typeof(definition_node) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(definition_node) object_key(key)) IS DISTINCT FROM ARRAY['active','id','name','shape','version']::text[] OR jsonb_typeof(definition_node->'active') IS DISTINCT FROM 'boolean' OR jsonb_typeof(definition_node->'id') IS DISTINCT FROM 'string' OR NOT coalesce(definition_node->>'id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR jsonb_typeof(definition_node->'version') IS DISTINCT FROM 'string' OR NOT coalesce(definition_node->>'version'~'^[1-9][0-9]{0,18}$',false) OR jsonb_typeof(definition_node->'name') IS DISTINCT FROM 'string' OR NOT coalesce(public.pim_dictionary_clean_label(definition_node->>'name',2,120),false) THEN RETURN false;END IF;
  BEGIN IF(definition_node->>'version')::bigint<1 THEN RETURN false;END IF;EXCEPTION WHEN numeric_value_out_of_range THEN RETURN false;END;
  shape_node:=definition_node->'shape';IF jsonb_typeof(shape_node) IS DISTINCT FROM 'object' THEN RETURN false;END IF;shape_kind:=shape_node->>'kind';
  IF shape_kind='text' THEN
   IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(shape_node) object_key(key)) IS DISTINCT FROM ARRAY['kind','max_length']::text[] OR jsonb_typeof(shape_node->'max_length') IS DISTINCT FROM 'number' OR NOT coalesce(shape_node->>'max_length'~'^[1-9][0-9]{0,2}$',false) THEN RETURN false;END IF;
   IF(shape_node->>'max_length')::integer>500 THEN RETURN false;END IF;
  ELSIF shape_kind='boolean' THEN IF shape_node<>jsonb_build_object('kind','boolean') THEN RETURN false;END IF;
  ELSIF shape_kind='decimal' THEN
   IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(shape_node) object_key(key)) IS DISTINCT FROM ARRAY['kind','maximum','minimum','scale','unit']::text[] OR jsonb_typeof(shape_node->'scale') IS DISTINCT FROM 'number' OR NOT coalesce(shape_node->>'scale'~'^[0-6]$',false) THEN RETURN false;END IF;scale_value:=(shape_node->>'scale')::integer;
   IF shape_node->'unit'<>'null'::jsonb AND(jsonb_typeof(shape_node->'unit') IS DISTINCT FROM 'string' OR NOT coalesce(public.pim_dictionary_clean_label(shape_node->>'unit',1,32),false)) THEN RETURN false;END IF;
   IF shape_node->'minimum'<>'null'::jsonb AND(jsonb_typeof(shape_node->'minimum') IS DISTINCT FROM 'string' OR NOT coalesce(public.pim_dictionary_decimal_valid(shape_node->>'minimum',scale_value),false)) THEN RETURN false;END IF;
   IF shape_node->'maximum'<>'null'::jsonb AND(jsonb_typeof(shape_node->'maximum') IS DISTINCT FROM 'string' OR NOT coalesce(public.pim_dictionary_decimal_valid(shape_node->>'maximum',scale_value),false)) THEN RETURN false;END IF;
   IF shape_node->'minimum'<>'null'::jsonb AND shape_node->'maximum'<>'null'::jsonb AND(shape_node->>'minimum')::numeric>(shape_node->>'maximum')::numeric THEN RETURN false;END IF;
  ELSIF shape_kind='enum' THEN
   IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(shape_node) object_key(key)) IS DISTINCT FROM ARRAY['kind','options']::text[] OR jsonb_typeof(shape_node->'options') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
   IF(shape_node->'options') IS DISTINCT FROM(SELECT jsonb_agg(options_row.value ORDER BY options_row.value->>'id') FROM jsonb_array_elements(shape_node->'options') options_row(value)) THEN RETURN false;END IF;
   IF jsonb_array_length(shape_node->'options') NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;total_options:=total_options+jsonb_array_length(shape_node->'options');enum_ids:=ARRAY[]::text[];
   FOR option_node IN SELECT options_row.value FROM jsonb_array_elements(shape_node->'options') options_row(value) LOOP
    IF jsonb_typeof(option_node) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
    IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(option_node) object_key(key)) IS DISTINCT FROM ARRAY['active','id','label']::text[] OR jsonb_typeof(option_node->'active') IS DISTINCT FROM 'boolean' OR jsonb_typeof(option_node->'id') IS DISTINCT FROM 'string' OR NOT coalesce(option_node->>'id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR jsonb_typeof(option_node->'label') IS DISTINCT FROM 'string' OR NOT coalesce(public.pim_dictionary_clean_label(option_node->>'label',2,120),false) OR option_node->>'id'=ANY(enum_ids) THEN RETURN false;END IF;enum_ids:=enum_ids||(option_node->>'id');
   END LOOP;
  ELSE RETURN false;END IF;
 END LOOP;
 IF total_options>5000 THEN RETURN false;END IF;
 FOR category_node IN SELECT nodes.value FROM jsonb_array_elements(dictionary_json->'categories') nodes(value) LOOP
  IF jsonb_typeof(category_node) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(category_node) object_key(key)) IS DISTINCT FROM ARRAY['active','bindings','id','name','parent_id','version']::text[] OR jsonb_typeof(category_node->'active') IS DISTINCT FROM 'boolean' OR jsonb_typeof(category_node->'id') IS DISTINCT FROM 'string' OR NOT coalesce(category_node->>'id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR jsonb_typeof(category_node->'version') IS DISTINCT FROM 'string' OR NOT coalesce(category_node->>'version'~'^[1-9][0-9]{0,18}$',false) OR jsonb_typeof(category_node->'name') IS DISTINCT FROM 'string' OR NOT coalesce(public.pim_dictionary_clean_label(category_node->>'name',2,120),false) OR jsonb_typeof(category_node->'bindings') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  BEGIN IF(category_node->>'version')::bigint<1 THEN RETURN false;END IF;EXCEPTION WHEN numeric_value_out_of_range THEN RETURN false;END;
  IF(category_node->'bindings') IS DISTINCT FROM coalesce((SELECT jsonb_agg(bindings_row.value ORDER BY bindings_row.value->>'definition_id') FROM jsonb_array_elements(category_node->'bindings') bindings_row(value)),'[]'::jsonb) THEN RETURN false;END IF;
  IF jsonb_array_length(category_node->'bindings')>50 OR(category_node->'parent_id'<>'null'::jsonb AND(jsonb_typeof(category_node->'parent_id') IS DISTINCT FROM 'string' OR NOT(category_node->>'parent_id'=ANY(category_ids)))) THEN RETURN false;END IF;
  IF(SELECT count(DISTINCT bindings_row.value->>'definition_id') FROM jsonb_array_elements(category_node->'bindings') bindings_row(value))<>jsonb_array_length(category_node->'bindings') THEN RETURN false;END IF;
  FOR binding_node IN SELECT bindings_row.value FROM jsonb_array_elements(category_node->'bindings') bindings_row(value) LOOP
   IF jsonb_typeof(binding_node) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
   IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(binding_node) object_key(key)) IS DISTINCT FROM ARRAY['definition_id','required']::text[] OR jsonb_typeof(binding_node->'required') IS DISTINCT FROM 'boolean' OR jsonb_typeof(binding_node->'definition_id') IS DISTINCT FROM 'string' OR NOT(binding_node->>'definition_id'=ANY(definition_ids)) THEN RETURN false;END IF;
   IF category_node->'active'='true'::jsonb AND NOT EXISTS(SELECT FROM jsonb_array_elements(dictionary_json->'definitions') definition_row(value) WHERE definition_row.value->>'id'=binding_node->>'definition_id' AND definition_row.value->'active'='true'::jsonb) THEN RETURN false;END IF;
  END LOOP;
  ancestor_node:=category_node;seen_categories:=ARRAY[]::text[];depth_value:=0;
  LOOP
   IF ancestor_node IS NULL OR ancestor_node->>'id'=ANY(seen_categories) THEN RETURN false;END IF;depth_value:=depth_value+1;IF depth_value>16 THEN RETURN false;END IF;seen_categories:=seen_categories||(ancestor_node->>'id');
   IF category_node->'active'='true'::jsonb AND ancestor_node->'active'<>'true'::jsonb THEN RETURN false;END IF;
   EXIT WHEN ancestor_node->'parent_id'='null'::jsonb;
   SELECT nodes.value INTO ancestor_node FROM jsonb_array_elements(dictionary_json->'categories') nodes(value) WHERE nodes.value->>'id'=ancestor_node->>'parent_id';
  END LOOP;
  IF category_node->'active'='true'::jsonb AND(SELECT count(DISTINCT binding_row.value->>'definition_id') FROM jsonb_array_elements(dictionary_json->'categories') category_row(value) CROSS JOIN LATERAL jsonb_array_elements(category_row.value->'bindings') binding_row(value) WHERE category_row.value->>'id'=ANY(seen_categories))>50 THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_clean_label(text,integer,integer),pim_dictionary_decimal_valid(text,integer),pim_dictionary_validate_dictionary(jsonb) FROM PUBLIC,dyna_app;

-- Source unit transition.sql SHA256 83e4f52854c2a857dd90798ac202b8f1eabf1c13ce68bbc9bc90a0f57e4d2166
CREATE FUNCTION pim_dictionary_validate_transition(before_json jsonb,after_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE collection_name text;new_node jsonb;old_node jsonb;changed_node boolean;
BEGIN
 IF NOT public.pim_dictionary_validate_dictionary(before_json) OR NOT public.pim_dictionary_validate_dictionary(after_json) THEN RETURN false;END IF;
 FOREACH collection_name IN ARRAY ARRAY['categories','definitions'] LOOP
  IF EXISTS(SELECT FROM jsonb_array_elements(before_json->collection_name) previous(value) WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(after_json->collection_name) projected(value) WHERE projected.value->>'id'=previous.value->>'id')) THEN RETURN false;END IF;
  FOR new_node IN SELECT projected.value FROM jsonb_array_elements(after_json->collection_name) projected(value) LOOP
   SELECT previous.value INTO old_node FROM jsonb_array_elements(before_json->collection_name) previous(value) WHERE previous.value->>'id'=new_node->>'id';
   IF old_node IS NULL THEN IF new_node->>'version'<>'1' THEN RETURN false;END IF;
   ELSE
    changed_node:=(old_node-'version') IS DISTINCT FROM(new_node-'version');
    BEGIN IF(new_node->>'version')::bigint IS DISTINCT FROM(old_node->>'version')::bigint+(CASE WHEN changed_node THEN 1 ELSE 0 END) THEN RETURN false;END IF;EXCEPTION WHEN numeric_value_out_of_range THEN RETURN false;END;
    IF collection_name='definitions' AND(old_node->'shape'->>'kind' IS DISTINCT FROM new_node->'shape'->>'kind' OR(old_node->'shape'->>'kind'='decimal' AND(old_node->'shape'->'scale' IS DISTINCT FROM new_node->'shape'->'scale' OR old_node->'shape'->'unit' IS DISTINCT FROM new_node->'shape'->'unit'))) THEN RETURN false;END IF;
   END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_validate_transition(jsonb,jsonb) FROM PUBLIC,dyna_app;

-- Source unit projection.sql SHA256 e4c84daaf4062e88cd5939f0746d5acb8667130c3c756160af3db9585bbf7a2f
-- Exact native request executor. Caller-projected JSON never chooses dictionary data.
CREATE FUNCTION pim_dictionary_project_dictionary(before_json jsonb,changes_json jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE categories_map jsonb;definitions_map jsonb;change_json jsonb;node_id text;change_kind text;expected_keys text[];node_before jsonb;node_after jsonb;seen_ids text[]:=ARRAY[]::text[];result_json jsonb;new_categories jsonb:='[]'::jsonb;new_definitions jsonb:='[]'::jsonb;definition_shape jsonb;
BEGIN
 IF NOT public.pim_dictionary_validate_dictionary(before_json) OR jsonb_typeof(changes_json) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PIM dictionary request shape' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(changes_json) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'PIM dictionary request budget' USING ERRCODE='54000';END IF;
 SELECT coalesce(jsonb_object_agg(node.value->>'id',node.value),'{}'::jsonb) INTO categories_map FROM jsonb_array_elements(before_json->'categories') node(value);
 SELECT coalesce(jsonb_object_agg(node.value->>'id',node.value),'{}'::jsonb) INTO definitions_map FROM jsonb_array_elements(before_json->'definitions') node(value);
 FOR change_json IN SELECT request_row.value FROM jsonb_array_elements(changes_json) request_row(value) LOOP
  IF jsonb_typeof(change_json) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PIM dictionary change shape' USING ERRCODE='23514';END IF;
  change_kind:=change_json->>'kind';node_id:=change_json->>'id';IF jsonb_typeof(change_json->'id') IS DISTINCT FROM 'string' OR NOT coalesce(node_id~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR node_id=ANY(seen_ids) THEN RAISE EXCEPTION 'PIM dictionary change identity' USING ERRCODE='23514';END IF;seen_ids:=seen_ids||node_id;
  expected_keys:=CASE change_kind WHEN 'category_create' THEN ARRAY['id','kind','name','parent_id'] WHEN 'category_update' THEN ARRAY['active','id','kind','name','parent_id','version'] WHEN 'category_bindings' THEN ARRAY['bindings','id','kind','version'] WHEN 'definition_create' THEN ARRAY['id','kind','name','shape'] WHEN 'definition_update' THEN ARRAY['active','id','kind','name','shape','version'] ELSE NULL END;
  IF expected_keys IS NULL OR(SELECT array_agg(request_key.key ORDER BY request_key.key) FROM jsonb_object_keys(change_json) request_key(key)) IS DISTINCT FROM expected_keys THEN RAISE EXCEPTION 'PIM dictionary exact change keys' USING ERRCODE='23514';END IF;
  IF change_kind='category_create' THEN
   IF categories_map?node_id THEN RAISE EXCEPTION 'PIM category already exists' USING ERRCODE='40001';END IF;
   node_after:=jsonb_build_object('id',node_id,'version','1','parent_id',change_json->'parent_id','name',change_json->'name','active',true,'bindings','[]'::jsonb);categories_map:=categories_map||jsonb_build_object(node_id,node_after);
  ELSIF change_kind='definition_create' THEN
   IF definitions_map?node_id THEN RAISE EXCEPTION 'PIM definition already exists' USING ERRCODE='40001';END IF;
   node_after:=jsonb_build_object('id',node_id,'version','1','name',change_json->'name','active',true,'shape',change_json->'shape');definitions_map:=definitions_map||jsonb_build_object(node_id,node_after);
  ELSIF change_kind IN('category_update','category_bindings') THEN
   node_before:=categories_map->node_id;IF node_before IS NULL OR change_json->'version' IS DISTINCT FROM node_before->'version' THEN RAISE EXCEPTION 'PIM category source version changed' USING ERRCODE='40001';END IF;
   node_after:=CASE WHEN change_kind='category_update' THEN node_before||jsonb_build_object('parent_id',change_json->'parent_id','name',change_json->'name','active',change_json->'active') ELSE node_before||jsonb_build_object('bindings',change_json->'bindings') END;categories_map:=categories_map||jsonb_build_object(node_id,node_after);
  ELSIF change_kind='definition_update' THEN
   node_before:=definitions_map->node_id;IF node_before IS NULL OR change_json->'version' IS DISTINCT FROM node_before->'version' THEN RAISE EXCEPTION 'PIM definition source version changed' USING ERRCODE='40001';END IF;
   node_after:=node_before||jsonb_build_object('name',change_json->'name','active',change_json->'active','shape',change_json->'shape');definitions_map:=definitions_map||jsonb_build_object(node_id,node_after);
  END IF;
 END LOOP;
 FOR node_after IN SELECT category_entry.value FROM jsonb_each(categories_map) category_entry(key,value) ORDER BY category_entry.key LOOP
  IF jsonb_typeof(node_after->'bindings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PIM binding shape' USING ERRCODE='23514';END IF;
  node_after:=node_after||jsonb_build_object('bindings',coalesce((SELECT jsonb_agg(binding_entry.value ORDER BY binding_entry.value->>'definition_id') FROM jsonb_array_elements(node_after->'bindings') binding_entry(value)),'[]'::jsonb));
  SELECT previous.value INTO node_before FROM jsonb_array_elements(before_json->'categories') previous(value) WHERE previous.value->>'id'=node_after->>'id';
  IF node_before IS NOT NULL AND(node_before-'version') IS DISTINCT FROM(node_after-'version') THEN node_after:=node_after||jsonb_build_object('version',((node_before->>'version')::bigint+1)::text);END IF;
  new_categories:=new_categories||jsonb_build_array(node_after);
 END LOOP;
 FOR node_after IN SELECT definition_entry.value FROM jsonb_each(definitions_map) definition_entry(key,value) ORDER BY definition_entry.key LOOP
  definition_shape:=node_after->'shape';IF definition_shape->>'kind'='enum' THEN
   IF jsonb_typeof(definition_shape->'options') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PIM enum option shape' USING ERRCODE='23514';END IF;
   definition_shape:=definition_shape||jsonb_build_object('options',coalesce((SELECT jsonb_agg(option_entry.value ORDER BY option_entry.value->>'id') FROM jsonb_array_elements(definition_shape->'options') option_entry(value)),'[]'::jsonb));node_after:=node_after||jsonb_build_object('shape',definition_shape);
  END IF;
  SELECT previous.value INTO node_before FROM jsonb_array_elements(before_json->'definitions') previous(value) WHERE previous.value->>'id'=node_after->>'id';
  IF node_before IS NOT NULL AND(node_before-'version') IS DISTINCT FROM(node_after-'version') THEN node_after:=node_after||jsonb_build_object('version',((node_before->>'version')::bigint+1)::text);END IF;
  new_definitions:=new_definitions||jsonb_build_array(node_after);
 END LOOP;
 result_json:=jsonb_build_object('categories',new_categories,'definitions',new_definitions);
 IF NOT public.pim_dictionary_validate_transition(before_json,result_json) THEN RAISE EXCEPTION 'PIM invalid canonical dictionary change' USING ERRCODE='23514';END IF;
 RETURN result_json;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_project_dictionary(jsonb,jsonb) FROM PUBLIC,dyna_app;

-- Source unit value-projection.sql SHA256 f70ecccde00d69cdaf1e2fbbc60df7f8f4671ebda56fc8daf946f68ef25fbe7b
-- Native value evaluator against an immutable actual dictionary snapshot.
CREATE FUNCTION pim_dictionary_validate_values_json(dictionary_json jsonb,category uuid,typed_values jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE chain_ids uuid[];chain_ok boolean;entry_json jsonb;definition_json jsonb;entry_kind text;codec_scale integer;numeric_value numeric;minimum_value numeric;maximum_value numeric;required_ids uuid[];seen_ids uuid[]:=ARRAY[]::uuid[];selected_definition uuid;expected_keys text[];
BEGIN
 IF NOT public.pim_dictionary_validate_dictionary(dictionary_json) THEN RETURN false;END IF;
 IF jsonb_typeof(typed_values) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(typed_values)>50 THEN RETURN false;END IF;
 IF typed_values IS DISTINCT FROM coalesce((SELECT jsonb_agg(values_row.value ORDER BY values_row.value->>'definition_id') FROM jsonb_array_elements(typed_values) values_row(value)),'[]'::jsonb) THEN RETURN false;END IF;
 IF category IS NULL THEN RETURN typed_values='[]'::jsonb;END IF;
 WITH RECURSIVE nodes AS(SELECT(node.value->>'id')::uuid id,(node.value->>'parent_id')::uuid parent_id,(node.value->>'active')::boolean active,node.value->'bindings' bindings FROM jsonb_array_elements(dictionary_json->'categories') node(value)), ancestry AS(SELECT c.id,c.parent_id,c.active,ARRAY[c.id] visited,1 depth FROM nodes c WHERE c.id=category
 UNION ALL SELECT c.id,c.parent_id,c.active,a.visited||c.id,a.depth+1 FROM ancestry a JOIN nodes c ON c.id=a.parent_id WHERE a.depth<16 AND NOT c.id=ANY(a.visited))
 SELECT array_agg(a.id ORDER BY a.depth),bool_and(a.active) AND bool_or(a.parent_id IS NULL) INTO chain_ids,chain_ok FROM ancestry a;
 IF NOT coalesce(chain_ok,false) THEN RETURN false;END IF;
 IF(SELECT count(DISTINCT binding_node.value->>'definition_id') FROM jsonb_array_elements(dictionary_json->'categories') category_node(value) CROSS JOIN LATERAL jsonb_array_elements(category_node.value->'bindings') binding_node(value) WHERE(category_node.value->>'id')::uuid=ANY(chain_ids))>50 THEN RETURN false;END IF;
 SELECT coalesce(array_agg(DISTINCT(binding_node.value->>'definition_id')::uuid),'{}'::uuid[]) INTO required_ids FROM jsonb_array_elements(dictionary_json->'categories') category_node(value) CROSS JOIN LATERAL jsonb_array_elements(category_node.value->'bindings') binding_node(value) WHERE(category_node.value->>'id')::uuid=ANY(chain_ids) AND binding_node.value->'required'='true'::jsonb;
 FOR entry_json IN SELECT values_row.value FROM jsonb_array_elements(typed_values) values_row(value) LOOP
  IF jsonb_typeof(entry_json) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF jsonb_typeof(entry_json->'definition_id') IS DISTINCT FROM 'string' OR NOT coalesce(entry_json->>'definition_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RETURN false;END IF;
  selected_definition:=(entry_json->>'definition_id')::uuid;IF selected_definition=ANY(seen_ids) THEN RETURN false;END IF;seen_ids:=seen_ids||selected_definition;
  SELECT definition_node.value INTO definition_json FROM jsonb_array_elements(dictionary_json->'definitions') definition_node(value) WHERE definition_node.value->>'id'=selected_definition::text AND definition_node.value->'active'='true'::jsonb;
  IF definition_json IS NULL OR NOT EXISTS(SELECT FROM jsonb_array_elements(dictionary_json->'categories') category_node(value) CROSS JOIN LATERAL jsonb_array_elements(category_node.value->'bindings') binding_node(value) WHERE(category_node.value->>'id')::uuid=ANY(chain_ids) AND binding_node.value->>'definition_id'=selected_definition::text) THEN RETURN false;END IF;
  entry_kind:=definition_json->'shape'->>'kind';IF(entry_json->>'kind') IS DISTINCT FROM entry_kind THEN RETURN false;END IF;
  expected_keys:=CASE WHEN entry_kind='enum' THEN ARRAY['definition_id','kind','option_id'] ELSE ARRAY['definition_id','kind','value'] END;
  IF(SELECT array_agg(object_key.key ORDER BY object_key.key) FROM jsonb_object_keys(entry_json) object_key(key)) IS DISTINCT FROM expected_keys THEN RETURN false;END IF;
  IF entry_kind='boolean' THEN IF jsonb_typeof(entry_json->'value') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  ELSIF entry_kind='text' THEN
   IF jsonb_typeof(entry_json->'value') IS DISTINCT FROM 'string' OR public.pim_dictionary_utf16_length(entry_json->>'value')>(definition_json->'shape'->>'max_length')::integer OR(entry_json->>'value')~'[\x01-\x1f\x7f]' OR(selected_definition=ANY(required_ids) AND public.pim_dictionary_blank(entry_json->>'value')) THEN RETURN false;END IF;
  ELSIF entry_kind='enum' THEN
   IF jsonb_typeof(entry_json->'option_id') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT FROM jsonb_array_elements(definition_json->'shape'->'options') option_row(value) WHERE option_row.value->>'id'=entry_json->>'option_id' AND option_row.value->'active'='true'::jsonb) THEN RETURN false;END IF;
  ELSIF entry_kind='decimal' THEN
   codec_scale:=(definition_json->'shape'->>'scale')::integer;IF codec_scale NOT BETWEEN 0 AND 6 OR jsonb_typeof(entry_json->'value') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
   IF NOT(entry_json->>'value' ~ ('^-?(0|[1-9][0-9]{0,17})'||CASE WHEN codec_scale=0 THEN '' ELSE '\.[0-9]{'||codec_scale::text||'}' END||'$')) THEN RETURN false;END IF;
   numeric_value:=(entry_json->>'value')::numeric;IF left(entry_json->>'value',1)='-' AND numeric_value=0 THEN RETURN false;END IF;
   minimum_value:=(definition_json->'shape'->>'minimum')::numeric;maximum_value:=(definition_json->'shape'->>'maximum')::numeric;
   IF(minimum_value IS NOT NULL AND numeric_value<minimum_value) OR(maximum_value IS NOT NULL AND numeric_value>maximum_value) THEN RETURN false;END IF;
  ELSE RETURN false;END IF;
 END LOOP;
 RETURN required_ids<@seen_ids;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_validate_values_json(jsonb,uuid,jsonb) FROM PUBLIC,dyna_app;
CREATE FUNCTION pim_dictionary_canonical_row(row_json jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF jsonb_typeof(row_json) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PIM row shape' USING ERRCODE='23514';END IF;
 IF(SELECT array_agg(row_key.key ORDER BY row_key.key) FROM jsonb_object_keys(row_json) row_key(key)) IS DISTINCT FROM ARRAY['category_id','product_id','product_version','source_hash','state_version','values']::text[] OR jsonb_typeof(row_json->'values') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PIM exact product row shape' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(row_json->'product_id') IS DISTINCT FROM 'string' OR NOT coalesce(row_json->>'product_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR jsonb_typeof(row_json->'source_hash') IS DISTINCT FROM 'string' OR NOT coalesce(row_json->>'source_hash'~'^[a-f0-9]{64}$',false) THEN RAISE EXCEPTION 'PIM canonical row identity' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(row_json->'product_version') IS DISTINCT FROM 'string' OR NOT coalesce(row_json->>'product_version'~'^[1-9][0-9]{0,18}$',false) OR jsonb_typeof(row_json->'state_version') IS DISTINCT FROM 'string' OR NOT coalesce(row_json->>'state_version'~'^(0|[1-9][0-9]{0,18})$',false) THEN RAISE EXCEPTION 'PIM canonical row versions' USING ERRCODE='23514';END IF;
 IF(row_json->>'product_version')::numeric>9223372036854775807 OR(row_json->>'state_version')::numeric>9223372036854775807 OR(jsonb_typeof(row_json->'category_id') IS DISTINCT FROM 'null' AND(jsonb_typeof(row_json->'category_id') IS DISTINCT FROM 'string' OR NOT coalesce(row_json->>'category_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false))) THEN RAISE EXCEPTION 'PIM canonical row scope' USING ERRCODE='23514';END IF;
 RETURN row_json||jsonb_build_object('values',coalesce((SELECT jsonb_agg(value_row.value ORDER BY value_row.value->>'definition_id') FROM jsonb_array_elements(row_json->'values') value_row(value)),'[]'::jsonb));
END $$;
CREATE FUNCTION pim_dictionary_row_errors(dictionary_json jsonb,rows_json jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row_json jsonb;row_index integer:=0;errors_json jsonb:='[]'::jsonb;
BEGIN
 IF NOT public.pim_dictionary_validate_dictionary(dictionary_json) OR jsonb_typeof(rows_json) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PIM full row error source shape' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(rows_json) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'PIM full row error scope budget' USING ERRCODE='54000';END IF;
 FOR row_json IN SELECT request_row.value FROM jsonb_array_elements(rows_json) request_row(value) LOOP
  row_json:=public.pim_dictionary_canonical_row(row_json);
  IF NOT public.pim_dictionary_validate_values_json(dictionary_json,(row_json->>'category_id')::uuid,row_json->'values') THEN errors_json:=errors_json||jsonb_build_array(jsonb_build_object('row',row_index,'field','values','code','invalid_typed_values','definition_id',NULL));END IF;
  row_index:=row_index+1;
 END LOOP;
 RETURN errors_json;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_canonical_row(jsonb),pim_dictionary_row_errors(jsonb,jsonb) FROM PUBLIC,dyna_app;
CREATE FUNCTION pim_dictionary_dictionary_errors(t uuid,cid uuid,after_json jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE assigned_ids jsonb;rows_json jsonb:='[]'::jsonb;product_id_json jsonb;source_json jsonb;
BEGIN
 IF t IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'PIM tenant mismatch' USING ERRCODE='42501';END IF;
 assigned_ids:=public.pim_dictionary_assigned_products(t,cid);IF jsonb_array_length(assigned_ids)>500 THEN RAISE EXCEPTION 'PIM whole impacted scope budget' USING ERRCODE='54000';END IF;
 FOR product_id_json IN SELECT assigned.value FROM jsonb_array_elements(assigned_ids) assigned(value) LOOP
  source_json:=public.pim_dictionary_product_frame(t,cid,(product_id_json#>>'{}')::uuid,false);
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('product_id',source_json->'product_id','product_version',source_json->'product_version','state_version',source_json->'state_version','source_hash',source_json->'source_hash','category_id',source_json->'category_id','values',source_json->'values'));
 END LOOP;
 IF rows_json='[]'::jsonb THEN RETURN '[]'::jsonb;END IF;
 RETURN public.pim_dictionary_row_errors(after_json,rows_json);
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_dictionary_errors(uuid,uuid,jsonb) FROM PUBLIC,dyna_app;

-- Source unit source.sql SHA256 3aa52721e5a040b2335dc20fbf6c3245ccfd730fad3feca1de4f0468423ad341
-- Complete native immutable source: namespace plus every impacted product.
-- Sorted namespace→product locks; no truncation or active-only filtering.
CREATE FUNCTION pim_dictionary_source(t uuid,cid uuid,request_json jsonb,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE frame_json jsonb;source_ids jsonb;selected_id text;source_rows jsonb:='[]'::jsonb;validated_row jsonb;
BEGIN
 frame_json:=public.pim_dictionary_frame(t,cid,pin);
 IF jsonb_typeof(request_json) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PIM source request' USING ERRCODE='23514';END IF;
 IF request_json->>'kind'='dictionary' THEN
  source_ids:=public.pim_dictionary_assigned_products(t,cid);
 ELSIF request_json->>'kind'='product_values' THEN
  IF jsonb_typeof(request_json->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PIM complete rows' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(request_json->'rows') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'PIM source scope budget' USING ERRCODE='54000';END IF;
  FOR validated_row IN SELECT submitted.value FROM jsonb_array_elements(request_json->'rows') submitted(value) LOOP PERFORM public.pim_dictionary_canonical_row(validated_row);END LOOP;
  SELECT jsonb_agg(submitted.value->'product_id' ORDER BY submitted.value->>'product_id') INTO source_ids FROM jsonb_array_elements(request_json->'rows') submitted(value);
  IF(SELECT count(DISTINCT submitted.value#>>'{}') FROM jsonb_array_elements(source_ids) submitted(value))<>jsonb_array_length(source_ids) THEN RAISE EXCEPTION 'PIM source duplicate product' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'PIM source discriminator' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(source_ids)>500 THEN RAISE EXCEPTION 'PIM entire source exceeds budget' USING ERRCODE='54000';END IF;
 FOR selected_id IN SELECT selected.value FROM jsonb_array_elements_text(source_ids) selected(value) ORDER BY selected.value LOOP
  source_rows:=source_rows||jsonb_build_array(public.pim_dictionary_product_frame(t,cid,selected_id::uuid,pin));
 END LOOP;
 frame_json:=frame_json||jsonb_build_object('sources',source_rows);IF octet_length(frame_json::text)>2097152 THEN RAISE EXCEPTION 'PIM full source bytes' USING ERRCODE='54000';END IF;
 RETURN frame_json;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_source(uuid,uuid,jsonb,boolean) FROM PUBLIC,dyna_app;
CREATE FUNCTION pim_dictionary_source_json_valid(frame_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  FOR legacy_value IN SELECT attribute_entry.value FROM jsonb_each(source_row->'legacy'->'attributes') attribute_entry(key,value) LOOP IF jsonb_typeof(legacy_value) IS DISTINCT FROM 'string' THEN RETURN false;END IF;END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_source_json_valid(jsonb) FROM PUBLIC,dyna_app;

-- Source unit lifecycle.sql SHA256 5a4b967d5dfb6b0b5351a9811821ea5e4e57efe1ff0206ff715f86e6b909df24
-- Private native managed context, owned by the SECURITY DEFINER owner. No GUC
-- supplies authority. Root transaction identity is PostgreSQL native and temp
-- custody is disjoint from caller SQL. HTTP provenance remains trusted adapter.
CREATE FUNCTION pim_dictionary_begin() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE owner_id oid:=(SELECT proowner FROM pg_proc WHERE oid='public.pim_dictionary_begin()'::regprocedure);
BEGIN
 IF to_regclass('pg_temp.pim_dictionary_tx_context') IS NULL THEN
  PERFORM public.pim_dictionary_require();
  CREATE TEMP TABLE pim_dictionary_tx_context(singleton boolean PRIMARY KEY CHECK(singleton),root_xid text NOT NULL,start_at timestamptz NOT NULL,backend_pid integer NOT NULL,duties jsonb NOT NULL,prepared boolean NOT NULL,finalized boolean NOT NULL) ON COMMIT DROP;
  REVOKE ALL ON pg_temp.pim_dictionary_tx_context FROM PUBLIC,dyna_app;
  CREATE CONSTRAINT TRIGGER pim_dictionary_tx_complete AFTER INSERT OR UPDATE ON pg_temp.pim_dictionary_tx_context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pim_dictionary_commit_guard();
  SET CONSTRAINTS pim_dictionary_tx_complete DEFERRED;
  INSERT INTO pg_temp.pim_dictionary_tx_context VALUES(true,pg_current_xact_id()::text,transaction_timestamp(),pg_backend_pid(),'[]'::jsonb,false,false);
 END IF;
 IF NOT EXISTS(SELECT FROM pg_class cl WHERE cl.oid=to_regclass('pg_temp.pim_dictionary_tx_context') AND cl.relpersistence='t' AND cl.relowner=owner_id AND NOT EXISTS(SELECT FROM aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) acl WHERE acl.grantee<>owner_id)) OR(SELECT count(*) FROM pg_attribute attr WHERE attr.attrelid=to_regclass('pg_temp.pim_dictionary_tx_context') AND attr.attnum>0 AND NOT attr.attisdropped)<>7 THEN RAISE EXCEPTION 'PIM temporary custody metadata' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx WHERE ctx.singleton AND ctx.root_xid=pg_current_xact_id()::text AND ctx.start_at=transaction_timestamp() AND ctx.backend_pid=pg_backend_pid()) OR(SELECT count(*) FROM pg_temp.pim_dictionary_tx_context)<>1 THEN RAISE EXCEPTION 'PIM managed root transaction missing' USING ERRCODE='55000';END IF;
END $$;
CREATE FUNCTION pim_dictionary_enlist(t uuid,cid uuid,u uuid,k uuid,h text,r text,w boolean,source_request jsonb,expected_source jsonb,expiry timestamptz) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE proof_json jsonb;new_duty jsonb;
BEGIN
 PERFORM public.pim_dictionary_begin();proof_json:=public.pim_dictionary_identity(t,u,k,h,r,w,false);
 IF expiry IS NOT NULL AND expiry<=clock_timestamp() THEN RAISE EXCEPTION 'PIM preview expired during admission' USING ERRCODE='40001';END IF;
 IF(source_request IS NULL) IS DISTINCT FROM(expected_source IS NULL) THEN RAISE EXCEPTION 'PIM source duty shape' USING ERRCODE='23514';END IF;
 new_duty:=jsonb_build_object('tenant_id',t,'catalog_id',cid,'user_id',u,'api_key_id',k,'credential_hash',h,'role',r,'writing',w,'request',source_request,'expected_source',expected_source,'expiry',expiry,'proof',proof_json);
 IF NOT EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx CROSS JOIN LATERAL jsonb_array_elements(ctx.duties) duty(value) WHERE duty.value=new_duty) THEN
  IF(SELECT jsonb_array_length(ctx.duties) FROM pg_temp.pim_dictionary_tx_context ctx)>=32 THEN RAISE EXCEPTION 'PIM complete duty budget' USING ERRCODE='54000';END IF;
  IF(SELECT octet_length((ctx.duties||jsonb_build_array(new_duty))::text) FROM pg_temp.pim_dictionary_tx_context ctx)>4194304 THEN RAISE EXCEPTION 'PIM complete duty bytes' USING ERRCODE='54000';END IF;
  UPDATE pg_temp.pim_dictionary_tx_context SET duties=duties||jsonb_build_array(new_duty),prepared=false,finalized=false;
 END IF;
END $$;
CREATE FUNCTION pim_dictionary_prepare() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE duty_json jsonb;proof_json jsonb;final_duties jsonb:='[]'::jsonb;
BEGIN
 PERFORM public.pim_dictionary_begin();PERFORM public.pim_dictionary_require();
 FOR duty_json IN SELECT duty.value FROM pg_temp.pim_dictionary_tx_context ctx CROSS JOIN LATERAL jsonb_array_elements(ctx.duties) duty(value) ORDER BY duty.value->>'tenant_id',duty.value->>'catalog_id',duty.value->>'user_id',duty.value->>'api_key_id' LOOP
  IF duty_json->'request'<>'null'::jsonb AND public.pim_dictionary_source((duty_json->>'tenant_id')::uuid,(duty_json->>'catalog_id')::uuid,duty_json->'request',true) IS DISTINCT FROM duty_json->'expected_source' THEN RAISE EXCEPTION 'PIM complete source changed before final identity' USING ERRCODE='40001';END IF;
  proof_json:=public.pim_dictionary_identity((duty_json->>'tenant_id')::uuid,(duty_json->>'user_id')::uuid,(duty_json->>'api_key_id')::uuid,duty_json->>'credential_hash',duty_json->>'role',(duty_json->>'writing')::boolean,true);
  final_duties:=final_duties||jsonb_build_array(duty_json||jsonb_build_object('proof',proof_json));
 END LOOP;
 UPDATE pg_temp.pim_dictionary_tx_context SET duties=final_duties,prepared=true,finalized=false;
END $$;
-- LAST: only native clock after every sibling wait. No relation/advisory locks.
CREATE FUNCTION pim_dictionary_last_clock() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE actual_clock timestamptz:=clock_timestamp();
BEGIN
 IF to_regclass('pg_temp.pim_dictionary_tx_context') IS NULL THEN RAISE EXCEPTION 'PIM final custody absent' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx WHERE ctx.singleton AND ctx.prepared AND ctx.root_xid=pg_current_xact_id()::text AND ctx.start_at=transaction_timestamp() AND ctx.backend_pid=pg_backend_pid()) THEN RAISE EXCEPTION 'PIM final custody not prepared' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx CROSS JOIN LATERAL jsonb_array_elements(ctx.duties) duty(value) WHERE(duty.value->'proof'->>'deadline')::timestamptz<=actual_clock OR duty.value->'proof'->>'deadline' IS NULL) THEN RAISE EXCEPTION 'PIM authority expired at final clock' USING ERRCODE='28000';END IF;
 IF EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx CROSS JOIN LATERAL jsonb_array_elements(ctx.duties) duty(value) WHERE duty.value->'expiry'<>'null'::jsonb AND(duty.value->>'expiry')::timestamptz<=actual_clock) THEN RAISE EXCEPTION 'PIM preview expired at final clock' USING ERRCODE='40001';END IF;
 UPDATE pg_temp.pim_dictionary_tx_context SET finalized=true;
END $$;
CREATE FUNCTION pim_dictionary_source_current(t uuid,cid uuid,request_json jsonb,expected_source jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN RETURN public.pim_dictionary_source(t,cid,request_json,false)=expected_source;
EXCEPTION WHEN no_data_found OR check_violation OR program_limit_exceeded THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_begin(),pim_dictionary_enlist(uuid,uuid,uuid,uuid,text,text,boolean,jsonb,jsonb,timestamptz),pim_dictionary_prepare(),pim_dictionary_last_clock(),pim_dictionary_source_current(uuid,uuid,jsonb,jsonb) FROM PUBLIC,dyna_app;

CREATE FUNCTION pim_dictionary_custody(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 -- Owner RRRO historical verification is explicitly a distinct trust boundary.
 IF current_setting('role',true) IS DISTINCT FROM 'dyna_app' THEN RETURN;END IF;
 PERFORM public.pim_dictionary_begin();
 IF to_regclass('pg_temp.pim_dictionary_tx_context') IS NULL THEN RAISE EXCEPTION 'PIM actual credential custody absent' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx CROSS JOIN LATERAL jsonb_array_elements(ctx.duties) duty(value) WHERE ctx.root_xid=pg_current_xact_id()::text AND ctx.start_at=transaction_timestamp() AND ctx.backend_pid=pg_backend_pid() AND duty.value->>'tenant_id'=t::text) THEN RAISE EXCEPTION 'PIM actual credential tenant absent' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_custody(uuid) FROM PUBLIC,dyna_app;

CREATE FUNCTION pim_dictionary_commit_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE actual_clock timestamptz:=clock_timestamp();
BEGIN
 IF NOT EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx WHERE ctx.singleton AND ctx.prepared AND ctx.finalized AND ctx.root_xid=pg_current_xact_id()::text AND ctx.start_at=transaction_timestamp() AND ctx.backend_pid=pg_backend_pid()) THEN RAISE EXCEPTION 'PIM requires completed managed final clock' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx CROSS JOIN LATERAL jsonb_array_elements(ctx.duties) duty(value) WHERE duty.value->'proof'->>'deadline' IS NULL OR(duty.value->'proof'->>'deadline')::timestamptz<=actual_clock) THEN RAISE EXCEPTION 'PIM authority expired at deferred commit' USING ERRCODE='28000';END IF;
 IF EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx CROSS JOIN LATERAL jsonb_array_elements(ctx.duties) duty(value) WHERE duty.value->'expiry'<>'null'::jsonb AND(duty.value->>'expiry')::timestamptz<=actual_clock) THEN RAISE EXCEPTION 'PIM preview expired at deferred commit' USING ERRCODE='40001';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_commit_guard() FROM PUBLIC,dyna_app;

-- Source unit producer.sql SHA256 9a3ca6af23ad07d4632a9aa444cd685c159063d053d117cd8dcd06687cd63722
-- AUTHORING: private preview producer, not a migration or grant/seal package.
CREATE FUNCTION pim_dictionary_assigned_products(t uuid,cid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_agg(assigned.product_id ORDER BY assigned.product_id),'[]'::jsonb) FROM(SELECT s.product_id FROM public.pim_dictionary_product_states s WHERE(s.tenant_id,s.catalog_id)=(t,cid) AND t=nullif(current_setting('app.tenant_id',true),'')::uuid ORDER BY s.product_id LIMIT 501) assigned $$;
CREATE FUNCTION pim_dictionary_preview_json(preview_row pim_dictionary_previews) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('_after_revision',CASE WHEN preview_row.kind='dictionary' THEN preview_row.frame->'revision'||jsonb_build_object('dictionary_version',((preview_row.frame->'revision'->>'dictionary_version')::bigint+CASE WHEN preview_row.projection->'dictionary_after'=preview_row.projection->'dictionary_before' THEN 0 ELSE 1 END)::text,'schema_hash',public.pim_dictionary_hash(preview_row.projection->'dictionary_after')) ELSE NULL END,'_source_current',public.pim_dictionary_source_current(preview_row.tenant_id,preview_row.catalog_id,preview_row.request,preview_row.frame),'_api_key_id',preview_row.api_key_id,'_frame',preview_row.frame,'_expired',preview_row.expires_at<=clock_timestamp(),'id',preview_row.id,'catalog_id',preview_row.catalog_id,'actor_id',preview_row.actor_id,'kind',preview_row.kind,'client_key',preview_row.client_key,'revision',preview_row.request->'revision','request',preview_row.request,'scope_hash',preview_row.scope_hash,'created_at',to_char(preview_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'expires_at',to_char(preview_row.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'ready',preview_row.ready,'operation_id',(SELECT o.id FROM public.pim_dictionary_operations o WHERE(o.tenant_id,o.preview_id)=(preview_row.tenant_id,preview_row.id)),'errors',preview_row.errors,'product_rows',preview_row.projection->'product_rows','dictionary_before',preview_row.projection->'dictionary_before','dictionary_after',preview_row.projection->'dictionary_after') $$;
CREATE FUNCTION pim_dictionary_store_preview(t uuid,cid uuid,u uuid,k uuid,h text,role_name text,request_json jsonb,projection_json jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE prior_row public.pim_dictionary_previews%ROWTYPE;new_row public.pim_dictionary_previews%ROWTYPE;frame_json jsonb;projected_row jsonb;current_source jsonb;request_digest text;created_clock timestamptz;current_identity jsonb;source_map jsonb;
BEGIN
 current_identity:=public.pim_dictionary_identity(t,u,k,h,role_name,true,false);
 PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,true,NULL,NULL,NULL);
 IF jsonb_typeof(request_json) IS DISTINCT FROM 'object' OR jsonb_typeof(projection_json) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid full PIM preview shape' USING ERRCODE='23514';END IF;
 IF octet_length(request_json::text)>1048576 OR octet_length(projection_json::text)>2097152 THEN RAISE EXCEPTION 'PIM full preview byte budget' USING ERRCODE='54000';END IF;
 IF NOT coalesce(request_json->>'kind' IN('dictionary','product_values'),false) OR NOT coalesce(request_json->>'client_key'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RAISE EXCEPTION 'Invalid PIM request discriminator' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(request_json->'client_key') IS DISTINCT FROM 'string' OR(SELECT array_agg(request_key.key ORDER BY request_key.key) FROM jsonb_object_keys(request_json) request_key(key)) IS DISTINCT FROM (CASE request_json->>'kind' WHEN 'dictionary' THEN ARRAY['changes','client_key','kind','revision']::text[] ELSE ARRAY['client_key','kind','revision','rows']::text[] END) THEN RAISE EXCEPTION 'PIM exact native request' USING ERRCODE='23514';END IF;
 IF(SELECT array_agg(projection_key.key ORDER BY projection_key.key) FROM jsonb_object_keys(projection_json) projection_key(key)) IS DISTINCT FROM ARRAY['dictionary_after','dictionary_before','errors','frame','product_rows','ready','request']::text[] THEN RAISE EXCEPTION 'PIM exact projection union' USING ERRCODE='23514';END IF;
 request_digest:=public.pim_dictionary_hash(request_json);
 PERFORM pg_advisory_xact_lock(hashtextextended('pim_dictionary:'||t::text||':'||cid::text,0));
 SELECT * INTO prior_row FROM public.pim_dictionary_previews p WHERE(p.tenant_id,p.actor_id,p.client_key)=(t,u,(request_json->>'client_key')::uuid);
 IF prior_row.id IS NOT NULL THEN
  IF prior_row.catalog_id<>cid OR prior_row.api_key_id IS DISTINCT FROM k OR prior_row.request_hash<>request_digest OR prior_row.request<>request_json THEN RAISE EXCEPTION 'PIM client key conflict' USING ERRCODE='40001';END IF;
  PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,true,NULL,NULL,NULL);
 RETURN public.pim_dictionary_preview_json(prior_row)||jsonb_build_object('reused',true);
 END IF;
 frame_json:=public.pim_dictionary_source(t,cid,request_json,true);
 SELECT coalesce(jsonb_object_agg(native_source.value->>'product_id',native_source.value),'{}'::jsonb) INTO source_map FROM jsonb_array_elements(frame_json->'sources') native_source(value);
 IF request_json->'revision' IS DISTINCT FROM frame_json->'revision' OR projection_json->'frame' IS DISTINCT FROM frame_json OR projection_json->'request' IS DISTINCT FROM request_json OR jsonb_typeof(projection_json->'ready') IS DISTINCT FROM 'boolean' OR jsonb_typeof(projection_json->'errors') IS DISTINCT FROM 'array' OR jsonb_typeof(projection_json->'product_rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PIM native frame/revision changed' USING ERRCODE='40001';END IF;
 IF request_json->>'kind'='product_values' THEN
  IF projection_json->'dictionary_before' IS DISTINCT FROM 'null'::jsonb OR projection_json->'dictionary_after' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'PIM product projection union' USING ERRCODE='23514';END IF;
  IF jsonb_typeof(request_json->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(request_json->'rows') NOT BETWEEN 1 AND 500 OR(projection_json->'ready'='true'::jsonb AND jsonb_array_length(projection_json->'product_rows')<>jsonb_array_length(request_json->'rows')) OR(projection_json->'ready'='false'::jsonb AND projection_json->'product_rows'<>'[]'::jsonb) THEN RAISE EXCEPTION 'PIM complete product row budget' USING ERRCODE='23514';END IF;
  IF projection_json->'errors' IS DISTINCT FROM public.pim_dictionary_row_errors(frame_json->'dictionary',request_json->'rows') OR(projection_json->'ready'='true'::jsonb) IS DISTINCT FROM(public.pim_dictionary_row_errors(frame_json->'dictionary',request_json->'rows')='[]'::jsonb) THEN RAISE EXCEPTION 'PIM actual full validation errors mismatch' USING ERRCODE='23514';END IF;
  IF(SELECT count(DISTINCT submitted.value->>'product_id') FROM jsonb_array_elements(request_json->'rows') submitted(value))<>jsonb_array_length(request_json->'rows') THEN RAISE EXCEPTION 'PIM duplicate product row' USING ERRCODE='23514';END IF;
  FOR projected_row IN SELECT submitted.value FROM jsonb_array_elements(request_json->'rows') submitted(value) ORDER BY submitted.value->>'product_id' LOOP
   current_source:=source_map->(projected_row->>'product_id');
   IF projected_row->>'product_version' IS DISTINCT FROM current_source->>'product_version' OR projected_row->>'state_version' IS DISTINCT FROM current_source->>'state_version' OR projected_row->>'source_hash' IS DISTINCT FROM current_source->>'source_hash' THEN RAISE EXCEPTION 'PIM native product source changed' USING ERRCODE='40001';END IF;
  END LOOP;
  IF projection_json->'ready'='true'::jsonb AND(SELECT count(DISTINCT projected.value->'after'->>'product_id') FROM jsonb_array_elements(projection_json->'product_rows') projected(value))<>jsonb_array_length(request_json->'rows') THEN RAISE EXCEPTION 'PIM projected row bijection' USING ERRCODE='23514';END IF;
  FOR projected_row IN SELECT projected.value FROM jsonb_array_elements(projection_json->'product_rows') projected(value) LOOP
   IF jsonb_typeof(projected_row) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PIM row projection shape' USING ERRCODE='23514';END IF;
   IF(SELECT array_agg(projected_key.key ORDER BY projected_key.key) FROM jsonb_object_keys(projected_row) projected_key(key)) IS DISTINCT FROM ARRAY['after','before','changed','index']::text[] OR jsonb_typeof(projected_row->'index') IS DISTINCT FROM 'number' OR NOT coalesce(projected_row->>'index'~'^(0|[1-9][0-9]{0,2})$',false) THEN RAISE EXCEPTION 'PIM row projection keys' USING ERRCODE='23514';END IF;
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(request_json->'rows') WITH ORDINALITY submitted(value,ordinal) WHERE public.pim_dictionary_canonical_row(submitted.value)=projected_row->'after' AND submitted.ordinal-1=(projected_row->>'index')::integer) THEN RAISE EXCEPTION 'PIM projected row request identity' USING ERRCODE='23514';END IF;
   current_source:=source_map->(projected_row->'after'->>'product_id');
   IF projected_row->'changed' IS DISTINCT FROM to_jsonb(jsonb_build_object('category_id',current_source->'category_id','values',current_source->'values') IS DISTINCT FROM jsonb_build_object('category_id',projected_row->'after'->'category_id','values',projected_row->'after'->'values')) THEN RAISE EXCEPTION 'PIM semantic changed flag' USING ERRCODE='23514';END IF;
   IF projected_row->'before' IS DISTINCT FROM current_source OR NOT public.pim_dictionary_validate_values(t,cid,(projected_row->'after'->>'category_id')::uuid,projected_row->'after'->'values') THEN RAISE EXCEPTION 'PIM native typed projection mismatch' USING ERRCODE='23514';END IF;
  END LOOP;
 ELSE
  IF projection_json->'product_rows' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'PIM dictionary projection union' USING ERRCODE='23514';END IF;
  IF(SELECT count(*) FROM(SELECT assigned_state.product_id FROM public.pim_dictionary_product_states assigned_state WHERE(assigned_state.tenant_id,assigned_state.catalog_id)=(t,cid) LIMIT 501) complete_scope)>500 THEN RAISE EXCEPTION 'PIM complete affected scope budget' USING ERRCODE='54000';END IF;
  IF projection_json->'dictionary_after' IS DISTINCT FROM public.pim_dictionary_project_dictionary(frame_json->'dictionary',request_json->'changes') OR projection_json->'dictionary_before' IS DISTINCT FROM frame_json->'dictionary' OR NOT public.pim_dictionary_validate_transition(frame_json->'dictionary',projection_json->'dictionary_after') THEN RAISE EXCEPTION 'PIM dictionary before mismatch' USING ERRCODE='23514';END IF;
  IF projection_json->'errors' IS DISTINCT FROM public.pim_dictionary_dictionary_errors(t,cid,projection_json->'dictionary_after') OR(projection_json->'ready'='true'::jsonb) IS DISTINCT FROM(public.pim_dictionary_dictionary_errors(t,cid,projection_json->'dictionary_after')='[]'::jsonb) THEN RAISE EXCEPTION 'PIM exact native affected validation errors mismatch' USING ERRCODE='23514';END IF;
 END IF;
 IF request_json->>'kind'='dictionary' AND projection_json->'dictionary_after' IS DISTINCT FROM frame_json->'dictionary' AND(frame_json->'revision'->>'dictionary_version')::numeric>=9223372036854775807 THEN RAISE EXCEPTION 'PIM dictionary version exhausted' USING ERRCODE='23514';END IF;
 IF NOT public.pim_dictionary_projection_valid(frame_json,request_json,projection_json) THEN RAISE EXCEPTION 'PIM complete projection rejected' USING ERRCODE='23514';END IF;
 created_clock:=clock_timestamp();
 INSERT INTO public.pim_dictionary_previews(tenant_id,catalog_id,id,actor_id,api_key_id,client_key,request_hash,scope_hash,kind,request,frame,projection,ready,errors,created_at,expires_at)
 VALUES(t,cid,gen_random_uuid(),u,k,(request_json->>'client_key')::uuid,request_digest,public.pim_dictionary_hash(jsonb_build_object('request',request_json,'frame',frame_json,'projection',projection_json)),request_json->>'kind',request_json,frame_json,projection_json,(projection_json->>'ready')::boolean,projection_json->'errors',created_clock,created_clock+interval '15 minutes') RETURNING * INTO new_row;
 PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,true,request_json,frame_json,new_row.expires_at);
 RETURN public.pim_dictionary_preview_json(new_row)||jsonb_build_object('reused',false);
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_assigned_products(uuid,uuid),pim_dictionary_preview_json(pim_dictionary_previews),pim_dictionary_store_preview(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb) FROM PUBLIC,dyna_app;

CREATE FUNCTION pim_dictionary_find_preview(t uuid,cid uuid,u uuid,k uuid,h text,role_name text,request_json jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior_row public.pim_dictionary_previews%ROWTYPE;
BEGIN
 PERFORM public.pim_dictionary_identity(t,u,k,h,role_name,true,false);
 IF jsonb_typeof(request_json) IS DISTINCT FROM 'object' OR NOT coalesce(request_json->>'client_key'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RAISE EXCEPTION 'PIM preview request shape' USING ERRCODE='23514';END IF;
 SELECT * INTO prior_row FROM public.pim_dictionary_previews p WHERE(p.tenant_id,p.actor_id,p.client_key)=(t,u,(request_json->>'client_key')::uuid);
 IF prior_row.id IS NULL THEN RETURN NULL;END IF;
 IF prior_row.catalog_id<>cid OR prior_row.api_key_id IS DISTINCT FROM k OR prior_row.request_hash<>public.pim_dictionary_hash(request_json) OR prior_row.request<>request_json THEN RAISE EXCEPTION 'PIM preview key conflict' USING ERRCODE='40001';END IF;
 PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,true,NULL,NULL,NULL);
 RETURN public.pim_dictionary_preview_json(prior_row)||jsonb_build_object('reused',true);
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_find_preview(uuid,uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC,dyna_app;

-- Source unit closure.sql SHA256 ff6f11bb31a926abc362bd8172b32f44cb934994dcb57a12f0962c201bf155e0
-- Historical semantic proof is detached from mutable products and current IAM.
CREATE FUNCTION pim_dictionary_projection_valid(frame_json jsonb,request_json jsonb,projection_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE projected_row jsonb;submitted_row jsonb;source_row jsonb;expected_errors jsonb;scope_rows jsonb:='[]'::jsonb;canonical_row jsonb;seen_ids text[]:='{}'::text[];
BEGIN
 IF jsonb_typeof(frame_json) IS DISTINCT FROM 'object' OR jsonb_typeof(request_json) IS DISTINCT FROM 'object' OR jsonb_typeof(projection_json) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF(SELECT array_agg(shape_key.key ORDER BY shape_key.key) FROM jsonb_object_keys(projection_json) shape_key(key)) IS DISTINCT FROM ARRAY['dictionary_after','dictionary_before','errors','frame','product_rows','ready','request']::text[] THEN RETURN false;END IF;
 IF NOT public.pim_dictionary_source_json_valid(frame_json) THEN RETURN false;END IF;
 IF projection_json->'frame' IS DISTINCT FROM frame_json OR projection_json->'request' IS DISTINCT FROM request_json OR request_json->'revision' IS DISTINCT FROM frame_json->'revision' OR NOT public.pim_dictionary_validate_dictionary(frame_json->'dictionary') OR jsonb_typeof(frame_json->'sources') IS DISTINCT FROM 'array' OR jsonb_typeof(projection_json->'product_rows') IS DISTINCT FROM 'array' OR jsonb_typeof(projection_json->'ready') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
 IF jsonb_array_length(frame_json->'sources')>500 OR frame_json->'sources' IS DISTINCT FROM coalesce((SELECT jsonb_agg(native_source.value ORDER BY native_source.value->>'product_id') FROM jsonb_array_elements(frame_json->'sources') native_source(value)),'[]'::jsonb) THEN RETURN false;END IF;
 FOR source_row IN SELECT native_source.value FROM jsonb_array_elements(frame_json->'sources') native_source(value) LOOP
  IF source_row->>'product_id'=ANY(seen_ids) OR source_row->>'catalog_id' IS DISTINCT FROM frame_json->>'catalog_id' OR source_row->>'source_hash' IS DISTINCT FROM public.pim_dictionary_hash(source_row-'source_hash') THEN RETURN false;END IF;
  seen_ids:=seen_ids||ARRAY[source_row->>'product_id'];scope_rows:=scope_rows||jsonb_build_array(jsonb_build_object('product_id',source_row->'product_id','product_version',source_row->'product_version','state_version',source_row->'state_version','source_hash',source_row->'source_hash','category_id',source_row->'category_id','values',source_row->'values'));
 END LOOP;
 IF request_json->>'kind'='product_values' THEN
  IF(SELECT array_agg(shape_key.key ORDER BY shape_key.key) FROM jsonb_object_keys(request_json) shape_key(key)) IS DISTINCT FROM ARRAY['client_key','kind','revision','rows']::text[] OR projection_json->'dictionary_before' IS DISTINCT FROM 'null'::jsonb OR projection_json->'dictionary_after' IS DISTINCT FROM 'null'::jsonb THEN RETURN false;END IF;
  expected_errors:=public.pim_dictionary_row_errors(frame_json->'dictionary',request_json->'rows');
  IF jsonb_array_length(request_json->'rows')<>jsonb_array_length(scope_rows) OR(SELECT count(DISTINCT request_row.value->>'product_id') FROM jsonb_array_elements(request_json->'rows') request_row(value))<>jsonb_array_length(scope_rows) THEN RETURN false;END IF;
  FOR submitted_row IN SELECT request_row.value FROM jsonb_array_elements(request_json->'rows') request_row(value) LOOP
   canonical_row:=public.pim_dictionary_canonical_row(submitted_row);
   SELECT native_source.value INTO source_row FROM jsonb_array_elements(frame_json->'sources') native_source(value) WHERE native_source.value->>'product_id'=canonical_row->>'product_id';
   IF source_row IS NULL OR canonical_row->'product_version' IS DISTINCT FROM source_row->'product_version' OR canonical_row->'state_version' IS DISTINCT FROM source_row->'state_version' OR canonical_row->'source_hash' IS DISTINCT FROM source_row->'source_hash' THEN RETURN false;END IF;
  END LOOP;
  IF expected_errors='[]'::jsonb THEN
   IF jsonb_array_length(projection_json->'product_rows')<>jsonb_array_length(scope_rows) THEN RETURN false;END IF;
   FOR projected_row IN SELECT projected.value FROM jsonb_array_elements(projection_json->'product_rows') projected(value) LOOP
    IF jsonb_typeof(projected_row) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
    IF(SELECT array_agg(shape_key.key ORDER BY shape_key.key) FROM jsonb_object_keys(projected_row) shape_key(key)) IS DISTINCT FROM ARRAY['after','before','changed','index']::text[] OR jsonb_typeof(projected_row->'index') IS DISTINCT FROM 'number' OR NOT coalesce(projected_row->>'index'~'^(0|[1-9][0-9]{0,2})$',false) THEN RETURN false;END IF;
    IF NOT EXISTS(SELECT FROM jsonb_array_elements(request_json->'rows') WITH ORDINALITY request_row(value,ordinal) WHERE request_row.ordinal-1=(projected_row->>'index')::integer AND public.pim_dictionary_canonical_row(request_row.value)=projected_row->'after') THEN RETURN false;END IF;
    SELECT native_source.value INTO source_row FROM jsonb_array_elements(frame_json->'sources') native_source(value) WHERE native_source.value->>'product_id'=projected_row->'after'->>'product_id';
    IF projected_row->'before' IS DISTINCT FROM source_row OR projected_row->'changed' IS DISTINCT FROM to_jsonb(jsonb_build_object('category_id',source_row->'category_id','values',source_row->'values') IS DISTINCT FROM jsonb_build_object('category_id',projected_row->'after'->'category_id','values',projected_row->'after'->'values')) THEN RETURN false;END IF;
   END LOOP;
   IF(SELECT count(DISTINCT projected.value->>'index') FROM jsonb_array_elements(projection_json->'product_rows') projected(value))<>jsonb_array_length(scope_rows) THEN RETURN false;END IF;
  ELSIF projection_json->'product_rows' IS DISTINCT FROM '[]'::jsonb THEN RETURN false;END IF;
 ELSIF request_json->>'kind'='dictionary' THEN
  IF(SELECT array_agg(shape_key.key ORDER BY shape_key.key) FROM jsonb_object_keys(request_json) shape_key(key)) IS DISTINCT FROM ARRAY['changes','client_key','kind','revision']::text[] OR projection_json->'product_rows' IS DISTINCT FROM '[]'::jsonb OR projection_json->'dictionary_before' IS DISTINCT FROM frame_json->'dictionary' OR projection_json->'dictionary_after' IS DISTINCT FROM public.pim_dictionary_project_dictionary(frame_json->'dictionary',request_json->'changes') THEN RETURN false;END IF;
  IF projection_json->'dictionary_after' IS DISTINCT FROM frame_json->'dictionary' AND(frame_json->'revision'->>'dictionary_version')::numeric>=9223372036854775807 THEN RETURN false;END IF;
  expected_errors:=CASE WHEN scope_rows='[]'::jsonb THEN '[]'::jsonb ELSE public.pim_dictionary_row_errors(projection_json->'dictionary_after',scope_rows) END;
 ELSE RETURN false;END IF;
 RETURN projection_json->'errors'=expected_errors AND(projection_json->'ready'='true'::jsonb)=(expected_errors='[]'::jsonb);
EXCEPTION WHEN check_violation OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR program_limit_exceeded THEN RETURN false;
END $$;
CREATE FUNCTION pim_dictionary_validate_preview(t uuid,preview_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE preview_row public.pim_dictionary_previews%ROWTYPE;
BEGIN
 SELECT * INTO preview_row FROM public.pim_dictionary_previews pv WHERE(pv.tenant_id,pv.id)=(t,preview_id);
 IF preview_row.id IS NULL OR NOT isfinite(preview_row.created_at) OR NOT isfinite(preview_row.expires_at) OR preview_row.frame->>'catalog_id' IS DISTINCT FROM preview_row.catalog_id::text OR preview_row.request_hash IS DISTINCT FROM public.pim_dictionary_hash(preview_row.request) OR preview_row.request->>'client_key' IS DISTINCT FROM preview_row.client_key::text OR preview_row.kind IS DISTINCT FROM preview_row.request->>'kind' OR preview_row.ready IS DISTINCT FROM(preview_row.projection->>'ready')::boolean OR preview_row.errors IS DISTINCT FROM preview_row.projection->'errors' OR preview_row.expires_at IS DISTINCT FROM preview_row.created_at+interval '15 minutes' OR preview_row.scope_hash IS DISTINCT FROM public.pim_dictionary_hash(jsonb_build_object('request',preview_row.request,'frame',preview_row.frame,'projection',preview_row.projection)) OR NOT public.pim_dictionary_projection_valid(preview_row.frame,preview_row.request,preview_row.projection) THEN RAISE EXCEPTION 'PIM immutable preview proof mismatch' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION pim_dictionary_validate_operation(t uuid,operation_id uuid,historical boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE operation_row public.pim_dictionary_operations%ROWTYPE;admission_row public.pim_dictionary_admissions%ROWTYPE;preview_row public.pim_dictionary_previews%ROWTYPE;projected_row jsonb;expected_source jsonb;next_source jsonb;expected_body jsonb;source_row jsonb;new_sources jsonb:='[]'::jsonb;product_rows jsonb:='[]'::jsonb;changed integer:=0;next_dictionary jsonb;next_revision jsonb;next_state bigint;
BEGIN
 SELECT * INTO operation_row FROM public.pim_dictionary_operations op WHERE(op.tenant_id,op.id)=(t,operation_id);
 SELECT * INTO admission_row FROM public.pim_dictionary_admissions adm WHERE(adm.tenant_id,adm.id)=(t,operation_id);
 IF operation_row.id IS NULL OR admission_row.id IS NULL THEN RAISE EXCEPTION 'PIM complete parent pair absent' USING ERRCODE='23514';END IF;
 PERFORM public.pim_dictionary_validate_preview(t,operation_row.preview_id);
 SELECT * INTO preview_row FROM public.pim_dictionary_previews pv WHERE(pv.tenant_id,pv.id)=(t,operation_row.preview_id);
 IF NOT isfinite(operation_row.created_at) OR NOT isfinite(admission_row.created_at) OR NOT isfinite(admission_row.start_at) OR NOT preview_row.ready OR(operation_row.preview_id,operation_row.actor_id,operation_row.client_key,operation_row.request_hash,operation_row.created_at) IS DISTINCT FROM(admission_row.preview_id,admission_row.actor_id,admission_row.client_key,admission_row.request_hash,admission_row.created_at) OR operation_row.api_key_id IS DISTINCT FROM admission_row.api_key_id OR operation_row.body IS DISTINCT FROM admission_row.result OR(operation_row.catalog_id,operation_row.actor_id,operation_row.kind,operation_row.scope_hash) IS DISTINCT FROM(preview_row.catalog_id,preview_row.actor_id,preview_row.kind,preview_row.scope_hash) OR operation_row.api_key_id IS DISTINCT FROM preview_row.api_key_id OR operation_row.request_hash IS DISTINCT FROM public.pim_dictionary_hash(jsonb_build_object('client_key',operation_row.client_key,'scope_hash',operation_row.scope_hash,'confirmed',true)) OR operation_row.created_at<preview_row.created_at OR operation_row.created_at>=preview_row.expires_at THEN RAISE EXCEPTION 'PIM immutable operation link mismatch' USING ERRCODE='23514';END IF;
 expected_source:=preview_row.frame;next_revision:=expected_source->'revision';
 IF operation_row.kind='product_values' THEN
  FOR source_row IN SELECT native_source.value FROM jsonb_array_elements(expected_source->'sources') native_source(value) LOOP
   SELECT projected.value INTO projected_row FROM jsonb_array_elements(preview_row.projection->'product_rows') projected(value) WHERE projected.value->'after'->>'product_id'=source_row->>'product_id';
   IF projected_row IS NULL THEN RAISE EXCEPTION 'PIM full operation source bijection' USING ERRCODE='23514';END IF;
   next_state:=(source_row->>'state_version')::bigint;IF projected_row->'changed'='true'::jsonb THEN next_state:=next_state+1;changed:=changed+1;END IF;
   next_source:=(source_row-'source_hash')||jsonb_build_object('category_id',projected_row->'after'->'category_id','values',projected_row->'after'->'values','state_version',next_state::text);
   next_source:=next_source||jsonb_build_object('source_hash',public.pim_dictionary_hash(next_source));new_sources:=new_sources||jsonb_build_array(next_source);
  END LOOP;
  FOR projected_row IN SELECT projected.value FROM jsonb_array_elements(preview_row.projection->'product_rows') projected(value) ORDER BY projected.value->'after'->>'product_id' LOOP
   SELECT native_source.value INTO next_source FROM jsonb_array_elements(new_sources) native_source(value) WHERE native_source.value->>'product_id'=projected_row->'after'->>'product_id';source_row:=projected_row->'before';
   product_rows:=product_rows||jsonb_build_array(jsonb_build_object('product_id',source_row->'product_id','before',jsonb_build_object('product_id',source_row->'product_id','product_version',source_row->'product_version','state_version',source_row->'state_version','source_hash',source_row->'source_hash','category_id',source_row->'category_id','values',source_row->'values'),'after',(projected_row->'after')||jsonb_build_object('state_version',next_source->'state_version','source_hash',next_source->'source_hash')));
  END LOOP;
  expected_body:=jsonb_build_object('product_rows',product_rows,'dictionary_before',NULL,'dictionary_after',NULL);expected_source:=expected_source||jsonb_build_object('sources',new_sources);
 ELSE
  next_dictionary:=preview_row.projection->'dictionary_after';
  changed:=(SELECT count(*) FROM jsonb_array_elements(next_dictionary->'categories') projected(value) WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(preview_row.frame->'dictionary'->'categories') old_node(value) WHERE old_node.value=projected.value))+(SELECT count(*) FROM jsonb_array_elements(next_dictionary->'definitions') projected(value) WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(preview_row.frame->'dictionary'->'definitions') old_node(value) WHERE old_node.value=projected.value));
  next_revision:=next_revision||jsonb_build_object('dictionary_version',((next_revision->>'dictionary_version')::bigint+CASE WHEN changed=0 THEN 0 ELSE 1 END)::text,'schema_hash',public.pim_dictionary_hash(next_dictionary));
  expected_source:=expected_source||jsonb_build_object('dictionary',next_dictionary,'revision',next_revision);expected_body:=jsonb_build_object('product_rows','[]'::jsonb,'dictionary_before',preview_row.frame->'dictionary','dictionary_after',next_dictionary);
 END IF;
 expected_body:=expected_body||jsonb_build_object('_expected_source',expected_source,'_before_revision',preview_row.frame->'revision','_after_revision',next_revision);
 IF operation_row.changed_count IS DISTINCT FROM changed OR operation_row.body IS DISTINCT FROM expected_body THEN RAISE EXCEPTION 'PIM full operation projection mismatch' USING ERRCODE='23514';END IF;
 IF NOT public.pim_dictionary_identity_json_valid(admission_row.identity,operation_row.api_key_id IS NOT NULL,operation_row.created_at) THEN RAISE EXCEPTION 'PIM historical authority proof mismatch' USING ERRCODE='23514';END IF;
 IF NOT historical THEN
  IF to_regclass('pg_temp.pim_dictionary_tx_context') IS NULL THEN RAISE EXCEPTION 'PIM complete managed context absent' USING ERRCODE='55000';END IF;
  IF NOT EXISTS(SELECT FROM pg_temp.pim_dictionary_tx_context ctx CROSS JOIN LATERAL jsonb_array_elements(ctx.duties) duty(value) WHERE ctx.root_xid=pg_current_xact_id()::text AND ctx.start_at=transaction_timestamp() AND ctx.backend_pid=pg_backend_pid() AND duty.value->>'tenant_id'=t::text AND duty.value->>'user_id'=operation_row.actor_id::text AND duty.value->>'api_key_id' IS NOT DISTINCT FROM operation_row.api_key_id::text AND duty.value->'writing'='true'::jsonb AND duty.value->'request'=preview_row.request AND duty.value->'expected_source'=expected_source) THEN RAISE EXCEPTION 'PIM complete native duty mismatch' USING ERRCODE='23514';END IF;
  IF admission_row.root_xid<>pg_current_xact_id()::text OR admission_row.start_at<>transaction_timestamp() OR admission_row.backend_pid<>pg_backend_pid() OR public.pim_dictionary_source(t,operation_row.catalog_id,preview_row.request,false) IS DISTINCT FROM expected_source THEN RAISE EXCEPTION 'PIM live complete source closure mismatch' USING ERRCODE='23514';END IF;
 END IF;
END $$;
CREATE FUNCTION pim_dictionary_evidence_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='pim_dictionary_previews' THEN PERFORM public.pim_dictionary_validate_preview(NEW.tenant_id,NEW.id);
 ELSE PERFORM public.pim_dictionary_validate_operation(NEW.tenant_id,NEW.id,false);END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER pim_dictionary_preview_complete AFTER INSERT ON pim_dictionary_previews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pim_dictionary_evidence_guard();
CREATE CONSTRAINT TRIGGER pim_dictionary_admission_complete AFTER INSERT ON pim_dictionary_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pim_dictionary_evidence_guard();
CREATE CONSTRAINT TRIGGER pim_dictionary_operation_complete AFTER INSERT ON pim_dictionary_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pim_dictionary_evidence_guard();
CREATE FUNCTION pim_dictionary_state_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scoped_tenant uuid;scoped_catalog uuid;head_operation uuid;state_operation uuid;actual_operation public.pim_dictionary_operations%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN scoped_tenant:=OLD.tenant_id;scoped_catalog:=OLD.catalog_id;ELSE scoped_tenant:=NEW.tenant_id;scoped_catalog:=NEW.catalog_id;END IF;
 IF TG_TABLE_NAME='pim_dictionary_product_states' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PIM states cannot be hard-deleted' USING ERRCODE='23514';END IF;
  SELECT ps.last_operation_id INTO state_operation FROM public.pim_dictionary_product_states ps WHERE(ps.tenant_id,ps.product_id)=(NEW.tenant_id,NEW.product_id);
  SELECT * INTO actual_operation FROM public.pim_dictionary_operations op WHERE(op.tenant_id,op.id)=(scoped_tenant,state_operation);
  IF actual_operation.kind IS DISTINCT FROM 'product_values' OR NOT EXISTS(SELECT FROM jsonb_array_elements(actual_operation.body->'product_rows') projected(value) WHERE projected.value->>'product_id'=NEW.product_id::text AND projected.value->'before' IS DISTINCT FROM projected.value->'after') THEN RAISE EXCEPTION 'PIM state not enlisted in exact operation' USING ERRCODE='23514';END IF;
  PERFORM public.pim_dictionary_validate_operation(scoped_tenant,state_operation,false);
 ELSE
  SELECT ph.last_operation_id INTO head_operation FROM public.pim_dictionary_heads ph WHERE(ph.tenant_id,ph.catalog_id)=(scoped_tenant,scoped_catalog);
  SELECT * INTO actual_operation FROM public.pim_dictionary_operations op WHERE(op.tenant_id,op.id)=(scoped_tenant,head_operation);
  IF actual_operation.kind IS DISTINCT FROM 'dictionary' OR actual_operation.changed_count=0 THEN RAISE EXCEPTION 'PIM dictionary mutation lacks exact changed operation' USING ERRCODE='23514';END IF;
  PERFORM public.pim_dictionary_validate_operation(scoped_tenant,head_operation,false);
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['pim_dictionary_heads','pim_dictionary_categories','pim_dictionary_definitions','pim_dictionary_bindings','pim_dictionary_product_states'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER pim_dictionary_state_complete AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pim_dictionary_state_guard()',relation_name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_projection_valid(jsonb,jsonb,jsonb),pim_dictionary_validate_preview(uuid,uuid),pim_dictionary_validate_operation(uuid,uuid,boolean),pim_dictionary_evidence_guard(),pim_dictionary_state_guard() FROM PUBLIC,dyna_app;

CREATE FUNCTION pim_dictionary_key_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF(to_jsonb(OLD)->'tenant_id',to_jsonb(OLD)->'catalog_id',to_jsonb(OLD)->'id',to_jsonb(OLD)->'product_id',to_jsonb(OLD)->'category_id',to_jsonb(OLD)->'definition_id') IS DISTINCT FROM(to_jsonb(NEW)->'tenant_id',to_jsonb(NEW)->'catalog_id',to_jsonb(NEW)->'id',to_jsonb(NEW)->'product_id',CASE WHEN TG_TABLE_NAME='pim_dictionary_product_states' THEN to_jsonb(OLD)->'category_id' ELSE to_jsonb(NEW)->'category_id' END,to_jsonb(NEW)->'definition_id') THEN RAISE EXCEPTION 'PIM native key mutation prohibited' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE relation_name text;BEGIN
 FOREACH relation_name IN ARRAY ARRAY['pim_dictionary_heads','pim_dictionary_categories','pim_dictionary_definitions','pim_dictionary_bindings','pim_dictionary_product_states'] LOOP
  EXECUTE format('CREATE TRIGGER pim_dictionary_key_immutable BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pim_dictionary_key_guard()',relation_name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_key_guard() FROM PUBLIC,dyna_app;

-- Source unit apply.sql SHA256 bf10b6337c3e6770d4edebb9152445be024c8f9e385b0969cd03f824ff1894ec
-- PRIVATE WRITER CANDIDATE; full deferred closure/portable seal/terminal below
-- are adoption prerequisites, not optional bypasses. No application ACL grants.
CREATE FUNCTION pim_dictionary_operation_json(operation_row pim_dictionary_operations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT operation_row.body||jsonb_build_object('id',operation_row.id,'preview_id',operation_row.preview_id,'catalog_id',operation_row.catalog_id,'actor_id',operation_row.actor_id,'kind',operation_row.kind,'scope_hash',operation_row.scope_hash,'created_at',to_char(operation_row.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'changed_count',operation_row.changed_count) $$;
CREATE FUNCTION pim_dictionary_apply(t uuid,cid uuid,u uuid,k uuid,h text,role_name text,requested_preview_id uuid,apply_json jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE prior_operation public.pim_dictionary_operations%ROWTYPE;preview_row public.pim_dictionary_previews%ROWTYPE;created_operation public.pim_dictionary_operations%ROWTYPE;frame_json jsonb;row_json jsonb;current_source jsonb;result_json jsonb;identity_json jsonb;operation_id uuid;changed integer:=0;created_clock timestamptz;new_dictionary jsonb;new_categories jsonb;new_definitions jsonb;head_version bigint;head_exists boolean;product_changes jsonb:='[]'::jsonb;new_state_version bigint;source_map jsonb;next_source jsonb;
BEGIN
 identity_json:=public.pim_dictionary_identity(t,u,k,h,role_name,true,false);
 PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,true,NULL,NULL,NULL);
 IF jsonb_typeof(apply_json) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PIM apply shape' USING ERRCODE='23514';END IF;
 IF(SELECT array_agg(input_key.key ORDER BY input_key.key) FROM jsonb_object_keys(apply_json) input_key(key)) IS DISTINCT FROM ARRAY['client_key','confirmed','scope_hash']::text[] OR jsonb_typeof(apply_json->'scope_hash') IS DISTINCT FROM 'string' OR jsonb_typeof(apply_json->'client_key') IS DISTINCT FROM 'string' OR apply_json->'confirmed' IS DISTINCT FROM 'true'::jsonb OR NOT coalesce(apply_json->>'client_key'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RAISE EXCEPTION 'PIM exact consent required' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pim_dictionary:'||t::text||':'||cid::text,0));
 SELECT * INTO prior_operation FROM public.pim_dictionary_operations o WHERE(o.tenant_id,o.actor_id,o.client_key)=(t,u,(apply_json->>'client_key')::uuid);
 IF prior_operation.id IS NOT NULL THEN
  IF prior_operation.catalog_id<>cid OR prior_operation.api_key_id IS DISTINCT FROM k OR prior_operation.preview_id<>requested_preview_id OR prior_operation.request_hash<>public.pim_dictionary_hash(apply_json) OR prior_operation.scope_hash IS DISTINCT FROM apply_json->>'scope_hash' THEN RAISE EXCEPTION 'PIM operation client key conflict' USING ERRCODE='40001';END IF;
  PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,true,NULL,NULL,NULL);
  RETURN public.pim_dictionary_operation_json(prior_operation)||jsonb_build_object('reused',true);
 END IF;
 SELECT * INTO preview_row FROM public.pim_dictionary_previews p WHERE(p.tenant_id,p.id,p.catalog_id,p.actor_id)=(t,requested_preview_id,cid,u) FOR SHARE;
 IF preview_row.id IS NULL THEN RAISE EXCEPTION 'Unknown own PIM preview' USING ERRCODE='P0002';END IF;
 IF preview_row.api_key_id IS DISTINCT FROM k OR NOT preview_row.ready OR preview_row.expires_at<=clock_timestamp() OR preview_row.scope_hash IS DISTINCT FROM apply_json->>'scope_hash' THEN RAISE EXCEPTION 'PIM preview no longer applicable' USING ERRCODE='40001';END IF;
 IF EXISTS(SELECT FROM public.pim_dictionary_operations o WHERE(o.tenant_id,o.preview_id)=(t,requested_preview_id)) THEN RAISE EXCEPTION 'PIM preview already applied with another key' USING ERRCODE='40001';END IF;
 frame_json:=public.pim_dictionary_source(t,cid,preview_row.request,true);SELECT coalesce(jsonb_object_agg(native_source.value->>'product_id',native_source.value),'{}'::jsonb) INTO source_map FROM jsonb_array_elements(frame_json->'sources') native_source(value);IF frame_json IS DISTINCT FROM preview_row.frame THEN RAISE EXCEPTION 'PIM dictionary source changed' USING ERRCODE='40001';END IF;
 operation_id:=gen_random_uuid();created_clock:=clock_timestamp();
 IF preview_row.kind='product_values' THEN
  FOR row_json IN SELECT projected.value FROM jsonb_array_elements(preview_row.projection->'product_rows') projected(value) ORDER BY projected.value->'after'->>'product_id' LOOP
   current_source:=source_map->(row_json->'after'->>'product_id');
   IF current_source IS DISTINCT FROM row_json->'before' OR NOT public.pim_dictionary_validate_values(t,cid,(row_json->'after'->>'category_id')::uuid,row_json->'after'->'values') THEN RAISE EXCEPTION 'PIM actual full product projection changed' USING ERRCODE='40001';END IF;
   IF jsonb_build_object('category_id',current_source->'category_id','values',current_source->'values') IS DISTINCT FROM jsonb_build_object('category_id',row_json->'after'->'category_id','values',row_json->'after'->'values') THEN changed:=changed+1;new_state_version:=(current_source->>'state_version')::bigint+1;
    INSERT INTO public.pim_dictionary_product_states(tenant_id,product_id,catalog_id,version,category_id,typed_values,last_operation_id) VALUES(t,(current_source->>'product_id')::uuid,cid,new_state_version,(row_json->'after'->>'category_id')::uuid,row_json->'after'->'values',operation_id)
    ON CONFLICT(tenant_id,product_id) DO UPDATE SET version=excluded.version,category_id=excluded.category_id,typed_values=excluded.typed_values,last_operation_id=excluded.last_operation_id;
   ELSE new_state_version:=(current_source->>'state_version')::bigint;END IF;
   next_source:=(current_source-'source_hash')||jsonb_build_object('category_id',row_json->'after'->'category_id','values',row_json->'after'->'values','state_version',new_state_version::text);
   product_changes:=product_changes||jsonb_build_array(jsonb_build_object('product_id',current_source->'product_id','before',jsonb_build_object('product_id',current_source->'product_id','product_version',current_source->'product_version','state_version',current_source->'state_version','source_hash',current_source->'source_hash','category_id',current_source->'category_id','values',current_source->'values'),'after',(row_json->'after')||jsonb_build_object('state_version',new_state_version::text,'source_hash',public.pim_dictionary_hash(next_source))));
  END LOOP;
  result_json:=jsonb_build_object('product_rows',product_changes,'dictionary_before',NULL,'dictionary_after',NULL);
 ELSE
  IF(SELECT count(*) FROM(SELECT assigned_state.product_id FROM public.pim_dictionary_product_states assigned_state WHERE(assigned_state.tenant_id,assigned_state.catalog_id)=(t,cid) LIMIT 501) complete_scope)>500 THEN RAISE EXCEPTION 'PIM complete affected scope budget' USING ERRCODE='54000';END IF;
  -- Complete native dictionary semantics are independent of the TS projector.
  new_dictionary:=preview_row.projection->'dictionary_after';new_categories:=new_dictionary->'categories';new_definitions:=new_dictionary->'definitions';
  IF new_dictionary IS DISTINCT FROM public.pim_dictionary_project_dictionary(frame_json->'dictionary',preview_row.request->'changes') OR NOT public.pim_dictionary_validate_transition(frame_json->'dictionary',new_dictionary) OR jsonb_typeof(new_categories) IS DISTINCT FROM 'array' OR jsonb_typeof(new_definitions) IS DISTINCT FROM 'array' OR jsonb_array_length(new_categories)>500 OR jsonb_array_length(new_definitions)>500 THEN RAISE EXCEPTION 'PIM complete dictionary budget' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT FROM public.pim_dictionary_categories c WHERE(c.tenant_id,c.catalog_id)=(t,cid) AND NOT EXISTS(SELECT FROM jsonb_array_elements(new_categories) projected(value) WHERE projected.value->>'id'=c.id::text)) OR EXISTS(SELECT FROM public.pim_dictionary_definitions d WHERE(d.tenant_id,d.catalog_id)=(t,cid) AND NOT EXISTS(SELECT FROM jsonb_array_elements(new_definitions) projected(value) WHERE projected.value->>'id'=d.id::text)) THEN RAISE EXCEPTION 'PIM hard-delete prohibited' USING ERRCODE='23514';END IF;
  IF new_dictionary IS DISTINCT FROM frame_json->'dictionary' THEN
   changed:=(SELECT count(*) FROM jsonb_array_elements(new_categories) projected(value) WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(frame_json->'dictionary'->'categories') old_node(value) WHERE old_node.value=projected.value))+(SELECT count(*) FROM jsonb_array_elements(new_definitions) projected(value) WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(frame_json->'dictionary'->'definitions') old_node(value) WHERE old_node.value=projected.value));
   IF changed>500 THEN RAISE EXCEPTION 'PIM whole change budget' USING ERRCODE='54000';END IF;
   FOR row_json IN SELECT projected.value FROM jsonb_array_elements(new_definitions) projected(value) LOOP
    INSERT INTO public.pim_dictionary_definitions(tenant_id,catalog_id,id,version,name,active,shape) VALUES(t,cid,(row_json->>'id')::uuid,(row_json->>'version')::bigint,row_json->>'name',(row_json->>'active')::boolean,row_json->'shape') ON CONFLICT(tenant_id,catalog_id,id) DO UPDATE SET version=excluded.version,name=excluded.name,active=excluded.active,shape=excluded.shape;
   END LOOP;
   FOR row_json IN SELECT projected.value FROM jsonb_array_elements(new_categories) projected(value) LOOP
    INSERT INTO public.pim_dictionary_categories(tenant_id,catalog_id,id,version,parent_id,name,active) VALUES(t,cid,(row_json->>'id')::uuid,(row_json->>'version')::bigint,(row_json->>'parent_id')::uuid,row_json->>'name',(row_json->>'active')::boolean) ON CONFLICT(tenant_id,catalog_id,id) DO UPDATE SET version=excluded.version,parent_id=excluded.parent_id,name=excluded.name,active=excluded.active;
   END LOOP;
   DELETE FROM public.pim_dictionary_bindings b WHERE(b.tenant_id,b.catalog_id)=(t,cid);
   INSERT INTO public.pim_dictionary_bindings(tenant_id,catalog_id,category_id,definition_id,required) SELECT t,cid,(category_node.value->>'id')::uuid,(binding_node.value->>'definition_id')::uuid,(binding_node.value->>'required')::boolean FROM jsonb_array_elements(new_categories) category_node(value) CROSS JOIN LATERAL jsonb_array_elements(category_node.value->'bindings') binding_node(value);
   FOR row_json IN SELECT jsonb_build_object('product_id',s.product_id,'category_id',s.category_id,'values',s.typed_values) FROM public.pim_dictionary_product_states s WHERE(s.tenant_id,s.catalog_id)=(t,cid) ORDER BY s.product_id LOOP
    IF NOT public.pim_dictionary_validate_values(t,cid,(row_json->>'category_id')::uuid,row_json->'values') THEN RAISE EXCEPTION 'PIM impacted product invalid' USING ERRCODE='23514';END IF;
   END LOOP;
   head_version:=(frame_json->'revision'->>'dictionary_version')::bigint+1;
   INSERT INTO public.pim_dictionary_heads(tenant_id,catalog_id,version,last_operation_id) VALUES(t,cid,head_version,operation_id) ON CONFLICT(tenant_id,catalog_id) DO UPDATE SET version=excluded.version,last_operation_id=excluded.last_operation_id;
  END IF;
  result_json:=jsonb_build_object('product_rows','[]'::jsonb,'dictionary_before',frame_json->'dictionary','dictionary_after',new_dictionary);
 END IF;
 result_json:=result_json||jsonb_build_object('_expected_source',public.pim_dictionary_source(t,cid,preview_row.request,false),'_before_revision',frame_json->'revision','_after_revision',public.pim_dictionary_frame(t,cid,false)->'revision');
 -- Durable identity is the actual late pin after all source/effect locks, not the initial read.
 identity_json:=public.pim_dictionary_identity(t,u,k,h,role_name,true,true);
 INSERT INTO public.pim_dictionary_admissions(tenant_id,id,preview_id,actor_id,api_key_id,client_key,request_hash,root_xid,start_at,backend_pid,identity,result,created_at) VALUES(t,operation_id,requested_preview_id,u,k,(apply_json->>'client_key')::uuid,public.pim_dictionary_hash(apply_json),pg_current_xact_id()::text,transaction_timestamp(),pg_backend_pid(),identity_json,result_json,created_clock);
 INSERT INTO public.pim_dictionary_operations(tenant_id,id,preview_id,catalog_id,actor_id,api_key_id,client_key,request_hash,scope_hash,kind,changed_count,body,created_at) VALUES(t,operation_id,requested_preview_id,cid,u,k,(apply_json->>'client_key')::uuid,public.pim_dictionary_hash(apply_json),preview_row.scope_hash,preview_row.kind,changed,result_json,created_clock) RETURNING * INTO created_operation;
 PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,true,preview_row.request,result_json->'_expected_source',preview_row.expires_at);
 RETURN public.pim_dictionary_operation_json(created_operation)||jsonb_build_object('reused',false);
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_operation_json(pim_dictionary_operations),pim_dictionary_apply(uuid,uuid,uuid,uuid,text,text,uuid,jsonb) FROM PUBLIC,dyna_app;

-- Source unit reads.sql SHA256 2f013f56b50eba15cb169275918704ec707568db07a65f56e0611a6eef4c9cb1
CREATE FUNCTION pim_dictionary_read_preview(t uuid,cid uuid,u uuid,k uuid,h text,role_name text,preview_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE preview_row public.pim_dictionary_previews%ROWTYPE;
BEGIN
 PERFORM public.pim_dictionary_identity(t,u,k,h,role_name,false,false);
 SELECT * INTO preview_row FROM public.pim_dictionary_previews p WHERE(p.tenant_id,p.catalog_id,p.id)=(t,cid,preview_id);
 IF preview_row.id IS NULL THEN RAISE EXCEPTION 'Unknown own PIM preview' USING ERRCODE='P0002';END IF;
 PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,false,NULL,NULL,NULL);
 RETURN public.pim_dictionary_preview_json(preview_row)||jsonb_build_object('reused',false);
END $$;
CREATE FUNCTION pim_dictionary_read_operation(t uuid,cid uuid,u uuid,k uuid,h text,role_name text,operation_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE operation_row public.pim_dictionary_operations%ROWTYPE;
BEGIN
 PERFORM public.pim_dictionary_identity(t,u,k,h,role_name,false,false);
 SELECT * INTO operation_row FROM public.pim_dictionary_operations o WHERE(o.tenant_id,o.catalog_id,o.id)=(t,cid,operation_id);
 IF operation_row.id IS NULL THEN RAISE EXCEPTION 'Unknown own PIM operation' USING ERRCODE='P0002';END IF;
 PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,false,NULL,NULL,NULL);
 RETURN public.pim_dictionary_operation_json(operation_row)||jsonb_build_object('reused',false);
END $$;
CREATE FUNCTION pim_dictionary_history(t uuid,cid uuid,u uuid,k uuid,h text,role_name text,cursor_id uuid,kind_filter text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE cursor_time timestamptz;result_rows jsonb;last_id uuid;row_count integer;
BEGIN
 PERFORM public.pim_dictionary_identity(t,u,k,h,role_name,false,false);PERFORM public.pim_dictionary_frame(t,cid,false);IF kind_filter IS NOT NULL AND kind_filter NOT IN('dictionary','product_values') THEN RAISE EXCEPTION 'Invalid PIM history kind' USING ERRCODE='23514';END IF;
 IF cursor_id IS NOT NULL THEN SELECT p.created_at INTO cursor_time FROM public.pim_dictionary_previews p WHERE(p.tenant_id,p.catalog_id,p.id)=(t,cid,cursor_id) AND(kind_filter IS NULL OR p.kind=kind_filter);IF cursor_time IS NULL THEN RAISE EXCEPTION 'Unknown scoped PIM cursor' USING ERRCODE='P0002';END IF;END IF;
 WITH selected AS(SELECT p.id,p.kind,p.created_at,p.ready,(SELECT o.id FROM public.pim_dictionary_operations o WHERE(o.tenant_id,o.preview_id)=(p.tenant_id,p.id)) operation_id FROM public.pim_dictionary_previews p WHERE(p.tenant_id,p.catalog_id)=(t,cid) AND(kind_filter IS NULL OR p.kind=kind_filter) AND(cursor_id IS NULL OR(p.created_at,p.id)<(cursor_time,cursor_id)) ORDER BY p.created_at DESC,p.id DESC LIMIT 50)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',selected.id,'kind',selected.kind,'created_at',to_char(selected.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'operation_id',selected.operation_id,'ready',selected.ready) ORDER BY selected.created_at DESC,selected.id DESC),'[]'::jsonb),count(*) INTO result_rows,row_count FROM selected;
 PERFORM public.pim_dictionary_enlist(t,cid,u,k,h,role_name,false,NULL,NULL,NULL);
 RETURN jsonb_build_object('data',result_rows,'meta',jsonb_build_object('cursor',CASE WHEN row_count=50 THEN result_rows->49->>'id' ELSE NULL END,'limit',50));
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_read_preview(uuid,uuid,uuid,uuid,text,text,uuid),pim_dictionary_read_operation(uuid,uuid,uuid,uuid,text,text,uuid),pim_dictionary_history(uuid,uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC,dyna_app;

-- Source unit grants.sql SHA256 04fb6e28f5e09b12ecb4eedd3e13d7c080a14ee1bd301128f5376aa8cca6e2e9
-- Reviewed entrypoint-only application ACL, after all functions/closure exist.
-- No app generic table writes/reads or private hash/history-validator execute.
GRANT EXECUTE ON FUNCTION
 pim_dictionary_identity(uuid,uuid,uuid,text,text,boolean,boolean),
 pim_dictionary_begin(),
 pim_dictionary_enlist(uuid,uuid,uuid,uuid,text,text,boolean,jsonb,jsonb,timestamptz),
 pim_dictionary_prepare(),pim_dictionary_last_clock(),
 pim_dictionary_frame(uuid,uuid,boolean),pim_dictionary_product_frame(uuid,uuid,uuid,boolean),
 pim_dictionary_source(uuid,uuid,jsonb,boolean),
 pim_dictionary_row_errors(jsonb,jsonb),
 pim_dictionary_find_preview(uuid,uuid,uuid,uuid,text,text,jsonb),
 pim_dictionary_store_preview(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb),
 pim_dictionary_apply(uuid,uuid,uuid,uuid,text,text,uuid,jsonb),
 pim_dictionary_read_preview(uuid,uuid,uuid,uuid,text,text,uuid),
 pim_dictionary_read_operation(uuid,uuid,uuid,uuid,text,text,uuid),
 pim_dictionary_history(uuid,uuid,uuid,uuid,text,text,uuid,text)
 TO dyna_app;

-- Source unit root-manifest.sql SHA256 ce1ecb9ea22bbadd777b3f930dc83c92ab27f2b74180a0426029c6fba47da10d
-- Root staged metadata/seal. Execute AFTER complete closure/lifecycle and exact grants.
-- Not an installed migration. No predecessor function, ACL, or certificate is edited.
CREATE FUNCTION pim_dictionary_acl_metadata(items aclitem[]) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
 ORDER BY pg_get_userbyid(a.grantor)::text,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(items) a
$$;
CREATE FUNCTION pim_dictionary_function_metadata(function_oid oid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'language',l.lanname,
 'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'security_definer',p.prosecdef,'parallel',p.proparallel,'kind',p.prokind,'returns_set',p.proretset,
 'arguments',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),'argument_modes',p.proargmodes,'argument_names',p.proargnames,
 'defaults',pg_get_expr(p.proargdefaults,0),'configuration',p.proconfig,'cost',p.procost,'rows',p.prorows,
 'acl',public.pim_dictionary_acl_metadata(coalesce(p.proacl,acldefault('f',p.proowner)))) FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid
$$;
CREATE FUNCTION pim_dictionary_predecessor_metadata() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_object_agg(names.name,public.pim_dictionary_function_metadata(to_regprocedure('public.'||names.name||'()')::oid) ORDER BY names.name)
 FROM unnest(ARRAY['allegro_oauth_recovery_guards','b2b_credit_guards','b2b_invoice_guards','buyer_address_guards','catalog_stock_control_guards','catalog_stock_count_guards','catalog_stock_legacy_group_guards','catalog_stock_return_guards','competitor_observation_guards','credit_source_upgrade_valid','fa3_draft_guards','financial_return_guards','financial_return_upgrade_valid','label_print_guards','local_invoice_guards','manual_inventory_off_valid','operative_delivery_valid','packed_label_print_guards','parcel_physical_wz_valid','print_job_guards','product_rule_price_tags_guards','product_rule_schedule_guards','stocktake_adjustment_guards','warehouse_automatic_wz_guards','warehouse_wz_issuer_guards']::text[]) names(name)
$$;
CREATE FUNCTION pim_dictionary_metadata() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
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
  FROM pg_class c LEFT JOIN pg_am am ON am.oid=c.relam WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'pim_dictionary_') AND c.relkind IN('r','p','v','m','S','f')),
 'functions',(SELECT coalesce(jsonb_agg(public.pim_dictionary_function_metadata(p.oid) ORDER BY p.oid::regprocedure::text),'[]'::jsonb) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'pim_dictionary_')),
 'authority_roles',(WITH RECURSIVE reachable(role_oid) AS (
  SELECT r.oid FROM pg_roles r WHERE r.rolname='dyna_app' OR r.oid=(SELECT relowner FROM pg_class WHERE oid='public.pim_dictionary_manifest'::regclass)
  UNION SELECT membership.roleid FROM pg_auth_members membership JOIN reachable reachable_role ON reachable_role.role_oid=membership.member)
  SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(role_row)-'oid'-'rolpassword' ORDER BY role_row.rolname) FROM pg_roles role_row WHERE role_row.oid IN(SELECT role_oid FROM reachable)),
  'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),'member',pg_get_userbyid(m.member),'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY pg_get_userbyid(m.roleid)::text,pg_get_userbyid(m.member)::text,pg_get_userbyid(m.grantor)::text),'[]'::jsonb) FROM pg_auth_members m WHERE m.member IN(SELECT role_oid FROM reachable) OR m.roleid IN(SELECT role_oid FROM reachable)))),
 -- RI trigger names contain allocation OIDs. Capture exact semantic FK/function/flags,
 -- including the triggers added to existing parents, without generated names or OIDs.
 'ri',(SELECT coalesce(jsonb_agg(jsonb_build_object('relation',tr.tgrelid::regclass::text,'constraint_relation',con.conrelid::regclass::text,'constraint',con.conname,'definition',pg_get_constraintdef(con.oid,true),'type',tr.tgtype,'enabled',tr.tgenabled,'function',tr.tgfoid::regprocedure::text,'deferrable',tr.tgdeferrable,'deferred',tr.tginitdeferred) ORDER BY tr.tgrelid::regclass::text,con.conrelid::regclass::text,con.conname,tr.tgtype,tr.tgfoid::regprocedure::text),'[]'::jsonb)
 FROM pg_trigger tr JOIN pg_constraint con ON con.oid=tr.tgconstraint JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid WHERE tr.tgisinternal AND ((child.relnamespace='public'::regnamespace AND starts_with(child.relname,'pim_dictionary_')) OR(parent.relnamespace='public'::regnamespace AND starts_with(parent.relname,'pim_dictionary_'))))
 )
$$;
CREATE FUNCTION pim_dictionary_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$ SELECT public.pim_dictionary_hash(public.pim_dictionary_metadata()) $$;
CREATE FUNCTION pim_dictionary_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE stored public.pim_dictionary_manifest%ROWTYPE;predecessors_json jsonb;guard_name text;guard_ok boolean;
BEGIN
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
CREATE FUNCTION pim_dictionary_require() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN IF public.pim_dictionary_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Incomplete PIM metadata or predecessor lineage' USING ERRCODE='55000';END IF;END $$;
CREATE FUNCTION pim_dictionary_seal(expected_predecessors jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE guard_name text;guard_ok boolean;
BEGIN
 IF current_user IS DISTINCT FROM session_user OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.pim_dictionary_manifest'::regclass)
 OR EXISTS(SELECT FROM public.pim_dictionary_manifest) OR expected_predecessors IS DISTINCT FROM public.pim_dictionary_predecessor_metadata()
 OR jsonb_typeof(expected_predecessors) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(expected_predecessors))<>25 OR EXISTS(SELECT FROM jsonb_each(expected_predecessors) predecessor(name,body) WHERE body='null'::jsonb)
 THEN RAISE EXCEPTION 'PIM seal requires own native owner and complete unchanged predecessors' USING ERRCODE='55000';END IF;
 FOR guard_name IN SELECT key FROM jsonb_object_keys(expected_predecessors) keys(key) ORDER BY key LOOP EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'PIM predecessor guard failed' USING ERRCODE='55000';END IF;END LOOP;
 INSERT INTO public.pim_dictionary_manifest(singleton,fingerprint,predecessors,created_at) VALUES(true,public.pim_dictionary_fingerprint(),expected_predecessors,clock_timestamp());
 PERFORM public.pim_dictionary_require();
END $$;
REVOKE ALL ON FUNCTION pim_dictionary_acl_metadata(aclitem[]),pim_dictionary_function_metadata(oid),pim_dictionary_predecessor_metadata(),pim_dictionary_metadata(),pim_dictionary_fingerprint(),pim_dictionary_valid(),pim_dictionary_require(),pim_dictionary_seal(jsonb) FROM PUBLIC,dyna_app;

DO $pim170$
DECLARE before_json jsonb;after_json jsonb;
BEGIN
 SELECT value INTO STRICT before_json FROM pg_temp.dyna_pim_predecessor_capture;
 SELECT jsonb_object_agg(p.proname,jsonb_build_object('catalog_row',to_jsonb(p),'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname) INTO after_json FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.pronargs=0 AND p.proname=ANY(ARRAY['allegro_oauth_recovery_guards','b2b_credit_guards','b2b_invoice_guards','buyer_address_guards','catalog_stock_control_guards','catalog_stock_count_guards','catalog_stock_legacy_group_guards','catalog_stock_return_guards','competitor_observation_guards','credit_source_upgrade_valid','fa3_draft_guards','financial_return_guards','financial_return_upgrade_valid','label_print_guards','local_invoice_guards','manual_inventory_off_valid','operative_delivery_valid','packed_label_print_guards','parcel_physical_wz_valid','print_job_guards','product_rule_price_tags_guards','product_rule_schedule_guards','stocktake_adjustment_guards','warehouse_automatic_wz_guards','warehouse_wz_issuer_guards']::text[]);
 IF before_json IS DISTINCT FROM after_json OR (SELECT count(*) FROM jsonb_object_keys(before_json))<>25 THEN RAISE EXCEPTION 'PIM migration predecessor changed' USING ERRCODE='55000';END IF;
 PERFORM public.pim_dictionary_seal(public.pim_dictionary_predecessor_metadata());
END $pim170$;
DROP TABLE pg_temp.dyna_pim_predecessor_capture;
