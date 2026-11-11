-- First explicit B2B catalog configuration. No legacy backfill or public handlers.
-- All issuers remain private until feed/refresh/quote/import consumers are integrated.
CREATE TABLE b2b_catalog_scope_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 kind text NOT NULL CHECK(kind IN('supplier','buyer')),entity_id uuid NOT NULL,catalog_id uuid NOT NULL,
 account_id uuid,link_id uuid,client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '900 seconds'),
 CHECK((kind='supplier' AND account_id IS NOT NULL AND account_id=entity_id AND link_id IS NULL) OR(kind='buyer' AND link_id IS NOT NULL AND link_id=entity_id AND account_id IS NULL)),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,kind,entity_id),UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,account_id) REFERENCES b2b_accounts(tenant_id,id),FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),
 FOREIGN KEY(tenant_id,catalog_id) REFERENCES product_catalogs(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE b2b_catalog_scope_operations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,preview_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('supplier','buyer')),entity_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,id,kind,entity_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,actor_id,client_key),
 FOREIGN KEY(tenant_id,preview_id,kind,entity_id) REFERENCES b2b_catalog_scope_previews(tenant_id,id,kind,entity_id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE b2b_supplier_catalog_scopes (
 tenant_id uuid NOT NULL REFERENCES tenants,account_id uuid NOT NULL,catalog_id uuid NOT NULL,warehouse_id uuid NOT NULL,price_list_id uuid NOT NULL,
 language text NOT NULL CHECK(length(language)<=40 AND language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$'),
 protocol text NOT NULL DEFAULT 'catalog_scope_v1' CHECK(protocol='catalog_scope_v1'),kind text NOT NULL DEFAULT 'supplier' CHECK(kind='supplier'),
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),operation_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,account_id),UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES b2b_accounts(tenant_id,id),FOREIGN KEY(tenant_id,catalog_id) REFERENCES product_catalogs(tenant_id,id),
 FOREIGN KEY(tenant_id,catalog_id,warehouse_id) REFERENCES product_catalog_warehouses(tenant_id,catalog_id,warehouse_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,catalog_id,price_list_id) REFERENCES product_catalog_price_lists(tenant_id,catalog_id,price_list_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,catalog_id,language) REFERENCES product_catalog_languages(tenant_id,catalog_id,locale) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,operation_id,kind,account_id) REFERENCES b2b_catalog_scope_operations(tenant_id,id,kind,entity_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE b2b_buyer_catalog_scopes (
 tenant_id uuid NOT NULL REFERENCES tenants,link_id uuid NOT NULL,target_catalog_id uuid NOT NULL,
 protocol text NOT NULL DEFAULT 'catalog_scope_v1' CHECK(protocol='catalog_scope_v1'),kind text NOT NULL DEFAULT 'buyer' CHECK(kind='buyer'),
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),operation_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,link_id),UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),FOREIGN KEY(tenant_id,target_catalog_id) REFERENCES product_catalogs(tenant_id,id),
 FOREIGN KEY(tenant_id,operation_id,kind,link_id) REFERENCES b2b_catalog_scope_operations(tenant_id,id,kind,entity_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE b2b_catalog_scope_admissions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,operation_id uuid NOT NULL,preview_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('supplier','buyer')),entity_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 txid xid8 NOT NULL DEFAULT pg_current_xact_id(),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,preview_id,kind,entity_id) REFERENCES b2b_catalog_scope_previews(tenant_id,id,kind,entity_id),
 FOREIGN KEY(tenant_id,operation_id,kind,entity_id) REFERENCES b2b_catalog_scope_operations(tenant_id,id,kind,entity_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE INDEX b2b_catalog_scope_preview_page ON b2b_catalog_scope_previews(tenant_id,kind,entity_id,id);
CREATE INDEX b2b_catalog_scope_operation_page ON b2b_catalog_scope_operations(tenant_id,kind,entity_id,id);
-- Nullable proof columns preserve every historical run without a backfill.
ALTER TABLE b2b_catalog_runs ADD COLUMN catalog_scope jsonb;
ALTER TABLE b2b_catalog_runs ADD COLUMN catalog_scope_hash text;
ALTER TABLE b2b_catalog_runs ADD COLUMN api_key_id uuid;
ALTER TABLE b2b_catalog_runs ADD CONSTRAINT b2b_catalog_run_scope_shape CHECK(
 (catalog_scope IS NULL AND catalog_scope_hash IS NULL AND api_key_id IS NULL)
 OR(jsonb_typeof(catalog_scope) IS NOT DISTINCT FROM 'object' AND catalog_scope_hash IS NOT NULL AND catalog_scope_hash ~ '^[a-f0-9]{64}$'));
ALTER TABLE b2b_catalog_runs ADD CONSTRAINT b2b_catalog_run_scope_key FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id);
CREATE TABLE b2b_catalog_bindings (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 link_id uuid NOT NULL,item_id uuid NOT NULL,product_id uuid NOT NULL,client_key uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 catalog_scope jsonb NOT NULL CHECK(jsonb_typeof(catalog_scope)='object'),source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),txid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,actor_id,client_key),UNIQUE(tenant_id,item_id),
 FOREIGN KEY(tenant_id,link_id) REFERENCES b2b_links(tenant_id,id),FOREIGN KEY(tenant_id,item_id) REFERENCES b2b_catalog_items(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
DO $$ DECLARE tbl text;BEGIN FOREACH tbl IN ARRAY ARRAY['b2b_supplier_catalog_scopes','b2b_buyer_catalog_scopes','b2b_catalog_scope_previews','b2b_catalog_scope_operations','b2b_catalog_scope_admissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
 EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tbl);
END LOOP;END $$;
ALTER TABLE b2b_catalog_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE b2b_catalog_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON b2b_catalog_bindings USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON b2b_catalog_bindings FROM PUBLIC,dyna_app;

CREATE FUNCTION b2b_catalog_scope_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$ SELECT encode(sha256(convert_to(j::text,'UTF8')),'hex') $$;
CREATE FUNCTION b2b_catalog_scope_installed() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
CREATE FUNCTION b2b_catalog_scope_lock() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN IF t IS NULL THEN RAISE EXCEPTION 'Brak własnej firmy B2B' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b.catalog.scope.quota:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog:'||t::text,0));
END $$;
CREATE FUNCTION b2b_catalog_scope_preview(uid uuid,kid uuid,side text,eid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;rh text;f jsonb;pr public.b2b_catalog_scope_previews;stamp timestamptz:=clock_timestamp();
BEGIN PERFORM public.b2b_catalog_scope_require(uid,kid,side,false);PERFORM public.b2b_catalog_scope_lock();
 IF NOT public.b2b_catalog_scope_request_valid(side,b) THEN RAISE EXCEPTION 'Niepoprawny podgląd zakresu B2B' USING ERRCODE='23514';END IF;
 rh:=public.b2b_catalog_scope_hash(jsonb_build_object('actor',uid,'key',kid,'kind',side,'entity_id',eid,'request',b));
 SELECT * INTO pr FROM public.b2b_catalog_scope_previews WHERE(tenant_id,actor_id,client_key)=(t,uid,(b->>'client_key')::uuid);
 IF pr.id IS NOT NULL THEN
  IF pr.request_hash IS DISTINCT FROM rh OR pr.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Klucz podglądu B2B ma inną treść' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('preview',to_jsonb(pr),'reused',true);
 END IF;
 f:=public.b2b_catalog_scope_frame(side,eid,b);
 INSERT INTO public.b2b_catalog_scope_previews(id,tenant_id,actor_id,api_key_id,kind,entity_id,catalog_id,account_id,link_id,client_key,request_hash,scope_hash,request,payload,created_at,expires_at)
 VALUES(gen_random_uuid(),t,uid,kid,side,eid,(f->'catalog'->>'id')::uuid,CASE WHEN side='supplier' THEN eid END,CASE WHEN side='buyer' THEN eid END,(b->>'client_key')::uuid,rh,public.b2b_catalog_scope_hash(f),b,f,stamp,stamp+interval '900 seconds') RETURNING * INTO pr;
 PERFORM public.b2b_catalog_scope_budget(t);RETURN jsonb_build_object('preview',to_jsonb(pr),'reused',false);
END $$;
CREATE FUNCTION b2b_catalog_scope_commit(uid uuid,kid uuid,pid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;pr public.b2b_catalog_scope_previews;op public.b2b_catalog_scope_operations;f jsonb;rh text;oid uuid:=gen_random_uuid();after_doc jsonb;scope_doc jsonb;
BEGIN
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Niepoprawna zgoda zakresu B2B' USING ERRCODE='23514';END IF;
 IF NOT b ?& ARRAY['client_key','scope_hash','confirmed'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(b)x WHERE x NOT IN('client_key','scope_hash','confirmed'))
 OR jsonb_typeof(b->'client_key') IS DISTINCT FROM 'string' OR coalesce(b->>'client_key','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR jsonb_typeof(b->'scope_hash') IS DISTINCT FROM 'string' OR coalesce(b->>'scope_hash','') !~ '^[a-f0-9]{64}$' OR b->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Niepoprawna zgoda zakresu B2B' USING ERRCODE='23514';END IF;
 SELECT * INTO pr FROM public.b2b_catalog_scope_previews WHERE(tenant_id,id)=(t,pid);
 IF pr.id IS NULL THEN RAISE EXCEPTION 'Brak podglądu zakresu B2B' USING ERRCODE='P0002';END IF;
 PERFORM public.b2b_catalog_scope_require(uid,kid,pr.kind,false);PERFORM public.b2b_catalog_scope_lock();
 IF pr.actor_id IS DISTINCT FROM uid OR pr.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Podgląd należy do innego wykonawcy' USING ERRCODE='23514';END IF;
 rh:=public.b2b_catalog_scope_hash(jsonb_build_object('actor',uid,'key',kid,'preview_id',pid,'request',b));
 SELECT * INTO op FROM public.b2b_catalog_scope_operations WHERE(tenant_id,actor_id,client_key)=(t,uid,(b->>'client_key')::uuid);
 IF op.id IS NOT NULL THEN
  IF op.request_hash IS DISTINCT FROM rh OR op.api_key_id IS DISTINCT FROM kid THEN RAISE EXCEPTION 'Klucz wykonania B2B ma inną treść' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('operation',to_jsonb(op),'reused',true);
 END IF;
 PERFORM 1 FROM public.b2b_catalog_scope_previews WHERE(tenant_id,id)=(t,pid) FOR UPDATE;
 IF pr.expires_at<=clock_timestamp() OR b->>'scope_hash' IS DISTINCT FROM pr.scope_hash
 OR EXISTS(SELECT 1 FROM public.b2b_catalog_scope_operations WHERE(tenant_id,preview_id)=(t,pid)) THEN RAISE EXCEPTION 'Podgląd zakresu B2B wygasł lub wykonano zgodę' USING ERRCODE='23514';END IF;
 f:=public.b2b_catalog_scope_frame(pr.kind,pr.entity_id,pr.request);
 IF f IS DISTINCT FROM pr.payload OR public.b2b_catalog_scope_hash(f) IS DISTINCT FROM pr.scope_hash THEN RAISE EXCEPTION 'Źródło zakresu B2B zmieniło się' USING ERRCODE='23514';END IF;
 INSERT INTO public.b2b_catalog_scope_admissions(id,tenant_id,operation_id,preview_id,kind,entity_id,actor_id,api_key_id,payload) VALUES(gen_random_uuid(),t,oid,pid,pr.kind,pr.entity_id,uid,kid,f);
 IF pr.kind='supplier' THEN
  UPDATE public.b2b_accounts SET warehouse_id=(pr.request->>'warehouse_id')::uuid,price_list_id=(pr.request->>'price_list_id')::uuid,version=version+1,updated_at=clock_timestamp() WHERE(tenant_id,id)=(t,pr.entity_id);
  INSERT INTO public.b2b_supplier_catalog_scopes(tenant_id,account_id,catalog_id,warehouse_id,price_list_id,language,operation_id)
  VALUES(t,pr.entity_id,pr.catalog_id,(pr.request->>'warehouse_id')::uuid,(pr.request->>'price_list_id')::uuid,pr.request->>'language',oid);
  SELECT to_jsonb(s) INTO scope_doc FROM public.b2b_supplier_catalog_scopes s WHERE(s.tenant_id,s.account_id)=(t,pr.entity_id);
  SELECT jsonb_build_object('id',a.id,'version',a.version::text,'warehouse_id',a.warehouse_id,'price_list_id',a.price_list_id,'active',a.active) INTO after_doc FROM public.b2b_accounts a WHERE(a.tenant_id,a.id)=(t,pr.entity_id);
 ELSE
  UPDATE public.b2b_links SET version=version+1 WHERE(tenant_id,id)=(t,pr.entity_id);
  INSERT INTO public.b2b_buyer_catalog_scopes(tenant_id,link_id,target_catalog_id,operation_id) VALUES(t,pr.entity_id,pr.catalog_id,oid);
  SELECT to_jsonb(s) INTO scope_doc FROM public.b2b_buyer_catalog_scopes s WHERE(s.tenant_id,s.link_id)=(t,pr.entity_id);
  SELECT jsonb_build_object('id',l.id,'version',l.version::text,'supplier_tenant_id',l.supplier_tenant_id,'account_id',l.account_id,'paused',l.paused,'schedule_minutes',l.schedule_minutes) INTO after_doc FROM public.b2b_links l WHERE(l.tenant_id,l.id)=(t,pr.entity_id);
 END IF;
 INSERT INTO public.b2b_catalog_scope_operations(id,tenant_id,preview_id,kind,entity_id,actor_id,api_key_id,client_key,request_hash,request,payload)
 VALUES(oid,t,pid,pr.kind,pr.entity_id,uid,kid,(b->>'client_key')::uuid,rh,b,jsonb_build_object('protocol','catalog_scope_v1','preview_id',pid,'scope_hash',pr.scope_hash,'snapshot',f,'before',f->'before','after',after_doc,'scope',scope_doc)) RETURNING * INTO op;
 PERFORM public.b2b_catalog_scope_budget(t);RETURN jsonb_build_object('operation',to_jsonb(op),'reused',false);
END $$;
CREATE FUNCTION b2b_catalog_scope_access(uid uuid,kid uuid,side text,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k public.api_keys;valid boolean:=true;allowed boolean:=true;scopes text[];
BEGIN IF side IS NULL OR side NOT IN('supplier','buyer') THEN RAISE EXCEPTION 'Niepoprawna strona zakresu B2B' USING ERRCODE='23514';END IF;
 IF pin THEN SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid) FOR SHARE;ELSE SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid);END IF;
 scopes:=CASE side WHEN 'supplier' THEN ARRAY['products:read','products:write','inventory:read'] ELSE ARRAY['products:read','products:write','purchasing:read','purchasing:write'] END;
 IF kid IS NOT NULL THEN
  IF pin THEN SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;ELSE SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);END IF;
  valid:=k.id IS NOT NULL AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>clock_timestamp());allowed:=valid AND k.scopes @> scopes;
 END IF;
 IF NOT coalesce(valid,false) THEN RAISE EXCEPTION 'Klucz zakresu B2B jest nieaktualny' USING ERRCODE='28000';END IF;
 IF NOT coalesce(r='admin' AND allowed,false) THEN RAISE EXCEPTION 'Brak aktualnego uprawnienia do zakresu B2B' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('current_role',r,'required_scopes',scopes);
END $$;
CREATE FUNCTION b2b_catalog_scope_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n bigint;bytes bigint;
BEGIN SELECT count(*) INTO n FROM(SELECT id FROM public.b2b_catalog_scope_previews WHERE tenant_id=t UNION ALL SELECT id FROM public.b2b_catalog_scope_operations WHERE tenant_id=t UNION ALL SELECT id FROM public.b2b_catalog_bindings WHERE tenant_id=t)x;
 SELECT coalesce(sum(octet_length(x.j::text)),0) INTO bytes FROM(
 SELECT to_jsonb(p) j FROM public.b2b_catalog_scope_previews p WHERE tenant_id=t UNION ALL SELECT to_jsonb(o) FROM public.b2b_catalog_scope_operations o WHERE tenant_id=t
 UNION ALL SELECT to_jsonb(a) FROM public.b2b_catalog_scope_admissions a WHERE tenant_id=t UNION ALL SELECT to_jsonb(s) FROM public.b2b_supplier_catalog_scopes s WHERE tenant_id=t UNION ALL SELECT to_jsonb(b) FROM public.b2b_buyer_catalog_scopes b WHERE tenant_id=t UNION ALL SELECT to_jsonb(r) FROM public.b2b_catalog_bindings r WHERE tenant_id=t)x;
 IF n>5000 OR bytes>67108864 THEN RAISE EXCEPTION 'Limit historii zakresu B2B' USING ERRCODE='54000';END IF;
END $$;
CREATE FUNCTION b2b_catalog_scope_request_valid(side text,b jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE field text;v text;keys text[];
BEGIN IF side IS NULL OR side NOT IN('supplier','buyer') OR jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 keys:=CASE side WHEN 'supplier' THEN ARRAY['client_key','account_version','catalog_id','catalog_version','warehouse_id','price_list_id','language'] ELSE ARRAY['client_key','link_version','target_catalog_id','target_catalog_version'] END;
 IF NOT b ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(b)x WHERE NOT x=ANY(keys)) THEN RETURN false;END IF;
 FOREACH field IN ARRAY keys LOOP
  IF jsonb_typeof(b->field) IS DISTINCT FROM 'string' THEN RETURN false;END IF;v:=b->>field;
  IF field='language' THEN IF length(v)>40 OR v !~ '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$' THEN RETURN false;END IF;
  ELSIF field LIKE '%version' THEN IF v !~ '^[1-9][0-9]{0,18}$' THEN RETURN false;END IF;
   IF v::numeric>9223372036854775807 OR(field IN('account_version','link_version') AND v::numeric>2147483647) THEN RETURN false;END IF;
  ELSE IF v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION b2b_catalog_scope_frame(side text,eid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;ca public.product_catalogs;ac public.b2b_accounts;ln public.b2b_links;wh public.warehouses;pl public.price_lists;cid uuid;before_doc jsonb;resources jsonb;
BEGIN IF NOT public.b2b_catalog_scope_request_valid(side,b) THEN RAISE EXCEPTION 'Niepoprawny podgląd zakresu B2B' USING ERRCODE='23514';END IF;
 cid:=(b->>(CASE side WHEN 'supplier' THEN 'catalog_id' ELSE 'target_catalog_id' END))::uuid;
 SELECT * INTO ca FROM public.product_catalogs WHERE(tenant_id,id)=(t,cid) FOR SHARE;
 IF ca.id IS NULL OR NOT ca.active OR ca.version::text IS DISTINCT FROM b->>(CASE side WHEN 'supplier' THEN 'catalog_version' ELSE 'target_catalog_version' END) THEN RAISE EXCEPTION 'Katalog zakresu B2B zmienił się' USING ERRCODE='23514';END IF;
 IF side='supplier' THEN
  SELECT * INTO ac FROM public.b2b_accounts WHERE(tenant_id,id)=(t,eid) FOR UPDATE;
  IF ac.id IS NULL THEN RAISE EXCEPTION 'Brak własnego konta B2B' USING ERRCODE='P0002';END IF;
  IF ac.version>=2147483647 OR ac.version::text IS DISTINCT FROM b->>'account_version' OR EXISTS(SELECT 1 FROM public.b2b_supplier_catalog_scopes WHERE(tenant_id,account_id)=(t,eid)) THEN RAISE EXCEPTION 'Konto B2B zmieniło się lub posiada zakres' USING ERRCODE='23514';END IF;
  SELECT * INTO wh FROM public.warehouses WHERE(tenant_id,id)=(t,(b->>'warehouse_id')::uuid) FOR SHARE;
  SELECT * INTO pl FROM public.price_lists WHERE(tenant_id,id)=(t,(b->>'price_list_id')::uuid) FOR SHARE;
  IF wh.id IS NULL OR pl.id IS NULL OR NOT pl.active
   OR NOT EXISTS(SELECT 1 FROM public.product_catalog_warehouses WHERE(tenant_id,catalog_id,warehouse_id)=(t,cid,wh.id))
   OR NOT EXISTS(SELECT 1 FROM public.product_catalog_price_lists WHERE(tenant_id,catalog_id,price_list_id)=(t,cid,pl.id))
   OR NOT EXISTS(SELECT 1 FROM public.product_catalog_languages WHERE(tenant_id,catalog_id,locale)=(t,cid,b->>'language')) THEN RAISE EXCEPTION 'Zasób nie jest przypisany do katalogu B2B' USING ERRCODE='23514';END IF;
  before_doc:=jsonb_build_object('id',ac.id,'version',ac.version::text,'warehouse_id',ac.warehouse_id,'price_list_id',ac.price_list_id,'active',ac.active);
  resources:=jsonb_build_object('warehouse',jsonb_build_object('id',wh.id,'name',wh.name,'code',wh.code),'price_list',jsonb_build_object('id',pl.id,'version',pl.version::text,'currency',pl.currency,'active',pl.active),'language',b->>'language');
 ELSE
  SELECT * INTO ln FROM public.b2b_links WHERE(tenant_id,id)=(t,eid) FOR UPDATE;
  IF ln.id IS NULL THEN RAISE EXCEPTION 'Brak własnego powiązania B2B' USING ERRCODE='P0002';END IF;
  IF ln.version>=2147483647 OR ln.version::text IS DISTINCT FROM b->>'link_version' OR EXISTS(SELECT 1 FROM public.b2b_buyer_catalog_scopes WHERE(tenant_id,link_id)=(t,eid)) THEN RAISE EXCEPTION 'Powiązanie B2B zmieniło się lub posiada zakres' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.b2b_catalog_items i JOIN public.products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE(i.tenant_id,i.link_id)=(t,eid) AND p.catalog_id<>cid) THEN RAISE EXCEPTION 'Istniejące powiązanie produktu pochodzi z innego katalogu' USING ERRCODE='23514';END IF;
  before_doc:=jsonb_build_object('id',ln.id,'version',ln.version::text,'supplier_tenant_id',ln.supplier_tenant_id,'account_id',ln.account_id,'paused',ln.paused,'schedule_minutes',ln.schedule_minutes);
  resources:=jsonb_build_object('supplier_tenant_id',ln.supplier_tenant_id,'supplier_name',ln.supplier_name,'account_id',ln.account_id);
 END IF;
 RETURN jsonb_build_object('protocol','catalog_scope_v1','kind',side,'entity_id',eid,'request',b,'before',before_doc,'catalog',public.product_catalog_head(cid),'resources',resources,'scope_before',NULL);
END $$;
CREATE FUNCTION b2b_catalog_scope_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Niezmienny dowód zakresu B2B' USING ERRCODE='23514';END $$;
CREATE FUNCTION b2b_catalog_scope_sidecar_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ad public.b2b_catalog_scope_admissions;side text;eid uuid;
BEGIN IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Pierwsza konfiguracja zakresu B2B jest niezmienna' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='b2b_supplier_catalog_scopes' THEN side:='supplier';eid:=NEW.account_id;ELSE side:='buyer';eid:=NEW.link_id;END IF;
 SELECT * INTO ad FROM public.b2b_catalog_scope_admissions a WHERE(a.tenant_id,a.operation_id,a.kind,a.entity_id,a.txid)=(NEW.tenant_id,NEW.operation_id,side,eid,pg_current_xact_id());
 IF ad.id IS NULL OR NEW.version<>1 OR NEW.protocol<>'catalog_scope_v1' OR NEW.kind<>side THEN RAISE EXCEPTION 'Zakres B2B wymaga bieżącej zgody' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='b2b_supplier_catalog_scopes' THEN
  IF(NEW.catalog_id::text,NEW.warehouse_id::text,NEW.price_list_id::text,NEW.language) IS DISTINCT FROM(ad.payload->'request'->>'catalog_id',ad.payload->'request'->>'warehouse_id',ad.payload->'request'->>'price_list_id',ad.payload->'request'->>'language') THEN RAISE EXCEPTION 'Zakres dostawcy nie odpowiada zgodzie' USING ERRCODE='23514';END IF;
 ELSE IF NEW.target_catalog_id::text IS DISTINCT FROM ad.payload->'request'->>'target_catalog_id' THEN RAISE EXCEPTION 'Zakres odbiorcy nie odpowiada zgodzie' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION b2b_catalog_scope_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ad public.b2b_catalog_scope_admissions;pr public.b2b_catalog_scope_previews;op public.b2b_catalog_scope_operations;scope_doc jsonb;after_doc jsonb;expected_after jsonb;
BEGIN
 IF TG_TABLE_NAME='b2b_catalog_scope_admissions' THEN SELECT * INTO ad FROM public.b2b_catalog_scope_admissions a WHERE(a.tenant_id,a.id)=(NEW.tenant_id,NEW.id);
 ELSE SELECT * INTO ad FROM public.b2b_catalog_scope_admissions a WHERE(a.tenant_id,a.operation_id)=(NEW.tenant_id,NEW.id);END IF;
 IF ad.id IS NULL OR ad.txid IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Brak świeżej zgody zakresu B2B' USING ERRCODE='23514';END IF;
 PERFORM public.b2b_catalog_scope_require(ad.actor_id,ad.api_key_id,ad.kind,false);
 SELECT * INTO pr FROM public.b2b_catalog_scope_previews p WHERE(p.tenant_id,p.id)=(ad.tenant_id,ad.preview_id);
 SELECT * INTO op FROM public.b2b_catalog_scope_operations o WHERE(o.tenant_id,o.id)=(ad.tenant_id,ad.operation_id);
 IF pr.id IS NULL OR op.id IS NULL OR(ad.kind,ad.entity_id,ad.actor_id,ad.api_key_id) IS DISTINCT FROM(pr.kind,pr.entity_id,pr.actor_id,pr.api_key_id)
 OR(op.kind,op.entity_id,op.actor_id,op.api_key_id,op.preview_id) IS DISTINCT FROM(ad.kind,ad.entity_id,ad.actor_id,ad.api_key_id,ad.preview_id)
 OR ad.payload IS DISTINCT FROM pr.payload OR public.b2b_catalog_scope_hash(pr.payload) IS DISTINCT FROM pr.scope_hash
 OR pr.request_hash IS DISTINCT FROM public.b2b_catalog_scope_hash(jsonb_build_object('actor',pr.actor_id,'key',pr.api_key_id,'kind',pr.kind,'entity_id',pr.entity_id,'request',pr.request))
 OR op.request_hash IS DISTINCT FROM public.b2b_catalog_scope_hash(jsonb_build_object('actor',op.actor_id,'key',op.api_key_id,'preview_id',op.preview_id,'request',op.request))
 OR op.request->'confirmed' IS DISTINCT FROM 'true'::jsonb OR op.request->>'scope_hash' IS DISTINCT FROM pr.scope_hash
 OR op.payload->>'protocol' IS DISTINCT FROM 'catalog_scope_v1' OR op.payload->>'preview_id' IS DISTINCT FROM pr.id::text
 OR op.payload->>'scope_hash' IS DISTINCT FROM pr.scope_hash OR op.payload->'snapshot' IS DISTINCT FROM pr.payload OR op.payload->'before' IS DISTINCT FROM pr.payload->'before' THEN RAISE EXCEPTION 'Niezgodny pełny dowód zakresu B2B' USING ERRCODE='23514';END IF;
 expected_after:=(pr.payload->'before')||jsonb_build_object('version',((pr.payload->'before'->>'version')::bigint+1)::text);
 IF ad.kind='supplier' THEN
  SELECT to_jsonb(s) INTO scope_doc FROM public.b2b_supplier_catalog_scopes s WHERE(s.tenant_id,s.account_id)=(ad.tenant_id,ad.entity_id);
  SELECT jsonb_build_object('id',a.id,'version',a.version::text,'warehouse_id',a.warehouse_id,'price_list_id',a.price_list_id,'active',a.active) INTO after_doc FROM public.b2b_accounts a WHERE(a.tenant_id,a.id)=(ad.tenant_id,ad.entity_id);
  expected_after:=expected_after||jsonb_build_object('warehouse_id',pr.request->'warehouse_id','price_list_id',pr.request->'price_list_id');
 ELSE
  SELECT to_jsonb(s) INTO scope_doc FROM public.b2b_buyer_catalog_scopes s WHERE(s.tenant_id,s.link_id)=(ad.tenant_id,ad.entity_id);
  SELECT jsonb_build_object('id',l.id,'version',l.version::text,'supplier_tenant_id',l.supplier_tenant_id,'account_id',l.account_id,'paused',l.paused,'schedule_minutes',l.schedule_minutes) INTO after_doc FROM public.b2b_links l WHERE(l.tenant_id,l.id)=(ad.tenant_id,ad.entity_id);
 END IF;
 IF scope_doc IS NULL OR scope_doc->>'operation_id' IS DISTINCT FROM op.id::text OR scope_doc->>'version' IS DISTINCT FROM '1'
 OR scope_doc->>'protocol' IS DISTINCT FROM 'catalog_scope_v1' OR scope_doc->>'kind' IS DISTINCT FROM ad.kind
 OR scope_doc->>'tenant_id' IS DISTINCT FROM ad.tenant_id::text OR op.payload->'scope' IS DISTINCT FROM scope_doc
 OR op.payload->'after' IS DISTINCT FROM after_doc OR after_doc IS DISTINCT FROM expected_after
 OR public.product_catalog_head(pr.catalog_id) IS DISTINCT FROM pr.payload->'catalog' THEN RAISE EXCEPTION 'Konfiguracja B2B nie odpowiada zatwierdzonemu dowodowi' USING ERRCODE='23514';END IF;
 PERFORM public.b2b_catalog_scope_budget(ad.tenant_id);RETURN NULL;
END $$;
CREATE FUNCTION b2b_catalog_scope_entity_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE scoped boolean;
BEGIN
 IF TG_TABLE_NAME='b2b_accounts' THEN
  SELECT EXISTS(SELECT 1 FROM public.b2b_supplier_catalog_scopes s WHERE(s.tenant_id,s.account_id) IN((OLD.tenant_id,OLD.id),(NEW.tenant_id,NEW.id))) INTO scoped;
 ELSE SELECT EXISTS(SELECT 1 FROM public.b2b_buyer_catalog_scopes s WHERE(s.tenant_id,s.link_id) IN((OLD.tenant_id,OLD.id),(NEW.tenant_id,NEW.id))) INTO scoped;END IF;
 IF NOT scoped THEN RETURN NEW;END IF;
 IF(NEW.tenant_id,NEW.id) IS DISTINCT FROM(OLD.tenant_id,OLD.id) OR EXISTS(SELECT 1 FROM public.b2b_catalog_scope_admissions a JOIN public.b2b_catalog_scope_operations o ON(o.tenant_id,o.id)=(a.tenant_id,a.operation_id)
 WHERE a.txid=pg_current_xact_id() AND(a.tenant_id,a.entity_id) IN((OLD.tenant_id,OLD.id),(NEW.tenant_id,NEW.id))) THEN RAISE EXCEPTION 'Zapieczętowana konfiguracja B2B' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='b2b_accounts' THEN
  IF NOT EXISTS(SELECT 1 FROM public.b2b_supplier_catalog_scopes s WHERE(s.tenant_id,s.account_id,s.warehouse_id,s.price_list_id)=(NEW.tenant_id,NEW.id,NEW.warehouse_id,NEW.price_list_id)) THEN RAISE EXCEPTION 'Magazyn i cennik wymagają konfiguracji zakresu B2B' USING ERRCODE='23514';END IF;
 ELSE IF(NEW.supplier_tenant_id,NEW.account_id) IS DISTINCT FROM(OLD.supplier_tenant_id,OLD.account_id) THEN RAISE EXCEPTION 'Niezmienny dostawca zakresu B2B' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b2b_supplier_catalog_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_supplier_catalog_scopes FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_sidecar_guard();
CREATE TRIGGER b2b_buyer_catalog_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_buyer_catalog_scopes FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_sidecar_guard();
CREATE TRIGGER b2b_catalog_scope_preview_immutable BEFORE UPDATE OR DELETE ON b2b_catalog_scope_previews FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_immutable();
CREATE TRIGGER b2b_catalog_scope_operation_immutable BEFORE UPDATE OR DELETE ON b2b_catalog_scope_operations FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_immutable();
CREATE TRIGGER b2b_catalog_scope_admission_immutable BEFORE UPDATE OR DELETE ON b2b_catalog_scope_admissions FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_immutable();
CREATE CONSTRAINT TRIGGER b2b_catalog_scope_admission_complete AFTER INSERT ON b2b_catalog_scope_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_complete();
CREATE CONSTRAINT TRIGGER b2b_catalog_scope_operation_complete AFTER INSERT ON b2b_catalog_scope_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_complete();
CREATE TRIGGER b2b_catalog_scope_account_guard BEFORE UPDATE ON b2b_accounts FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_entity_guard();
CREATE TRIGGER b2b_catalog_scope_link_guard BEFORE UPDATE ON b2b_links FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_entity_guard();

-- Server and trigger use the same literal current configuration proof. Supplier
-- identity comes from the persisted own link, never a request tenant UUID.
CREATE FUNCTION b2b_catalog_scope_run_pair(t uuid,lid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l public.b2b_links;a public.b2b_accounts;bc public.product_catalogs;sc public.product_catalogs;pl public.price_lists;
 bs public.b2b_buyer_catalog_scopes;ss public.b2b_supplier_catalog_scopes;lang text;
BEGIN
 SELECT * INTO l FROM public.b2b_links WHERE(tenant_id,id)=(t,lid);
 SELECT * INTO bs FROM public.b2b_buyer_catalog_scopes WHERE(tenant_id,link_id)=(t,lid);
 SELECT * INTO bc FROM public.product_catalogs WHERE tenant_id=t AND CASE WHEN bs.link_id IS NULL THEN is_default ELSE id=bs.target_catalog_id END;
 SELECT * INTO a FROM public.b2b_accounts WHERE(tenant_id,id)=(l.supplier_tenant_id,l.account_id);
 SELECT * INTO ss FROM public.b2b_supplier_catalog_scopes WHERE(tenant_id,account_id)=(a.tenant_id,a.id);
 SELECT * INTO sc FROM public.product_catalogs WHERE tenant_id=a.tenant_id AND CASE WHEN ss.account_id IS NULL THEN is_default ELSE id=ss.catalog_id END;
 SELECT * INTO pl FROM public.price_lists WHERE(tenant_id,id)=(a.tenant_id,a.price_list_id);lang:=coalesce(ss.language,sc.default_language);
 IF l.id IS NULL OR l.paused OR a.id IS NULL OR NOT a.active OR bc.id IS NULL OR NOT bc.active OR sc.id IS NULL OR NOT sc.active OR pl.id IS NULL OR NOT pl.active
 OR(ss.account_id IS NOT NULL AND(ss.warehouse_id,ss.price_list_id) IS DISTINCT FROM(a.warehouse_id,a.price_list_id))
 OR NOT EXISTS(SELECT 1 FROM public.product_catalog_warehouses WHERE(tenant_id,catalog_id,warehouse_id)=(a.tenant_id,sc.id,a.warehouse_id))
 OR NOT EXISTS(SELECT 1 FROM public.product_catalog_price_lists WHERE(tenant_id,catalog_id,price_list_id)=(a.tenant_id,sc.id,pl.id))
 OR NOT EXISTS(SELECT 1 FROM public.product_catalog_languages WHERE(tenant_id,catalog_id,locale)=(a.tenant_id,sc.id,lang))
 THEN RAISE EXCEPTION 'Nieaktualny zakres przebiegu B2B' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('buyer',jsonb_build_object('mode',CASE WHEN bs.link_id IS NULL THEN 'legacy_default' ELSE 'catalog_scope_v1' END,
 'tenant_id',t,'link_id',l.id,'link_version',l.version::text,'supplier_tenant_id',l.supplier_tenant_id,'account_id',l.account_id,
 'target_catalog_id',bc.id,'target_catalog_version',bc.version::text,'operation_id',bs.operation_id,'scope_version',bs.version::text),
 'supplier',jsonb_build_object('mode',CASE WHEN ss.account_id IS NULL THEN 'legacy_default' ELSE 'catalog_scope_v1' END,
 'tenant_id',a.tenant_id,'account_id',a.id,'account_version',a.version::text,'catalog_id',sc.id,'catalog_version',sc.version::text,
 'operation_id',ss.operation_id,'scope_version',ss.version::text,'warehouse_id',a.warehouse_id,'price_list_id',pl.id,'price_list_version',pl.version::text,'currency',pl.currency,'language',lang));
END $$;
CREATE FUNCTION b2b_catalog_scope_run_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE pair_doc jsonb;j public.jobs;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.catalog_scope IS NOT NULL THEN RAISE EXCEPTION 'Niezmienny dowód przebiegu katalogu B2B' USING ERRCODE='23514';END IF;
  --Keep genuine pre144 legacy deletion behavior; no new run is unstamped.
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF(to_jsonb(NEW)-ARRAY['state','cursor','fetched','error','finished_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','cursor','fetched','error','finished_at']) THEN
   RAISE EXCEPTION 'Niezmienny dowód przebiegu katalogu B2B' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 pair_doc:=public.b2b_catalog_scope_run_pair(NEW.tenant_id,NEW.link_id);
 PERFORM public.b2b_catalog_scope_access(NEW.actor_id,NEW.api_key_id,'buyer',false);
 SELECT * INTO j FROM public.jobs WHERE(tenant_id,id)=(NEW.tenant_id,NEW.job_id);
 IF NEW.catalog_scope IS DISTINCT FROM pair_doc OR NEW.catalog_scope_hash IS DISTINCT FROM public.b2b_catalog_scope_hash(pair_doc)
 OR(NEW.link_version::text,NEW.account_version::text,NEW.list_version::text) IS DISTINCT FROM(pair_doc->'buyer'->>'link_version',pair_doc->'supplier'->>'account_version',pair_doc->'supplier'->>'price_list_version')
 OR j.id IS NULL OR j.kind IS DISTINCT FROM 'b2b.catalog' OR j.payload IS DISTINCT FROM jsonb_build_object('run_id',NEW.id,'link_id',NEW.link_id,'actor_id',NEW.actor_id,'api_key_id',NEW.api_key_id,'catalog_scope_hash',NEW.catalog_scope_hash)
 THEN RAISE EXCEPTION 'Niezgodny pełny dowód przebiegu katalogu B2B' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE FUNCTION b2b_catalog_scope_binding_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i public.b2b_catalog_items;p public.products;expected jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Niezmienny wynik powiązania B2B' USING ERRCODE='23514';END IF;
 PERFORM public.b2b_catalog_scope_access(NEW.actor_id,NEW.api_key_id,'buyer',false);
 SELECT * INTO i FROM public.b2b_catalog_items WHERE(tenant_id,id,link_id)=(NEW.tenant_id,NEW.item_id,NEW.link_id);
 SELECT * INTO p FROM public.products WHERE(tenant_id,id)=(NEW.tenant_id,NEW.product_id);
 expected:=jsonb_build_object('id',NEW.id,'link_id',NEW.link_id,'item_id',NEW.item_id,'product_id',NEW.product_id,
 'item_version_before',NEW.request->'version','item_version_after',i.version,'quantity',0,'supplier_available',NEW.source_snapshot->'available','created_at',NEW.created_at);
 IF NEW.txid IS DISTINCT FROM pg_current_xact_id() OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
 OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'version',i.version-1,'product_id',NEW.product_id,'confirmed',true)
 OR NEW.request_hash IS DISTINCT FROM public.b2b_catalog_scope_hash(jsonb_build_object('actor',NEW.actor_id,'key',NEW.api_key_id,'link_id',NEW.link_id,'item_id',NEW.item_id,'request',NEW.request))
 OR NEW.catalog_scope IS DISTINCT FROM public.b2b_catalog_scope_run_pair(NEW.tenant_id,NEW.link_id)
 OR i.id IS NULL OR NOT i.published OR i.product_id IS DISTINCT FROM NEW.product_id OR i.snapshot IS DISTINCT FROM NEW.source_snapshot
 OR p.id IS NULL OR NOT p.active OR p.kind NOT IN('simple','variant') OR p.catalog_id::text IS DISTINCT FROM NEW.catalog_scope->'buyer'->>'target_catalog_id'
 OR NEW.response IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Niezgodny pełny wynik powiązania B2B' USING ERRCODE='23514';END IF;
 PERFORM public.b2b_catalog_scope_budget(NEW.tenant_id);RETURN NEW;
END $$;
CREATE TRIGGER b2b_catalog_scope_run_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_catalog_runs FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_run_guard();
CREATE TRIGGER b2b_catalog_scope_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_catalog_bindings FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_binding_guard();
CREATE FUNCTION b2b_catalog_scope_bound_item_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.b2b_catalog_bindings b WHERE(b.tenant_id,b.item_id)= (OLD.tenant_id,OLD.id)) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Niezmienna tożsamość powiązania B2B' USING ERRCODE='23514';END IF;
  IF(NEW.id,NEW.tenant_id,NEW.link_id,NEW.source_product_id,NEW.product_id) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.link_id,OLD.source_product_id,OLD.product_id)
  OR EXISTS(SELECT 1 FROM public.b2b_catalog_bindings b WHERE(b.tenant_id,b.item_id,b.txid)=(OLD.tenant_id,OLD.id,pg_current_xact_id())) THEN
   RAISE EXCEPTION 'Niezmienna tożsamość powiązania B2B' USING ERRCODE='23514';END IF;
 END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER b2b_catalog_scope_bound_item_guard BEFORE UPDATE OR DELETE ON b2b_catalog_items FOR EACH ROW EXECUTE FUNCTION b2b_catalog_scope_bound_item_guard();

