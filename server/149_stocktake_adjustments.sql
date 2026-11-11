-- PW/RW are immutable evidence of the existing stocktake journals. They never
-- call a stock writer and never attach warehouse_document_id to WMS origins.
CREATE TABLE stocktake_adjustment_series (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,kind text NOT NULL CHECK(kind IN('PW','RW')),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120),prefix text NOT NULL CHECK(prefix~'^[A-Z][A-Z0-9_-]{0,19}$'),
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,kind,prefix)
);
CREATE TABLE stocktake_adjustment_series_commands (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request jsonb NOT NULL,series_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES stocktake_adjustment_series(tenant_id,id)
);
CREATE TABLE stocktake_adjustment_counters (
 tenant_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2000 AND 9999),
 sequence bigint NOT NULL CHECK(sequence>=0),PRIMARY KEY(tenant_id,series_id,year),
 FOREIGN KEY(tenant_id,series_id) REFERENCES stocktake_adjustment_series(tenant_id,id)
);
CREATE TABLE stocktake_adjustment_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN('quantity','wms')),quantity_stocktake_id uuid,wms_stocktake_id uuid,
 request jsonb NOT NULL,scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),frame jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,quantity_stocktake_id) REFERENCES stocktakes(tenant_id,id),
 FOREIGN KEY(tenant_id,wms_stocktake_id) REFERENCES wms_stocktakes(tenant_id,id),
 CHECK((source_kind='quantity' AND quantity_stocktake_id IS NOT NULL AND wms_stocktake_id IS NULL)
 OR(source_kind='wms' AND quantity_stocktake_id IS NULL AND wms_stocktake_id IS NOT NULL))
);
CREATE TABLE stocktake_adjustment_preview_rows (
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 9999),
 payload jsonb NOT NULL,PRIMARY KEY(tenant_id,preview_id,ordinal),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES stocktake_adjustment_previews(tenant_id,id)
);
CREATE TABLE stocktake_adjustment_admissions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request jsonb NOT NULL,txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 counter_before jsonb NOT NULL,counter_after jsonb NOT NULL DEFAULT '[]',sealed boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES stocktake_adjustment_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id)
);
CREATE TABLE stocktake_adjustment_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,
 client_key uuid NOT NULL,request jsonb NOT NULL,source_kind text NOT NULL CHECK(source_kind IN('quantity','wms')),
 quantity_stocktake_id uuid,wms_stocktake_id uuid,posting_id uuid,operation_id uuid,
 source_version bigint NOT NULL CHECK(source_version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),
 UNIQUE(tenant_id,quantity_stocktake_id),UNIQUE(tenant_id,wms_stocktake_id),
 FOREIGN KEY(tenant_id,id) REFERENCES stocktake_adjustment_admissions(tenant_id,id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES stocktake_adjustment_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,quantity_stocktake_id) REFERENCES stocktakes(tenant_id,id),
 FOREIGN KEY(tenant_id,wms_stocktake_id,posting_id) REFERENCES wms_stocktake_postings(tenant_id,stocktake_id,id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id),
 CHECK((source_kind='quantity' AND quantity_stocktake_id IS NOT NULL AND wms_stocktake_id IS NULL AND posting_id IS NULL AND operation_id IS NULL)
 OR(source_kind='wms' AND quantity_stocktake_id IS NULL AND wms_stocktake_id IS NOT NULL AND posting_id IS NOT NULL AND operation_id IS NOT NULL))
);
CREATE TABLE stocktake_adjustment_documents (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('PW','RW')),
 series_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2000 AND 9999),sequence bigint NOT NULL CHECK(sequence>0),
 number text NOT NULL,warehouse_id uuid NOT NULL,row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 10000),
 summary jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,receipt_id,kind),UNIQUE(tenant_id,series_id,year,sequence),UNIQUE(tenant_id,number),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES stocktake_adjustment_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,series_id,year) REFERENCES stocktake_adjustment_counters(tenant_id,series_id,year),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
