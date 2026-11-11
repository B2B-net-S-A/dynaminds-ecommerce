-- Additive BO snapshot and strict physical admission authority. No history backfill.
CREATE TABLE catalog_stock_control_previews(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants,actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,client_key uuid NOT NULL,catalog_id uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,nonce uuid NOT NULL DEFAULT gen_random_uuid(),frame jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',UNIQUE(tenant_id,id),UNIQUE(tenant_id,actor_id,client_key),FOREIGN KEY(tenant_id,catalog_id) REFERENCES public.product_catalogs(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id));
CREATE TABLE catalog_stock_control_operations(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants,actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,client_key uuid NOT NULL,catalog_id uuid NOT NULL,preview_id uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,catalog_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,actor_id,client_key),FOREIGN KEY(tenant_id,preview_id) REFERENCES public.catalog_stock_control_previews(tenant_id,id),FOREIGN KEY(tenant_id,catalog_id) REFERENCES public.product_catalogs(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id));
CREATE TABLE catalog_stock_control_policies(tenant_id uuid NOT NULL,catalog_id uuid NOT NULL,version bigint NOT NULL CHECK(version=1),operation_id uuid NOT NULL,PRIMARY KEY(tenant_id,catalog_id),FOREIGN KEY(tenant_id,catalog_id) REFERENCES public.product_catalogs(tenant_id,id),FOREIGN KEY(tenant_id,operation_id) REFERENCES public.catalog_stock_control_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE catalog_stock_control_revisions(tenant_id uuid NOT NULL,catalog_id uuid NOT NULL,version bigint NOT NULL,operation_id uuid NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(tenant_id,catalog_id,version),FOREIGN KEY(tenant_id,catalog_id) REFERENCES public.catalog_stock_control_policies(tenant_id,catalog_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,operation_id) REFERENCES public.catalog_stock_control_operations(tenant_id,id));
CREATE TABLE catalog_stock_control_series(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants,warehouse_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('BO','PZ','MM','WZ','PW','RW')),version bigint NOT NULL DEFAULT 1 CHECK(version=1),name text NOT NULL,prefix text NOT NULL,UNIQUE(tenant_id,id),UNIQUE(tenant_id,warehouse_id,kind),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES public.warehouses(tenant_id,id));
CREATE TABLE catalog_stock_control_counters(tenant_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2000 AND 9999),value bigint NOT NULL CHECK(value>0),PRIMARY KEY(tenant_id,series_id,year),FOREIGN KEY(tenant_id,series_id) REFERENCES public.catalog_stock_control_series(tenant_id,id));
CREATE TABLE catalog_stock_control_documents(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,operation_id uuid NOT NULL,catalog_id uuid NOT NULL,warehouse_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),payload jsonb NOT NULL,UNIQUE(tenant_id,id),UNIQUE(tenant_id,operation_id,warehouse_id),UNIQUE(tenant_id,series_id,year,sequence),FOREIGN KEY(tenant_id,operation_id) REFERENCES public.catalog_stock_control_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,catalog_id) REFERENCES public.product_catalogs(tenant_id,id),FOREIGN KEY(tenant_id,warehouse_id) REFERENCES public.warehouses(tenant_id,id),FOREIGN KEY(tenant_id,series_id,year) REFERENCES public.catalog_stock_control_counters(tenant_id,series_id,year));
CREATE TABLE catalog_stock_control_rows(tenant_id uuid NOT NULL,document_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),product_id uuid NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(tenant_id,document_id,ordinal),FOREIGN KEY(tenant_id,document_id) REFERENCES public.catalog_stock_control_documents(tenant_id,id),FOREIGN KEY(tenant_id,product_id) REFERENCES public.products(tenant_id,id));
CREATE TABLE catalog_stock_control_admissions(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,operation_id uuid NOT NULL,catalog_id uuid NOT NULL,txid xid8 NOT NULL DEFAULT pg_current_xact_id(),frame jsonb NOT NULL,sealed boolean NOT NULL DEFAULT false,UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,operation_id) REFERENCES public.catalog_stock_control_operations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,catalog_id) REFERENCES public.product_catalogs(tenant_id,id));
CREATE TABLE catalog_stock_control_effect_admissions(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants,actor_id uuid REFERENCES public.users,api_key_id uuid,source_kind text NOT NULL,source_id uuid NOT NULL,request jsonb NOT NULL,before_frame jsonb NOT NULL,txid xid8 NOT NULL DEFAULT pg_current_xact_id(),number jsonb,sealed boolean NOT NULL DEFAULT false,UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_kind,source_id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id));
CREATE TABLE catalog_stock_control_effects(tenant_id uuid NOT NULL,admission_id uuid NOT NULL,proof jsonb NOT NULL,after_frame jsonb NOT NULL,warehouse_document_id uuid,operation_id uuid,purchase_receipt_id uuid,dispatch_receipt_id uuid,adjustment_receipt_id uuid,location_operation_id uuid,PRIMARY KEY(tenant_id,admission_id),FOREIGN KEY(tenant_id,admission_id) REFERENCES public.catalog_stock_control_effect_admissions(tenant_id,id),FOREIGN KEY(tenant_id,warehouse_document_id) REFERENCES public.warehouse_documents(tenant_id,id),FOREIGN KEY(tenant_id,operation_id) REFERENCES public.wms_operations(tenant_id,id),FOREIGN KEY(tenant_id,purchase_receipt_id) REFERENCES public.purchase_receipts(tenant_id,id),FOREIGN KEY(tenant_id,dispatch_receipt_id) REFERENCES public.warehouse_wz_issuer_receipts(tenant_id,id),FOREIGN KEY(tenant_id,adjustment_receipt_id) REFERENCES public.stocktake_adjustment_receipts(tenant_id,id),FOREIGN KEY(location_operation_id) REFERENCES public.stock_location_operations(id));
CREATE TABLE catalog_stock_control_effect_journals(tenant_id uuid NOT NULL,admission_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('stock','bin','layer')),journal_id uuid NOT NULL,stock_movement_id uuid,location_movement_id uuid,layer_movement_id uuid,PRIMARY KEY(tenant_id,admission_id,kind,journal_id),FOREIGN KEY(tenant_id,admission_id) REFERENCES public.catalog_stock_control_effects(tenant_id,admission_id),FOREIGN KEY(tenant_id,stock_movement_id) REFERENCES public.stock_movements(tenant_id,id),FOREIGN KEY(tenant_id,location_movement_id) REFERENCES public.stock_location_movements(tenant_id,id),FOREIGN KEY(tenant_id,layer_movement_id) REFERENCES public.wms_layer_movements(tenant_id,id),CHECK((kind='stock' AND stock_movement_id=journal_id AND location_movement_id IS NULL AND layer_movement_id IS NULL) OR(kind='bin' AND stock_movement_id IS NULL AND location_movement_id=journal_id AND layer_movement_id IS NULL) OR(kind='layer' AND stock_movement_id IS NULL AND location_movement_id IS NULL AND layer_movement_id=journal_id)));
CREATE TABLE catalog_stock_control_manifest(id boolean PRIMARY KEY DEFAULT true CHECK(id),fingerprint text NOT NULL);
DO $$ DECLARE n text; BEGIN FOR n IN SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'catalog_stock_control_%' AND relkind='r' LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',n);
 IF n<>'catalog_stock_control_manifest' THEN EXECUTE format('CREATE POLICY tenant ON public.%I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',n);END IF;
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app',n);
 END LOOP;END $$;
CREATE INDEX catalog_stock_control_preview_catalog ON catalog_stock_control_previews(tenant_id,catalog_id,created_at DESC,id DESC);
CREATE INDEX catalog_stock_control_preview_key ON catalog_stock_control_previews(tenant_id,api_key_id);
CREATE INDEX catalog_stock_control_operation_catalog ON catalog_stock_control_operations(tenant_id,catalog_id,created_at DESC,id DESC);
CREATE INDEX catalog_stock_control_operation_key ON catalog_stock_control_operations(tenant_id,api_key_id);
CREATE INDEX catalog_stock_control_policy_operation ON catalog_stock_control_policies(tenant_id,operation_id);
CREATE INDEX catalog_stock_control_revision_operation ON catalog_stock_control_revisions(tenant_id,operation_id);
CREATE INDEX catalog_stock_control_document_catalog ON catalog_stock_control_documents(tenant_id,catalog_id,id);
CREATE INDEX catalog_stock_control_document_wh ON catalog_stock_control_documents(tenant_id,warehouse_id,id);
CREATE INDEX catalog_stock_control_row_product ON catalog_stock_control_rows(tenant_id,product_id);
CREATE INDEX catalog_stock_control_admission_operation ON catalog_stock_control_admissions(tenant_id,operation_id);
CREATE INDEX catalog_stock_control_admission_catalog ON catalog_stock_control_admissions(tenant_id,catalog_id);
CREATE INDEX catalog_stock_control_effect_key ON catalog_stock_control_effect_admissions(tenant_id,api_key_id);
CREATE INDEX catalog_stock_control_effect_doc ON catalog_stock_control_effects(tenant_id,warehouse_document_id);
CREATE INDEX catalog_stock_control_effect_op ON catalog_stock_control_effects(tenant_id,operation_id);
CREATE INDEX catalog_stock_control_effect_purchase ON catalog_stock_control_effects(tenant_id,purchase_receipt_id);
CREATE INDEX catalog_stock_control_effect_dispatch ON catalog_stock_control_effects(tenant_id,dispatch_receipt_id);
CREATE INDEX catalog_stock_control_effect_adjustment ON catalog_stock_control_effects(tenant_id,adjustment_receipt_id);
CREATE INDEX catalog_stock_control_effect_stock_journal ON catalog_stock_control_effect_journals(tenant_id,stock_movement_id);
CREATE INDEX catalog_stock_control_effect_bin_journal ON catalog_stock_control_effect_journals(tenant_id,location_movement_id);
CREATE INDEX catalog_stock_control_effect_layer_journal ON catalog_stock_control_effect_journals(tenant_id,layer_movement_id);
CREATE FUNCTION catalog_stock_control_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$ SELECT encode(sha256(convert_to(j::text,'UTF8')),'hex') $$;
CREATE FUNCTION catalog_stock_control_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS(SELECT FROM public.migrations WHERE name='152_catalog_stock_control') $$;
CREATE FUNCTION catalog_stock_control_require() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN IF NOT public.catalog_stock_control_guards() THEN RAISE EXCEPTION 'Niekompletny moduł ścisłej kontroli katalogu' USING ERRCODE='55000';END IF;END $$;
CREATE FUNCTION catalog_stock_control_access(uid uuid,kid uuid,writing boolean,pin boolean,active_read boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k public.api_keys;rd boolean:=true;wr boolean:=true;val boolean:=true;onw boolean;
BEGIN IF pin THEN SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid) FOR SHARE;ELSE SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid);END IF;
 SELECT coalesce(enabled,false) INTO onw FROM public.wms_policies WHERE tenant_id=t;onw:=coalesce(onw,false);
 IF kid IS NOT NULL THEN IF pin THEN SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;ELSE SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);END IF;
 IF k.id IS NULL OR k.revoked_at IS NOT NULL OR(k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Klucz API został cofnięty lub wygasł' USING ERRCODE='28000';END IF;
 rd:='inventory:read'=ANY(k.scopes);val:='purchasing:read'=ANY(k.scopes);wr:=rd AND 'inventory:write'=ANY(k.scopes);END IF;
 IF NOT coalesce(rd AND r IN('admin','operator','viewer') AND(NOT(writing OR active_read) OR r='admin') AND(NOT writing OR wr),false) THEN RAISE EXCEPTION 'Brak aktualnego uprawnienia BO' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('current_role',r,'can_manage',r='admin' AND wr,'can_read_value',r='admin' AND val);END $$;
CREATE FUNCTION catalog_stock_control_policy(cid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT jsonb_build_object('catalog_id',cid,'version',coalesce(p.version,0)::text,'strict',p.catalog_id IS NOT NULL,'operation_id',p.operation_id) FROM(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid t)x LEFT JOIN public.catalog_stock_control_policies p ON(p.tenant_id,p.catalog_id)=(x.t,cid) $$;
CREATE FUNCTION catalog_stock_control_frame(cid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;cat public.product_catalogs;wh jsonb;rowsj jsonb;blockers jsonb:='[]';onw boolean;curr text;exp integer;summary jsonb;raw jsonb;
BEGIN SELECT * INTO cat FROM public.product_catalogs WHERE(tenant_id,id)=(t,cid);IF cat.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego katalogu' USING ERRCODE='P0002';END IF;
 SELECT enabled,currency,exponent INTO onw,curr,exp FROM public.wms_policies WHERE tenant_id=t;onw:=coalesce(onw,false);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'code',w.code,'policy',public.warehouse_inventory_policy(t,w.id),'series',jsonb_build_object('id',s.id,'version',coalesce(s.version,0)::text,'name',coalesce(s.name,'Bilans otwarcia'),'prefix',coalesce(s.prefix,'BO'))) ORDER BY w.id),'[]') INTO wh FROM public.product_catalog_warehouses a JOIN public.warehouses w ON(w.tenant_id,w.id)=(a.tenant_id,a.warehouse_id) LEFT JOIN public.catalog_stock_control_series s ON(s.tenant_id,s.warehouse_id,s.kind)=(t,w.id,'BO') WHERE(a.tenant_id,a.catalog_id)=(t,cid);
 IF jsonb_array_length(wh)=0 OR jsonb_array_length(wh)>100 THEN RAISE EXCEPTION 'Niepoprawny zakres magazynów BO' USING ERRCODE='54000';END IF;
 WITH base AS(SELECT s.*,p.sku,p.name,l.location bin_location,l.quantity bin_quantity,to_jsonb(l) bin_basis FROM public.stock s JOIN public.products p ON(p.tenant_id,p.id)=(s.tenant_id,s.product_id) JOIN public.product_catalog_warehouses a ON(a.tenant_id,a.warehouse_id,a.catalog_id)=(t,s.warehouse_id,cid) JOIN public.stock_locations l ON(l.tenant_id,l.warehouse_id,l.product_id)=(s.tenant_id,s.warehouse_id,s.product_id) WHERE(s.tenant_id,p.catalog_id)=(t,cid)),
 rr AS(SELECT b.warehouse_id,b.product_id,b.sku,b.name,b.bin_location location,CASE WHEN onw THEN pos.quantity ELSE b.bin_quantity END quantity,CASE WHEN onw THEN pos.reserved ELSE coalesce((SELECT sum(r.quantity-r.consumed_quantity-r.released_quantity) FROM public.reservation_locations r JOIN public.reservations h USING(tenant_id,order_id,product_id,warehouse_id) WHERE(r.tenant_id,r.warehouse_id,r.product_id,r.location)=(t,b.warehouse_id,b.product_id,b.bin_location) AND h.state='active'),0)::integer END reserved,b.version::text stock_version,public.catalog_stock_control_hash(b.bin_basis) bin_basis_hash,CASE WHEN onw THEN pos.layer_id END layer_id,CASE WHEN onw THEN cl.lot_id END lot_id,CASE WHEN onw THEN pos.version::text END position_version,cl.unit_cost_minor,cl.currency,cl.exponent FROM base b LEFT JOIN public.wms_layer_positions pos ON onw AND(pos.tenant_id,pos.warehouse_id,pos.product_id,pos.location)=(t,b.warehouse_id,b.product_id,b.bin_location) LEFT JOIN public.wms_cost_layers cl ON(cl.tenant_id,cl.id,cl.product_id)=(t,pos.layer_id,b.product_id) WHERE (NOT onw AND b.bin_quantity>0) OR(onw AND pos.quantity>0))
 SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal',ordinal,'warehouse_id',warehouse_id,'product_id',product_id,'sku',sku,'name',name,'location',location,'quantity',quantity,'reserved',reserved,'stock_version',stock_version,'bin_basis_hash',bin_basis_hash,'layer_id',layer_id,'lot_id',lot_id,'position_version',position_version)||CASE WHEN onw THEN jsonb_build_object('unit_cost_minor',unit_cost_minor::text,'value_minor',(quantity::numeric*unit_cost_minor)::text,'currency',currency,'exponent',exponent) ELSE '{}'::jsonb END ORDER BY ordinal),'[]') INTO rowsj FROM(SELECT *,row_number() OVER(ORDER BY warehouse_id,product_id,location,layer_id NULLS FIRST)-1 ordinal FROM rr)x;
 IF jsonb_array_length(rowsj)>10000 THEN RAISE EXCEPTION 'Limit pełnego manifestu BO' USING ERRCODE='54000';END IF;
 IF NOT cat.active THEN blockers:=blockers||jsonb_build_array(jsonb_build_object('code','CATALOG_INACTIVE','message','Katalog jest nieaktywny'));END IF;
 IF EXISTS(SELECT FROM public.catalog_stock_control_policies WHERE(tenant_id,catalog_id)=(t,cid)) THEN blockers:=blockers||jsonb_build_array(jsonb_build_object('code','ALREADY_STRICT','message','Katalog ma już bilans otwarcia'));END IF;
 IF EXISTS(SELECT FROM public.stock s JOIN public.products p ON(p.tenant_id,p.id)=(s.tenant_id,s.product_id) WHERE(s.tenant_id,p.catalog_id)=(t,cid) AND(s.reserved>0 OR s.on_hand<>(SELECT coalesce(sum(l.quantity),0) FROM public.stock_locations l WHERE(l.tenant_id,l.warehouse_id,l.product_id)=(t,s.warehouse_id,s.product_id)))) THEN blockers:=blockers||jsonb_build_array(jsonb_build_object('code','STOCK_NOT_READY','message','Rezerwacje lub niespójne lokalizacje'));END IF;
 IF EXISTS(SELECT FROM public.stock s JOIN public.products p ON(p.tenant_id,p.id)=(s.tenant_id,s.product_id) WHERE(s.tenant_id,p.catalog_id)=(t,cid) AND s.on_hand>0 AND(NOT EXISTS(SELECT FROM public.product_catalog_warehouses a WHERE(a.tenant_id,a.catalog_id,a.warehouse_id)=(t,cid,s.warehouse_id)) OR NOT(public.warehouse_inventory_policy(t,s.warehouse_id)->>'enabled')::boolean)) THEN blockers:=blockers||jsonb_build_array(jsonb_build_object('code','WAREHOUSE_NOT_READY','message','Dodatni zapas poza przypisaniem lub w wyłączonym magazynie'));END IF;
 IF onw AND EXISTS(SELECT FROM public.stock_locations l JOIN public.products p ON(p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE(l.tenant_id,p.catalog_id)=(t,cid) AND l.quantity<>(SELECT coalesce(sum(q.quantity),0) FROM public.wms_layer_positions q WHERE(q.tenant_id,q.warehouse_id,q.product_id,q.location)=(t,l.warehouse_id,l.product_id,l.location))) THEN blockers:=blockers||jsonb_build_array(jsonb_build_object('code','LAYERS_NOT_READY','message','Warstwy nie pokrywają fizycznego zapasu'));END IF;
 IF EXISTS(SELECT FROM public.stocktake_lines l JOIN public.stocktakes h ON(h.tenant_id,h.id)=(l.tenant_id,l.stocktake_id) JOIN public.products p ON(p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE(l.tenant_id,p.catalog_id)=(t,cid) AND h.state IN('counting','review')) OR EXISTS(SELECT FROM public.wms_stocktake_lines l JOIN public.wms_stocktakes h ON(h.tenant_id,h.id)=(l.tenant_id,l.stocktake_id) JOIN public.products p ON(p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE(l.tenant_id,p.catalog_id)=(t,cid) AND h.state IN('counting','review')) THEN blockers:=blockers||jsonb_build_array(jsonb_build_object('code','STOCKTAKE_PENDING','message','Otwarty spis katalogu'));END IF;
 SELECT jsonb_build_object('physical_quantity',coalesce(sum((v->>'quantity')::numeric),0)::text,'reserved_quantity',coalesce(sum((v->>'reserved')::numeric),0)::text)||CASE WHEN onw THEN jsonb_build_object('known_quantity',coalesce(sum((v->>'quantity')::numeric) FILTER(WHERE v->>'unit_cost_minor' IS NOT NULL),0)::text,'zero_cost_quantity',coalesce(sum((v->>'quantity')::numeric) FILTER(WHERE v->>'unit_cost_minor'='0'),0)::text,'unknown_quantity',coalesce(sum((v->>'quantity')::numeric) FILTER(WHERE v->>'unit_cost_minor' IS NULL),0)::text,'known_value_minor',coalesce(sum((v->>'value_minor')::numeric),0)::text,'currency',curr,'exponent',exp) ELSE '{}'::jsonb END INTO summary FROM jsonb_array_elements(rowsj)v;
 IF EXISTS(SELECT FROM public.return_items ri JOIN public.return_cases rc ON(rc.tenant_id,rc.id)=(ri.tenant_id,ri.return_id) JOIN public.order_items oi ON(oi.tenant_id,oi.order_id,oi.id)=(ri.tenant_id,ri.order_id,ri.item_id) JOIN public.products p ON(p.tenant_id,p.id)=(oi.tenant_id,oi.product_id) WHERE(p.tenant_id,p.catalog_id)=(t,cid) AND rc.state='requested') THEN blockers:=blockers||jsonb_build_array(jsonb_build_object('code','RETURN_PENDING','message','Niezakończona kontrola zwrotu katalogu'));END IF;
 raw:=jsonb_build_object('products',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.products p WHERE(p.tenant_id,p.catalog_id)=(t,cid)),'[]'),'stock',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id) FROM public.stock s JOIN public.products p ON(p.tenant_id,p.id)=(s.tenant_id,s.product_id) WHERE(s.tenant_id,p.catalog_id)=(t,cid)),'[]'),'bins',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.warehouse_id,l.product_id,l.location) FROM public.stock_locations l JOIN public.products p ON(p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE(l.tenant_id,p.catalog_id)=(t,cid)),'[]'),'components',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.bundle_id,b.product_id) FROM public.bundle_components b JOIN public.products p ON(p.tenant_id,p.id)=(b.tenant_id,b.bundle_id) WHERE(p.tenant_id,p.catalog_id)=(t,cid)),'[]'),'aliases',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.product_id,a.sku) FROM public.product_sku_aliases a JOIN public.products p ON(p.tenant_id,p.id)=(a.tenant_id,a.product_id) WHERE(p.tenant_id,p.catalog_id)=(t,cid)),'[]'),'positions',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.warehouse_id,q.product_id,q.location,q.layer_id) FROM public.wms_layer_positions q JOIN public.products p ON(p.tenant_id,p.id)=(q.tenant_id,q.product_id) WHERE(p.tenant_id,p.catalog_id)=(t,cid)),'[]'),'layers',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.wms_cost_layers l JOIN public.products p ON(p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE(p.tenant_id,p.catalog_id)=(t,cid)),'[]'));
 RETURN jsonb_build_object('snapshot',jsonb_build_object('catalog',jsonb_build_object('id',cid,'name',cat.name,'version',cat.version::text),'policy',public.catalog_stock_control_policy(cid),'warehouses',wh,'wms_enabled',onw,'row_count',jsonb_array_length(rowsj),'summary',summary,'rows_sha256',public.catalog_stock_control_hash(rowsj)),'rows',rowsj,'blockers',blockers,'raw',raw);END $$;
