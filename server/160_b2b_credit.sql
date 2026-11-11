-- SOURCE_ONLY160 / NOT_APPLIED / NOT_RUN. Execute only inside owned native migration BEGIN.
-- Original157/158 manifests and159 certificate remain literal. Both014 document indexes are untouched.
-- Durable certificate JSON uses one timezone across migration and later callers.
SET LOCAL TimeZone='UTC';
DO $$BEGIN
 IF current_user<>session_user OR current_setting('session_replication_role')<>'origin'
 OR NOT public.local_invoice_guards() OR NOT public.fa3_draft_guards() OR NOT public.b2b_invoice_guards()
 OR NOT public.catalog_stock_return_guards() THEN RAISE EXCEPTION 'Brak dokładnego poprzednika160' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b\_credit\_%' ESCAPE '\')
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b\_credit\_%' ESCAPE '\') THEN RAISE EXCEPTION 'Pozostałości160' USING ERRCODE='55000';END IF;
END$$;
CREATE TEMP TABLE b2b_credit_migration_basis ON COMMIT DROP AS SELECT pg_current_xact_id() root_xid,transaction_timestamp() transaction_started_at,pg_backend_pid() backend_pid,session_user::text migration_owner,
 (SELECT to_jsonb(m) FROM public.local_invoice_manifest m WHERE id) original157,
 (SELECT to_jsonb(m) FROM public.fa3_draft_manifest m WHERE id) original158,
 (SELECT to_jsonb(m) FROM public.b2b_invoice_upgrade m WHERE id) original159,
 public.local_invoice_fingerprint() predecessor157,public.fa3_draft_fingerprint() predecessor158,public.b2b_invoice_fingerprint() predecessor159,
 (SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ax.grantor),CASE WHEN ax.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ax.grantee) END,ax.privilege_type,ax.is_grantable) ORDER BY CASE WHEN ax.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ax.grantee)::text END,ax.privilege_type,pg_get_userbyid(ax.grantor)::text,ax.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))ax),'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'retset',p.proretset,'return_type',format_type(p.prorettype,NULL),'identity_args',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),'argmodes',p.proargmodes,'argnames',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0),'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),'security_definer',p.prosecdef,'config',p.proconfig)) FROM pg_proc p WHERE p.oid IN('public.b2b_invoice_upgrade_valid()'::regprocedure,'public.fa3_draft_invoice_seal()'::regprocedure)) replaced_functions,
 (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indexrelid IN('public.document_order_mode'::regclass,'public.document_return_mode'::regclass)) original014_indexes;