-- The UUID primary keys already exist; these compound keys permit tenant-bound
-- journal references without rewriting any historical row.
ALTER TABLE stock_location_movements ADD CONSTRAINT stocktake_adjustment_location_identity UNIQUE(tenant_id,id);
ALTER TABLE stock_movements ADD CONSTRAINT stocktake_adjustment_stock_identity UNIQUE(tenant_id,id);
CREATE TABLE stocktake_adjustment_document_rows (
 tenant_id uuid NOT NULL,document_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 9999),
 preview_id uuid NOT NULL,source_ordinal integer NOT NULL,payload jsonb NOT NULL,
 quantity_movement_id uuid,wms_movement_id uuid,stock_movement_id uuid,
 PRIMARY KEY(tenant_id,document_id,ordinal),UNIQUE(tenant_id,preview_id,source_ordinal),
 UNIQUE(tenant_id,quantity_movement_id),UNIQUE(tenant_id,wms_movement_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES stocktake_adjustment_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,preview_id,source_ordinal) REFERENCES stocktake_adjustment_preview_rows(tenant_id,preview_id,ordinal),
 FOREIGN KEY(tenant_id,quantity_movement_id) REFERENCES stock_location_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,wms_movement_id) REFERENCES wms_layer_movements(tenant_id,id),
 FOREIGN KEY(tenant_id,stock_movement_id) REFERENCES stock_movements(tenant_id,id),
 CHECK((quantity_movement_id IS NULL)<>(wms_movement_id IS NULL))
);
CREATE INDEX stocktake_adjustment_history ON stocktake_adjustment_documents(tenant_id,created_at DESC,id DESC);
CREATE INDEX stocktake_adjustment_document_receipt ON stocktake_adjustment_documents(tenant_id,receipt_id);
CREATE INDEX stocktake_adjustment_row_movement ON stocktake_adjustment_document_rows(tenant_id,stock_movement_id);
CREATE INDEX stocktake_adjustment_command_series ON stocktake_adjustment_series_commands(tenant_id,series_id);
CREATE INDEX stocktake_adjustment_document_series ON stocktake_adjustment_documents(tenant_id,series_id,year);
CREATE INDEX stocktake_adjustment_document_warehouse ON stocktake_adjustment_documents(tenant_id,warehouse_id,created_at DESC,id DESC);
CREATE INDEX stocktake_adjustment_preview_quantity ON stocktake_adjustment_previews(tenant_id,quantity_stocktake_id);
CREATE INDEX stocktake_adjustment_preview_wms ON stocktake_adjustment_previews(tenant_id,wms_stocktake_id);
CREATE INDEX stocktake_adjustment_receipt_posting ON stocktake_adjustment_receipts(tenant_id,wms_stocktake_id,posting_id);
CREATE INDEX stocktake_adjustment_receipt_operation ON stocktake_adjustment_receipts(tenant_id,operation_id);
CREATE INDEX stocktake_adjustment_source_history ON stocktake_adjustment_previews(tenant_id,source_kind,quantity_stocktake_id,wms_stocktake_id);
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['series','series_commands','counters','previews','preview_rows','admissions','receipts','documents','document_rows'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY','stocktake_adjustment_'||n);
 EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY','stocktake_adjustment_'||n);
 EXECUTE format('CREATE POLICY stocktake_adjustment_tenant ON public.%I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)','stocktake_adjustment_'||n);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,dyna_app','stocktake_adjustment_'||n);
 END LOOP;
END $$;

CREATE FUNCTION stocktake_adjustment_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public
AS $$ SELECT encode(sha256(convert_to(j::text,'UTF8')),'hex') $$;
CREATE FUNCTION stocktake_adjustment_installed() RETURNS boolean LANGUAGE sql SET search_path=pg_catalog,public AS $$ SELECT true $$;
CREATE FUNCTION stocktake_adjustment_access(uid uuid,kid uuid,writing boolean,admin_only boolean,on_source boolean,pin boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r text;k public.api_keys;rd boolean:=true;wr boolean:=true;cost boolean:=true;BEGIN
 IF pin THEN SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid) FOR SHARE;
 ELSE SELECT role INTO r FROM public.memberships WHERE(tenant_id,user_id)=(t,uid);END IF;
 IF kid IS NOT NULL THEN
 IF pin THEN SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;
 ELSE SELECT * INTO k FROM public.api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid);END IF;
 IF k.id IS NULL OR k.revoked_at IS NOT NULL OR(k.expires_at IS NOT NULL AND k.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Nieaktualny klucz API' USING ERRCODE='28000';END IF;
 rd:='inventory:read'=ANY(k.scopes);wr:=rd AND 'inventory:write'=ANY(k.scopes);cost:='purchasing:read'=ANY(k.scopes);
 IF on_source THEN wr:=wr AND cost AND 'purchasing:write'=ANY(k.scopes);END IF;
 END IF;
 rd:=coalesce(rd AND r IN('admin','operator','viewer'),false);wr:=coalesce(wr AND r='admin',false);cost:=coalesce(cost AND r='admin',false);
 IF NOT rd OR(admin_only AND r IS DISTINCT FROM 'admin') OR(writing AND NOT wr) THEN RAISE EXCEPTION 'Brak aktualnego uprawnienia spisu' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('current_role',r,'can_read',rd,'can_write',wr,'can_read_value',cost);
END $$;
CREATE FUNCTION stocktake_adjustment_lock() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('stocktake.adjustments:'||current_setting('app.tenant_id'),0));END $$;
CREATE FUNCTION stocktake_adjustment_budget() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;n numeric:=0;x numeric;rel text;BEGIN
 IF(SELECT count(*) FROM public.stocktake_adjustment_series WHERE tenant_id=t)>100
 OR(SELECT count(*) FROM public.stocktake_adjustment_previews WHERE tenant_id=t)>5000
 OR(SELECT count(*) FROM public.stocktake_adjustment_receipts WHERE tenant_id=t)>5000
 OR(SELECT count(*) FROM public.stocktake_adjustment_series_commands WHERE tenant_id=t)>5000
 THEN RAISE EXCEPTION 'Limit dowodów spisu' USING ERRCODE='54000';END IF;
 FOREACH rel IN ARRAY ARRAY['series','series_commands','counters','previews','preview_rows','admissions','receipts','documents','document_rows'] LOOP
 EXECUTE format('SELECT coalesce(sum(pg_column_size(r)),0) FROM public.%I r WHERE tenant_id=$1','stocktake_adjustment_'||rel) INTO x USING t;n:=n+x;
 END LOOP;
 IF n>134217728 THEN RAISE EXCEPTION 'Limit bajtów dowodów spisu' USING ERRCODE='54000';END IF;