CREATE FUNCTION catalog_stock_control_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN IF(SELECT count(*) FROM public.catalog_stock_control_previews WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM public.catalog_stock_control_operations WHERE tenant_id=t)>2000 OR coalesce((SELECT sum(pg_column_size(p)) FROM public.catalog_stock_control_previews p WHERE tenant_id=t),0)+coalesce((SELECT sum(pg_column_size(p)) FROM public.catalog_stock_control_operations p WHERE tenant_id=t),0)>134217728 THEN RAISE EXCEPTION 'Limit pełnej historii BO' USING ERRCODE='54000';END IF;END $$;
CREATE FUNCTION catalog_stock_control_lock(cid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;w uuid;BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('catalog.strict.lifecycle:'||t,0));PERFORM public.product_catalog_lock();PERFORM 1 FROM public.product_catalogs WHERE(tenant_id,id)=(t,cid) FOR SHARE;FOR w IN SELECT warehouse_id FROM public.product_catalog_warehouses WHERE(tenant_id,catalog_id)=(t,cid) ORDER BY warehouse_id LOOP PERFORM public.warehouse_inventory_policy_lock(t,w);END LOOP;PERFORM pg_advisory_xact_lock(hashtextextended('catalog.strict.quota:'||t,0));END $$;
CREATE FUNCTION catalog_stock_control_preview(uid uuid,kid uuid,cid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$ DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.catalog_stock_control_previews;f jsonb;BEGIN PERFORM public.catalog_stock_control_require();PERFORM public.catalog_stock_control_access(uid,kid,true,false);PERFORM public.catalog_stock_control_lock(cid);
 SELECT * INTO p FROM public.catalog_stock_control_previews WHERE(tenant_id,actor_id,client_key)=(t,uid,(b->>'client_key')::uuid);IF p.id IS NOT NULL THEN IF p.api_key_id IS DISTINCT FROM kid OR p.catalog_id<>cid OR p.request<>b THEN RAISE EXCEPTION 'Inna treść klucza BO' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('preview',to_jsonb(p),'reused',true);END IF;
 f:=public.catalog_stock_control_frame(cid);IF b->>'catalog_version'<>f#>>'{snapshot,catalog,version}' OR b->>'policy_version'<>f#>>'{snapshot,policy,version}' OR b->'warehouse_policy_versions'<>(SELECT jsonb_agg(jsonb_build_object('warehouse_id',v->'id','version',v#>'{policy,version}') ORDER BY v->>'id') FROM jsonb_array_elements(f#>'{snapshot,warehouses}')v) OR b->'series_versions'<>(SELECT jsonb_agg(jsonb_build_object('warehouse_id',v->'id','version',v#>'{series,version}') ORDER BY v->>'id') FROM jsonb_array_elements(f#>'{snapshot,warehouses}')v) THEN RAISE EXCEPTION 'Wersja źródła BO zmieniła się' USING ERRCODE='23514';END IF;
 p.id:=gen_random_uuid();p.nonce:=gen_random_uuid();INSERT INTO public.catalog_stock_control_previews(id,tenant_id,actor_id,api_key_id,client_key,catalog_id,request,request_hash,scope_hash,nonce,frame) VALUES(p.id,t,uid,kid,(b->>'client_key')::uuid,cid,b,public.catalog_stock_control_hash(b),public.catalog_stock_control_hash(f||jsonb_build_object('nonce',p.nonce)),p.nonce,f) RETURNING * INTO p;PERFORM public.catalog_stock_control_budget(t);RETURN jsonb_build_object('preview',to_jsonb(p),'reused',false);END $$;
CREATE FUNCTION catalog_stock_control_next(t uuid,sid uuid,yr integer) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n bigint;BEGIN INSERT INTO public.catalog_stock_control_counters VALUES(t,sid,yr,1) ON CONFLICT(tenant_id,series_id,year) DO UPDATE SET value=catalog_stock_control_counters.value+1 WHERE catalog_stock_control_counters.value<9223372036854775807 RETURNING value INTO n;IF n IS NULL THEN RAISE EXCEPTION 'Wyczerpany licznik dokumentów' USING ERRCODE='54000';END IF;RETURN n;END $$;
CREATE FUNCTION catalog_stock_control_commit(uid uuid,kid uuid,pid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.catalog_stock_control_previews;o public.catalog_stock_control_operations;f jsonb;eid uuid:=gen_random_uuid();wh jsonb;s public.catalog_stock_control_series;did uuid;yr integer:=extract(year FROM transaction_timestamp());n bigint;rowsj jsonb;sumj jsonb;docs jsonb:='[]';doc jsonb;payload jsonb;beforej jsonb;afterj jsonb;
BEGIN PERFORM public.catalog_stock_control_require();PERFORM public.catalog_stock_control_access(uid,kid,true,false);
 SELECT * INTO p FROM public.catalog_stock_control_previews WHERE(tenant_id,id)=(t,pid);IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego podglądu BO' USING ERRCODE='P0002';END IF;
 PERFORM public.catalog_stock_control_lock(p.catalog_id);SELECT * INTO o FROM public.catalog_stock_control_operations WHERE tenant_id=t AND(actor_id=uid AND client_key=(b->>'client_key')::uuid OR preview_id=pid);
 IF o.id IS NOT NULL THEN IF(o.actor_id,o.api_key_id,o.preview_id,o.request) IS DISTINCT FROM(uid,kid,pid,b) THEN RAISE EXCEPTION 'Inna zgoda BO' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('operation',o.payload,'reused',true);END IF;
 IF p.actor_id<>uid OR p.api_key_id IS DISTINCT FROM kid OR p.scope_hash<>b->>'scope_hash' OR b->>'confirmed'<>'true' OR p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Brak pełnej aktualnej zgody BO' USING ERRCODE='23514';END IF;
 f:=public.catalog_stock_control_frame(p.catalog_id);IF f<>p.frame OR jsonb_array_length(f->'blockers')<>0 THEN RAISE EXCEPTION 'Źródło BO zmieniło się lub ma blokady' USING ERRCODE='23514';END IF;
 beforej:=f#>'{snapshot,policy}';afterj:=jsonb_build_object('catalog_id',p.catalog_id,'version','1','strict',true,'operation_id',eid);
 INSERT INTO public.catalog_stock_control_admissions(id,tenant_id,operation_id,catalog_id,frame) VALUES(eid,t,eid,p.catalog_id,f);
 FOR wh IN SELECT value FROM jsonb_array_elements(f#>'{snapshot,warehouses}') ORDER BY value->>'id' LOOP
 INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix) VALUES(gen_random_uuid(),t,(wh->>'id')::uuid,'BO','Bilans otwarcia','BO') ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;
 SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,(wh->>'id')::uuid,'BO') FOR UPDATE;
 n:=public.catalog_stock_control_next(t,s.id,yr);
 did:=gen_random_uuid();SELECT coalesce(jsonb_agg(v ORDER BY(v->>'ordinal')::integer),'[]') INTO rowsj FROM jsonb_array_elements(f->'rows')v WHERE v->>'warehouse_id'=wh->>'id';
 SELECT jsonb_build_object('physical_quantity',coalesce(sum((v->>'quantity')::numeric),0)::text,'reserved_quantity',coalesce(sum((v->>'reserved')::numeric),0)::text)||CASE WHEN(f#>>'{snapshot,wms_enabled}')::boolean THEN jsonb_build_object('known_quantity',coalesce(sum((v->>'quantity')::numeric) FILTER(WHERE v->>'unit_cost_minor' IS NOT NULL),0)::text,'zero_cost_quantity',coalesce(sum((v->>'quantity')::numeric) FILTER(WHERE v->>'unit_cost_minor'='0'),0)::text,'unknown_quantity',coalesce(sum((v->>'quantity')::numeric) FILTER(WHERE v->>'unit_cost_minor' IS NULL),0)::text,'known_value_minor',coalesce(sum((v->>'value_minor')::numeric),0)::text,'currency',f#>'{snapshot,summary,currency}','exponent',f#>'{snapshot,summary,exponent}') ELSE '{}'::jsonb END INTO sumj FROM jsonb_array_elements(rowsj)v;
 doc:=jsonb_build_object('id',did,'operation_id',eid,'catalog_id',p.catalog_id,'warehouse',wh,'kind','BO','number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END),'series_id',s.id,'series_version',s.version::text,'year',yr,'sequence',n::text,'row_count',jsonb_array_length(rowsj),'summary',sumj,'created_at',to_jsonb(transaction_timestamp()));
 INSERT INTO public.catalog_stock_control_documents VALUES(did,t,eid,p.catalog_id,(wh->>'id')::uuid,s.id,yr,n,doc);
 INSERT INTO public.catalog_stock_control_rows SELECT t,did,row_number() OVER(ORDER BY(v->>'ordinal')::integer)-1,(v->>'product_id')::uuid,v FROM jsonb_array_elements(rowsj)v;docs:=docs||jsonb_build_array(doc);END LOOP;
 payload:=jsonb_build_object('id',eid,'catalog_id',p.catalog_id,'preview_id',pid,'client_key',b->'client_key','request',b,'scope_hash',p.scope_hash,'snapshot',f->'snapshot','before',beforej,'after',afterj,'documents',docs,'created_at',to_jsonb(transaction_timestamp()));
 INSERT INTO public.catalog_stock_control_operations VALUES(eid,t,uid,kid,(b->>'client_key')::uuid,p.catalog_id,pid,b,public.catalog_stock_control_hash(b),payload,transaction_timestamp());
 INSERT INTO public.catalog_stock_control_policies VALUES(t,p.catalog_id,1,eid);INSERT INTO public.catalog_stock_control_revisions VALUES(t,p.catalog_id,1,eid,afterj);PERFORM public.catalog_stock_control_budget(t);RETURN jsonb_build_object('operation',payload,'reused',false);END $$;
-- BEGIN PRIVATE SUBXID169 WITNESS
-- AUTHORED_ONLY. Fresh152 composition, before the initial core manifest.
-- No migration/reseed of any accepted152/153 database. No provider/runtime run.
-- PG18 witness (root execution) proves RELEASE deletes a child XID lock while
-- the child tuple survives. Preserve its genuine ownership BEFORE that release.
CREATE TABLE public.catalog_stock_control_xid_claims (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id), root_xid xid8 NOT NULL,
 child_xid bigint NOT NULL CHECK(child_xid BETWEEN 0 AND 4294967295), started_at timestamptz NOT NULL, backend_pid integer NOT NULL,
 PRIMARY KEY(tenant_id,root_xid,child_xid,started_at,backend_pid)
);
CREATE INDEX catalog_stock_control_xid_claims_prune ON public.catalog_stock_control_xid_claims(tenant_id,started_at,root_xid,child_xid);
ALTER TABLE public.catalog_stock_control_xid_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_stock_control_xid_claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_stock_control_xid_claims FROM PUBLIC,dyna_app;

CREATE FUNCTION public.catalog_stock_control_xid_claim_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
   OR (OLD.root_xid,OLD.started_at,OLD.backend_pid)=
    (pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) THEN
   RAISE EXCEPTION 'Nie wolno usunąć aktywnego witnessu' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP<>'INSERT' OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR NEW.root_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.started_at IS DISTINCT FROM transaction_timestamp()
  OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid() OR NEW.child_xid=mod(NEW.root_xid::text::numeric,4294967296)::bigint
  OR NOT EXISTS(SELECT FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='transactionid'
   AND l.mode='ExclusiveLock' AND l.granted AND l.transactionid=NEW.child_xid::text::xid) THEN
  RAISE EXCEPTION 'Witness wymaga bieżącej własnej blokady podtransakcji' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_stock_control_xid_claim_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.catalog_stock_control_xid_claims FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_control_xid_claim_guard();

-- Only MVCC-visible previous-context claims may be pruned. INSERT guard
-- binds every live claim to its actual root/start/PID. Other backend's active
-- writes are not visible; own active/released claims retain exactly that tuple.
-- Copied source-history claims may contain future xid8 values in a new cluster;
-- no pg_xact_status call or low32 status guess is needed or used here.
-- No deferred current-root cleanup: SET CONSTRAINTS may run before later gates.
CREATE FUNCTION public.catalog_stock_control_prune_xid_claims() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE affected integer;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Brak tenant pruning' USING ERRCODE='23514'; END IF;
 WITH ended AS(SELECT tenant_id,root_xid,child_xid,started_at,backend_pid FROM public.catalog_stock_control_xid_claims c
  WHERE c.tenant_id=t AND(c.root_xid,c.started_at,c.backend_pid) IS DISTINCT FROM
   (pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())
  ORDER BY c.started_at,c.root_xid,c.child_xid LIMIT 128 FOR UPDATE SKIP LOCKED)
 DELETE FROM public.catalog_stock_control_xid_claims c USING ended e
  WHERE(c.tenant_id,c.root_xid,c.child_xid,c.started_at,c.backend_pid)=
   (e.tenant_id,e.root_xid,e.child_xid,e.started_at,e.backend_pid);
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected;
END $$;

CREATE FUNCTION public.catalog_stock_control_capture_xid_birth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actual_xmin xid;t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE') OR
 TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN(
  'stock_movements','stock_location_movements','wms_layer_movements','wms_operations',
  'wms_policies','wms_lots','wms_cost_layers','wms_layer_positions','warehouse_documents',
  'stock_location_operations','inventory_bulk_edit_executions','wms_stocktake_postings') THEN
  RAISE EXCEPTION 'Obcy native birth publisher' USING ERRCODE='23514'; END IF;
 IF NEW.tenant_id IS DISTINCT FROM t THEN RAISE EXCEPTION 'Obcy tenant native birth' USING ERRCODE='23514'; END IF;
 -- Literal, indexed native keys. No full-table JSON search, request-selected
 -- table, guessed journal ID, or inferred in-progress/committed transaction.
 IF TG_TABLE_NAME='wms_policies' THEN
  SELECT xmin INTO actual_xmin FROM public.wms_policies WHERE tenant_id=t;
 ELSIF TG_TABLE_NAME='wms_layer_positions' THEN
  SELECT xmin INTO actual_xmin FROM public.wms_layer_positions WHERE
   (tenant_id,warehouse_id,product_id,location,layer_id)=(t,NEW.warehouse_id,NEW.product_id,NEW.location,NEW.layer_id);
 ELSE
  EXECUTE format('SELECT r.xmin FROM public.%I r WHERE r.tenant_id=$1 AND r.id=$2',TG_TABLE_NAME)
   INTO actual_xmin USING t,NEW.id;
 END IF;
 IF actual_xmin IS NULL THEN RAISE EXCEPTION 'Brak rzeczywistego native tuple' USING ERRCODE='23514'; END IF;
 IF actual_xmin=pg_current_xact_id()::xid THEN RETURN NEW; END IF;
 IF EXISTS(SELECT FROM public.catalog_stock_control_xid_claims c WHERE
  (c.tenant_id,c.root_xid,c.child_xid,c.started_at,c.backend_pid)=
  (t,pg_current_xact_id(),actual_xmin::text::bigint,transaction_timestamp(),pg_backend_pid())) THEN RETURN NEW; END IF;
 PERFORM public.catalog_stock_control_prune_xid_claims();
 IF(SELECT count(*) FROM public.catalog_stock_control_xid_claims c WHERE(c.tenant_id,c.root_xid,c.started_at,c.backend_pid)=(t,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()))>=10000 THEN
  RAISE EXCEPTION 'Limit pełnego rejestru podtransakcji' USING ERRCODE='54000'; END IF;
 -- This command runs INSIDE the same active child as the real source write.
 -- Rollback removes the claim too; RELEASE keeps it with the parent. The guard
 -- independently checks actual pg_locks ownership before accepting the claim.
 INSERT INTO public.catalog_stock_control_xid_claims
 VALUES(t,pg_current_xact_id(),actual_xmin::text::bigint,transaction_timestamp(),pg_backend_pid())
 ON CONFLICT(tenant_id,root_xid,child_xid,started_at,backend_pid) DO NOTHING;
 RETURN NEW;
END $$;
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY[
  'stock_movements','stock_location_movements','wms_layer_movements','wms_operations',
  'wms_policies','wms_lots','wms_cost_layers','wms_layer_positions','warehouse_documents',
  'stock_location_operations','inventory_bulk_edit_executions','wms_stocktake_postings'] LOOP
  EXECUTE format('CREATE TRIGGER catalog_stock_control_capture_xid_birth AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_control_capture_xid_birth()',n);
 END LOOP;
END $$;

CREATE FUNCTION public.catalog_stock_control_owns_xmin(row_xmin xid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 RETURN row_xmin=pg_current_xact_id()::xid OR EXISTS(
  SELECT FROM public.catalog_stock_control_xid_claims claim WHERE
   (claim.tenant_id,claim.root_xid,claim.child_xid,claim.started_at,claim.backend_pid)=
   (nullif(current_setting('app.tenant_id',true),'')::uuid,pg_current_xact_id(),row_xmin::text::bigint,transaction_timestamp(),pg_backend_pid()));
END $$;
-- The final core ACL loop revokes ALL four functions from PUBLIC/dyna_app.
-- The core full fingerprint includes this table, its columns/PK/FK/index/ACL,
-- all four function bodies/config/owners and all13 enabled trigger bindings.
-- Staged patch changes the exact core-family relation guard13 ->14. It also
-- substitutes owns_xmin for152/RETURN/COUNT birth checks and trusted collectors;
-- no sum/cost/provenance/native parent/counter/terminal invariant is relaxed.
-- END PRIVATE SUBXID169 WITNESS
-- The effect frame is a physical/journal witness, never a second stock store.
CREATE FUNCTION catalog_stock_control_effect_frame(b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;ps uuid[];ws uuid[];j jsonb;
BEGIN SELECT array_agg(v::uuid ORDER BY v) INTO ps FROM jsonb_array_elements_text(b->'product_ids')v;SELECT array_agg(v::uuid ORDER BY v) INTO ws FROM jsonb_array_elements_text(b->'warehouse_ids')v;
 IF cardinality(ps)>10000 OR cardinality(ws)>100 OR cardinality(ps) IS NULL OR cardinality(ws) IS NULL THEN RAISE EXCEPTION 'Niepoprawny pełny zakres efektu' USING ERRCODE='54000';END IF;
 IF(SELECT count(*) FROM public.stock WHERE tenant_id=t AND product_id=ANY(ps) AND warehouse_id=ANY(ws))>10000 OR(SELECT count(*) FROM public.stock_locations WHERE tenant_id=t AND product_id=ANY(ps) AND warehouse_id=ANY(ws))>10000 OR(SELECT count(*) FROM public.wms_layer_positions WHERE tenant_id=t AND product_id=ANY(ps) AND warehouse_id=ANY(ws))>10000 OR(SELECT count(*) FROM public.stock_movements WHERE public.catalog_stock_control_owns_xmin(xmin) AND tenant_id=t AND product_id=ANY(ps) AND warehouse_id=ANY(ws))>10000 OR(SELECT count(*) FROM public.stock_location_movements WHERE public.catalog_stock_control_owns_xmin(xmin) AND tenant_id=t AND product_id=ANY(ps) AND warehouse_id=ANY(ws))>10000 OR(SELECT count(*) FROM public.wms_layer_movements WHERE public.catalog_stock_control_owns_xmin(xmin) AND tenant_id=t AND product_id=ANY(ps) AND warehouse_id=ANY(ws))>10000 THEN RAISE EXCEPTION 'Limit pełnych komórek lub ruchów bieżącej transakcji' USING ERRCODE='54000';END IF;
 IF(SELECT count(*) FROM public.products WHERE tenant_id=t AND id=ANY(ps))<>cardinality(ps) OR(SELECT count(*) FROM public.warehouses WHERE tenant_id=t AND id=ANY(ws))<>cardinality(ws) THEN RAISE EXCEPTION 'Obcy zakres fizycznego efektu' USING ERRCODE='23514';END IF;
 SELECT jsonb_build_object('stock',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id) FROM public.stock s WHERE s.tenant_id=t AND s.product_id=ANY(ps) AND s.warehouse_id=ANY(ws)),'[]'),'bins',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id,s.location) FROM public.stock_locations s WHERE s.tenant_id=t AND s.product_id=ANY(ps) AND s.warehouse_id=ANY(ws)),'[]'),'positions',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.warehouse_id,s.product_id,s.location,s.layer_id) FROM public.wms_layer_positions s WHERE s.tenant_id=t AND s.product_id=ANY(ps) AND s.warehouse_id=ANY(ws)),'[]'),'stock_journals',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.stock_movements s WHERE public.catalog_stock_control_owns_xmin(s.xmin) AND s.tenant_id=t AND s.product_id=ANY(ps) AND s.warehouse_id=ANY(ws)),'[]'),'bin_journals',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.stock_location_movements s WHERE public.catalog_stock_control_owns_xmin(s.xmin) AND s.tenant_id=t AND s.product_id=ANY(ps) AND s.warehouse_id=ANY(ws)),'[]'),'layer_journals',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.wms_layer_movements s WHERE public.catalog_stock_control_owns_xmin(s.xmin) AND s.tenant_id=t AND s.product_id=ANY(ps) AND s.warehouse_id=ANY(ws)),'[]')) INTO j;RETURN j;END $$;
