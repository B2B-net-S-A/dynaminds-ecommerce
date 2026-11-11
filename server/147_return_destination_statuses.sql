-- Versioned configuration only. No historical assistant, RMA or inventory rewrite.
-- Extend the existing nineteen-scope developer key contract additively. Existing
-- keys retain their exact scope arrays; no grant is added to any historical key.
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check1;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK(cardinality(scopes)>=1 AND cardinality(scopes)<=20);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check1 CHECK(scopes <@ ARRAY[
 'orders:read','orders:write','products:read','products:write','inventory:read','inventory:write',
 'documents:read','documents:write','purchasing:read','purchasing:write','automations:read','automations:write',
 'communications:read','communications:write','order-fields:read','order-fields:write','order-fields:admin',
 'integrations:read','integrations:write','returns:configure']::text[]);

CREATE FUNCTION return_destination_status_hash(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex')
$$;

CREATE FUNCTION return_destination_status_settings_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object'
 OR value-ARRAY['name','color','active','decision','inventory_effect','warehouse_id','warehouse_policy_version','default_location']<>'{}'
 OR NOT value ?& ARRAY['name','color','active','decision','inventory_effect','warehouse_id','warehouse_policy_version','default_location']
 OR jsonb_typeof(value->'name') IS DISTINCT FROM 'string' OR length(value->>'name') NOT BETWEEN 2 AND 120
 OR value->>'name'<>btrim(value->>'name') OR value->>'name' ~ '[[:cntrl:]]'
 OR jsonb_typeof(value->'color') IS DISTINCT FROM 'string' OR value->>'color' !~ '^#[0-9a-f]{6}$'
 OR jsonb_typeof(value->'active') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(value->'decision') IS DISTINCT FROM 'string'
 OR jsonb_typeof(value->'inventory_effect') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 IF value->>'decision'='reject' THEN
  RETURN value->>'inventory_effect'='none' AND value->'warehouse_id'='null'::jsonb
   AND value->'warehouse_policy_version'='null'::jsonb AND value->'default_location'='null'::jsonb;
 END IF;
 IF value->>'decision' IS DISTINCT FROM 'accept' OR coalesce(value->>'inventory_effect','') NOT IN('sale','custody')
 OR jsonb_typeof(value->'warehouse_id') IS DISTINCT FROM 'string'
 OR coalesce(value->>'warehouse_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR jsonb_typeof(value->'warehouse_policy_version') IS DISTINCT FROM 'string'
 OR coalesce(value->>'warehouse_policy_version','') !~ '^(0|[1-9][0-9]{0,18})$'
 OR jsonb_typeof(value->'default_location') IS DISTINCT FROM 'string'
 OR length(value->>'default_location') NOT BETWEEN 1 AND 80
 OR value->>'default_location'<>btrim(value->>'default_location') OR value->>'default_location' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
 RETURN (value->>'warehouse_policy_version')::numeric<=9223372036854775807;
END $$;

CREATE TABLE return_destination_statuses (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants,
 version bigint NOT NULL CHECK(version>0), revision_id uuid NOT NULL,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,version,revision_id)
);
CREATE TABLE return_destination_status_previews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants,
 actor_id uuid NOT NULL REFERENCES users, api_key_id uuid, client_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('create','update')), status_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '900 seconds'),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,status_id), UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE return_destination_status_operations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants,
 preview_id uuid NOT NULL, status_id uuid NOT NULL, revision_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users, api_key_id uuid, client_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('create','update')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,status_id,revision_id),
 UNIQUE(tenant_id,client_key), UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,status_id) REFERENCES return_destination_status_previews(tenant_id,id,status_id),
 FOREIGN KEY(tenant_id,status_id) REFERENCES return_destination_statuses(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE return_destination_status_revisions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants,
 status_id uuid NOT NULL, version bigint NOT NULL CHECK(version>0),
 operation_id uuid NOT NULL, settings jsonb NOT NULL CHECK(coalesce(return_destination_status_settings_valid(settings),false)),
 warehouse_id uuid GENERATED ALWAYS AS ((settings->>'warehouse_id')::uuid) STORED,
 warehouse_snapshot jsonb NOT NULL CHECK(jsonb_typeof(warehouse_snapshot) IN('object','null')),
 created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,status_id,id), UNIQUE(tenant_id,status_id,version), UNIQUE(tenant_id,status_id,version,id),
 FOREIGN KEY(tenant_id,status_id) REFERENCES return_destination_statuses(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id,status_id,id) REFERENCES return_destination_status_operations(tenant_id,id,status_id,revision_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE return_destination_statuses ADD CONSTRAINT return_destination_status_current_revision
 FOREIGN KEY(tenant_id,id,version,revision_id) REFERENCES return_destination_status_revisions(tenant_id,status_id,version,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE return_destination_status_operations ADD CONSTRAINT return_destination_status_operation_revision
 FOREIGN KEY(tenant_id,status_id,revision_id) REFERENCES return_destination_status_revisions(tenant_id,status_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE return_destination_status_admissions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants,
 operation_id uuid NOT NULL, preview_id uuid NOT NULL, status_id uuid NOT NULL, revision_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users, api_key_id uuid,
 txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 before_row jsonb NOT NULL, after_row jsonb NOT NULL CHECK(jsonb_typeof(after_row)='object'),
 revision jsonb NOT NULL CHECK(jsonb_typeof(revision)='object'),
 operation jsonb NOT NULL CHECK(jsonb_typeof(operation)='object'), created_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,preview_id,status_id) REFERENCES return_destination_status_previews(tenant_id,id,status_id),
 FOREIGN KEY(tenant_id,operation_id,status_id,revision_id) REFERENCES return_destination_status_operations(tenant_id,id,status_id,revision_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX return_destination_status_preview_page ON return_destination_status_previews(tenant_id,id);
CREATE INDEX return_destination_status_operation_page ON return_destination_status_operations(tenant_id,status_id,id);

DO $$ DECLARE relation_name text; BEGIN
 FOREACH relation_name IN ARRAY ARRAY['return_destination_statuses','return_destination_status_revisions','return_destination_status_previews','return_destination_status_operations','return_destination_status_admissions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',relation_name);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',relation_name);
 END LOOP;
END $$;

CREATE FUNCTION return_destination_status_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE admission public.return_destination_status_admissions; new_row jsonb; old_row jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Historia statusu zwrotu jest niezmienna' USING ERRCODE='23514'; END IF;
 new_row:=to_jsonb(NEW);
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME<>'return_destination_statuses' THEN RAISE EXCEPTION 'Historia statusu zwrotu jest niezmienna' USING ERRCODE='23514'; END IF;
  old_row:=to_jsonb(OLD);
 END IF;
 IF TG_TABLE_NAME='return_destination_statuses' THEN
  SELECT * INTO admission FROM return_destination_status_admissions WHERE tenant_id=(new_row->>'tenant_id')::uuid
   AND status_id=(new_row->>'id')::uuid AND revision_id=(new_row->>'revision_id')::uuid AND txid=pg_current_xact_id();
  IF admission.id IS NULL OR new_row IS DISTINCT FROM admission.after_row
  OR(TG_OP='INSERT' AND admission.before_row<>'null'::jsonb)
  OR(TG_OP='UPDATE' AND old_row IS DISTINCT FROM admission.before_row)
  THEN RAISE EXCEPTION 'Zmiana statusu wymaga dokładnej bieżącej zgody' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME IN('return_destination_status_revisions','return_destination_status_operations') THEN
  SELECT * INTO admission FROM return_destination_status_admissions WHERE tenant_id=(new_row->>'tenant_id')::uuid
   AND txid=pg_current_xact_id() AND CASE WHEN TG_TABLE_NAME='return_destination_status_revisions'
    THEN revision_id=(new_row->>'id')::uuid ELSE operation_id=(new_row->>'id')::uuid END;
  -- Stored generated warehouse_id is computed after BEFORE triggers; the
  -- deferred complete check compares its final value independently.
  IF admission.id IS NULL OR (CASE WHEN TG_TABLE_NAME='return_destination_status_revisions'
   THEN new_row-'warehouse_id' IS DISTINCT FROM admission.revision-'warehouse_id'
   ELSE new_row IS DISTINCT FROM admission.operation END)
  THEN RAISE EXCEPTION 'Historia statusu nie odpowiada bieżącej zgodzie' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION return_destination_status_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row_value jsonb:=to_jsonb(NEW); admission public.return_destination_status_admissions;
 saved_operation public.return_destination_status_operations; saved_preview public.return_destination_status_previews;
 saved_revision public.return_destination_status_revisions; saved_head public.return_destination_statuses;
BEGIN
 SELECT * INTO admission FROM return_destination_status_admissions
 WHERE tenant_id=(row_value->>'tenant_id')::uuid AND operation_id=CASE WHEN TG_TABLE_NAME='return_destination_status_operations' THEN(row_value->>'id')::uuid ELSE(row_value->>'operation_id')::uuid END;
 IF admission.id IS NULL OR admission.txid<>pg_current_xact_id() THEN RAISE EXCEPTION 'Brak świeżej zgody statusu zwrotu' USING ERRCODE='23514'; END IF;
 PERFORM public.return_destination_status_require(admission.actor_id,admission.api_key_id,true,false);
 SELECT * INTO saved_operation FROM return_destination_status_operations WHERE(tenant_id,id)=(admission.tenant_id,admission.operation_id);
 SELECT * INTO saved_preview FROM return_destination_status_previews WHERE(tenant_id,id)=(admission.tenant_id,admission.preview_id);
 SELECT * INTO saved_revision FROM return_destination_status_revisions WHERE(tenant_id,id)=(admission.tenant_id,admission.revision_id);
 SELECT * INTO saved_head FROM return_destination_statuses WHERE(tenant_id,id)=(admission.tenant_id,admission.status_id);
 IF to_jsonb(saved_operation) IS DISTINCT FROM admission.operation OR to_jsonb(saved_revision) IS DISTINCT FROM admission.revision
 OR to_jsonb(saved_head) IS DISTINCT FROM admission.after_row OR saved_preview.id IS NULL
 OR(saved_preview.actor_id,saved_preview.api_key_id,saved_preview.status_id) IS DISTINCT FROM(admission.actor_id,admission.api_key_id,admission.status_id)
 OR saved_operation.request->>'scope_hash' IS DISTINCT FROM saved_preview.scope_hash
 OR saved_operation.request_hash IS DISTINCT FROM public.return_destination_status_hash(jsonb_build_object('tenant',admission.tenant_id,'actor',admission.actor_id,'key',admission.api_key_id,'preview_id',saved_preview.id,'request',saved_operation.request))
 OR saved_preview.scope_hash IS DISTINCT FROM public.return_destination_status_hash(saved_preview.payload)
 OR saved_operation.payload->'before' IS DISTINCT FROM saved_preview.payload->'before'
 OR saved_operation.payload->'after'->'settings' IS DISTINCT FROM saved_preview.payload->'after'->'settings'
 OR saved_operation.payload->'after'->>'version' IS DISTINCT FROM saved_preview.payload->'after'->>'version'
 THEN RAISE EXCEPTION 'Niekompletny zapis statusu zwrotu' USING ERRCODE='23514'; END IF;
 PERFORM public.return_destination_status_budget(admission.tenant_id);
 RETURN NEW;
END $$;

CREATE FUNCTION return_destination_status_resource_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE before_value jsonb:='null'; after_value jsonb:='null';
BEGIN
 IF TG_OP<>'INSERT' THEN before_value:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN after_value:=to_jsonb(NEW); END IF;
 IF EXISTS(SELECT 1 FROM return_destination_status_admissions a JOIN return_destination_status_operations o
  ON(o.tenant_id,o.id)=(a.tenant_id,a.operation_id)
  WHERE a.txid=pg_current_xact_id() AND a.tenant_id::text IN(before_value->>'tenant_id',after_value->>'tenant_id')
  AND a.revision->'warehouse_snapshot'->>'id' IN(
   CASE WHEN TG_TABLE_NAME='warehouses' THEN before_value->>'id' ELSE before_value->>'warehouse_id' END,
   CASE WHEN TG_TABLE_NAME='warehouses' THEN after_value->>'id' ELSE after_value->>'warehouse_id' END))
 THEN RAISE EXCEPTION 'Zasoby zatwierdzonego statusu są zamknięte' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

DO $$ DECLARE relation_name text; BEGIN
 FOREACH relation_name IN ARRAY ARRAY['return_destination_statuses','return_destination_status_revisions','return_destination_status_previews','return_destination_status_operations','return_destination_status_admissions'] LOOP
  EXECUTE format('CREATE TRIGGER return_destination_status_row_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION return_destination_status_row_guard()',relation_name);
 END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER return_destination_status_operation_complete AFTER INSERT ON return_destination_status_operations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_destination_status_complete();
CREATE CONSTRAINT TRIGGER return_destination_status_admission_complete AFTER INSERT ON return_destination_status_admissions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_destination_status_complete();
CREATE TRIGGER return_destination_status_resource_seal BEFORE INSERT OR UPDATE OR DELETE ON warehouses
 FOR EACH ROW EXECUTE FUNCTION return_destination_status_resource_seal();
CREATE TRIGGER return_destination_status_resource_seal BEFORE INSERT OR UPDATE OR DELETE ON warehouse_inventory_policies
 FOR EACH ROW EXECUTE FUNCTION return_destination_status_resource_seal();

CREATE FUNCTION return_destination_status_guards() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE relation_name text; signature text; function_oid oid; function_record record;
 expected_columns text[]; actual_columns text[]; trigger_count integer; fk record;
BEGIN
 -- New statuses depend on the exact current146 policy semantics; an absent or
 -- torn146 must never manufacture an implicit default policy.
 IF to_regprocedure('public.warehouse_inventory_policy_lock(uuid,uuid)') IS NULL
 OR to_regprocedure('public.warehouse_inventory_policy(uuid,uuid)') IS NULL
 OR to_regprocedure('public.warehouse_inventory_policy_guards()') IS NULL THEN RETURN false; END IF;
 IF NOT public.warehouse_inventory_policy_guards() THEN RETURN false; END IF;
 FOR relation_name,expected_columns IN SELECT * FROM(VALUES
  ('return_destination_statuses',ARRAY['id','tenant_id','version','revision_id','created_at','updated_at']),
  ('return_destination_status_revisions',ARRAY['id','tenant_id','status_id','version','operation_id','settings','warehouse_id','warehouse_snapshot','created_at']),
  ('return_destination_status_previews',ARRAY['id','tenant_id','actor_id','api_key_id','client_key','kind','status_id','request_hash','scope_hash','request','payload','created_at','expires_at']),
  ('return_destination_status_operations',ARRAY['id','tenant_id','preview_id','status_id','revision_id','actor_id','api_key_id','client_key','kind','request_hash','request','payload','created_at']),
  ('return_destination_status_admissions',ARRAY['id','tenant_id','operation_id','preview_id','status_id','revision_id','actor_id','api_key_id','txid','before_row','after_row','revision','operation','created_at'])
 ) entries(name,columns) LOOP
  IF to_regclass('public.'||relation_name) IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||relation_name) AND relkind='r' AND relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)=session_user)
  OR(SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('public.'||relation_name))<>1
  OR NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.'||relation_name) AND polname='tenant_scope' AND polcmd='*' AND polqual IS NOT NULL AND polwithcheck IS NOT NULL)
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) privilege WHERE c.oid=to_regclass('public.'||relation_name) AND privilege.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) privilege WHERE c.oid=to_regclass('public.'||relation_name) AND privilege.grantee<>c.relowner)
  THEN RETURN false; END IF;
  SELECT array_agg(attname::text ORDER BY attnum) INTO actual_columns FROM pg_attribute WHERE attrelid=to_regclass('public.'||relation_name) AND attnum>0 AND NOT attisdropped;
  IF actual_columns IS DISTINCT FROM expected_columns THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||relation_name) AND attnum>0 AND NOT attisdropped AND attname NOT IN('api_key_id','warehouse_id') AND NOT attnotnull) THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.'||relation_name) AND contype='p' AND convalidated) THEN RETURN false; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY['return_destination_statuses'::regclass,'return_destination_status_revisions'::regclass,'return_destination_status_previews'::regclass,'return_destination_status_operations'::regclass,'return_destination_status_admissions'::regclass]) AND NOT convalidated)
 OR(SELECT count(*) FROM pg_constraint WHERE conrelid=ANY(ARRAY['return_destination_statuses'::regclass,'return_destination_status_revisions'::regclass,'return_destination_status_previews'::regclass,'return_destination_status_operations'::regclass,'return_destination_status_admissions'::regclass]) AND contype='f')<>20
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='return_destination_status_current_revision' AND conrelid='return_destination_statuses'::regclass AND confrelid='return_destination_status_revisions'::regclass AND condeferrable AND condeferred)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='return_destination_status_operation_revision' AND conrelid='return_destination_status_operations'::regclass AND confrelid='return_destination_status_revisions'::regclass AND condeferrable AND condeferred) THEN RETURN false; END IF;
 FOR fk IN SELECT * FROM(VALUES
  ('return_destination_statuses','tenant_id','tenants','id',false),
  ('return_destination_statuses','tenant_id,id,version,revision_id','return_destination_status_revisions','tenant_id,status_id,version,id',true),
  ('return_destination_status_previews','tenant_id','tenants','id',false),
  ('return_destination_status_previews','actor_id','users','id',false),
  ('return_destination_status_previews','tenant_id,api_key_id','api_keys','tenant_id,id',false),
  ('return_destination_status_operations','tenant_id','tenants','id',false),
  ('return_destination_status_operations','actor_id','users','id',false),
  ('return_destination_status_operations','tenant_id,preview_id,status_id','return_destination_status_previews','tenant_id,id,status_id',false),
  ('return_destination_status_operations','tenant_id,status_id','return_destination_statuses','tenant_id,id',true),
  ('return_destination_status_operations','tenant_id,api_key_id','api_keys','tenant_id,id',false),
  ('return_destination_status_operations','tenant_id,status_id,revision_id','return_destination_status_revisions','tenant_id,status_id,id',true),
  ('return_destination_status_revisions','tenant_id','tenants','id',false),
  ('return_destination_status_revisions','tenant_id,status_id','return_destination_statuses','tenant_id,id',true),
  ('return_destination_status_revisions','tenant_id,warehouse_id','warehouses','tenant_id,id',false),
  ('return_destination_status_revisions','tenant_id,operation_id,status_id,id','return_destination_status_operations','tenant_id,id,status_id,revision_id',true),
  ('return_destination_status_admissions','tenant_id','tenants','id',false),
  ('return_destination_status_admissions','actor_id','users','id',false),
  ('return_destination_status_admissions','tenant_id,preview_id,status_id','return_destination_status_previews','tenant_id,id,status_id',false),
  ('return_destination_status_admissions','tenant_id,operation_id,status_id,revision_id','return_destination_status_operations','tenant_id,id,status_id,revision_id',true),
  ('return_destination_status_admissions','tenant_id,api_key_id','api_keys','tenant_id,id',false)
 ) manifest(source_table,source_columns,target_table,target_columns,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid=to_regclass('public.'||fk.source_table)
   AND c.confrelid=to_regclass('public.'||fk.target_table) AND c.convalidated AND c.condeferrable=fk.deferred AND c.condeferred=fk.deferred
   AND(SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(num,ordinality) JOIN pg_attribute a ON(a.attrelid,a.attnum)=(c.conrelid,k.num))=fk.source_columns
   AND(SELECT string_agg(a.attname,',' ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(num,ordinality) JOIN pg_attribute a ON(a.attrelid,a.attnum)=(c.confrelid,k.num))=fk.target_columns)
  THEN RETURN false; END IF;
 END LOOP;
 IF(SELECT count(*) FROM pg_constraint WHERE conrelid=ANY(ARRAY['return_destination_statuses'::regclass,'return_destination_status_revisions'::regclass,'return_destination_status_previews'::regclass,'return_destination_status_operations'::regclass,'return_destination_status_admissions'::regclass]) AND contype='c')<>17
 OR(SELECT count(*) FROM pg_constraint WHERE conrelid=ANY(ARRAY['return_destination_statuses'::regclass,'return_destination_status_revisions'::regclass,'return_destination_status_previews'::regclass,'return_destination_status_operations'::regclass,'return_destination_status_admissions'::regclass]) AND contype='u')<>15
 OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='return_destination_status_revisions'::regclass AND attname='warehouse_id' AND attgenerated='s') THEN RETURN false; END IF;
 FOREACH signature IN ARRAY ARRAY['return_destination_status_hash(jsonb)','return_destination_status_settings_valid(jsonb)','return_destination_status_installed()',
  'return_destination_status_access(uuid,uuid,boolean,boolean)','return_destination_status_require(uuid,uuid,boolean,boolean)',
  'return_destination_status_lock()','return_destination_status_budget(uuid)','return_destination_status_head(uuid)',
  'return_destination_status_request_valid(jsonb)','return_destination_status_frame(jsonb,uuid)',
  'return_destination_status_preview(uuid,uuid,jsonb)','return_destination_status_commit(uuid,uuid,uuid,jsonb)',
  'return_destination_status_row_guard()','return_destination_status_complete()','return_destination_status_resource_seal()','return_destination_status_guards()'] LOOP
  function_oid:=to_regprocedure('public.'||signature);
  SELECT * INTO function_record FROM pg_proc WHERE oid=function_oid;
  IF function_oid IS NULL OR pg_get_userbyid(function_record.proowner) IS DISTINCT FROM session_user
  OR(signature NOT IN('return_destination_status_hash(jsonb)','return_destination_status_settings_valid(jsonb)','return_destination_status_installed()','return_destination_status_request_valid(jsonb)') AND NOT function_record.prosecdef)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(function_record.proacl,acldefault('f',function_record.proowner))) privilege WHERE privilege.grantee<>function_record.proowner) THEN RETURN false; END IF;
 END LOOP;
 SELECT count(*) INTO trigger_count FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (
  (tgname='return_destination_status_row_guard' AND tgfoid='return_destination_status_row_guard()'::regprocedure AND tgtype=31 AND tgrelid=ANY(ARRAY['return_destination_statuses'::regclass,'return_destination_status_revisions'::regclass,'return_destination_status_previews'::regclass,'return_destination_status_operations'::regclass,'return_destination_status_admissions'::regclass]))
  OR(tgname IN('return_destination_status_operation_complete','return_destination_status_admission_complete') AND tgfoid='return_destination_status_complete()'::regprocedure AND tgtype=5 AND tgdeferrable AND tginitdeferred AND tgrelid=ANY(ARRAY['return_destination_status_operations'::regclass,'return_destination_status_admissions'::regclass]))
  OR(tgname='return_destination_status_resource_seal' AND tgfoid='return_destination_status_resource_seal()'::regprocedure AND tgtype=31 AND tgrelid=ANY(ARRAY['warehouses'::regclass,'warehouse_inventory_policies'::regclass])));
 RETURN trigger_count=9;