END $$;
CREATE FUNCTION stocktake_adjustment_totals(rows jsonb,on_source boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('pw_quantity',coalesce(sum((r->>'quantity')::numeric) FILTER(WHERE r->>'kind'='PW'),0)::text,
 'rw_quantity',coalesce(sum((r->>'quantity')::numeric) FILTER(WHERE r->>'kind'='RW'),0)::text)
 || CASE WHEN on_source THEN jsonb_build_object('known_pw_minor',coalesce(sum((r->>'value_minor')::numeric) FILTER(WHERE r->>'kind'='PW'),0)::text,
 'known_rw_minor',coalesce(sum((r->>'value_minor')::numeric) FILTER(WHERE r->>'kind'='RW'),0)::text,
 'unknown_pw_quantity',coalesce(sum((r->>'quantity')::numeric) FILTER(WHERE r->>'kind'='PW' AND r->>'unit_cost_minor' IS NULL),0)::text,
 'unknown_rw_quantity',coalesce(sum((r->>'quantity')::numeric) FILTER(WHERE r->>'kind'='RW' AND r->>'unit_cost_minor' IS NULL),0)::text,'currency',min(r->>'currency'),'exponent',min((r->>'_exponent')::int)) ELSE '{}'::jsonb END
 FROM jsonb_array_elements(rows) r $$;

-- JSONB timestamptz values are part of the frozen proof. Canonicalize inside
-- each producer, including trusted callers whose transaction uses another zone.
CREATE FUNCTION stocktake_adjustment_source(sk text,sid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;h jsonb;wh jsonb;rs jsonb;lc integer;rv public.wms_stocktake_reviews;pol public.wms_policies;BEGIN
 IF sk='quantity' THEN
 SELECT to_jsonb(s) INTO h FROM public.stocktakes s WHERE(tenant_id,id)=(t,sid);
 IF h IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego spisu' USING ERRCODE='P0002';END IF;
 SELECT count(*) INTO lc FROM public.stocktake_lines WHERE(tenant_id,stocktake_id)=(t,sid);
 SELECT coalesce(jsonb_agg(v ORDER BY product_id,location COLLATE "C",line_id),'[]') INTO rs FROM(
 SELECT l.product_id,l.location,l.id line_id,jsonb_build_object('line_id',l.id,'product_id',l.product_id,'sku',l.sku,'name',l.name,
 'warehouse_id',h->>'warehouse_id','location',l.location,'kind',CASE WHEN l.counted>l.basis_quantity THEN 'PW' ELSE 'RW' END,
 'quantity',abs(l.counted-l.basis_quantity),'delta',l.counted-l.basis_quantity,'lot_id',NULL,'lot_code',NULL,'expiry_date',NULL,'layer_id',NULL) v
 FROM public.stocktake_lines l WHERE(l.tenant_id,l.stocktake_id)=(t,sid) AND l.counted IS NOT NULL AND l.counted<>l.basis_quantity) x;
 ELSIF sk='wms' THEN
 SELECT to_jsonb(s) INTO h FROM public.wms_stocktakes s WHERE(tenant_id,id)=(t,sid);
 IF h IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego spisu' USING ERRCODE='P0002';END IF;
 SELECT * INTO pol FROM public.wms_policies WHERE tenant_id=t;
 IF NOT coalesce(pol.enabled,false) OR pol.currency IS DISTINCT FROM h->>'currency' OR pol.version::text IS DISTINCT FROM h->>'policy_version' THEN RAISE EXCEPTION 'Polityka WMS zmieniła się' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO lc FROM public.wms_stocktake_lines WHERE(tenant_id,stocktake_id)=(t,sid);
 SELECT * INTO rv FROM public.wms_stocktake_reviews WHERE(tenant_id,stocktake_id,id)=(t,sid,(h->>'last_review_id')::uuid);
 SELECT coalesce(jsonb_agg(v ORDER BY line_id,fragment_ordinal),'[]') INTO rs FROM(
 SELECT l.id line_id,f.ordinality fragment_ordinal,jsonb_build_object('line_id',l.id,'product_id',l.product_id,'sku',l.sku,'name',l.name,
 'warehouse_id',h->>'warehouse_id','location',l.location,'kind',CASE WHEN(f.value->>'delta')::int>0 THEN 'PW' ELSE 'RW' END,
 'quantity',(f.value->>'quantity')::int,'delta',(f.value->>'delta')::int,'lot_id',l.lot_id,'lot_code',l.lot->>'lot_code','expiry_date',l.lot->>'expiry_date',
 '_exponent',pol.exponent,'layer_id',f.value->>'layer_id','unit_cost_minor',f.value->>'unit_cost_minor','currency',f.value->>'currency',
 'value_minor',CASE WHEN f.value->>'unit_cost_minor' IS NULL THEN NULL ELSE((f.value->>'quantity')::numeric*(f.value->>'unit_cost_minor')::numeric)::text END) v
 FROM public.wms_stocktake_review_rows r JOIN public.wms_stocktake_lines l ON(l.tenant_id,l.stocktake_id,l.id)=(r.tenant_id,r.stocktake_id,r.line_id)
 CROSS JOIN LATERAL jsonb_array_elements(r.fragments) WITH ORDINALITY f(value,ordinality) WHERE(r.tenant_id,r.stocktake_id,r.review_id)=(t,sid,rv.id)) x;
 ELSE RAISE EXCEPTION 'Nieprawidłowy rodzaj spisu' USING ERRCODE='23514';END IF;
 IF lc>10000 OR jsonb_array_length(rs)>10000 THEN RAISE EXCEPTION 'Za dużo pozycji spisu' USING ERRCODE='54000';END IF;
 SELECT jsonb_build_object('id',id,'name',name,'code',code,'policy',public.warehouse_inventory_policy(t,id)) INTO wh FROM public.warehouses WHERE(tenant_id,id)=(t,(h->>'warehouse_id')::uuid);
 SELECT coalesce(jsonb_agg(value||jsonb_build_object('ordinal',ordinality-1) ORDER BY ordinality),'[]') INTO rs FROM jsonb_array_elements(rs) WITH ORDINALITY;
 RETURN jsonb_build_object('source',jsonb_build_object('source_kind',sk,'stocktake_id',sid,'version',h->>'version','state',h->>'state','name',h->>'name',
 'warehouse',wh,'review_hash',CASE WHEN sk='quantity' THEN h->>'review_hash' ELSE NULL END,'review_id',rv.id,'scope_hash',rv.scope_hash,
 'line_count',lc,'row_count',jsonb_array_length(rs),'summary',public.stocktake_adjustment_totals(rs,sk='wms')||CASE WHEN sk='wms' THEN jsonb_build_object('currency',pol.currency,'exponent',pol.exponent) ELSE '{}'::jsonb END,'can_preview',h->>'state'='review'),
 'rows',rs,'head',h);
END $$;
CREATE FUNCTION stocktake_adjustment_frame(b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;sk text:=b->>'source_kind';sid uuid:=(b->>'stocktake_id')::uuid;s jsonb;se jsonb:='{}';v jsonb;k text;prior jsonb;BEGIN
 s:=public.stocktake_adjustment_source(sk,sid);
 IF s->'source'->>'state'<>'review' OR s->'source'->>'version' IS DISTINCT FROM b->>'version'
 OR(sk='quantity' AND s->'source'->>'review_hash' IS DISTINCT FROM b->>'review_hash')
 OR(sk='wms' AND(s->'source'->>'review_id',s->'source'->>'scope_hash') IS DISTINCT FROM(b->>'review_id',b->>'scope_hash'))
 THEN RAISE EXCEPTION 'Spis lub przegląd zmienił się' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['PW','RW'] LOOP
 SELECT to_jsonb(r)-'tenant_id'||jsonb_build_object('version',r.version::text) INTO v FROM public.stocktake_adjustment_series r
 WHERE(tenant_id,id,kind)=(t,(b->>(CASE WHEN k='PW' THEN 'pw_series_id' ELSE 'rw_series_id' END))::uuid,k);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'rows') r WHERE r->>'kind'=k) AND v IS NULL THEN RAISE EXCEPTION 'Wybierz własną serię każdego kierunku' USING ERRCODE='P0002';END IF;
 IF (b ? (CASE WHEN k='PW' THEN 'pw_series_id' ELSE 'rw_series_id' END)) AND v IS NULL THEN RAISE EXCEPTION 'Seria nie należy do własnego kierunku' USING ERRCODE='P0002';END IF;
 IF v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'rows') r WHERE r->>'kind'=k)
 THEN RAISE EXCEPTION 'Nie wybieraj serii dla pustego kierunku' USING ERRCODE='23514';END IF;
 se:=se||jsonb_build_object(k,v);
 END LOOP;
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO prior FROM public.stock_movements WHERE tenant_id=t
 AND((sk='quantity' AND stocktake_id=sid) OR(sk='wms' AND kind='wms_stocktake' AND note='Inwentaryzacja WMS '||sid::text));
 RETURN jsonb_build_object('source',s->'source','year',extract(year FROM clock_timestamp() AT TIME ZONE 'UTC')::int,'series',se,
 'row_count',jsonb_array_length(s->'rows'),'rows_sha256',public.stocktake_adjustment_hash(s->'rows'),'summary',s->'source'->'summary','rows',s->'rows','head',s->'head','prior_stock_movement_ids',prior);
END $$;