CREATE FUNCTION catalog_stock_control_effect_prepare(uid uuid,kid uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;strictids jsonb;eid uuid:=gen_random_uuid();s public.catalog_stock_control_series;d public.warehouse_documents;w uuid;kindj text;yr integer:=extract(year FROM transaction_timestamp());n bigint;num jsonb;f jsonb;old public.catalog_stock_control_effect_admissions;pv public.wms_previews;
BEGIN PERFORM public.catalog_stock_control_require();
 -- No public activation scopes are imposed on ordinary physical callers; their
 -- actual enclosing source IAM is enlisted by the trusted server adapter.
 IF uid IS NOT NULL AND NOT EXISTS(SELECT FROM public.memberships WHERE(tenant_id,user_id)=(t,uid) AND role IN('admin','operator')) THEN RAISE EXCEPTION 'Brak aktualnego operatora fizycznego efektu' USING ERRCODE='42501';END IF;
 IF b->>'source_kind' NOT IN('warehouse_document','purchase_receipt','dispatch','stocktake','location_operation','wms_movement','wms_receipt','return','wms_opening','catalog_import','inventory_import') THEN RAISE EXCEPTION 'Nieznane źródło fizyczne' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog.strict.lifecycle:'||t,0));
 SELECT coalesce(jsonb_agg(DISTINCT p.catalog_id ORDER BY p.catalog_id),'[]') INTO strictids FROM public.products p JOIN public.catalog_stock_control_policies h ON(h.tenant_id,h.catalog_id)=(p.tenant_id,p.catalog_id) WHERE p.tenant_id=t AND p.id IN(SELECT v::uuid FROM jsonb_array_elements_text(b->'product_ids')v);
 IF jsonb_array_length(strictids)=0 THEN RETURN NULL;END IF;
 FOR w IN SELECT v::uuid FROM jsonb_array_elements_text(b->'warehouse_ids')v ORDER BY v LOOP PERFORM public.warehouse_inventory_policy_lock(t,w);END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended('catalog.strict.quota:'||t,0));
 SELECT * INTO old FROM public.catalog_stock_control_effect_admissions WHERE(tenant_id,source_kind,source_id)=(t,b->>'source_kind',(b->>'source_id')::uuid);
 IF old.id IS NOT NULL THEN IF old.sealed THEN RETURN NULL;END IF;IF old.txid<>pg_current_xact_id() OR old.actor_id IS DISTINCT FROM uid OR old.api_key_id IS DISTINCT FROM kid OR old.request<>b THEN RAISE EXCEPTION 'Inne przyjęcie fizycznego źródła' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('id',old.id,'tenant_id',t,'source',b,'strict_catalog_ids',strictids,'number',old.number);END IF;
 IF b->>'source_kind'='warehouse_document' THEN SELECT * INTO d FROM public.warehouse_documents WHERE(tenant_id,id)=(t,(b->>'source_id')::uuid);IF d.id IS NULL OR d.status<>'draft' THEN RAISE EXCEPTION 'Historyczne źródło nie otrzyma nowego numeru' USING ERRCODE='23514';END IF;kindj:=CASE d.kind WHEN 'receipt' THEN 'PZ' WHEN 'transfer' THEN 'MM' WHEN 'issue' THEN 'WZ' END;IF kindj IS NULL THEN RAISE EXCEPTION 'Pomiar strict wymaga PW/RW' USING ERRCODE='23514';END IF;
 INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix) VALUES(gen_random_uuid(),t,d.warehouse_id,kindj,kindj,kindj) ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;
 SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,d.warehouse_id,kindj) FOR UPDATE;
 n:=public.catalog_stock_control_next(t,s.id,yr);
 num:=jsonb_build_object('kind',kindj,'number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END),'series_id',s.id,'year',yr,'sequence',n::text);END IF;
 IF b->>'source_kind' IN('purchase_receipt','wms_receipt') THEN SELECT v::uuid INTO w FROM jsonb_array_elements_text(b->'warehouse_ids')v;IF jsonb_array_length(b->'warehouse_ids')<>1 THEN RAISE EXCEPTION 'Przyjęcie dostawy ma jeden rzeczywisty magazyn' USING ERRCODE='23514';END IF;INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix) VALUES(gen_random_uuid(),t,w,'PZ','PZ','PZ') ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,w,'PZ') FOR UPDATE;n:=public.catalog_stock_control_next(t,s.id,yr);num:=jsonb_build_object('kind','PZ','number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END),'series_id',s.id,'year',yr,'sequence',n::text);END IF;
 IF b->>'source_kind'='wms_movement' THEN SELECT * INTO pv FROM public.wms_previews WHERE(tenant_id,id,actor_id)=(t,(b->>'source_id')::uuid,uid);IF pv.id IS NULL OR NOT pv.ready OR pv.expires_at<=clock_timestamp() OR pv.kind NOT IN('issue','transfer','bin_move','adjustment') OR b->'product_ids'<>jsonb_build_array(pv.request->'product_id') OR b->'warehouse_ids'<>(SELECT jsonb_agg(v ORDER BY v#>>'{}') FROM jsonb_array_elements(jsonb_build_array(pv.request->'warehouse_id')||CASE WHEN pv.kind='transfer' THEN jsonb_build_array(pv.request->'destination_warehouse_id') ELSE '[]'::jsonb END)v) THEN RAISE EXCEPTION 'Brak własnego gotowego źródła ruchu WMS lub strict PW/RW' USING ERRCODE='23514';END IF;kindj:=CASE pv.kind WHEN 'issue' THEN 'WZ' WHEN 'transfer' THEN 'MM' WHEN 'adjustment' THEN CASE WHEN (pv.request->>'quantity')::integer>0 THEN 'PW' ELSE 'RW' END END;IF kindj IS NOT NULL THEN w:=(pv.request->>'warehouse_id')::uuid;INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix) VALUES(gen_random_uuid(),t,w,kindj,kindj,kindj) ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,w,kindj) FOR UPDATE;n:=public.catalog_stock_control_next(t,s.id,yr);num:=jsonb_build_object('kind',kindj,'number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END),'series_id',s.id,'year',yr,'sequence',n::text);END IF;END IF;
 IF b->>'source_kind'='wms_opening' AND EXISTS(SELECT FROM public.wms_operations o JOIN public.wms_policies h
  ON(h.tenant_id,h.opening_operation_id)=(o.tenant_id,o.id) WHERE o.tenant_id=t AND o.kind='opening'
  AND o.request->>'preview_id'=b->>'source_id') THEN RETURN NULL;END IF;
 IF b->>'source_kind'='wms_opening' THEN
  SELECT * INTO pv FROM public.wms_previews WHERE(tenant_id,id,actor_id)=(t,(b->>'source_id')::uuid,uid);
  IF pv.id IS NULL OR pv.kind<>'opening' OR NOT pv.ready OR pv.expires_at<=clock_timestamp() OR pv.policy_version<>0
   OR b->'product_ids' IS DISTINCT FROM(SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT r->>'product_id' v FROM jsonb_array_elements(pv.snapshot->'rows')r)x)
   OR b->'warehouse_ids' IS DISTINCT FROM(SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT r->>'warehouse_id' v FROM jsonb_array_elements(pv.snapshot->'rows')r)x)
   OR EXISTS(SELECT FROM public.wms_policies WHERE tenant_id=t)
   OR EXISTS(SELECT FROM public.wms_lots WHERE tenant_id=t)
   OR EXISTS(SELECT FROM public.wms_cost_layers WHERE tenant_id=t)
   OR EXISTS(SELECT FROM public.wms_layer_positions WHERE tenant_id=t)
  THEN RAISE EXCEPTION 'Otwarcie strict wymaga własnego pełnego źródła WMS OFF' USING ERRCODE='23514';END IF;
 END IF;
 f:=public.catalog_stock_control_effect_frame(b);
 INSERT INTO public.catalog_stock_control_effect_admissions(id,tenant_id,actor_id,api_key_id,source_kind,source_id,request,before_frame,number) VALUES(eid,t,uid,kid,b->>'source_kind',(b->>'source_id')::uuid,b,f,num);
 RETURN jsonb_build_object('id',eid,'tenant_id',t,'source',b,'strict_catalog_ids',strictids,'number',num);END $$;
CREATE FUNCTION catalog_stock_control_effect_validate(eid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_control_effect_admissions;e public.catalog_stock_control_effects;f jsonb;kindj text;keyj text;ids jsonb;news jsonb;beforej jsonb;afterj jsonb;x jsonb;priorj jsonb;delta numeric;sumdelta numeric;d public.warehouse_documents;op public.wms_operations;pv public.wms_previews;countj bigint;
BEGIN SELECT * INTO a FROM public.catalog_stock_control_effect_admissions WHERE id=eid;IF a.id IS NULL OR a.txid<>pg_current_xact_id() THEN RAISE EXCEPTION 'Brak przyjęcia strict w bieżącej transakcji' USING ERRCODE='23514';END IF;SELECT * INTO e FROM public.catalog_stock_control_effects WHERE(tenant_id,admission_id)=(a.tenant_id,a.id);IF e.admission_id IS NULL THEN RAISE EXCEPTION 'Brak pełnego dokumentu fizycznego efektu' USING ERRCODE='23514';END IF;
 f:=public.catalog_stock_control_effect_frame(a.request);IF NOT EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions later WHERE later.tenant_id=a.tenant_id AND later.txid=a.txid AND later.id<>a.id AND later.sealed AND later.request->'product_ids'=a.request->'product_ids' AND later.request->'warehouse_ids'=a.request->'warehouse_ids' AND later.before_frame=e.after_frame) AND f<>e.after_frame THEN RAISE EXCEPTION 'Zapieczętowany fizyczny efekt zmienił się' USING ERRCODE='23514';END IF;f:=e.after_frame;
 FOREACH kindj IN ARRAY ARRAY['stock','bin','layer'] LOOP keyj:=CASE kindj WHEN 'stock' THEN 'stock_movement_ids' WHEN 'bin' THEN 'location_movement_ids' ELSE 'layer_movement_ids' END;
 ids:=coalesce(e.proof->keyj,'[]');beforej:=a.before_frame->(kindj||'_journals');afterj:=f->(kindj||'_journals');
 IF EXISTS(SELECT FROM jsonb_array_elements(beforej)b WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(afterj)n WHERE n=b)) THEN RAISE EXCEPTION 'Historia fizyczna została zmieniona' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(v->'id' ORDER BY v->>'id'),'[]') INTO news FROM jsonb_array_elements(afterj)v WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(beforej)o WHERE o->>'id'=v->>'id');
 IF news<>(SELECT coalesce(jsonb_agg(v ORDER BY v#>>'{}'),'[]') FROM jsonb_array_elements(ids)v) OR jsonb_array_length(ids)<>(SELECT count(DISTINCT v) FROM jsonb_array_elements(ids)v) THEN RAISE EXCEPTION 'Dowód nie obejmuje wszystkich rzeczywistych ruchów' USING ERRCODE='23514';END IF;END LOOP;
 -- Every signed cell delta equals the actual new journal sum, including net-zero SKU moves.
 FOREACH kindj IN ARRAY ARRAY['stock','bins','positions'] LOOP
 WITH old_cells AS(SELECT v->>'warehouse_id' w,v->>'product_id' p,CASE WHEN kindj='stock' THEN '' ELSE v->>'location' END l,CASE WHEN kindj='positions' THEN v->>'layer_id' ELSE '' END layer,(v->>(CASE WHEN kindj='stock' THEN 'on_hand' ELSE 'quantity' END))::numeric q FROM jsonb_array_elements(a.before_frame->kindj)v),
 new_cells AS(SELECT v->>'warehouse_id' w,v->>'product_id' p,CASE WHEN kindj='stock' THEN '' ELSE v->>'location' END l,CASE WHEN kindj='positions' THEN v->>'layer_id' ELSE '' END layer,(v->>(CASE WHEN kindj='stock' THEN 'on_hand' ELSE 'quantity' END))::numeric q FROM jsonb_array_elements(f->kindj)v),
 journals AS(SELECT v->>'warehouse_id' w,v->>'product_id' p,CASE WHEN kindj='stock' THEN '' ELSE v->>'location' END l,CASE WHEN kindj='positions' THEN v->>'layer_id' ELSE '' END layer,sum((v->>'delta')::numeric) delta FROM jsonb_array_elements(f->(CASE kindj WHEN 'stock' THEN 'stock_journals' WHEN 'bins' THEN 'bin_journals' ELSE 'layer_journals' END))v WHERE v->'id' IN(SELECT value FROM jsonb_array_elements(e.proof->(CASE kindj WHEN 'stock' THEN 'stock_movement_ids' WHEN 'bins' THEN 'location_movement_ids' ELSE 'layer_movement_ids' END))) GROUP BY 1,2,3,4),
 cells AS(SELECT coalesce(n.w,o.w) w,coalesce(n.p,o.p) p,coalesce(n.l,o.l) l,coalesce(n.layer,o.layer) layer,coalesce(n.q,0)-coalesce(o.q,0) delta FROM old_cells o FULL JOIN new_cells n USING(w,p,l,layer))
 SELECT count(*) INTO countj FROM cells c FULL JOIN journals j USING(w,p,l,layer) WHERE coalesce(c.delta,0)<>coalesce(j.delta,0);
 IF countj<>0 THEN RAISE EXCEPTION 'Ruch nie odpowiada dokładnemu stanowi komórki' USING ERRCODE='23514';END IF;END LOOP;
 IF a.source_kind IN('warehouse_document','purchase_receipt','wms_movement','wms_receipt') THEN SELECT * INTO d FROM public.warehouse_documents WHERE(tenant_id,id)=(a.tenant_id,(e.proof->>'warehouse_document_id')::uuid);IF d.id IS NULL OR d.status<>'posted' OR(a.source_kind='warehouse_document' AND d.id<>a.source_id) OR(a.number IS NOT NULL AND d.number<>a.number->>'number' AND NOT(a.source_kind='wms_movement' AND EXISTS(SELECT FROM public.wms_previews wp WHERE(wp.tenant_id,wp.id)=(a.tenant_id,a.source_id) AND wp.kind='adjustment'))) THEN RAISE EXCEPTION 'Brak rzeczywistego zaksięgowanego dokumentu' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(f->'stock_journals')v WHERE v->'id' IN(SELECT value FROM jsonb_array_elements(e.proof->'stock_movement_ids')) AND v->>'warehouse_document_id' IS DISTINCT FROM d.id::text) THEN RAISE EXCEPTION 'Ruch obcego dokumentu' USING ERRCODE='23514';END IF;
 IF a.source_kind='purchase_receipt' AND NOT EXISTS(SELECT FROM public.purchase_receipts pr JOIN public.purchase_orders po ON(po.tenant_id,po.id)=(pr.tenant_id,pr.order_id) WHERE(pr.tenant_id,pr.id,pr.document_id)=(a.tenant_id,a.source_id,d.id) AND pr.id=e.purchase_receipt_id AND po.warehouse_id=d.warehouse_id AND NOT EXISTS(SELECT FROM public.purchase_receipt_lines l WHERE(l.tenant_id,l.receipt_id)=(pr.tenant_id,pr.id) AND NOT EXISTS(SELECT FROM public.warehouse_document_lines dl WHERE(dl.tenant_id,dl.document_id,dl.product_id,dl.quantity,dl.location)=(l.tenant_id,d.id,l.product_id,l.quantity,l.location)))) THEN RAISE EXCEPTION 'Dowód PZ nie odpowiada rzeczywistemu przyjęciu dostawy' USING ERRCODE='23514';END IF;
 IF a.source_kind IN('wms_movement','wms_receipt') THEN SELECT * INTO op FROM public.wms_operations WHERE(tenant_id,id)=(a.tenant_id,e.operation_id);IF op.id IS NULL OR op.warehouse_document_id IS DISTINCT FROM d.id OR(a.source_kind='wms_receipt' AND(op.kind<>'receipt' OR op.client_key<>a.source_id OR op.purchase_receipt_id IS NOT NULL)) OR(a.source_kind='wms_movement' AND op.request->>'preview_id' IS DISTINCT FROM a.source_id::text) THEN RAISE EXCEPTION 'Dokument nie odpowiada rzeczywistemu źródłu WMS' USING ERRCODE='23514';END IF;IF a.source_kind='wms_movement' THEN SELECT * INTO pv FROM public.wms_previews WHERE(tenant_id,id)=(a.tenant_id,a.source_id);IF pv.id IS NULL OR pv.kind<>op.kind OR d.reference<>'WMS/'||pv.id OR d.warehouse_id<>(pv.request->>'warehouse_id')::uuid THEN RAISE EXCEPTION 'Obcy zapisany plan ruchu WMS' USING ERRCODE='23514';END IF;IF pv.kind='adjustment' AND e.proof->'correction_document' IS DISTINCT FROM public.catalog_stock_control_wms_correction_build(a.id,e.proof) THEN RAISE EXCEPTION 'Niepełny zapisany dokument PW/RW korekty' USING ERRCODE='23514';END IF;END IF;END IF;
 ELSIF a.source_kind='wms_opening' THEN
  SELECT * INTO pv FROM public.wms_previews WHERE(tenant_id,id,actor_id)=(a.tenant_id,a.source_id,a.actor_id);
  SELECT * INTO op FROM public.wms_operations WHERE(tenant_id,id)=(a.tenant_id,e.operation_id);
  IF pv.id IS NULL OR pv.kind<>'opening' OR NOT pv.ready OR pv.policy_version<>0 OR op.id IS NULL
   OR op.kind<>'opening' OR op.actor_id IS DISTINCT FROM a.actor_id OR op.policy_version<>1
   OR op.request->>'preview_id' IS DISTINCT FROM pv.id::text OR op.request->>'scope_hash' IS DISTINCT FROM pv.scope_hash
   OR op.request->'confirmed' IS DISTINCT FROM 'true'::jsonb
   OR (pv.snapshot->'valuation'->>'unknown_quantity'<>'0' AND op.request->'ack_unknown_costs' IS DISTINCT FROM 'true'::jsonb)
   OR NOT EXISTS(SELECT FROM public.wms_operations o WHERE(o.tenant_id,o.id)=(a.tenant_id,op.id) AND public.catalog_stock_control_owns_xmin(o.xmin))
   OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL OR op.order_id IS NOT NULL OR op.return_id IS NOT NULL
   OR e.warehouse_document_id IS NOT NULL OR e.location_operation_id IS NOT NULL OR a.number IS NOT NULL
   OR a.before_frame->'stock'<>f->'stock' OR a.before_frame->'bins'<>f->'bins'
   OR a.before_frame->'positions'<>'[]'::jsonb
   OR e.proof->'stock_movement_ids'<>'[]'::jsonb OR e.proof->'location_movement_ids'<>'[]'::jsonb
   OR NOT EXISTS(SELECT FROM public.wms_policies h WHERE h.tenant_id=a.tenant_id AND h.enabled AND h.version=1
    AND h.method='FIFO' AND h.opening_operation_id=op.id AND h.currency=pv.request->>'currency' AND h.exponent=2 AND public.catalog_stock_control_owns_xmin(h.xmin))
  THEN RAISE EXCEPTION 'Otwarcie warstw nie odpowiada rzeczywistemu źródłu WMS OFF' USING ERRCODE='23514';END IF;
  -- Every positive physical bin in the entire tenant, including nonstrict
  -- catalogs, is represented once. Opening never writes stock or a second PZ.
  WITH expected AS(SELECT r->>'warehouse_id' w,r->>'product_id' p,r->>'location' l,(r->>'quantity')::integer q
    FROM jsonb_array_elements(pv.snapshot->'rows')r),
   physical AS(SELECT warehouse_id::text w,product_id::text p,location l,quantity q FROM public.stock_locations WHERE tenant_id=a.tenant_id AND quantity>0)
  SELECT count(*) INTO countj FROM expected FULL JOIN physical USING(w,p,l) WHERE expected.q IS DISTINCT FROM physical.q;
  IF countj<>0 THEN RAISE EXCEPTION 'Otwarcie nie obejmuje całego zapasu firmy' USING ERRCODE='23514';END IF;
  WITH expected AS(SELECT r->>'warehouse_id' w,r->>'product_id' p,r->>'location' l,(r->>'quantity')::integer q,
    r->>'lot_code' code,(r->>'unit_cost_minor')::bigint cost,r->>'currency' currency FROM jsonb_array_elements(pv.snapshot->'rows')r),
   actual AS(SELECT pos.warehouse_id::text w,pos.product_id::text p,pos.location l,pos.quantity q,lot.lot_code code,cl.unit_cost_minor cost,cl.currency
    FROM public.wms_layer_positions pos JOIN public.wms_cost_layers cl ON(cl.tenant_id,cl.id,cl.product_id)=(pos.tenant_id,pos.layer_id,pos.product_id)
    JOIN public.wms_lots lot ON(lot.tenant_id,lot.id,lot.product_id)=(cl.tenant_id,cl.lot_id,cl.product_id)
    WHERE pos.tenant_id=a.tenant_id AND cl.operation_id=op.id AND lot.operation_id=op.id AND lot.origin='opening'
     AND pos.reserved=0 AND cl.quantity_received=pos.quantity AND cl.exponent=2 AND cl.warehouse_document_id IS NULL AND cl.purchase_receipt_id IS NULL
     AND public.catalog_stock_control_owns_xmin(pos.xmin) AND public.catalog_stock_control_owns_xmin(cl.xmin) AND public.catalog_stock_control_owns_xmin(lot.xmin))
  SELECT count(*) INTO countj FROM expected FULL JOIN actual USING(w,p,l) WHERE expected.q IS DISTINCT FROM actual.q OR expected.code IS DISTINCT FROM actual.code
    OR expected.cost IS DISTINCT FROM actual.cost OR expected.currency IS DISTINCT FROM actual.currency;
  IF countj<>0 OR jsonb_array_length(f->'positions')<>jsonb_array_length(pv.snapshot->'rows')
   OR(SELECT count(*) FROM public.wms_lots WHERE tenant_id=a.tenant_id)<>jsonb_array_length(pv.snapshot->'rows')
   OR(SELECT count(*) FROM public.wms_cost_layers WHERE tenant_id=a.tenant_id)<>jsonb_array_length(pv.snapshot->'rows')
   OR jsonb_array_length(e.proof->'layer_movement_ids')<>jsonb_array_length(pv.snapshot->'rows')
   OR EXISTS(SELECT FROM jsonb_array_elements(f->'layer_journals')j WHERE j->'id' IN(SELECT value FROM jsonb_array_elements(e.proof->'layer_movement_ids'))
     AND(j->>'operation_id' IS DISTINCT FROM op.id::text OR j->>'kind'<>'opening' OR(j->>'delta')::integer<=0))
  THEN RAISE EXCEPTION 'Otwarcie nie odtwarza dokładnych partii, ilości i kosztów źródła' USING ERRCODE='23514';END IF;
 ELSIF a.source_kind='inventory_import' THEN PERFORM public.catalog_stock_count_validate(eid);
 ELSIF a.source_kind='return' THEN PERFORM public.catalog_stock_return_validate(eid);
 ELSIF a.source_kind='dispatch' THEN IF NOT EXISTS(SELECT FROM public.warehouse_wz_issuer_receipts r WHERE r.tenant_id=a.tenant_id AND r.shipment_id=a.source_id AND r.id=e.dispatch_receipt_id AND EXISTS(SELECT FROM public.warehouse_wz_issuer_admissions wa WHERE(wa.tenant_id,wa.id,wa.txid)=(r.tenant_id,r.id,pg_current_xact_id()))) THEN RAISE EXCEPTION 'Brak pełnego automatycznego WZ' USING ERRCODE='23514';END IF;
 ELSIF a.source_kind='stocktake' THEN IF NOT EXISTS(SELECT FROM public.stocktake_adjustment_receipts r WHERE r.tenant_id=a.tenant_id AND r.id=a.source_id AND r.id=e.adjustment_receipt_id AND EXISTS(SELECT FROM public.stocktake_adjustment_admissions sa WHERE(sa.tenant_id,sa.id,sa.txid)=(r.tenant_id,r.id,pg_current_xact_id()))) THEN RAISE EXCEPTION 'Brak pełnego PW/RW' USING ERRCODE='23514';END IF;
 ELSIF a.source_kind='location_operation' THEN IF NOT EXISTS(SELECT FROM public.stock_location_operations o WHERE(o.tenant_id,o.id)=(a.tenant_id,a.source_id) AND o.id=e.location_operation_id AND public.catalog_stock_control_owns_xmin(o.xmin) AND o.result->>'kind'='move') OR e.operation_id IS NOT NULL OR EXISTS(SELECT FROM jsonb_array_elements(f->'bin_journals')j WHERE j->'id' IN(SELECT value FROM jsonb_array_elements(e.proof->'location_movement_ids')) AND j->>'operation_id' IS DISTINCT FROM a.source_id::text) OR EXISTS(SELECT FROM jsonb_array_elements(f->'stock')v WHERE coalesce((v->>'on_hand')::integer,0) IS DISTINCT FROM(SELECT(o->>'on_hand')::integer FROM jsonb_array_elements(a.before_frame->'stock')o WHERE(o->>'warehouse_id',o->>'product_id')=(v->>'warehouse_id',v->>'product_id'))) THEN RAISE EXCEPTION 'Pomiar strict wymaga PW/RW; relokacja wymaga dowodu' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Źródło strict wymaga certyfikowanego adaptera dokumentu' USING ERRCODE='23514';END IF;END $$;
-- Fresh-install candidate only: immutable correction publication inside
-- existing typed effect proof; no artificial149/086/115 source and no DML stock.
CREATE FUNCTION catalog_stock_control_wms_correction_build(eid uuid,b jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_control_effect_admissions;pv public.wms_previews;op public.wms_operations;
 d public.warehouse_documents;cl public.wms_cost_layers;lot public.wms_lots;s public.catalog_stock_control_series;w public.warehouses;
 j record;qty integer;direction text;rowsj jsonb:='[]';actualids jsonb;wantedids jsonb;
 curr text;exp integer;seen bigint:=0;unknownq bigint:=0;zeroq bigint:=0;known numeric:=0;expectedj jsonb;actualj jsonb;publication jsonb;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_control_effect_admissions WHERE id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 SELECT * INTO pv FROM public.wms_previews WHERE(tenant_id,id,actor_id)=(a.tenant_id,a.source_id,a.actor_id);
 SELECT * INTO op FROM public.wms_operations WHERE(tenant_id,id)=(a.tenant_id,(b->>'operation_id')::uuid);
 SELECT * INTO d FROM public.warehouse_documents WHERE(tenant_id,id)=(a.tenant_id,(b->>'warehouse_document_id')::uuid);
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR a.source_kind<>'wms_movement'
  OR pv.id IS NULL OR pv.kind<>'adjustment' OR NOT pv.ready OR op.id IS NULL OR op.kind<>'adjustment'
  OR op.actor_id IS DISTINCT FROM a.actor_id OR op.warehouse_document_id IS DISTINCT FROM d.id
  OR op.request->>'preview_id' IS DISTINCT FROM pv.id::text OR op.request->>'scope_hash' IS DISTINCT FROM pv.scope_hash
  OR op.request->'confirmed' IS DISTINCT FROM 'true'::jsonb OR op.client_key IS DISTINCT FROM(op.request->>'client_key')::uuid
  OR op.order_id IS NOT NULL OR op.return_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL
  OR NOT EXISTS(SELECT FROM public.wms_operations x WHERE(x.tenant_id,x.id)=(a.tenant_id,op.id) AND public.catalog_stock_control_owns_xmin(x.xmin)) OR d.id IS NULL OR d.status<>'posted'
  OR d.reference IS DISTINCT FROM 'WMS/'||pv.id OR d.warehouse_id IS DISTINCT FROM(pv.request->>'warehouse_id')::uuid
  OR d.destination_id IS NOT NULL OR NOT EXISTS(SELECT FROM public.warehouse_documents x WHERE(x.tenant_id,x.id)=(a.tenant_id,d.id) AND public.catalog_stock_control_owns_xmin(x.xmin))
  OR a.request->'product_ids'<>jsonb_build_array(pv.request->'product_id')
  OR a.request->'warehouse_ids'<>jsonb_build_array(pv.request->'warehouse_id')
 THEN RAISE EXCEPTION 'Brak rzeczywistego źródła korekty WMS' USING ERRCODE='23514';END IF;
 qty:=(pv.request->>'quantity')::integer;direction:=CASE WHEN qty>0 THEN 'PW' ELSE 'RW' END;
 curr:=pv.snapshot#>>'{policy,currency}';exp:=(pv.snapshot#>>'{policy,exponent}')::integer;
 SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,id,warehouse_id,kind)=(a.tenant_id,(a.number->>'series_id')::uuid,d.warehouse_id,direction);
 SELECT * INTO w FROM public.warehouses WHERE(tenant_id,id)=(a.tenant_id,d.warehouse_id);
 IF qty=0 OR s.id IS NULL OR a.number->>'kind' IS DISTINCT FROM direction
  OR a.number->>'number' IS DISTINCT FROM s.prefix||'/'||(a.number->>'year')||'/'||
   (CASE WHEN length(a.number->>'sequence')>=6 THEN a.number->>'sequence' ELSE lpad(a.number->>'sequence',6,'0') END)
  OR d.kind IS DISTINCT FROM (CASE WHEN qty>0 THEN 'receipt' ELSE 'issue' END)
  OR(SELECT count(*) FROM public.warehouse_document_lines WHERE(tenant_id,document_id)=(a.tenant_id,d.id))<>1
  OR NOT EXISTS(SELECT FROM public.warehouse_document_lines WHERE(tenant_id,document_id,product_id,location,quantity)=(a.tenant_id,d.id,(pv.request->>'product_id')::uuid,pv.request->>'location',abs(qty)))
 THEN RAISE EXCEPTION 'Dokument korekty ma inny zakres lub numerację' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(b->'stock_movement_ids')<>1 OR jsonb_array_length(b->'location_movement_ids')<>1
  OR(SELECT count(*) FROM public.stock_movements WHERE(tenant_id,warehouse_document_id)=(a.tenant_id,d.id))<>1
  OR NOT EXISTS(SELECT FROM public.stock_movements WHERE(tenant_id,id,warehouse_document_id,warehouse_id,product_id,delta,kind)=(a.tenant_id,(b#>>'{stock_movement_ids,0}')::uuid,d.id,d.warehouse_id,(pv.request->>'product_id')::uuid,qty,'wms_adjustment') AND public.catalog_stock_control_owns_xmin(xmin))
  OR(SELECT count(*) FROM public.stock_location_movements WHERE(tenant_id,operation_id)=(a.tenant_id,op.id))<>1
  OR NOT EXISTS(SELECT FROM public.stock_location_movements WHERE(tenant_id,id,operation_id,warehouse_id,product_id,location,delta,kind)=(a.tenant_id,(b#>>'{location_movement_ids,0}')::uuid,op.id,d.warehouse_id,(pv.request->>'product_id')::uuid,pv.request->>'location',qty,'wms_adjustment') AND public.catalog_stock_control_owns_xmin(xmin))
 THEN RAISE EXCEPTION 'Korekta nie odpowiada rzeczywistym journalom' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(id) ORDER BY id),'[]') INTO actualids FROM public.wms_layer_movements WHERE(tenant_id,operation_id)=(a.tenant_id,op.id);
 SELECT coalesce(jsonb_agg(v ORDER BY v#>>'{}'),'[]') INTO wantedids FROM jsonb_array_elements(b->'layer_movement_ids')v;
 IF actualids<>wantedids OR jsonb_array_length(actualids)=0 OR jsonb_array_length(actualids)>10000
  OR jsonb_array_length(wantedids)<>(SELECT count(DISTINCT v) FROM jsonb_array_elements(wantedids)v)
 THEN RAISE EXCEPTION 'Niepełny manifest korekty warstw' USING ERRCODE='23514';END IF;
 FOR j IN SELECT m.*,m.xmin current_xmin FROM public.wms_layer_movements m WHERE(tenant_id,operation_id)=(a.tenant_id,op.id) ORDER BY layer_id,location,id LOOP
  SELECT * INTO cl FROM public.wms_cost_layers WHERE(tenant_id,id,product_id)=(a.tenant_id,j.layer_id,j.product_id);
  SELECT * INTO lot FROM public.wms_lots WHERE(tenant_id,id,product_id)=(a.tenant_id,cl.lot_id,j.product_id);
  IF NOT public.catalog_stock_control_owns_xmin(j.current_xmin) OR cl.id IS NULL OR lot.id IS NULL OR j.kind<>'adjustment'
   OR(j.warehouse_id,j.product_id,j.location) IS DISTINCT FROM(d.warehouse_id,(pv.request->>'product_id')::uuid,pv.request->>'location')
   OR sign(j.delta)<>sign(qty) OR cl.currency IS DISTINCT FROM curr OR cl.exponent IS DISTINCT FROM exp
   OR j.value_delta IS DISTINCT FROM (CASE WHEN cl.unit_cost_minor IS NULL THEN NULL ELSE j.delta::bigint*cl.unit_cost_minor END)
   OR(qty>0 AND(cl.operation_id<>op.id OR cl.warehouse_document_id IS DISTINCT FROM d.id OR cl.purchase_receipt_id IS NOT NULL
    OR cl.quantity_received<>qty OR lot.operation_id<>op.id OR lot.origin<>'adjustment'
    OR lot.lot_code IS DISTINCT FROM pv.request->>'lot_code' OR cl.unit_cost_minor IS DISTINCT FROM(pv.request->>'unit_cost_minor')::bigint))
  THEN RAISE EXCEPTION 'Korekta utraciła podpisane pochodzenie lub koszt' USING ERRCODE='23514';END IF;
  seen:=seen+abs(j.delta);known:=known+coalesce(abs(j.delta)::numeric*cl.unit_cost_minor,0);
  IF cl.unit_cost_minor IS NULL THEN unknownq:=unknownq+abs(j.delta);ELSIF cl.unit_cost_minor=0 THEN zeroq:=zeroq+abs(j.delta);END IF;
  rowsj:=rowsj||jsonb_build_array(jsonb_build_object('ordinal',jsonb_array_length(rowsj),'product_id',j.product_id,'warehouse_id',j.warehouse_id,
   'location',j.location,'sku',(SELECT sku FROM public.warehouse_document_lines WHERE(tenant_id,document_id,product_id)=(a.tenant_id,d.id,j.product_id)),'name',(SELECT name FROM public.warehouse_document_lines WHERE(tenant_id,document_id,product_id)=(a.tenant_id,d.id,j.product_id)),'quantity',abs(j.delta)::text,'delta',j.delta::text,'stock_movement_id',b#>>'{stock_movement_ids,0}',
   'location_movement_id',b#>>'{location_movement_ids,0}','layer_movement_id',j.id,'operation_id',op.id,'layer_id',cl.id,'lot_id',lot.id,
   'unit_cost_minor',cl.unit_cost_minor::text,'value_minor',CASE WHEN cl.unit_cost_minor IS NULL THEN NULL ELSE(abs(j.delta)::numeric*cl.unit_cost_minor)::text END,
   'currency',cl.currency,'exponent',cl.exponent));
 END LOOP;
 IF seen<>abs(qty) OR(qty>0 AND jsonb_array_length(rowsj)<>1) THEN RAISE EXCEPTION 'Ilość korekty różni się od potwierdzonego zakresu' USING ERRCODE='23514';END IF;
 IF qty<0 THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('layer_id',v->'layer_id','location',v->'location','quantity',(v->>'quantity')::integer,'unit_cost_minor',v->>'unit_cost_minor','currency',v->'currency') ORDER BY v->>'layer_id',v->>'location'),'[]') INTO expectedj FROM jsonb_array_elements(pv.snapshot->'fragments')v;
  SELECT coalesce(jsonb_agg(jsonb_build_object('layer_id',v->'layer_id','location',v->'location','quantity',(v->>'quantity')::integer,'unit_cost_minor',v->>'unit_cost_minor','currency',v->'currency') ORDER BY v->>'layer_id',v->>'location'),'[]') INTO actualj FROM jsonb_array_elements(rowsj)v;
  IF expectedj<>actualj THEN RAISE EXCEPTION 'RW nie odpowiada oryginalnym wybranym warstwom' USING ERRCODE='23514';END IF;
 END IF;
 publication:=jsonb_build_object('id',a.id,'protocol','wms_adjustment','preview_id',pv.id,'operation_id',op.id,'warehouse_document_id',d.id,
  'kind',direction,'number',a.number->>'number','series_id',s.id,'year',a.number->'year','sequence',a.number->>'sequence',
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'code',w.code),'quantity',seen::text,'row_count',jsonb_array_length(rowsj),
  'rows',rowsj,'created_at',op.created_at,'summary',jsonb_build_object('quantity',seen::text,'known_quantity',(seen-unknownq)::text,
   'zero_cost_quantity',zeroq::text,'unknown_quantity',unknownq::text,'known_value_minor',known::text,
   'signed_known_value_minor',CASE WHEN known=0 THEN '0' ELSE(sign(qty)*known)::text END,'currency',curr,'exponent',exp));
 IF octet_length(publication::text)>8388608 THEN RAISE EXCEPTION 'Pełny dokument korekty przekracza limit' USING ERRCODE='54000';END IF;
 RETURN publication;
END $$;
-- Freeze both OLD and NEW identities of actual parents after publication;
-- unrelated native documents keep their existing lifecycle and ACLs.
CREATE FUNCTION catalog_stock_control_wms_correction_seal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE oldj jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 newj jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;v jsonb;did uuid;
BEGIN
 FOR v IN SELECT value FROM jsonb_array_elements(jsonb_build_array(oldj,newj)) LOOP
  did:=CASE WHEN TG_TABLE_NAME='warehouse_documents' THEN(v->>'id')::uuid ELSE(v->>'document_id')::uuid END;
  IF EXISTS(SELECT FROM public.catalog_stock_control_effects e
   JOIN public.catalog_stock_control_effect_admissions a ON(a.tenant_id,a.id)=(e.tenant_id,e.admission_id)
   WHERE(e.tenant_id,e.warehouse_document_id)=((v->>'tenant_id')::uuid,did) AND a.sealed
    AND a.source_kind='wms_movement' AND e.proof#>>'{correction_document,protocol}'='wms_adjustment') THEN
   RAISE EXCEPTION 'Zapieczętowany dokument źródłowy korekty PW/RW' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER catalog_stock_control_wms_correction_seal BEFORE INSERT OR UPDATE OR DELETE ON warehouse_documents
 FOR EACH ROW EXECUTE FUNCTION catalog_stock_control_wms_correction_seal();
CREATE TRIGGER catalog_stock_control_wms_correction_seal BEFORE INSERT OR UPDATE OR DELETE ON warehouse_document_lines
 FOR EACH ROW EXECUTE FUNCTION catalog_stock_control_wms_correction_seal();
CREATE FUNCTION catalog_stock_control_effect_finish(uid uuid,kid uuid,eid uuid,b jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$ DECLARE a public.catalog_stock_control_effect_admissions;BEGIN PERFORM public.catalog_stock_control_require();SELECT * INTO a FROM public.catalog_stock_control_effect_admissions WHERE id=eid FOR UPDATE;IF a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS DISTINCT FROM kid OR a.txid<>pg_current_xact_id() OR a.sealed THEN RAISE EXCEPTION 'Obcy lub zamknięty efekt strict' USING ERRCODE='23514';END IF;IF a.source_kind='wms_movement' AND EXISTS(SELECT FROM public.wms_previews WHERE(tenant_id,id)=(a.tenant_id,a.source_id) AND kind='adjustment') THEN b:=b||jsonb_build_object('correction_document',public.catalog_stock_control_wms_correction_build(eid,b));END IF;INSERT INTO public.catalog_stock_control_effects VALUES(a.tenant_id,a.id,b,public.catalog_stock_control_effect_frame(a.request),(b->>'warehouse_document_id')::uuid,(b->>'operation_id')::uuid,CASE WHEN a.source_kind='purchase_receipt' THEN(b->>'receipt_id')::uuid END,CASE WHEN a.source_kind='dispatch' THEN(b->>'receipt_id')::uuid END,CASE WHEN a.source_kind='stocktake' THEN(b->>'receipt_id')::uuid END,(b->>'location_operation_id')::uuid,CASE WHEN a.source_kind='inventory_import' THEN(b->>'receipt_id')::uuid END);INSERT INTO public.catalog_stock_control_effect_journals SELECT a.tenant_id,a.id,'stock',v::uuid,v::uuid,NULL::uuid,NULL::uuid FROM jsonb_array_elements_text(b->'stock_movement_ids')v UNION ALL SELECT a.tenant_id,a.id,'bin',v::uuid,NULL::uuid,v::uuid,NULL::uuid FROM jsonb_array_elements_text(b->'location_movement_ids')v UNION ALL SELECT a.tenant_id,a.id,'layer',v::uuid,NULL::uuid,NULL::uuid,v::uuid FROM jsonb_array_elements_text(b->'layer_movement_ids')v;PERFORM public.catalog_stock_control_effect_validate(eid);UPDATE public.catalog_stock_control_effect_admissions SET sealed=true WHERE id=eid;END $$;
CREATE FUNCTION catalog_stock_control_effect_abandon(uid uuid,kid uuid,eid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$ DECLARE a public.catalog_stock_control_effect_admissions;n bigint;BEGIN SELECT * INTO a FROM public.catalog_stock_control_effect_admissions WHERE id=eid FOR UPDATE;IF a.id IS NULL OR a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS DISTINCT FROM kid OR a.txid<>pg_current_xact_id() OR a.sealed OR a.before_frame<>public.catalog_stock_control_effect_frame(a.request) THEN RAISE EXCEPTION 'Nie można porzucić zmienionego fizycznego efektu' USING ERRCODE='23514';END IF;IF a.number IS NOT NULL THEN SELECT value INTO n FROM public.catalog_stock_control_counters WHERE(tenant_id,series_id,year)=(a.tenant_id,(a.number->>'series_id')::uuid,(a.number->>'year')::integer) FOR UPDATE;IF n<>(a.number->>'sequence')::bigint THEN RAISE EXCEPTION 'Licznik został już wykorzystany' USING ERRCODE='23514';END IF;IF n=1 THEN DELETE FROM public.catalog_stock_control_counters WHERE(tenant_id,series_id,year)=(a.tenant_id,(a.number->>'series_id')::uuid,(a.number->>'year')::integer);ELSE UPDATE public.catalog_stock_control_counters SET value=value-1 WHERE(tenant_id,series_id,year)=(a.tenant_id,(a.number->>'series_id')::uuid,(a.number->>'year')::integer);END IF;END IF;DELETE FROM public.catalog_stock_control_effect_admissions WHERE id=eid;END $$;
CREATE FUNCTION catalog_stock_control_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_control_admissions;o public.catalog_stock_control_operations;p public.catalog_stock_control_previews;f jsonb;d public.catalog_stock_control_documents;j jsonb;countj integer;
BEGIN SELECT * INTO a FROM public.catalog_stock_control_admissions WHERE id=NEW.id;IF a.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO o FROM public.catalog_stock_control_operations WHERE(tenant_id,id)=(a.tenant_id,a.operation_id);SELECT * INTO p FROM public.catalog_stock_control_previews WHERE(tenant_id,id)=(a.tenant_id,o.preview_id);
 IF a.txid<>pg_current_xact_id() OR o.id IS NULL OR p.id IS NULL OR a.frame<>p.frame OR NOT EXISTS(SELECT FROM public.catalog_stock_control_policies h WHERE(h.tenant_id,h.catalog_id,h.version,h.operation_id)=(a.tenant_id,a.catalog_id,1,o.id)) OR NOT EXISTS(SELECT FROM public.catalog_stock_control_revisions r WHERE(r.tenant_id,r.catalog_id,r.version,r.operation_id)=(a.tenant_id,a.catalog_id,1,o.id) AND r.payload=o.payload->'after') THEN RAISE EXCEPTION 'Brak pełnego grafu aktywacji BO' USING ERRCODE='23514';END IF;
 f:=public.catalog_stock_control_frame(a.catalog_id);IF f->'raw'<>a.frame->'raw' OR f->'rows'<>a.frame->'rows' OR f#>'{snapshot,catalog}'<>a.frame#>'{snapshot,catalog}' THEN RAISE EXCEPTION 'BO nie może zmienić źródłowego zapasu' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO countj FROM public.catalog_stock_control_documents WHERE(tenant_id,operation_id)=(a.tenant_id,o.id);IF countj<>jsonb_array_length(a.frame#>'{snapshot,warehouses}') OR countj<>jsonb_array_length(o.payload->'documents') THEN RAISE EXCEPTION 'Niepełny zakres magazynów BO' USING ERRCODE='23514';END IF;
 FOR d IN SELECT * FROM public.catalog_stock_control_documents WHERE(tenant_id,operation_id)=(a.tenant_id,o.id) LOOP
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(o.payload->'documents')v WHERE v=d.payload) OR d.payload->>'id'<>d.id::text OR d.payload->>'operation_id'<>o.id::text OR(d.payload->>'row_count')::integer<>(SELECT count(*) FROM public.catalog_stock_control_rows WHERE(tenant_id,document_id)=(d.tenant_id,d.id)) OR NOT EXISTS(SELECT FROM public.catalog_stock_control_counters c WHERE(c.tenant_id,c.series_id,c.year)=(d.tenant_id,d.series_id,d.year) AND c.value>=d.sequence) THEN RAISE EXCEPTION 'Niepełny numerowany dokument BO' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(r.payload ORDER BY r.ordinal),'[]') INTO j FROM public.catalog_stock_control_rows r WHERE(r.tenant_id,r.document_id)=(d.tenant_id,d.id);IF j<>(SELECT coalesce(jsonb_agg(v ORDER BY(v->>'ordinal')::integer),'[]') FROM jsonb_array_elements(a.frame->'rows')v WHERE v->>'warehouse_id'=d.warehouse_id::text) THEN RAISE EXCEPTION 'Wiersze BO nie są rzeczywistym snapshotem' USING ERRCODE='23514';END IF;END LOOP;
 UPDATE public.catalog_stock_control_admissions SET sealed=true WHERE id=a.id;RETURN NULL;END $$;
CREATE FUNCTION catalog_stock_control_effect_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN IF EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions WHERE id=NEW.id) THEN PERFORM public.catalog_stock_control_effect_validate(NEW.id);END IF;RETURN NULL;END $$;
CREATE FUNCTION catalog_stock_control_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Niezmienna historia BO lub strict' USING ERRCODE='23514';END $$;
CREATE FUNCTION catalog_stock_control_admission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN IF OLD.txid<>pg_current_xact_id() OR OLD.sealed OR(TG_OP='UPDATE' AND(to_jsonb(OLD)-'sealed')<>(to_jsonb(NEW)-'sealed')) OR(TG_OP='DELETE' AND TG_TABLE_NAME<>'catalog_stock_control_effect_admissions') THEN RAISE EXCEPTION 'Zapieczętowane przyjęcie strict' USING ERRCODE='23514';END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
CREATE TRIGGER catalog_stock_control_admission_guard BEFORE UPDATE OR DELETE ON catalog_stock_control_admissions FOR EACH ROW EXECUTE FUNCTION catalog_stock_control_admission_guard();
CREATE TRIGGER catalog_stock_control_admission_guard BEFORE UPDATE OR DELETE ON catalog_stock_control_effect_admissions FOR EACH ROW EXECUTE FUNCTION catalog_stock_control_admission_guard();
CREATE FUNCTION catalog_stock_control_physical_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t uuid:=(j->>'tenant_id')::uuid;p uuid:=(j->>'product_id')::uuid;w uuid:=(j->>'warehouse_id')::uuid;cid uuid;changed boolean;sealed boolean;
BEGIN SELECT catalog_id INTO cid FROM public.products WHERE(tenant_id,id)=(t,p);
 IF EXISTS(SELECT FROM public.catalog_stock_control_admissions a WHERE(a.tenant_id,a.catalog_id)=(t,cid) AND a.txid=pg_current_xact_id()) THEN RAISE EXCEPTION 'Zapieczętowane źródło BO nie przyjmuje zmian' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM public.catalog_stock_control_policies WHERE(tenant_id,catalog_id)=(t,cid)) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END IF;
 changed:=TG_OP='DELETE' OR(TG_OP='INSERT' AND coalesce((j->>(CASE WHEN TG_TABLE_NAME='stock' THEN 'on_hand' ELSE 'quantity' END))::integer,0)<>0) OR(TG_OP='UPDATE' AND(to_jsonb(OLD)->>(CASE WHEN TG_TABLE_NAME='stock' THEN 'on_hand' ELSE 'quantity' END)) IS DISTINCT FROM(j->>(CASE WHEN TG_TABLE_NAME='stock' THEN 'on_hand' ELSE 'quantity' END)));
 IF NOT EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions open WHERE open.tenant_id=t AND open.txid=pg_current_xact_id() AND NOT open.sealed AND open.request->'product_ids' @>jsonb_build_array(p::text) AND open.request->'warehouse_ids' @>jsonb_build_array(w::text)) AND EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions a WHERE a.tenant_id=t AND a.txid=pg_current_xact_id() AND a.sealed AND a.request->'product_ids' @>jsonb_build_array(p::text) AND a.request->'warehouse_ids' @>jsonb_build_array(w::text)) THEN RAISE EXCEPTION 'Zapieczętowany fizyczny efekt strict' USING ERRCODE='23514';END IF;
 IF changed AND NOT EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions a WHERE a.tenant_id=t AND a.txid=pg_current_xact_id() AND NOT a.sealed AND a.request->'product_ids' @>jsonb_build_array(p::text) AND a.request->'warehouse_ids' @>jsonb_build_array(w::text)) THEN RAISE EXCEPTION 'Fizyczna zmiana strict wymaga pełnego dokumentu i przyjęcia' USING ERRCODE='23514';END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
CREATE FUNCTION catalog_stock_control_journal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE j jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;cid uuid;BEGIN SELECT catalog_id INTO cid FROM public.products WHERE(tenant_id,id)=((j->>'tenant_id')::uuid,(j->>'product_id')::uuid);IF EXISTS(SELECT FROM public.catalog_stock_control_admissions a WHERE a.tenant_id=(j->>'tenant_id')::uuid AND a.catalog_id=cid AND a.txid=pg_current_xact_id()) THEN RAISE EXCEPTION 'Zapieczętowana historia źródła BO' USING ERRCODE='23514';END IF;IF EXISTS(SELECT FROM public.catalog_stock_control_policies h WHERE(h.tenant_id,h.catalog_id)=((j->>'tenant_id')::uuid,cid)) AND(TG_OP<>'INSERT' OR NOT EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions a WHERE a.tenant_id=(j->>'tenant_id')::uuid AND a.txid=pg_current_xact_id() AND NOT a.sealed AND a.request->'product_ids' @>jsonb_build_array(j->>'product_id') AND a.request->'warehouse_ids' @>jsonb_build_array(j->>'warehouse_id'))) THEN RAISE EXCEPTION 'Zapieczętowana historia fizycznego efektu strict' USING ERRCODE='23514';END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
CREATE FUNCTION catalog_stock_control_source_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb;k jsonb;a public.catalog_stock_control_admissions;v jsonb;
BEGIN j:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;k:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 FOR a IN SELECT * FROM public.catalog_stock_control_admissions WHERE txid=pg_current_xact_id() AND tenant_id IN((j->>'tenant_id')::uuid,(k->>'tenant_id')::uuid) LOOP
 IF TG_TABLE_NAME='product_catalogs' AND a.catalog_id IN((j->>'id')::uuid,(k->>'id')::uuid) OR TG_TABLE_NAME='products' AND a.catalog_id IN((j->>'catalog_id')::uuid,(k->>'catalog_id')::uuid) OR TG_TABLE_NAME='product_catalog_warehouses' AND a.catalog_id IN((j->>'catalog_id')::uuid,(k->>'catalog_id')::uuid) THEN RAISE EXCEPTION 'Zapieczętowany pełny zakres BO' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME IN('warehouses','warehouse_inventory_policies') AND EXISTS(SELECT FROM jsonb_array_elements(a.frame#>'{snapshot,warehouses}')w WHERE w->>'id' IN(j->>'warehouse_id',k->>'warehouse_id',j->>'id',k->>'id')) THEN RAISE EXCEPTION 'Zapieczętowany magazyn BO' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME IN('bundle_components','product_sku_aliases','wms_cost_layers','wms_lots') AND EXISTS(SELECT FROM jsonb_array_elements(a.frame#>'{raw,products}')p WHERE p->>'id' IN(j->>'product_id',k->>'product_id',j->>'bundle_id',k->>'bundle_id')) THEN RAISE EXCEPTION 'Zapieczętowane pochodzenie BO' USING ERRCODE='23514';END IF;END LOOP;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
CREATE FUNCTION catalog_stock_control_counter_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE n bigint;wanted bigint;BEGIN SELECT value INTO n FROM public.catalog_stock_control_counters WHERE(tenant_id,series_id,year)=(NEW.tenant_id,NEW.series_id,NEW.year);IF n IS NULL THEN RETURN NULL;END IF;SELECT max(seq) INTO wanted FROM(SELECT sequence seq FROM public.catalog_stock_control_documents WHERE(tenant_id,series_id,year)=(NEW.tenant_id,NEW.series_id,NEW.year) UNION ALL SELECT(a.number->>'sequence')::bigint FROM public.catalog_stock_control_effect_admissions a WHERE a.tenant_id=NEW.tenant_id AND(a.number->>'series_id')::uuid=NEW.series_id AND(a.number->>'year')::integer=NEW.year AND a.sealed UNION ALL SELECT sequence FROM public.catalog_stock_return_documents WHERE(tenant_id,series_id,year)=(NEW.tenant_id,NEW.series_id,NEW.year) UNION ALL SELECT sequence FROM public.catalog_stock_count_documents WHERE(tenant_id,series_id,year)=(NEW.tenant_id,NEW.series_id,NEW.year))x;IF n IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'Licznik BO lub efektu nie ma pełnego dokumentu' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER catalog_stock_control_counter_complete AFTER INSERT OR UPDATE ON catalog_stock_control_counters DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_stock_control_counter_complete();
CREATE CONSTRAINT TRIGGER catalog_stock_control_activation_complete AFTER INSERT ON catalog_stock_control_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_stock_control_complete();
CREATE CONSTRAINT TRIGGER catalog_stock_control_effect_complete AFTER INSERT ON catalog_stock_control_effect_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_stock_control_effect_complete();
DO $$ DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['catalog_stock_control_previews','catalog_stock_control_operations','catalog_stock_control_policies','catalog_stock_control_revisions','catalog_stock_control_series','catalog_stock_control_documents','catalog_stock_control_rows','catalog_stock_control_effects','catalog_stock_control_effect_journals','catalog_stock_control_manifest'] LOOP EXECUTE format('CREATE TRIGGER catalog_stock_control_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_control_immutable()',n);END LOOP;
 FOREACH n IN ARRAY ARRAY['stock','stock_locations','wms_layer_positions'] LOOP EXECUTE format('CREATE TRIGGER catalog_stock_control_physical_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_control_physical_guard()',n);END LOOP;
 FOREACH n IN ARRAY ARRAY['stock_movements','stock_location_movements','wms_layer_movements'] LOOP EXECUTE format('CREATE TRIGGER catalog_stock_control_journal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_control_journal_guard()',n);END LOOP;
 FOREACH n IN ARRAY ARRAY['product_catalogs','product_catalog_warehouses','products','warehouses','warehouse_inventory_policies','bundle_components','product_sku_aliases','wms_cost_layers','wms_lots'] LOOP EXECUTE format('CREATE TRIGGER catalog_stock_control_source_seal BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_control_source_seal()',n);END LOOP;END $$;
-- BEGIN EMBEDDED CATALOG_STOCK_RETURN169 — canonical fragment, one migration152
-- SOURCE FRAGMENT ONLY. Append after152 definitions and before its final
-- manifest capture. Canonical contents are embedded in migration152; this file
-- is an authoring source, never a separately applied migration. No physical
-- UPDATE/INSERT occurs.
-- Not an independently registered migration, and not a certification witness.
CREATE TABLE catalog_stock_return_admissions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,return_id uuid NOT NULL,order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,
 protocol text NOT NULL CHECK(protocol IN('rma','legacy_status','assistant_v1','destinations_v1','exchange','dropship_supplier')),
 preview_id uuid,txid xid8 NOT NULL DEFAULT pg_current_xact_id(),frame jsonb NOT NULL,
 numbers jsonb NOT NULL,sealed boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,return_id),
 FOREIGN KEY(tenant_id,id) REFERENCES public.catalog_stock_control_effect_admissions(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES public.return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.return_assistant_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id)
);
CREATE TABLE catalog_stock_return_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,return_id uuid NOT NULL,order_id uuid NOT NULL,
 assistant_receipt_id uuid,exchange_id uuid,dropship_admission_id uuid,local_proof_id uuid,
 parcel_receipt_return_id uuid,wms_operation_id uuid,proof jsonb NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,return_id),
 FOREIGN KEY(tenant_id,id) REFERENCES public.catalog_stock_return_admissions(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES public.return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,assistant_receipt_id) REFERENCES public.return_assistant_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,exchange_id) REFERENCES public.return_exchanges(tenant_id,id),
 FOREIGN KEY(tenant_id,local_proof_id) REFERENCES public.b2b_return_local_proofs(tenant_id,id),
 FOREIGN KEY(tenant_id,parcel_receipt_return_id) REFERENCES public.order_parcel_return_receipts(tenant_id,return_id),
 FOREIGN KEY(tenant_id,wms_operation_id) REFERENCES public.wms_operations(tenant_id,id),
 --111 proof has no UNIQUE(tenant_id,id); global UUID PK is the physical FK;
 -- validate() independently binds its tenant/RMA/currentTX/actor/key.
 FOREIGN KEY(dropship_admission_id) REFERENCES public.b2b_dropship_return_proofs(id)
);
CREATE TABLE catalog_stock_return_documents (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,return_id uuid NOT NULL,
 warehouse_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),
 number text NOT NULL,payload jsonb NOT NULL,UNIQUE(tenant_id,id),UNIQUE(tenant_id,receipt_id,warehouse_id),
 UNIQUE(tenant_id,series_id,year,sequence),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES public.catalog_stock_return_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,return_id) REFERENCES public.return_cases(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES public.warehouses(tenant_id,id),
 FOREIGN KEY(tenant_id,series_id,year) REFERENCES public.catalog_stock_control_counters(tenant_id,series_id,year)
);
-- A row is one actual incoming bin journal. Layer/stock/commercial allocations
-- are separately typed; a journal's ID is not presented as a fabricated lot ID.
CREATE TABLE catalog_stock_return_rows (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,document_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),
 product_id uuid NOT NULL,warehouse_id uuid NOT NULL,location text NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 bin_movement_id uuid NOT NULL,payload jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id,ordinal),UNIQUE(tenant_id,bin_movement_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.catalog_stock_return_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES public.products(tenant_id,id),
 FOREIGN KEY(tenant_id,warehouse_id,product_id,location) REFERENCES public.stock_locations(tenant_id,warehouse_id,product_id,location),
 FOREIGN KEY(tenant_id,bin_movement_id) REFERENCES public.stock_location_movements(tenant_id,id)
);
CREATE TABLE catalog_stock_return_stock_maps (
 tenant_id uuid NOT NULL,row_id uuid NOT NULL,stock_movement_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tenant_id,row_id,stock_movement_id),
 FOREIGN KEY(tenant_id,row_id) REFERENCES public.catalog_stock_return_rows(tenant_id,id),
 FOREIGN KEY(tenant_id,stock_movement_id) REFERENCES public.stock_movements(tenant_id,id)
);
CREATE TABLE catalog_stock_return_layer_maps (
 tenant_id uuid NOT NULL,row_id uuid NOT NULL,layer_movement_id uuid NOT NULL,fragment_id uuid,
 quantity integer NOT NULL CHECK(quantity>0),payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,row_id,layer_movement_id),
 FOREIGN KEY(tenant_id,row_id) REFERENCES public.catalog_stock_return_rows(tenant_id,id),
 FOREIGN KEY(tenant_id,layer_movement_id) REFERENCES public.wms_layer_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,fragment_id) REFERENCES public.wms_return_fragments(tenant_id,id)
);
CREATE TABLE catalog_stock_return_item_maps (
 tenant_id uuid NOT NULL,row_id uuid NOT NULL,return_id uuid NOT NULL,item_id uuid NOT NULL,
 arrival_id uuid,quantity integer NOT NULL CHECK(quantity>0),id uuid NOT NULL DEFAULT gen_random_uuid(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,row_id) REFERENCES public.catalog_stock_return_rows(tenant_id,id),
 FOREIGN KEY(tenant_id,return_id,item_id) REFERENCES public.return_items(tenant_id,return_id,item_id),
 FOREIGN KEY(tenant_id,arrival_id) REFERENCES public.return_destination_arrivals(tenant_id,id)
);
CREATE TABLE catalog_stock_return_manifest(id boolean PRIMARY KEY DEFAULT true CHECK(id),fingerprint text NOT NULL);
CREATE INDEX catalog_stock_return_admission_rma ON catalog_stock_return_admissions(tenant_id,order_id,return_id);
CREATE INDEX catalog_stock_return_admission_actor ON catalog_stock_return_admissions(actor_id);
CREATE INDEX catalog_stock_return_admission_key ON catalog_stock_return_admissions(tenant_id,api_key_id);
CREATE INDEX catalog_stock_return_receipt_rma ON catalog_stock_return_receipts(tenant_id,order_id,return_id);
CREATE INDEX catalog_stock_return_rows_product ON catalog_stock_return_rows(tenant_id,product_id);
CREATE INDEX catalog_stock_return_admission_preview ON catalog_stock_return_admissions(tenant_id,preview_id);
CREATE INDEX catalog_stock_return_receipt_assistant ON catalog_stock_return_receipts(tenant_id,assistant_receipt_id);
CREATE INDEX catalog_stock_return_receipt_exchange ON catalog_stock_return_receipts(tenant_id,exchange_id);
CREATE INDEX catalog_stock_return_receipt_local ON catalog_stock_return_receipts(tenant_id,local_proof_id);
CREATE INDEX catalog_stock_return_receipt_parcel ON catalog_stock_return_receipts(tenant_id,parcel_receipt_return_id);
CREATE INDEX catalog_stock_return_receipt_wms ON catalog_stock_return_receipts(tenant_id,wms_operation_id);
CREATE INDEX catalog_stock_return_receipt_dropship ON catalog_stock_return_receipts(dropship_admission_id);
CREATE INDEX catalog_stock_return_documents_page ON catalog_stock_return_documents(tenant_id,warehouse_id,id);
CREATE INDEX catalog_stock_return_documents_return ON catalog_stock_return_documents(tenant_id,return_id);
CREATE INDEX catalog_stock_return_rows_cell ON catalog_stock_return_rows(tenant_id,warehouse_id,product_id,location);
CREATE INDEX catalog_stock_return_stock_journal ON catalog_stock_return_stock_maps(tenant_id,stock_movement_id);
CREATE INDEX catalog_stock_return_layer_journal ON catalog_stock_return_layer_maps(tenant_id,layer_movement_id);
CREATE INDEX catalog_stock_return_fragment ON catalog_stock_return_layer_maps(tenant_id,fragment_id);
CREATE INDEX catalog_stock_return_item ON catalog_stock_return_item_maps(tenant_id,return_id,item_id);
CREATE INDEX catalog_stock_return_item_row ON catalog_stock_return_item_maps(tenant_id,row_id);
CREATE INDEX catalog_stock_return_arrival ON catalog_stock_return_item_maps(tenant_id,arrival_id);
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['admissions','receipts','documents','rows','stock_maps','layer_maps','item_maps','manifest'] LOOP
 EXECUTE format('ALTER TABLE public.catalog_stock_return_%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE public.catalog_stock_return_%I FORCE ROW LEVEL SECURITY',n);
 IF n<>'manifest' THEN EXECUTE format('CREATE POLICY owner_scope ON public.catalog_stock_return_%I TO %I USING(true) WITH CHECK(true)',n,current_user);END IF;
 EXECUTE format('REVOKE ALL ON public.catalog_stock_return_%I FROM PUBLIC,dyna_app',n);
 END LOOP;
