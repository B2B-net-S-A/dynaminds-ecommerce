-- ALTERNATIVE FULL COUNT BLOCK: replaces the base count fragment in152.
-- Never apply after the base tables/functions or an already adopted ledger.
-- Native086 bulk and115/116 file count parents; no physical writes/backfill.
CREATE TABLE catalog_stock_count_admissions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,
 protocol text NOT NULL CHECK(protocol IN('inventory_bulk','stock_file')),source_id uuid NOT NULL,count_receipt_id uuid NOT NULL,
 inventory_preview_id uuid,stock_file_preview_id uuid,request jsonb NOT NULL,frame jsonb NOT NULL,numbers jsonb NOT NULL,
 txid xid8 NOT NULL DEFAULT pg_current_xact_id(),sealed boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,count_receipt_id),UNIQUE(tenant_id,protocol,source_id),
 FOREIGN KEY(tenant_id,id) REFERENCES public.catalog_stock_control_effect_admissions(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,inventory_preview_id) REFERENCES public.inventory_bulk_edit_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,stock_file_preview_id) REFERENCES public.stock_file_import_previews(tenant_id,id),
 CHECK((protocol='inventory_bulk' AND inventory_preview_id IS NOT NULL AND inventory_preview_id=source_id AND stock_file_preview_id IS NULL)
 OR(protocol='stock_file' AND stock_file_preview_id IS NOT NULL AND stock_file_preview_id=source_id AND inventory_preview_id IS NULL))
);
CREATE TABLE catalog_stock_count_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,admission_id uuid NOT NULL,inventory_execution_id uuid,stock_file_execution_id uuid,
 proof jsonb NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,admission_id),FOREIGN KEY(tenant_id,admission_id) REFERENCES public.catalog_stock_count_admissions(tenant_id,id),
 FOREIGN KEY(tenant_id,inventory_execution_id) REFERENCES public.inventory_bulk_edit_executions(tenant_id,id),
 FOREIGN KEY(tenant_id,stock_file_execution_id) REFERENCES public.stock_file_import_executions(tenant_id,id),
 CHECK((inventory_execution_id IS NULL)<>(stock_file_execution_id IS NULL))
);
CREATE TABLE catalog_stock_count_documents(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,warehouse_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('PW','RW')),series_id uuid NOT NULL,year integer NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),
 number text NOT NULL,payload jsonb NOT NULL,UNIQUE(tenant_id,id),UNIQUE(tenant_id,receipt_id,warehouse_id,kind),
 UNIQUE(tenant_id,series_id,year,sequence),FOREIGN KEY(tenant_id,receipt_id) REFERENCES public.catalog_stock_count_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES public.warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,series_id,year) REFERENCES public.catalog_stock_control_counters(tenant_id,series_id,year)
);
CREATE TABLE catalog_stock_count_rows(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,document_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),
 warehouse_id uuid NOT NULL,product_id uuid NOT NULL,location text NOT NULL,delta integer NOT NULL CHECK(delta<>0),
 bin_movement_id uuid,layer_movement_id uuid,source_index integer CHECK(source_index>=0),
 stocktake_line_id uuid,stocktake_posting_id uuid,payload jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id,ordinal),UNIQUE(tenant_id,bin_movement_id),UNIQUE(tenant_id,layer_movement_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.catalog_stock_count_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES public.products(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location) REFERENCES public.stock_locations(tenant_id,warehouse_id,product_id,location),
 FOREIGN KEY(tenant_id,bin_movement_id) REFERENCES public.stock_location_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,layer_movement_id) REFERENCES public.wms_layer_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,stocktake_line_id,product_id) REFERENCES public.wms_stocktake_lines(tenant_id,id,product_id),
 FOREIGN KEY(tenant_id,stocktake_posting_id) REFERENCES public.wms_stocktake_postings(tenant_id,id),
 CHECK((bin_movement_id IS NOT NULL AND layer_movement_id IS NULL AND source_index IS NULL AND stocktake_line_id IS NULL AND stocktake_posting_id IS NULL)
 OR(bin_movement_id IS NULL AND layer_movement_id IS NOT NULL AND source_index IS NOT NULL AND stocktake_line_id IS NOT NULL AND stocktake_posting_id IS NOT NULL))
);
-- ON lot rows prove signed layer effects. Bin maps allocate only the net
-- bin journal actually emitted by092; a net0 cell has no bin map or journal.
CREATE TABLE catalog_stock_count_bin_maps(
 tenant_id uuid NOT NULL,row_id uuid NOT NULL,bin_movement_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tenant_id,row_id,bin_movement_id),
 FOREIGN KEY(tenant_id,row_id) REFERENCES public.catalog_stock_count_rows(tenant_id,id),
 FOREIGN KEY(tenant_id,bin_movement_id) REFERENCES public.stock_location_movements(tenant_id,id)
);
-- A stock map is an explicit allocation of a signed net aggregate, not an
-- invented original journal relation. Opposite bins can have net0/no stock map.
CREATE TABLE catalog_stock_count_stock_maps(
 tenant_id uuid NOT NULL,row_id uuid NOT NULL,stock_movement_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tenant_id,row_id,stock_movement_id),FOREIGN KEY(tenant_id,row_id) REFERENCES public.catalog_stock_count_rows(tenant_id,id),
 FOREIGN KEY(tenant_id,stock_movement_id) REFERENCES public.stock_movements(tenant_id,id)
);
CREATE TABLE catalog_stock_count_layer_maps(
 tenant_id uuid NOT NULL,row_id uuid NOT NULL,layer_movement_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,row_id,layer_movement_id),FOREIGN KEY(tenant_id,row_id) REFERENCES public.catalog_stock_count_rows(tenant_id,id),
 FOREIGN KEY(tenant_id,layer_movement_id) REFERENCES public.wms_layer_movements(tenant_id,id)
);
CREATE TABLE catalog_stock_count_native_maps(
 tenant_id uuid NOT NULL,row_id uuid NOT NULL,source_index integer NOT NULL CHECK(source_index>=0),quantity integer NOT NULL CHECK(quantity>0),
 inventory_execution_id uuid,inventory_row_index integer,stock_file_execution_id uuid,
 PRIMARY KEY(tenant_id,row_id,source_index),FOREIGN KEY(tenant_id,row_id) REFERENCES public.catalog_stock_count_rows(tenant_id,id),
 FOREIGN KEY(tenant_id,inventory_execution_id,inventory_row_index) REFERENCES public.inventory_bulk_edit_execution_rows(tenant_id,execution_id,index),
 FOREIGN KEY(tenant_id,stock_file_execution_id) REFERENCES public.stock_file_import_executions(tenant_id,id),
 CHECK((inventory_execution_id IS NOT NULL AND inventory_row_index IS NOT NULL AND inventory_row_index=source_index AND stock_file_execution_id IS NULL)
 OR(inventory_execution_id IS NULL AND inventory_row_index IS NULL AND stock_file_execution_id IS NOT NULL))
);
CREATE TABLE catalog_stock_count_manifest(id boolean PRIMARY KEY DEFAULT true CHECK(id),fingerprint text NOT NULL);
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['admissions','receipts','documents','rows','bin_maps','stock_maps','layer_maps','native_maps','manifest'] LOOP
 EXECUTE format('ALTER TABLE public.catalog_stock_count_%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE public.catalog_stock_count_%I FORCE ROW LEVEL SECURITY',n);
 IF n<>'manifest' THEN EXECUTE format('CREATE POLICY owner_scope ON public.catalog_stock_count_%I TO %I USING(true) WITH CHECK(true)',n,current_user);END IF;
 EXECUTE format('REVOKE ALL ON public.catalog_stock_count_%I FROM PUBLIC,dyna_app',n);
 END LOOP;
END $$;
-- Full portable schema/function/source-trigger witness. It deliberately pins
-- the OLD native-source seal additions as well as all new private objects.
CREATE FUNCTION catalog_stock_count_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
SELECT public.catalog_stock_control_hash(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl_grant),
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',x.attname,'type',format_type(x.atttypid,x.atttypmod),'notnull',x.attnotnull,'generated',x.attgenerated,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(x.attacl) acl_grant),'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum)
 FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid,true) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles)r),
 'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.relname)
 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND left(c.relname,20)='catalog_stock_count_' AND c.relkind='r'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',oidvectortypes(p.proargtypes),'defaults',pg_get_expr(p.proargdefaults,0),'body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'sd',p.prosecdef,'config',p.proconfig,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl_grant),'volatility',p.provolatile) ORDER BY p.proname,oidvectortypes(p.proargtypes))
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,20)='catalog_stock_count_'),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'type',t.tgtype,'enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid,true)) ORDER BY c.relname,t.tgname)
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND left(p.proname,20)='catalog_stock_count_'))) $$;