CREATE FUNCTION stocktake_adjustment_create_series(sid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;old public.stocktake_adjustment_series_commands;BEGIN
 PERFORM public.stocktake_adjustment_access(uid,kid,true,true,false,false);PERFORM public.stocktake_adjustment_lock();
 SELECT * INTO old FROM public.stocktake_adjustment_series_commands WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF old.id IS NOT NULL THEN IF(old.actor_id,old.api_key_id,old.request) IS DISTINCT FROM(uid,kid,b) THEN RAISE EXCEPTION 'Klucz ma inne żądanie' USING ERRCODE='23514';END IF;RETURN old.series_id;END IF;
 INSERT INTO public.stocktake_adjustment_series(id,tenant_id,kind,name,prefix) VALUES(sid,t,b->>'kind',b->>'name',b->>'prefix');
 INSERT INTO public.stocktake_adjustment_series_commands(id,tenant_id,actor_id,api_key_id,client_key,request,series_id) VALUES(gen_random_uuid(),t,uid,kid,(b->>'client_key')::uuid,b,sid);
 PERFORM public.stocktake_adjustment_budget();RETURN sid;
END $$;
CREATE FUNCTION stocktake_adjustment_preview(pid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;old public.stocktake_adjustment_previews;f jsonb;BEGIN
 PERFORM public.stocktake_adjustment_access(uid,kid,true,true,b->>'source_kind'='wms',false);PERFORM public.stocktake_adjustment_lock();
 SELECT * INTO old FROM public.stocktake_adjustment_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF old.id IS NOT NULL THEN IF(old.actor_id,old.api_key_id,old.request) IS DISTINCT FROM(uid,kid,b) THEN RAISE EXCEPTION 'Klucz ma inne żądanie' USING ERRCODE='23514';END IF;RETURN old.id;END IF;
 f:=public.stocktake_adjustment_frame(b)||jsonb_build_object('nonce',gen_random_uuid());
 INSERT INTO public.stocktake_adjustment_previews(id,tenant_id,actor_id,api_key_id,client_key,source_kind,quantity_stocktake_id,wms_stocktake_id,request,scope_hash,frame,expires_at)
 VALUES(pid,t,uid,kid,(b->>'client_key')::uuid,b->>'source_kind',CASE WHEN b->>'source_kind'='quantity' THEN(b->>'stocktake_id')::uuid END,
 CASE WHEN b->>'source_kind'='wms' THEN(b->>'stocktake_id')::uuid END,b,public.stocktake_adjustment_hash(f),f,clock_timestamp()+interval '900 seconds');
 INSERT INTO public.stocktake_adjustment_preview_rows SELECT t,pid,(r->>'ordinal')::int,r FROM jsonb_array_elements(f->'rows') r;
 PERFORM public.stocktake_adjustment_budget();RETURN pid;
END $$;
CREATE FUNCTION stocktake_adjustment_prepare(pid uuid,eid uuid,b jsonb,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;p public.stocktake_adjustment_previews;old public.stocktake_adjustment_receipts;sid uuid;f jsonb;c jsonb;BEGIN
 PERFORM public.stocktake_adjustment_lock();
 SELECT * INTO old FROM public.stocktake_adjustment_receipts WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF old.id IS NOT NULL THEN IF(old.actor_id,old.api_key_id,old.preview_id,old.request) IS DISTINCT FROM(uid,kid,pid,b) THEN RAISE EXCEPTION 'Klucz ma inne żądanie' USING ERRCODE='23514';END IF;RETURN old.id;END IF;
 SELECT * INTO p FROM public.stocktake_adjustment_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Nie znaleziono własnego podglądu' USING ERRCODE='P0002';END IF;
 PERFORM public.stocktake_adjustment_access(uid,kid,true,true,p.source_kind='wms',false);
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR p.scope_hash IS DISTINCT FROM b->>'scope_hash' OR b->'confirmed'<>'true'::jsonb THEN RAISE EXCEPTION 'Zgoda ma inny lub wygasły zakres' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.stocktake_adjustment_receipts WHERE(tenant_id,preview_id)=(t,pid)) THEN RAISE EXCEPTION 'Podgląd rozliczono inną zgodą' USING ERRCODE='23514';END IF;
 FOR sid IN SELECT id FROM public.stocktake_adjustment_series WHERE tenant_id=t AND id IN((p.request->>'pw_series_id')::uuid,(p.request->>'rw_series_id')::uuid) AND EXISTS(SELECT 1 FROM public.stocktake_adjustment_preview_rows v WHERE(v.tenant_id,v.preview_id)=(t,p.id) AND v.payload->>'kind'=stocktake_adjustment_series.kind) ORDER BY id FOR UPDATE LOOP
 INSERT INTO public.stocktake_adjustment_counters(tenant_id,series_id,year,sequence) VALUES(t,sid,(p.frame->>'year')::int,0) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.stocktake_adjustment_counters WHERE(tenant_id,series_id,year)=(t,sid,(p.frame->>'year')::int) FOR UPDATE;
 END LOOP;
 IF p.source_kind='quantity' THEN PERFORM 1 FROM public.stocktakes WHERE(tenant_id,id)=(t,p.quantity_stocktake_id) FOR UPDATE;
 ELSE PERFORM 1 FROM public.wms_stocktakes WHERE(tenant_id,id)=(t,p.wms_stocktake_id) FOR UPDATE;END IF;
 f:=public.stocktake_adjustment_frame(p.request);
 IF f IS DISTINCT FROM p.frame-'nonce' THEN RAISE EXCEPTION 'Zakres spisu lub roku zmienił się' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY series_id),'[]') INTO c FROM public.stocktake_adjustment_counters r WHERE tenant_id=t AND year=(p.frame->>'year')::int AND series_id IN((p.request->>'pw_series_id')::uuid,(p.request->>'rw_series_id')::uuid);
 INSERT INTO public.stocktake_adjustment_admissions(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request,counter_before) VALUES(eid,t,pid,uid,kid,(b->>'client_key')::uuid,b,c);
 RETURN eid;
END $$;
CREATE FUNCTION stocktake_adjustment_core_scope(eid uuid,sid uuid,uid uuid,kid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.stocktake_adjustment_admissions a JOIN public.stocktake_adjustment_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id)
 WHERE a.tenant_id=current_setting('app.tenant_id')::uuid AND(a.id,a.actor_id,a.api_key_id) IS NOT DISTINCT FROM(eid,uid,kid)
 AND a.txid=pg_current_xact_id() AND NOT a.sealed AND coalesce(p.quantity_stocktake_id,p.wms_stocktake_id)=sid) $$;