END $$;

DO $$ DECLARE function_record record; BEGIN
 FOR function_record IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'return_destination_status_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',function_record.signature);
 END LOOP;
END $$;

CREATE FUNCTION return_destination_status_installed() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;

CREATE FUNCTION return_destination_status_access(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 member_role text; api_key public.api_keys; can_read boolean:=true; can_manage boolean:=true;
BEGIN
 IF pin THEN SELECT role INTO member_role FROM memberships WHERE(tenant_id,user_id)=(tenant,uid) FOR SHARE;
 ELSE SELECT role INTO member_role FROM memberships WHERE(tenant_id,user_id)=(tenant,uid); END IF;
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO api_key FROM api_keys WHERE(tenant_id,id,user_id)=(tenant,kid,uid) FOR SHARE;
  ELSE SELECT * INTO api_key FROM api_keys WHERE(tenant_id,id,user_id)=(tenant,kid,uid); END IF;
  IF api_key.id IS NULL OR api_key.revoked_at IS NOT NULL OR(api_key.expires_at IS NOT NULL AND api_key.expires_at<=clock_timestamp())
  THEN RAISE EXCEPTION 'Klucz statusów zwrotu jest nieaktualny' USING ERRCODE='28000'; END IF;
  can_read:='orders:read'=ANY(api_key.scopes) AND 'inventory:read'=ANY(api_key.scopes);
  can_manage:=can_read AND 'returns:configure'=ANY(api_key.scopes);
 END IF;
 can_read:=coalesce(can_read AND member_role IN('admin','operator','viewer'),false);
 can_manage:=coalesce(can_manage AND member_role='admin',false);
 IF NOT can_read OR(writing AND NOT can_manage) THEN RAISE EXCEPTION 'Brak aktualnego uprawnienia statusów zwrotu' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('current_role',member_role,'can_read',can_read,'can_manage',can_manage);
END $$;

CREATE FUNCTION return_destination_status_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT public.return_destination_status_guards() THEN RAISE EXCEPTION 'Niekompletna konfiguracja statusów zwrotu' USING ERRCODE='55000'; END IF;
 RETURN public.return_destination_status_access(uid,kid,writing,pin);
END $$;

CREATE FUNCTION return_destination_status_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF tenant IS NULL THEN RAISE EXCEPTION 'Brak firmy statusów zwrotu' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('return.destination.status.quota:'||tenant::text,0));
END $$;