END $$;

-- BEGIN EMBEDDED LEGACY_RECEIVE_CLOSE169_PHASE
-- SUCCESSOR AUTHORED_ONLY, NOT_INSTALLED. Native63234 second-close rejection confirmed.
-- Original WIP draft remains unchanged. This file is embedded by the companion patch.
-- AUTHORED_ONLY, NOT_INSTALLED. Fresh152 integration only, before RETURN's
-- initial immutable manifest. Never apply to/reseed an installed152 database.
-- Narrow capability: real automation.run, preexisting ordinary legacy OFF RMA,
-- exactly receive -> close. No initiating/ON/112/138/batch/preview authority.
CREATE TABLE catalog_stock_legacy_group_admissions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 run_id uuid NOT NULL REFERENCES automation_runs(id), job_id uuid NOT NULL,
 order_id uuid NOT NULL, return_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 lease_token uuid NOT NULL, txid xid8 NOT NULL, started_at timestamptz NOT NULL, backend_pid integer NOT NULL,
 frame jsonb NOT NULL, phase text NOT NULL DEFAULT 'prepared' CHECK(phase IN('prepared','received','sealed')),
 receipt_id uuid, received_order jsonb, received_return jsonb,
 wms_enabled boolean NOT NULL DEFAULT false, on_admission_id uuid, on_command jsonb,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,run_id), UNIQUE(tenant_id,return_id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES catalog_stock_return_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,on_admission_id) REFERENCES catalog_stock_return_admissions(tenant_id,id),
 CHECK((on_admission_id IS NULL)=(on_command IS NULL)),
 CHECK(wms_enabled OR on_admission_id IS NULL),
 CHECK((phase='prepared')=(receipt_id IS NULL)),
 CHECK((receipt_id IS NULL)=(received_order IS NULL)), CHECK((receipt_id IS NULL)=(received_return IS NULL))
);
CREATE TABLE catalog_stock_legacy_group_receipts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, order_after jsonb NOT NULL, return_after jsonb NOT NULL,
 run_after jsonb NOT NULL, job_after jsonb NOT NULL,
 FOREIGN KEY(tenant_id,id) REFERENCES catalog_stock_legacy_group_admissions(tenant_id,id)
);
CREATE TABLE catalog_stock_legacy_group_manifest (id boolean PRIMARY KEY CHECK(id), fingerprint text NOT NULL);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['admissions','receipts','manifest'] LOOP
  EXECUTE format('ALTER TABLE catalog_stock_legacy_group_%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE catalog_stock_legacy_group_%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('REVOKE ALL ON catalog_stock_legacy_group_%I FROM PUBLIC,dyna_app',n);
 END LOOP;
END $$;
CREATE INDEX catalog_stock_legacy_group_current ON catalog_stock_legacy_group_admissions(tenant_id,txid,return_id);

CREATE FUNCTION catalog_stock_legacy_group_prepare(uid uuid,runid uuid,lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 ar public.automation_runs; j public.jobs; rule public.automation_rules; o public.orders; r public.return_cases; gid uuid;
BEGIN
 PERFORM public.catalog_stock_legacy_group_require();
 SELECT * INTO ar FROM public.automation_runs WHERE(tenant_id,id)=(t,runid);
 SELECT * INTO j FROM public.jobs WHERE(tenant_id,id)=(t,ar.job_id);
 IF ar.id IS NULL OR ar.definition->>'actor_id' IS DISTINCT FROM uid::text THEN
  RAISE EXCEPTION 'Obcy rzeczywisty parent reguły' USING ERRCODE='42501'; END IF;
 IF j.state IS DISTINCT FROM 'running' OR j.lease_token IS DISTINCT FROM lease THEN RETURN NULL; END IF;
 SELECT * INTO rule FROM public.automation_rules WHERE(tenant_id,id)=(t,ar.rule_id);
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,ar.order_id);
 SELECT * INTO r FROM public.return_cases WHERE(tenant_id,order_id)=(t,o.id) AND legacy AND state='requested';
 IF ar.state<>'queued' OR j.kind<>'automation.run' OR j.payload->>'run_id' IS DISTINCT FROM ar.id::text
  OR rule.id IS NULL OR NOT rule.enabled OR rule.version<>ar.rule_version OR rule.actor_id IS DISTINCT FROM uid
  OR ar.definition->'actions' IS DISTINCT FROM '[{"type":"set_status","status":"return_received"},{"type":"set_status","status":"return_completed"}]'::jsonb
  OR rule.config->'actions' IS DISTINCT FROM ar.definition->'actions' OR rule.trigger IS DISTINCT FROM(ar.definition->>'trigger')
  OR rule.trigger IS DISTINCT FROM 'order.return_initiated'
  OR o.id IS NULL OR o.status<>'return_initiated' OR r.id IS NULL
  OR(SELECT count(*) FROM public.return_cases WHERE(tenant_id,order_id)=(t,o.id))<>1
  OR EXISTS(SELECT FROM public.order_parcel_plans WHERE(tenant_id,order_id)=(t,o.id))
  OR EXISTS(SELECT FROM public.b2b_return_local_origins WHERE(tenant_id,return_id)=(t,r.id))
  OR EXISTS(SELECT FROM public.b2b_dropship_return_cases WHERE(tenant_id,return_id)=(t,r.id))
  OR EXISTS(SELECT FROM public.b2b_dropship_return_supplier_cases WHERE(tenant_id,return_id)=(t,r.id)) THEN
  -- Not an authority for another public/native protocol. The caller rolls
  -- back this read-only preflight and preserves the ordinary worker path.
  RETURN NULL; END IF;
 IF public.b2b_dropship_current_role(uid,false) IS DISTINCT FROM 'admin' THEN
  RAISE EXCEPTION 'Brak bieżącego administratora reguły' USING ERRCODE='42501'; END IF;
 PERFORM public.catalog_stock_return_access(uid,NULL,r.id,'legacy_status');
 -- This first capability needs a genuine strict receipt; legacy nonstrict
 -- execution retains its ordinary path. Do not allocate a synthetic group
 -- merely because an order has matching action text.
 IF NOT EXISTS(SELECT FROM public.return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp
   JOIN public.products p ON(p.tenant_id,p.id)=(ri.tenant_id,(comp->>'product_id')::uuid)
   JOIN public.catalog_stock_control_policies policy ON(policy.tenant_id,policy.catalog_id)=(p.tenant_id,p.catalog_id)
   WHERE(ri.tenant_id,ri.return_id)=(t,r.id)) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT FROM public.return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components) comp
   JOIN public.products p ON(p.tenant_id,p.id)=(ri.tenant_id,(comp->>'product_id')::uuid)
   LEFT JOIN public.catalog_stock_control_policies policy ON(policy.tenant_id,policy.catalog_id)=(p.tenant_id,p.catalog_id)
   WHERE(ri.tenant_id,ri.return_id)=(t,r.id) AND policy.catalog_id IS NULL) THEN
  RAISE EXCEPTION 'Mieszany katalog wymaga szerszej grupy' USING ERRCODE='23514'; END IF;
 gid:=gen_random_uuid();
 INSERT INTO public.catalog_stock_legacy_group_admissions(id,tenant_id,run_id,job_id,order_id,return_id,actor_id,lease_token,txid,started_at,backend_pid,frame,wms_enabled)
 VALUES(gid,t,ar.id,j.id,o.id,r.id,uid,lease,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid(),
  jsonb_build_object('run',to_jsonb(ar),'job',to_jsonb(j),'rule',to_jsonb(rule),'order',to_jsonb(o),'return_case',to_jsonb(r)),coalesce((SELECT enabled FROM public.wms_policies WHERE tenant_id=t),false));
 RETURN jsonb_build_object('id',gid,'order_id',o.id,'return_id',r.id,'wms_enabled',coalesce((SELECT enabled FROM public.wms_policies WHERE tenant_id=t),false));
END $$;