CREATE FUNCTION catalog_stock_count_guards() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ownerid oid:=(SELECT proowner FROM pg_proc WHERE oid='public.catalog_stock_count_guards()'::regprocedure);nm text;
BEGIN
 IF NOT public.catalog_stock_control_installed() OR
 (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND left(relname,20)='catalog_stock_count_' AND relkind='r')<>9 OR
 (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND left(proname,20)='catalog_stock_count_')<>22 THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND left(c.relname,20)='catalog_stock_count_' AND c.relkind='r' AND
 (c.relowner<>ownerid OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR EXISTS(SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE a.grantee<>ownerid)
 OR EXISTS(SELECT FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl)a WHERE x.attrelid=c.oid AND a.grantee<>ownerid)
 OR(c.relname='catalog_stock_count_manifest' AND EXISTS(SELECT FROM pg_policy WHERE polrelid=c.oid))
 OR(c.relname<>'catalog_stock_count_manifest' AND(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)<>1))) OR
 EXISTS(SELECT FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,20)='catalog_stock_count_' AND
 (p.proowner<>ownerid OR NOT p.prosecdef OR EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE a.grantee<>ownerid))) THEN RETURN false;END IF;
 FOREACH nm IN ARRAY ARRAY['access','frame','prepare','child_scope','operation_key','location_scope','journal_proof','native_snapshot','lot_witnesses','lot_validate','finish','validate','budget','abandon','immutable','admission_guard','record_guard','complete','source_seal','fingerprint','guards','require'] LOOP
 IF NOT EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='catalog_stock_count_'||nm) THEN RETURN false;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT FROM pg_constraint k WHERE k.conrelid=to_regclass('public.catalog_stock_control_effects') AND k.confrelid='public.catalog_stock_count_receipts'::regclass AND k.contype='f' AND k.convalidated
 AND(SELECT array_agg(x.attname::text ORDER BY v.ord) FROM unnest(k.conkey) WITH ORDINALITY v(att,ord) JOIN pg_attribute x ON(x.attrelid,x.attnum)=(k.conrelid,v.att))=ARRAY['tenant_id','count_receipt_id']
 AND(SELECT array_agg(x.attname::text ORDER BY v.ord) FROM unnest(k.confkey) WITH ORDINALITY v(att,ord) JOIN pg_attribute x ON(x.attrelid,x.attnum)=(k.confrelid,v.att))=ARRAY['tenant_id','id']) THEN RETURN false;END IF;
 IF to_regprocedure('public.catalog_stock_control_effect_validate(uuid)') IS NULL OR to_regprocedure('public.catalog_stock_control_counter_complete()') IS NULL OR
 position('PERFORM public.catalog_stock_count_validate(eid);' IN(SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.catalog_stock_control_effect_validate(uuid)')))=0 OR
 position('FROM public.catalog_stock_count_documents WHERE(tenant_id,series_id,year)=(NEW.tenant_id,NEW.series_id,NEW.year)' IN(SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.catalog_stock_control_counter_complete()')))=0 THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND t.tgenabled IN('O','A') AND p.pronamespace='public'::regnamespace AND left(p.proname,20)='catalog_stock_count_')<>25 THEN RETURN false;END IF;
 RETURN coalesce((SELECT fingerprint=public.catalog_stock_count_fingerprint() FROM public.catalog_stock_count_manifest WHERE id),false);
END $$;
CREATE FUNCTION catalog_stock_count_require() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.catalog_stock_control_require();IF NOT public.catalog_stock_count_guards() THEN RAISE EXCEPTION 'Niekompletny typowany publisher pomiarów PW/RW' USING ERRCODE='55000';END IF;END $$;
CREATE INDEX catalog_stock_count_actor ON catalog_stock_count_admissions(actor_id);
CREATE INDEX catalog_stock_count_key ON catalog_stock_count_admissions(tenant_id,api_key_id);
CREATE INDEX catalog_stock_count_inventory_preview ON catalog_stock_count_admissions(tenant_id,inventory_preview_id);
CREATE INDEX catalog_stock_count_file_preview ON catalog_stock_count_admissions(tenant_id,stock_file_preview_id);
CREATE INDEX catalog_stock_count_inventory_execution ON catalog_stock_count_receipts(tenant_id,inventory_execution_id);
CREATE INDEX catalog_stock_count_file_execution ON catalog_stock_count_receipts(tenant_id,stock_file_execution_id);
CREATE INDEX catalog_stock_count_document_history ON catalog_stock_count_documents(tenant_id,warehouse_id,id);
CREATE INDEX catalog_stock_count_row_product ON catalog_stock_count_rows(tenant_id,product_id);
CREATE INDEX catalog_stock_count_stock_journal ON catalog_stock_count_stock_maps(tenant_id,stock_movement_id);
CREATE INDEX catalog_stock_count_layer_journal ON catalog_stock_count_layer_maps(tenant_id,layer_movement_id);
CREATE INDEX catalog_stock_count_bin_journal ON catalog_stock_count_bin_maps(tenant_id,bin_movement_id);
CREATE INDEX catalog_stock_count_native_inventory ON catalog_stock_count_native_maps(tenant_id,inventory_execution_id,inventory_row_index);
CREATE INDEX catalog_stock_count_native_file ON catalog_stock_count_native_maps(tenant_id,stock_file_execution_id);

CREATE FUNCTION catalog_stock_count_access(uid uuid,kid uuid,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k public.api_keys;onw boolean;sc text[];
BEGIN
 IF b->>'protocol' NOT IN('inventory_bulk','stock_file') OR b->>'source_id' IS NULL THEN RAISE EXCEPTION 'Nieznany protokół pomiaru' USING ERRCODE='23514';END IF;
 SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid);
 IF r IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Pomiar wymaga administratora' USING ERRCODE='42501';END IF;
 SELECT coalesce((SELECT enabled FROM public.wms_policies WHERE tenant_id=t),false) INTO onw;
 sc:=ARRAY['products:read','inventory:read','inventory:write'];
 IF onw AND b->>'protocol'='stock_file' THEN sc:=sc||ARRAY['purchasing:read','purchasing:write'];END IF;
 IF kid IS NOT NULL THEN
 SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);
 IF k.id IS NULL OR k.revoked_at IS NOT NULL OR(k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Klucz pomiaru cofnięty lub wygasł' USING ERRCODE='28000';END IF;
 IF NOT k.scopes @> sc THEN RAISE EXCEPTION 'Brak właściwych scopes pomiaru' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('admin_only',true,'scopes',to_jsonb(sc));
END $$;

-- Reads the actual frozen native preview. No client product/warehouse/cost list
-- is authoritative. Current physical CAS remains native086 or115/116 authority.
CREATE FUNCTION catalog_stock_count_frame(uid uuid,kid uuid,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.inventory_bulk_edit_previews;
 fp public.stock_file_import_previews;ie public.inventory_bulk_edit_executions;fe public.stock_file_import_executions;
 a public.catalog_stock_count_admissions;receipt public.catalog_stock_count_receipts;rs jsonb;rowsj jsonb;productsj jsonb;
 requirements jsonb;native jsonb;historical boolean:=false;whj jsonb;psj jsonb;onw boolean;h text;
BEGIN
 requirements:=public.catalog_stock_count_access(uid,kid,b);
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR NOT b ?& ARRAY['protocol','source_id','request'] OR
 EXISTS(SELECT FROM jsonb_object_keys(b)x WHERE x NOT IN('protocol','source_id','request')) OR
 jsonb_typeof(b->'request') IS DISTINCT FROM 'object' OR b#>>'{request,confirmed}' IS DISTINCT FROM 'true' OR
 b#>>'{request,client_key}' IS NULL OR b#>>'{request,scope_hash}' IS NULL THEN RAISE EXCEPTION 'Niepełna zgoda pomiaru' USING ERRCODE='23514';END IF;
 IF b->>'protocol'='inventory_bulk' THEN
 SELECT * INTO p FROM public.inventory_bulk_edit_previews WHERE(tenant_id,id)=(t,(b->>'source_id')::uuid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego podglądu pomiaru' USING ERRCODE='P0002';END IF;
 IF p.actor_id IS DISTINCT FROM uid OR p.scope_hash IS DISTINCT FROM b#>>'{request,scope_hash}' OR NOT p.ready OR
 EXISTS(SELECT FROM jsonb_object_keys(b->'request')x WHERE x NOT IN('client_key','scope_hash','confirmed')) THEN RAISE EXCEPTION 'Brak własnego gotowego podglądu pomiaru' USING ERRCODE='23514';END IF;
 SELECT * INTO ie FROM public.inventory_bulk_edit_executions WHERE tenant_id=t AND(client_key=(b#>>'{request,client_key}')::uuid OR preview_id=p.id);
 h:=public.stock_file_import_hash(jsonb_build_object('source',p.source,'request',jsonb_build_object('preview_id',p.id)||(b->'request')));
 IF ie.id IS NOT NULL THEN
 IF ie.actor_id IS DISTINCT FROM uid OR ie.preview_id<>p.id OR ie.client_key::text IS DISTINCT FROM b#>>'{request,client_key}' OR ie.request_hash<>h THEN RAISE EXCEPTION 'Inna historyczna zgoda pomiaru' USING ERRCODE='23514';END IF;
 historical:=true;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.index),'[]') INTO native FROM public.inventory_bulk_edit_rows x WHERE(x.tenant_id,x.preview_id)=(t,p.id);
 IF jsonb_array_length(native)<>p.total THEN RAISE EXCEPTION 'Niepełny rodzimy podgląd pomiaru' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('index',x->'index','warehouse_id',p.warehouse_id,'product_id',x->'product_id',
 'location',x->'location','delta',(x#>>'{input,quantity}')::integer-coalesce((x#>>'{before,quantity}')::integer,0)) ORDER BY (x->>'index')::integer),'[]') INTO rs
 FROM jsonb_array_elements(native)x WHERE x#>>'{input,operation}'='count' AND x->>'status' IN('changed','unchanged');
 onw:=false;native:=jsonb_build_object('head',to_jsonb(p),'rows',native);
 ELSE
 SELECT * INTO fp FROM public.stock_file_import_previews WHERE(tenant_id,id)=(t,(b->>'source_id')::uuid);
 IF fp.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego podglądu pliku' USING ERRCODE='P0002';END IF;
 IF fp.actor_id IS DISTINCT FROM uid OR fp.api_key_id IS DISTINCT FROM kid OR fp.scope_hash IS DISTINCT FROM b#>>'{request,scope_hash}' OR
 (fp.payload#>>'{summary,invalid}')::integer<>0 OR(fp.payload#>>'{summary,conflicts}')::integer<>0 OR
 EXISTS(SELECT FROM jsonb_object_keys(b->'request')x WHERE x NOT IN('client_key','scope_hash','confirmed','ack_unknown_loss_warehouse_ids','ack_surplus_warehouse_ids')) THEN RAISE EXCEPTION 'Brak własnego gotowego pliku pomiaru' USING ERRCODE='23514';END IF;
 SELECT * INTO fe FROM public.stock_file_import_executions WHERE tenant_id=t AND(client_key=(b#>>'{request,client_key}')::uuid OR preview_id=fp.id);
 IF fe.id IS NOT NULL THEN
 IF fe.actor_id IS DISTINCT FROM uid OR fe.api_key_id IS DISTINCT FROM kid OR fe.preview_id<>fp.id OR fe.client_key::text IS DISTINCT FROM b#>>'{request,client_key}' OR fe.payload->'execute_request' IS DISTINCT FROM b->'request' THEN RAISE EXCEPTION 'Inna historyczna zgoda pliku' USING ERRCODE='23514';END IF;
 historical:=true;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('index',x->'index','warehouse_id',x->'warehouse_id','product_id',x->'product_id',
 'location',x->'location','line_id',x->'line_id','lot',x->'lot','fragments',x->'fragments',
 'delta',(x#>>'{input,quantity}')::integer-coalesce((x#>>'{before,quantity}')::integer,0)) ORDER BY (x->>'index')::integer),'[]') INTO rs
 FROM jsonb_array_elements(fp.payload->'rows')x WHERE x#>>'{input,operation}'='count' AND x->'position' IS NOT NULL AND x->'position'<>'null'::jsonb AND x->>'product_id' IS NOT NULL;
 onw:=(fp.payload#>>'{policy,enabled}')::boolean;native:=jsonb_build_object('head',to_jsonb(fp));
 END IF;
 IF historical THEN
 SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE(tenant_id,protocol,source_id)=(t,b->>'protocol',(b->>'source_id')::uuid);
 IF a.id IS NOT NULL THEN SELECT * INTO receipt FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(t,a.id);
 IF NOT a.sealed OR receipt.id IS NULL OR a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS DISTINCT FROM kid OR a.request IS DISTINCT FROM b->'request' THEN RAISE EXCEPTION 'Historyczny pomiar ma inny principal lub zgodę' USING ERRCODE='23514';END IF;END IF;
 RETURN jsonb_build_object('historical',true,'requirements',requirements);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',warehouse_id,'product_id',product_id,'location',location,'delta',delta) ORDER BY warehouse_id,product_id,location),'[]') INTO rowsj
 FROM(SELECT x->>'warehouse_id' warehouse_id,x->>'product_id' product_id,x->>'location' location,sum((x->>'delta')::bigint) delta FROM jsonb_array_elements(rs)x GROUP BY 1,2,3 HAVING sum((x->>'delta')::bigint)<>0)z;
 SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') INTO whj FROM(SELECT DISTINCT x->>'warehouse_id'v FROM jsonb_array_elements(rs)x)z;
 SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') INTO psj FROM(SELECT DISTINCT x->>'product_id'v FROM jsonb_array_elements(rs)x)z;
 SELECT coalesce(jsonb_agg(to_jsonb(prod) ORDER BY prod.id),'[]') INTO productsj FROM public.products prod WHERE prod.tenant_id=t AND prod.id IN(SELECT v::uuid FROM jsonb_array_elements_text(psj)v);
 IF jsonb_array_length(productsj)<>jsonb_array_length(psj) OR jsonb_array_length(rs)>10000 OR octet_length(native::text)>33554432 THEN RAISE EXCEPTION 'Niepełny lub zbyt duży zakres pomiaru' USING ERRCODE='54000';END IF;
 RETURN jsonb_build_object('historical',false,'requirements',requirements,'native',native,'source_rows',rs,'bins',rowsj,'warehouse_ids',whj,'product_ids',psj,'products',productsj,'wms_enabled',onw);
END $$;

CREATE FUNCTION catalog_stock_count_prepare(uid uuid,kid uuid,b jsonb,native_zone text DEFAULT current_setting('TimeZone')) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f jsonb;fresh jsonb;token jsonb;eid uuid:=gen_random_uuid();n record;
 s public.catalog_stock_control_series;seq bigint;yr integer:=extract(year FROM transaction_timestamp());numbers jsonb:='[]';
BEGIN
 PERFORM public.catalog_stock_count_require();
 IF native_zone IS NULL OR native_zone='' THEN RAISE EXCEPTION 'Brak kontekstu czasu rodzimego pomiaru' USING ERRCODE='23514';END IF;
 PERFORM set_config('TimeZone',native_zone,true);PERFORM set_config('TimeZone','UTC',true);
 f:=public.catalog_stock_count_frame(uid,kid,b);
 IF f->'historical' IS DISTINCT FROM 'true'::jsonb AND NOT EXISTS(SELECT FROM public.products p JOIN public.catalog_stock_control_policies h ON(h.tenant_id,h.catalog_id)=(p.tenant_id,p.catalog_id)
 WHERE p.tenant_id=t AND p.id IN(SELECT v::uuid FROM jsonb_array_elements_text(f->'product_ids')v)) THEN RETURN NULL;END IF;
 IF f->'historical'='true'::jsonb OR NOT EXISTS(SELECT FROM jsonb_array_elements(coalesce(f->'source_rows','[]'))sr WHERE(sr->>'delta')::bigint<>0) THEN
 -- Opposed lot deltas are not a NOP:092 folds their bin journal, so preserve
 -- this explicit unsupported physical-witness boundary even at net0.
 IF NOT coalesce((f->>'wms_enabled')::boolean,false) AND EXISTS(SELECT FROM jsonb_array_elements(coalesce(f->'source_rows','[]'))x WHERE (x->>'delta')::bigint<>0) THEN
 RAISE EXCEPTION 'Przeciwne pomiary partii w jednym binie wymagają osobnych podpisanych ruchów' USING ERRCODE='23514';END IF;
 RETURN NULL;END IF;
 token:=public.catalog_stock_control_effect_prepare(uid,kid,jsonb_build_object('source_kind','inventory_import','source_id',eid,
 'warehouse_ids',f->'warehouse_ids','product_ids',f->'product_ids'));
 IF token IS NULL THEN RETURN NULL;END IF;
 fresh:=public.catalog_stock_count_frame(uid,kid,b);
 -- An exact native execution may commit while this request waits for the
 -- generic strict quota. The fresh frame validates its principal and body;
 -- release the unused generic admission before allocating any number.
 IF fresh->'historical'='true'::jsonb THEN
 PERFORM public.catalog_stock_control_effect_abandon(uid,kid,(token->>'id')::uuid);
 RETURN NULL;
 END IF;
 IF f IS DISTINCT FROM fresh THEN RAISE EXCEPTION 'Źródło pomiaru zmieniło się podczas oczekiwania' USING ERRCODE='23514';END IF;
 f:=f||jsonb_build_object('native_timezone',native_zone);
 IF EXISTS(SELECT FROM jsonb_array_elements(f#>'{native,rows}')x WHERE x#>>'{input,operation}'='move') THEN
 RAISE EXCEPTION 'Mieszany pomiar i przesunięcie wymaga osobnego typowanego MM' USING ERRCODE='23514';END IF;
 IF NOT(f->>'wms_enabled')::boolean AND EXISTS(SELECT FROM jsonb_array_elements(f->'source_rows')x GROUP BY x->>'warehouse_id',x->>'product_id',x->>'location'
 HAVING bool_or((x->>'delta')::bigint>0) AND bool_or((x->>'delta')::bigint<0)) THEN
 RAISE EXCEPTION 'Przeciwne pomiary partii w jednym binie wymagają osobnych podpisanych ruchów' USING ERRCODE='23514';END IF;
 FOR n IN SELECT DISTINCT (x->>'warehouse_id')::uuid warehouse_id,CASE WHEN(x->>'delta')::bigint>0 THEN 'PW' ELSE 'RW' END kind
 FROM jsonb_array_elements(f->'source_rows')x WHERE(x->>'delta')::bigint<>0 ORDER BY 1,2 LOOP
 INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix)
 VALUES(gen_random_uuid(),t,n.warehouse_id,n.kind,n.kind,n.kind) ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;
 SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,n.warehouse_id,n.kind) FOR UPDATE;
 seq:=public.catalog_stock_control_next(t,s.id,yr);
 numbers:=numbers||jsonb_build_array(jsonb_build_object('warehouse_id',n.warehouse_id,'kind',n.kind,'series_id',s.id,'series',to_jsonb(s),'year',yr,'sequence',seq::text,
 'number',s.prefix||'/'||yr||'/'||(CASE WHEN length(seq::text)>=6 THEN seq::text ELSE lpad(seq::text,6,'0') END)));
 END LOOP;
 INSERT INTO public.catalog_stock_count_admissions(id,tenant_id,actor_id,api_key_id,protocol,source_id,count_receipt_id,inventory_preview_id,stock_file_preview_id,request,frame,numbers)
 VALUES((token->>'id')::uuid,t,uid,kid,b->>'protocol',(b->>'source_id')::uuid,eid,
 CASE WHEN b->>'protocol'='inventory_bulk' THEN(b->>'source_id')::uuid END,
 CASE WHEN b->>'protocol'='stock_file' THEN(b->>'source_id')::uuid END,b->'request',f,numbers);
 RETURN jsonb_build_object('id',token->>'id','tenant_id',t,'protocol',b->>'protocol','source_id',b->>'source_id',
 'warehouse_ids',f->'warehouse_ids','product_ids',f->'product_ids','requirements',f->'requirements');
END $$;

CREATE FUNCTION catalog_stock_count_child_scope(eid uuid,pid uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;s public.stock_file_import_admissions;
BEGIN
 PERFORM public.catalog_stock_count_require();SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 IF a.id IS NULL OR a.protocol<>'stock_file' OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR a.txid<>pg_current_xact_id() OR a.sealed THEN RETURN false;END IF;
 SELECT * INTO s FROM public.stock_file_import_admissions WHERE(tenant_id,preview_id)=(a.tenant_id,a.source_id);
 RETURN s.execution_id IS NOT NULL AND s.top_xid=pg_current_xact_id() AND s.actor_id=a.actor_id AND s.api_key_id IS NOT DISTINCT FROM a.api_key_id
 AND s.request=a.request AND EXISTS(SELECT FROM jsonb_array_elements(a.frame#>'{native,head,payload,targets}')t
 CROSS JOIN LATERAL jsonb_array_elements(t->'children')c WHERE c->>'id'=pid::text);
END $$;
CREATE FUNCTION catalog_stock_count_operation_key(pid uuid,ck uuid,idx integer) RETURNS uuid
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
 FROM(SELECT public.stock_file_import_hash(jsonb_build_object('preview_id',pid,'client_key',ck,'index',idx))h)x $$;
CREATE FUNCTION catalog_stock_count_location_scope(eid uuid,opkey uuid,wid uuid,pid uuid,kindj text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;
BEGIN
 PERFORM public.catalog_stock_count_require();SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 IF a.id IS NULL OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR a.txid<>pg_current_xact_id() OR a.sealed OR kindj<>'count' THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM public.inventory_bulk_edit_previews p JOIN public.inventory_bulk_edit_rows r ON(r.tenant_id,r.preview_id)=(p.tenant_id,p.id)
 WHERE p.tenant_id=a.tenant_id AND p.actor_id=a.actor_id AND p.ready AND p.warehouse_id=wid AND r.product_id=pid AND r.input->>'operation'='count' AND r.status='changed'
 AND((a.protocol='inventory_bulk' AND p.id=a.source_id AND opkey=public.catalog_stock_count_operation_key(p.id,(a.request->>'client_key')::uuid,r.index))
 OR(a.protocol='stock_file' AND public.catalog_stock_count_child_scope(eid,p.id) AND EXISTS(
 SELECT FROM jsonb_array_elements(a.frame#>'{native,head,payload,targets}')t CROSS JOIN LATERAL jsonb_array_elements(t->'children')ch
 WHERE ch->>'id'=p.id::text AND opkey=public.catalog_stock_count_operation_key(p.id,(ch->>'execute_key')::uuid,r.index)))))
 ;
END $$;

CREATE FUNCTION catalog_stock_count_journal_proof(eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_control_effect_admissions;f jsonb;answer jsonb:='{}';names text[]:=ARRAY['stock','bin','layer'];n text;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_control_effect_admissions WHERE id=eid;
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Brak aktualnego fizycznego źródła pomiaru' USING ERRCODE='23514';END IF;
 f:=public.catalog_stock_control_effect_frame(a.request);
 FOREACH n IN ARRAY names LOOP
 answer:=answer||jsonb_build_object(CASE n WHEN 'stock' THEN 'stock_movement_ids' WHEN 'bin' THEN 'location_movement_ids' ELSE 'layer_movement_ids' END,
 (SELECT coalesce(jsonb_agg(x->'id' ORDER BY x->>'id'),'[]') FROM jsonb_array_elements(f->(n||'_journals'))x
 WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(a.before_frame->(n||'_journals'))o WHERE o->'id'=x->'id')));
 END LOOP;
 RETURN answer;
END $$;

CREATE FUNCTION catalog_stock_count_native_snapshot(eid uuid,inventory_id uuid DEFAULT NULL,file_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;r public.catalog_stock_count_receipts;
 ie public.inventory_bulk_edit_executions;fe public.stock_file_import_executions;rs jsonb;native jsonb;prior_zone text;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 IF a.id IS NULL OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR a.txid<>pg_current_xact_id() THEN RAISE EXCEPTION 'Obcy lub nieaktualny zakres pomiaru' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(a.tenant_id,eid);
 IF r.id IS NULL THEN r.id:=a.count_receipt_id;r.inventory_execution_id:=inventory_id;r.stock_file_execution_id:=file_id;END IF;
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR r.id IS DISTINCT FROM a.count_receipt_id THEN RAISE EXCEPTION 'Brak aktualnego rodzica pomiaru' USING ERRCODE='23514';END IF;
 IF a.protocol='inventory_bulk' THEN
 SELECT * INTO ie FROM public.inventory_bulk_edit_executions WHERE(tenant_id,id)=(a.tenant_id,r.inventory_execution_id) AND xmin=pg_current_xact_id()::text::xid;
 IF ie.id IS NULL OR ie.actor_id<>a.actor_id OR ie.preview_id<>a.source_id OR ie.client_key::text IS DISTINCT FROM a.request->>'client_key'
 OR ie.scope_hash IS DISTINCT FROM a.request->>'scope_hash' OR ie.request_hash<>public.stock_file_import_hash(jsonb_build_object('source',a.frame#>>'{native,head,source}',
 'request',jsonb_build_object('preview_id',a.source_id)||a.request)) THEN RAISE EXCEPTION 'Obcy rodzic pomiaru zbiorczego' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.index),'[]') INTO rs FROM public.inventory_bulk_edit_execution_rows x WHERE(x.tenant_id,x.execution_id)=(a.tenant_id,ie.id);
 IF jsonb_array_length(rs)<>(a.frame#>>'{native,head,total}')::integer OR EXISTS(
 SELECT FROM jsonb_array_elements(a.frame#>'{native,rows}')f LEFT JOIN jsonb_array_elements(rs)x ON x->'index'=f->'index'
 WHERE x IS NULL OR(x->>'preview_id',x->>'product_id',x->>'location',x->>'sku',x->>'operation',x->>'status') IS DISTINCT FROM
 (a.source_id::text,f->>'product_id',f->>'location',f->>'sku',f#>>'{input,operation}',f->>'status') OR x->'before' IS DISTINCT FROM f->'before' OR x->'after' IS DISTINCT FROM f->'after'
 OR(x->>'before_stock_version')::bigint IS DISTINCT FROM(f#>>'{before,stock_version}')::bigint
 OR(x->>'after_stock_version')::bigint IS DISTINCT FROM(f#>>'{after,stock_version}')::bigint
 OR CASE WHEN f->>'status'='changed' THEN jsonb_array_length(x->'operation_ids')<>1 ELSE jsonb_array_length(x->'operation_ids')<>0 END) THEN
 RAISE EXCEPTION 'Niepełne oryginalne wiersze wykonania zbiorczego' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(rs)x CROSS JOIN LATERAL jsonb_array_elements_text(x->'operation_ids')v
 WHERE NOT EXISTS(SELECT FROM public.stock_location_operations o WHERE o.id=v::uuid AND o.tenant_id=a.tenant_id AND o.xmin=pg_current_xact_id()::text::xid AND o.result->>'kind'='count'
 AND o.idempotency_key=public.catalog_stock_count_operation_key(a.source_id,(a.request->>'client_key')::uuid,(x->>'index')::integer))) THEN
 RAISE EXCEPTION 'Brak rzeczywistej operacji rodzimego pomiaru' USING ERRCODE='23514';END IF;
 native:=jsonb_build_object('execution',to_jsonb(ie),'rows',rs,'preview',(SELECT to_jsonb(p) FROM public.inventory_bulk_edit_previews p WHERE(tenant_id,id)=(a.tenant_id,a.source_id)),
 'preview_rows',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.index) FROM public.inventory_bulk_edit_rows x WHERE(x.tenant_id,x.preview_id)=(a.tenant_id,a.source_id)));
 ELSE
 SELECT * INTO fe FROM public.stock_file_import_executions WHERE(tenant_id,id)=(a.tenant_id,r.stock_file_execution_id);
 IF fe.id IS NULL OR fe.top_xid<>pg_current_xact_id() OR fe.transaction_started_at<>transaction_timestamp() OR fe.actor_id<>a.actor_id OR fe.api_key_id IS DISTINCT FROM a.api_key_id
 OR fe.preview_id<>a.source_id OR fe.client_key::text IS DISTINCT FROM a.request->>'client_key' OR fe.payload->'execute_request' IS DISTINCT FROM a.request
 OR NOT EXISTS(SELECT FROM public.stock_file_import_admissions s WHERE(s.tenant_id,s.preview_id,s.execution_id,s.top_xid)=(a.tenant_id,a.source_id,fe.id,pg_current_xact_id())
 AND s.actor_id=a.actor_id AND s.api_key_id IS NOT DISTINCT FROM a.api_key_id AND s.request=a.request AND s.after_snapshot=fe.payload->'snapshot') THEN
 RAISE EXCEPTION 'Brak rzeczywistego pełnego wykonania pliku' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(a.frame->'native_timezone') IS DISTINCT FROM 'string' OR a.frame->>'native_timezone'='' THEN
 RAISE EXCEPTION 'Brak zapisanego kontekstu rodzimego pomiaru' USING ERRCODE='23514';END IF;
 prior_zone:=current_setting('TimeZone');
 BEGIN
 PERFORM set_config('TimeZone',a.frame->>'native_timezone',true);
 PERFORM public.stock_file_import_validate_execution(fe.payload);
 PERFORM set_config('TimeZone',prior_zone,true);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('TimeZone',prior_zone,true);RAISE;
 END;
 native:=jsonb_build_object('execution',to_jsonb(fe),'preview',(SELECT to_jsonb(p) FROM public.stock_file_import_previews p WHERE(tenant_id,id)=(a.tenant_id,a.source_id)),
 'admission',(SELECT to_jsonb(s) FROM public.stock_file_import_admissions s WHERE(s.tenant_id,s.preview_id)=(a.tenant_id,a.source_id)));
 END IF;
 IF a.protocol='inventory_bulk' AND(native->'preview' IS DISTINCT FROM a.frame#>'{native,head}' OR native->'preview_rows' IS DISTINCT FROM a.frame#>'{native,rows}')
 OR a.protocol='stock_file' AND native->'preview' IS DISTINCT FROM a.frame#>'{native,head}' THEN RAISE EXCEPTION 'Zmienione zapisane źródło pomiaru' USING ERRCODE='23514';END IF;
 RETURN native;
END $$;

-- Each frozen115 fragment is matched to exactly one current092 journal.
-- A shortage retains its original layer; a surplus proves the actual new
-- layer's stocktake_line_id, actual lot and reviewed declared cost.
CREATE FUNCTION catalog_stock_count_lot_witnesses(eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;r public.catalog_stock_count_receipts;
 sr jsonb;fr jsonb;linkj jsonb;posting public.wms_stocktake_postings;ln public.wms_stocktake_lines;
 rw public.wms_stocktake_review_rows;matches jsonb;witness jsonb;outj jsonb:='[]';ids jsonb;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(a.tenant_id,eid);
 IF a.id IS NULL OR r.id IS DISTINCT FROM a.count_receipt_id OR a.protocol<>'stock_file' OR
 a.txid<>pg_current_xact_id() OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
 OR a.frame->'wms_enabled' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Brak rzeczywistego ON rodzica partii' USING ERRCODE='23514';END IF;
 PERFORM public.catalog_stock_count_native_snapshot(eid);
 FOR sr IN SELECT value FROM jsonb_array_elements(a.frame->'source_rows') ORDER BY(value->>'index')::integer LOOP
 SELECT value INTO linkj FROM jsonb_array_elements(r.snapshot#>'{execution,payload,links}')
 WHERE value->>'warehouse_id'=sr->>'warehouse_id';
 SELECT * INTO posting FROM public.wms_stocktake_postings WHERE(tenant_id,id)=(a.tenant_id,(linkj->>'posting_id')::uuid);
 SELECT * INTO ln FROM public.wms_stocktake_lines WHERE(tenant_id,id)=(a.tenant_id,(sr->>'line_id')::uuid);
 SELECT * INTO rw FROM public.wms_stocktake_review_rows WHERE(tenant_id,review_id,line_id)=(a.tenant_id,posting.review_id,ln.id);
 IF posting.id IS NULL OR posting.actor_id IS DISTINCT FROM a.actor_id OR posting.operation_id::text IS DISTINCT FROM linkj->>'operation_id'
 OR NOT EXISTS(SELECT FROM public.wms_stocktake_postings nativep WHERE(nativep.tenant_id,nativep.id)=(a.tenant_id,posting.id)
 AND nativep.xmin=pg_current_xact_id()::text::xid) OR ln.stocktake_id IS DISTINCT FROM posting.stocktake_id
 OR ln.product_id::text IS DISTINCT FROM sr->>'product_id' OR ln.location IS DISTINCT FROM sr->>'location'
 OR ln.lot IS DISTINCT FROM sr->'lot' OR rw.fragments IS DISTINCT FROM sr->'fragments'
 OR((rw.after->>'quantity')::bigint-(rw.before->>'quantity')::bigint) IS DISTINCT FROM(sr->>'delta')::bigint THEN
 RAISE EXCEPTION 'Pozycja partii nie odpowiada rzeczywistemu przeglądowi i postingowi' USING ERRCODE='23514';END IF;
 IF(sr->>'delta')::bigint=0 AND jsonb_array_length(sr->'fragments')<>0 THEN RAISE EXCEPTION 'NOP partii ma signed fragmenty' USING ERRCODE='23514';END IF;
 FOR fr IN SELECT value FROM jsonb_array_elements(sr->'fragments') LOOP
 IF(fr->>'delta')::bigint=0 OR sign((fr->>'delta')::bigint)<>sign((sr->>'delta')::bigint)
 OR abs((fr->>'delta')::bigint) IS DISTINCT FROM(fr->>'quantity')::bigint THEN RAISE EXCEPTION 'Niezgodny znak rodzimego fragmentu' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('source_index',sr->'index','line_id',ln.id,'posting_id',posting.id,
 'review_id',posting.review_id,'warehouse_id',lm.warehouse_id,'product_id',lm.product_id,'location',lm.location,
 'layer_movement_id',lm.id,'layer_id',cl.id,'lot_id',cl.lot_id,'operation_id',lm.operation_id,'delta',lm.delta,
 'quantity',abs(lm.delta::bigint)::text,'unit_cost_minor',cl.unit_cost_minor::text,'currency',cl.currency,'exponent',cl.exponent,
 'value_minor',CASE WHEN cl.unit_cost_minor IS NULL THEN NULL ELSE(abs(lm.delta::bigint)*cl.unit_cost_minor)::text END) ORDER BY lm.id),'[]') INTO matches
 FROM public.wms_layer_movements lm JOIN public.wms_cost_layers cl ON(cl.tenant_id,cl.id,cl.product_id)=(lm.tenant_id,lm.layer_id,lm.product_id)
 WHERE(lm.tenant_id,lm.operation_id,lm.warehouse_id,lm.product_id,lm.location,lm.delta)=
 (a.tenant_id,posting.operation_id,(sr->>'warehouse_id')::uuid,ln.product_id,ln.location,(fr->>'delta')::integer)
 AND lm.kind='stocktake' AND lm.xmin=pg_current_xact_id()::text::xid AND lm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v)
 AND((ln.lot_id IS NOT NULL AND cl.lot_id=ln.lot_id) OR(ln.lot_id IS NULL AND EXISTS(
 SELECT FROM public.wms_lots lot WHERE(lot.tenant_id,lot.id,lot.product_id,lot.operation_id)=(a.tenant_id,cl.lot_id,ln.product_id,posting.operation_id)
 AND lot.lot_code IS NOT DISTINCT FROM ln.lot->>'lot_code' AND lot.expiry_date::text IS NOT DISTINCT FROM ln.lot->>'expiry_date'
 AND lot.xmin=pg_current_xact_id()::text::xid)))
 AND cl.unit_cost_minor::text IS NOT DISTINCT FROM fr->>'unit_cost_minor'
 AND cl.currency IS NOT DISTINCT FROM fr->>'currency' AND lm.value_delta IS NOT DISTINCT FROM lm.delta::bigint*cl.unit_cost_minor
 AND(((fr->>'delta')::integer<0 AND cl.id::text IS NOT DISTINCT FROM fr->>'layer_id'
 AND ln.original->'layer_ids' ? cl.id::text)
 OR((fr->>'delta')::integer>0 AND fr->>'layer_id' IS NULL AND cl.stocktake_line_id=ln.id
 AND cl.operation_id=posting.operation_id AND cl.xmin=pg_current_xact_id()::text::xid))
 AND EXISTS(SELECT FROM public.wms_operations op CROSS JOIN LATERAL jsonb_array_elements(op.result->'rows')oprow
 CROSS JOIN LATERAL jsonb_array_elements(oprow->'fragments')opf
 WHERE(op.tenant_id,op.id,op.stocktake_id,op.stocktake_posting_id,op.stocktake_review_id)=
 (a.tenant_id,posting.operation_id,posting.stocktake_id,posting.id,posting.review_id)
 AND op.kind='stocktake_post' AND op.actor_id=a.actor_id AND op.xmin=pg_current_xact_id()::text::xid
 AND(oprow->>'line_id',oprow->>'product_id',oprow->>'location',oprow->>'lot_id')=(ln.id::text,ln.product_id::text,ln.location,cl.lot_id::text)
 AND(opf->>'id',opf->>'line_id',opf->>'product_id',opf->>'location',opf->>'lot_id',opf->>'layer_id')=
 (lm.id::text,ln.id::text,ln.product_id::text,ln.location,cl.lot_id::text,cl.id::text)
 AND(opf->>'delta')::integer=lm.delta AND(opf->>'quantity')::integer=abs(lm.delta)
 AND opf->>'unit_cost_minor' IS NOT DISTINCT FROM cl.unit_cost_minor::text
 AND opf->>'currency' IS NOT DISTINCT FROM cl.currency AND(opf->>'value_delta')::bigint IS NOT DISTINCT FROM lm.value_delta);
 IF jsonb_array_length(matches)<>1 THEN RAISE EXCEPTION 'Fragment partii nie ma jednego rzeczywistego signed journalu' USING ERRCODE='23514';END IF;
 witness:=matches->0;
 IF EXISTS(SELECT FROM jsonb_array_elements(outj)oldw WHERE oldw->'layer_movement_id'=witness->'layer_movement_id') THEN
 RAISE EXCEPTION 'Podwójne pochodzenie signed journalu partii' USING ERRCODE='23514';END IF;
 outj:=outj||jsonb_build_array(witness);
 END LOOP;
 IF(SELECT coalesce(sum((z->>'delta')::bigint),0) FROM jsonb_array_elements(outj)z WHERE z->'source_index'=sr->'index') IS DISTINCT FROM(sr->>'delta')::bigint THEN
 RAISE EXCEPTION 'Niepełny signed pomiar oryginalnej pozycji' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(z->'layer_movement_id' ORDER BY z->>'layer_movement_id'),'[]') INTO ids FROM jsonb_array_elements(outj)z;
 IF ids IS DISTINCT FROM r.proof->'layer_movement_ids' THEN RAISE EXCEPTION 'Dodatkowy journal poza oryginalnymi partiami' USING ERRCODE='23514';END IF;
 RETURN outj;
END $$;

CREATE FUNCTION catalog_stock_count_lot_validate(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;r public.catalog_stock_count_receipts;ws jsonb;wr jsonb;rr public.catalog_stock_count_rows;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(a.tenant_id,eid);
 ws:=public.catalog_stock_count_lot_witnesses(eid);
 IF(SELECT count(*) FROM public.catalog_stock_count_rows cr JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id)
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,r.id))<>jsonb_array_length(ws) THEN RAISE EXCEPTION 'Niepełne signed wiersze partii PW/RW' USING ERRCODE='23514';END IF;
 FOR wr IN SELECT value FROM jsonb_array_elements(ws) LOOP
 SELECT cr.* INTO rr FROM public.catalog_stock_count_rows cr JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id)
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,r.id) AND cr.layer_movement_id=(wr->>'layer_movement_id')::uuid
 AND cd.kind=(CASE WHEN(wr->>'delta')::integer>0 THEN 'PW' ELSE 'RW' END);
 IF rr.id IS NULL OR rr.bin_movement_id IS NOT NULL OR(rr.warehouse_id,rr.product_id,rr.location,rr.delta,rr.source_index,rr.stocktake_line_id,rr.stocktake_posting_id)
 IS DISTINCT FROM((wr->>'warehouse_id')::uuid,(wr->>'product_id')::uuid,wr->>'location',(wr->>'delta')::integer,(wr->>'source_index')::integer,(wr->>'line_id')::uuid,(wr->>'posting_id')::uuid)
 OR rr.payload IS DISTINCT FROM wr||jsonb_build_object('sku',(SELECT prod->>'sku' FROM jsonb_array_elements(a.frame->'products')prod WHERE prod->>'id'=wr->>'product_id'),
 'name',(SELECT prod->>'name' FROM jsonb_array_elements(a.frame->'products')prod WHERE prod->>'id'=wr->>'product_id'),'bin_movement_id',null) THEN
 RAISE EXCEPTION 'Zmienione pochodzenie partii wiersza PW/RW' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.catalog_stock_count_native_maps nm WHERE(nm.tenant_id,nm.row_id)=(a.tenant_id,rr.id))<>1 OR
 NOT EXISTS(SELECT FROM public.catalog_stock_count_native_maps nm WHERE(nm.tenant_id,nm.row_id,nm.source_index,nm.quantity,nm.stock_file_execution_id)=
 (a.tenant_id,rr.id,rr.source_index,abs(rr.delta),r.stock_file_execution_id) AND nm.inventory_execution_id IS NULL AND nm.inventory_row_index IS NULL)
 OR(SELECT count(*) FROM public.catalog_stock_count_layer_maps lm WHERE(lm.tenant_id,lm.row_id)=(a.tenant_id,rr.id))<>1 OR
 NOT EXISTS(SELECT FROM public.catalog_stock_count_layer_maps lm WHERE(lm.tenant_id,lm.row_id,lm.layer_movement_id,lm.quantity)=(a.tenant_id,rr.id,rr.layer_movement_id,abs(rr.delta))
 AND lm.payload=wr-ARRAY['source_index','line_id','posting_id','review_id','warehouse_id','product_id','location','layer_movement_id','delta','quantity']) THEN
 RAISE EXCEPTION 'Niepełna typed alokacja oryginalnej partii' USING ERRCODE='23514';END IF;
 IF(SELECT coalesce(sum(sm.quantity),0) FROM public.catalog_stock_count_stock_maps sm WHERE(sm.tenant_id,sm.row_id)=(a.tenant_id,rr.id))>abs(rr.delta::bigint)
 OR(SELECT coalesce(sum(bm.quantity),0) FROM public.catalog_stock_count_bin_maps bm WHERE(bm.tenant_id,bm.row_id)=(a.tenant_id,rr.id))>abs(rr.delta::bigint) THEN
 RAISE EXCEPTION 'Nadmiar ilościowej alokacji net journalu do partii' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT FROM public.stock_location_movements bm WHERE bm.tenant_id=a.tenant_id AND bm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'location_movement_ids')v)
 AND(SELECT coalesce(sum(mp.quantity),0) FROM public.catalog_stock_count_bin_maps mp WHERE(mp.tenant_id,mp.bin_movement_id)=(a.tenant_id,bm.id))<>abs(bm.delta::bigint)) OR
 EXISTS(SELECT FROM public.catalog_stock_count_bin_maps mp JOIN public.catalog_stock_count_rows cr ON(cr.tenant_id,cr.id)=(mp.tenant_id,mp.row_id)
 JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id) JOIN public.stock_location_movements bm ON(bm.tenant_id,bm.id)=(mp.tenant_id,mp.bin_movement_id)
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,r.id) AND(bm.id NOT IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'location_movement_ids')v)
 OR(bm.warehouse_id,bm.product_id,bm.location,sign(bm.delta))<>(cr.warehouse_id,cr.product_id,cr.location,sign(cr.delta)))) THEN
 RAISE EXCEPTION 'Niezgodna rzeczywista alokacja net bin journalu' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.stock_movements sm WHERE sm.tenant_id=a.tenant_id AND sm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v)
 AND(SELECT coalesce(sum(mp.quantity),0) FROM public.catalog_stock_count_stock_maps mp WHERE(mp.tenant_id,mp.stock_movement_id)=(a.tenant_id,sm.id))<>abs(sm.delta::bigint)) OR
 EXISTS(SELECT FROM public.catalog_stock_count_stock_maps mp JOIN public.catalog_stock_count_rows cr ON(cr.tenant_id,cr.id)=(mp.tenant_id,mp.row_id)
 JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id) JOIN public.stock_movements sm ON(sm.tenant_id,sm.id)=(mp.tenant_id,mp.stock_movement_id)
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,r.id) AND(sm.id NOT IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v)
 OR(sm.warehouse_id,sm.product_id,sign(sm.delta))<>(cr.warehouse_id,cr.product_id,sign(cr.delta)))) THEN
 RAISE EXCEPTION 'Niezgodna rzeczywista alokacja net stock journalu' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION catalog_stock_count_finish(uid uuid,kid uuid,eid uuid,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;proof jsonb;native jsonb;n jsonb;did uuid;head jsonb;docs jsonb:='[]';k text;ws jsonb;
BEGIN
 PERFORM public.catalog_stock_count_require();SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid FOR UPDATE;
 IF a.id IS NULL OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS DISTINCT FROM kid
 OR a.txid<>pg_current_xact_id() OR a.sealed THEN RAISE EXCEPTION 'Obcy lub zamknięty token dokumentów pomiaru' USING ERRCODE='23514';END IF;
 PERFORM public.catalog_stock_count_access(uid,kid,jsonb_build_object('protocol',a.protocol,'source_id',a.source_id));
 IF EXISTS(SELECT FROM jsonb_object_keys(b)x WHERE x NOT IN('inventory_execution_id','stock_file_execution_id','stock_movement_ids','location_movement_ids','layer_movement_ids'))
 OR (a.protocol='inventory_bulk' AND(b->>'inventory_execution_id' IS NULL OR b->>'stock_file_execution_id' IS NOT NULL))
 OR (a.protocol='stock_file' AND(b->>'stock_file_execution_id' IS NULL OR b->>'inventory_execution_id' IS NOT NULL)) THEN RAISE EXCEPTION 'Nieznany typ rodzica pomiaru' USING ERRCODE='23514';END IF;
 proof:=public.catalog_stock_count_journal_proof(eid);
 FOREACH k IN ARRAY ARRAY['stock_movement_ids','location_movement_ids','layer_movement_ids'] LOOP
 IF jsonb_typeof(b->k) IS DISTINCT FROM 'array' OR (SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') FROM jsonb_array_elements(b->k)v) IS DISTINCT FROM proof->k THEN
 RAISE EXCEPTION 'Niepełne rzeczywiste dzienniki pomiaru' USING ERRCODE='23514';END IF;
 END LOOP;
 native:=public.catalog_stock_count_native_snapshot(eid,(b->>'inventory_execution_id')::uuid,(b->>'stock_file_execution_id')::uuid);
 INSERT INTO public.catalog_stock_count_receipts(id,tenant_id,admission_id,inventory_execution_id,stock_file_execution_id,proof,snapshot)
 VALUES(a.count_receipt_id,a.tenant_id,eid,(b->>'inventory_execution_id')::uuid,(b->>'stock_file_execution_id')::uuid,proof||jsonb_build_object('receipt_id',a.count_receipt_id),native);
 IF(a.frame->>'wms_enabled')::boolean THEN ws:=public.catalog_stock_count_lot_witnesses(eid);END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(a.numbers) LOOP
 did:=gen_random_uuid();
 IF(a.frame->>'wms_enabled')::boolean THEN
 SELECT jsonb_build_object('id',did,'receipt_id',a.count_receipt_id,'kind',n->'kind','number',n->'number','series_id',n->'series_id','year',n->'year','sequence',n->'sequence',
 'protocol',a.protocol,'source_id',a.source_id,'warehouse_id',n->'warehouse_id','row_count',count(*),'quantity',coalesce(sum(abs((wit->>'delta')::bigint)),0)::text,
 'wms_enabled',true,'created_at',transaction_timestamp(),'series',n->'series',
 'warehouse',(SELECT to_jsonb(wh) FROM public.warehouses wh WHERE(tenant_id,id)=(a.tenant_id,(n->>'warehouse_id')::uuid))) INTO head
 FROM jsonb_array_elements(ws)wit WHERE wit->>'warehouse_id'=n->>'warehouse_id' AND(CASE WHEN(wit->>'delta')::integer>0 THEN 'PW' ELSE 'RW' END)=n->>'kind';
 ELSE
 SELECT jsonb_build_object('id',did,'receipt_id',a.count_receipt_id,'kind',n->'kind','number',n->'number','series_id',n->'series_id','year',n->'year','sequence',n->'sequence',
 'protocol',a.protocol,'source_id',a.source_id,'warehouse_id',n->'warehouse_id','row_count',count(*),'quantity',coalesce(sum(abs(m.delta::bigint)),0)::text,
 'wms_enabled',a.frame->'wms_enabled','created_at',transaction_timestamp(),'series',n->'series',
 'warehouse',(SELECT to_jsonb(w) FROM public.warehouses w WHERE(tenant_id,id)=(a.tenant_id,(n->>'warehouse_id')::uuid))) INTO head
 FROM public.stock_location_movements m WHERE m.tenant_id=a.tenant_id AND m.warehouse_id=(n->>'warehouse_id')::uuid
 AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'location_movement_ids')v) AND (CASE WHEN m.delta>0 THEN 'PW' ELSE 'RW' END)=n->>'kind';
 END IF;
 IF(head->>'row_count')::integer=0 THEN RAISE EXCEPTION 'Numer nie ma rzeczywistego podpisanego ruchu' USING ERRCODE='23514';END IF;
 INSERT INTO public.catalog_stock_count_documents VALUES(did,a.tenant_id,a.count_receipt_id,(n->>'warehouse_id')::uuid,n->>'kind',(n->>'series_id')::uuid,(n->>'year')::integer,(n->>'sequence')::bigint,n->>'number',head);
 IF(a.frame->>'wms_enabled')::boolean THEN
 INSERT INTO public.catalog_stock_count_rows(id,tenant_id,document_id,ordinal,warehouse_id,product_id,location,delta,
 layer_movement_id,source_index,stocktake_line_id,stocktake_posting_id,payload)
 SELECT gen_random_uuid(),a.tenant_id,did,(row_number() OVER(ORDER BY(wit->>'source_index')::integer,wit->>'layer_movement_id')-1)::integer,
 (wit->>'warehouse_id')::uuid,(wit->>'product_id')::uuid,wit->>'location',(wit->>'delta')::integer,(wit->>'layer_movement_id')::uuid,
 (wit->>'source_index')::integer,(wit->>'line_id')::uuid,(wit->>'posting_id')::uuid,
 wit||jsonb_build_object('sku',prod->>'sku','name',prod->>'name','bin_movement_id',null)
 FROM jsonb_array_elements(ws)wit JOIN jsonb_array_elements(a.frame->'products')prod ON prod->>'id'=wit->>'product_id'
 WHERE wit->>'warehouse_id'=n->>'warehouse_id' AND(CASE WHEN(wit->>'delta')::integer>0 THEN 'PW' ELSE 'RW' END)=n->>'kind';
 ELSE
 INSERT INTO public.catalog_stock_count_rows(id,tenant_id,document_id,ordinal,warehouse_id,product_id,location,delta,bin_movement_id,payload)
 SELECT gen_random_uuid(),a.tenant_id,did,(row_number() OVER(ORDER BY m.product_id,m.location,m.id)-1)::integer,m.warehouse_id,m.product_id,m.location,m.delta,m.id,
 jsonb_build_object('product_id',m.product_id,'sku',p->>'sku','name',p->>'name','warehouse_id',m.warehouse_id,'location',m.location,'delta',m.delta,'quantity',abs(m.delta::bigint)::text,'bin_movement_id',m.id)
 FROM public.stock_location_movements m JOIN jsonb_array_elements(a.frame->'products')p ON p->>'id'=m.product_id::text
 WHERE m.tenant_id=a.tenant_id AND m.warehouse_id=(n->>'warehouse_id')::uuid AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'location_movement_ids')v)
 AND (CASE WHEN m.delta>0 THEN 'PW' ELSE 'RW' END)=n->>'kind';
 END IF;
 docs:=docs||jsonb_build_array(head);
 END LOOP;
 IF(a.frame->>'wms_enabled')::boolean THEN
 INSERT INTO public.catalog_stock_count_native_maps
 SELECT a.tenant_id,cr.id,cr.source_index,abs(cr.delta),null,null,(b->>'stock_file_execution_id')::uuid
 FROM public.catalog_stock_count_rows cr JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id)
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,a.count_receipt_id);
 INSERT INTO public.catalog_stock_count_layer_maps
 SELECT a.tenant_id,cr.id,cr.layer_movement_id,abs(cr.delta),wit-ARRAY['source_index','line_id','posting_id','review_id','warehouse_id','product_id','location','layer_movement_id','delta','quantity']
 FROM public.catalog_stock_count_rows cr JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id)
 JOIN jsonb_array_elements(ws)wit ON wit->>'layer_movement_id'=cr.layer_movement_id::text
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,a.count_receipt_id);
 ELSE
 -- Same-sign intervals: exact bin→native frozen counts and layer allocations.
 WITH rr AS MATERIALIZED(SELECT x.*,sum(abs(x.delta::bigint)) OVER(PARTITION BY x.warehouse_id,x.product_id,x.location,sign(x.delta) ORDER BY x.bin_movement_id)hi
 FROM public.catalog_stock_count_rows x JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id)),
 nn AS MATERIALIZED(SELECT (v->>'index')::integer idx,(v->>'warehouse_id')::uuid wh,(v->>'product_id')::uuid pid,v->>'location' loc,(v->>'delta')::bigint delta,
 sum(abs((v->>'delta')::bigint)) OVER(PARTITION BY v->>'warehouse_id',v->>'product_id',v->>'location',sign((v->>'delta')::bigint) ORDER BY(v->>'index')::integer)hi
 FROM jsonb_array_elements(a.frame->'source_rows')v WHERE(v->>'delta')::bigint<>0)
 INSERT INTO public.catalog_stock_count_native_maps
 SELECT a.tenant_id,x.id,n.idx,(least(x.hi,n.hi)-greatest(x.hi-abs(x.delta::bigint),n.hi-abs(n.delta)))::integer,
 (b->>'inventory_execution_id')::uuid,CASE WHEN a.protocol='inventory_bulk' THEN n.idx END,(b->>'stock_file_execution_id')::uuid
 FROM rr x JOIN nn n ON(n.wh,n.pid,n.loc,sign(n.delta))=(x.warehouse_id,x.product_id,x.location,sign(x.delta))
 AND x.hi>n.hi-abs(n.delta) AND n.hi>x.hi-abs(x.delta::bigint);
 END IF;
 WITH rr AS MATERIALIZED(SELECT x.*,sum(abs(x.delta::bigint)) OVER(PARTITION BY x.warehouse_id,x.product_id,sign(x.delta) ORDER BY x.location,coalesce(x.bin_movement_id,x.layer_movement_id))hi
 FROM public.catalog_stock_count_rows x JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id)),
 mm AS MATERIALIZED(SELECT m.*,sum(abs(m.delta::bigint)) OVER(PARTITION BY m.warehouse_id,m.product_id,sign(m.delta) ORDER BY m.id)hi FROM public.stock_movements m
 WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'stock_movement_ids')v))
 INSERT INTO public.catalog_stock_count_stock_maps SELECT a.tenant_id,x.id,m.id,(least(x.hi,m.hi)-greatest(x.hi-abs(x.delta::bigint),m.hi-abs(m.delta::bigint)))::integer
 FROM rr x JOIN mm m ON(m.warehouse_id,m.product_id,sign(m.delta))=(x.warehouse_id,x.product_id,sign(x.delta)) AND x.hi>m.hi-abs(m.delta::bigint) AND m.hi>x.hi-abs(x.delta::bigint);
 IF(a.frame->>'wms_enabled')::boolean THEN
 WITH rr AS MATERIALIZED(SELECT cr.*,sum(abs(cr.delta::bigint)) OVER(PARTITION BY cr.warehouse_id,cr.product_id,cr.location,sign(cr.delta) ORDER BY cr.layer_movement_id)hi
 FROM public.catalog_stock_count_rows cr JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id) WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,a.count_receipt_id)),
 mm AS MATERIALIZED(SELECT bm.*,sum(abs(bm.delta::bigint)) OVER(PARTITION BY bm.warehouse_id,bm.product_id,bm.location,sign(bm.delta) ORDER BY bm.id)hi
 FROM public.stock_location_movements bm WHERE bm.tenant_id=a.tenant_id AND bm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'location_movement_ids')v))
 INSERT INTO public.catalog_stock_count_bin_maps SELECT a.tenant_id,cr.id,bm.id,(least(cr.hi,bm.hi)-greatest(cr.hi-abs(cr.delta::bigint),bm.hi-abs(bm.delta::bigint)))::integer
 FROM rr cr JOIN mm bm ON(bm.warehouse_id,bm.product_id,bm.location,sign(bm.delta))=(cr.warehouse_id,cr.product_id,cr.location,sign(cr.delta))
 AND cr.hi>bm.hi-abs(bm.delta::bigint) AND bm.hi>cr.hi-abs(cr.delta::bigint);
 ELSE
 WITH rr AS MATERIALIZED(SELECT x.*,sum(abs(x.delta::bigint)) OVER(PARTITION BY x.warehouse_id,x.product_id,x.location,sign(x.delta) ORDER BY x.bin_movement_id)hi
 FROM public.catalog_stock_count_rows x JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id)),
 mm AS MATERIALIZED(SELECT m.*,sum(abs(m.delta::bigint)) OVER(PARTITION BY m.warehouse_id,m.product_id,m.location,sign(m.delta) ORDER BY m.id)hi FROM public.wms_layer_movements m
 WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'layer_movement_ids')v))
 INSERT INTO public.catalog_stock_count_layer_maps SELECT a.tenant_id,x.id,m.id,(least(x.hi,m.hi)-greatest(x.hi-abs(x.delta::bigint),m.hi-abs(m.delta::bigint)))::integer,
 jsonb_build_object('layer_id',l.id,'lot_id',l.lot_id,'operation_id',m.operation_id,'unit_cost_minor',l.unit_cost_minor::text,'currency',l.currency,'exponent',l.exponent,
 'value_minor',CASE WHEN l.unit_cost_minor IS NULL THEN NULL ELSE((least(x.hi,m.hi)-greatest(x.hi-abs(x.delta::bigint),m.hi-abs(m.delta::bigint)))*l.unit_cost_minor)::text END)
 FROM rr x JOIN mm m ON(m.warehouse_id,m.product_id,m.location,sign(m.delta))=(x.warehouse_id,x.product_id,x.location,sign(x.delta)) AND x.hi>m.hi-abs(m.delta::bigint) AND m.hi>x.hi-abs(x.delta::bigint)
 JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(m.tenant_id,m.layer_id,m.product_id);
 END IF;
 PERFORM public.catalog_stock_count_validate(eid);
 PERFORM public.catalog_stock_control_effect_finish(uid,kid,eid,proof||jsonb_build_object('receipt_id',a.count_receipt_id));
 UPDATE public.catalog_stock_count_admissions SET sealed=true WHERE id=eid;
 PERFORM public.catalog_stock_count_budget(a.tenant_id);
 RETURN jsonb_build_object('documents',docs);