CREATE FUNCTION return_destination_status_budget(tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE retained numeric;
BEGIN
 IF(SELECT count(*) FROM return_destination_statuses s JOIN return_destination_status_revisions r ON(r.tenant_id,r.id)=(s.tenant_id,s.revision_id) WHERE s.tenant_id=tenant AND r.settings->'active'='true')>100
 OR(SELECT count(*) FROM return_destination_status_revisions WHERE tenant_id=tenant)>2000
 OR(SELECT count(*) FROM return_destination_status_previews WHERE tenant_id=tenant)>2000
 OR(SELECT count(*) FROM return_destination_status_operations WHERE tenant_id=tenant)>2000
 OR(SELECT count(*) FROM return_destination_status_admissions WHERE tenant_id=tenant)>2000
 THEN RAISE EXCEPTION 'Limit historii statusów zwrotu' USING ERRCODE='54000'; END IF;
 SELECT coalesce(sum(bytes),0) INTO retained FROM (
  SELECT pg_column_size(s) bytes FROM return_destination_statuses s WHERE tenant_id=tenant
  UNION ALL SELECT pg_column_size(r) FROM return_destination_status_revisions r WHERE tenant_id=tenant
  UNION ALL SELECT pg_column_size(p) FROM return_destination_status_previews p WHERE tenant_id=tenant
  UNION ALL SELECT pg_column_size(o) FROM return_destination_status_operations o WHERE tenant_id=tenant
  UNION ALL SELECT pg_column_size(a) FROM return_destination_status_admissions a WHERE tenant_id=tenant
 ) sizes;
 IF retained>67108864 THEN RAISE EXCEPTION 'Limit pamięci statusów zwrotu' USING ERRCODE='54000'; END IF;
END $$;

CREATE FUNCTION return_destination_status_head(sid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',s.id,'version',s.version::text,'revision_id',s.revision_id,
 'settings',r.settings,'created_at',s.created_at,'updated_at',s.updated_at)
 FROM return_destination_statuses s JOIN return_destination_status_revisions r
 ON(r.tenant_id,r.status_id,r.id)=(s.tenant_id,s.id,s.revision_id)
 WHERE s.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND s.id=sid
$$;

CREATE FUNCTION return_destination_status_request_valid(body jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR coalesce(body->>'kind','') NOT IN('create','update')
 OR jsonb_typeof(body->'client_key') IS DISTINCT FROM 'string'
 OR coalesce(body->>'client_key','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR NOT coalesce(public.return_destination_status_settings_valid(body->'settings'),false) THEN RETURN false; END IF;
 IF body->>'kind'='create' THEN RETURN body-ARRAY['client_key','kind','settings']='{}'; END IF;
 IF body-ARRAY['client_key','kind','settings','status_id','version']<>'{}'
 OR jsonb_typeof(body->'status_id') IS DISTINCT FROM 'string'
 OR coalesce(body->>'status_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR jsonb_typeof(body->'version') IS DISTINCT FROM 'string'
 OR coalesce(body->>'version','') !~ '^[1-9][0-9]{0,18}$' THEN RETURN false; END IF;
 RETURN(body->>'version')::numeric<9223372036854775807;
END $$;

CREATE FUNCTION return_destination_status_frame(body jsonb,sid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 settings_value jsonb:=body->'settings'; before_head jsonb; target public.warehouses; policy jsonb; resource jsonb:='null';
 next_version bigint:=1;
BEGIN
 IF NOT coalesce(public.return_destination_status_request_valid(body),false) THEN RAISE EXCEPTION 'Nieprawidłowy podgląd statusu zwrotu' USING ERRCODE='23514'; END IF;
 -- Policy146 holds catalog SHARED and warehouse/policy SHARE until COMMIT,
 -- including implicit default version0. Acquire them before the status row.
 IF settings_value->>'decision'='accept' THEN
  policy:=public.warehouse_inventory_policy_lock(tenant,(settings_value->>'warehouse_id')::uuid);
  SELECT * INTO target FROM warehouses WHERE(tenant_id,id)=(tenant,(settings_value->>'warehouse_id')::uuid);
  IF target.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego magazynu statusu' USING ERRCODE='P0002'; END IF;
  IF policy IS NULL OR policy->>'usage' IS DISTINCT FROM settings_value->>'inventory_effect'
  OR policy->'enabled' IS DISTINCT FROM 'true'::jsonb OR policy->>'version' IS DISTINCT FROM settings_value->>'warehouse_policy_version'
  THEN RAISE EXCEPTION 'Polityka magazynu statusu zmieniła się lub nie odpowiada celowi' USING ERRCODE='23514'; END IF;
  resource:=jsonb_build_object('id',target.id,'name',target.name,'code',target.code,'policy',policy);
 END IF;
 IF body->>'kind'='update' THEN
  PERFORM 1 FROM return_destination_statuses WHERE(tenant_id,id)=(tenant,sid) FOR UPDATE;
  before_head:=public.return_destination_status_head(sid);
  IF before_head IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego statusu zwrotu' USING ERRCODE='P0002'; END IF;
  IF before_head->>'version' IS DISTINCT FROM body->>'version' THEN RAISE EXCEPTION 'Status zwrotu zmienił wersję' USING ERRCODE='23514'; END IF;
  next_version:=(before_head->>'version')::bigint+1;
 ELSE
  IF EXISTS(SELECT 1 FROM return_destination_statuses WHERE(tenant_id,id)=(tenant,sid)) THEN RAISE EXCEPTION 'Identyfikator statusu jest już użyty' USING ERRCODE='23514'; END IF;
 END IF;
 IF settings_value->'active'='true'::jsonb AND coalesce(before_head->'settings'->'active','false')<>'true'::jsonb
 AND(SELECT count(*) FROM return_destination_statuses s JOIN return_destination_status_revisions r ON(r.tenant_id,r.id)=(s.tenant_id,s.revision_id) WHERE s.tenant_id=tenant AND r.settings->'active'='true')>=100
 THEN RAISE EXCEPTION 'Limit aktywnych statusów zwrotu' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('before',before_head,'after',jsonb_build_object('id',sid,'version',next_version::text,'settings',settings_value),'resources',jsonb_build_object('warehouse',resource));
END $$;

CREATE FUNCTION return_destination_status_preview(uid uuid,kid uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 saved public.return_destination_status_previews; request_digest text; frame_value jsonb;
 status_identity uuid; stamp timestamptz:=clock_timestamp();
BEGIN
 PERFORM public.return_destination_status_require(uid,kid,true,false);
 PERFORM public.return_destination_status_lock();
 IF NOT coalesce(public.return_destination_status_request_valid(body),false) THEN RAISE EXCEPTION 'Nieprawidłowy podgląd statusu zwrotu' USING ERRCODE='23514'; END IF;
 request_digest:=public.return_destination_status_hash(jsonb_build_object('tenant',tenant,'actor',uid,'key',kid,'request',body));
 SELECT * INTO saved FROM return_destination_status_previews WHERE tenant_id=tenant AND client_key=(body->>'client_key')::uuid;
 IF saved.id IS NOT NULL THEN
  IF saved.actor_id IS DISTINCT FROM uid OR saved.api_key_id IS DISTINCT FROM kid OR saved.request_hash IS DISTINCT FROM request_digest
  THEN RAISE EXCEPTION 'Klucz podglądu statusu ma inną treść lub właściciela' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('preview',to_jsonb(saved),'reused',true);
 END IF;
 status_identity:=CASE WHEN body->>'kind'='create' THEN gen_random_uuid() ELSE(body->>'status_id')::uuid END;
 frame_value:=public.return_destination_status_frame(body,status_identity);
 INSERT INTO return_destination_status_previews(id,tenant_id,actor_id,api_key_id,client_key,kind,status_id,request_hash,scope_hash,request,payload,created_at,expires_at)
 VALUES(gen_random_uuid(),tenant,uid,kid,(body->>'client_key')::uuid,body->>'kind',status_identity,request_digest,public.return_destination_status_hash(frame_value),body,frame_value,stamp,stamp+interval '900 seconds') RETURNING * INTO saved;
 PERFORM public.return_destination_status_budget(tenant);
 RETURN jsonb_build_object('preview',to_jsonb(saved),'reused',false);
END $$;

CREATE FUNCTION return_destination_status_commit(uid uuid,kid uuid,pid uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 saved public.return_destination_status_operations; preview_row public.return_destination_status_previews;
 prior_status public.return_destination_statuses; head_row public.return_destination_statuses;
 revision_row public.return_destination_status_revisions;
 request_digest text; frame_value jsonb; operation_identity uuid:=gen_random_uuid(); revision_identity uuid:=gen_random_uuid();
 stamp timestamptz:=clock_timestamp(); after_head jsonb; before_raw jsonb:='null'; after_raw jsonb; revision_raw jsonb; operation_raw jsonb;
BEGIN
 PERFORM public.return_destination_status_require(uid,kid,true,false);
 PERFORM public.return_destination_status_lock();
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR body-ARRAY['client_key','scope_hash','confirmed']<>'{}'
 OR body->'confirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(body->'client_key') IS DISTINCT FROM 'string'
 OR coalesce(body->>'client_key','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR jsonb_typeof(body->'scope_hash') IS DISTINCT FROM 'string' OR coalesce(body->>'scope_hash','') !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Nieprawidłowa zgoda statusu zwrotu' USING ERRCODE='23514'; END IF;
 request_digest:=public.return_destination_status_hash(jsonb_build_object('tenant',tenant,'actor',uid,'key',kid,'preview_id',pid,'request',body));
 SELECT * INTO saved FROM return_destination_status_operations WHERE tenant_id=tenant AND client_key=(body->>'client_key')::uuid;
 IF saved.id IS NOT NULL THEN
  IF saved.actor_id IS DISTINCT FROM uid OR saved.api_key_id IS DISTINCT FROM kid OR saved.preview_id IS DISTINCT FROM pid OR saved.request_hash IS DISTINCT FROM request_digest
  THEN RAISE EXCEPTION 'Klucz zapisu statusu ma inną treść lub właściciela' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('operation',to_jsonb(saved),'reused',true);
 END IF;
 SELECT * INTO preview_row FROM return_destination_status_previews WHERE(tenant_id,id)=(tenant,pid) FOR SHARE;
 IF preview_row.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego podglądu statusu' USING ERRCODE='P0002'; END IF;
 IF preview_row.actor_id IS DISTINCT FROM uid OR preview_row.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Podgląd statusu należy do innego principala' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM return_destination_status_operations WHERE(tenant_id,preview_id)=(tenant,pid)) THEN RAISE EXCEPTION 'Podgląd statusu został już zapisany innym kluczem' USING ERRCODE='23514'; END IF;
 IF preview_row.expires_at<=clock_timestamp() OR preview_row.scope_hash IS DISTINCT FROM body->>'scope_hash' THEN RAISE EXCEPTION 'Podgląd statusu wygasł lub zakres jest inny' USING ERRCODE='23514'; END IF;
 frame_value:=public.return_destination_status_frame(preview_row.request,preview_row.status_id);
 IF frame_value IS DISTINCT FROM preview_row.payload THEN RAISE EXCEPTION 'Zakres podglądu statusu zmienił się' USING ERRCODE='23514'; END IF;
 SELECT * INTO prior_status FROM return_destination_statuses WHERE(tenant_id,id)=(tenant,preview_row.status_id);
 IF prior_status.id IS NOT NULL THEN before_raw:=to_jsonb(prior_status); END IF;
 after_raw:=jsonb_build_object('id',preview_row.status_id,'tenant_id',tenant,'version',(frame_value->'after'->>'version')::bigint,
  'revision_id',revision_identity,'created_at',coalesce(prior_status.created_at,stamp),'updated_at',stamp);
 revision_raw:=jsonb_build_object('id',revision_identity,'tenant_id',tenant,'status_id',preview_row.status_id,
  'version',(frame_value->'after'->>'version')::bigint,'operation_id',operation_identity,'settings',frame_value->'after'->'settings',
  'warehouse_id',frame_value->'after'->'settings'->'warehouse_id','warehouse_snapshot',frame_value->'resources'->'warehouse','created_at',stamp);
 after_head:=jsonb_build_object('id',preview_row.status_id,'version',frame_value->'after'->>'version','revision_id',revision_identity,
  'settings',frame_value->'after'->'settings','created_at',coalesce(prior_status.created_at,stamp),'updated_at',stamp);
 operation_raw:=jsonb_build_object('id',operation_identity,'tenant_id',tenant,'preview_id',pid,'status_id',preview_row.status_id,
  'revision_id',revision_identity,'actor_id',uid,'api_key_id',kid,'client_key',(body->>'client_key')::uuid,'kind',preview_row.kind,
  'request_hash',request_digest,'request',body,'payload',jsonb_build_object('before',frame_value->'before','after',after_head,'snapshot',
   jsonb_build_object('id',preview_row.id,'kind',preview_row.kind,'status_id',preview_row.status_id,'request',preview_row.request,'scope_hash',preview_row.scope_hash,
   'before',frame_value->'before','after',frame_value->'after','resources',frame_value->'resources','ready',true,'created_at',preview_row.created_at,'expires_at',preview_row.expires_at)),
  'created_at',stamp);
 INSERT INTO return_destination_status_admissions(id,tenant_id,operation_id,preview_id,status_id,revision_id,actor_id,api_key_id,before_row,after_row,revision,operation,created_at)
 VALUES(gen_random_uuid(),tenant,operation_identity,pid,preview_row.status_id,revision_identity,uid,kid,before_raw,after_raw,revision_raw,operation_raw,stamp);
 INSERT INTO return_destination_status_revisions(id,tenant_id,status_id,version,operation_id,settings,warehouse_snapshot,created_at)
 VALUES(revision_identity,tenant,preview_row.status_id,(frame_value->'after'->>'version')::bigint,operation_identity,frame_value->'after'->'settings',frame_value->'resources'->'warehouse',stamp);
 IF preview_row.kind='create' THEN
  INSERT INTO return_destination_statuses SELECT x.* FROM jsonb_populate_record(NULL::public.return_destination_statuses,after_raw)x;
 ELSE
  UPDATE return_destination_statuses SET version=(after_raw->>'version')::bigint,revision_id=revision_identity,updated_at=stamp WHERE(tenant_id,id)=(tenant,preview_row.status_id);
 END IF;
 INSERT INTO return_destination_status_operations SELECT x.* FROM jsonb_populate_record(NULL::public.return_destination_status_operations,operation_raw)x RETURNING * INTO saved;
 PERFORM public.return_destination_status_budget(tenant);
 RETURN jsonb_build_object('operation',to_jsonb(saved),'reused',false);
END $$;

-- Keep all typed issuers private, including functions declared after guards.
DO $$ DECLARE function_record record; BEGIN
 FOR function_record IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'return_destination_status_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',function_record.signature);
 END LOOP;
END $$;