-- Private native source witness. No physical writer and no public flag.
CREATE FUNCTION catalog_stock_legacy_group_on_source(rid uuid,q jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid; rc public.return_cases; f jsonb; wanted jsonb; actual jsonb;
BEGIN
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(t,rid);
 SELECT jsonb_build_object(
 'policy',(SELECT to_jsonb(p) FROM public.wms_policies p WHERE p.tenant_id=t),
 'warehouse_policy',(SELECT to_jsonb(p) FROM public.warehouse_inventory_policies p WHERE(p.tenant_id,p.warehouse_id)=(t,rc.warehouse_id)),
 'items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.item_id) FROM public.return_items i WHERE(i.tenant_id,i.return_id)=(t,rid)),'[]'),
 'commercial_items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.order_items i WHERE(i.tenant_id,i.order_id)=(t,rc.order_id)),'[]'),
 'fragments',coalesce((SELECT jsonb_agg(to_jsonb(issue)||jsonb_build_object('returned_quantity',(SELECT coalesce(sum(x.quantity),0) FROM public.wms_return_fragments x WHERE(x.tenant_id,x.issue_fragment_id)=(issue.tenant_id,issue.id))) ORDER BY issue.product_id,issue.id) FROM public.wms_issue_fragments issue WHERE(issue.tenant_id,issue.order_id)=(t,rc.order_id)),'[]'),
 'stocks',coalesce((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.product_id) FROM public.stock st WHERE(st.tenant_id,st.warehouse_id)=(t,rc.warehouse_id) AND st.product_id IN(SELECT(comp->>'product_id')::uuid FROM public.return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components)comp WHERE(ri.tenant_id,ri.return_id)=(t,rid))),'[]')) INTO f;
 IF rc.id IS NULL OR NOT rc.legacy OR rc.state<>'requested' OR rc.receipt IS NOT NULL OR rc.remedy IS NOT DISTINCT FROM 'exchange'
 OR f#>>'{policy,enabled}' IS DISTINCT FROM 'true'
 OR q#>>'{wms_lots,policy_version}' IS DISTINCT FROM f#>>'{policy,version}'
 OR q->>'version' IS DISTINCT FROM rc.version::text
 OR q->>'shipping_refund' IS DISTINCT FROM rc.requested_shipping::text
 OR jsonb_typeof(q->'wms_lots') IS DISTINCT FROM 'object'
 OR jsonb_typeof(q#>'{wms_lots,picks}') IS DISTINCT FROM 'array'
 OR jsonb_typeof(q->'items') IS DISTINCT FROM 'array'
 OR jsonb_array_length(f->'items')=0 OR jsonb_array_length(f->'items')>100
 OR jsonb_array_length(f->'fragments')=0 OR jsonb_array_length(f->'fragments')>500
 OR jsonb_array_length(f->'items')<>jsonb_array_length(f->'commercial_items')
 OR jsonb_array_length(q->'items')<>jsonb_array_length(f->'items')
 OR EXISTS(SELECT FROM jsonb_array_elements(q->'items')x GROUP BY x->>'item_id' HAVING count(*)<>1)
 OR EXISTS(SELECT FROM jsonb_array_elements(f->'items')i WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(q->'items')x JOIN jsonb_array_elements(f->'commercial_items')oi ON oi->>'id'=i->>'item_id'
 WHERE x->>'item_id'=i->>'item_id' AND x->'accepted'=i->'requested' AND x->'restocked'=i->'requested' AND oi->'quantity'=i->'requested' AND i->'accepted'='0'::jsonb AND i->'restocked'='0'::jsonb))
 OR EXISTS(SELECT FROM jsonb_array_elements(f->'fragments')i WHERE(i->>'returned_quantity')::bigint<>0)
 OR(f->'warehouse_policy'<>'null'::jsonb AND(f#>>'{warehouse_policy,enabled}' IS DISTINCT FROM 'true' OR f#>>'{warehouse_policy,usage}' IS DISTINCT FROM 'sale')) THEN
 RAISE EXCEPTION 'ON grupa wymaga pełnego oryginalnego nieprzyjętego RMA' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('issue_fragment_id',x->>'id','quantity',x->'quantity','location','ZWROT') ORDER BY x->>'id'),'[]') INTO wanted FROM jsonb_array_elements(f->'fragments')x;
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'issue_fragment_id'),'[]') INTO actual FROM jsonb_array_elements(q#>'{wms_lots,picks}')x;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'Picks grupy nie są pełnymi oryginalnymi fragmentami ZWROT' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity) ORDER BY product_id),'[]') INTO wanted FROM(
 SELECT comp->>'product_id'product_id,sum((i->>'requested')::bigint*(comp->>'quantity')::bigint)quantity FROM jsonb_array_elements(f->'items')i CROSS JOIN LATERAL jsonb_array_elements(i->'components')comp GROUP BY 1)x;
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity) ORDER BY product_id),'[]') INTO actual FROM(
 SELECT i->>'product_id'product_id,sum((i->>'quantity')::bigint)quantity FROM jsonb_array_elements(f->'fragments')i GROUP BY 1)x;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'Fragmenty nie pokrywają dokładnej receptury' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',x->>'product_id','warehouse_id',x->>'warehouse_id','version',x->>'version') ORDER BY x->>'product_id'),'[]') INTO wanted FROM jsonb_array_elements(f->'stocks')x;
 SELECT coalesce(jsonb_agg(x ORDER BY x->>'product_id'),'[]') INTO actual FROM jsonb_array_elements(q#>'{wms_lots,stock_versions}')x;
 IF actual IS DISTINCT FROM wanted OR jsonb_array_length(actual) IS DISTINCT FROM jsonb_array_length(wanted) OR pg_column_size(f)>8388608 THEN RAISE EXCEPTION 'Nieaktualne pełne wersje zapasu ON grupy' USING ERRCODE='23514'; END IF;
 RETURN f;
END $$;
CREATE FUNCTION catalog_stock_legacy_group_bind_on(uid uuid,gid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE g public.catalog_stock_legacy_group_admissions; a public.catalog_stock_return_admissions; command jsonb;
BEGIN
 PERFORM public.catalog_stock_legacy_group_require();
 SELECT * INTO g FROM public.catalog_stock_legacy_group_admissions WHERE id=gid;
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE(tenant_id,return_id)=(g.tenant_id,g.return_id);
 IF g.id IS NULL OR g.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NOT g.wms_enabled
 OR g.txid<>pg_current_xact_id() OR g.started_at<>transaction_timestamp() OR g.backend_pid<>pg_backend_pid()
 OR g.actor_id IS DISTINCT FROM uid OR g.phase<>'prepared' OR g.on_command IS NOT NULL
 OR a.id IS NULL OR a.sealed OR a.txid<>g.txid OR a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS NOT NULL OR a.protocol<>'legacy_status'
 OR a.frame->'return_case' IS DISTINCT FROM g.frame->'return_case' THEN RAISE EXCEPTION 'Obcy albo powtórny ON command grupy' USING ERRCODE='23514'; END IF;
 IF public.b2b_dropship_current_role(uid,false) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Cofnięto admina ON grupy' USING ERRCODE='42501'; END IF;
 command:=jsonb_build_object('request',a.frame->'request','return_frame',a.frame,'source',public.catalog_stock_legacy_group_on_source(g.return_id,a.frame->'request'));
 UPDATE public.catalog_stock_legacy_group_admissions SET on_admission_id=a.id,on_command=command WHERE id=gid;
END $$;

-- Caller holds actual job/run/rule/order locks obtained AFTER early receive
-- admission. The exact preflight cannot survive a supported intervening change.
CREATE FUNCTION catalog_stock_legacy_group_lock_validate(uid uuid,gid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE g public.catalog_stock_legacy_group_admissions; actual jsonb;
BEGIN
 PERFORM public.catalog_stock_legacy_group_require();
 SELECT * INTO g FROM public.catalog_stock_legacy_group_admissions WHERE id=gid;
 IF g.id IS NULL OR g.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR g.actor_id IS DISTINCT FROM uid OR g.phase IS DISTINCT FROM 'prepared' OR g.txid<>pg_current_xact_id()
  OR g.started_at<>transaction_timestamp() OR g.backend_pid<>pg_backend_pid() THEN
  RAISE EXCEPTION 'Obca przedwczesna grupa' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('run',to_jsonb(ar),'job',to_jsonb(j),'rule',to_jsonb(rule),'order',to_jsonb(o),'return_case',to_jsonb(r)) INTO actual
 FROM public.automation_runs ar JOIN public.jobs j ON(j.tenant_id,j.id)=(ar.tenant_id,ar.job_id)
 JOIN public.automation_rules rule ON(rule.tenant_id,rule.id)=(ar.tenant_id,ar.rule_id)
 JOIN public.orders o ON(o.tenant_id,o.id)=(ar.tenant_id,ar.order_id)
 JOIN public.return_cases r ON(r.tenant_id,r.order_id,r.id)=(o.tenant_id,o.id,g.return_id)
 WHERE(ar.tenant_id,ar.id)=(g.tenant_id,g.run_id);
 IF actual IS DISTINCT FROM g.frame OR g.wms_enabled IS DISTINCT FROM coalesce((SELECT enabled FROM public.wms_policies WHERE tenant_id=g.tenant_id),false)
  OR(g.wms_enabled AND(g.on_command IS NULL OR g.on_command->'source' IS DISTINCT FROM public.catalog_stock_legacy_group_on_source(g.return_id,g.on_command->'request'))) THEN
  RAISE EXCEPTION 'Źródło grupy zmieniło się podczas oczekiwania' USING ERRCODE='23514'; END IF;
 IF public.b2b_dropship_current_role(uid,false) IS DISTINCT FROM 'admin' THEN
  RAISE EXCEPTION 'Cofnięto administratora reguły' USING ERRCODE='42501'; END IF;
 PERFORM public.catalog_stock_return_access(uid,NULL,g.return_id,'legacy_status');
END $$;

CREATE FUNCTION catalog_stock_legacy_group_capture(uid uuid,gid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE g public.catalog_stock_legacy_group_admissions; a public.catalog_stock_return_admissions;
 r public.catalog_stock_return_receipts; o public.orders; rc public.return_cases;
BEGIN
 PERFORM public.catalog_stock_legacy_group_require();
 SELECT * INTO g FROM public.catalog_stock_legacy_group_admissions WHERE id=gid FOR UPDATE;
 IF g.id IS NULL OR g.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR g.actor_id IS DISTINCT FROM uid OR g.phase<>'prepared' OR g.txid<>pg_current_xact_id()
  OR g.started_at<>transaction_timestamp() OR g.backend_pid<>pg_backend_pid() THEN
  RAISE EXCEPTION 'Obca faza grupy' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE(tenant_id,return_id)=(g.tenant_id,g.return_id);
 SELECT * INTO r FROM public.catalog_stock_return_receipts WHERE(tenant_id,id)=(g.tenant_id,a.id);
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(g.tenant_id,g.order_id);
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(g.tenant_id,g.return_id);
 IF a.id IS NULL OR NOT a.sealed OR a.actor_id<>uid OR a.api_key_id IS NOT NULL OR a.protocol<>'legacy_status'
  OR a.txid<>g.txid OR r.id IS NULL OR r.local_proof_id IS NOT NULL OR r.parcel_receipt_return_id IS NOT NULL
  OR (NOT g.wms_enabled AND r.wms_operation_id IS NOT NULL)
  OR(g.wms_enabled AND(a.id IS DISTINCT FROM g.on_admission_id OR a.frame IS DISTINCT FROM g.on_command->'return_frame' OR a.frame->'request' IS DISTINCT FROM g.on_command->'request'
   OR NOT EXISTS(SELECT FROM public.wms_operations op WHERE(op.tenant_id,op.id,op.return_id,op.order_id,op.kind)=(g.tenant_id,r.wms_operation_id,g.return_id,g.order_id,'return')
    AND public.catalog_stock_control_owns_xmin(op.xmin) AND op.actor_id=uid AND op.client_key::text=g.on_command#>>'{request,wms_lots,client_key}'
    AND op.request=g.on_command->'request' AND op.result->'legacy_unknown_layers'='[]'::jsonb)))
  OR r.assistant_receipt_id IS NOT NULL OR r.exchange_id IS NOT NULL OR r.dropship_admission_id IS NOT NULL
  OR a.frame->'return_case' IS DISTINCT FROM g.frame->'return_case' OR r.snapshot->'return_case' IS DISTINCT FROM to_jsonb(rc)
  OR rc.state IS DISTINCT FROM 'refund_pending'
  OR o.status<>'return_received' OR o.workflow_status_id IS NOT NULL OR o.version<>(g.frame->'order'->>'version')::bigint+3
  OR (to_jsonb(o)-ARRAY['status','workflow_status_id','version','updated_at']) IS DISTINCT FROM
     ((g.frame->'order')-ARRAY['status','workflow_status_id','version','updated_at']) THEN
  RAISE EXCEPTION 'Brak rzeczywistego pełnego intermediate receive' USING ERRCODE='23514'; END IF;
 PERFORM public.catalog_stock_return_validate(a.id);
 UPDATE public.catalog_stock_legacy_group_admissions SET phase='received',receipt_id=a.id,received_return=to_jsonb(rc),received_order=to_jsonb(o) WHERE id=gid;
END $$;

-- Read-only source-seal predicate. It does not issue consent, mutate a proof,
-- accept a GUC/public flag, or permit a second receipt/physical writer.
CREATE FUNCTION catalog_stock_legacy_group_close_allowed(oldrc jsonb,newrc jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
BEGIN
 RETURN EXISTS(SELECT FROM public.catalog_stock_legacy_group_admissions g
  WHERE g.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND(g.tenant_id,g.return_id,g.txid,g.started_at,g.backend_pid,g.phase)=
   ((oldrc->>'tenant_id')::uuid,(oldrc->>'id')::uuid,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid(),'received')
  AND g.received_return=oldrc AND newrc->>'state'='closed'
  AND(newrc->>'version')::bigint=(oldrc->>'version')::bigint+1
  AND(newrc-ARRAY['state','version','updated_at'])=(oldrc-ARRAY['state','version','updated_at']));
END $$;

-- Existing169 received receipt remains immutable. A separately authenticated
-- phase receipt proves final close; ordinary non-group validation is unchanged.
CREATE FUNCTION catalog_stock_legacy_group_return_basis(eid uuid,actualrc jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE g public.catalog_stock_legacy_group_admissions;
BEGIN
 SELECT * INTO g FROM public.catalog_stock_legacy_group_admissions WHERE receipt_id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  AND txid=pg_current_xact_id() AND started_at=transaction_timestamp() AND backend_pid=pg_backend_pid();
 IF g.id IS NULL OR actualrc=g.received_return THEN RETURN actualrc; END IF;
 IF g.phase NOT IN('received','sealed') OR g.started_at<>transaction_timestamp() OR g.backend_pid<>pg_backend_pid()
  OR actualrc->>'state'<>'closed' OR(actualrc->>'version')::bigint<>(g.received_return->>'version')::bigint+1
  OR(actualrc-ARRAY['state','version','updated_at']) IS DISTINCT FROM(g.received_return-ARRAY['state','version','updated_at']) THEN
  RAISE EXCEPTION 'Nieautentyczna końcowa faza RMA' USING ERRCODE='23514'; END IF;
 RETURN g.received_return;
END $$;

CREATE FUNCTION catalog_stock_legacy_group_validate(gid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE g public.catalog_stock_legacy_group_admissions; rr public.catalog_stock_legacy_group_receipts;
 a public.catalog_stock_return_admissions; o jsonb; rc jsonb; ar jsonb; j jsonb; rule jsonb;
BEGIN
 SELECT * INTO g FROM public.catalog_stock_legacy_group_admissions WHERE id=gid;
 SELECT * INTO rr FROM public.catalog_stock_legacy_group_receipts WHERE id=gid;
 IF g.id IS NULL OR g.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR g.receipt_id IS NULL OR rr.id IS NULL OR g.txid<>pg_current_xact_id()
  OR g.started_at<>transaction_timestamp() OR g.backend_pid<>pg_backend_pid() THEN
  RAISE EXCEPTION 'Niepełny prawdziwy parent grupy' USING ERRCODE='23514'; END IF;
 SELECT to_jsonb(x) INTO o FROM public.orders x WHERE(tenant_id,id)=(g.tenant_id,g.order_id);
 SELECT to_jsonb(x) INTO rc FROM public.return_cases x WHERE(tenant_id,id)=(g.tenant_id,g.return_id);
 SELECT to_jsonb(x) INTO ar FROM public.automation_runs x WHERE(tenant_id,id)=(g.tenant_id,g.run_id);
 SELECT to_jsonb(x) INTO j FROM public.jobs x WHERE(tenant_id,id)=(g.tenant_id,g.job_id);
 SELECT to_jsonb(x) INTO rule FROM public.automation_rules x WHERE(tenant_id,id)=(g.tenant_id,(g.frame->'run'->>'rule_id')::uuid);
 IF o IS NULL OR rc IS NULL OR ar IS NULL OR j IS NULL OR rule IS DISTINCT FROM g.frame->'rule'
  OR o->>'status' IS DISTINCT FROM 'return_completed' OR o->'workflow_status_id' IS DISTINCT FROM 'null'::jsonb
  OR(o->>'version')::bigint<>(g.received_order->>'version')::bigint+1
  OR(o-ARRAY['status','workflow_status_id','version','updated_at']) IS DISTINCT FROM(g.received_order-ARRAY['status','workflow_status_id','version','updated_at'])
  OR public.catalog_stock_legacy_group_return_basis(g.receipt_id,rc) IS DISTINCT FROM g.received_return
  OR rc->>'state' IS DISTINCT FROM 'closed' OR ar->>'state' IS DISTINCT FROM 'done' OR ar->'error' IS DISTINCT FROM 'null'::jsonb
  OR ar->'finished_at'='null'::jsonb OR (ar-ARRAY['state','result','error','finished_at']) IS DISTINCT FROM((g.frame->'run')-ARRAY['state','result','error','finished_at'])
  OR j->>'state' IS DISTINCT FROM 'done' OR j->'error' IS DISTINCT FROM 'null'::jsonb OR j->'lease_token' IS DISTINCT FROM 'null'::jsonb OR j->'locked_at' IS DISTINCT FROM 'null'::jsonb
  OR(j-ARRAY['state','error','lease_token','locked_at']) IS DISTINCT FROM((g.frame->'job')-ARRAY['state','error','lease_token','locked_at'])
  OR ar->'result' IS DISTINCT FROM jsonb_build_object('matched',true,'reason',NULL,'actions',jsonb_build_array(
    jsonb_build_object('changed',true,'status','return_received','workflow_status_id',NULL,'tags',g.received_order->'tags','version',g.received_order->>'version'),
    jsonb_build_object('changed',true,'status','return_completed','workflow_status_id',NULL,'tags',o->'tags','version',o->>'version')))
  OR rr.order_after IS DISTINCT FROM o OR rr.return_after IS DISTINCT FROM rc OR rr.run_after IS DISTINCT FROM ar OR rr.job_after IS DISTINCT FROM j THEN
  RAISE EXCEPTION 'Końcowy transcript grupy nie odpowiada native parents' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE(tenant_id,id)=(g.tenant_id,g.receipt_id);
 IF a.id IS NULL OR NOT a.sealed OR a.actor_id<>g.actor_id OR a.api_key_id IS NOT NULL OR a.protocol<>'legacy_status'
  OR(g.wms_enabled AND(a.id IS DISTINCT FROM g.on_admission_id OR a.frame IS DISTINCT FROM g.on_command->'return_frame' OR a.frame->'request' IS DISTINCT FROM g.on_command->'request')) THEN
  RAISE EXCEPTION 'Obca zapieczętowana authority receive' USING ERRCODE='23514'; END IF;
 PERFORM public.catalog_stock_control_effect_validate(a.id);
END $$;
CREATE FUNCTION catalog_stock_legacy_group_finish(uid uuid,gid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE g public.catalog_stock_legacy_group_admissions;
BEGIN
 PERFORM public.catalog_stock_legacy_group_require();
 SELECT * INTO g FROM public.catalog_stock_legacy_group_admissions WHERE id=gid FOR UPDATE;
 IF g.id IS NULL OR g.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR g.txid<>pg_current_xact_id() OR g.started_at<>transaction_timestamp() OR g.backend_pid<>pg_backend_pid()
  OR g.actor_id IS DISTINCT FROM uid OR g.phase IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'Obcy finish grupy' USING ERRCODE='42501'; END IF;
 INSERT INTO public.catalog_stock_legacy_group_receipts
 SELECT g.id,g.tenant_id,to_jsonb(o),to_jsonb(r),to_jsonb(ar),to_jsonb(j)
 FROM public.orders o JOIN public.return_cases r ON(r.tenant_id,r.order_id,r.id)=(o.tenant_id,o.id,g.return_id)
 JOIN public.automation_runs ar ON(ar.tenant_id,ar.order_id,ar.id)=(o.tenant_id,o.id,g.run_id)
 JOIN public.jobs j ON(j.tenant_id,j.id)=(o.tenant_id,g.job_id) WHERE(o.tenant_id,o.id)=(g.tenant_id,g.order_id);
 PERFORM public.catalog_stock_legacy_group_validate(gid);
 UPDATE public.catalog_stock_legacy_group_admissions SET phase='sealed' WHERE id=gid;
END $$;

CREATE FUNCTION catalog_stock_legacy_group_record_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE actual jsonb; a public.catalog_stock_return_admissions;
BEGIN
 IF TG_TABLE_NAME='catalog_stock_legacy_group_receipts' THEN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT FROM public.catalog_stock_legacy_group_admissions g WHERE(g.tenant_id,g.id,g.txid,g.started_at,g.backend_pid,g.phase)
    =(NEW.tenant_id,NEW.id,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid(),'received')) THEN
    RAISE EXCEPTION 'Receipt wymaga własnej otwartej fazy' USING ERRCODE='23514'; END IF;
 ELSIF TG_OP='INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
   OR NEW.on_admission_id IS NOT NULL OR NEW.on_command IS NOT NULL
   OR NEW.wms_enabled IS DISTINCT FROM coalesce((SELECT enabled FROM public.wms_policies WHERE tenant_id=NEW.tenant_id),false)
   OR NEW.phase<>'prepared' OR NEW.receipt_id IS NOT NULL OR NEW.txid<>pg_current_xact_id() OR NEW.started_at<>transaction_timestamp() OR NEW.backend_pid<>pg_backend_pid() THEN
   RAISE EXCEPTION 'Nieautentyczna nowa grupa' USING ERRCODE='23514'; END IF;
  SELECT jsonb_build_object('run',to_jsonb(ar),'job',to_jsonb(j),'rule',to_jsonb(rule),'order',to_jsonb(ord),'return_case',to_jsonb(rc)) INTO actual
  FROM public.automation_runs ar
  JOIN public.jobs j ON(j.tenant_id,j.id)=(ar.tenant_id,ar.job_id)
  JOIN public.automation_rules rule ON(rule.tenant_id,rule.id)=(ar.tenant_id,ar.rule_id)
  JOIN public.orders ord ON(ord.tenant_id,ord.id)=(ar.tenant_id,ar.order_id)
  JOIN public.return_cases rc ON(rc.tenant_id,rc.order_id,rc.id)=(ord.tenant_id,ord.id,NEW.return_id)
  WHERE(ar.tenant_id,ar.id,j.id,ord.id)=(NEW.tenant_id,NEW.run_id,NEW.job_id,NEW.order_id)
   AND ar.state='queued' AND j.kind='automation.run' AND j.state='running' AND j.lease_token=NEW.lease_token
   AND j.payload->>'run_id'=ar.id::text AND ar.definition->>'actor_id'=NEW.actor_id::text
   AND rule.actor_id=NEW.actor_id AND rule.enabled AND rule.version=ar.rule_version
   AND rule.trigger='order.return_initiated' AND ar.definition->>'trigger'=rule.trigger
   AND ar.definition->'actions'='[{"type":"set_status","status":"return_received"},{"type":"set_status","status":"return_completed"}]'::jsonb
   AND rule.config->'actions'=ar.definition->'actions'
   AND ord.status='return_initiated' AND rc.legacy AND rc.state='requested';
  IF actual IS DISTINCT FROM NEW.frame OR pg_column_size(NEW.frame)>8388608 THEN
   RAISE EXCEPTION 'Grupa nie pochodzi z rzeczywistych zamrożonych native parents' USING ERRCODE='23514'; END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.phase='prepared' AND NEW.phase='prepared' AND OLD.wms_enabled AND OLD.on_admission_id IS NULL AND OLD.on_command IS NULL THEN
   SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE(tenant_id,id)=(OLD.tenant_id,NEW.on_admission_id);
   IF OLD.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR OLD.txid<>pg_current_xact_id()
    OR OLD.started_at<>transaction_timestamp() OR OLD.backend_pid<>pg_backend_pid()
    OR(to_jsonb(OLD)-ARRAY['on_admission_id','on_command']) IS DISTINCT FROM(to_jsonb(NEW)-ARRAY['on_admission_id','on_command'])
    OR a.id IS NULL OR a.sealed OR a.txid<>OLD.txid OR a.return_id<>OLD.return_id OR a.order_id<>OLD.order_id OR a.actor_id<>OLD.actor_id OR a.api_key_id IS NOT NULL OR a.protocol<>'legacy_status'
    OR a.frame->'return_case' IS DISTINCT FROM OLD.frame->'return_case'
    OR NEW.on_command IS DISTINCT FROM jsonb_build_object('request',a.frame->'request','return_frame',a.frame,'source',public.catalog_stock_legacy_group_on_source(OLD.return_id,a.frame->'request')) THEN
    RAISE EXCEPTION 'Niezmienna autentyczna komenda ON grupy' USING ERRCODE='23514'; END IF;
   RETURN NEW;
  END IF;
  IF OLD.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR OLD.txid<>pg_current_xact_id() OR OLD.started_at<>transaction_timestamp() OR OLD.backend_pid<>pg_backend_pid()
   OR NOT ((OLD.phase='prepared' AND NEW.phase='received' AND
      (to_jsonb(OLD)-ARRAY['phase','receipt_id','received_order','received_return'])=(to_jsonb(NEW)-ARRAY['phase','receipt_id','received_order','received_return']))
     OR(OLD.phase='received' AND NEW.phase='sealed' AND(to_jsonb(OLD)-'phase')=(to_jsonb(NEW)-'phase') AND EXISTS(SELECT FROM public.catalog_stock_legacy_group_receipts WHERE id=OLD.id))) THEN
   RAISE EXCEPTION 'Niezmienna authority grupy' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Nie można usunąć authority grupy' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION catalog_stock_legacy_group_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Niezmienna historia grupy' USING ERRCODE='23514'; END $$;
CREATE FUNCTION catalog_stock_legacy_group_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 PERFORM public.catalog_stock_legacy_group_require(); PERFORM public.catalog_stock_legacy_group_validate(NEW.id);
 IF NOT EXISTS(SELECT FROM public.catalog_stock_legacy_group_admissions WHERE id=NEW.id AND phase='sealed') THEN RAISE EXCEPTION 'Nieukończona grupa' USING ERRCODE='23514'; END IF; RETURN NULL;
END $$;
CREATE FUNCTION catalog_stock_legacy_group_source_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE n jsonb; o jsonb; BEGIN
 n:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END; o:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 IF EXISTS(SELECT FROM public.catalog_stock_legacy_group_admissions g WHERE g.txid=pg_current_xact_id() AND g.phase='sealed' AND g.started_at=transaction_timestamp() AND g.backend_pid=pg_backend_pid()
  AND g.tenant_id IN((n->>'tenant_id')::uuid,(o->>'tenant_id')::uuid)
  AND(CASE TG_TABLE_NAME WHEN 'orders' THEN g.order_id WHEN 'return_cases' THEN g.return_id WHEN 'automation_runs' THEN g.run_id WHEN 'jobs' THEN g.job_id END)
   IN((n->>'id')::uuid,(o->>'id')::uuid)) THEN RAISE EXCEPTION 'Końcowy parent grupy jest zapieczętowany' USING ERRCODE='23514'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER catalog_stock_legacy_group_record_guard BEFORE INSERT OR UPDATE OR DELETE ON catalog_stock_legacy_group_admissions FOR EACH ROW EXECUTE FUNCTION catalog_stock_legacy_group_record_guard();
CREATE CONSTRAINT TRIGGER catalog_stock_legacy_group_complete AFTER INSERT ON catalog_stock_legacy_group_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_stock_legacy_group_complete();
CREATE TRIGGER catalog_stock_legacy_group_record_guard BEFORE INSERT ON catalog_stock_legacy_group_receipts FOR EACH ROW EXECUTE FUNCTION catalog_stock_legacy_group_record_guard();
CREATE TRIGGER catalog_stock_legacy_group_immutable BEFORE UPDATE OR DELETE ON catalog_stock_legacy_group_receipts FOR EACH ROW EXECUTE FUNCTION catalog_stock_legacy_group_immutable();
CREATE TRIGGER catalog_stock_legacy_group_immutable BEFORE UPDATE OR DELETE ON catalog_stock_legacy_group_manifest FOR EACH ROW EXECUTE FUNCTION catalog_stock_legacy_group_immutable();
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['orders','return_cases','automation_runs','jobs'] LOOP
 EXECUTE format('CREATE TRIGGER catalog_stock_legacy_group_source_seal BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION catalog_stock_legacy_group_source_seal()',n); END LOOP; END $$;
CREATE FUNCTION catalog_stock_legacy_group_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
SELECT public.catalog_stock_control_hash(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl_grant),
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',x.attname,'type',format_type(x.atttypid,x.atttypmod),'notnull',x.attnotnull,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(x.attacl) acl_grant),'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum)
    FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
  'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid,true) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid),
  'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles)r),
   'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.relname)
   FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'catalog_stock_legacy_group_%' AND c.relkind='r'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',oidvectortypes(p.proargtypes),'body',p.prosrc,'owner',pg_get_userbyid(p.proowner),
  'identity_arguments',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),
  'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),
  'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,
  'kind',p.prokind,'returns_set',p.proretset,'return_type',format_type(p.prorettype,NULL),
  'argument_modes',p.proargmodes,'argument_names',p.proargnames,'argument_defaults',p.proargdefaults::text,
  'arguments_with_defaults',pg_get_function_arguments(p.oid),'cost',p.procost,'rows',p.prorows,
  'support',CASE WHEN p.prosupport=0 THEN NULL ELSE p.prosupport::regprocedure::text END,
  'sd',p.prosecdef,'config',p.proconfig,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl_grant)) ORDER BY p.proname,oidvectortypes(p.proargtypes)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'catalog_stock_legacy_group_%'),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'type',t.tgtype,'enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid,true)) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname LIKE 'catalog_stock_legacy_group_%'))) $$;
CREATE FUNCTION catalog_stock_legacy_group_guards() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ownerid oid:=(SELECT proowner FROM pg_proc WHERE oid='public.catalog_stock_legacy_group_guards()'::regprocedure);
BEGIN
 IF NOT public.catalog_stock_control_installed() OR
  (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'catalog_stock_legacy_group_%' AND relkind='r')<>3 OR
  (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'catalog_stock_legacy_group_%')<>16 OR
  (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.pronamespace='public'::regnamespace AND p.proname LIKE 'catalog_stock_legacy_group_%')<>9 THEN RETURN false; END IF;
 IF EXISTS(SELECT FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'catalog_stock_legacy_group_%' AND c.relkind='r' AND
  (c.relowner<>ownerid OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR EXISTS(SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>ownerid) OR
   EXISTS(SELECT FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>ownerid) OR
   EXISTS(SELECT FROM pg_policy policy WHERE policy.polrelid=c.oid))) OR
  EXISTS(SELECT FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'catalog_stock_legacy_group_%' AND
   (p.proowner<>ownerid OR NOT p.prosecdef OR NOT coalesce(p.proconfig @> ARRAY['search_path=pg_catalog, public'],false) OR
    EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>ownerid))) THEN RETURN false; END IF;
 -- No core-require recursion: these predicates only inspect the actual delegate
 -- bodies; core/RETURN manifests independently pin their complete implementations.
 IF to_regprocedure('public.catalog_stock_return_validate(uuid)') IS NULL OR
  to_regprocedure('public.catalog_stock_return_source_seal()') IS NULL OR
  to_regprocedure('public.catalog_stock_return_guards()') IS NULL THEN RETURN false; END IF;
 IF position('public.catalog_stock_legacy_group_return_basis(eid,to_jsonb(rc))' IN(SELECT prosrc FROM pg_proc WHERE oid='public.catalog_stock_return_validate(uuid)'::regprocedure))=0 OR
  position('public.catalog_stock_legacy_group_close_allowed(to_jsonb(OLD),to_jsonb(NEW))' IN(SELECT prosrc FROM pg_proc WHERE oid='public.catalog_stock_return_source_seal()'::regprocedure))=0 OR
  position('NOT public.catalog_stock_legacy_group_guards()' IN(SELECT prosrc FROM pg_proc WHERE oid='public.catalog_stock_return_guards()'::regprocedure))=0 THEN RETURN false; END IF;
 RETURN coalesce((SELECT fingerprint=public.catalog_stock_legacy_group_fingerprint() FROM public.catalog_stock_legacy_group_manifest WHERE id),false);
END $$;
CREATE FUNCTION catalog_stock_legacy_group_require() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 PERFORM public.catalog_stock_control_require();
 IF NOT public.catalog_stock_legacy_group_guards() THEN RAISE EXCEPTION 'Niekompletna authority faz grupy zwrotu' USING ERRCODE='55000'; END IF;
END $$;
DO $$ DECLARE p record; BEGIN
 FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'catalog_stock_legacy_group_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.signature);
 END LOOP;
END $$;
INSERT INTO public.catalog_stock_legacy_group_manifest VALUES(true,public.catalog_stock_legacy_group_fingerprint());

-- END EMBEDDED LEGACY_RECEIVE_CLOSE169_PHASE

CREATE FUNCTION catalog_stock_return_finish(uid uuid,kid uuid,eid uuid,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_return_admissions;e public.catalog_stock_control_effect_admissions;f jsonb;proof jsonb;
 n jsonb;did uuid;head jsonb;docs jsonb:='[]';rc public.return_cases;opid uuid;countj bigint;bytesj bigint;
BEGIN
 PERFORM public.catalog_stock_return_require();
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE id=eid FOR UPDATE;
 IF a.id IS NULL OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR a.txid<>pg_current_xact_id()
  OR a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS DISTINCT FROM kid OR a.sealed THEN RAISE EXCEPTION 'Obcy lub zamknięty token zwrotu' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM public.catalog_stock_control_effect_admissions WHERE(tenant_id,id)=(a.tenant_id,a.id);
 f:=public.catalog_stock_control_effect_frame(e.request);
 -- New journal proof is independently derived from152's before witness.
 SELECT jsonb_build_object('stock_movement_ids',coalesce(jsonb_agg(x->'id' ORDER BY x->>'id'),'[]')) INTO proof
 FROM jsonb_array_elements(f->'stock_journals')x WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(e.before_frame->'stock_journals')o WHERE o->'id'=x->'id');
 proof:=proof||jsonb_build_object('location_movement_ids',(SELECT coalesce(jsonb_agg(x->'id' ORDER BY x->>'id'),'[]') FROM jsonb_array_elements(f->'bin_journals')x
  WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(e.before_frame->'bin_journals')o WHERE o->'id'=x->'id')),
  'layer_movement_ids',(SELECT coalesce(jsonb_agg(x->'id' ORDER BY x->>'id'),'[]') FROM jsonb_array_elements(f->'layer_journals')x
  WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(e.before_frame->'layer_journals')o WHERE o->'id'=x->'id')));
 IF jsonb_array_length(proof->'stock_movement_ids')>10000 OR jsonb_array_length(proof->'location_movement_ids')>10000 OR
  jsonb_array_length(proof->'layer_movement_ids')>10000 OR EXISTS(SELECT FROM jsonb_array_elements(f->'stock_journals')x WHERE x->'id' IN(SELECT value FROM jsonb_array_elements(proof->'stock_movement_ids'))
   AND(x->>'return_id',x->>'order_id',x->>'kind') IS DISTINCT FROM(a.return_id::text,a.order_id::text,'return')) OR
  EXISTS(SELECT FROM jsonb_array_elements(f->'bin_journals')x WHERE x->'id' IN(SELECT value FROM jsonb_array_elements(proof->'location_movement_ids')) AND((x->>'delta')::integer<=0 OR x->>'kind'<>'stock_in')) THEN
  RAISE EXCEPTION 'Niepełne lub obce dodatnie ruchy zwrotu' USING ERRCODE='23514';END IF;
 SELECT id INTO opid FROM public.wms_operations WHERE(tenant_id,return_id,order_id,kind)=(a.tenant_id,a.return_id,a.order_id,'return')
  AND public.catalog_stock_control_owns_xmin(xmin);
 IF (b->>'wms_operation_id')::uuid IS DISTINCT FROM opid THEN RAISE EXCEPTION 'Nie podano rzeczywistej operacji zwrotu' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.wms_layer_movements m WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'layer_movement_ids')v)
  AND(m.operation_id IS DISTINCT FROM opid OR m.delta<=0)) THEN RAISE EXCEPTION 'Obce warstwy przyjęcia' USING ERRCODE='23514';END IF;
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 INSERT INTO public.catalog_stock_return_receipts(id,tenant_id,return_id,order_id,assistant_receipt_id,exchange_id,dropship_admission_id,
  local_proof_id,parcel_receipt_return_id,wms_operation_id,proof,snapshot)
 VALUES(eid,a.tenant_id,a.return_id,a.order_id,(b->>'assistant_receipt_id')::uuid,(b->>'exchange_id')::uuid,(b->>'dropship_admission_id')::uuid,
  (b->>'local_proof_id')::uuid,(b->>'parcel_receipt_return_id')::uuid,opid,proof,
  jsonb_build_object('return_case',to_jsonb(rc),'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY item_id) FROM public.return_items i WHERE(tenant_id,return_id)=(a.tenant_id,a.return_id))));
 FOR n IN SELECT value FROM jsonb_array_elements(a.numbers) LOOP
  did:=gen_random_uuid();
  SELECT jsonb_build_object('id',did,'receipt_id',eid,'return_id',a.return_id,'order_id',a.order_id,'warehouse_id',n->>'warehouse_id',
   'kind','PZ','number',n->>'number','series_id',n->>'series_id','year',(n->>'year')::integer,'sequence',n->>'sequence',
   'row_count',count(*),'quantity',coalesce(sum(m.delta),0)::text,'wms_enabled',opid IS NOT NULL,'created_at',transaction_timestamp()) INTO head
  FROM public.stock_location_movements m WHERE m.tenant_id=a.tenant_id AND m.warehouse_id=(n->>'warehouse_id')::uuid
   AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'location_movement_ids')v);
  IF(head->>'row_count')::integer=0 THEN RAISE EXCEPTION 'Przyjęcie nie ma dodatnich wierszy tego PZ' USING ERRCODE='23514';END IF;
  INSERT INTO public.catalog_stock_return_documents VALUES(did,a.tenant_id,eid,a.return_id,(n->>'warehouse_id')::uuid,
   (n->>'series_id')::uuid,(n->>'year')::integer,(n->>'sequence')::bigint,n->>'number',head||jsonb_build_object('series',n->'series','warehouse',
    (SELECT to_jsonb(w) FROM public.warehouses w WHERE(tenant_id,id)=(a.tenant_id,(n->>'warehouse_id')::uuid))));
  INSERT INTO public.catalog_stock_return_rows
  SELECT gen_random_uuid(),a.tenant_id,did,(row_number() OVER(ORDER BY m.product_id,m.location,m.id)-1)::integer,
   m.product_id,m.warehouse_id,m.location,m.delta,m.id,jsonb_build_object('product_id',m.product_id,'sku',p.value->>'sku','name',p.value->>'name',
    'warehouse_id',m.warehouse_id,'location',m.location,'quantity',m.delta,'bin_movement_id',m.id)
  FROM public.stock_location_movements m JOIN jsonb_array_elements(a.frame->'products')p(value) ON p.value->>'id'=m.product_id::text
  WHERE m.tenant_id=a.tenant_id AND m.warehouse_id=(n->>'warehouse_id')::uuid
   AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'location_movement_ids')v);
  docs:=docs||jsonb_build_array(head);
 END LOOP;
 -- Allocate real aggregate stock journals to real bin journals by deterministic
 -- quantity intervals. This is an explicit derived allocation, not a claim that
 --025 persisted an order/item/layer field it does not possess.
 WITH rr AS MATERIALIZED(SELECT x.*,sum(x.quantity) OVER(PARTITION BY x.warehouse_id,x.product_id ORDER BY x.location,x.bin_movement_id) hi
  FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid)),
 mm AS MATERIALIZED(SELECT m.*,sum(m.delta) OVER(PARTITION BY m.warehouse_id,m.product_id ORDER BY m.id) hi
  FROM public.stock_movements m WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'stock_movement_ids')v))
 INSERT INTO public.catalog_stock_return_stock_maps
 SELECT a.tenant_id,x.id,m.id,(least(x.hi,m.hi)-greatest(x.hi-x.quantity,m.hi-m.delta))::integer FROM rr x JOIN mm m
 ON(m.warehouse_id,m.product_id)=(x.warehouse_id,x.product_id) AND x.hi>m.hi-m.delta AND m.hi>x.hi-x.quantity;
 -- Layer valuation comes only from real journals and frozen cost layers.
 WITH rr AS MATERIALIZED(SELECT x.*,sum(x.quantity) OVER(PARTITION BY x.warehouse_id,x.product_id,x.location ORDER BY x.bin_movement_id) hi
  FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid)),
 mm AS MATERIALIZED(SELECT m.*,sum(m.delta) OVER(PARTITION BY m.warehouse_id,m.product_id,m.location ORDER BY m.id) hi,
  row_number() OVER(PARTITION BY m.warehouse_id,m.product_id,m.location,m.layer_id,m.delta,m.value_delta ORDER BY m.id) duplicate
  FROM public.wms_layer_movements m WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(proof->'layer_movement_ids')v)),
 ff AS MATERIALIZED(SELECT f.*,row_number() OVER(PARTITION BY f.warehouse_id,f.product_id,f.location,f.layer_id,f.quantity,f.value_minor ORDER BY f.id) duplicate
  FROM public.wms_return_fragments f WHERE(f.tenant_id,f.operation_id)=(a.tenant_id,opid))
 INSERT INTO public.catalog_stock_return_layer_maps
 SELECT a.tenant_id,x.id,m.id,f.id,(least(x.hi,m.hi)-greatest(x.hi-x.quantity,m.hi-m.delta))::integer,
  jsonb_build_object('layer_id',l.id,'lot_id',l.lot_id,'issue_fragment_id',f.issue_fragment_id,'unit_cost_minor',l.unit_cost_minor::text,
   'currency',l.currency,'exponent',l.exponent,'value_minor',CASE WHEN l.unit_cost_minor IS NULL THEN NULL
    ELSE((least(x.hi,m.hi)-greatest(x.hi-x.quantity,m.hi-m.delta))*l.unit_cost_minor)::text END,
   'allocation','quantity_interval')
 FROM rr x JOIN mm m ON(m.warehouse_id,m.product_id,m.location)=(x.warehouse_id,x.product_id,x.location)
  AND x.hi>m.hi-m.delta AND m.hi>x.hi-x.quantity
 JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(m.tenant_id,m.layer_id,m.product_id)
 LEFT JOIN ff f ON(f.warehouse_id,f.product_id,f.location,f.layer_id,f.quantity,f.duplicate)=(m.warehouse_id,m.product_id,m.location,m.layer_id,m.delta,m.duplicate)
  AND f.value_minor IS NOT DISTINCT FROM m.value_delta;
 --148 has an actual per-part arrival FK. Legacy protocols only have the frozen
 --recipe and aggregate restock, so record deterministic recipe allocations.
 WITH rr AS MATERIALIZED(SELECT x.*,sum(x.quantity) OVER(PARTITION BY x.warehouse_id,x.product_id,
  CASE WHEN a.protocol='destinations_v1' THEN x.location ELSE '' END ORDER BY x.location,x.bin_movement_id) hi
  FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid)),
 raw AS MATERIALIZED(
  SELECT ar.item_id,ar.id arrival_id,ar.warehouse_id,ar.product_id,ar.location,ar.quantity FROM public.return_destination_arrivals ar
   WHERE a.protocol='destinations_v1' AND(ar.tenant_id,ar.receipt_id)=(a.tenant_id,(b->>'assistant_receipt_id')::uuid)
  UNION ALL SELECT i.item_id,NULL::uuid,(a.frame->'return_case'->>'warehouse_id')::uuid,(comp->>'product_id')::uuid,''::text,
   (i.restocked*(comp->>'quantity')::integer)::integer FROM public.return_items i CROSS JOIN LATERAL jsonb_array_elements(i.components)comp
   WHERE a.protocol<>'destinations_v1' AND(i.tenant_id,i.return_id)=(a.tenant_id,a.return_id) AND i.restocked>0),
 ii AS MATERIALIZED(SELECT raw.*,sum(quantity) OVER(PARTITION BY warehouse_id,product_id,location ORDER BY item_id,arrival_id) hi FROM raw)
 INSERT INTO public.catalog_stock_return_item_maps(tenant_id,row_id,return_id,item_id,arrival_id,quantity)
 SELECT a.tenant_id,x.id,a.return_id,i.item_id,i.arrival_id,(least(x.hi,i.hi)-greatest(x.hi-x.quantity,i.hi-i.quantity))::integer
 FROM rr x JOIN ii i ON(i.warehouse_id,i.product_id)=(x.warehouse_id,x.product_id)
  AND(a.protocol<>'destinations_v1' OR i.location=x.location) AND x.hi>i.hi-i.quantity AND i.hi>x.hi-x.quantity;
 SELECT(SELECT count(*) FROM public.catalog_stock_return_stock_maps WHERE tenant_id=a.tenant_id AND row_id IN(SELECT x.id FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid)))+
 (SELECT count(*) FROM public.catalog_stock_return_layer_maps WHERE tenant_id=a.tenant_id AND row_id IN(SELECT x.id FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid)))+
 (SELECT count(*) FROM public.catalog_stock_return_item_maps WHERE tenant_id=a.tenant_id AND row_id IN(SELECT x.id FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid))) INTO countj;
 IF countj>30000 OR(SELECT count(*) FROM public.catalog_stock_return_receipts WHERE tenant_id=a.tenant_id)>2000 THEN RAISE EXCEPTION 'Limit pełnej historii PZ zwrotu' USING ERRCODE='54000';END IF;
 SELECT coalesce(sum(v.bytes),0) INTO bytesj FROM(
  SELECT octet_length(to_jsonb(x)::text) bytes FROM public.catalog_stock_return_admissions x WHERE tenant_id=a.tenant_id
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.catalog_stock_return_receipts x WHERE tenant_id=a.tenant_id
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.catalog_stock_return_documents x WHERE tenant_id=a.tenant_id
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.catalog_stock_return_rows x WHERE tenant_id=a.tenant_id
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.catalog_stock_return_stock_maps x WHERE tenant_id=a.tenant_id
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.catalog_stock_return_layer_maps x WHERE tenant_id=a.tenant_id
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM public.catalog_stock_return_item_maps x WHERE tenant_id=a.tenant_id)v;
 IF bytesj>134217728 THEN RAISE EXCEPTION 'Limit pełnych bajtów PZ zwrotu' USING ERRCODE='54000';END IF;
 PERFORM public.catalog_stock_return_validate(eid);
 -- Migration152 delegates its return branch back to validate(eid), retaining
 --all cell deltas and exact journal sets before sealing the source and receipt.
 PERFORM public.catalog_stock_control_effect_finish(uid,kid,eid,proof||jsonb_build_object('operation_id',opid));
 UPDATE public.catalog_stock_return_admissions SET sealed=true WHERE id=eid;
 RETURN jsonb_build_object('documents',docs);