END $$;

CREATE FUNCTION catalog_stock_count_validate(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;r public.catalog_stock_count_receipts;e public.catalog_stock_control_effects;
 wanted jsonb;actual jsonb;j jsonb;doc_record public.catalog_stock_count_documents;n jsonb;row_record record;native jsonb;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(a.tenant_id,eid);
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
 OR r.id IS DISTINCT FROM a.count_receipt_id THEN RAISE EXCEPTION 'Niekompletne dokumenty rodzimego pomiaru' USING ERRCODE='23514';END IF;
 native:=public.catalog_stock_count_native_snapshot(eid);
 IF r.snapshot IS DISTINCT FROM native OR r.proof IS DISTINCT FROM public.catalog_stock_count_journal_proof(eid)||jsonb_build_object('receipt_id',a.count_receipt_id) THEN
 RAISE EXCEPTION 'Zmieniony pełny dowód pomiaru' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM public.catalog_stock_control_effects WHERE(tenant_id,admission_id)=(a.tenant_id,eid);
 IF e.admission_id IS NOT NULL AND(e.proof IS DISTINCT FROM r.proof OR e.count_receipt_id IS DISTINCT FROM a.count_receipt_id) THEN
 RAISE EXCEPTION 'Efekt nie wskazuje typowanego rzeczywistego rodzica PW/RW' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_array(x->>'warehouse_id',x->>'product_id',x->>'location',(x->>'delta')::bigint) ORDER BY x->>'warehouse_id',x->>'product_id',x->>'location'),'[]') INTO wanted FROM jsonb_array_elements(a.frame->'bins')x;
 SELECT coalesce(jsonb_agg(jsonb_build_array(w::text,p::text,l,delta) ORDER BY w,p,l),'[]') INTO actual FROM
 (SELECT warehouse_id w,product_id p,location l,sum(delta::bigint)delta FROM public.stock_location_movements
 WHERE tenant_id=a.tenant_id AND id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'location_movement_ids')v) GROUP BY 1,2,3)z;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'Podpisane biny nie odpowiadają pełnemu zamrożonemu pomiarowi' USING ERRCODE='23514';END IF;
 FOR j IN SELECT to_jsonb(m) FROM public.stock_location_movements m WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'location_movement_ids')v) LOOP
 IF(j->>'delta')::integer=0 OR j->>'kind' IS DISTINCT FROM (CASE WHEN(a.frame->>'wms_enabled')::boolean THEN 'wms_stocktake' ELSE 'count' END) OR
 NOT EXISTS(SELECT FROM public.stock_location_movements m WHERE m.tenant_id=a.tenant_id AND m.id=(j->>'id')::uuid AND m.xmin=pg_current_xact_id()::text::xid) OR
 ((a.frame->>'wms_enabled')::boolean AND NOT EXISTS(SELECT FROM jsonb_array_elements(r.snapshot#>'{execution,payload,links}')lk WHERE lk->>'operation_id'=j->>'operation_id')) OR
 (NOT(a.frame->>'wms_enabled')::boolean AND NOT EXISTS(SELECT FROM public.inventory_bulk_edit_execution_rows er WHERE er.tenant_id=a.tenant_id AND (j->>'operation_id')::uuid=ANY(er.operation_ids)
 AND(er.execution_id=r.inventory_execution_id OR EXISTS(SELECT FROM jsonb_array_elements(r.snapshot#>'{execution,payload,links}')lk WHERE lk->>'core_execution_id'=er.execution_id::text))
 AND er.product_id::text=j->>'product_id' AND er.location=j->>'location' AND er.operation='count' AND er.status='changed')) THEN
 RAISE EXCEPTION 'Dziennik nie pochodzi z rzeczywistego rodzimego pomiaru' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Full signed aggregate conservation permits mixed bins/net0; no second move.
 SELECT coalesce(jsonb_agg(jsonb_build_array(w,p,delta) ORDER BY w,p),'[]') INTO wanted FROM
 (SELECT x->>'warehouse_id'w,x->>'product_id'p,sum((x->>'delta')::bigint)delta FROM jsonb_array_elements(a.frame->'bins')x GROUP BY 1,2 HAVING sum((x->>'delta')::bigint)<>0)z;
 SELECT coalesce(jsonb_agg(jsonb_build_array(w::text,p::text,delta) ORDER BY w,p),'[]') INTO actual FROM
 (SELECT warehouse_id w,product_id p,sum(delta::bigint)delta FROM public.stock_movements WHERE tenant_id=a.tenant_id AND id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v) GROUP BY 1,2 HAVING sum(delta::bigint)<>0)z;
 IF actual IS DISTINCT FROM wanted OR EXISTS(SELECT FROM public.stock_movements m WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v)
 AND(m.xmin<>pg_current_xact_id()::text::xid OR m.delta=0 OR m.kind IS DISTINCT FROM (CASE WHEN(a.frame->>'wms_enabled')::boolean THEN 'wms_stocktake' ELSE 'location_count' END))) THEN
 RAISE EXCEPTION 'Niezgodny pojedynczy rzeczywisty rozchód agregatu pomiaru' USING ERRCODE='23514';END IF;
 IF NOT(a.frame->>'wms_enabled')::boolean AND jsonb_array_length(r.proof->'layer_movement_ids')<>0 THEN RAISE EXCEPTION 'OFF nie tworzy wyceny WMS' USING ERRCODE='23514';END IF;
 IF(a.frame->>'wms_enabled')::boolean THEN
 SELECT coalesce(jsonb_agg(jsonb_build_array(w::text,p::text,l,delta) ORDER BY w,p,l),'[]') INTO actual FROM
 (SELECT warehouse_id w,product_id p,location l,sum(delta::bigint)delta FROM public.wms_layer_movements WHERE tenant_id=a.tenant_id AND id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v) GROUP BY 1,2,3 HAVING sum(delta::bigint)<>0)z;
 SELECT coalesce(jsonb_agg(jsonb_build_array(x->>'warehouse_id',x->>'product_id',x->>'location',(x->>'delta')::bigint) ORDER BY x->>'warehouse_id',x->>'product_id',x->>'location'),'[]') INTO wanted FROM jsonb_array_elements(a.frame->'bins')x;
 IF wanted IS DISTINCT FROM actual OR EXISTS(SELECT FROM public.wms_layer_movements m JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(m.tenant_id,m.layer_id,m.product_id)
 WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v)
 AND(m.xmin<>pg_current_xact_id()::text::xid OR m.kind<>'stocktake' OR m.delta=0 OR NOT EXISTS(SELECT FROM jsonb_array_elements(r.snapshot#>'{execution,payload,links}')lk WHERE lk->>'operation_id'=m.operation_id::text)
 OR m.value_delta IS DISTINCT FROM m.delta::bigint*l.unit_cost_minor)) THEN RAISE EXCEPTION 'Nieprawdziwe warstwy lub koszt pomiaru' USING ERRCODE='23514';END IF;
 END IF;
 IF(SELECT count(*) FROM public.catalog_stock_count_documents WHERE(tenant_id,receipt_id)=(a.tenant_id,a.count_receipt_id))<>jsonb_array_length(a.numbers) THEN
 RAISE EXCEPTION 'Niepełne numery PW/RW' USING ERRCODE='23514';END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(a.numbers) LOOP
 SELECT * INTO doc_record FROM public.catalog_stock_count_documents WHERE(tenant_id,receipt_id,warehouse_id,kind)=(a.tenant_id,a.count_receipt_id,(n->>'warehouse_id')::uuid,n->>'kind');
 IF doc_record.id IS NULL OR doc_record.series_id::text<>n->>'series_id' OR doc_record.year<>(n->>'year')::integer OR doc_record.sequence<>(n->>'sequence')::bigint OR doc_record.number<>n->>'number'
 OR doc_record.payload->>'number'<>doc_record.number OR doc_record.payload->>'id'<>doc_record.id::text OR doc_record.payload->>'receipt_id'<>a.count_receipt_id::text OR doc_record.payload->>'kind'<>doc_record.kind
 OR doc_record.payload->'series' IS DISTINCT FROM n->'series' OR(doc_record.payload->>'row_count')::integer<>(SELECT count(*) FROM public.catalog_stock_count_rows WHERE(tenant_id,document_id)=(a.tenant_id,doc_record.id))
 OR doc_record.payload->>'quantity' IS DISTINCT FROM(SELECT sum(abs(delta::bigint))::text FROM public.catalog_stock_count_rows WHERE(tenant_id,document_id)=(a.tenant_id,doc_record.id)) THEN
 RAISE EXCEPTION 'Niezgodny pełny numerowany dokument PW/RW' USING ERRCODE='23514';END IF;
 END LOOP;
 IF(a.frame->>'wms_enabled')::boolean THEN
 PERFORM public.catalog_stock_count_lot_validate(eid);RETURN;
 END IF;
 IF(SELECT count(*) FROM public.catalog_stock_count_rows x JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id))<>jsonb_array_length(r.proof->'location_movement_ids') THEN
 RAISE EXCEPTION 'Niepełne podpisane wiersze PW/RW' USING ERRCODE='23514';END IF;
 FOR row_record IN SELECT rr.*,d.kind FROM public.catalog_stock_count_rows rr JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(rr.tenant_id,rr.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id) LOOP
 IF NOT EXISTS(SELECT FROM public.stock_location_movements m WHERE(m.tenant_id,m.id,m.warehouse_id,m.product_id,m.location,m.delta)=(row_record.tenant_id,row_record.bin_movement_id,row_record.warehouse_id,row_record.product_id,row_record.location,row_record.delta)
 AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'location_movement_ids')v)) OR row_record.kind<>(CASE WHEN row_record.delta>0 THEN 'PW' ELSE 'RW' END)
 OR row_record.payload IS DISTINCT FROM jsonb_build_object('product_id',row_record.product_id,'sku',(SELECT p->>'sku' FROM jsonb_array_elements(a.frame->'products')p WHERE p->>'id'=row_record.product_id::text),
 'name',(SELECT p->>'name' FROM jsonb_array_elements(a.frame->'products')p WHERE p->>'id'=row_record.product_id::text),'warehouse_id',row_record.warehouse_id,'location',row_record.location,'delta',row_record.delta,'quantity',abs(row_record.delta::bigint)::text,'bin_movement_id',row_record.bin_movement_id)
 OR(SELECT coalesce(sum(quantity),0) FROM public.catalog_stock_count_native_maps WHERE(tenant_id,row_id)=(a.tenant_id,row_record.id))<>abs(row_record.delta::bigint)
 OR(SELECT coalesce(sum(quantity),0) FROM public.catalog_stock_count_stock_maps WHERE(tenant_id,row_id)=(a.tenant_id,row_record.id))>abs(row_record.delta::bigint)
 OR EXISTS(SELECT FROM public.catalog_stock_count_bin_maps bm WHERE(bm.tenant_id,bm.row_id)=(a.tenant_id,row_record.id))
 OR(a.frame->>'wms_enabled')::boolean AND(SELECT coalesce(sum(quantity),0) FROM public.catalog_stock_count_layer_maps WHERE(tenant_id,row_id)=(a.tenant_id,row_record.id))<>abs(row_record.delta::bigint) THEN
 RAISE EXCEPTION 'Niepełne pochodzenie podpisanego wiersza PW/RW' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Every original signed source amount and actual layer journal is consumed
 -- once. FK existence alone does not prove tenant/cell/sign/quantity.
 IF EXISTS(SELECT FROM jsonb_array_elements(a.frame->'source_rows')s WHERE(s->>'delta')::bigint<>0 AND
 (SELECT coalesce(sum(m.quantity),0) FROM public.catalog_stock_count_native_maps m JOIN public.catalog_stock_count_rows rr ON(rr.tenant_id,rr.id)=(m.tenant_id,m.row_id)
 JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(rr.tenant_id,rr.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id)
 AND m.source_index=(s->>'index')::integer)<>abs((s->>'delta')::bigint)) OR EXISTS(
 SELECT FROM public.catalog_stock_count_native_maps m JOIN public.catalog_stock_count_rows rr ON(rr.tenant_id,rr.id)=(m.tenant_id,m.row_id)
 JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(rr.tenant_id,rr.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id)
 AND(NOT EXISTS(SELECT FROM jsonb_array_elements(a.frame->'source_rows')s WHERE(s->>'index')::integer=m.source_index AND(s->>'warehouse_id',s->>'product_id',s->>'location')=(rr.warehouse_id::text,rr.product_id::text,rr.location) AND sign((s->>'delta')::bigint)=sign(rr.delta))
 OR m.inventory_execution_id IS DISTINCT FROM r.inventory_execution_id OR m.stock_file_execution_id IS DISTINCT FROM r.stock_file_execution_id)) THEN RAISE EXCEPTION 'Obca lub podwójna alokacja natywnego pomiaru' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.wms_layer_movements lm WHERE lm.tenant_id=a.tenant_id AND lm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v)
 AND(SELECT coalesce(sum(m.quantity),0) FROM public.catalog_stock_count_layer_maps m WHERE(m.tenant_id,m.layer_movement_id)=(a.tenant_id,lm.id))<>abs(lm.delta::bigint)) OR EXISTS(
 SELECT FROM public.catalog_stock_count_layer_maps m JOIN public.catalog_stock_count_rows rr ON(rr.tenant_id,rr.id)=(m.tenant_id,m.row_id)
 JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(rr.tenant_id,rr.document_id) JOIN public.wms_layer_movements lm ON(lm.tenant_id,lm.id)=(m.tenant_id,m.layer_movement_id)
 JOIN public.wms_cost_layers l ON(l.tenant_id,l.id)=(lm.tenant_id,lm.layer_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id)
 AND(lm.id NOT IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v) OR(lm.warehouse_id,lm.product_id,lm.location,sign(lm.delta))<>(rr.warehouse_id,rr.product_id,rr.location,sign(rr.delta))
 OR m.payload IS DISTINCT FROM jsonb_build_object('layer_id',l.id,'lot_id',l.lot_id,'operation_id',lm.operation_id,'unit_cost_minor',l.unit_cost_minor::text,'currency',l.currency,'exponent',l.exponent,
 'value_minor',CASE WHEN l.unit_cost_minor IS NULL THEN NULL ELSE(m.quantity::bigint*l.unit_cost_minor)::text END))) THEN RAISE EXCEPTION 'Zmieniona historyczna lub deklarowana wycena warstw PW/RW' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.stock_movements sm WHERE sm.tenant_id=a.tenant_id AND sm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v)
 AND(SELECT coalesce(sum(m.quantity),0) FROM public.catalog_stock_count_stock_maps m WHERE(m.tenant_id,m.stock_movement_id)=(a.tenant_id,sm.id))<>abs(sm.delta::bigint)) OR EXISTS(
 SELECT FROM public.catalog_stock_count_stock_maps m JOIN public.catalog_stock_count_rows rr ON(rr.tenant_id,rr.id)=(m.tenant_id,m.row_id)
 JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.id)=(rr.tenant_id,rr.document_id) JOIN public.stock_movements sm ON(sm.tenant_id,sm.id)=(m.tenant_id,m.stock_movement_id)
 WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,a.count_receipt_id) AND(sm.id NOT IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v)
 OR(sm.warehouse_id,sm.product_id,sign(sm.delta))<>(rr.warehouse_id,rr.product_id,sign(rr.delta)) OR m.quantity>abs(rr.delta::bigint))) THEN
 RAISE EXCEPTION 'Obcy lub podwójny ruch agregatu PW/RW' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION catalog_stock_count_budget(t uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n bigint:=0;v bigint;nm text;
BEGIN
 IF(SELECT count(*) FROM public.catalog_stock_count_receipts WHERE tenant_id=t)>2000 THEN RAISE EXCEPTION 'Limit historii dokumentów pomiarów' USING ERRCODE='54000';END IF;
 FOREACH nm IN ARRAY ARRAY['admissions','receipts','documents','rows','bin_maps','stock_maps','layer_maps','native_maps'] LOOP
 EXECUTE format('SELECT coalesce(sum(pg_column_size(x)),0) FROM public.catalog_stock_count_%I x WHERE tenant_id=$1',nm) INTO v USING t;n:=n+v;
 END LOOP;
 IF n>134217728 THEN RAISE EXCEPTION 'Budżet pełnych dowodów pomiaru PW/RW' USING ERRCODE='54000';END IF;
END $$;
CREATE FUNCTION catalog_stock_count_abandon(uid uuid,kid uuid,eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;n jsonb;v bigint;
BEGIN
 PERFORM public.catalog_stock_count_require();SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid FOR UPDATE;
 IF a.id IS NULL OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR a.txid<>pg_current_xact_id()
 OR a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS DISTINCT FROM kid OR a.sealed OR EXISTS(SELECT FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(a.tenant_id,a.id)) THEN
 RAISE EXCEPTION 'Nie można porzucić zakończonego pomiaru' USING ERRCODE='23514';END IF;
 -- Generic abandon validates unchanged physical snapshot before any deletion.
 -- Delete own row first for its actual FK; a refusal rolls back all changes.
 FOR n IN SELECT value FROM jsonb_array_elements(a.numbers) ORDER BY value->>'warehouse_id',value->>'kind' LOOP
 SELECT value INTO v FROM public.catalog_stock_control_counters WHERE(tenant_id,series_id,year)=(a.tenant_id,(n->>'series_id')::uuid,(n->>'year')::integer) FOR UPDATE;
 IF v IS DISTINCT FROM(n->>'sequence')::bigint THEN RAISE EXCEPTION 'Numer pomiaru został wykorzystany' USING ERRCODE='23514';END IF;
 IF v=1 THEN DELETE FROM public.catalog_stock_control_counters WHERE(tenant_id,series_id,year)=(a.tenant_id,(n->>'series_id')::uuid,(n->>'year')::integer);
 ELSE UPDATE public.catalog_stock_control_counters SET value=value-1 WHERE(tenant_id,series_id,year)=(a.tenant_id,(n->>'series_id')::uuid,(n->>'year')::integer);END IF;
 END LOOP;
 DELETE FROM public.catalog_stock_count_admissions WHERE id=eid;
 PERFORM public.catalog_stock_control_effect_abandon(uid,kid,eid);
END $$;
CREATE FUNCTION catalog_stock_count_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Dowód PW/RW pomiaru jest niezmienny' USING ERRCODE='23514';END $$;
CREATE FUNCTION catalog_stock_count_admission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE e public.catalog_stock_control_effect_admissions;f jsonb;n jsonb;
BEGIN
 PERFORM public.catalog_stock_count_require();
 IF TG_OP='DELETE' THEN
 SELECT * INTO e FROM public.catalog_stock_control_effect_admissions WHERE(tenant_id,id)=(OLD.tenant_id,OLD.id);
 IF OLD.txid<>pg_current_xact_id() OR OLD.sealed OR EXISTS(SELECT FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(OLD.tenant_id,OLD.id))
 OR e.before_frame IS DISTINCT FROM public.catalog_stock_control_effect_frame(e.request) THEN RAISE EXCEPTION 'Nie można usunąć użytej zgody pomiaru' USING ERRCODE='23514';END IF;RETURN OLD;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.txid<>pg_current_xact_id() THEN RAISE EXCEPTION 'Obca zgoda pomiaru' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM public.catalog_stock_control_effect_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);
 IF e.id IS NULL OR e.actor_id IS DISTINCT FROM NEW.actor_id OR e.api_key_id IS DISTINCT FROM NEW.api_key_id OR e.txid<>NEW.txid
 OR e.request IS DISTINCT FROM jsonb_build_object('source_kind','inventory_import','source_id',NEW.count_receipt_id,'warehouse_ids',NEW.frame->'warehouse_ids','product_ids',NEW.frame->'product_ids') THEN
 RAISE EXCEPTION 'Zgoda nie odpowiada przyjęciu fizycznego pomiaru' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 IF OLD.sealed OR NOT NEW.sealed OR(to_jsonb(NEW)-'sealed') IS DISTINCT FROM(to_jsonb(OLD)-'sealed') OR NOT e.sealed THEN RAISE EXCEPTION 'Niedozwolona zmiana zgody pomiaru' USING ERRCODE='23514';END IF;
 PERFORM public.catalog_stock_count_validate(NEW.id);RETURN NEW;
 END IF;
 IF jsonb_typeof(NEW.frame->'native_timezone') IS DISTINCT FROM 'string' OR NEW.frame->>'native_timezone'='' THEN
 RAISE EXCEPTION 'Brak rzeczywistego kontekstu rodzimego pomiaru' USING ERRCODE='23514';END IF;
 IF NEW.sealed OR e.sealed OR NEW.frame IS DISTINCT FROM
 (public.catalog_stock_count_frame(NEW.actor_id,NEW.api_key_id,jsonb_build_object('protocol',NEW.protocol,'source_id',NEW.source_id,'request',NEW.request))||jsonb_build_object('native_timezone',NEW.frame->>'native_timezone')) THEN
 RAISE EXCEPTION 'Zgoda nie zawiera rzeczywistego pełnego podglądu' USING ERRCODE='23514';END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(NEW.numbers) LOOP
 IF NOT EXISTS(SELECT FROM public.catalog_stock_control_series s JOIN public.catalog_stock_control_counters c ON(c.tenant_id,c.series_id)=(s.tenant_id,s.id)
 WHERE(s.tenant_id,s.id,s.warehouse_id,s.kind,c.year,c.value)=(NEW.tenant_id,(n->>'series_id')::uuid,(n->>'warehouse_id')::uuid,n->>'kind',(n->>'year')::integer,(n->>'sequence')::bigint)
 AND to_jsonb(s)=n->'series' AND n->>'number'=s.prefix||'/'||c.year||'/'||(CASE WHEN length(c.value::text)>=6 THEN c.value::text ELSE lpad(c.value::text,6,'0') END)) THEN
 RAISE EXCEPTION 'Nieprawdziwy systemowy numer pomiaru' USING ERRCODE='23514';END IF;
 END LOOP;
 IF NEW.numbers IS DISTINCT FROM(SELECT jsonb_agg(number_entry ORDER BY number_entry->>'warehouse_id',number_entry->>'kind') FROM jsonb_array_elements(NEW.numbers)number_entry) OR
 (SELECT count(*) FROM jsonb_array_elements(NEW.numbers))<>(SELECT count(*) FROM(SELECT DISTINCT x->>'warehouse_id',sign((x->>'delta')::bigint) FROM jsonb_array_elements(NEW.frame->'source_rows')x WHERE(x->>'delta')::bigint<>0)z) THEN
 RAISE EXCEPTION 'Niepełne numery obu znaków pomiaru' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION catalog_stock_count_record_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;rid uuid;did uuid;
BEGIN
 PERFORM public.catalog_stock_count_require();
 IF TG_TABLE_NAME='catalog_stock_count_receipts' THEN SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.admission_id);
 IF NEW.id IS DISTINCT FROM a.count_receipt_id OR NEW.snapshot IS DISTINCT FROM public.catalog_stock_count_native_snapshot(a.id,NEW.inventory_execution_id,NEW.stock_file_execution_id) THEN RAISE EXCEPTION 'Nieprawdziwy niezmienny rodzic pomiaru' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='catalog_stock_count_documents' THEN rid:=NEW.receipt_id;
 ELSE
 IF TG_TABLE_NAME='catalog_stock_count_rows' THEN did:=NEW.document_id;
 ELSE SELECT document_id INTO did FROM public.catalog_stock_count_rows WHERE(tenant_id,id)=(NEW.tenant_id,NEW.row_id);END IF;
 SELECT receipt_id INTO rid FROM public.catalog_stock_count_documents WHERE(tenant_id,id)=(NEW.tenant_id,did);
 END IF;
 IF a.id IS NULL THEN SELECT ca.* INTO a FROM public.catalog_stock_count_receipts r JOIN public.catalog_stock_count_admissions ca ON(ca.tenant_id,ca.id)=(r.tenant_id,r.admission_id) WHERE(r.tenant_id,r.id)=(NEW.tenant_id,rid);END IF;
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR a.sealed OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Poza bieżącym niezapieczętowanym pomiarem' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION catalog_stock_count_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;
BEGIN
 IF TG_TABLE_NAME='catalog_stock_count_admissions' THEN SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=NEW.id;
 ELSE SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=NEW.admission_id;END IF;
 IF a.id IS NULL THEN RETURN NULL;END IF;
 IF NOT a.sealed OR NOT EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions e JOIN public.catalog_stock_control_effects f ON(f.tenant_id,f.admission_id)=(e.tenant_id,e.id)
 WHERE(e.tenant_id,e.id,e.txid)=(a.tenant_id,a.id,a.txid) AND e.sealed AND f.count_receipt_id=a.count_receipt_id) THEN RAISE EXCEPTION 'Osierocona zgoda dokumentów pomiaru' USING ERRCODE='23514';END IF;
 PERFORM public.catalog_stock_count_validate(a.id);RETURN NULL;