CREATE FUNCTION stocktake_adjustment_finish(eid uuid,uid uuid,kid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=current_setting('app.tenant_id')::uuid;a public.stocktake_adjustment_admissions;p public.stocktake_adjustment_previews;h jsonb;op public.wms_operations;
 post public.wms_stocktake_postings;k text;did uuid;se public.stocktake_adjustment_series;seq bigint;rr record;mid uuid;smid uuid;actual jsonb;ord integer;afterc jsonb;BEGIN
 SELECT * INTO a FROM public.stocktake_adjustment_admissions WHERE(tenant_id,id)=(t,eid);
 IF NOT public.stocktake_adjustment_core_scope(eid,coalesce((SELECT quantity_stocktake_id FROM public.stocktake_adjustment_previews WHERE(tenant_id,id)=(t,a.preview_id)),(SELECT wms_stocktake_id FROM public.stocktake_adjustment_previews WHERE(tenant_id,id)=(t,a.preview_id))),uid,kid)
 THEN RAISE EXCEPTION 'Brak dokładnej bieżącej zgody' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.stocktake_adjustment_previews WHERE(tenant_id,id)=(t,a.preview_id);
 IF p.source_kind='quantity' THEN SELECT to_jsonb(s) INTO h FROM public.stocktakes s WHERE(tenant_id,id)=(t,p.quantity_stocktake_id);
 ELSE SELECT to_jsonb(s) INTO h FROM public.wms_stocktakes s WHERE(tenant_id,id)=(t,p.wms_stocktake_id);
 SELECT * INTO post FROM public.wms_stocktake_postings WHERE(tenant_id,stocktake_id,id)=(t,p.wms_stocktake_id,(h->>'posting_id')::uuid);
 SELECT * INTO op FROM public.wms_operations WHERE(tenant_id,id)=(t,post.operation_id);
 IF op.id IS NULL OR op.kind<>'stocktake_post' OR op.warehouse_document_id IS NOT NULL OR(op.stocktake_id,op.stocktake_posting_id,op.stocktake_review_id) IS DISTINCT FROM(p.wms_stocktake_id,post.id,(p.request->>'review_id')::uuid)
 THEN RAISE EXCEPTION 'Niezgodne pochodzenie rozliczenia WMS' USING ERRCODE='23514';END IF;END IF;
 IF h->>'state'<>'posted' OR(h->>'version')::bigint<>(p.request->>'version')::bigint+1 THEN RAISE EXCEPTION 'Spis nie został dokładnie rozliczony' USING ERRCODE='23514';END IF;
 INSERT INTO public.stocktake_adjustment_receipts(id,tenant_id,preview_id,actor_id,api_key_id,client_key,request,source_kind,quantity_stocktake_id,wms_stocktake_id,posting_id,operation_id,source_version)
 VALUES(eid,t,p.id,uid,kid,a.client_key,a.request,p.source_kind,p.quantity_stocktake_id,p.wms_stocktake_id,post.id,op.id,(h->>'version')::bigint);
 FOREACH k IN ARRAY ARRAY['PW','RW'] LOOP
 IF NOT EXISTS(SELECT 1 FROM public.stocktake_adjustment_preview_rows WHERE(tenant_id,preview_id)=(t,p.id) AND payload->>'kind'=k) THEN CONTINUE;END IF;
 SELECT * INTO se FROM public.stocktake_adjustment_series WHERE(tenant_id,id)=(t,(p.frame->'series'->k->>'id')::uuid);
 SELECT sequence+1 INTO seq FROM public.stocktake_adjustment_counters WHERE(tenant_id,series_id,year)=(t,se.id,(p.frame->>'year')::int);
 IF seq IS NULL OR seq>9223372036854775806 THEN RAISE EXCEPTION 'Wyczerpano numerację' USING ERRCODE='54000';END IF;
 did:=gen_random_uuid();ord:=0;
 INSERT INTO public.stocktake_adjustment_documents(id,tenant_id,receipt_id,kind,series_id,year,sequence,number,warehouse_id,row_count,summary)
 SELECT did,t,eid,k,se.id,(p.frame->>'year')::int,seq,se.prefix||'/'||(p.frame->>'year')||'/'||CASE WHEN length(seq::text)<6 THEN lpad(seq::text,6,'0') ELSE seq::text END,(p.frame->'source'->'warehouse'->>'id')::uuid,count(*)::int,
 public.stocktake_adjustment_totals(jsonb_agg(payload ORDER BY ordinal),p.source_kind='wms') FROM public.stocktake_adjustment_preview_rows WHERE(tenant_id,preview_id)=(t,p.id) AND payload->>'kind'=k;
 FOR rr IN SELECT * FROM public.stocktake_adjustment_preview_rows WHERE(tenant_id,preview_id)=(t,p.id) AND payload->>'kind'=k ORDER BY ordinal LOOP
 mid:=NULL;smid:=NULL;actual:=rr.payload;
 IF p.source_kind='quantity' THEN
 SELECT id INTO STRICT mid FROM public.stock_location_movements WHERE tenant_id=t AND stocktake_id=p.quantity_stocktake_id AND operation_id=p.quantity_stocktake_id AND kind='stocktake'
 AND(warehouse_id,product_id,location,delta)=((actual->>'warehouse_id')::uuid,(actual->>'product_id')::uuid,actual->>'location',(actual->>'delta')::int);
 SELECT id INTO smid FROM public.stock_movements WHERE tenant_id=t AND stocktake_id=p.quantity_stocktake_id AND product_id=(actual->>'product_id')::uuid AND kind='stocktake';
 ELSE
 SELECT m.id,actual||jsonb_build_object('layer_id',m.layer_id,'lot_id',l.lot_id) INTO STRICT mid,actual FROM public.wms_layer_movements m
 JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(m.tenant_id,m.layer_id,m.product_id)
 WHERE(m.tenant_id,m.operation_id,m.warehouse_id,m.product_id,m.location,m.delta)=(t,op.id,(actual->>'warehouse_id')::uuid,(actual->>'product_id')::uuid,actual->>'location',(actual->>'delta')::int)
 AND(l.unit_cost_minor::text,l.currency) IS NOT DISTINCT FROM(actual->>'unit_cost_minor',actual->>'currency')
 AND(actual->>'layer_id' IS NULL OR m.layer_id=(actual->>'layer_id')::uuid)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(op.result->'rows') r CROSS JOIN LATERAL jsonb_array_elements(r->'fragments') f WHERE r->>'line_id'=actual->>'line_id' AND f->>'id'=m.id::text);
 SELECT id INTO smid FROM public.stock_movements WHERE tenant_id=t AND warehouse_id=(actual->>'warehouse_id')::uuid AND product_id=(actual->>'product_id')::uuid
 AND kind='wms_stocktake' AND note='Inwentaryzacja WMS '||p.wms_stocktake_id::text AND NOT(p.frame->'prior_stock_movement_ids' ? id::text);
 END IF;
 INSERT INTO public.stocktake_adjustment_document_rows VALUES(t,did,ord,p.id,rr.ordinal,actual||jsonb_build_object('ordinal',ord,'source_ordinal',rr.ordinal,'movement_id',mid,'stock_movement_id',smid),
 CASE WHEN p.source_kind='quantity' THEN mid END,CASE WHEN p.source_kind='wms' THEN mid END,smid);ord:=ord+1;
 END LOOP;
 UPDATE public.stocktake_adjustment_counters SET sequence=seq WHERE(tenant_id,series_id,year)=(t,se.id,(p.frame->>'year')::int);
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY series_id),'[]') INTO afterc FROM public.stocktake_adjustment_counters r WHERE tenant_id=t AND year=(p.frame->>'year')::int AND series_id IN((p.request->>'pw_series_id')::uuid,(p.request->>'rw_series_id')::uuid);
 UPDATE public.stocktake_adjustment_admissions SET counter_after=afterc WHERE(tenant_id,id)=(t,eid);
 PERFORM public.stocktake_adjustment_budget();RETURN eid;
END $$;