CREATE TABLE b2b_credit_upgrade(
 id boolean PRIMARY KEY CHECK(id),profile text NOT NULL CHECK(profile='157-158-159-original-to160-return-credit/v1'),
 original157 jsonb NOT NULL,original158 jsonb NOT NULL,original159 jsonb NOT NULL,
 predecessor157 text NOT NULL,predecessor158 text NOT NULL,predecessor159 text NOT NULL,
 replaced_functions jsonb NOT NULL,original014_indexes jsonb NOT NULL,
 successor157 text NOT NULL,successor158 text NOT NULL,successor159 text NOT NULL,successor160 text NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE b2b_credit_previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants,
 original_document_id uuid NOT NULL,original_receipt_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,return_receipt_id uuid NOT NULL,
 series_id uuid NOT NULL,receipt_sequence integer NOT NULL CHECK(receipt_sequence>0),previous_receipt_id uuid,
 actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,client_key uuid NOT NULL,
 request jsonb NOT NULL,request_hash text NOT NULL,source jsonb NOT NULL,input jsonb NOT NULL,snapshot jsonb NOT NULL,scope_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,original_document_id) REFERENCES public.documents(tenant_id,id),
 FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES public.b2b_invoice_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES public.return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,return_receipt_id) REFERENCES public.catalog_stock_return_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES public.local_invoice_series(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$'),
 CHECK(octet_length(source::text)+octet_length(input::text)<=33554432 AND octet_length(snapshot::text)<=2097152)
);
CREATE TABLE b2b_credit_admissions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,
 original_document_id uuid NOT NULL,return_id uuid NOT NULL,return_receipt_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,
 year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 999999),number text NOT NULL,
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),backend_pid integer NOT NULL DEFAULT pg_backend_pid(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,return_receipt_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.documents(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.b2b_credit_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,original_document_id) REFERENCES public.documents(tenant_id,id),
 FOREIGN KEY(tenant_id,return_id) REFERENCES public.return_cases(tenant_id,id),
 FOREIGN KEY(tenant_id,return_receipt_id) REFERENCES public.catalog_stock_return_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id)
);
CREATE TABLE b2b_credit_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,
 original_document_id uuid NOT NULL,original_receipt_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,return_receipt_id uuid NOT NULL,
 series_id uuid NOT NULL,receipt_sequence integer NOT NULL CHECK(receipt_sequence>0),previous_receipt_id uuid,
 actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,
 snapshot jsonb NOT NULL,calculation_hash text NOT NULL,scope_hash text NOT NULL,
 year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 999999),number text NOT NULL,
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),backend_pid integer NOT NULL DEFAULT pg_backend_pid(),issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,return_receipt_id),
 UNIQUE(tenant_id,original_document_id,receipt_sequence),UNIQUE(tenant_id,number),UNIQUE(tenant_id,series_id,year,sequence),
 FOREIGN KEY(tenant_id,id) REFERENCES public.b2b_credit_admissions(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.documents(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES public.b2b_credit_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,original_document_id) REFERENCES public.documents(tenant_id,id),FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES public.b2b_invoice_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES public.return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,return_receipt_id) REFERENCES public.catalog_stock_return_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,series_id) REFERENCES public.local_invoice_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 FOREIGN KEY(tenant_id,previous_receipt_id) REFERENCES public.b2b_credit_receipts(tenant_id,id),CHECK(octet_length(snapshot::text)<=2097152)
);
ALTER TABLE b2b_credit_previews ADD FOREIGN KEY(tenant_id,previous_receipt_id) REFERENCES b2b_credit_receipts(tenant_id,id);
ALTER TABLE b2b_credit_admissions ADD FOREIGN KEY(tenant_id,id) REFERENCES b2b_credit_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE b2b_credit_counters(tenant_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL CHECK(year BETWEEN 2006 AND 2050),last_number integer NOT NULL CHECK(last_number BETWEEN 0 AND 999999),PRIMARY KEY(tenant_id,series_id,year),FOREIGN KEY(tenant_id,series_id) REFERENCES public.local_invoice_series(tenant_id,id));
CREATE TABLE b2b_credit_namespaces(seller_tax_id text NOT NULL CHECK(seller_tax_id~'^[0-9]{10}$'),prefix text NOT NULL CHECK(prefix~'^[A-Z0-9][A-Z0-9-]{0,11}$'),tenant_id uuid NOT NULL REFERENCES public.tenants,series_id uuid NOT NULL,claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(seller_tax_id,prefix),UNIQUE(tenant_id,series_id),FOREIGN KEY(tenant_id,series_id) REFERENCES public.local_invoice_series(tenant_id,id));
CREATE INDEX b2b_credit_preview_page ON b2b_credit_previews(tenant_id,created_at DESC,id DESC);
CREATE INDEX b2b_credit_receipt_page ON b2b_credit_receipts(tenant_id,issued_at DESC,document_id DESC);
CREATE INDEX b2b_credit_receipt_chain ON b2b_credit_receipts(tenant_id,original_document_id,receipt_sequence);
CREATE INDEX b2b_credit_admission_root ON b2b_credit_admissions(tenant_id,root_xid,transaction_started_at);
ALTER TABLE public.documents ADD CONSTRAINT documents_b2b_credit CHECK(mode<>'b2b_correction' OR(kind='correction' AND channel_id IS NULL AND external_id IS NULL AND return_id IS NOT NULL));
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['upgrade','previews','admissions','receipts','counters','namespaces'] LOOP
 EXECUTE format('ALTER TABLE b2b_credit_%I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE b2b_credit_%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY owner ON b2b_credit_%I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);EXECUTE format('REVOKE ALL ON b2b_credit_%I FROM PUBLIC,dyna_app',tab);
END LOOP;END$$;
CREATE FUNCTION b2b_credit_installed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM migrations WHERE name='160_b2b_credit')$$;
CREATE FUNCTION b2b_credit_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Niezmienny native credit160' USING ERRCODE='23514';END$$;
CREATE FUNCTION b2b_credit_require(uid uuid,kid uuid,h text,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NOT b2b_credit_guards() OR NOT b2b_invoice_guards() OR NOT fa3_draft_guards() OR NOT local_invoice_guards() OR NOT catalog_stock_return_guards() THEN RAISE EXCEPTION 'Niepełny profil korekty160' USING ERRCODE='55000';END IF;
 PERFORM local_invoice_identity(uid,kid,h,writing,pin);
END$$;

CREATE FUNCTION b2b_credit_history(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_return_admissions;r public.catalog_stock_return_receipts;rc public.return_cases;op public.wms_operations;
 item jsonb;expected jsonb;return_document_head record;n jsonb;actual jsonb;wanted jsonb;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_return_receipts WHERE(tenant_id,id)=(a.tenant_id,a.id);
 IF a.id IS NULL OR r.id IS NULL OR NOT a.sealed OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR(a.txid=pg_current_xact_id() AND r.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Brak pełnej zgody dokumentu zwrotu' USING ERRCODE='23514';END IF;
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 IF a.protocol NOT IN('rma','legacy_status') OR r.assistant_receipt_id IS NOT NULL OR r.exchange_id IS NOT NULL OR r.dropship_admission_id IS NOT NULL OR r.local_proof_id IS NOT NULL OR r.parcel_receipt_return_id IS NOT NULL
 OR r.snapshot#>>'{return_case,state}'<>'refund_pending' OR r.snapshot#>>'{return_case,remedy}'<>'refund' OR rc.state NOT IN('refund_pending','closed')
 OR rc.version<(r.snapshot#>>'{return_case,version}')::bigint
 OR to_jsonb(rc)-ARRAY['state','version','updated_at','refunded_at','settlement'] IS DISTINCT FROM(r.snapshot->'return_case')-ARRAY['state','version','updated_at','refunded_at','settlement'] THEN RAISE EXCEPTION 'Nieobsługiwany lub zmieniony historical receipt169' USING ERRCODE='23514';END IF;
 -- Only immutable received birth is used for original request version checks.
 rc:=jsonb_populate_record(NULL::public.return_cases,r.snapshot->'return_case');
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
 IF r.wms_operation_id IS NOT NULL THEN
  SELECT * INTO op FROM public.wms_operations WHERE(tenant_id,id)=(a.tenant_id,r.wms_operation_id);
  IF op.id IS NULL OR op.kind<>'return' OR(op.order_id,op.return_id) IS DISTINCT FROM(a.order_id,a.return_id)
    OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL OR op.request IS DISTINCT FROM a.frame->'request' THEN RAISE EXCEPTION 'Obca operacja WMS zwrotu' USING ERRCODE='23514';END IF;
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
 IF false THEN
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

CREATE FUNCTION b2b_credit_money(g numeric,rate integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE v numeric;BEGIN
 IF g<0 OR g>9223372036854775807 OR g<>trunc(g) OR rate NOT IN(0,5,8,23) THEN RAISE EXCEPTION 'Kwota/stawka poza zakresem160' USING ERRCODE='22023';END IF;
 v:=floor((2*g*rate+100+rate)/(2*(100+rate)));RETURN jsonb_build_object('gross_minor',g::bigint::text,'net_minor',(g-v)::bigint::text,'vat_minor',v::bigint::text);
END$$;
CREATE FUNCTION b2b_credit_sum(xs jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT jsonb_build_object('gross_minor',coalesce(sum((x->>'gross_minor')::numeric),0)::bigint::text,'net_minor',coalesce(sum((x->>'net_minor')::numeric),0)::bigint::text,'vat_minor',coalesce(sum((x->>'vat_minor')::numeric),0)::bigint::text) FROM jsonb_array_elements(xs)x$$;
CREATE FUNCTION b2b_credit_minus(a jsonb,b jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT jsonb_build_object('gross_minor',((a->>'gross_minor')::numeric-(b->>'gross_minor')::numeric)::bigint::text,'net_minor',((a->>'net_minor')::numeric-(b->>'net_minor')::numeric)::bigint::text,'vat_minor',((a->>'vat_minor')::numeric-(b->>'vat_minor')::numeric)::bigint::text)$$;
CREATE FUNCTION b2b_credit_calculate(x jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE original jsonb:=x->'original';fiscal jsonb:=x#>'{original,document,data,fiscal_snapshot}';accepted jsonb:='{}';prior jsonb;shipping numeric:=0;prior_shipping numeric;refund numeric;units numeric;
 a jsonb;it jsonb;ln jsonb;pc jsonb;rowsj jsonb;rowj jsonb;calc jsonb;resultj jsonb;beforej jsonb;afterj jsonb;vatj jsonb;vatcode text;
 idx integer:=0;selected integer:=jsonb_array_length(x->'previous_credits');q numeric;n numeric;oldq numeric;g numeric;bq numeric;aq numeric;pg numeric;ng numeric;rate integer;bm jsonb;am jsonb;chain text;ids uuid[]:='{}';BEGIN
 IF jsonb_array_length(x->'acceptances') NOT BETWEEN 1 AND 1000 OR selected>=jsonb_array_length(x->'acceptances')
 OR x#>>'{acceptances}' IS NULL OR x#>>'{acceptance_manifest,count}' IS DISTINCT FROM jsonb_array_length(x->'acceptances')::text
 OR x#>>'{acceptance_manifest,financial_history_hash}' IS DISTINCT FROM fa3_draft_hash(x->'acceptances')
 OR x->>'selected_return_id' IS DISTINCT FROM(x->'acceptances'->selected->>'return_id') THEN RAISE EXCEPTION 'Niepełna chronologia korekt160' USING ERRCODE='23514';END IF;
 chain:=fa3_draft_hash(jsonb_build_object('original_document_id',original#>'{document,id}','original_receipt_id',original#>'{receipt,id}'));
 FOR a IN SELECT value FROM jsonb_array_elements(x->'acceptances') LOOP
  idx:=idx+1;IF(a->>'receipt_sequence')::integer<>idx OR(a->>'return_id')::uuid=ANY(ids) OR a#>>'{native_proof,financial_hash}' IS DISTINCT FROM fa3_draft_hash(a-'native_proof')
  OR a->>'tenant_id' IS DISTINCT FROM fiscal#>>'{source,tenant_id}' OR a->>'order_id' IS DISTINCT FROM original#>>'{document,order_id}'
  OR(a->>'received_at')::date<(original#>>'{document,data,issue_date}')::date THEN RAISE EXCEPTION 'Obcy/lukowy accepted receipt160' USING ERRCODE='23514';END IF;ids:=ids||(a->>'return_id')::uuid;
  prior:=accepted;prior_shipping:=shipping;refund:=0;units:=0;
  IF(SELECT count(*) FROM jsonb_array_elements(a->'items'))<>(SELECT count(DISTINCT value->>'item_id') FROM jsonb_array_elements(a->'items')) THEN RAISE EXCEPTION 'Powtórzona pozycja przyjęcia' USING ERRCODE='23514';END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(a->'items') LOOP
   SELECT value INTO ln FROM jsonb_array_elements(fiscal->'lines') WHERE value->>'source_item_id'=it->>'item_id' AND value->>'kind'='item';
   IF ln IS NULL THEN RAISE EXCEPTION 'Obca pozycja przyjęcia' USING ERRCODE='23514';END IF;
   q:=(ln->>'quantity')::numeric;n:=(it->>'accepted')::numeric;oldq:=coalesce((accepted->>(it->>'item_id'))::numeric,0);g:=(ln->>'gross_minor')::numeric;
   IF n<0 OR n<>trunc(n) OR n>100000 OR(it->>'restocked')::numeric>n OR oldq+n>q OR(it->>'refund_amount_minor')::numeric<>floor(g*(oldq+n)/q)-floor(g*oldq/q) THEN RAISE EXCEPTION 'Niezgodna pełna alokacja refund160' USING ERRCODE='23514';END IF;
   accepted:=accepted||jsonb_build_object(it->>'item_id',(oldq+n)::bigint::text);refund:=refund+(it->>'refund_amount_minor')::numeric;units:=units+n;
  END LOOP;
  shipping:=shipping+(a->>'refunded_shipping_minor')::numeric;refund:=refund+(a->>'refunded_shipping_minor')::numeric;
  IF units<=0 OR shipping>(fiscal#>>'{source,shipping_gross_minor}')::numeric OR refund<>(a->>'refund_amount_minor')::numeric THEN RAISE EXCEPTION 'Niepełna kwota/refundshipping160' USING ERRCODE='23514';END IF;
  IF idx>selected+1 THEN CONTINUE;END IF;
  rowsj:='[]';FOR ln IN SELECT value FROM jsonb_array_elements(fiscal->'lines') LOOP
   q:=(ln->>'quantity')::numeric;g:=(ln->>'gross_minor')::numeric;rate:=CASE WHEN ln->>'vat_code'='0 KR' THEN 0 ELSE(ln->>'vat_code')::integer END;
   IF ln->>'kind'='shipping' THEN oldq:=prior_shipping;n:=shipping;pg:=g-oldq;ng:=g-n;bq:=1;aq:=1;
   ELSE oldq:=coalesce((prior->>(ln->>'source_item_id'))::numeric,0);n:=coalesce((accepted->>(ln->>'source_item_id'))::numeric,0);pg:=g-floor(g*oldq/q);ng:=g-floor(g*n/q);bq:=q-oldq;aq:=q-n;END IF;
   bm:=b2b_credit_money(pg,rate);am:=b2b_credit_money(ng,rate);
   rowj:=jsonb_build_object('ordinal',ln->'ordinal','line_id',ln->'line_id','source_item_id',ln->'source_item_id','kind',ln->'kind','name',ln->'name','unit',ln->'unit','vat_code',ln->'vat_code','zero_domestic_basis',ln->'zero_domestic_basis','affected',oldq<>n,
    'before',bm||jsonb_build_object('quantity',bq::bigint::text),'after',am||jsonb_build_object('quantity',aq::bigint::text),'delta',b2b_credit_minus(am,bm)||jsonb_build_object('quantity',(aq-bq)::bigint::text));rowsj:=rowsj||jsonb_build_array(rowj);
  END LOOP;
  SELECT b2b_credit_sum(jsonb_agg(v->'before')),b2b_credit_sum(jsonb_agg(v->'after')) INTO beforej,afterj FROM jsonb_array_elements(rowsj)v;
  vatj:='[]';FOR vatcode IN SELECT DISTINCT value->>'vat_code' FROM jsonb_array_elements(rowsj) ORDER BY 1 LOOP
   SELECT b2b_credit_sum(jsonb_agg(z->'before')),b2b_credit_sum(jsonb_agg(z->'after')) INTO bm,am FROM jsonb_array_elements(rowsj)z WHERE z->>'vat_code'=vatcode;
   vatj:=vatj||jsonb_build_array(jsonb_build_object('vat_code',vatcode,'before',bm,'after',am,'delta',b2b_credit_minus(am,bm)));
  END LOOP;
  -- Array VAT order is numeric0/5/8/23, identical to the independent pure module.
  SELECT coalesce(jsonb_agg(z ORDER BY CASE WHEN z->>'vat_code'='0 KR' THEN 0 ELSE(z->>'vat_code')::integer END),'[]') INTO vatj FROM jsonb_array_elements(vatj)z;
  calc:=jsonb_build_object('schema','b2b-invoice-correction-calculation/v1','state','unnumbered_calculation','currency','PLN','tax_method','gross_line_half_up','shipping_credit_scope',x->'shipping_credit_scope',
   'original',jsonb_build_object('document_id',original#>'{document,id}','receipt_id',original#>'{receipt,id}','number',original#>'{document,number}','scope_hash',original#>'{document,data,scope_hash}','fiscal_snapshot_hash',original#>'{document,data,project_hash}','issued_basis_hash',fa3_draft_hash(original)),
   'acceptance',jsonb_build_object('return_id',a->'return_id','number',a->'number','receipt_sequence',a->'receipt_sequence','receipt_id',a#>'{native_proof,receipt_id}','admission_id',a#>'{native_proof,admission_id}','receipt_snapshot_hash',a#>'{native_proof,receipt_snapshot_hash}','financial_hash',a#>'{native_proof,financial_hash}','received_at',a->'received_at'),
   'fiscal_snapshot',fiscal,'previous_chain_hash',chain,'rows',rowsj,'totals',jsonb_build_object('before',beforej,'after',afterj,'delta',b2b_credit_minus(afterj,beforej)),'vat_buckets',vatj);
  IF(calc#>>'{totals,delta,gross_minor}')::numeric<>-refund THEN RAISE EXCEPTION 'Korekta nie obejmuje pełnego przyjęcia160' USING ERRCODE='23514';END IF;
  IF idx<=selected THEN pc:=x->'previous_credits'->(idx-1);
   IF pc->'calculation' IS DISTINCT FROM calc OR pc->>'calculation_hash' IS DISTINCT FROM fa3_draft_hash(calc)
    OR pc->'return_id' IS DISTINCT FROM a->'return_id' OR pc->'return_receipt_id' IS DISTINCT FROM a#>'{native_proof,receipt_id}'
    OR pc->'original_document_id' IS DISTINCT FROM original#>'{document,id}' OR pc->'original_receipt_id' IS DISTINCT FROM original#>'{receipt,id}' THEN RAISE EXCEPTION 'Niepełny typed previous credit160' USING ERRCODE='23514';END IF;
   chain:=fa3_draft_hash(jsonb_build_object('previous_chain_hash',chain,'credit',pc));ELSE resultj:=calc;END IF;
 END LOOP;RETURN resultj;
END$$;
CREATE FUNCTION b2b_credit_locks(did uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d documents%ROWTYPE;BEGIN
 SELECT * INTO d FROM documents WHERE(tenant_id,id)=(t,did) AND kind='invoice' AND mode='b2b_invoice';IF d.id IS NULL THEN RAISE EXCEPTION 'Brak własnego oryginału159' USING ERRCODE='P0002';END IF;
 IF d.data#>>'{fiscal_snapshot,source,buyer_basis,kind}'<>'ordinary_explicit' THEN RAISE EXCEPTION 'Korekty supplier/B2B partner wymagają osobnej authority' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b2b-credit-namespace:'||(d.data#>>'{fiscal_snapshot,seller,tax_id}')||':'||(d.data#>>'{series_definition,prefix}'),0));
 PERFORM local_invoice_locks();PERFORM pg_advisory_xact_lock(hashtextextended('b2b-credit-original:'||t||':'||did,0));
 PERFORM id FROM orders WHERE(tenant_id,id)=(t,d.order_id) FOR UPDATE;
 PERFORM id FROM return_cases WHERE(tenant_id,order_id)=(t,d.order_id) ORDER BY receipt_sequence,id FOR SHARE;
 IF EXISTS(SELECT FROM b2b_credit_namespaces ns WHERE(ns.seller_tax_id,ns.prefix)=(d.data#>>'{fiscal_snapshot,seller,tax_id}',d.data#>>'{series_definition,prefix}') AND(ns.tenant_id,ns.series_id) IS DISTINCT FROM(t,(d.data->>'series_id')::uuid)) THEN RAISE EXCEPTION 'Namespace KOR-B2B już należy do innej serii/workspace' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION b2b_credit_basis(did uuid,selected_return uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d documents%ROWTYPE;ir b2b_invoice_receipts%ROWTYPE;p b2b_invoice_previews%ROWTYPE;ad b2b_invoice_admissions%ROWTYPE;
 project fa3_draft_projects%ROWTYPE;projectreceipt fa3_draft_receipts%ROWTYPE;projectpreview fa3_draft_previews%ROWTYPE;s local_invoice_series%ROWTYPE;cmd local_invoice_series_commands%ROWTYPE;
 rr record;cr record;financial jsonb;acceptances jsonb:='[]';history jsonb:='[]';previousj jsonb:='[]';creditsj jsonb:='[]';original jsonb;inputj jsonb;prev uuid:=NULL;seq integer:=0;raw jsonb;BEGIN
 SELECT * INTO d FROM documents WHERE(tenant_id,id)=(t,did) AND kind='invoice' AND mode='b2b_invoice';
 SELECT * INTO ir FROM b2b_invoice_receipts WHERE(tenant_id,document_id)=(t,did);SELECT * INTO p FROM b2b_invoice_previews WHERE(tenant_id,id)=(t,ir.preview_id);
 SELECT * INTO ad FROM b2b_invoice_admissions WHERE(tenant_id,id)=(t,ir.id);SELECT * INTO project FROM fa3_draft_projects WHERE(tenant_id,id)=(t,ir.project_id);
 SELECT * INTO projectreceipt FROM fa3_draft_receipts WHERE(tenant_id,id)=(t,ir.project_receipt_id);SELECT * INTO projectpreview FROM fa3_draft_previews WHERE(tenant_id,id)=(t,project.preview_id);
 SELECT * INTO s FROM local_invoice_series WHERE(tenant_id,id)=(t,ir.series_id);SELECT * INTO cmd FROM local_invoice_series_commands WHERE(tenant_id,series_id)=(t,ir.series_id);
 IF d.id IS NULL OR ir.id IS NULL OR p.id IS NULL OR ad.id IS NULL OR project.id IS NULL OR projectreceipt.id IS NULL OR projectpreview.id IS NULL OR s.id IS NULL OR cmd.id IS NULL
 OR(ir.root_xid=pg_current_xact_id() AND ir.transaction_started_at=transaction_timestamp()) OR d.data IS DISTINCT FROM ir.snapshot
 OR p.snapshot IS DISTINCT FROM d.data-ARRAY['number','year','sequence','preview_id','scope_hash']
 OR project.draft IS DISTINCT FROM d.data->'fiscal_snapshot' OR projectpreview.draft IS DISTINCT FROM project.draft OR project.draft_hash IS DISTINCT FROM d.data->>'project_hash'

 OR(d.kind,d.mode,d.order_id,d.number,d.channel_id,d.external_id,d.return_id) IS DISTINCT FROM('invoice'::text,'b2b_invoice'::text,ir.order_id,ir.number,NULL::uuid,NULL::text,NULL::uuid)
 OR(ad.id,ad.document_id,ad.preview_id,ad.project_id,ad.actor_id,ad.api_key_id,ad.client_key,ad.request_hash,ad.request,ad.root_xid,ad.transaction_started_at,ad.number,ad.year,ad.sequence)
 IS DISTINCT FROM(ir.id,ir.document_id,ir.preview_id,ir.project_id,ir.actor_id,ir.api_key_id,ir.client_key,ir.request_hash,ir.request,ir.root_xid,ir.transaction_started_at,ir.number,ir.year,ir.sequence)
 OR(ir.project_receipt_id,ir.order_id,ir.series_id,ir.scope_hash) IS DISTINCT FROM(p.project_receipt_id,p.order_id,p.series_id,p.scope_hash)
 OR project.state<>'approved_project' OR project.issued OR project.ksef_state<>'not_submitted' OR project.scope_hash IS DISTINCT FROM d.data->>'project_scope_hash'
 OR project.scope_hash IS DISTINCT FROM projectpreview.scope_hash OR project.preview_id<>projectpreview.id OR projectreceipt.preview_id<>projectpreview.id
 OR p.source IS DISTINCT FROM projectpreview.source OR fa3_draft_hash(project.draft)<>project.draft_hash
 OR p.scope_hash<>fa3_draft_hash(jsonb_build_object('request',p.request,'source',p.source,'snapshot',p.snapshot))
 OR s.definition IS DISTINCT FROM d.data->'series_definition' OR cmd.request_hash IS DISTINCT FROM d.data->>'series_command_hash'
 OR projectreceipt.project_id<>project.id OR projectreceipt.scope_hash<>project.scope_hash
 OR d.data#>>'{fiscal_snapshot,source,buyer_basis,kind}'<>'ordinary_explicit' OR d.data#>>'{fiscal_snapshot,currency}'<>'PLN'
 OR EXISTS(SELECT FROM b2b_dropship_supplier_orders WHERE(tenant_id,order_id)=(t,d.order_id)) THEN RAISE EXCEPTION 'Niepełny/unsupported oryginał korekty160' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM documents x WHERE(x.tenant_id,x.order_id)=(t,d.order_id) AND x.kind='correction' AND(x.mode<>'b2b_correction' OR NOT EXISTS(SELECT FROM b2b_credit_admissions ca WHERE(ca.tenant_id,ca.document_id,ca.original_document_id)=(t,x.id,did))))
 OR EXISTS(SELECT FROM invoice_plans WHERE(tenant_id,order_id)=(t,d.order_id) AND kind='correction' AND state NOT IN('preview','cancelled')) THEN RAISE EXCEPTION 'Legacy/odrębny corrective source160' USING ERRCODE='23514';END IF;
 original:=jsonb_build_object('document',jsonb_build_object('id',d.id,'order_id',d.order_id,'kind',d.kind,'mode',d.mode,'number',d.number,'data',d.data,'created_at',d.created_at),
 'receipt',jsonb_build_object('id',ir.id,'document_id',ir.document_id,'preview_id',ir.preview_id,'project_id',ir.project_id,'project_receipt_id',ir.project_receipt_id,'client_key',ir.client_key,'scope_hash',ir.scope_hash,'year',ir.year,'sequence',ir.sequence,'number',ir.number,'issued_at',ir.issued_at));
 FOR rr IN SELECT rc.id,rc.receipt_sequence FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(t,d.order_id) AND(rc.received_at IS NOT NULL OR rc.receipt_sequence>0) ORDER BY rc.receipt_sequence,rc.id LOOP
  seq:=seq+1;IF seq>1000 OR rr.receipt_sequence<>seq THEN RAISE EXCEPTION 'Niepełna chronologia169' USING ERRCODE='23514';END IF;
  SELECT jsonb_build_object('current_case',to_jsonb(rc),'receipt',to_jsonb(r),'admission',to_jsonb(ra),'effect_admission',to_jsonb(ea),'effect',to_jsonb(e),
   'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.item_id),'[]') FROM return_items i WHERE(i.tenant_id,i.return_id)=(t,rc.id)),
   'documents',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.warehouse_id,v.id),'[]') FROM catalog_stock_return_documents v WHERE(v.tenant_id,v.receipt_id)=(t,r.id)),
   'rows',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.document_id,v.ordinal),'[]') FROM catalog_stock_return_rows v JOIN catalog_stock_return_documents vd ON(vd.tenant_id,vd.id)=(v.tenant_id,v.document_id) WHERE(vd.tenant_id,vd.receipt_id)=(t,r.id))) INTO raw
  FROM return_cases rc JOIN catalog_stock_return_receipts r ON(r.tenant_id,r.return_id)=(rc.tenant_id,rc.id)
  JOIN catalog_stock_return_admissions ra ON(ra.tenant_id,ra.id)=(r.tenant_id,r.id)
  JOIN catalog_stock_control_effect_admissions ea ON(ea.tenant_id,ea.id)=(r.tenant_id,r.id) JOIN catalog_stock_control_effects e ON(e.tenant_id,e.admission_id)=(r.tenant_id,r.id) WHERE(rc.tenant_id,rc.id)=(t,rr.id);
  IF raw IS NULL THEN RAISE EXCEPTION 'Brak immutable physical169receipt' USING ERRCODE='23514';END IF;
  raw:=raw||jsonb_build_object('physical',b2b_credit_physical((raw#>>'{receipt,id}')::uuid));
  financial:=jsonb_build_object('tenant_id',t,'order_id',d.order_id,'return_id',rr.id,'number',raw#>'{receipt,snapshot,return_case,number}','receipt_sequence',rr.receipt_sequence,
   'kind',raw#>'{receipt,snapshot,return_case,kind}','received_state','refund_pending','remedy','refund','legacy',raw#>'{receipt,snapshot,return_case,legacy}','acceptance_kind','physical',
   'received_at',raw#>'{receipt,snapshot,return_case,received_at}','refund_amount_minor',(raw#>>'{receipt,snapshot,return_case,refund_amount}')::bigint::text,'refunded_shipping_minor',(raw#>>'{receipt,snapshot,return_case,refunded_shipping}')::bigint::text,
   'items',(SELECT jsonb_agg(jsonb_build_object('item_id',v->'item_id','accepted',(v->>'accepted')::bigint::text,'restocked',(v->>'restocked')::bigint::text,'refund_amount_minor',(v->>'refund_amount')::bigint::text) ORDER BY v->>'item_id') FROM jsonb_array_elements(raw#>'{receipt,snapshot,items}') v));
  acceptances:=acceptances||jsonb_build_array(financial||jsonb_build_object('native_proof',jsonb_build_object('kind','catalog_stock_return169','receipt_id',raw#>'{receipt,id}','admission_id',raw#>'{admission,id}','receipt_snapshot_hash',fa3_draft_hash(raw#>'{receipt,snapshot}'),'financial_hash',fa3_draft_hash(financial))));history:=history||jsonb_build_array(raw);
 END LOOP;
 IF seq=0 OR EXISTS(SELECT FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(t,d.order_id) AND rc.received_at IS NULL AND b2b_dropship_return_acceptance(rc.id) IS NOT NULL) THEN RAISE EXCEPTION 'Unsupported/empty fullhistory160' USING ERRCODE='23514';END IF;
 FOR cr IN SELECT r.*,to_jsonb(dc) doc FROM b2b_credit_receipts r JOIN documents dc ON(dc.tenant_id,dc.id)=(r.tenant_id,r.document_id) WHERE(r.tenant_id,r.original_document_id)=(t,did) AND NOT(r.root_xid=pg_current_xact_id() AND r.transaction_started_at=transaction_timestamp() AND r.backend_pid=pg_backend_pid()) ORDER BY r.receipt_sequence,r.id LOOP
  PERFORM b2b_credit_previous(cr.document_id);
  IF cr.previous_receipt_id IS DISTINCT FROM prev OR cr.receipt_sequence<>jsonb_array_length(previousj)+1 OR cr.snapshot IS DISTINCT FROM cr.doc->'data' OR cr.doc->>'mode'<>'b2b_correction' OR cr.doc->>'kind'<>'correction' OR cr.doc->>'return_id'<>cr.return_id::text THEN RAISE EXCEPTION 'Spliced nativeprevious160receipt' USING ERRCODE='23514';END IF;
  previousj:=previousj||jsonb_build_array(jsonb_build_object('document_id',cr.document_id,'receipt_id',cr.id,'original_document_id',cr.original_document_id,'original_receipt_id',cr.original_receipt_id,'return_id',cr.return_id,'return_receipt_id',cr.return_receipt_id,'receipt_sequence',cr.receipt_sequence,'calculation',cr.snapshot->'calculation','calculation_hash',cr.calculation_hash));prev:=cr.id;creditsj:=creditsj||jsonb_build_array(to_jsonb(cr));
 END LOOP;
 IF EXISTS(SELECT FROM orders o WHERE(o.tenant_id,o.id)=(t,d.order_id) AND o.currency<>'PLN') THEN RAISE EXCEPTION 'Zmieniona waluta źródła' USING ERRCODE='23514';END IF;
 inputj:=jsonb_build_object('original',original,'acceptance_manifest',jsonb_build_object('count',jsonb_array_length(acceptances),'financial_history_hash',fa3_draft_hash(acceptances)),'acceptances',acceptances,'previous_credits',previousj,'selected_return_id',selected_return,'shipping_credit_scope','native_refunded_shipping_value_only');
 raw:=jsonb_build_object('original',jsonb_build_object('document',to_jsonb(d),'receipt',to_jsonb(ir),'preview',to_jsonb(p),'admission',to_jsonb(ad),'project',to_jsonb(project),'project_receipt',to_jsonb(projectreceipt),'source_preview',to_jsonb(projectpreview),'series',to_jsonb(s),'series_command',to_jsonb(cmd)),'returns',history,'credits',creditsj,'input',inputj);
 IF octet_length(raw::text)>33554432 THEN RAISE EXCEPTION 'Pełne źródło160 przekracza32MiB' USING ERRCODE='54000';END IF;RETURN raw;
END$$;


-- Materialize exact history from typed native parents, never a caller JSON graph.
CREATE FUNCTION b2b_credit_physical(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;graphs jsonb;g jsonb;admissionj jsonb;receiptj jsonb;effectadmissionj jsonb;effectj jsonb;kind text;key text;col text;wanted jsonb;beforej jsonb;afterj jsonb;born jsonb;links jsonb;physical_journal jsonb;physical_document jsonb;physical_row jsonb;physical_number jsonb;product jsonb;actual jsonb;expected jsonb;
BEGIN
 PERFORM b2b_credit_history(eid);
WITH receipts AS MATERIALIZED(
   SELECT r.*,rc.receipt_sequence history_sequence FROM public.catalog_stock_return_receipts r
   JOIN public.return_cases rc ON(rc.tenant_id,rc.id,rc.order_id)=(r.tenant_id,r.return_id,r.order_id)
   WHERE r.tenant_id=t AND r.id=ANY(ARRAY[eid])),
  docs AS MATERIALIZED(SELECT d.* FROM public.catalog_stock_return_documents d JOIN receipts r ON(r.tenant_id,r.id)=(d.tenant_id,d.receipt_id)),
  rr AS MATERIALIZED(SELECT x.*,d.receipt_id FROM public.catalog_stock_return_rows x JOIN docs d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)),
  sm AS MATERIALIZED(SELECT m.*,x.receipt_id FROM public.catalog_stock_return_stock_maps m JOIN rr x ON(x.tenant_id,x.id)=(m.tenant_id,m.row_id)),
  im AS MATERIALIZED(SELECT m.*,x.receipt_id FROM public.catalog_stock_return_item_maps m JOIN rr x ON(x.tenant_id,x.id)=(m.tenant_id,m.row_id)),
  lm AS MATERIALIZED(SELECT m.*,x.receipt_id FROM public.catalog_stock_return_layer_maps m JOIN rr x ON(x.tenant_id,x.id)=(m.tenant_id,m.row_id)),
  graph AS MATERIALIZED(SELECT coalesce(jsonb_agg(jsonb_build_object(
   'receipt',to_jsonb(r)-'history_sequence','admission',to_jsonb(ad),'effect_admission',to_jsonb(ea),'effect',to_jsonb(e),
   'current_admission',ad.txid=pg_current_xact_id() AND r.created_at=transaction_timestamp(),
   'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.item_id),'[]') FROM public.return_items i WHERE(i.tenant_id,i.return_id)=(r.tenant_id,r.return_id)),
   'operation',(SELECT to_jsonb(op) FROM public.wms_operations op WHERE(op.tenant_id,op.id)=(r.tenant_id,r.wms_operation_id)),
   'journals',(SELECT coalesce(jsonb_agg(to_jsonb(j)||jsonb_build_object('actual',CASE j.kind
    WHEN 'stock' THEN(SELECT to_jsonb(m) FROM public.stock_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.stock_movement_id))
    WHEN 'bin' THEN(SELECT to_jsonb(m) FROM public.stock_location_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.location_movement_id))
    WHEN 'layer' THEN(SELECT to_jsonb(m) FROM public.wms_layer_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.layer_movement_id)) END) ORDER BY j.kind,j.journal_id),'[]')
    FROM public.catalog_stock_control_effect_journals j WHERE(j.tenant_id,j.admission_id)=(r.tenant_id,r.id)),
   'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.warehouse_id,d.id),'[]') FROM docs d WHERE d.receipt_id=r.id),
   'rows',(SELECT coalesce(jsonb_agg(to_jsonb(x)-'receipt_id' ORDER BY x.warehouse_id,x.product_id,x.location,x.bin_movement_id),'[]') FROM rr x WHERE x.receipt_id=r.id),
   'stock_maps',(SELECT coalesce(jsonb_agg(to_jsonb(m)-'receipt_id' ORDER BY m.row_id,m.stock_movement_id),'[]') FROM sm m WHERE m.receipt_id=r.id),
   'item_maps',(SELECT coalesce(jsonb_agg(to_jsonb(m)-'receipt_id' ORDER BY m.row_id,m.item_id,m.id),'[]') FROM im m WHERE m.receipt_id=r.id),
   'layer_maps',(SELECT coalesce(jsonb_agg(to_jsonb(m)-'receipt_id' ORDER BY m.row_id,m.layer_movement_id),'[]') FROM lm m WHERE m.receipt_id=r.id),
   'fragments',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]') FROM public.wms_return_fragments f WHERE(f.tenant_id,f.operation_id)=(r.tenant_id,r.wms_operation_id)),
   'layers',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]') FROM public.wms_cost_layers l WHERE l.tenant_id=r.tenant_id AND l.id IN(
    SELECT m.layer_id FROM public.wms_layer_movements m WHERE m.tenant_id=r.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids') v))),
   'issues',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]') FROM public.wms_issue_fragments i WHERE i.tenant_id=r.tenant_id AND i.id IN(
    SELECT f.issue_fragment_id FROM public.wms_return_fragments f WHERE(f.tenant_id,f.operation_id)=(r.tenant_id,r.wms_operation_id)))
   ) ORDER BY r.history_sequence,r.return_id),'[]') value FROM receipts r
   JOIN public.catalog_stock_return_admissions ad ON(ad.tenant_id,ad.id)=(r.tenant_id,r.id)
   JOIN public.catalog_stock_control_effect_admissions ea ON(ea.tenant_id,ea.id)=(r.tenant_id,r.id)
   JOIN public.catalog_stock_control_effects e ON(e.tenant_id,e.admission_id)=(r.tenant_id,r.id))
  SELECT CASE WHEN octet_length(value::text)<=33554432 THEN value ELSE NULL END INTO graphs FROM graph;
 IF graphs IS NULL THEN RAISE EXCEPTION 'Cały graph physical160 przekracza32MiB' USING ERRCODE='54000';END IF;
 IF jsonb_array_length(graphs)<>1 THEN RAISE EXCEPTION 'Brak dokładnego PZ history169' USING ERRCODE='23514';END IF;
 g:=graphs->0;admissionj:=g->'admission';receiptj:=g->'receipt';effectadmissionj:=g->'effect_admission';effectj:=g->'effect';
 IF effectadmissionj->'sealed' IS DISTINCT FROM 'true'::jsonb OR admissionj->'sealed' IS DISTINCT FROM 'true'::jsonb
 OR(effectadmissionj->>'id',effectadmissionj->>'source_kind',effectadmissionj->>'source_id',effectadmissionj->>'txid',effectadmissionj->>'actor_id',effectadmissionj->>'api_key_id') IS DISTINCT FROM(admissionj->>'id','return',admissionj->>'return_id',admissionj->>'txid',admissionj->>'actor_id',admissionj->>'api_key_id')
 OR(effectj->>'admission_id',effectj->>'operation_id') IS DISTINCT FROM(admissionj->>'id',receiptj->>'wms_operation_id') THEN RAISE EXCEPTION 'Obcy sealed physical parent152' USING ERRCODE='23514';END IF;
 FOREACH kind IN ARRAY ARRAY['stock','bin','layer'] LOOP
  key:=CASE kind WHEN 'stock' THEN 'stock_movement_ids' WHEN 'bin' THEN 'location_movement_ids' ELSE 'layer_movement_ids' END;
  col:=CASE kind WHEN 'stock' THEN 'stock_movement_id' WHEN 'bin' THEN 'location_movement_id' ELSE 'layer_movement_id' END;
  wanted:=receiptj->'proof'->key;beforej:=effectadmissionj->'before_frame'->(kind||'_journals');afterj:=effectj->'after_frame'->(kind||'_journals');
  IF jsonb_typeof(wanted) IS DISTINCT FROM 'array' OR jsonb_typeof(beforej) IS DISTINCT FROM 'array' OR jsonb_typeof(afterj) IS DISTINCT FROM 'array'
  OR wanted IS DISTINCT FROM effectj->'proof'->key OR jsonb_array_length(wanted)>10000
  OR jsonb_array_length(wanted)<>(SELECT count(DISTINCT v) FROM jsonb_array_elements(wanted)v)
  OR jsonb_array_length(beforej)<>(SELECT count(DISTINCT v->>'id') FROM jsonb_array_elements(beforej)v)
  OR jsonb_array_length(afterj)<>(SELECT count(DISTINCT v->>'id') FROM jsonb_array_elements(afterj)v)
  OR EXISTS(SELECT FROM jsonb_array_elements(beforej)b WHERE(SELECT v FROM jsonb_array_elements(afterj)v WHERE v->>'id'=b->>'id') IS DISTINCT FROM b)
  THEN RAISE EXCEPTION 'Niepełny sealed before/after journal152' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(v ORDER BY v->>'id'),'[]') INTO born FROM jsonb_array_elements(afterj)v WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(beforej)b WHERE b->>'id'=v->>'id');
  SELECT coalesce(jsonb_agg(v ORDER BY v->>'journal_id'),'[]') INTO links FROM jsonb_array_elements(g->'journals')v WHERE v->>'kind'=kind;
  IF(SELECT coalesce(jsonb_agg(v->'id' ORDER BY v->>'id'),'[]') FROM jsonb_array_elements(born)v) IS DISTINCT FROM(SELECT coalesce(jsonb_agg(v ORDER BY v#>>'{}'),'[]') FROM jsonb_array_elements(wanted)v)
  OR(SELECT coalesce(jsonb_agg(v->'journal_id' ORDER BY v->>'journal_id'),'[]') FROM jsonb_array_elements(links)v) IS DISTINCT FROM(SELECT coalesce(jsonb_agg(v ORDER BY v#>>'{}'),'[]') FROM jsonb_array_elements(wanted)v)
  THEN RAISE EXCEPTION 'Brak bijekcji sealed/proof/typed journal152' USING ERRCODE='23514';END IF;
  FOR physical_journal IN SELECT v FROM jsonb_array_elements(links)v LOOP
   IF physical_journal->>col IS DISTINCT FROM physical_journal->>'journal_id' OR physical_journal->'actual' IS DISTINCT FROM(SELECT v FROM jsonb_array_elements(born)v WHERE v->>'id'=physical_journal->>'journal_id')
   OR physical_journal#>>'{actual,tenant_id}' IS DISTINCT FROM t::text
   OR EXISTS(SELECT FROM unnest(ARRAY['stock_movement_id','location_movement_id','layer_movement_id'])k WHERE k<>col AND physical_journal->>k IS NOT NULL)
   OR(physical_journal#>>'{actual,delta}')::bigint<=0 THEN RAISE EXCEPTION 'Obcy typed actual journal169' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_array_elements(g->'journals')v WHERE v->>'kind' NOT IN('stock','bin','layer'))
 OR jsonb_array_length(receiptj#>'{proof,stock_movement_ids}')=0 OR jsonb_array_length(receiptj#>'{proof,location_movement_ids}')=0
 OR jsonb_array_length(g->'rows')>10000 OR jsonb_array_length(g->'stock_maps')+jsonb_array_length(g->'item_maps')+jsonb_array_length(g->'layer_maps')>30000
 THEN RAISE EXCEPTION 'Unsupported/niepełny physical manifest169' USING ERRCODE='23514';END IF;
 -- Literal frozen heads/rows, including complete ordinal order, not only sums.
 FOR physical_document IN SELECT v FROM jsonb_array_elements(g->'documents')v LOOP
  SELECT v INTO physical_number FROM jsonb_array_elements(admissionj->'numbers')v WHERE v->>'warehouse_id'=physical_document->>'warehouse_id';
  expected:=jsonb_build_object('id',physical_document->'id','receipt_id',receiptj->'id','return_id',admissionj->'return_id','order_id',admissionj->'order_id','warehouse_id',physical_document->'warehouse_id','kind','PZ','number',physical_document->'number','series_id',physical_document->'series_id','year',physical_document->'year','sequence',physical_document->>'sequence',
   'row_count',(SELECT count(*) FROM jsonb_array_elements(g->'rows')v WHERE v->>'document_id'=physical_document->>'id'),
   'quantity',(SELECT sum((v->>'quantity')::bigint)::text FROM jsonb_array_elements(g->'rows')v WHERE v->>'document_id'=physical_document->>'id'),'wms_enabled',receiptj->>'wms_operation_id' IS NOT NULL,'created_at',receiptj->'created_at','series',physical_number->'series','warehouse',physical_document#>'{payload,warehouse}');
  IF physical_document->'payload' IS DISTINCT FROM expected OR physical_document#>>'{payload,warehouse,id}' IS DISTINCT FROM physical_document->>'warehouse_id' OR physical_document#>>'{payload,warehouse,tenant_id}' IS DISTINCT FROM t::text
  OR EXISTS(SELECT FROM(SELECT v,row_number() OVER(ORDER BY v->>'product_id',v->>'location',v->>'bin_movement_id')-1 ordinal FROM jsonb_array_elements(g->'rows')v WHERE v->>'document_id'=physical_document->>'id')z WHERE(z.v->>'ordinal')::bigint<>z.ordinal)
  THEN RAISE EXCEPTION 'Zmienił się frozen head/ordinal PZ169' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR physical_row IN SELECT v FROM jsonb_array_elements(g->'rows')v LOOP
  SELECT v INTO product FROM jsonb_array_elements(admissionj#>'{frame,products}')v WHERE v->>'id'=physical_row->>'product_id';
  IF product IS NULL OR physical_row->'payload' IS DISTINCT FROM jsonb_build_object('product_id',physical_row->'product_id','sku',product->'sku','name',product->'name','warehouse_id',physical_row->'warehouse_id','location',physical_row->'location','quantity',physical_row->'quantity','bin_movement_id',physical_row->'bin_movement_id') THEN RAISE EXCEPTION 'Zmieniła się frozen pozycja PZ169' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Exact interval stock maps independently reconstructed in native UUID/location order.
 WITH rows AS(SELECT v,(v->>'quantity')::numeric q,sum((v->>'quantity')::numeric) OVER(PARTITION BY v->>'warehouse_id',v->>'product_id' ORDER BY v->>'location',v->>'bin_movement_id') hi FROM jsonb_array_elements(g->'rows')v),
 journals AS(SELECT v->'actual' v,(v#>>'{actual,delta}')::numeric q,sum((v#>>'{actual,delta}')::numeric) OVER(PARTITION BY v#>>'{actual,warehouse_id}',v#>>'{actual,product_id}' ORDER BY v->>'journal_id') hi FROM jsonb_array_elements(g->'journals')v WHERE v->>'kind'='stock'),
 maps AS(SELECT jsonb_build_object('tenant_id',t,'row_id',x.v->'id','stock_movement_id',j.v->'id','quantity',(least(x.hi,j.hi)-greatest(x.hi-x.q,j.hi-j.q))::integer) v FROM rows x JOIN journals j ON(x.v->>'warehouse_id',x.v->>'product_id')=(j.v->>'warehouse_id',j.v->>'product_id') WHERE least(x.hi,j.hi)>greatest(x.hi-x.q,j.hi-j.q))
 SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') INTO expected FROM maps;
 SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') INTO actual FROM jsonb_array_elements(g->'stock_maps')v;
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Stock interval map nie jest native169' USING ERRCODE='23514';END IF;
 WITH rows AS(SELECT v,(v->>'quantity')::numeric q,sum((v->>'quantity')::numeric) OVER(PARTITION BY v->>'warehouse_id',v->>'product_id' ORDER BY v->>'location',v->>'bin_movement_id') hi FROM jsonb_array_elements(g->'rows')v),
 recipe AS(SELECT i->'item_id' item_id,c->'product_id' product_id,(i->>'restocked')::numeric*(c->>'quantity')::numeric q FROM jsonb_array_elements(receiptj#>'{snapshot,items}')i CROSS JOIN LATERAL jsonb_array_elements(i->'components')c WHERE(i->>'restocked')::numeric*(c->>'quantity')::numeric>0),
 spans AS(SELECT *,sum(q) OVER(PARTITION BY product_id ORDER BY item_id) hi FROM recipe),
 maps AS(SELECT jsonb_build_object('tenant_id',t,'row_id',x.v->'id','return_id',admissionj->'return_id','item_id',i.item_id,'arrival_id',NULL,'quantity',(least(x.hi,i.hi)-greatest(x.hi-x.q,i.hi-i.q))::integer) v FROM rows x JOIN spans i ON x.v->'product_id'=i.product_id AND x.v->'warehouse_id'=admissionj#>'{frame,return_case,warehouse_id}' WHERE least(x.hi,i.hi)>greatest(x.hi-x.q,i.hi-i.q))
 SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') INTO expected FROM maps;
 SELECT coalesce(jsonb_agg(v-'id' ORDER BY(v-'id')::text),'[]') INTO actual FROM jsonb_array_elements(g->'item_maps')v;
 IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Item interval map nie jest native169' USING ERRCODE='23514';END IF;
 IF receiptj->>'wms_operation_id' IS NULL THEN
  IF jsonb_array_length(g->'layer_maps')<>0 OR jsonb_array_length(g->'fragments')<>0 OR jsonb_array_length(g->'layers')<>0 OR jsonb_array_length(g->'issues')<>0 OR jsonb_array_length(receiptj#>'{proof,layer_movement_ids}')<>0 THEN RAISE EXCEPTION 'OFF z obcą warstwą' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT FROM jsonb_array_elements(g->'fragments')f LEFT JOIN LATERAL(SELECT v FROM jsonb_array_elements(g->'issues')v WHERE v->>'id'=f->>'issue_fragment_id')i ON true
   LEFT JOIN LATERAL(SELECT v FROM jsonb_array_elements(g->'layers')v WHERE v->>'id'=f->>'layer_id')l ON true
   WHERE i.v IS NULL OR l.v IS NULL OR(f->>'operation_id',f->>'return_id',f->>'order_id',f->>'layer_id',f->>'product_id') IS DISTINCT FROM(receiptj->>'wms_operation_id',admissionj->>'return_id',admissionj->>'order_id',i.v->>'layer_id',i.v->>'product_id')
   OR i.v->>'order_id' IS DISTINCT FROM admissionj->>'order_id' OR i.v->>'warehouse_document_id' IS NOT NULL
   OR(i.v->>'unit_cost_minor',i.v->>'currency') IS DISTINCT FROM(l.v->>'unit_cost_minor',l.v->>'currency')
   OR(f->>'quantity')::numeric>(i.v->>'quantity')::numeric OR(f->>'value_minor')::numeric IS DISTINCT FROM(f->>'quantity')::numeric*(l.v->>'unit_cost_minor')::numeric)
   THEN RAISE EXCEPTION 'Obce original issue fragment/cost169' USING ERRCODE='23514';END IF;
  WITH rows AS(SELECT v,(v->>'quantity')::numeric q,sum((v->>'quantity')::numeric) OVER(PARTITION BY v->>'warehouse_id',v->>'product_id',v->>'location' ORDER BY v->>'bin_movement_id') hi FROM jsonb_array_elements(g->'rows')v),
  journals AS(SELECT v->'actual' v,(v#>>'{actual,delta}')::numeric q,sum((v#>>'{actual,delta}')::numeric) OVER(PARTITION BY v#>>'{actual,warehouse_id}',v#>>'{actual,product_id}',v#>>'{actual,location}' ORDER BY v->>'journal_id') hi,
   row_number() OVER(PARTITION BY v#>>'{actual,warehouse_id}',v#>>'{actual,product_id}',v#>>'{actual,location}',v#>>'{actual,layer_id}',v#>>'{actual,delta}',v#>>'{actual,value_delta}' ORDER BY v->>'journal_id') rank
   FROM jsonb_array_elements(g->'journals')v WHERE v->>'kind'='layer'),
  fragments AS(SELECT v,row_number() OVER(PARTITION BY v->>'warehouse_id',v->>'product_id',v->>'location',v->>'layer_id',v->>'quantity',v->>'value_minor' ORDER BY v->>'id') rank FROM jsonb_array_elements(g->'fragments')v),
  maps AS(SELECT jsonb_build_object('tenant_id',t,'row_id',x.v->'id','layer_movement_id',j.v->'id','fragment_id',f.v->'id','quantity',q.qty,
   'payload',jsonb_build_object('layer_id',l.v->'id','lot_id',l.v->'lot_id','issue_fragment_id',f.v->'issue_fragment_id','unit_cost_minor',l.v->>'unit_cost_minor','currency',l.v->'currency','exponent',l.v->'exponent','value_minor',(q.qty::numeric*(l.v->>'unit_cost_minor')::numeric)::text,'allocation','quantity_interval')) v
   FROM rows x JOIN journals j ON(x.v->>'warehouse_id',x.v->>'product_id',x.v->>'location')=(j.v->>'warehouse_id',j.v->>'product_id',j.v->>'location')
   JOIN LATERAL(SELECT v FROM jsonb_array_elements(g->'layers')v WHERE v->>'id'=j.v->>'layer_id')l ON true
   LEFT JOIN fragments f ON(f.v->>'warehouse_id',f.v->>'product_id',f.v->>'location',f.v->>'layer_id',f.v->>'quantity',f.v->>'value_minor',f.rank) IS NOT DISTINCT FROM(j.v->>'warehouse_id',j.v->>'product_id',j.v->>'location',j.v->>'layer_id',j.v->>'delta',j.v->>'value_delta',j.rank)
   CROSS JOIN LATERAL(SELECT(least(x.hi,j.hi)-greatest(x.hi-x.q,j.hi-j.q))::integer qty)q WHERE q.qty>0)
  SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') INTO expected FROM maps;
  SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]') INTO actual FROM jsonb_array_elements(g->'layer_maps')v;
  IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Layer interval map nie jest native169' USING ERRCODE='23514';END IF;
 END IF;
 RETURN g;
END$$;

-- Historical receipts are validated by immutable tuple lineage; they are never
-- presented to admissionj current-XID issuance validator. Arithmetic recomputes the chain.
CREATE FUNCTION b2b_credit_previous(did uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r b2b_credit_receipts;p b2b_credit_previews;a b2b_credit_admissions;d documents;BEGIN
 SELECT * INTO d FROM documents WHERE(tenant_id,id)=(t,did);SELECT * INTO r FROM b2b_credit_receipts WHERE(tenant_id,document_id)=(t,did);
 SELECT * INTO p FROM b2b_credit_previews WHERE(tenant_id,id)=(t,r.preview_id);SELECT * INTO a FROM b2b_credit_admissions WHERE(tenant_id,id)=(t,r.id);
 IF d.id IS NULL OR r.id IS NULL OR p.id IS NULL OR a.id IS NULL
 OR(d.kind,d.mode,d.number,d.order_id,d.return_id,d.channel_id,d.external_id) IS DISTINCT FROM('correction'::text,'b2b_correction'::text,r.number,r.order_id,r.return_id,NULL::uuid,NULL::text)
 OR(a.id,a.document_id,a.preview_id,a.original_document_id,a.return_id,a.return_receipt_id,a.actor_id,a.api_key_id,a.client_key,a.request,a.request_hash,a.year,a.sequence,a.number,a.root_xid,a.transaction_started_at,a.backend_pid)
 IS DISTINCT FROM(r.id,r.document_id,r.preview_id,r.original_document_id,r.return_id,r.return_receipt_id,r.actor_id,r.api_key_id,r.client_key,r.request,r.request_hash,r.year,r.sequence,r.number,r.root_xid,r.transaction_started_at,r.backend_pid)
 OR(r.original_document_id,r.original_receipt_id,r.order_id,r.return_id,r.return_receipt_id,r.receipt_sequence,r.previous_receipt_id,r.series_id,r.scope_hash)
 IS DISTINCT FROM(p.original_document_id,p.original_receipt_id,p.order_id,p.return_id,p.return_receipt_id,p.receipt_sequence,p.previous_receipt_id,p.series_id,p.scope_hash)
 OR r.snapshot IS DISTINCT FROM d.data OR r.snapshot IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash))
 OR r.calculation_hash<>fa3_draft_hash(r.snapshot->'calculation') OR r.request_hash<>fa3_draft_hash(jsonb_build_object('preview',p.id,'request',r.request,'actor',r.actor_id,'key',r.api_key_id))
 OR r.request IS DISTINCT FROM jsonb_build_object('client_key',r.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
 OR p.request_hash<>fa3_draft_hash(jsonb_build_object('request',p.request,'actor',p.actor_id,'key',p.api_key_id))
 OR p.scope_hash<>fa3_draft_hash(jsonb_build_object('request',p.request,'source',p.source,'input',p.input,'snapshot',p.snapshot))
 OR p.input IS DISTINCT FROM p.source->'input' OR p.snapshot->'calculation' IS DISTINCT FROM b2b_credit_calculate(p.input)
 OR(p.actor_id,p.api_key_id) IS DISTINCT FROM(r.actor_id,r.api_key_id)
 OR r.year<>extract(year FROM(p.snapshot->>'issue_date')::date)::integer
 OR r.number IS DISTINCT FROM 'KOR-B2B/'||(p.snapshot#>>'{series_definition,prefix}')||'/'||r.year::text||'/'||lpad(r.sequence::text,6,'0')
 THEN RAISE EXCEPTION 'Niepełna immutable lineage poprzedniej korekty160' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION b2b_credit_snapshot(src jsonb,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE inputj jsonb:=src->'input';calc jsonb:=b2b_credit_calculate(inputj);f jsonb:=inputj#>'{original,document,data}';selected jsonb;BEGIN
 SELECT v INTO selected FROM jsonb_array_elements(inputj->'acceptances')v WHERE v->>'return_id'=b->>'return_id';
 IF b IS DISTINCT FROM jsonb_build_object('client_key',b->'client_key','original_document_id',inputj#>'{original,document,id}','return_id',inputj->'selected_return_id','issue_date',b->'issue_date','reason',b->'reason','local_only',true,'confirmed_received_snapshot',true)
 OR selected IS NULL OR b->>'issue_date'!~'^\d{4}-\d{2}-\d{2}$' OR(b->>'issue_date')::date NOT BETWEEN '2006-01-01'::date AND '2050-01-01'::date
 OR(b->>'issue_date')::date<(f->>'issue_date')::date OR(b->>'issue_date')::date<(selected->>'received_at')::timestamptz::date
 OR(b->>'issue_date')::date>(clock_timestamp() AT TIME ZONE 'UTC')::date OR length(b->>'reason') NOT BETWEEN 1 AND 2000 OR b->>'reason'~'[\x00-\x08\x0B\x0C\x0E-\x1F]' THEN RAISE EXCEPTION 'Wymagana pełna obsługiwana zgoda korekty160' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('schema','b2b-local-correction/v1','original_document_id',inputj#>'{original,document,id}','original_receipt_id',inputj#>'{original,receipt,id}','return_id',selected->'return_id','return_receipt_id',selected#>'{native_proof,receipt_id}','receipt_sequence',selected->'receipt_sequence',
 'series_id',f->'series_id','series_definition',f->'series_definition','series_command_hash',f->'series_command_hash','issue_date',b->'issue_date','reason',b->'reason','calculation',calc,'calculation_hash',fa3_draft_hash(calc),'local_only',true,'ksef_state','not_submitted','fiscalized',false);
END$$;
CREATE FUNCTION b2b_credit_preview(b jsonb,expected_input jsonb,expected_calculation jsonb,uid uuid,kid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_credit_previews;src jsonb;snap jsonb;rh text:=fa3_draft_hash(jsonb_build_object('request',b,'actor',uid,'key',kid));prev uuid;BEGIN
 PERFORM b2b_credit_require(uid,kid,h,true,false);PERFORM b2b_credit_locks((b->>'original_document_id')::uuid);
 SELECT * INTO p FROM b2b_credit_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.actor_id,p.api_key_id,p.request,p.request_hash) IS DISTINCT FROM(uid,kid,b,rh) THEN RAISE EXCEPTION 'Klucz podglądu z inną zgodą160' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('id',p.id,'reused',true);END IF;
 src:=b2b_credit_basis((b->>'original_document_id')::uuid,(b->>'return_id')::uuid);snap:=b2b_credit_snapshot(src,b);
 IF octet_length(src::text)+octet_length((src->'input')::text)>33554432 OR octet_length(snap::text)>2097152 THEN RAISE EXCEPTION 'Cały preview160 przekracza jawny budżet' USING ERRCODE='54000';END IF;
 IF src->'input' IS DISTINCT FROM expected_input OR snap->'calculation' IS DISTINCT FROM expected_calculation THEN RAISE EXCEPTION 'Native/pure/history proof nie odpowiada sobie160' USING ERRCODE='23514';END IF;
 SELECT id INTO prev FROM b2b_credit_receipts WHERE(tenant_id,original_document_id)=(t,(b->>'original_document_id')::uuid) ORDER BY receipt_sequence DESC LIMIT 1;
 INSERT INTO b2b_credit_previews(tenant_id,original_document_id,original_receipt_id,order_id,return_id,return_receipt_id,series_id,receipt_sequence,previous_receipt_id,actor_id,api_key_id,client_key,request,request_hash,source,input,snapshot,scope_hash)
 VALUES(t,(snap->>'original_document_id')::uuid,(snap->>'original_receipt_id')::uuid,(src#>>'{input,original,document,order_id}')::uuid,(snap->>'return_id')::uuid,(snap->>'return_receipt_id')::uuid,(snap->>'series_id')::uuid,(snap->>'receipt_sequence')::integer,prev,uid,kid,(b->>'client_key')::uuid,b,rh,src,src->'input',snap,fa3_draft_hash(jsonb_build_object('request',b,'source',src,'input',src->'input','snapshot',snap))) RETURNING * INTO p;
 PERFORM b2b_credit_budget(t);RETURN jsonb_build_object('id',p.id,'reused',false);
END$$;
CREATE FUNCTION b2b_credit_issue(pid uuid,b jsonb,expected_input jsonb,expected_calculation jsonb,uid uuid,kid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_credit_previews;r b2b_credit_receipts;src jsonb;snap jsonb;yr integer;seq integer;prefix text;num text;did uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();rh text:=fa3_draft_hash(jsonb_build_object('preview',pid,'request',b,'actor',uid,'key',kid));BEGIN
 PERFORM b2b_credit_require(uid,kid,h,true,false);SELECT * INTO p FROM b2b_credit_previews WHERE(tenant_id,id)=(t,pid);IF p.id IS NULL THEN RAISE EXCEPTION 'Brak własnego podglądu160' USING ERRCODE='P0002';END IF;
 PERFORM b2b_credit_locks(p.original_document_id);
 SELECT * INTO r FROM b2b_credit_receipts WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request,r.request_hash) IS DISTINCT FROM(pid,uid,kid,b,rh) THEN RAISE EXCEPTION 'Klucz issue z inną zgodą160' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('document_id',r.document_id,'receipt_id',r.id,'reused',true);END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR b IS DISTINCT FROM jsonb_build_object('client_key',b->'client_key','scope_hash',p.scope_hash,'confirmed',true,'local_only',true) THEN RAISE EXCEPTION 'Brak osobnej aktualnej zgody160' USING ERRCODE='23514';END IF;
 src:=b2b_credit_basis(p.original_document_id,p.return_id);snap:=b2b_credit_snapshot(src,p.request);
 IF src IS DISTINCT FROM p.source OR src->'input' IS DISTINCT FROM expected_input OR p.input IS DISTINCT FROM expected_input OR snap IS DISTINCT FROM p.snapshot OR snap->'calculation' IS DISTINCT FROM expected_calculation THEN RAISE EXCEPTION 'Całe źródło/łańcuch korekty zmienił się160' USING ERRCODE='23514';END IF;
 yr:=extract(year FROM(p.snapshot->>'issue_date')::date)::integer;SELECT last_number+1 INTO seq FROM b2b_credit_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,yr) FOR UPDATE;seq:=coalesce(seq,1);prefix:=p.snapshot#>>'{series_definition,prefix}';
 IF seq>999999 THEN RAISE EXCEPTION 'Numeracja korekt wyczerpana160' USING ERRCODE='23514';END IF;num:='KOR-B2B/'||prefix||'/'||yr::text||'/'||lpad(seq::text,6,'0');
 INSERT INTO b2b_credit_admissions(id,tenant_id,document_id,preview_id,original_document_id,return_id,return_receipt_id,actor_id,api_key_id,client_key,request,request_hash,year,sequence,number)
 VALUES(rid,t,did,p.id,p.original_document_id,p.return_id,p.return_receipt_id,uid,kid,(b->>'client_key')::uuid,b,rh,yr,seq,num);
 IF NOT EXISTS(SELECT FROM b2b_credit_namespaces WHERE(tenant_id,series_id)=(t,p.series_id)) THEN INSERT INTO b2b_credit_namespaces(seller_tax_id,prefix,tenant_id,series_id) VALUES(p.snapshot#>>'{calculation,fiscal_snapshot,seller,tax_id}',prefix,t,p.series_id);END IF;
 IF NOT EXISTS(SELECT FROM b2b_credit_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,yr)) THEN INSERT INTO b2b_credit_counters VALUES(t,p.series_id,yr,0);END IF;
 snap:=snap||jsonb_build_object('number',num,'year',yr,'sequence',seq,'preview_id',p.id,'scope_hash',p.scope_hash);
 INSERT INTO documents(id,tenant_id,order_id,return_id,kind,mode,number,data) VALUES(did,t,p.order_id,p.return_id,'correction','b2b_correction',num,snap);
 INSERT INTO b2b_credit_receipts(id,tenant_id,document_id,preview_id,original_document_id,original_receipt_id,order_id,return_id,return_receipt_id,series_id,receipt_sequence,previous_receipt_id,actor_id,api_key_id,client_key,request,request_hash,snapshot,calculation_hash,scope_hash,year,sequence,number)
 VALUES(rid,t,did,p.id,p.original_document_id,p.original_receipt_id,p.order_id,p.return_id,p.return_receipt_id,p.series_id,p.receipt_sequence,p.previous_receipt_id,uid,kid,(b->>'client_key')::uuid,b,rh,snap,p.snapshot->>'calculation_hash',p.scope_hash,yr,seq,num);
 UPDATE b2b_credit_counters SET last_number=seq WHERE(tenant_id,series_id,year)=(t,p.series_id,yr);
 RETURN jsonb_build_object('document_id',did,'receipt_id',rid,'reused',false);
END$$;
CREATE FUNCTION b2b_credit_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF(SELECT count(*) FROM b2b_credit_previews WHERE tenant_id=t)>10000 OR(SELECT coalesce(sum(octet_length(source::text)+octet_length(input::text)+octet_length(snapshot::text)+octet_length(request::text)),0) FROM b2b_credit_previews WHERE tenant_id=t)>134217728 THEN RAISE EXCEPTION 'Pełny native160 przekroczył128MiB/10000' USING ERRCODE='54000';END IF;
END$$;
CREATE FUNCTION b2b_credit_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_credit_previews;a b2b_credit_admissions;raw jsonb:=to_jsonb(NEW);src jsonb;n integer;BEGIN
 IF NOT b2b_credit_guards() OR NEW.tenant_id IS DISTINCT FROM t THEN RAISE EXCEPTION 'Niepełny kontekst160' USING ERRCODE='55000';END IF;
 IF TG_TABLE_NAME='b2b_credit_previews' THEN
  src:=b2b_credit_basis(NEW.original_document_id,NEW.return_id);
  IF NEW.source IS DISTINCT FROM src OR NEW.input IS DISTINCT FROM src->'input' OR NEW.snapshot IS DISTINCT FROM b2b_credit_snapshot(src,NEW.request)
  OR(NEW.original_receipt_id,NEW.order_id,NEW.return_receipt_id,NEW.series_id,NEW.receipt_sequence) IS DISTINCT FROM((NEW.snapshot->>'original_receipt_id')::uuid,(src#>>'{input,original,document,order_id}')::uuid,(NEW.snapshot->>'return_receipt_id')::uuid,(NEW.snapshot->>'series_id')::uuid,(NEW.snapshot->>'receipt_sequence')::integer)
  OR NEW.previous_receipt_id IS DISTINCT FROM(SELECT id FROM b2b_credit_receipts WHERE(tenant_id,original_document_id)=(t,NEW.original_document_id) ORDER BY receipt_sequence DESC LIMIT 1)
  OR NEW.request_hash<>fa3_draft_hash(jsonb_build_object('request',NEW.request,'actor',NEW.actor_id,'key',NEW.api_key_id))
  OR NEW.scope_hash<>fa3_draft_hash(jsonb_build_object('request',NEW.request,'source',NEW.source,'input',NEW.input,'snapshot',NEW.snapshot))
  OR NEW.created_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp() OR NEW.expires_at>NEW.created_at+interval '15 minutes 1 second' THEN RAISE EXCEPTION 'Niepełny rzeczywisty preview160' USING ERRCODE='23514';END IF;
  PERFORM b2b_credit_require(NEW.actor_id,NEW.api_key_id,current_setting('b2b_credit.identity_hash',true),true,false);
 ELSE
  SELECT * INTO p FROM b2b_credit_previews WHERE(tenant_id,id)=(t,(raw->>'preview_id')::uuid);IF p.id IS NULL THEN RAISE EXCEPTION 'Brak typedpreview160' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='b2b_credit_admissions' THEN
   SELECT last_number+1 INTO n FROM b2b_credit_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,NEW.year);n:=coalesce(n,1);
   IF(NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())
   OR(NEW.original_document_id,NEW.return_id,NEW.return_receipt_id,NEW.actor_id,NEW.api_key_id) IS DISTINCT FROM(p.original_document_id,p.return_id,p.return_receipt_id,p.actor_id,p.api_key_id)
   OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
   OR NEW.request_hash<>fa3_draft_hash(jsonb_build_object('preview',p.id,'request',NEW.request,'actor',NEW.actor_id,'key',NEW.api_key_id))
   OR NEW.year<>extract(year FROM(p.snapshot->>'issue_date')::date)::integer OR NEW.sequence<>n OR NEW.number IS DISTINCT FROM 'KOR-B2B/'||(p.snapshot#>>'{series_definition,prefix}')||'/'||NEW.year::text||'/'||lpad(NEW.sequence::text,6,'0')
   OR p.expires_at<=clock_timestamp() OR p.source IS DISTINCT FROM b2b_credit_basis(p.original_document_id,p.return_id) THEN RAISE EXCEPTION 'Obca/historyczna zgoda160' USING ERRCODE='23514';END IF;
   PERFORM b2b_credit_require(NEW.actor_id,NEW.api_key_id,current_setting('b2b_credit.identity_hash',true),true,false);
  ELSE
   SELECT * INTO a FROM b2b_credit_admissions WHERE(tenant_id,document_id)=(t,NEW.document_id);
   IF a.id IS NULL OR(a.root_xid,a.transaction_started_at,a.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())
   OR(NEW.id,NEW.preview_id,NEW.original_document_id,NEW.return_id,NEW.return_receipt_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request,NEW.request_hash,NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid,NEW.year,NEW.sequence,NEW.number)
   IS DISTINCT FROM(a.id,a.preview_id,a.original_document_id,a.return_id,a.return_receipt_id,a.actor_id,a.api_key_id,a.client_key,a.request,a.request_hash,a.root_xid,a.transaction_started_at,a.backend_pid,a.year,a.sequence,a.number)
   OR(NEW.original_receipt_id,NEW.order_id,NEW.series_id,NEW.receipt_sequence,NEW.previous_receipt_id,NEW.scope_hash) IS DISTINCT FROM(p.original_receipt_id,p.order_id,p.series_id,p.receipt_sequence,p.previous_receipt_id,p.scope_hash)
   OR NEW.snapshot IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash)) OR NEW.calculation_hash<>p.snapshot->>'calculation_hash'
   THEN RAISE EXCEPTION 'Receipt nie odpowiada actual native issue160' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION b2b_credit_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a b2b_credit_admissions;p b2b_credit_previews;BEGIN
 IF TG_OP<>'INSERT' AND OLD.mode='b2b_correction' THEN RAISE EXCEPTION 'Niezmienny wystawiony credit160' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;IF NEW.mode<>'b2b_correction' THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Nie wolno relabel dokumentu160' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM b2b_credit_admissions WHERE(tenant_id,document_id)=(NEW.tenant_id,NEW.id);SELECT * INTO p FROM b2b_credit_previews WHERE(tenant_id,id)=(NEW.tenant_id,a.preview_id);
 IF a.id IS NULL OR p.id IS NULL OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
 OR(a.root_xid,a.transaction_started_at,a.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())
 OR(NEW.kind,NEW.mode,NEW.order_id,NEW.return_id,NEW.number,NEW.channel_id,NEW.external_id) IS DISTINCT FROM('correction'::text,'b2b_correction'::text,p.order_id,p.return_id,a.number,NULL::uuid,NULL::text)
 OR NEW.data IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash)) THEN RAISE EXCEPTION 'Dokument bez current typed zgody160' USING ERRCODE='23514';END IF;
 PERFORM b2b_credit_require(a.actor_id,a.api_key_id,current_setting('b2b_credit.identity_hash',true),true,false);RETURN NEW;
END$$;
CREATE FUNCTION b2b_credit_namespace_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Niezmienny namespace160' USING ERRCODE='23514';END IF;
 IF NOT b2b_credit_guards() OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
 OR NOT EXISTS(SELECT FROM b2b_credit_admissions a JOIN b2b_credit_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id) WHERE(a.root_xid,a.transaction_started_at,a.backend_pid)=(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())
 AND(p.tenant_id,p.series_id,p.snapshot#>>'{calculation,fiscal_snapshot,seller,tax_id}',p.snapshot#>>'{series_definition,prefix}')=(NEW.tenant_id,NEW.series_id,NEW.seller_tax_id,NEW.prefix)) THEN RAISE EXCEPTION 'Brak native namespace approval160' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION b2b_credit_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Nie wolno usuwać numeracji160' USING ERRCODE='23514';END IF;
 IF NOT b2b_credit_guards() OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Brak native context160' USING ERRCODE='55000';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.last_number<>0 OR NOT EXISTS(SELECT FROM b2b_credit_admissions a JOIN b2b_credit_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id) WHERE(a.tenant_id,p.series_id,a.year,a.sequence,a.root_xid,a.transaction_started_at,a.backend_pid)=(NEW.tenant_id,NEW.series_id,NEW.year,1,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())) THEN RAISE EXCEPTION 'Brak pierwszej zgody licznika160' USING ERRCODE='23514';END IF;
 ELSE
  IF(NEW.tenant_id,NEW.series_id,NEW.year) IS DISTINCT FROM(OLD.tenant_id,OLD.series_id,OLD.year) OR NEW.last_number<>OLD.last_number+1
  OR NOT EXISTS(SELECT FROM b2b_credit_receipts r WHERE(r.tenant_id,r.series_id,r.year,r.sequence,r.root_xid,r.transaction_started_at,r.backend_pid)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())) THEN RAISE EXCEPTION 'Licznik bez actualcurrentreceipt160' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION b2b_credit_validate(did uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a b2b_credit_admissions;p b2b_credit_previews;src jsonb;BEGIN
 PERFORM b2b_credit_previous(did);SELECT * INTO a FROM b2b_credit_admissions WHERE(tenant_id,document_id)=(t,did);SELECT * INTO p FROM b2b_credit_previews WHERE(tenant_id,id)=(t,a.preview_id);
 IF a.id IS NULL OR(a.root_xid,a.transaction_started_at,a.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) THEN RAISE EXCEPTION 'Nie jest currentissue160' USING ERRCODE='23514';END IF;
 src:=b2b_credit_basis(p.original_document_id,p.return_id);
 IF p.source IS DISTINCT FROM src OR p.input IS DISTINCT FROM src->'input' OR p.snapshot IS DISTINCT FROM b2b_credit_snapshot(src,p.request)
 OR NOT EXISTS(SELECT FROM b2b_credit_namespaces ns WHERE(ns.tenant_id,ns.series_id,ns.seller_tax_id,ns.prefix)=(t,p.series_id,p.snapshot#>>'{calculation,fiscal_snapshot,seller,tax_id}',p.snapshot#>>'{series_definition,prefix}'))
 OR a.sequence IS DISTINCT FROM(SELECT last_number FROM b2b_credit_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,a.year)) THEN RAISE EXCEPTION 'Niepełne bieżące zużycie historii/num160' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION b2b_credit_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_TABLE_NAME<>'b2b_credit_previews' THEN PERFORM b2b_credit_validate(NEW.document_id);END IF;PERFORM b2b_credit_budget(NEW.tenant_id);RETURN NEW;
END$$;
CREATE FUNCTION b2b_credit_source_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE raw jsonb;beforej jsonb;afterj jsonb;returnkey uuid;BEGIN
 IF TG_OP<>'INSERT' THEN beforej:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN afterj:=to_jsonb(NEW);END IF;
 FOR raw IN SELECT beforej UNION ALL SELECT afterj LOOP
  IF raw IS NULL THEN CONTINUE;END IF;returnkey:=NULL;
  IF TG_TABLE_NAME='return_cases' THEN returnkey:=(raw->>'id')::uuid;
  ELSIF TG_TABLE_NAME IN('return_items','catalog_stock_return_receipts','catalog_stock_return_admissions','catalog_stock_return_documents') THEN returnkey:=(raw->>'return_id')::uuid;
  ELSIF TG_TABLE_NAME='catalog_stock_return_rows' THEN SELECT return_id INTO returnkey FROM catalog_stock_return_documents WHERE(tenant_id,id)=((raw->>'tenant_id')::uuid,(raw->>'document_id')::uuid);
  ELSIF TG_TABLE_NAME IN('catalog_stock_return_stock_maps','catalog_stock_return_item_maps','catalog_stock_return_layer_maps') THEN SELECT d.return_id INTO returnkey FROM catalog_stock_return_rows x JOIN catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(x.tenant_id,x.id)=((raw->>'tenant_id')::uuid,(raw->>'row_id')::uuid);
  END IF;
  IF EXISTS(SELECT FROM b2b_credit_admissions a JOIN b2b_credit_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id) WHERE(a.root_xid,a.transaction_started_at,a.backend_pid)=(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) AND raw->>'tenant_id'=p.tenant_id::text AND(
   CASE WHEN TG_TABLE_NAME='orders' THEN raw->>'id'=p.order_id::text
   WHEN TG_TABLE_NAME='order_merge_claims' THEN raw->>'source_order_id'=p.order_id::text
   WHEN TG_TABLE_NAME IN('local_invoice_series','local_invoice_series_commands') THEN coalesce(raw->>'series_id',raw->>'id')=p.series_id::text
   WHEN TG_TABLE_NAME IN('order_items','documents','invoice_plans','odoo_invoice_exports','b2b_dropship_supplier_orders') THEN raw->>'order_id'=p.order_id::text
   ELSE EXISTS(SELECT FROM return_cases rc WHERE(rc.tenant_id,rc.order_id,rc.id)=(p.tenant_id,p.order_id,returnkey)) END)) THEN
   IF TG_TABLE_NAME='documents' AND TG_OP='INSERT' AND raw->>'mode'='b2b_correction' AND EXISTS(SELECT FROM b2b_credit_admissions own WHERE(own.tenant_id,own.document_id,own.number,own.root_xid,own.transaction_started_at,own.backend_pid)=((raw->>'tenant_id')::uuid,(raw->>'id')::uuid,raw->>'number',pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())) THEN CONTINUE;END IF;
   RAISE EXCEPTION 'Całe źródło korekty160 zapieczętowane do końca transakcji' USING ERRCODE='23514';
  END IF;
 END LOOP;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE FUNCTION b2b_credit_terminal(uid uuid,kid uuid,h text,writing boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE v record;g jsonb;stamp timestamptz;BEGIN
 PERFORM local_invoice_identity(uid,kid,h,writing,true);
 IF NOT b2b_credit_guards() OR NOT b2b_invoice_guards() OR NOT fa3_draft_guards() OR NOT local_invoice_guards() OR NOT catalog_stock_return_guards() THEN RAISE EXCEPTION 'Metadane160 zmieniły się po oczekiwaniu' USING ERRCODE='55000';END IF;
 FOR v IN SELECT document_id FROM b2b_credit_admissions WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND(root_xid,transaction_started_at,backend_pid)=(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) LOOP PERFORM b2b_credit_validate(v.document_id);END LOOP;
 IF EXISTS(SELECT FROM b2b_credit_admissions a JOIN b2b_credit_previews p ON(p.tenant_id,p.id)=(a.tenant_id,a.preview_id) WHERE(a.root_xid,a.transaction_started_at,a.backend_pid)=(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) AND p.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Osobna zgoda160 wygasła podczas oczekiwania' USING ERRCODE='23514';END IF;
 g:=local_invoice_access(uid,kid,true,false);stamp:=clock_timestamp();PERFORM local_invoice_identity(uid,kid,h,writing,false);RETURN g||jsonb_build_object('stamp',stamp);
END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['b2b_credit_previews','b2b_credit_admissions','b2b_credit_receipts'] LOOP
  EXECUTE format('CREATE TRIGGER b2b_credit_record_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION b2b_credit_record_guard()',tab);
  EXECUTE format('CREATE TRIGGER b2b_credit_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_credit_immutable()',tab);
  EXECUTE format('CREATE CONSTRAINT TRIGGER b2b_credit_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_credit_complete()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['orders','order_items','return_cases','return_items','order_merge_claims','documents','invoice_plans','odoo_invoice_exports','b2b_dropship_supplier_orders','catalog_stock_return_receipts','catalog_stock_return_admissions','catalog_stock_return_documents','catalog_stock_return_rows','catalog_stock_return_stock_maps','catalog_stock_return_item_maps','catalog_stock_return_layer_maps'] LOOP
  EXECUTE format('CREATE TRIGGER b2b_credit_source_seal BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_credit_source_seal()',tab);
 END LOOP;
END$$;
CREATE TRIGGER b2b_credit_document_guard BEFORE INSERT OR UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION b2b_credit_document_guard();
CREATE TRIGGER b2b_credit_namespace_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_credit_namespaces FOR EACH ROW EXECUTE FUNCTION b2b_credit_namespace_guard();
CREATE TRIGGER b2b_credit_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_credit_counters FOR EACH ROW EXECUTE FUNCTION b2b_credit_counter_guard();

CREATE FUNCTION public.b2b_credit_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,x.attgenerated,x.attidentity,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND (c.relname LIKE 'b2b\_credit\_%' ESCAPE '\' OR c.relname LIKE 'catalog\_stock\_return\_%' ESCAPE '\' OR c.relname LIKE 'catalog\_stock\_control\_%' ESCAPE '\' OR c.relname LIKE 'b2b\_invoice\_%' ESCAPE '\' OR c.relname LIKE 'fa3\_draft\_%' ESCAPE '\' OR c.relname LIKE 'b2b\_dropship\_%' ESCAPE '\' OR c.relname IN('local_invoice_series','local_invoice_series_commands','orders','order_items','order_merge_claims','return_cases','documents','invoice_plans','odoo_invoice_exports','users','sessions','memberships','api_keys','account_security','workspace_security_policies','tenants','return_items','stock_movements','stock_location_movements','wms_layer_movements','wms_cost_layers','wms_issue_fragments','wms_return_fragments','wms_operations')) AND c.relkind IN('r','p')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,p.proretset,p.prorettype,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.proargmodes,p.proargnames,pg_get_expr(p.proargdefaults,0),(SELECT lanname FROM pg_language WHERE oid=p.prolang),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND ((p.proname LIKE 'b2b\_credit\_%' ESCAPE '\' OR p.proname LIKE 'catalog\_stock\_return\_%' ESCAPE '\' OR p.proname LIKE 'catalog\_stock\_control\_%' ESCAPE '\' OR p.proname LIKE 'b2b\_invoice\_%' ESCAPE '\' OR p.proname LIKE 'fa3\_draft\_%' ESCAPE '\' OR p.proname LIKE 'local\_invoice\_%' ESCAPE '\' OR p.proname LIKE 'b2b\_dropship\_%' ESCAPE '\') OR p.oid IN(SELECT tr.tgfoid FROM pg_trigger tr JOIN pg_class rel ON rel.oid=tr.tgrelid WHERE rel.relnamespace='public'::regnamespace AND NOT tr.tgisinternal AND rel.relname IN('orders','order_items','order_merge_claims','return_cases','documents','invoice_plans','odoo_invoice_exports','users','sessions','memberships','api_keys','account_security','workspace_security_policies','tenants')))),
 'documents_checks',(SELECT jsonb_agg(jsonb_build_array(conname,convalidated,pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.documents'::regclass AND conname IN('documents_kind_check','documents_proforma_local','documents_native_invoice')),
 'document_indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid)) ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN('document_order_mode','document_demo_number')),
 'parent_triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE tgfoid IN(SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'b2b\_credit\_%' ESCAPE '\' OR proname LIKE 'b2b\_invoice\_%' ESCAPE '\' OR proname LIKE 'fa3\_draft\_%' ESCAPE '\' OR proname LIKE 'b2b\_dropship\_%' ESCAPE '\')))
 )::text) $$;

CREATE OR REPLACE FUNCTION b2b_invoice_upgrade_valid() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE sig text;c record;BEGIN
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b\_credit\_%' ESCAPE '\') OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b\_credit\_%' ESCAPE '\') OR EXISTS(SELECT FROM migrations WHERE name='160_b2b_credit') OR EXISTS(SELECT FROM pg_trigger WHERE tgname LIKE 'b2b\_credit\_%' ESCAPE '\') OR EXISTS(SELECT FROM pg_constraint WHERE conname='documents_b2b_credit') THEN
  IF to_regprocedure('public.b2b_credit_upgrade_valid()') IS NULL THEN RETURN false;END IF;RETURN b2b_credit_upgrade_valid();
 END IF;
 IF current_setting('session_replication_role')<>'origin' OR to_regclass('public.b2b_invoice_upgrade') IS NULL OR to_regclass('public.fa3_draft_manifest') IS NULL OR to_regprocedure('public.fa3_draft_fingerprint()') IS NULL THEN RETURN false;END IF;
 FOREACH sig IN ARRAY ARRAY['b2b_invoice_locks(uuid)','b2b_invoice_namespace_guard()','b2b_invoice_installed()','b2b_invoice_immutable()','b2b_invoice_require(uuid,uuid,text,boolean,boolean)','b2b_invoice_source(jsonb,boolean)','b2b_invoice_snapshot(uuid,jsonb,boolean)','b2b_invoice_preview(uuid,jsonb,uuid,uuid,text)','b2b_invoice_issue(uuid,jsonb,uuid,uuid,text)','b2b_invoice_budget(uuid)','b2b_invoice_record_guard()','b2b_invoice_document_guard()','b2b_invoice_counter_guard()','b2b_invoice_validate(uuid)','b2b_invoice_complete()','b2b_invoice_source_seal()','b2b_invoice_terminal(uuid,uuid,text,boolean)','b2b_invoice_upgrade_guard()','b2b_invoice_fingerprint()','b2b_invoice_upgrade_valid()','b2b_invoice_guards()'] LOOP IF to_regprocedure('public.'||sig) IS NULL THEN RETURN false;END IF;END LOOP;
 IF(SELECT count(*) FROM b2b_invoice_upgrade)<>1 OR(SELECT count(*) FROM fa3_draft_manifest)<>1 THEN RETURN false;END IF;
 SELECT * INTO c FROM b2b_invoice_upgrade WHERE id;
 RETURN coalesce(c.profile='158-original-to159-local-issued/v1' AND c.original_manifest=(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id)
 AND c.predecessor_fingerprint=c.original_manifest->>'fingerprint' AND c.successor158_fingerprint=fa3_draft_fingerprint()
 AND c.successor159_fingerprint=b2b_invoice_fingerprint(),false);
END$$;

CREATE OR REPLACE FUNCTION fa3_draft_invoice_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE rowdata jsonb;BEGIN
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;rowdata:=to_jsonb(NEW);

 IF TG_TABLE_NAME='documents' AND TG_OP='INSERT' AND rowdata->>'mode'='b2b_correction' AND rowdata->>'kind'='correction'
 AND to_regprocedure('public.b2b_credit_guards()') IS NOT NULL THEN
  IF b2b_credit_guards() AND EXISTS(SELECT FROM b2b_credit_admissions own JOIN b2b_credit_previews p ON(p.tenant_id,p.id)=(own.tenant_id,own.preview_id)
   WHERE(own.tenant_id,own.document_id,own.number,own.root_xid,own.transaction_started_at,own.backend_pid)=((rowdata->>'tenant_id')::uuid,(rowdata->>'id')::uuid,rowdata->>'number',pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())
   AND(p.order_id,p.return_id)=((rowdata->>'order_id')::uuid,(rowdata->>'return_id')::uuid)
   AND rowdata->'data'=(p.snapshot||jsonb_build_object('number',own.number,'year',own.year,'sequence',own.sequence,'preview_id',p.id,'scope_hash',p.scope_hash))) THEN RETURN NEW;END IF;
 END IF;
 -- One certified new native command, no general mode/protocol exception.
 IF TG_TABLE_NAME='documents' AND TG_OP='INSERT' AND rowdata->>'mode'='b2b_invoice' AND rowdata->>'kind'='invoice'
 AND b2b_invoice_guards() AND EXISTS(SELECT FROM b2b_invoice_admissions own JOIN b2b_invoice_previews p ON(p.tenant_id,p.id)=(own.tenant_id,own.preview_id)
 WHERE(own.tenant_id,own.document_id,own.number)=((rowdata->>'tenant_id')::uuid,(rowdata->>'id')::uuid,rowdata->>'number') AND p.order_id=(rowdata->>'order_id')::uuid
 AND(own.root_xid,own.transaction_started_at)=(pg_current_xact_id(),transaction_timestamp())
 AND rowdata->'data'=(p.snapshot||jsonb_build_object('number',own.number,'year',own.year,'sequence',own.sequence,'preview_id',p.id,'scope_hash',p.scope_hash))) THEN RETURN NEW;END IF;
 IF((TG_TABLE_NAME='documents' AND rowdata->>'kind' IN('invoice','correction')) OR TG_TABLE_NAME='local_invoice_previews'
 OR(TG_TABLE_NAME='invoice_plans' AND rowdata->>'kind'='invoice' AND rowdata->>'mode'='external' AND rowdata->>'state' NOT IN('preview','cancelled'))
 OR(TG_TABLE_NAME='odoo_invoice_exports' AND rowdata->>'mode'='external' AND rowdata->>'state' NOT IN('preview','cancelled')))
 AND EXISTS(SELECT FROM fa3_draft_projects WHERE(tenant_id,order_id)=((rowdata->>'tenant_id')::uuid,(rowdata->>'order_id')::uuid)) THEN RAISE EXCEPTION 'Zamówienie ma zatwierdzony projekt B2B; wymagany odrębny proces wystawienia' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;

-- Leaf is metadata-only. No ancestor/full guards/identity/source recursion.
CREATE FUNCTION b2b_credit_upgrade_valid() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE c record;sig text;tab text;BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RETURN false;END IF;
 FOREACH tab IN ARRAY ARRAY['local_invoice_manifest','fa3_draft_manifest','b2b_invoice_upgrade','b2b_credit_upgrade','b2b_credit_previews','b2b_credit_admissions','b2b_credit_receipts','b2b_credit_counters','b2b_credit_namespaces'] LOOP IF to_regclass('public.'||tab) IS NULL THEN RETURN false;END IF;END LOOP;
 FOREACH sig IN ARRAY ARRAY['local_invoice_fingerprint()','fa3_draft_fingerprint()','b2b_invoice_fingerprint()','b2b_credit_fingerprint()','b2b_credit_upgrade_valid()','b2b_credit_guards()','b2b_credit_installed()','b2b_credit_terminal(uuid,uuid,text,boolean)','b2b_credit_physical(uuid)','b2b_credit_history(uuid)','b2b_credit_previous(uuid)','b2b_credit_basis(uuid,uuid)','b2b_credit_calculate(jsonb)','b2b_credit_preview(jsonb,jsonb,jsonb,uuid,uuid,text)','b2b_credit_issue(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)','b2b_credit_upgrade_guard()','b2b_credit_record_guard()','b2b_credit_document_guard()','b2b_credit_namespace_guard()','b2b_credit_counter_guard()','b2b_credit_complete()','b2b_credit_source_seal()','b2b_invoice_upgrade_valid()','fa3_draft_invoice_seal()'] LOOP IF to_regprocedure('public.'||sig) IS NULL THEN RETURN false;END IF;END LOOP;
 IF(SELECT count(*) FROM b2b_credit_upgrade)<>1 OR(SELECT count(*) FROM local_invoice_manifest)<>1 OR(SELECT count(*) FROM fa3_draft_manifest)<>1 OR(SELECT count(*) FROM b2b_invoice_upgrade)<>1
 OR to_regclass('public.document_order_mode') IS NULL OR to_regclass('public.document_return_mode') IS NULL THEN RETURN false;END IF;

 IF NOT EXISTS(SELECT FROM migrations WHERE name='160_b2b_credit') THEN
  -- Bootstrap exception is a real owner-created native migration transcript,
  -- not an app GUC, public boolean, or a partial runtime successor fallback.
  IF to_regclass('pg_temp.b2b_credit_migration_basis') IS NULL THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT FROM pg_class WHERE oid=to_regclass('pg_temp.b2b_credit_migration_basis') AND relowner=(SELECT relowner FROM pg_class WHERE oid='public.b2b_credit_upgrade'::regclass)) THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT FROM pg_temp.b2b_credit_migration_basis WHERE(root_xid,transaction_started_at,backend_pid,migration_owner)=(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid(),session_user::text)) THEN RETURN false;END IF;
 END IF;
 SELECT * INTO c FROM b2b_credit_upgrade WHERE id;
 RETURN coalesce(c.profile='157-158-159-original-to160-return-credit/v1'
 AND c.original157=(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id)
 AND c.original158=(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id)
 AND c.original159=(SELECT to_jsonb(m) FROM b2b_invoice_upgrade m WHERE id)
 AND c.predecessor157=c.original157->>'fingerprint' AND c.predecessor158=c.original159->>'successor158_fingerprint' AND c.predecessor159=c.original159->>'successor159_fingerprint'
 AND c.successor157=c.predecessor157 AND c.successor157=local_invoice_fingerprint() AND c.successor158=fa3_draft_fingerprint() AND c.successor159=b2b_invoice_fingerprint() AND c.successor160=b2b_credit_fingerprint()
 AND c.original014_indexes=(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indexrelid IN('public.document_order_mode'::regclass,'public.document_return_mode'::regclass)),false);
END$$;
CREATE FUNCTION b2b_credit_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF to_regprocedure('public.b2b_credit_installed()') IS NULL OR to_regprocedure('public.b2b_credit_upgrade_valid()') IS NULL THEN RETURN false;END IF;
 IF NOT b2b_credit_installed() OR(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b\_credit\_%' ESCAPE '\' AND relkind IN('r','p') AND relrowsecurity AND relforcerowsecurity)<>6 THEN RETURN false;END IF;RETURN b2b_credit_upgrade_valid();
END$$;
CREATE FUNCTION b2b_credit_upgrade_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP<>'INSERT' OR to_regclass('pg_temp.b2b_credit_migration_basis') IS NULL THEN RAISE EXCEPTION 'Niezmienny certyfikat160' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM pg_temp.b2b_credit_migration_basis b WHERE(NEW.original157,NEW.original158,NEW.original159,NEW.predecessor157,NEW.predecessor158,NEW.predecessor159,NEW.replaced_functions,NEW.original014_indexes) IS NOT DISTINCT FROM(b.original157,b.original158,b.original159,b.predecessor157,b.predecessor158,b.predecessor159,b.replaced_functions,b.original014_indexes))
 OR NEW.original157 IS DISTINCT FROM(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id) OR NEW.original158 IS DISTINCT FROM(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id) OR NEW.original159 IS DISTINCT FROM(SELECT to_jsonb(m) FROM b2b_invoice_upgrade m WHERE id)
 OR NEW.successor157 IS DISTINCT FROM local_invoice_fingerprint() OR NEW.successor157 IS DISTINCT FROM NEW.predecessor157
 OR NEW.successor158 IS DISTINCT FROM fa3_draft_fingerprint() OR NEW.successor159 IS DISTINCT FROM b2b_invoice_fingerprint() OR NEW.successor160 IS DISTINCT FROM b2b_credit_fingerprint()
 THEN RAISE EXCEPTION 'Certyfikat160 nie odpowiada pełnemu uprawnionemu upgrade' USING ERRCODE='55000';END IF;RETURN NEW;
END$$;
CREATE TRIGGER b2b_credit_upgrade_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_credit_upgrade FOR EACH ROW EXECUTE FUNCTION b2b_credit_upgrade_guard();
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT p.oid::regprocedure sig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'b2b\_credit\_%' ESCAPE '\' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig);END LOOP;END$$;
GRANT EXECUTE ON FUNCTION b2b_credit_installed(),b2b_credit_guards(),b2b_credit_terminal(uuid,uuid,text,boolean) TO dyna_app;
INSERT INTO b2b_credit_upgrade(id,profile,original157,original158,original159,predecessor157,predecessor158,predecessor159,replaced_functions,original014_indexes,successor157,successor158,successor159,successor160)
 SELECT true,'157-158-159-original-to160-return-credit/v1',original157,original158,original159,predecessor157,predecessor158,predecessor159,replaced_functions,original014_indexes,local_invoice_fingerprint(),fa3_draft_fingerprint(),b2b_invoice_fingerprint(),b2b_credit_fingerprint() FROM pg_temp.b2b_credit_migration_basis;
DO $$BEGIN IF NOT b2b_credit_upgrade_valid() OR NOT local_invoice_guards() OR NOT fa3_draft_guards() OR NOT b2b_invoice_guards() OR NOT catalog_stock_return_guards() THEN RAISE EXCEPTION 'Upgrade160 nie zachował rodziców/metadanych' USING ERRCODE='55000';END IF;END$$;