END $$;

CREATE FUNCTION catalog_stock_return_abandon(uid uuid,kid uuid,eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_return_admissions;e public.catalog_stock_control_effect_admissions;n jsonb;current_number bigint;
BEGIN
 PERFORM public.catalog_stock_return_require();SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE id=eid FOR UPDATE;
 SELECT * INTO e FROM public.catalog_stock_control_effect_admissions WHERE(tenant_id,id)=(a.tenant_id,a.id);
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR a.actor_id IS DISTINCT FROM uid OR a.api_key_id IS DISTINCT FROM kid OR a.sealed OR
  a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR e.before_frame IS DISTINCT FROM public.catalog_stock_control_effect_frame(e.request) OR
  EXISTS(SELECT FROM public.catalog_stock_return_receipts WHERE id=eid) THEN RAISE EXCEPTION 'Nie można porzucić zmienionego zwrotu' USING ERRCODE='23514';END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(a.numbers) LOOP
  SELECT value INTO current_number FROM public.catalog_stock_control_counters WHERE(tenant_id,series_id,year)=(a.tenant_id,(n->>'series_id')::uuid,(n->>'year')::integer) FOR UPDATE;
  IF current_number IS DISTINCT FROM(n->>'sequence')::bigint THEN RAISE EXCEPTION 'Numer PZ został już wykorzystany' USING ERRCODE='23514';END IF;
  IF current_number=1 THEN DELETE FROM public.catalog_stock_control_counters WHERE(tenant_id,series_id,year)=(a.tenant_id,(n->>'series_id')::uuid,(n->>'year')::integer);
  ELSE UPDATE public.catalog_stock_control_counters SET value=value-1 WHERE(tenant_id,series_id,year)=(a.tenant_id,(n->>'series_id')::uuid,(n->>'year')::integer);END IF;
 END LOOP;
 DELETE FROM public.catalog_stock_return_admissions WHERE id=eid;
 PERFORM public.catalog_stock_control_effect_abandon(uid,kid,eid);
END $$;

-- Exact existing protocol requirements, not new blanket parcel scopes. This
-- function is private; protocol/rid come only from the trusted core adapter.
CREATE FUNCTION catalog_stock_return_access(uid uuid,kid uuid,rid uuid,protocol text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r public.return_cases;
 member_role text;k public.api_keys;scopes text[]:=ARRAY['orders:write'];admin_only boolean:=false;onw boolean;
BEGIN
 SELECT * INTO r FROM public.return_cases WHERE(tenant_id,id)=(t,rid);
 IF r.id IS NULL THEN RAISE EXCEPTION 'Brak własnego RMA' USING ERRCODE='P0002';END IF;
 IF protocol NOT IN('rma','legacy_status','assistant_v1','destinations_v1','exchange','dropship_supplier') THEN
  RAISE EXCEPTION 'Nieznany protokół RMA' USING ERRCODE='23514';END IF;
 IF protocol IN('assistant_v1','destinations_v1','exchange','dropship_supplier') OR
  EXISTS(SELECT FROM public.order_parcel_plans p WHERE(p.tenant_id,p.order_id)=(t,r.order_id) AND p.payload->>'protocol'='commercial_v1') THEN
  scopes:=scopes||ARRAY['orders:read'];END IF;
 SELECT coalesce(enabled,false) INTO onw FROM public.wms_policies WHERE tenant_id=t;
 IF coalesce(onw,false) THEN scopes:=scopes||ARRAY['orders:read','inventory:read','inventory:write'];END IF;
 IF protocol='destinations_v1' THEN scopes:=scopes||ARRAY['inventory:read','inventory:write'];END IF;
 IF protocol IN('exchange','dropship_supplier') OR
  EXISTS(SELECT FROM public.b2b_return_local_origins o WHERE(o.tenant_id,o.return_id)=(t,rid)) THEN
  admin_only:=true;scopes:=scopes||ARRAY['orders:read','inventory:read','inventory:write','purchasing:write'];END IF;
 SELECT array_agg(DISTINCT s ORDER BY s) INTO scopes FROM unnest(scopes)s;
 SELECT role INTO member_role FROM public.memberships WHERE(tenant_id,user_id)=(t,uid);
 IF NOT coalesce(CASE WHEN admin_only THEN member_role='admin' ELSE member_role IN('admin','operator') END,false) THEN
  RAISE EXCEPTION 'Brak aktualnej zgody zwrotu' USING ERRCODE='42501';END IF;
 IF kid IS NOT NULL THEN
  SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);
  IF k.id IS NULL OR k.revoked_at IS NOT NULL OR(k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN
   RAISE EXCEPTION 'Nieaktualny klucz zwrotu' USING ERRCODE='28000';END IF;
  IF NOT k.scopes @> scopes THEN RAISE EXCEPTION 'Brak aktualnych zakresów zwrotu' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('admin_only',admin_only,'scopes',scopes);
END $$;

CREATE FUNCTION catalog_stock_return_frame(uid uuid,kid uuid,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r public.return_cases;p public.return_assistant_previews;
 q jsonb:=b->'request';items jsonb;cells jsonb;f jsonb;products_json jsonb;protocol text:=b->>'protocol';g jsonb;
 prior public.catalog_stock_return_admissions;saved public.catalog_stock_return_receipts;
BEGIN
 PERFORM public.catalog_stock_control_require();
 g:=public.catalog_stock_return_access(uid,kid,(b->>'return_id')::uuid,protocol);
 SELECT * INTO r FROM public.return_cases WHERE(tenant_id,id)=(t,(b->>'return_id')::uuid);
 IF r.id IS NULL THEN RAISE EXCEPTION 'Brak własnego RMA' USING ERRCODE='P0002';END IF;
 IF protocol NOT IN('rma','legacy_status','assistant_v1','destinations_v1','exchange','dropship_supplier') THEN RAISE EXCEPTION 'Nieznany protokół RMA' USING ERRCODE='23514';END IF;
 IF protocol IN('assistant_v1','destinations_v1') THEN
  SELECT * INTO p FROM public.return_assistant_previews WHERE(tenant_id,id,return_id,actor_id)=(t,(b->>'preview_id')::uuid,r.id,uid);
  IF p.id IS NULL OR p.api_key_id IS DISTINCT FROM kid OR(protocol='destinations_v1') IS DISTINCT FROM coalesce(p.payload->'snapshot'->>'protocol'='destinations_v1',false) THEN RAISE EXCEPTION 'Obcy protokół podglądu RMA' USING ERRCODE='23514';END IF;
  q:=p.payload->'receive_input';
  IF q IS DISTINCT FROM b->'request' THEN RAISE EXCEPTION 'Podgląd ma inny kanoniczny input core' USING ERRCODE='23514';END IF;
 END IF;
 -- Genuine historical replay never allocates numbers or invents a receipt.
 -- A saved169 command retains its original author/key/protocol/body binding;
 -- pre169 history has no new receipt to retrofit or new authority to impose.
 IF r.state<>'requested' THEN
  SELECT * INTO prior FROM public.catalog_stock_return_admissions WHERE(tenant_id,return_id)=(t,r.id);
  SELECT * INTO saved FROM public.catalog_stock_return_receipts WHERE(tenant_id,return_id)=(t,r.id);
  IF prior.id IS NOT NULL OR saved.id IS NOT NULL THEN
   IF prior.id IS NULL OR saved.id IS NULL OR NOT prior.sealed OR saved.id IS DISTINCT FROM prior.id
    OR prior.actor_id IS DISTINCT FROM uid OR prior.api_key_id IS DISTINCT FROM kid
    OR prior.protocol IS DISTINCT FROM protocol OR prior.preview_id IS DISTINCT FROM p.id
    OR prior.frame->'request' IS DISTINCT FROM q THEN
    RAISE EXCEPTION 'Replay PZ zwrotu ma innego autora, klucz lub treść' USING ERRCODE='23514';END IF;
  END IF;
  RETURN jsonb_build_object('historical',true,'return_id',r.id);
 END IF;
 IF protocol IN('assistant_v1','destinations_v1') AND p.payload->>'action'='reject' THEN
  RETURN jsonb_build_object('return_case',to_jsonb(r),'cells','[]'::jsonb);END IF;
 -- Native receiveReturn permits a legacy-origin RMA through its ordinary
 -- receive endpoint only with explicit WMS picks and this tenant's enabled
 -- policy. This does not authorize OFF or another legacy protocol.
 IF protocol='legacy_status' AND NOT r.legacy OR
   protocol<>'legacy_status' AND r.legacy AND NOT (
    protocol='rma' AND jsonb_typeof(q->'wms_lots') IS NOT DISTINCT FROM 'object' AND
    EXISTS(SELECT FROM public.wms_policies wp WHERE wp.tenant_id=t AND wp.enabled)) OR
   (q->>'version')::bigint<>r.version OR jsonb_typeof(q->'items') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Nieaktualny stan lub wersja RMA' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY item_id),'[]') INTO items FROM public.return_items i WHERE(tenant_id,return_id)=(t,r.id);
 IF jsonb_array_length(items)>500 OR jsonb_array_length(q->'items')<>jsonb_array_length(items) OR
  EXISTS(SELECT FROM jsonb_array_elements(q->'items')i GROUP BY i->>'item_id' HAVING count(*)<>1) OR
  EXISTS(SELECT FROM jsonb_array_elements(items)i WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(q->'items')x
   WHERE x->>'item_id'=i->>'item_id' AND(x->>'accepted')::numeric BETWEEN 0 AND(i->>'requested')::numeric
   AND(x->>'restocked')::numeric BETWEEN 0 AND(x->>'accepted')::numeric)) THEN
  RAISE EXCEPTION 'Decyzje nie odpowiadają pełnym pozycjom RMA' USING ERRCODE='22023';END IF;
 IF protocol='destinations_v1' THEN
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'warehouse_id',x->>'product_id',x->>'location',x->>'part_id'),'[]') INTO cells
  FROM jsonb_array_elements(p.payload->'plan'->'arrivals')x;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',r.warehouse_id,'product_id',v.product_id,'quantity',v.quantity) ORDER BY v.product_id),'[]') INTO cells
  FROM(SELECT comp->>'product_id' product_id,sum((x->>'restocked')::bigint*(comp->>'quantity')::bigint) quantity
   FROM jsonb_array_elements(items)i JOIN jsonb_array_elements(q->'items')x ON x->>'item_id'=i->>'item_id'
   CROSS JOIN LATERAL jsonb_array_elements(i->'components')comp GROUP BY comp->>'product_id'
   HAVING sum((x->>'restocked')::bigint*(comp->>'quantity')::bigint)>0)v;
 END IF;
 IF jsonb_array_length(cells)>10000 OR octet_length((items||cells)::text)>16777216 THEN RAISE EXCEPTION 'Limit pełnego źródła zwrotu' USING ERRCODE='54000';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',pr.id,'sku',pr.sku,'name',pr.name) ORDER BY pr.id),'[]') INTO products_json
 FROM public.products pr WHERE pr.tenant_id=t AND pr.id IN(SELECT(x->>'product_id')::uuid FROM jsonb_array_elements(cells)x);
 f:=jsonb_build_object('return_case',to_jsonb(r),'items',items,'products',products_json,'request',q,'cells',cells,'preview_id',p.id,
  'plan',CASE WHEN protocol='destinations_v1' THEN p.payload->'plan' ELSE NULL END,'protocol',protocol,'requirements',g);
 RETURN f;
END $$;

CREATE FUNCTION catalog_stock_return_prepare(uid uuid,kid uuid,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;f jsonb;fresh jsonb;descriptor jsonb;token jsonb;
 w uuid;s public.catalog_stock_control_series;n bigint;yr integer:=extract(year FROM transaction_timestamp());numbers jsonb:='[]';
BEGIN
 PERFORM public.catalog_stock_return_require();f:=public.catalog_stock_return_frame(uid,kid,b);
 IF f->'historical'='true'::jsonb OR jsonb_array_length(f->'cells')=0 THEN RETURN NULL;END IF;
 descriptor:=jsonb_build_object('source_kind','return','source_id',b->>'return_id',
  'warehouse_ids',(SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT x->>'warehouse_id'v FROM jsonb_array_elements(f->'cells')x)a),
  'product_ids',(SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT x->>'product_id'v FROM jsonb_array_elements(f->'cells')x)a));
 token:=public.catalog_stock_control_effect_prepare(uid,kid,descriptor);
 IF token IS NULL THEN RETURN NULL;END IF;
 fresh:=public.catalog_stock_return_frame(uid,kid,b);
 IF f IS DISTINCT FROM fresh THEN RAISE EXCEPTION 'Źródło RMA zmieniło się podczas oczekiwania' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.catalog_stock_return_admissions WHERE(tenant_id,id)=(t,(token->>'id')::uuid)) THEN
  RAISE EXCEPTION 'Powtórne przygotowanie nie jest ponownym przyjęciem' USING ERRCODE='23514';END IF;
 FOR w IN SELECT DISTINCT(x->>'warehouse_id')::uuid FROM jsonb_array_elements(f->'cells')x ORDER BY 1 LOOP
  INSERT INTO public.catalog_stock_control_series(id,tenant_id,warehouse_id,kind,name,prefix)
   VALUES(gen_random_uuid(),t,w,'PZ','PZ','PZ') ON CONFLICT(tenant_id,warehouse_id,kind) DO NOTHING;
  SELECT * INTO s FROM public.catalog_stock_control_series WHERE(tenant_id,warehouse_id,kind)=(t,w,'PZ') FOR UPDATE;
  n:=public.catalog_stock_control_next(t,s.id,yr);
  numbers:=numbers||jsonb_build_array(jsonb_build_object('warehouse_id',w,'series_id',s.id,'series',to_jsonb(s),'year',yr,
   'sequence',n::text,'number',s.prefix||'/'||yr||'/'||(CASE WHEN length(n::text)>=6 THEN n::text ELSE lpad(n::text,6,'0') END)));
 END LOOP;
 INSERT INTO public.catalog_stock_return_admissions(id,tenant_id,return_id,order_id,actor_id,api_key_id,protocol,preview_id,frame,numbers)
 VALUES((token->>'id')::uuid,t,(b->>'return_id')::uuid,(f->'return_case'->>'order_id')::uuid,uid,kid,b->>'protocol',(b->>'preview_id')::uuid,f,numbers);
 RETURN jsonb_build_object('id',token->>'id','tenant_id',t,'return_id',b->>'return_id','protocol',b->>'protocol',
  'requirements',fresh->'requirements');
END $$;