CREATE FUNCTION stocktake_adjustment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 RAISE EXCEPTION 'Dowód PW/RW jest niezmienny' USING ERRCODE='23514';END $$;
CREATE FUNCTION stocktake_adjustment_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=NEW.tenant_id;r public.stocktake_adjustment_receipts;a public.stocktake_adjustment_admissions;p public.stocktake_adjustment_previews;rs jsonb;c jsonb;BEGIN
 SELECT * INTO r FROM public.stocktake_adjustment_receipts WHERE(tenant_id,id)=(t,NEW.id);
 SELECT * INTO a FROM public.stocktake_adjustment_admissions WHERE(tenant_id,id)=(t,r.id);
 SELECT * INTO p FROM public.stocktake_adjustment_previews WHERE(tenant_id,id)=(t,r.preview_id);
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR(a.actor_id,a.api_key_id,a.client_key,a.request,a.preview_id) IS DISTINCT FROM(r.actor_id,r.api_key_id,r.client_key,r.request,r.preview_id)
 OR p.scope_hash IS DISTINCT FROM public.stocktake_adjustment_hash(p.frame) OR r.request->>'scope_hash' IS DISTINCT FROM p.scope_hash THEN RAISE EXCEPTION 'Brak pełnej zgody PW/RW' USING ERRCODE='23514';END IF;
 PERFORM public.stocktake_adjustment_access(a.actor_id,a.api_key_id,true,true,p.source_kind='wms',false);
 IF r.source_kind IS DISTINCT FROM p.source_kind OR(r.quantity_stocktake_id,r.wms_stocktake_id) IS DISTINCT FROM(p.quantity_stocktake_id,p.wms_stocktake_id)
 OR r.source_version<>(p.request->>'version')::bigint+1 OR(p.source_kind='quantity' AND NOT EXISTS(SELECT 1 FROM public.stocktakes WHERE(tenant_id,id,state,version)=(t,p.quantity_stocktake_id,'posted',r.source_version)))
 OR(p.source_kind='wms' AND NOT EXISTS(SELECT 1 FROM public.wms_stocktakes s JOIN public.wms_stocktake_postings x ON(x.tenant_id,x.stocktake_id,x.id)=(s.tenant_id,s.id,s.posting_id)
 JOIN public.wms_operations o ON(o.tenant_id,o.id)=(x.tenant_id,x.operation_id) WHERE(s.tenant_id,s.id,s.state,s.version)=(t,p.wms_stocktake_id,'posted',r.source_version)
 AND(x.id,o.id,x.review_id)=(r.posting_id,r.operation_id,(p.request->>'review_id')::uuid) AND o.kind='stocktake_post' AND o.warehouse_document_id IS NULL))
 THEN RAISE EXCEPTION 'Dokumenty nie mają rzeczywistego źródła rozliczenia' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(payload ORDER BY ordinal),'[]') INTO rs FROM public.stocktake_adjustment_preview_rows WHERE(tenant_id,preview_id)=(t,p.id);
 IF rs IS DISTINCT FROM p.frame->'rows' OR public.stocktake_adjustment_hash(rs) IS DISTINCT FROM p.frame->>'rows_sha256'
 THEN RAISE EXCEPTION 'Pełne pozycje podglądu zostały zmienione' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.stocktake_adjustment_document_rows WHERE tenant_id=t AND preview_id=p.id)<>(p.frame->>'row_count')::int
 OR(SELECT count(*) FROM public.stocktake_adjustment_documents WHERE(tenant_id,receipt_id)=(t,r.id))<>(SELECT count(DISTINCT payload->>'kind') FROM public.stocktake_adjustment_preview_rows WHERE(tenant_id,preview_id)=(t,p.id))
 THEN RAISE EXCEPTION 'Dokumenty nie pokrywają wszystkich fragmentów' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.stocktake_adjustment_document_rows d JOIN public.stocktake_adjustment_preview_rows v ON(v.tenant_id,v.preview_id,v.ordinal)=(d.tenant_id,d.preview_id,d.source_ordinal)
 LEFT JOIN public.stock_location_movements q ON(q.tenant_id,q.id)=(d.tenant_id,d.quantity_movement_id)
 LEFT JOIN public.wms_layer_movements m ON(m.tenant_id,m.id)=(d.tenant_id,d.wms_movement_id)
 LEFT JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(m.tenant_id,m.layer_id,m.product_id)
 WHERE(d.tenant_id,d.preview_id)=(t,p.id) AND(
 (d.payload-ARRAY['ordinal','source_ordinal','movement_id','stock_movement_id','layer_id','lot_id']) IS DISTINCT FROM(v.payload-ARRAY['ordinal','layer_id','lot_id'])
 OR(d.payload->>'movement_id')::uuid IS DISTINCT FROM coalesce(q.id,m.id)
 OR(p.source_kind='quantity' AND(q.stocktake_id,q.operation_id,q.warehouse_id,q.product_id,q.location,q.delta,q.kind) IS DISTINCT FROM(p.quantity_stocktake_id,p.quantity_stocktake_id,(v.payload->>'warehouse_id')::uuid,(v.payload->>'product_id')::uuid,v.payload->>'location',(v.payload->>'delta')::int,'stocktake'))
 OR(p.source_kind='quantity' AND(d.payload->>'layer_id' IS NOT NULL OR d.payload->>'lot_id' IS NOT NULL))
 OR(p.source_kind='wms' AND(m.operation_id,m.warehouse_id,m.product_id,m.location,m.delta,l.unit_cost_minor::text,l.currency) IS DISTINCT FROM(r.operation_id,(v.payload->>'warehouse_id')::uuid,(v.payload->>'product_id')::uuid,v.payload->>'location',(v.payload->>'delta')::int,v.payload->>'unit_cost_minor',v.payload->>'currency'))
 OR(p.source_kind='wms' AND(d.payload->>'layer_id',d.payload->>'lot_id') IS DISTINCT FROM(m.layer_id::text,l.lot_id::text))
 OR(d.payload->>'stock_movement_id')::uuid IS DISTINCT FROM d.stock_movement_id
 OR(v.payload->>'layer_id' IS NOT NULL AND v.payload->>'layer_id' IS DISTINCT FROM d.payload->>'layer_id')))
 THEN RAISE EXCEPTION 'Fragment dokumentu nie odpowiada rzeczywistemu journalowi' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.stocktake_adjustment_document_rows d JOIN public.stocktake_adjustment_preview_rows v ON(v.tenant_id,v.preview_id,v.ordinal)=(d.tenant_id,d.preview_id,d.source_ordinal)
 LEFT JOIN public.stock_movements m ON(m.tenant_id,m.id)=(d.tenant_id,d.stock_movement_id)
 CROSS JOIN LATERAL(SELECT coalesce(sum((x.payload->>'delta')::bigint),0) delta FROM public.stocktake_adjustment_preview_rows x WHERE(x.tenant_id,x.preview_id)=(t,p.id) AND x.payload->>'product_id'=v.payload->>'product_id') net
 WHERE(d.tenant_id,d.preview_id)=(t,p.id) AND(
 (net.delta=0 AND d.stock_movement_id IS NOT NULL) OR(net.delta<>0 AND(m.id IS NULL OR(m.warehouse_id,m.product_id,m.delta::bigint) IS DISTINCT FROM((v.payload->>'warehouse_id')::uuid,(v.payload->>'product_id')::uuid,net.delta)))
 OR(m.id IS NOT NULL AND(p.frame->'prior_stock_movement_ids' ? m.id::text))
 OR(m.id IS NOT NULL AND p.source_kind='quantity' AND(m.kind,m.stocktake_id) IS DISTINCT FROM('stocktake',p.quantity_stocktake_id))
 OR(m.id IS NOT NULL AND p.source_kind='wms' AND(m.kind,m.note) IS DISTINCT FROM('wms_stocktake','Inwentaryzacja WMS '||p.wms_stocktake_id::text))))
 THEN RAISE EXCEPTION 'Dokument nie odpowiada rzeczywistemu ruchowi netto SKU' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.stock_movements m WHERE m.tenant_id=t AND NOT(p.frame->'prior_stock_movement_ids' ? m.id::text)
 AND((p.source_kind='quantity' AND m.kind='stocktake' AND m.stocktake_id=p.quantity_stocktake_id) OR(p.source_kind='wms' AND m.kind='wms_stocktake' AND m.note='Inwentaryzacja WMS '||p.wms_stocktake_id::text)))
 <>(SELECT count(*) FROM(SELECT payload->>'product_id' FROM public.stocktake_adjustment_preview_rows WHERE(tenant_id,preview_id)=(t,p.id) GROUP BY payload->>'product_id' HAVING sum((payload->>'delta')::bigint)<>0) products)
 THEN RAISE EXCEPTION 'Journal netto SKU ma dodatkowe lub brakujące ruchy' USING ERRCODE='23514';END IF;
 IF p.source_kind='quantity' THEN
 IF(SELECT count(*) FROM public.stock_location_movements WHERE(tenant_id,stocktake_id)=(t,p.quantity_stocktake_id) AND kind='stocktake')<>(p.frame->>'row_count')::int THEN RAISE EXCEPTION 'Journal spisu ma dodatkowe fragmenty' USING ERRCODE='23514';END IF;
 ELSE IF(SELECT count(*) FROM public.wms_layer_movements WHERE(tenant_id,operation_id)=(t,r.operation_id))<>(p.frame->>'row_count')::int THEN RAISE EXCEPTION 'Journal WMS ma dodatkowe fragmenty' USING ERRCODE='23514';END IF;END IF;
 IF EXISTS(SELECT 1 FROM public.stocktake_adjustment_documents d WHERE(d.tenant_id,d.receipt_id)=(t,r.id) AND(
 d.row_count<>(SELECT count(*) FROM public.stocktake_adjustment_document_rows x WHERE(x.tenant_id,x.document_id)=(t,d.id))
 OR d.summary IS DISTINCT FROM(SELECT public.stocktake_adjustment_totals(jsonb_agg(payload ORDER BY ordinal),p.source_kind='wms') FROM public.stocktake_adjustment_document_rows x WHERE(x.tenant_id,x.document_id)=(t,d.id))
 OR d.warehouse_id IS DISTINCT FROM(p.frame->'source'->'warehouse'->>'id')::uuid
 OR d.year IS DISTINCT FROM(p.frame->>'year')::int
 OR d.series_id IS DISTINCT FROM(p.frame->'series'->d.kind->>'id')::uuid
 OR EXISTS(SELECT 1 FROM public.stocktake_adjustment_document_rows x WHERE(x.tenant_id,x.document_id)=(t,d.id) AND x.payload->>'kind' IS DISTINCT FROM d.kind)
 OR(SELECT min(ordinal)<>0 OR max(ordinal)<>count(*)-1 FROM public.stocktake_adjustment_document_rows x WHERE(x.tenant_id,x.document_id)=(t,d.id))
 OR d.number IS DISTINCT FROM(p.frame->'series'->d.kind->>'prefix')||'/'||d.year::text||'/'||(CASE WHEN length(d.sequence::text)<6 THEN lpad(d.sequence::text,6,'0') ELSE d.sequence::text END)))
 THEN RAISE EXCEPTION 'Niezgodny pełny dokument PW/RW' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY series_id),'[]') INTO c FROM public.stocktake_adjustment_counters v WHERE tenant_id=t AND year=(p.frame->>'year')::int AND series_id IN((p.request->>'pw_series_id')::uuid,(p.request->>'rw_series_id')::uuid);
 IF c IS DISTINCT FROM a.counter_after OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.counter_before) b JOIN jsonb_array_elements(a.counter_after) e ON b->>'series_id'=e->>'series_id'
 WHERE(e->>'sequence')::bigint<>(b->>'sequence')::bigint+(SELECT count(*) FROM public.stocktake_adjustment_documents WHERE(tenant_id,receipt_id,series_id)=(t,r.id,(b->>'series_id')::uuid))) THEN RAISE EXCEPTION 'Niezgodna numeracja PW/RW' USING ERRCODE='23514';END IF;
 IF NOT a.sealed THEN UPDATE public.stocktake_adjustment_admissions SET sealed=true WHERE(tenant_id,id)=(t,a.id);END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION stocktake_adjustment_counter_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='DELETE' OR EXISTS(SELECT 1 FROM public.stocktake_adjustment_admissions a CROSS JOIN LATERAL jsonb_array_elements(a.counter_after) e
 WHERE a.tenant_id=NEW.tenant_id AND a.txid=pg_current_xact_id() AND a.sealed AND(e->>'series_id')::uuid=NEW.series_id AND(e->>'year')::int=NEW.year)
 THEN RAISE EXCEPTION 'Numeracja jest zapieczętowana' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE FUNCTION stocktake_adjustment_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE v jsonb:=to_jsonb(NEW);eid uuid;a public.stocktake_adjustment_admissions;BEGIN
 IF TG_TABLE_NAME='stocktake_adjustment_receipts' THEN eid:=(v->>'id')::uuid;
 ELSIF TG_TABLE_NAME='stocktake_adjustment_documents' THEN eid:=(v->>'receipt_id')::uuid;
 ELSE SELECT receipt_id INTO eid FROM public.stocktake_adjustment_documents WHERE(tenant_id,id)=((v->>'tenant_id')::uuid,(v->>'document_id')::uuid);END IF;
 SELECT * INTO a FROM public.stocktake_adjustment_admissions WHERE(tenant_id,id)=((v->>'tenant_id')::uuid,eid);
 IF a.id IS NULL OR a.txid<>pg_current_xact_id() OR a.sealed THEN RAISE EXCEPTION 'Dokument wymaga niezapieczętowanej bieżącej zgody' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION stocktake_adjustment_admission_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Zgoda jest niezmienna' USING ERRCODE='23514';END IF;
 IF OLD.sealed OR OLD.txid<>pg_current_xact_id() OR (to_jsonb(OLD)-ARRAY['counter_after','sealed']) IS DISTINCT FROM(to_jsonb(NEW)-ARRAY['counter_after','sealed'])
 THEN RAISE EXCEPTION 'Zgoda jest zapieczętowana' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE FUNCTION stocktake_adjustment_source_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v jsonb;rs jsonb;BEGIN
 IF TG_OP='INSERT' THEN rs:=jsonb_build_array(to_jsonb(NEW));ELSIF TG_OP='DELETE' THEN rs:=jsonb_build_array(to_jsonb(OLD));ELSE rs:=jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW));END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(rs) LOOP
 IF EXISTS(SELECT 1 FROM public.stocktake_adjustment_receipts r WHERE r.tenant_id=(v->>'tenant_id')::uuid AND(
 (TG_TABLE_NAME='stocktakes' AND r.quantity_stocktake_id=(v->>'id')::uuid)
 OR(TG_TABLE_NAME IN('stocktake_lines','stock_location_movements','stock_movements') AND r.quantity_stocktake_id=(v->>'stocktake_id')::uuid)
 OR(TG_TABLE_NAME='stock_location_movements' AND r.operation_id=(v->>'operation_id')::uuid)
 OR(TG_TABLE_NAME='stock_movements' AND r.wms_stocktake_id IS NOT NULL AND v->>'kind'='wms_stocktake' AND v->>'note'='Inwentaryzacja WMS '||r.wms_stocktake_id::text)
 OR(TG_TABLE_NAME='wms_stocktakes' AND r.wms_stocktake_id=(v->>'id')::uuid)
 OR(TG_TABLE_NAME='wms_stocktake_lines' AND r.wms_stocktake_id=(v->>'stocktake_id')::uuid)
 OR(TG_TABLE_NAME='wms_stocktake_postings' AND r.posting_id=(v->>'id')::uuid)
 OR(TG_TABLE_NAME='wms_operations' AND r.operation_id=(v->>'id')::uuid)
 OR(TG_TABLE_NAME='wms_layer_movements' AND r.operation_id=(v->>'operation_id')::uuid)))
 THEN RAISE EXCEPTION 'Źródło dokumentu PW/RW jest zapieczętowane' USING ERRCODE='23514';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER stocktake_adjustment_complete AFTER INSERT ON stocktake_adjustment_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stocktake_adjustment_complete();