END $$;
CREATE FUNCTION catalog_stock_count_source_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d jsonb;side integer;a public.catalog_stock_count_admissions;ref uuid;
BEGIN
 FOR side IN 1..2 LOOP
 IF side=1 AND TG_OP='INSERT' OR side=2 AND TG_OP='DELETE' THEN CONTINUE;END IF;
 d:=CASE WHEN side=1 THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 FOR a IN SELECT ca.* FROM public.catalog_stock_count_admissions ca WHERE ca.tenant_id=(d->>'tenant_id')::uuid AND ca.sealed LOOP
 IF TG_TABLE_NAME IN('inventory_bulk_edit_previews','inventory_bulk_edit_rows') THEN ref:=CASE WHEN TG_TABLE_NAME='inventory_bulk_edit_previews' THEN(d->>'id')::uuid ELSE(d->>'preview_id')::uuid END;
 IF a.protocol='inventory_bulk' AND ref=a.source_id THEN RAISE EXCEPTION 'Rodzime źródło PW/RW jest zapieczętowane' USING ERRCODE='23514';END IF;
 IF a.protocol='stock_file' AND EXISTS(SELECT FROM jsonb_array_elements(a.frame#>'{native,head,payload,targets}')t CROSS JOIN LATERAL jsonb_array_elements(t->'children')c WHERE c->>'id'=ref::text) THEN
 RAISE EXCEPTION 'Źródło składowe pliku PW/RW jest zapieczętowane' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME IN('stock_file_import_previews','stock_file_import_executions','stock_file_import_admissions') THEN ref:=CASE WHEN TG_TABLE_NAME='stock_file_import_previews' THEN(d->>'id')::uuid ELSE(d->>'preview_id')::uuid END;
 IF a.protocol='stock_file' AND ref=a.source_id THEN RAISE EXCEPTION 'Rodzime źródło PW/RW jest zapieczętowane' USING ERRCODE='23514';END IF;
 ELSE
 ref:=CASE WHEN TG_TABLE_NAME='inventory_bulk_edit_executions' THEN(d->>'id')::uuid ELSE(d->>'execution_id')::uuid END;
 IF EXISTS(SELECT FROM public.catalog_stock_count_receipts r WHERE(r.tenant_id,r.admission_id,r.inventory_execution_id)=(a.tenant_id,a.id,ref)) THEN RAISE EXCEPTION 'Rodzime wykonanie PW/RW jest zapieczętowane' USING ERRCODE='23514';END IF;
 IF a.protocol='stock_file' AND EXISTS(SELECT FROM public.catalog_stock_count_receipts r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot#>'{execution,payload,links}')lk
 WHERE(r.tenant_id,r.admission_id)=(a.tenant_id,a.id) AND lk->>'core_execution_id'=ref::text) THEN RAISE EXCEPTION 'Wykonanie składowe pliku PW/RW jest zapieczętowane' USING ERRCODE='23514';END IF;
 END IF;
 END LOOP;
 END LOOP;RETURN coalesce(NEW,OLD);
END $$;
CREATE TRIGGER count_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON catalog_stock_count_admissions FOR EACH ROW EXECUTE FUNCTION catalog_stock_count_admission_guard();
CREATE CONSTRAINT TRIGGER count_complete AFTER INSERT OR UPDATE ON catalog_stock_count_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_stock_count_complete();
CREATE CONSTRAINT TRIGGER count_complete AFTER INSERT ON catalog_stock_count_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_stock_count_complete();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON catalog_stock_count_manifest FOR EACH ROW EXECUTE FUNCTION catalog_stock_count_immutable();
DO $$ DECLARE nm text;BEGIN
 FOREACH nm IN ARRAY ARRAY['receipts','documents','rows','bin_maps','stock_maps','layer_maps','native_maps'] LOOP
 EXECUTE format('CREATE TRIGGER count_record BEFORE INSERT ON public.catalog_stock_count_%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_count_record_guard()',nm);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.catalog_stock_count_%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_count_immutable()',nm);
 END LOOP;
 FOREACH nm IN ARRAY ARRAY['inventory_bulk_edit_previews','inventory_bulk_edit_rows','inventory_bulk_edit_executions','inventory_bulk_edit_execution_rows','stock_file_import_previews','stock_file_import_executions','stock_file_import_admissions'] LOOP
 EXECUTE format('CREATE TRIGGER catalog_stock_count_source_seal BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_count_source_seal()',nm);
 END LOOP;
END $$;
-- Last ACL pass is after every helper and trigger, before both manifests.
DO $$ DECLARE p record;BEGIN
 FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND left(proname,20)='catalog_stock_count_' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.signature);
 END LOOP;
END $$;
INSERT INTO public.catalog_stock_count_manifest VALUES(true,public.catalog_stock_count_fingerprint());