-- Exact terminal validation is also called by152's deferred effect validator.
CREATE FUNCTION catalog_stock_return_validate(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_return_admissions;r public.catalog_stock_return_receipts;rc public.return_cases;op public.wms_operations;
 item jsonb;expected jsonb;return_document_head record;n jsonb;actual jsonb;wanted jsonb;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_return_receipts WHERE(tenant_id,id)=(a.tenant_id,a.id);
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR r.id IS NULL THEN RAISE EXCEPTION 'Brak pełnej zgody dokumentu zwrotu' USING ERRCODE='23514';END IF;
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 -- Preserve the original received receipt; only a genuine same-TX group may supply its captured intermediate basis.
 rc:=jsonb_populate_record(NULL::public.return_cases,public.catalog_stock_legacy_group_return_basis(eid,to_jsonb(rc)));
 IF rc.order_id<>a.order_id OR rc.version<>(a.frame->'return_case'->>'version')::bigint+1 OR rc.received_at IS NULL
  OR rc.receipt IS DISTINCT FROM a.frame->'request' OR rc.state NOT IN('refund_pending','closed')
  OR to_jsonb(rc)-ARRAY['state','remedy','receipt','refunded_shipping','refund_amount','decision_note','received_at','receipt_sequence','version','updated_at']
   IS DISTINCT FROM (a.frame->'return_case')-ARRAY['state','remedy','receipt','refunded_shipping','refund_amount','decision_note','received_at','receipt_sequence','version','updated_at'] THEN
  RAISE EXCEPTION 'Dokument nie odpowiada rzeczywistemu przyjęciu RMA' USING ERRCODE='23514';END IF;
 FOR item IN SELECT to_jsonb(i) FROM public.return_items i WHERE(tenant_id,return_id)=(a.tenant_id,a.return_id) LOOP
  SELECT x INTO expected FROM jsonb_array_elements(a.frame->'items')x WHERE x->>'item_id'=item->>'item_id';
  IF expected IS NULL OR item-ARRAY['accepted','restocked','refund_amount'] IS DISTINCT FROM expected-ARRAY['accepted','restocked','refund_amount'] OR
   NOT EXISTS(SELECT FROM jsonb_array_elements(a.frame->'request'->'items')x WHERE x->>'item_id'=item->>'item_id'
    AND x->'accepted'=item->'accepted' AND x->'restocked'=item->'restocked') THEN RAISE EXCEPTION 'Niepełna oryginalna receptura RMA' USING ERRCODE='23514';END IF;
 END LOOP;
 IF(SELECT count(*) FROM public.return_items WHERE(tenant_id,return_id)=(a.tenant_id,a.return_id))<>jsonb_array_length(a.frame->'items') THEN RAISE EXCEPTION 'Zmieniono pełne pozycje RMA' USING ERRCODE='23514';END IF;
 IF a.protocol IN('assistant_v1','destinations_v1') THEN
  IF NOT EXISTS(SELECT FROM public.return_assistant_receipts ar JOIN public.return_assistant_admissions aa
   ON(aa.tenant_id,aa.receipt_id,aa.transaction_id)=(ar.tenant_id,ar.id,pg_current_xact_id())
   WHERE(ar.tenant_id,ar.id,ar.return_id,ar.preview_id,ar.actor_id)=(a.tenant_id,r.assistant_receipt_id,a.return_id,a.preview_id,a.actor_id)
   AND ar.api_key_id IS NOT DISTINCT FROM a.api_key_id AND ar.payload->'receive_input'=a.frame->'request') THEN
   RAISE EXCEPTION 'Brak bieżącego receipt139' USING ERRCODE='23514';END IF;
  IF a.protocol='destinations_v1' THEN
   IF NOT EXISTS(SELECT FROM public.return_destination_admissions da WHERE(da.tenant_id,da.receipt_id,da.return_id,da.transaction_id,da.backend_pid)
    =(a.tenant_id,r.assistant_receipt_id,a.return_id,pg_current_xact_id(),pg_backend_pid()) AND da.payload->'plan'=a.frame->'plan') THEN
    RAISE EXCEPTION 'Brak bieżącego planu148' USING ERRCODE='23514';END IF;
   PERFORM public.return_destination_physical_validate(r.assistant_receipt_id);
  END IF;
 ELSIF r.assistant_receipt_id IS NOT NULL THEN RAISE EXCEPTION 'Obcy parent139' USING ERRCODE='23514';END IF;
 IF a.protocol='exchange' THEN
  IF NOT EXISTS(SELECT FROM public.return_exchanges ex JOIN public.return_exchange_admissions ea ON(ea.tenant_id,ea.id)=(ex.tenant_id,ex.id)
   WHERE(ex.tenant_id,ex.id,ex.return_id,ex.actor_id)=(a.tenant_id,r.exchange_id,a.return_id,a.actor_id)
   AND ea.transaction_id=pg_current_xact_id() AND ex.api_key_id IS NOT DISTINCT FROM a.api_key_id) THEN
   RAISE EXCEPTION 'Brak rzeczywistego receipt wymiany' USING ERRCODE='23514';END IF;
 ELSIF r.exchange_id IS NOT NULL THEN RAISE EXCEPTION 'Obca wymiana' USING ERRCODE='23514';END IF;
 IF a.protocol='dropship_supplier' THEN
  IF NOT EXISTS(SELECT FROM public.b2b_dropship_return_proofs p WHERE(p.tenant_id,p.id,p.return_id,p.transaction_id,p.actor_id)
   =(a.tenant_id,r.dropship_admission_id,a.return_id,pg_current_xact_id(),a.actor_id) AND p.kind='receive' AND p.api_key_id IS NOT DISTINCT FROM a.api_key_id AND p.applied) THEN
   RAISE EXCEPTION 'Brak bieżącego proof dostawcy' USING ERRCODE='23514';END IF;
 ELSIF r.dropship_admission_id IS NOT NULL THEN RAISE EXCEPTION 'Obcy proof dostawcy' USING ERRCODE='23514';END IF;
 IF r.local_proof_id IS NOT NULL AND NOT EXISTS(SELECT FROM public.b2b_return_local_proofs p WHERE(p.tenant_id,p.id,p.return_id,p.transaction_id,p.actor_id)
  =(a.tenant_id,r.local_proof_id,a.return_id,pg_current_xact_id(),a.actor_id) AND p.api_key_id IS NOT DISTINCT FROM a.api_key_id) THEN RAISE EXCEPTION 'Obcy proof112' USING ERRCODE='23514';END IF;
 IF r.parcel_receipt_return_id IS NOT NULL AND(r.parcel_receipt_return_id<>a.return_id OR NOT EXISTS(SELECT FROM public.order_parcel_return_receipts p JOIN public.order_parcel_return_admissions pa
  ON(pa.tenant_id,pa.return_id,pa.kind)=(p.tenant_id,p.return_id,'receive') WHERE(p.tenant_id,p.return_id,p.actor_id)=(a.tenant_id,a.return_id,a.actor_id)
  AND pa.transaction_id=pg_current_xact_id() AND p.api_key_id IS NOT DISTINCT FROM a.api_key_id)) THEN RAISE EXCEPTION 'Obcy receipt138' USING ERRCODE='23514';END IF;
 IF r.wms_operation_id IS NOT NULL THEN
  SELECT * INTO op FROM public.wms_operations WHERE(tenant_id,id)=(a.tenant_id,r.wms_operation_id);
  IF op.id IS NULL OR op.kind<>'return' OR(op.order_id,op.return_id) IS DISTINCT FROM(a.order_id,a.return_id)
    OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL THEN RAISE EXCEPTION 'Obca operacja WMS zwrotu' USING ERRCODE='23514';END IF;
 END IF;
 IF r.snapshot->'return_case' IS DISTINCT FROM to_jsonb(rc) OR r.snapshot->'items' IS DISTINCT FROM
  (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY item_id),'[]') FROM public.return_items i WHERE(tenant_id,return_id)=(a.tenant_id,a.return_id)) THEN
  RAISE EXCEPTION 'Zapieczętowany wynik zwrotu zmienił się' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.catalog_stock_return_documents WHERE(tenant_id,receipt_id)=(a.tenant_id,eid))<>jsonb_array_length(a.numbers) THEN RAISE EXCEPTION 'Brak pełnych PZ wszystkich magazynów' USING ERRCODE='23514';END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(a.numbers) LOOP
  SELECT * INTO return_document_head FROM public.catalog_stock_return_documents WHERE(tenant_id,receipt_id,warehouse_id)=(a.tenant_id,eid,(n->>'warehouse_id')::uuid);
  IF return_document_head.id IS NULL OR(return_document_head.series_id,return_document_head.year,return_document_head.sequence,return_document_head.number) IS DISTINCT FROM((n->>'series_id')::uuid,(n->>'year')::integer,(n->>'sequence')::bigint,n->>'number') THEN
   RAISE EXCEPTION 'PZ ma inną serię lub numer' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Cell totals, stock allocations and layer allocations are independently
 -- compared; a bin journal cannot be omitted, duplicated or used cross-RMA.
 SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY warehouse_id,product_id),'[]') INTO actual FROM(
  SELECT x.warehouse_id::text,x.product_id::text,sum(x.quantity)::text quantity FROM public.catalog_stock_return_rows x
  JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
  WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid) GROUP BY x.warehouse_id,x.product_id)v;
 SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY warehouse_id,product_id),'[]') INTO wanted FROM(
  SELECT x->>'warehouse_id' warehouse_id,x->>'product_id' product_id,sum((x->>'quantity')::numeric)::text quantity
  FROM jsonb_array_elements(a.frame->'cells')x GROUP BY 1,2)v;
 IF actual<>wanted THEN RAISE EXCEPTION 'PZ nie pokrywa rzeczywistego przyjęcia' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
  JOIN public.stock_location_movements m ON(m.tenant_id,m.id)=(x.tenant_id,x.bin_movement_id)
  WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid) AND(m.delta,m.warehouse_id,m.product_id,m.location) IS DISTINCT FROM(x.quantity,x.warehouse_id,x.product_id,x.location)) OR
 EXISTS(SELECT FROM public.catalog_stock_return_stock_maps sm JOIN public.catalog_stock_return_rows x ON(x.tenant_id,x.id)=(sm.tenant_id,sm.row_id)
  JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
  JOIN public.stock_movements m ON(m.tenant_id,m.id)=(sm.tenant_id,sm.stock_movement_id)
  WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid) AND(m.order_id,m.return_id,m.kind,m.warehouse_id,m.product_id)
   IS DISTINCT FROM(a.order_id,a.return_id,'return'::text,x.warehouse_id,x.product_id)) THEN RAISE EXCEPTION 'PZ odnosi się do obcych ruchów' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
  WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid) AND x.quantity IS DISTINCT FROM(SELECT coalesce(sum(quantity),0)::integer FROM public.catalog_stock_return_stock_maps WHERE(tenant_id,row_id)=(x.tenant_id,x.id))) THEN
  RAISE EXCEPTION 'Niepełne powiązanie stock/bin PZ' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.stock_movements m WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v)
  AND m.delta IS DISTINCT FROM(SELECT sum(sm.quantity)::integer FROM public.catalog_stock_return_stock_maps sm JOIN public.catalog_stock_return_rows x ON(x.tenant_id,x.id)=(sm.tenant_id,sm.row_id)
    JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id,sm.stock_movement_id)=(a.tenant_id,eid,m.id))) THEN
  RAISE EXCEPTION 'Ruch stock ma inny pełny manifest PZ' USING ERRCODE='23514';END IF;
 IF r.wms_operation_id IS NULL AND EXISTS(SELECT FROM public.catalog_stock_return_layer_maps lm JOIN public.catalog_stock_return_rows x ON(x.tenant_id,x.id)=(lm.tenant_id,lm.row_id)
  JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid)) THEN RAISE EXCEPTION 'OFF nie wymyśla warstw' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
  WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid) AND(
   x.quantity IS DISTINCT FROM(SELECT coalesce(sum(quantity),0)::integer FROM public.catalog_stock_return_item_maps WHERE(tenant_id,row_id)=(x.tenant_id,x.id)) OR
   (r.wms_operation_id IS NOT NULL AND x.quantity IS DISTINCT FROM(SELECT coalesce(sum(quantity),0)::integer FROM public.catalog_stock_return_layer_maps WHERE(tenant_id,row_id)=(x.tenant_id,x.id))))) THEN
  RAISE EXCEPTION 'Wiersze PZ nie mają pełnej receptury lub warstw' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.catalog_stock_return_layer_maps lm JOIN public.catalog_stock_return_rows x ON(x.tenant_id,x.id)=(lm.tenant_id,lm.row_id)
  JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
  JOIN public.wms_layer_movements m ON(m.tenant_id,m.id)=(lm.tenant_id,lm.layer_movement_id)
  JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(m.tenant_id,m.layer_id,m.product_id)
  LEFT JOIN public.wms_return_fragments f ON(f.tenant_id,f.id)=(lm.tenant_id,lm.fragment_id)
  WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid) AND(
   (m.operation_id,m.warehouse_id,m.product_id,m.location) IS DISTINCT FROM(r.wms_operation_id,x.warehouse_id,x.product_id,x.location) OR
   m.delta<=0 OR m.value_delta::numeric IS DISTINCT FROM m.delta::numeric*l.unit_cost_minor OR
   lm.payload->>'layer_id' IS DISTINCT FROM l.id::text OR lm.payload->>'lot_id' IS DISTINCT FROM l.lot_id::text OR
   lm.payload->>'unit_cost_minor' IS DISTINCT FROM l.unit_cost_minor::text OR lm.payload->>'currency' IS DISTINCT FROM l.currency OR
   (lm.payload->>'value_minor')::numeric IS DISTINCT FROM lm.quantity::numeric*l.unit_cost_minor OR
   (f.id IS NULL AND(l.operation_id IS DISTINCT FROM r.wms_operation_id OR l.unit_cost_minor IS NOT NULL OR m.kind<>'legacy_return')) OR
   (f.id IS NOT NULL AND(f.operation_id,f.return_id,f.order_id,f.product_id,f.layer_id,f.warehouse_id,f.location)
    IS DISTINCT FROM(r.wms_operation_id,a.return_id,a.order_id,x.product_id,l.id,x.warehouse_id,x.location)))) THEN
  RAISE EXCEPTION 'Koszt lub pochodzenie warstwy PZ jest inne' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.wms_layer_movements m WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v)
  AND m.delta IS DISTINCT FROM(SELECT sum(lm.quantity)::integer FROM public.catalog_stock_return_layer_maps lm JOIN public.catalog_stock_return_rows x ON(x.tenant_id,x.id)=(lm.tenant_id,lm.row_id)
   JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id,lm.layer_movement_id)=(a.tenant_id,eid,m.id))) OR
 EXISTS(SELECT FROM public.wms_return_fragments f WHERE(f.tenant_id,f.operation_id)=(a.tenant_id,r.wms_operation_id)
  AND f.quantity IS DISTINCT FROM(SELECT sum(lm.quantity)::integer FROM public.catalog_stock_return_layer_maps lm JOIN public.catalog_stock_return_rows x ON(x.tenant_id,x.id)=(lm.tenant_id,lm.row_id)
   JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id,lm.fragment_id)=(a.tenant_id,eid,f.id))) THEN
  RAISE EXCEPTION 'Niepełne mapy rzeczywistych fragmentów PZ' USING ERRCODE='23514';END IF;
 IF a.protocol='destinations_v1' THEN
  IF EXISTS(SELECT FROM public.return_destination_arrivals ar WHERE(ar.tenant_id,ar.receipt_id)=(a.tenant_id,r.assistant_receipt_id)
   AND ar.quantity IS DISTINCT FROM(SELECT sum(im.quantity)::integer FROM public.catalog_stock_return_item_maps im
     WHERE(im.tenant_id,im.arrival_id)=(ar.tenant_id,ar.id))) OR
   EXISTS(SELECT FROM public.catalog_stock_return_item_maps im JOIN public.catalog_stock_return_rows x ON(x.tenant_id,x.id)=(im.tenant_id,im.row_id)
    JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
    LEFT JOIN public.return_destination_arrivals ar ON(ar.tenant_id,ar.id)=(im.tenant_id,im.arrival_id)
    WHERE(d.tenant_id,d.receipt_id)=(a.tenant_id,eid) AND(ar.id IS NULL OR(ar.receipt_id,ar.return_id,ar.item_id,ar.product_id,ar.warehouse_id,ar.location)
      IS DISTINCT FROM(r.assistant_receipt_id,a.return_id,im.item_id,x.product_id,x.warehouse_id,x.location))) THEN
    RAISE EXCEPTION 'Brak dokładnych part-arrival map148' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT FROM public.return_items i CROSS JOIN LATERAL jsonb_array_elements(i.components)comp WHERE(i.tenant_id,i.return_id)=(a.tenant_id,a.return_id)
    AND i.restocked*(comp->>'quantity')::integer IS DISTINCT FROM(SELECT coalesce(sum(im.quantity),0)::integer FROM public.catalog_stock_return_item_maps im
      JOIN public.catalog_stock_return_rows x ON(x.tenant_id,x.id)=(im.tenant_id,im.row_id)
      JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
      WHERE(d.tenant_id,d.receipt_id,im.item_id,x.product_id)=(a.tenant_id,eid,i.item_id,(comp->>'product_id')::uuid))) THEN
    RAISE EXCEPTION 'PZ nie pokrywa oryginalnych komponentów pozycji' USING ERRCODE='23514';END IF;
 END IF;
END $$;

CREATE FUNCTION catalog_stock_return_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Dokument PZ zwrotu jest niezmienny' USING ERRCODE='23514';END $$;
CREATE FUNCTION catalog_stock_return_admission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.txid<>pg_current_xact_id() OR NEW.sealed OR NOT EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions e
    WHERE(e.tenant_id,e.id,e.source_id,e.source_kind,e.txid)=(NEW.tenant_id,NEW.id,NEW.return_id,'return',NEW.txid)
      AND e.actor_id=NEW.actor_id AND e.api_key_id IS NOT DISTINCT FROM NEW.api_key_id AND NOT e.sealed) THEN
   RAISE EXCEPTION 'Brak bieżącego physical admission zwrotu' USING ERRCODE='23514';END IF;RETURN NEW;
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.sealed OR OLD.txid<>pg_current_xact_id() OR NOT NEW.sealed OR to_jsonb(OLD)-'sealed' IS DISTINCT FROM to_jsonb(NEW)-'sealed' THEN
   RAISE EXCEPTION 'Zapieczętowana zgoda zwrotu' USING ERRCODE='23514';END IF;RETURN NEW;
 ELSE
  IF OLD.sealed OR OLD.txid<>pg_current_xact_id() OR EXISTS(SELECT FROM public.catalog_stock_return_receipts WHERE id=OLD.id) THEN
   RAISE EXCEPTION 'Nie można usunąć receipt PZ' USING ERRCODE='23514';END IF;RETURN OLD;
 END IF;
END $$;
CREATE FUNCTION catalog_stock_return_record_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb:=to_jsonb(NEW);eid uuid;
BEGIN
 IF TG_TABLE_NAME='catalog_stock_return_receipts' THEN eid:=(j->>'id')::uuid;
 ELSIF TG_TABLE_NAME='catalog_stock_return_documents' THEN eid:=(j->>'receipt_id')::uuid;
 ELSIF TG_TABLE_NAME='catalog_stock_return_rows' THEN SELECT receipt_id INTO eid FROM public.catalog_stock_return_documents WHERE(tenant_id,id)=((j->>'tenant_id')::uuid,(j->>'document_id')::uuid);
 ELSE SELECT d.receipt_id INTO eid FROM public.catalog_stock_return_rows x JOIN public.catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)
   WHERE(x.tenant_id,x.id)=((j->>'tenant_id')::uuid,(j->>'row_id')::uuid);END IF;
 IF NOT EXISTS(SELECT FROM public.catalog_stock_return_admissions a WHERE(a.tenant_id,a.id,a.txid)=((j->>'tenant_id')::uuid,eid,pg_current_xact_id()) AND NOT a.sealed) THEN
  RAISE EXCEPTION 'Wiersz wymaga bieżącej zgody PZ zwrotu' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION catalog_stock_return_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.catalog_stock_return_admissions WHERE id=NEW.id) THEN RETURN NULL;END IF;
 PERFORM public.catalog_stock_return_require();PERFORM public.catalog_stock_return_validate(NEW.id);
 IF NOT EXISTS(SELECT FROM public.catalog_stock_return_admissions WHERE id=NEW.id AND sealed) THEN RAISE EXCEPTION 'Nieukończony PZ zwrotu' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION catalog_stock_return_source_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;k jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
BEGIN
 IF EXISTS(SELECT FROM public.catalog_stock_return_admissions a WHERE a.txid=pg_current_xact_id() AND a.sealed
   AND a.tenant_id IN((j->>'tenant_id')::uuid,(k->>'tenant_id')::uuid)
   AND a.return_id IN((j->>(CASE WHEN TG_TABLE_NAME='return_cases' THEN 'id' ELSE 'return_id' END))::uuid,
      (k->>(CASE WHEN TG_TABLE_NAME='return_cases' THEN 'id' ELSE 'return_id' END))::uuid)) THEN
  IF TG_TABLE_NAME='return_cases' AND TG_OP='UPDATE' AND public.catalog_stock_legacy_group_close_allowed(to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Zapieczętowany wynik PZ zwrotu' USING ERRCODE='23514';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['receipts','documents','rows','stock_maps','layer_maps','item_maps'] LOOP
  EXECUTE format('CREATE TRIGGER catalog_stock_return_immutable BEFORE UPDATE OR DELETE ON public.catalog_stock_return_%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_return_immutable()',n);
  EXECUTE format('CREATE TRIGGER catalog_stock_return_record_guard BEFORE INSERT ON public.catalog_stock_return_%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_return_record_guard()',n);
 END LOOP;
END $$;
CREATE TRIGGER catalog_stock_return_manifest_immutable BEFORE UPDATE OR DELETE ON catalog_stock_return_manifest FOR EACH ROW EXECUTE FUNCTION catalog_stock_return_immutable();
CREATE TRIGGER catalog_stock_return_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON catalog_stock_return_admissions FOR EACH ROW EXECUTE FUNCTION catalog_stock_return_admission_guard();
CREATE CONSTRAINT TRIGGER catalog_stock_return_complete AFTER INSERT ON catalog_stock_return_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_stock_return_complete();
CREATE TRIGGER catalog_stock_return_source_seal BEFORE INSERT OR UPDATE OR DELETE ON public.return_cases FOR EACH ROW EXECUTE FUNCTION catalog_stock_return_source_seal();
CREATE TRIGGER catalog_stock_return_source_seal BEFORE INSERT OR UPDATE OR DELETE ON public.return_items FOR EACH ROW EXECUTE FUNCTION catalog_stock_return_source_seal();

CREATE FUNCTION catalog_stock_return_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
SELECT public.catalog_stock_control_hash(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl_grant),
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',x.attname,'type',format_type(x.atttypid,x.atttypmod),'notnull',x.attnotnull,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(x.attacl) acl_grant),'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum)
    FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
  'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid,true) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid),
  'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles)r),
   'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.relname)
   FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'catalog_stock_return_%' AND c.relkind='r'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',oidvectortypes(p.proargtypes),'body',p.prosrc,'owner',pg_get_userbyid(p.proowner),
  'sd',p.prosecdef,'config',p.proconfig,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl_grant)) ORDER BY p.proname,oidvectortypes(p.proargtypes)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'catalog_stock_return_%'),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'type',t.tgtype,'enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid,true)) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname LIKE 'catalog_stock_return_%'))) $$;
CREATE FUNCTION catalog_stock_return_guards() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ownerid oid:=(SELECT proowner FROM pg_proc WHERE oid='public.catalog_stock_return_guards()'::regprocedure);
BEGIN
 -- Separate statement avoids planning a call to an absent optional phase delegate.
 IF to_regprocedure('public.catalog_stock_legacy_group_guards()') IS NULL THEN RETURN false;END IF;
 IF NOT public.catalog_stock_control_installed() OR NOT public.catalog_stock_legacy_group_guards() OR
  (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'catalog_stock_return_%' AND relkind='r')<>8 THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'catalog_stock_return_%' AND c.relkind='r' AND
  (c.relowner<>ownerid OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR EXISTS(SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE a.grantee<>ownerid) OR
   EXISTS(SELECT FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl)a WHERE x.attrelid=c.oid AND a.grantee<>ownerid))) OR
  EXISTS(SELECT FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'catalog_stock_return_%' AND
   (p.proowner<>ownerid OR NOT p.prosecdef OR EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE a.grantee<>ownerid))) THEN RETURN false;END IF;
 -- The parent manifest pins the complete implementations of both delegates;
 -- this non-recursive guard also checks their installed, explicit wiring.
 IF to_regprocedure('public.catalog_stock_control_effect_validate(uuid)') IS NULL OR
    to_regprocedure('public.catalog_stock_control_counter_complete()') IS NULL THEN RETURN false;END IF;
 IF position('PERFORM public.catalog_stock_return_validate(eid);' IN(SELECT prosrc FROM pg_proc WHERE oid='public.catalog_stock_control_effect_validate(uuid)'::regprocedure))=0 OR
    position('FROM public.catalog_stock_return_documents WHERE(tenant_id,series_id,year)=(NEW.tenant_id,NEW.series_id,NEW.year)' IN(SELECT prosrc FROM pg_proc WHERE oid='public.catalog_stock_control_counter_complete()'::regprocedure))=0 THEN RETURN false;END IF;
 RETURN coalesce((SELECT fingerprint=public.catalog_stock_return_fingerprint() FROM public.catalog_stock_return_manifest WHERE id),false);
END $$;
CREATE FUNCTION catalog_stock_return_require() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.catalog_stock_control_require();IF NOT public.catalog_stock_return_guards() THEN RAISE EXCEPTION 'Niekompletny certyfikowany adapter PZ zwrotu' USING ERRCODE='55000';END IF;END $$;
DO $$ DECLARE p record;BEGIN
 FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'catalog_stock_return_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.signature);
 END LOOP;
END $$;
INSERT INTO catalog_stock_return_manifest VALUES(true,public.catalog_stock_return_fingerprint());
-- END EMBEDDED CATALOG_STOCK_RETURN169