CREATE CONSTRAINT TRIGGER stocktake_adjustment_admission_complete AFTER INSERT ON stocktake_adjustment_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stocktake_adjustment_complete();
CREATE TRIGGER stocktake_adjustment_counter_guard BEFORE UPDATE OR DELETE ON stocktake_adjustment_counters FOR EACH ROW EXECUTE FUNCTION stocktake_adjustment_counter_guard();
CREATE TRIGGER stocktake_adjustment_admission_guard BEFORE UPDATE OR DELETE ON stocktake_adjustment_admissions FOR EACH ROW EXECUTE FUNCTION stocktake_adjustment_admission_guard();
DO $$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['series','series_commands','previews','preview_rows','receipts','documents','document_rows'] LOOP
 EXECUTE format('CREATE TRIGGER stocktake_adjustment_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stocktake_adjustment_immutable()','stocktake_adjustment_'||n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['receipts','documents','document_rows'] LOOP
 EXECUTE format('CREATE TRIGGER stocktake_adjustment_insert_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stocktake_adjustment_insert_guard()','stocktake_adjustment_'||n);END LOOP;
 FOREACH n IN ARRAY ARRAY['stocktakes','stocktake_lines','stock_location_movements','stock_movements','wms_stocktakes','wms_stocktake_lines','wms_stocktake_postings','wms_operations','wms_layer_movements'] LOOP
 EXECUTE format('CREATE TRIGGER stocktake_adjustment_source_seal BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.stocktake_adjustment_source_seal()',n);END LOOP;
END $$;

CREATE FUNCTION stocktake_adjustment_metadata() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
SELECT jsonb_build_object(
 'tables',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum) WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'definition',pg_get_constraintdef(x.oid,true),'validated',x.convalidated) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('name',i.relname,'definition',pg_get_indexdef(x.indexrelid),'valid',x.indisvalid,'ready',x.indisready) ORDER BY i.relname) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
  'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles::text,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.relname),'[]')
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY['stocktake_adjustment_series','stocktake_adjustment_series_commands','stocktake_adjustment_counters','stocktake_adjustment_previews','stocktake_adjustment_preview_rows','stocktake_adjustment_admissions','stocktake_adjustment_receipts','stocktake_adjustment_documents','stocktake_adjustment_document_rows'])),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'config',p.proconfig,'body',public.stocktake_adjustment_hash(to_jsonb(p.prosrc))) ORDER BY p.oid::regprocedure::text),'[]') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'stocktake_adjustment_%' AND p.proname<>'stocktake_adjustment_manifest'),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'function',t.tgfoid::regprocedure::text,'type',t.tgtype,'enabled',t.tgenabled,'deferred',t.tgdeferrable,'initially_deferred',t.tginitdeferred) ORDER BY c.relname,t.tgname),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgname LIKE 'stocktake_adjustment_%'),
 'journal_keys',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',x.conname,'definition',pg_get_constraintdef(x.oid,true),'validated',x.convalidated) ORDER BY x.conname) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid WHERE x.conname IN('stocktake_adjustment_stock_identity','stocktake_adjustment_location_identity')))