CREATE FUNCTION b2b_catalog_scope_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tbl text;tables text[]:=ARRAY['b2b_supplier_catalog_scopes','b2b_buyer_catalog_scopes','b2b_catalog_scope_previews','b2b_catalog_scope_operations','b2b_catalog_scope_admissions','b2b_catalog_bindings'];
BEGIN IF to_regprocedure('public.product_catalog_guards()') IS NULL THEN RETURN false;END IF;IF NOT public.product_catalog_guards() THEN RETURN false;END IF;
 FOREACH tbl IN ARRAY tables LOOP
  IF to_regclass('public.'||tbl) IS NULL THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||tbl) AND relrowsecurity AND relforcerowsecurity) THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('public.'||tbl) AND p.polname='tenant_scope' AND p.polcmd='*')
  OR has_table_privilege('dyna_app','public.'||tbl,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('dyna_app','public.'||tbl,'SELECT,INSERT,UPDATE')
  OR EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=to_regclass('public.'||tbl) AND a.grantee=0) THEN RETURN false;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM(VALUES
  ('b2b_supplier_catalog_scopes',ARRAY['tenant_id','account_id','catalog_id','warehouse_id','price_list_id','language','protocol','kind','version','operation_id','created_at']::text[],ARRAY[]::text[]),
  ('b2b_buyer_catalog_scopes',ARRAY['tenant_id','link_id','target_catalog_id','protocol','kind','version','operation_id','created_at']::text[],ARRAY[]::text[]),
  ('b2b_catalog_scope_previews',ARRAY['id','tenant_id','actor_id','api_key_id','kind','entity_id','catalog_id','account_id','link_id','client_key','request_hash','scope_hash','request','payload','created_at','expires_at']::text[],ARRAY['api_key_id','account_id','link_id']::text[]),
  ('b2b_catalog_scope_operations',ARRAY['id','tenant_id','preview_id','kind','entity_id','actor_id','api_key_id','client_key','request_hash','request','payload','created_at']::text[],ARRAY['api_key_id']::text[]),
  ('b2b_catalog_scope_admissions',ARRAY['id','tenant_id','operation_id','preview_id','kind','entity_id','actor_id','api_key_id','txid','payload','created_at']::text[],ARRAY['api_key_id']::text[]),
  ('b2b_catalog_bindings',ARRAY['id','tenant_id','actor_id','api_key_id','link_id','item_id','product_id','client_key','request_hash','request','catalog_scope','source_snapshot','response','txid','created_at']::text[],ARRAY['api_key_id']::text[]),
  ('b2b_catalog_runs',ARRAY['catalog_scope','catalog_scope_hash','api_key_id']::text[],ARRAY['catalog_scope','catalog_scope_hash','api_key_id']::text[]),
  ('b2b_accounts',ARRAY['id','tenant_id','name','version','active','warehouse_id','price_list_id']::text[],ARRAY[]::text[]),
  ('b2b_links',ARRAY['id','tenant_id','version','supplier_tenant_id','supplier_name','account_id','paused','schedule_minutes']::text[],ARRAY[]::text[])
 )x(table_name,cols,nullable) CROSS JOIN LATERAL unnest(x.cols)y(col)
 WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||x.table_name) AND a.attname=y.col AND NOT a.attisdropped AND a.attnotnull=(NOT(y.col=ANY(x.nullable))))) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['b2b_catalog_scope_installed()','b2b_catalog_scope_hash(jsonb)','b2b_catalog_scope_lock()','b2b_catalog_scope_access(uuid,uuid,text,boolean)','b2b_catalog_scope_budget(uuid)','b2b_catalog_scope_request_valid(text,jsonb)','b2b_catalog_scope_frame(text,uuid,jsonb)','b2b_catalog_scope_preview(uuid,uuid,text,uuid,jsonb)','b2b_catalog_scope_commit(uuid,uuid,uuid,jsonb)','b2b_catalog_scope_require(uuid,uuid,text,boolean)','b2b_catalog_scope_immutable()','b2b_catalog_scope_sidecar_guard()','b2b_catalog_scope_complete()','b2b_catalog_scope_entity_guard()','b2b_catalog_scope_run_pair(uuid,uuid)','b2b_catalog_scope_run_guard()','b2b_catalog_scope_binding_guard()','b2b_catalog_scope_bound_item_guard()','b2b_catalog_scope_guards()'])x(sig)
 WHERE to_regprocedure('public.'||x.sig) IS NULL OR has_function_privilege('dyna_app',to_regprocedure('public.'||x.sig),'EXECUTE')
 OR EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=to_regprocedure('public.'||x.sig) AND a.grantee=0 AND a.privilege_type='EXECUTE')) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM(VALUES
 ('b2b_supplier_catalog_scope_guard','b2b_supplier_catalog_scopes','b2b_catalog_scope_sidecar_guard()',false),('b2b_buyer_catalog_scope_guard','b2b_buyer_catalog_scopes','b2b_catalog_scope_sidecar_guard()',false),
 ('b2b_catalog_scope_preview_immutable','b2b_catalog_scope_previews','b2b_catalog_scope_immutable()',false),('b2b_catalog_scope_operation_immutable','b2b_catalog_scope_operations','b2b_catalog_scope_immutable()',false),('b2b_catalog_scope_admission_immutable','b2b_catalog_scope_admissions','b2b_catalog_scope_immutable()',false),
 ('b2b_catalog_scope_admission_complete','b2b_catalog_scope_admissions','b2b_catalog_scope_complete()',true),('b2b_catalog_scope_operation_complete','b2b_catalog_scope_operations','b2b_catalog_scope_complete()',true),
 ('b2b_catalog_scope_account_guard','b2b_accounts','b2b_catalog_scope_entity_guard()',false),('b2b_catalog_scope_link_guard','b2b_links','b2b_catalog_scope_entity_guard()',false),
 ('b2b_catalog_scope_run_guard','b2b_catalog_runs','b2b_catalog_scope_run_guard()',false),('b2b_catalog_scope_binding_guard','b2b_catalog_bindings','b2b_catalog_scope_binding_guard()',false),('b2b_catalog_scope_bound_item_guard','b2b_catalog_items','b2b_catalog_scope_bound_item_guard()',false))x(name,tbl,fn,deferred)
 WHERE NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=to_regclass('public.'||x.tbl) AND g.tgname=x.name AND g.tgfoid=to_regprocedure('public.'||x.fn) AND g.tgenabled='O' AND NOT g.tgisinternal AND g.tgdeferrable=x.deferred AND g.tginitdeferred=x.deferred)) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.b2b_catalog_runs'::regclass AND tgname='b2b_catalog_scope_run_guard'
  AND tgfoid=to_regprocedure('public.b2b_catalog_scope_run_guard()') AND tgtype=31 AND tgenabled='O' AND NOT tgisinternal) THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_constraint WHERE conrelid=ANY(ARRAY(SELECT to_regclass('public.'||x) FROM unnest(tables)x)) AND contype='f')<>32
 OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY(SELECT to_regclass('public.'||x) FROM unnest(tables)x)) AND contype='f' AND NOT convalidated) THEN RETURN false;END IF;
 --142 replaces assignment rows within its atomic configuration transaction.
 --The exact supplier resources must still exist at flush/COMMIT, not between
 --its DELETE and matching INSERT. Missing/immediate/wrong-tuple FKs fail closed.
 IF EXISTS(SELECT 1 FROM(VALUES
  ('product_catalog_warehouses',ARRAY['tenant_id','catalog_id','warehouse_id']::text[],ARRAY['tenant_id','catalog_id','warehouse_id']::text[]),
  ('product_catalog_price_lists',ARRAY['tenant_id','catalog_id','price_list_id']::text[],ARRAY['tenant_id','catalog_id','price_list_id']::text[]),
  ('product_catalog_languages',ARRAY['tenant_id','catalog_id','language']::text[],ARRAY['tenant_id','catalog_id','locale']::text[])
 )x(target,src,dst) WHERE NOT EXISTS(SELECT 1 FROM pg_constraint fk WHERE fk.conrelid='public.b2b_supplier_catalog_scopes'::regclass
  AND fk.contype='f' AND fk.convalidated AND fk.condeferrable AND fk.condeferred AND fk.confrelid=to_regclass('public.'||x.target)
  AND fk.conkey=ARRAY(SELECT a.attnum FROM unnest(x.src) WITH ORDINALITY u(name,ord) JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attname=u.name AND NOT a.attisdropped ORDER BY u.ord)
  AND fk.confkey=ARRAY(SELECT a.attnum FROM unnest(x.dst) WITH ORDINALITY u(name,ord) JOIN pg_attribute a ON a.attrelid=fk.confrelid AND a.attname=u.name AND NOT a.attisdropped ORDER BY u.ord))) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.b2b_catalog_runs'::regclass AND conname='b2b_catalog_run_scope_shape' AND contype='c' AND convalidated)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.b2b_catalog_runs'::regclass AND conname='b2b_catalog_run_scope_key' AND contype='f' AND convalidated
  AND confrelid='public.api_keys'::regclass
  AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.b2b_catalog_runs'::regclass AND attname='tenant_id'),(SELECT attnum FROM pg_attribute WHERE attrelid='public.b2b_catalog_runs'::regclass AND attname='api_key_id')]::smallint[]
  AND confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.api_keys'::regclass AND attname='tenant_id'),(SELECT attnum FROM pg_attribute WHERE attrelid='public.api_keys'::regclass AND attname='id')]::smallint[]) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM(VALUES ('b2b_supplier_catalog_scopes',1,1,4),('b2b_buyer_catalog_scopes',1,1,3),('b2b_catalog_scope_previews',1,3,7),('b2b_catalog_scope_operations',1,4,4),('b2b_catalog_scope_admissions',1,2,2),('b2b_catalog_bindings',1,3,5))x(tbl,pks,uniques,checks)
 WHERE(SELECT count(*) FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||x.tbl) AND c.contype='p')<>x.pks
 OR(SELECT count(*) FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||x.tbl) AND c.contype='u')<>x.uniques
 OR(SELECT count(*) FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||x.tbl) AND c.contype='c' AND c.convalidated)<>x.checks) THEN RETURN false;END IF;
 RETURN true;
END $$;
CREATE FUNCTION b2b_catalog_scope_require(uid uuid,kid uuid,side text,pin boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF NOT public.b2b_catalog_scope_guards() THEN RAISE EXCEPTION 'Niekompletny zakres katalogów B2B' USING ERRCODE='55000';END IF;
 RETURN public.b2b_catalog_scope_access(uid,kid,side,pin);
END $$;
DO $$ DECLARE fn regprocedure;BEGIN
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'b2b_catalog_scope_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn);
 END LOOP;
END $$;
-- No GRANT EXECUTE, no routes, no db registry, no existing account/link/product backfill.
-- HTTP service must eventually flush constraints, hydrate immutable result, then
-- invoke require(...,pin=true) on the same client; raw principal/final-PIN remain OPEN.