-- BEGIN COUNT169 AUTHORING FRAGMENT
-- ALTERNATIVE FULL MIXED COUNT BLOCK: replaces the base/lot count block in152.
-- Never apply after the base tables/functions or an already adopted ledger.
-- Native086 bulk and115/116 file count parents; no physical writes/backfill.
-- Fresh-install capacity cut: full metadata at INSERT statement entry/exit,
-- unchanged per-row authority, and mandatory managed terminal schema/IAM gate.
-- No installed152 manifest re-seeding or timeout change is authorized.
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
CREATE TABLE catalog_stock_count_move_maps(
 tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,inventory_execution_id uuid NOT NULL,source_index integer NOT NULL,
 operation_id uuid NOT NULL,out_bin_movement_id uuid NOT NULL,in_bin_movement_id uuid NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(tenant_id,receipt_id,source_index),UNIQUE(tenant_id,operation_id),UNIQUE(tenant_id,out_bin_movement_id),UNIQUE(tenant_id,in_bin_movement_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES public.catalog_stock_count_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,inventory_execution_id,source_index) REFERENCES public.inventory_bulk_edit_execution_rows(tenant_id,execution_id,index),
 FOREIGN KEY(operation_id) REFERENCES public.stock_location_operations(id),
 FOREIGN KEY(tenant_id,out_bin_movement_id) REFERENCES public.stock_location_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,in_bin_movement_id) REFERENCES public.stock_location_movements(tenant_id,id),
 CHECK(out_bin_movement_id<>in_bin_movement_id)
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
 FOREACH n IN ARRAY ARRAY['admissions','receipts','documents','rows','bin_maps','move_maps','stock_maps','layer_maps','native_maps','manifest'] LOOP
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
 (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND left(relname,20)='catalog_stock_count_' AND relkind='r')<>10 OR
 (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND left(proname,20)='catalog_stock_count_')<>26 THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND left(c.relname,20)='catalog_stock_count_' AND c.relkind='r' AND
 (c.relowner<>ownerid OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR EXISTS(SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE a.grantee<>ownerid)
 OR EXISTS(SELECT FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl)a WHERE x.attrelid=c.oid AND a.grantee<>ownerid)
 OR(c.relname='catalog_stock_count_manifest' AND EXISTS(SELECT FROM pg_policy WHERE polrelid=c.oid))
 OR(c.relname<>'catalog_stock_count_manifest' AND(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)<>1))) OR
 EXISTS(SELECT FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND left(p.proname,20)='catalog_stock_count_' AND
 (p.proowner<>ownerid OR NOT p.prosecdef OR EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE a.grantee<>ownerid))) THEN RETURN false;END IF;
 FOREACH nm IN ARRAY ARRAY['access','frame','prepare','child_scope','operation_key','location_scope','journal_proof','native_snapshot','bulk_witnesses','bulk_validate','lot_witnesses','lot_validate','finish','validate','budget','abandon','immutable','admission_guard','record_guard','complete','source_seal','fingerprint','guards','require','statement_guard','terminal_require'] LOOP
 IF NOT EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='catalog_stock_count_'||nm) THEN RETURN false;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT FROM pg_constraint k WHERE k.conrelid=to_regclass('public.catalog_stock_control_effects') AND k.confrelid='public.catalog_stock_count_receipts'::regclass AND k.contype='f' AND k.convalidated
 AND(SELECT array_agg(x.attname::text ORDER BY v.ord) FROM unnest(k.conkey) WITH ORDINALITY v(att,ord) JOIN pg_attribute x ON(x.attrelid,x.attnum)=(k.conrelid,v.att))=ARRAY['tenant_id','count_receipt_id']
 AND(SELECT array_agg(x.attname::text ORDER BY v.ord) FROM unnest(k.confkey) WITH ORDINALITY v(att,ord) JOIN pg_attribute x ON(x.attrelid,x.attnum)=(k.confrelid,v.att))=ARRAY['tenant_id','id']) THEN RETURN false;END IF;
 IF to_regprocedure('public.catalog_stock_control_effect_validate(uuid)') IS NULL OR to_regprocedure('public.catalog_stock_control_counter_complete()') IS NULL OR
 position('PERFORM public.catalog_stock_count_validate(eid);' IN(SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.catalog_stock_control_effect_validate(uuid)')))=0 OR
 position('FROM public.catalog_stock_count_documents WHERE(tenant_id,series_id,year)=(NEW.tenant_id,NEW.series_id,NEW.year)' IN(SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.catalog_stock_control_counter_complete()')))=0 THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND t.tgenabled IN('O','A') AND p.pronamespace='public'::regnamespace AND left(p.proname,20)='catalog_stock_count_')<>44 THEN RETURN false;END IF;
 FOREACH nm IN ARRAY ARRAY['receipts','documents','rows','bin_maps','stock_maps','layer_maps','native_maps','move_maps'] LOOP
  IF NOT EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.catalog_stock_count_'||nm)
   AND t.tgname='count_statement_before' AND t.tgtype=6 AND t.tgenabled='O' AND NOT t.tgisinternal
   AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgnargs=0
   AND t.tgfoid=to_regprocedure('public.catalog_stock_count_statement_guard()')) OR
  NOT EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.catalog_stock_count_'||nm)
   AND t.tgname='count_statement_after' AND t.tgtype=4 AND t.tgenabled='O' AND NOT t.tgisinternal
   AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL AND t.tgnargs=0
   AND t.tgfoid=to_regprocedure('public.catalog_stock_count_statement_guard()')) THEN RETURN false;END IF;
 END LOOP;
 RETURN coalesce((SELECT fingerprint=public.catalog_stock_count_fingerprint() FROM public.catalog_stock_count_manifest WHERE id),false);
END $$;
CREATE FUNCTION catalog_stock_count_require() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF coalesce(position('NOT public.catalog_stock_count_guards()' IN
  (SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.catalog_stock_control_guards()'))),0)=0 THEN
  RAISE EXCEPTION 'Brak obowiązkowego delegowania guardów COUNT' USING ERRCODE='55000';
 END IF;
 -- The full core guard already delegates COUNT; do not fingerprint it twice.
 PERFORM public.catalog_stock_control_require();
END $$;
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
CREATE INDEX catalog_stock_count_move_parent ON catalog_stock_count_move_maps(tenant_id,inventory_execution_id,source_index);
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
 requirements jsonb;native jsonb;historical boolean:=false;whj jsonb;psj jsonb;onw boolean;h text;movej jsonb:='[]';
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
 SELECT coalesce(jsonb_agg(jsonb_build_object('index',mv->'index','warehouse_id',p.warehouse_id,'product_id',mv->'product_id',
 'location',mv->'location','destination',mv#>'{input,destination}','quantity',mv#>'{input,quantity}') ORDER BY(mv->>'index')::integer),'[]') INTO movej
 FROM jsonb_array_elements(native)mv WHERE mv#>>'{input,operation}'='move' AND mv->>'status'='changed';
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
 SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') INTO whj FROM(SELECT DISTINCT x->>'warehouse_id'v FROM jsonb_array_elements(rs||movej)x)z;
 SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') INTO psj FROM(SELECT DISTINCT x->>'product_id'v FROM jsonb_array_elements(rs||movej)x)z;
 SELECT coalesce(jsonb_agg(to_jsonb(prod) ORDER BY prod.id),'[]') INTO productsj FROM public.products prod WHERE prod.tenant_id=t AND prod.id IN(SELECT v::uuid FROM jsonb_array_elements_text(psj)v);
 IF jsonb_array_length(productsj)<>jsonb_array_length(psj) OR jsonb_array_length(rs)>10000 OR octet_length(native::text)>33554432 THEN RAISE EXCEPTION 'Niepełny lub zbyt duży zakres pomiaru' USING ERRCODE='54000';END IF;
 RETURN jsonb_build_object('historical',false,'requirements',requirements,'native',native,'source_rows',rs,'move_rows',movej,'bins',rowsj,'warehouse_ids',whj,'product_ids',psj,'products',productsj,'wms_enabled',onw);
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
 IF f->'historical'='true'::jsonb OR(NOT EXISTS(SELECT FROM jsonb_array_elements(coalesce(f->'source_rows','[]'))sr WHERE(sr->>'delta')::bigint<>0)
 AND jsonb_array_length(coalesce(f->'move_rows','[]'))=0) THEN
 -- Only unchanged count/move groups are a NOP. Signed ON lot contributions
 -- remain nonzero source rows even when their aggregate bin change is zero.
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
 'warehouse_ids',f->'warehouse_ids','product_ids',f->'product_ids','requirements',f->'requirements',
 'expected_count_documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse_id',num->'warehouse_id','kind',num->'kind') ORDER BY num->>'warehouse_id',num->>'kind'),'[]') FROM jsonb_array_elements(numbers)num));
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
CREATE FUNCTION catalog_stock_count_location_scope(eid uuid,opkey uuid,wid uuid,pid uuid,kindj text,body jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;
BEGIN
 PERFORM public.catalog_stock_count_require();SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 IF a.id IS NULL OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR a.txid<>pg_current_xact_id() OR a.sealed OR kindj NOT IN('count','move')
 OR jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM public.inventory_bulk_edit_previews p JOIN public.inventory_bulk_edit_rows r ON(r.tenant_id,r.preview_id)=(p.tenant_id,p.id)
 WHERE p.tenant_id=a.tenant_id AND p.actor_id=a.actor_id AND p.ready AND p.warehouse_id=wid AND r.product_id=pid AND r.input->>'operation'=kindj AND r.status='changed'
 AND body->>'client_key'=opkey::text AND body->>'warehouse_id'=wid::text AND body->>'product_id'=pid::text
 AND body->>'location'=r.location AND body->'quantity'=r.input->'quantity' AND body->>'note'=p.note
 AND(kindj='count' AND NOT(body ? 'destination') OR kindj='move' AND body->'destination'=r.input->'destination')
 AND(body->>'expected_version')::bigint=(SELECT st.version FROM public.stock st WHERE(st.tenant_id,st.warehouse_id,st.product_id)=(a.tenant_id,wid,pid))
 AND NOT EXISTS(SELECT FROM jsonb_object_keys(body)bk WHERE bk NOT IN('client_key','warehouse_id','product_id','location','quantity','note','expected_version','destination'))
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
 SELECT * INTO ie FROM public.inventory_bulk_edit_executions WHERE(tenant_id,id)=(a.tenant_id,r.inventory_execution_id) AND public.catalog_stock_control_owns_xmin(xmin);
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
 WHERE NOT EXISTS(SELECT FROM public.stock_location_operations o WHERE o.id=v::uuid AND o.tenant_id=a.tenant_id AND public.catalog_stock_control_owns_xmin(o.xmin) AND o.result->>'kind'=x->>'operation'
 AND o.idempotency_key=public.catalog_stock_count_operation_key(a.source_id,(a.request->>'client_key')::uuid,(x->>'index')::integer))) THEN
 RAISE EXCEPTION 'Brak rzeczywistej operacji rodzimego pomiaru' USING ERRCODE='23514';END IF;
 native:=jsonb_build_object('execution',to_jsonb(ie),'rows',rs,'preview',(SELECT to_jsonb(p) FROM public.inventory_bulk_edit_previews p WHERE(tenant_id,id)=(a.tenant_id,a.source_id)),
 'preview_rows',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.index) FROM public.inventory_bulk_edit_rows x WHERE(x.tenant_id,x.preview_id)=(a.tenant_id,a.source_id)),
 'operations',(SELECT coalesce(jsonb_agg(to_jsonb(locop) ORDER BY locop.id),'[]') FROM public.stock_location_operations locop WHERE locop.tenant_id=a.tenant_id AND locop.id IN
 (SELECT operation_id::uuid FROM jsonb_array_elements(rs)er CROSS JOIN LATERAL jsonb_array_elements_text(er->'operation_ids')operation_id)));
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

-- Whole086 group: every changed native row has one real025 operation;
-- count journals become PW/RW rows, move pairs remain separate witnesses.
CREATE FUNCTION catalog_stock_count_bulk_witnesses(eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;r public.catalog_stock_count_receipts;
 native jsonb;frozen jsonb;executed jsonb;locop public.stock_location_operations;
 binsj jsonb;answer jsonb:='[]';allids jsonb:='[]';countids jsonb:='[]';opid uuid;delta bigint;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(a.tenant_id,eid);
 IF a.id IS NULL OR a.protocol<>'inventory_bulk' OR a.txid<>pg_current_xact_id() OR r.id IS DISTINCT FROM a.count_receipt_id
 OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obca grupa rodzimego pomiaru' USING ERRCODE='23514';END IF;
 native:=public.catalog_stock_count_native_snapshot(eid);
 FOR frozen IN SELECT value FROM jsonb_array_elements(a.frame#>'{native,rows}') ORDER BY(value->>'index')::integer LOOP
 SELECT value INTO executed FROM jsonb_array_elements(native->'rows') WHERE value->'index'=frozen->'index';
 IF frozen->>'status'<>'changed' THEN
 IF jsonb_array_length(executed->'operation_ids')<>0 THEN RAISE EXCEPTION 'Niezmieniony wiersz tworzy operację' USING ERRCODE='23514';END IF;CONTINUE;END IF;
 IF frozen#>>'{input,operation}' NOT IN('count','move') OR jsonb_array_length(executed->'operation_ids')<>1 THEN RAISE EXCEPTION 'Niepełny rodzaj operacji grupy' USING ERRCODE='23514';END IF;
 opid:=(executed#>>'{operation_ids,0}')::uuid;
 SELECT * INTO locop FROM public.stock_location_operations WHERE id=opid AND tenant_id=a.tenant_id AND public.catalog_stock_control_owns_xmin(xmin);
 IF locop.id IS NULL OR locop.idempotency_key<>public.catalog_stock_count_operation_key(a.source_id,(a.request->>'client_key')::uuid,(frozen->>'index')::integer)
 OR locop.result->>'id' IS DISTINCT FROM opid::text OR locop.result->>'kind' IS DISTINCT FROM frozen#>>'{input,operation}'
 OR jsonb_typeof(locop.result->'data') IS DISTINCT FROM 'array' OR EXISTS(SELECT FROM jsonb_array_elements(locop.result->'data')binrow
 WHERE(binrow->>'tenant_id',binrow->>'warehouse_id',binrow->>'product_id') IS DISTINCT FROM(a.tenant_id::text,a.frame#>>'{native,head,warehouse_id}',frozen->>'product_id')) THEN
 RAISE EXCEPTION 'Obca rzeczywista operacja grupy pomiaru' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(bm) ORDER BY bm.id),'[]') INTO binsj FROM public.stock_location_movements bm WHERE bm.tenant_id=a.tenant_id AND bm.operation_id=opid;
 IF EXISTS(SELECT FROM public.stock_location_movements bm WHERE bm.tenant_id=a.tenant_id AND bm.operation_id=opid
 AND(NOT public.catalog_stock_control_owns_xmin(bm.xmin) OR bm.kind IS DISTINCT FROM frozen#>>'{input,operation}'
 OR bm.note IS DISTINCT FROM a.frame#>>'{native,head,note}' OR bm.warehouse_id::text IS DISTINCT FROM a.frame#>>'{native,head,warehouse_id}' OR bm.product_id::text IS DISTINCT FROM frozen->>'product_id')) THEN
 RAISE EXCEPTION 'Obce dzienniki operacji grupy' USING ERRCODE='23514';END IF;
 IF frozen#>>'{input,operation}'='count' THEN
 delta:=(frozen#>>'{input,quantity}')::bigint-coalesce((frozen#>>'{before,quantity}')::bigint,0);
 IF delta=0 OR jsonb_array_length(binsj)<>1 OR binsj#>>'{0,location}' IS DISTINCT FROM frozen->>'location' OR(binsj#>>'{0,delta}')::bigint<>delta THEN
 RAISE EXCEPTION 'Pomiar nie odpowiada rzeczywistemu dziennikowi' USING ERRCODE='23514';END IF;
 countids:=countids||jsonb_build_array(binsj#>'{0,id}');
 ELSE
 IF frozen->>'location'=frozen#>>'{input,destination}' OR jsonb_array_length(binsj)<>2
 OR(SELECT count(*) FROM jsonb_array_elements(binsj)bj WHERE bj->>'location'=frozen->>'location' AND(bj->>'delta')::bigint=-(frozen#>>'{input,quantity}')::bigint)<>1
 OR(SELECT count(*) FROM jsonb_array_elements(binsj)bj WHERE bj->>'location'=frozen#>>'{input,destination}' AND(bj->>'delta')::bigint=(frozen#>>'{input,quantity}')::bigint)<>1 THEN
 RAISE EXCEPTION 'Przesunięcie nie ma dokładnej pary dzienników' USING ERRCODE='23514';END IF;
 END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(binsj)bj WHERE allids ? (bj->>'id')) THEN RAISE EXCEPTION 'Dziennik grupy użyty ponownie' USING ERRCODE='23514';END IF;
 allids:=allids||(SELECT jsonb_agg(bj->'id') FROM jsonb_array_elements(binsj)bj);
 answer:=answer||jsonb_build_array(jsonb_build_object('source_index',frozen->'index','kind',frozen#>'{input,operation}',
 'operation_id',opid,'frozen_row',frozen,'execution_row',executed,'operation',to_jsonb(locop),'bins',binsj));
 END LOOP;
 IF(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') FROM jsonb_array_elements(allids)v) IS DISTINCT FROM r.proof->'location_movement_ids'
 OR jsonb_array_length(r.proof->'layer_movement_ids')<>0 THEN RAISE EXCEPTION 'Niepełne całe wykonanie grupy pomiaru' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('rows',answer,'count_bin_ids',(SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') FROM jsonb_array_elements(countids)v));
END $$;

CREATE FUNCTION catalog_stock_count_bulk_validate(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;r public.catalog_stock_count_receipts;
 ws jsonb;wit jsonb;bj jsonb;wanted jsonb;actual jsonb;row_record record;mm public.catalog_stock_count_move_maps;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_count_receipts WHERE(tenant_id,admission_id)=(a.tenant_id,eid);
 ws:=public.catalog_stock_count_bulk_witnesses(eid);
 SELECT coalesce(jsonb_agg(jsonb_build_array(s->>'warehouse_id',s->>'product_id',(s->>'delta')::bigint,a.frame#>>'{native,head,note}')
 ORDER BY s->>'warehouse_id',s->>'product_id',(s->>'delta')::bigint),'[]') INTO wanted FROM jsonb_array_elements(a.frame->'source_rows')s WHERE(s->>'delta')::bigint<>0;
 SELECT coalesce(jsonb_agg(jsonb_build_array(sm.warehouse_id::text,sm.product_id::text,sm.delta::bigint,sm.note) ORDER BY sm.warehouse_id,sm.product_id,sm.delta),'[]') INTO actual
 FROM public.stock_movements sm WHERE sm.tenant_id=a.tenant_id AND sm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v);
 IF wanted IS DISTINCT FROM actual OR EXISTS(SELECT FROM public.stock_movements sm WHERE sm.tenant_id=a.tenant_id
 AND sm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v) AND(sm.kind<>'location_count' OR NOT public.catalog_stock_control_owns_xmin(sm.xmin))) THEN
 RAISE EXCEPTION 'Niepełne podpisane agregaty pomiaru grupy' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.catalog_stock_count_rows cr JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id)
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,r.id))<>jsonb_array_length(ws->'count_bin_ids')
 OR(SELECT count(*) FROM public.catalog_stock_count_move_maps WHERE(tenant_id,receipt_id)=(a.tenant_id,r.id))<>(SELECT count(*) FROM jsonb_array_elements(ws->'rows')w WHERE w->>'kind'='move') THEN
 RAISE EXCEPTION 'Niepełne rozdzielenie pomiarów i przesunięć' USING ERRCODE='23514';END IF;
 FOR wit IN SELECT value FROM jsonb_array_elements(ws->'rows') LOOP
 IF wit->>'kind'='move' THEN
 SELECT * INTO mm FROM public.catalog_stock_count_move_maps WHERE(tenant_id,receipt_id,source_index)=(a.tenant_id,r.id,(wit->>'source_index')::integer);
 IF mm.receipt_id IS NULL OR mm.inventory_execution_id IS DISTINCT FROM r.inventory_execution_id OR mm.operation_id::text IS DISTINCT FROM wit->>'operation_id' OR mm.payload IS DISTINCT FROM wit
 OR mm.out_bin_movement_id::text IS DISTINCT FROM(SELECT value->>'id' FROM jsonb_array_elements(wit->'bins') WHERE(value->>'delta')::bigint<0)
 OR mm.in_bin_movement_id::text IS DISTINCT FROM(SELECT value->>'id' FROM jsonb_array_elements(wit->'bins') WHERE(value->>'delta')::bigint>0) THEN
 RAISE EXCEPTION 'Zmieniony typowany dowód przesunięcia' USING ERRCODE='23514';END IF;
 ELSE
 bj:=wit#>'{bins,0}';
 SELECT cr.*,cd.kind INTO row_record FROM public.catalog_stock_count_rows cr JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id)
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,r.id) AND cr.bin_movement_id=(bj->>'id')::uuid;
 IF row_record.id IS NULL OR(row_record.warehouse_id::text,row_record.product_id::text,row_record.location,row_record.delta::text) IS DISTINCT FROM(bj->>'warehouse_id',bj->>'product_id',bj->>'location',bj->>'delta')
 OR row_record.kind<>(CASE WHEN row_record.delta>0 THEN 'PW' ELSE 'RW' END)
 OR row_record.payload IS DISTINCT FROM jsonb_build_object('product_id',row_record.product_id,'sku',(SELECT prod->>'sku' FROM jsonb_array_elements(a.frame->'products')prod WHERE prod->>'id'=row_record.product_id::text),
 'name',(SELECT prod->>'name' FROM jsonb_array_elements(a.frame->'products')prod WHERE prod->>'id'=row_record.product_id::text),'warehouse_id',row_record.warehouse_id,'location',row_record.location,'delta',row_record.delta,'quantity',abs(row_record.delta::bigint)::text,'bin_movement_id',row_record.bin_movement_id)
 OR(SELECT count(*) FROM public.catalog_stock_count_native_maps nm WHERE(nm.tenant_id,nm.row_id,nm.inventory_execution_id,nm.inventory_row_index,nm.source_index,nm.quantity)=
 (a.tenant_id,row_record.id,r.inventory_execution_id,(wit->>'source_index')::integer,(wit->>'source_index')::integer,abs(row_record.delta)))<>1
 OR(SELECT count(*) FROM public.catalog_stock_count_native_maps WHERE(tenant_id,row_id)=(a.tenant_id,row_record.id))<>1
 OR EXISTS(SELECT FROM public.catalog_stock_count_layer_maps WHERE(tenant_id,row_id)=(a.tenant_id,row_record.id))
 OR EXISTS(SELECT FROM public.catalog_stock_count_bin_maps WHERE(tenant_id,row_id)=(a.tenant_id,row_record.id))
 OR(SELECT coalesce(sum(quantity),0) FROM public.catalog_stock_count_stock_maps WHERE(tenant_id,row_id)=(a.tenant_id,row_record.id))>abs(row_record.delta::bigint) THEN
 RAISE EXCEPTION 'Niepełny podpisany dokument pomiaru grupy' USING ERRCODE='23514';END IF;
 END IF;
 END LOOP;
 IF EXISTS(SELECT FROM public.stock_movements sm WHERE sm.tenant_id=a.tenant_id AND sm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v)
 AND(SELECT coalesce(sum(quantity),0) FROM public.catalog_stock_count_stock_maps WHERE(tenant_id,stock_movement_id)=(a.tenant_id,sm.id))<>abs(sm.delta::bigint)) OR EXISTS(
 SELECT FROM public.catalog_stock_count_stock_maps maprow JOIN public.catalog_stock_count_rows cr ON(cr.tenant_id,cr.id)=(maprow.tenant_id,maprow.row_id)
 JOIN public.catalog_stock_count_documents cd ON(cd.tenant_id,cd.id)=(cr.tenant_id,cr.document_id) JOIN public.stock_movements sm ON(sm.tenant_id,sm.id)=(maprow.tenant_id,maprow.stock_movement_id)
 WHERE(cd.tenant_id,cd.receipt_id)=(a.tenant_id,r.id) AND(sm.id NOT IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'stock_movement_ids')v)
 OR(sm.warehouse_id,sm.product_id,sign(sm.delta))<>(cr.warehouse_id,cr.product_id,sign(cr.delta)))) THEN RAISE EXCEPTION 'Niepełny pojedynczy zapis agregatu pomiaru' USING ERRCODE='23514';END IF;
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
 AND public.catalog_stock_control_owns_xmin(nativep.xmin)) OR ln.stocktake_id IS DISTINCT FROM posting.stocktake_id
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
 AND lm.kind='stocktake' AND public.catalog_stock_control_owns_xmin(lm.xmin) AND lm.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v)
 AND((ln.lot_id IS NOT NULL AND cl.lot_id=ln.lot_id) OR(ln.lot_id IS NULL AND EXISTS(
 SELECT FROM public.wms_lots lot WHERE(lot.tenant_id,lot.id,lot.product_id,lot.operation_id)=(a.tenant_id,cl.lot_id,ln.product_id,posting.operation_id)
 AND lot.lot_code IS NOT DISTINCT FROM ln.lot->>'lot_code' AND lot.expiry_date::text IS NOT DISTINCT FROM ln.lot->>'expiry_date'
 AND public.catalog_stock_control_owns_xmin(lot.xmin))))
 AND cl.unit_cost_minor::text IS NOT DISTINCT FROM fr->>'unit_cost_minor'
 AND cl.currency IS NOT DISTINCT FROM fr->>'currency' AND lm.value_delta IS NOT DISTINCT FROM lm.delta::bigint*cl.unit_cost_minor
 AND(((fr->>'delta')::integer<0 AND cl.id::text IS NOT DISTINCT FROM fr->>'layer_id'
 AND ln.original->'layer_ids' ? cl.id::text)
 OR((fr->>'delta')::integer>0 AND fr->>'layer_id' IS NULL AND cl.stocktake_line_id=ln.id
 AND cl.operation_id=posting.operation_id AND public.catalog_stock_control_owns_xmin(cl.xmin)))
 AND EXISTS(SELECT FROM public.wms_operations op CROSS JOIN LATERAL jsonb_array_elements(op.result->'rows')oprow
 CROSS JOIN LATERAL jsonb_array_elements(oprow->'fragments')opf
 WHERE(op.tenant_id,op.id,op.stocktake_id,op.stocktake_posting_id,op.stocktake_review_id)=
 (a.tenant_id,posting.operation_id,posting.stocktake_id,posting.id,posting.review_id)
 AND op.kind='stocktake_post' AND op.actor_id=a.actor_id AND public.catalog_stock_control_owns_xmin(op.xmin)
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
DECLARE a public.catalog_stock_count_admissions;proof jsonb;native jsonb;n jsonb;did uuid;head jsonb;docs jsonb:='[]';k text;ws jsonb;bulkj jsonb;count_bins jsonb;
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
 count_bins:=proof->'location_movement_ids';
 IF a.protocol='inventory_bulk' THEN
 bulkj:=public.catalog_stock_count_bulk_witnesses(eid);count_bins:=bulkj->'count_bin_ids';
 INSERT INTO public.catalog_stock_count_move_maps
 SELECT a.tenant_id,a.count_receipt_id,(b->>'inventory_execution_id')::uuid,(wit->>'source_index')::integer,(wit->>'operation_id')::uuid,
 (SELECT(value->>'id')::uuid FROM jsonb_array_elements(wit->'bins') WHERE(value->>'delta')::bigint<0),
 (SELECT(value->>'id')::uuid FROM jsonb_array_elements(wit->'bins') WHERE(value->>'delta')::bigint>0),wit
 FROM jsonb_array_elements(bulkj->'rows')wit WHERE wit->>'kind'='move';
 END IF;
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
 AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(count_bins)v) AND (CASE WHEN m.delta>0 THEN 'PW' ELSE 'RW' END)=n->>'kind';
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
 WHERE m.tenant_id=a.tenant_id AND m.warehouse_id=(n->>'warehouse_id')::uuid AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(count_bins)v)
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
 RETURN jsonb_build_object('receipt_id',a.count_receipt_id,'documents',docs);
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
 IF a.protocol='inventory_bulk' THEN
 IF(SELECT count(*) FROM public.catalog_stock_count_documents WHERE(tenant_id,receipt_id)=(a.tenant_id,a.count_receipt_id))<>jsonb_array_length(a.numbers) THEN
 RAISE EXCEPTION 'Niepełne numery PW/RW grupy' USING ERRCODE='23514';END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(a.numbers) LOOP
 SELECT * INTO doc_record FROM public.catalog_stock_count_documents WHERE(tenant_id,receipt_id,warehouse_id,kind)=(a.tenant_id,a.count_receipt_id,(n->>'warehouse_id')::uuid,n->>'kind');
 IF doc_record.id IS NULL OR doc_record.series_id::text<>n->>'series_id' OR doc_record.year<>(n->>'year')::integer OR doc_record.sequence<>(n->>'sequence')::bigint OR doc_record.number<>n->>'number'
 OR doc_record.payload->>'number'<>doc_record.number OR doc_record.payload->>'id'<>doc_record.id::text OR doc_record.payload->>'receipt_id'<>a.count_receipt_id::text OR doc_record.payload->>'kind'<>doc_record.kind
 OR doc_record.payload->'series' IS DISTINCT FROM n->'series' OR(doc_record.payload->>'row_count')::integer<>(SELECT count(*) FROM public.catalog_stock_count_rows WHERE(tenant_id,document_id)=(a.tenant_id,doc_record.id))
 OR doc_record.payload->>'quantity' IS DISTINCT FROM(SELECT sum(abs(delta::bigint))::text FROM public.catalog_stock_count_rows WHERE(tenant_id,document_id)=(a.tenant_id,doc_record.id)) THEN
 RAISE EXCEPTION 'Niezgodny pełny dokument podpisanego pomiaru grupy' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM public.catalog_stock_count_bulk_validate(eid);RETURN;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_array(x->>'warehouse_id',x->>'product_id',x->>'location',(x->>'delta')::bigint) ORDER BY x->>'warehouse_id',x->>'product_id',x->>'location'),'[]') INTO wanted FROM jsonb_array_elements(a.frame->'bins')x;
 SELECT coalesce(jsonb_agg(jsonb_build_array(w::text,p::text,l,delta) ORDER BY w,p,l),'[]') INTO actual FROM
 (SELECT warehouse_id w,product_id p,location l,sum(delta::bigint)delta FROM public.stock_location_movements
 WHERE tenant_id=a.tenant_id AND id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'location_movement_ids')v) GROUP BY 1,2,3)z;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'Podpisane biny nie odpowiadają pełnemu zamrożonemu pomiarowi' USING ERRCODE='23514';END IF;
 FOR j IN SELECT to_jsonb(m) FROM public.stock_location_movements m WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'location_movement_ids')v) LOOP
 IF(j->>'delta')::integer=0 OR j->>'kind' IS DISTINCT FROM (CASE WHEN(a.frame->>'wms_enabled')::boolean THEN 'wms_stocktake' ELSE 'count' END) OR
 NOT EXISTS(SELECT FROM public.stock_location_movements m WHERE m.tenant_id=a.tenant_id AND m.id=(j->>'id')::uuid AND public.catalog_stock_control_owns_xmin(m.xmin)) OR
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
 AND(NOT public.catalog_stock_control_owns_xmin(m.xmin) OR m.delta=0 OR m.kind IS DISTINCT FROM (CASE WHEN(a.frame->>'wms_enabled')::boolean THEN 'wms_stocktake' ELSE 'location_count' END))) THEN
 RAISE EXCEPTION 'Niezgodny pojedynczy rzeczywisty rozchód agregatu pomiaru' USING ERRCODE='23514';END IF;
 IF NOT(a.frame->>'wms_enabled')::boolean AND jsonb_array_length(r.proof->'layer_movement_ids')<>0 THEN RAISE EXCEPTION 'OFF nie tworzy wyceny WMS' USING ERRCODE='23514';END IF;
 IF(a.frame->>'wms_enabled')::boolean THEN
 SELECT coalesce(jsonb_agg(jsonb_build_array(w::text,p::text,l,delta) ORDER BY w,p,l),'[]') INTO actual FROM
 (SELECT warehouse_id w,product_id p,location l,sum(delta::bigint)delta FROM public.wms_layer_movements WHERE tenant_id=a.tenant_id AND id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v) GROUP BY 1,2,3 HAVING sum(delta::bigint)<>0)z;
 SELECT coalesce(jsonb_agg(jsonb_build_array(x->>'warehouse_id',x->>'product_id',x->>'location',(x->>'delta')::bigint) ORDER BY x->>'warehouse_id',x->>'product_id',x->>'location'),'[]') INTO wanted FROM jsonb_array_elements(a.frame->'bins')x;
 IF wanted IS DISTINCT FROM actual OR EXISTS(SELECT FROM public.wms_layer_movements m JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(m.tenant_id,m.layer_id,m.product_id)
 WHERE m.tenant_id=a.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids')v)
 AND(NOT public.catalog_stock_control_owns_xmin(m.xmin) OR m.kind<>'stocktake' OR m.delta=0 OR NOT EXISTS(SELECT FROM jsonb_array_elements(r.snapshot#>'{execution,payload,links}')lk WHERE lk->>'operation_id'=m.operation_id::text)
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
 FOREACH nm IN ARRAY ARRAY['admissions','receipts','documents','rows','bin_maps','move_maps','stock_maps','layer_maps','native_maps'] LOOP
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
 IF NEW.numbers IS DISTINCT FROM(SELECT coalesce(jsonb_agg(number_entry ORDER BY number_entry->>'warehouse_id',number_entry->>'kind'),'[]') FROM jsonb_array_elements(NEW.numbers)number_entry) OR
 (SELECT count(*) FROM jsonb_array_elements(NEW.numbers))<>(SELECT count(*) FROM(SELECT DISTINCT x->>'warehouse_id',sign((x->>'delta')::bigint) FROM jsonb_array_elements(NEW.frame->'source_rows')x WHERE(x->>'delta')::bigint<>0)z) THEN
 RAISE EXCEPTION 'Niepełne numery obu znaków pomiaru' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION catalog_stock_count_record_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_count_admissions;rid uuid;did uuid;
BEGIN
 -- Fresh full metadata is checked before AND after this INSERT statement.
 -- Actual native receipt birth and per-row tenant/currentTX authority remain.
 IF TG_TABLE_NAME='catalog_stock_count_receipts' THEN SELECT * INTO a FROM public.catalog_stock_count_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.admission_id);
 IF NEW.id IS DISTINCT FROM a.count_receipt_id OR NEW.snapshot IS DISTINCT FROM public.catalog_stock_count_native_snapshot(a.id,NEW.inventory_execution_id,NEW.stock_file_execution_id) THEN RAISE EXCEPTION 'Nieprawdziwy niezmienny rodzic pomiaru' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME IN('catalog_stock_count_documents','catalog_stock_count_move_maps') THEN rid:=NEW.receipt_id;
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
 ELSIF TG_TABLE_NAME='stock_location_operations' THEN
 IF EXISTS(SELECT FROM public.catalog_stock_count_receipts cr JOIN public.inventory_bulk_edit_execution_rows er ON er.tenant_id=cr.tenant_id AND(er.execution_id=cr.inventory_execution_id OR EXISTS(
 SELECT FROM jsonb_array_elements(cr.snapshot#>'{execution,payload,links}')lk WHERE lk->>'core_execution_id'=er.execution_id::text))
 WHERE(cr.tenant_id,cr.admission_id)=(a.tenant_id,a.id) AND(d->>'id')::uuid=ANY(er.operation_ids)) THEN RAISE EXCEPTION 'Rodzima operacja grupy jest zapieczętowana' USING ERRCODE='23514';END IF;
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
 FOREACH nm IN ARRAY ARRAY['receipts','documents','rows','bin_maps','stock_maps','layer_maps','native_maps','move_maps'] LOOP
 EXECUTE format('CREATE TRIGGER count_record BEFORE INSERT ON public.catalog_stock_count_%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_count_record_guard()',nm);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.catalog_stock_count_%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_count_immutable()',nm);
 END LOOP;
 FOREACH nm IN ARRAY ARRAY['inventory_bulk_edit_previews','inventory_bulk_edit_rows','inventory_bulk_edit_executions','inventory_bulk_edit_execution_rows','stock_file_import_previews','stock_file_import_executions','stock_file_import_admissions','stock_location_operations'] LOOP
 EXECUTE format('CREATE TRIGGER catalog_stock_count_source_seal BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.catalog_stock_count_source_seal()',nm);
 END LOOP;
END $$;
-- Last ACL pass is after every helper and trigger, before both manifests.
CREATE FUNCTION catalog_stock_count_statement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.catalog_stock_count_require();RETURN NULL;
END $$;
CREATE FUNCTION catalog_stock_count_terminal_require() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.catalog_stock_count_require();
END $$;
DO $$ DECLARE nm text;BEGIN
 FOREACH nm IN ARRAY ARRAY['receipts','documents','rows','bin_maps','stock_maps','layer_maps','native_maps','move_maps'] LOOP
  EXECUTE format('CREATE TRIGGER count_statement_before BEFORE INSERT ON public.catalog_stock_count_%I FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_stock_count_statement_guard()',nm);
  EXECUTE format('CREATE TRIGGER count_statement_after AFTER INSERT ON public.catalog_stock_count_%I FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_stock_count_statement_guard()',nm);
 END LOOP;
END $$;
DO $$ DECLARE p record;BEGIN
 FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND left(proname,20)='catalog_stock_count_' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.signature);
 END LOOP;
END $$;
INSERT INTO public.catalog_stock_count_manifest VALUES(true,public.catalog_stock_count_fingerprint());
-- END COUNT169 AUTHORING FRAGMENT
ALTER TABLE public.catalog_stock_control_effects ADD COLUMN count_receipt_id uuid;
ALTER TABLE public.catalog_stock_control_effects ADD CONSTRAINT catalog_stock_control_count_receipt_fk FOREIGN KEY(tenant_id,count_receipt_id) REFERENCES public.catalog_stock_count_receipts(tenant_id,id);

CREATE FUNCTION catalog_stock_control_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.catalog_stock_control_hash(jsonb_build_object('count_module',public.catalog_stock_count_fingerprint(),'return_module',public.catalog_stock_return_fingerprint(),'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl_grant),'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(a.attacl) acl_grant)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid,true) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid),'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles)r),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'catalog_stock_control_%' AND c.relkind='r'),'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',oidvectortypes(p.proargtypes),'body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'sd',p.prosecdef,'config',p.proconfig,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable) ORDER BY CASE WHEN acl_grant.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_grant.grantee) END,pg_get_userbyid(acl_grant.grantor),acl_grant.privilege_type,acl_grant.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl_grant)) ORDER BY p.proname,oidvectortypes(p.proargtypes)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'catalog_stock_control_%'),'triggers',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'type',t.tgtype,'enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid,true)) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname LIKE 'catalog_stock_control_%'))) $$;
CREATE FUNCTION catalog_stock_control_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ DECLARE ownerid oid:=(SELECT proowner FROM pg_proc WHERE oid='public.catalog_stock_control_guards()'::regprocedure);BEGIN
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.pronamespace='public'::regnamespace AND p.proname IN('catalog_stock_control_xid_claim_guard','catalog_stock_control_capture_xid_birth'))<>13 OR
  to_regprocedure('public.catalog_stock_control_owns_xmin(xid)') IS NULL OR
  to_regprocedure('public.catalog_stock_control_prune_xid_claims()') IS NULL THEN RETURN false; END IF;
 IF NOT public.catalog_stock_control_installed() OR NOT public.catalog_stock_return_guards() OR NOT public.catalog_stock_count_guards() OR NOT public.product_catalog_guards() OR NOT public.warehouse_inventory_policy_guards() OR(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'catalog_stock_control_%' AND relkind='r')<>14 THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'catalog_stock_control_%' AND c.relkind='r' AND(c.relowner<>ownerid OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR EXISTS(SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE a.grantee<>ownerid) OR EXISTS(SELECT FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl)a WHERE x.attrelid=c.oid AND a.grantee<>ownerid))) OR EXISTS(SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'catalog_stock_control_%' AND(p.proowner<>ownerid OR a.grantee<>ownerid)) THEN RETURN false;END IF;
 RETURN coalesce((SELECT fingerprint=public.catalog_stock_control_fingerprint() FROM public.catalog_stock_control_manifest WHERE id),false);END $$;
DO $$ DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'catalog_stock_control_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.signature);END LOOP;END $$;
INSERT INTO catalog_stock_control_manifest VALUES(true,public.catalog_stock_control_fingerprint());