$$;
CREATE FUNCTION stocktake_adjustment_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n text;rel regclass;ownerid oid;BEGIN
 IF to_regprocedure('public.warehouse_inventory_policy_guards()') IS NULL OR to_regprocedure('public.warehouse_inventory_policy(uuid,uuid)') IS NULL
 OR to_regprocedure('public.warehouse_inventory_policy_lock(uuid,uuid)') IS NULL THEN RETURN false;END IF;
 IF NOT public.warehouse_inventory_policy_guards() THEN RETURN false;END IF;
 FOREACH n IN ARRAY ARRAY['series','series_commands','counters','previews','preview_rows','admissions','receipts','documents','document_rows'] LOOP
 rel:=to_regclass('public.stocktake_adjustment_'||n);IF rel IS NULL THEN RETURN false;END IF;
 SELECT relowner INTO ownerid FROM pg_class WHERE oid=rel;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=rel AND relrowsecurity AND relforcerowsecurity AND relkind='r')
 OR(SELECT count(*) FROM pg_policy WHERE polrelid=rel)<>1
 OR NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=rel AND polname='stocktake_adjustment_tenant' AND polcmd='*')
 OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=rel AND(x.grantee<>ownerid OR x.is_grantable))
 OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=rel AND(x.grantee<>ownerid OR x.is_grantable))
 OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=rel AND attname='tenant_id' AND attnotnull AND NOT attisdropped)
 OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=rel AND NOT convalidated) THEN RETURN false;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stocktake_adjustment_receipts'::regclass AND tgname='stocktake_adjustment_complete' AND tgfoid='public.stocktake_adjustment_complete()'::regprocedure AND tgtype=5 AND tgdeferrable AND tginitdeferred AND tgenabled='O')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stocktake_adjustment_counters'::regclass AND tgname='stocktake_adjustment_counter_guard' AND tgtype=27 AND tgenabled='O') THEN RETURN false;END IF;
 FOREACH n IN ARRAY ARRAY['series','series_commands','previews','preview_rows','receipts','documents','document_rows'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.stocktake_adjustment_'||n) AND tgname='stocktake_adjustment_immutable' AND tgfoid='public.stocktake_adjustment_immutable()'::regprocedure AND tgtype=27 AND tgenabled='O') THEN RETURN false;END IF;END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'stocktake_adjustment_%' AND(x.grantee<>p.proowner OR x.is_grantable)) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'stocktake_adjustment_%' AND p.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.stocktake_adjustment_series'::regclass)) THEN RETURN false;END IF;
 IF public.stocktake_adjustment_metadata() IS DISTINCT FROM public.stocktake_adjustment_manifest() THEN RETURN false;END IF;
 RETURN true;
END $$;
-- A portable, exact identity manifest is sealed by the migration, rather than
-- accepting an arbitrary FK/function count. OIDs are deliberately not archived.
DO $$ DECLARE expected jsonb;BEGIN
 expected:=public.stocktake_adjustment_metadata();
 EXECUTE format('CREATE FUNCTION public.stocktake_adjustment_manifest() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS %L', 'SELECT '||quote_literal(expected::text)||'::jsonb');
END $$;
DO $$ DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'stocktake_adjustment_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',p.signature);END LOOP;END $$;
