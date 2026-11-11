-- Independent ordinary PL/PLN consumer credit. No ancestor manifest, function or parent trigger is rewritten.
DO $$BEGIN IF session_user<>'postgres' OR current_user<>'postgres' OR NOT public.local_invoice_guards() OR NOT public.catalog_stock_return_guards() OR NOT public.b2b_credit_guards() THEN RAISE EXCEPTION 'Niepełny rzeczywisty poprzednik188' USING ERRCODE='55000';END IF;END$$;
CREATE TABLE local_consumer_credit_previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,original_document_id uuid NOT NULL,original_receipt_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,calculation_hash text NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,original_document_id) REFERENCES documents(tenant_id,id),FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES local_invoice_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$' AND calculation_hash~'^[a-f0-9]{64}$' AND expires_at>created_at AND octet_length(snapshot::text)<=2097152));
CREATE TABLE local_consumer_credit_documents(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,original_document_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,kind text NOT NULL CHECK(kind='correction'),mode text NOT NULL CHECK(mode='local_consumer_credit'),number text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,return_id),UNIQUE(tenant_id,number),FOREIGN KEY(tenant_id,original_document_id) REFERENCES documents(tenant_id,id),FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),CHECK(octet_length(data::text)<=2097152));
CREATE TABLE local_consumer_credit_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,original_document_id uuid NOT NULL,original_receipt_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,return_receipt_id uuid NOT NULL,receipt_sequence integer NOT NULL,previous_receipt_id uuid,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,calculation_hash text NOT NULL,snapshot jsonb NOT NULL,series_id uuid NOT NULL,year integer NOT NULL,sequence integer NOT NULL,number text NOT NULL,
 root_xid xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,backend_pid integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,return_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,series_id,year,sequence),
 FOREIGN KEY(tenant_id,document_id) REFERENCES local_consumer_credit_documents(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES local_consumer_credit_previews(tenant_id,id),FOREIGN KEY(tenant_id,original_document_id) REFERENCES documents(tenant_id,id),FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES local_invoice_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,return_receipt_id) REFERENCES catalog_stock_return_receipts(tenant_id,id),FOREIGN KEY(tenant_id,previous_receipt_id) REFERENCES local_consumer_credit_receipts(tenant_id,id),FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(receipt_sequence BETWEEN 1 AND 1000 AND year BETWEEN 2006 AND 2050 AND sequence BETWEEN 1 AND 999999));
CREATE TABLE local_consumer_credit_counters(tenant_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL,last_number integer NOT NULL CHECK(last_number BETWEEN 0 AND 999999),PRIMARY KEY(tenant_id,series_id,year),FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id));
CREATE TABLE local_consumer_credit_manifest(id boolean PRIMARY KEY CHECK(id),profile text NOT NULL CHECK(profile='157+139+169-original-to188-consumer-credit/v1'),fingerprint text NOT NULL,original157 jsonb NOT NULL,original160 jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX local_consumer_credit_page ON local_consumer_credit_documents(tenant_id,created_at DESC,id DESC);
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['local_consumer_credit_previews','local_consumer_credit_documents','local_consumer_credit_receipts','local_consumer_credit_counters'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 EXECUTE format('CREATE POLICY owner_scope ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);EXECUTE format('GRANT SELECT ON %I TO dyna_app',tab);
 END LOOP;END$$;
ALTER TABLE local_consumer_credit_manifest ENABLE ROW LEVEL SECURITY;ALTER TABLE local_consumer_credit_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON local_consumer_credit_manifest TO CURRENT_USER USING(true) WITH CHECK(true);REVOKE ALL ON local_consumer_credit_manifest FROM PUBLIC,dyna_app;
CREATE FUNCTION local_consumer_credit_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT encode(sha256(convert_to(public.local_invoice_canonical(v),'UTF8')),'hex')$$;
CREATE FUNCTION local_consumer_credit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Niezmienny consumer credit188' USING ERRCODE='23514';END$$;
CREATE FUNCTION local_consumer_credit_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NOT public.local_consumer_credit_installed() OR NOT public.local_consumer_credit_guards() OR NOT public.local_invoice_guards() OR NOT public.catalog_stock_return_guards() THEN RAISE EXCEPTION 'Niepełny profil188' USING ERRCODE='55000';END IF;
 PERFORM public.local_invoice_require(uid,kid,writing,pin);
END$$;
CREATE FUNCTION local_consumer_credit_history(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_return_admissions;r public.catalog_stock_return_receipts;rc public.return_cases;op public.wms_operations;
 item jsonb;expected jsonb;return_document_head record;n jsonb;actual jsonb;wanted jsonb;
BEGIN
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_return_receipts WHERE(tenant_id,id)=(a.tenant_id,a.id);
 IF a.id IS NULL OR r.id IS NULL OR NOT a.sealed OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR(a.txid=pg_current_xact_id() AND r.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Brak pełnej zgody dokumentu zwrotu' USING ERRCODE='23514';END IF;
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 IF a.protocol NOT IN('rma','assistant_v1') OR (a.protocol='rma' AND r.assistant_receipt_id IS NOT NULL) OR (a.protocol='assistant_v1' AND r.assistant_receipt_id IS NULL) OR r.exchange_id IS NOT NULL OR r.dropship_admission_id IS NOT NULL OR r.local_proof_id IS NOT NULL OR r.parcel_receipt_return_id IS NOT NULL
 OR r.snapshot#>>'{return_case,state}'<>'refund_pending' OR r.snapshot#>>'{return_case,remedy}'<>'refund' OR rc.state NOT IN('refund_pending','closed')
 OR rc.version<(r.snapshot#>>'{return_case,version}')::bigint
 OR to_jsonb(rc)-ARRAY['state','version','updated_at','refunded_at','settlement'] IS DISTINCT FROM(r.snapshot->'return_case')-ARRAY['state','version','updated_at','refunded_at','settlement'] THEN RAISE EXCEPTION 'Nieobsługiwany lub zmieniony historical receipt169' USING ERRCODE='23514';END IF;
 -- Historical139 receipt is accepted only via its immutable native admission/preview lineage,
 -- exact original receive_input and sealed169 actor/APIkey/root transaction. No new replay.
 IF a.protocol='assistant_v1' THEN
  IF NOT EXISTS(SELECT FROM public.return_assistant_receipts ar
   JOIN public.return_assistant_previews ap ON(ap.tenant_id,ap.id,ap.session_id,ap.return_id)=(ar.tenant_id,ar.preview_id,ar.session_id,ar.return_id)
   JOIN public.return_assistant_admissions aa ON(aa.tenant_id,aa.receipt_id,aa.transaction_id)=(ar.tenant_id,ar.id,a.txid)
   WHERE(ar.tenant_id,ar.id,ar.return_id,ar.order_id,ar.preview_id,ar.actor_id)=(a.tenant_id,r.assistant_receipt_id,a.return_id,a.order_id,a.preview_id,a.actor_id)
   AND ar.api_key_id IS NOT DISTINCT FROM a.api_key_id AND ar.payload=ap.payload AND ar.scope_hash=ap.scope_hash
   AND(ar.preview_id,ar.session_id,ar.return_id,ar.actor_id,ar.api_key_id,ar.client_key,ar.request_hash,ar.payload)
    IS NOT DISTINCT FROM(aa.preview_id,aa.session_id,aa.return_id,aa.actor_id,aa.api_key_id,aa.client_key,aa.request_hash,aa.payload)
   AND ar.payload->>'action'='receive' AND ar.payload->'receive_input'=a.frame->'request'
   AND ar.result->'receipt'=r.snapshot#>'{return_case,receipt}'
   AND(ar.result->>'refund_amount')::bigint=(r.snapshot#>>'{return_case,refund_amount}')::bigint
   AND(ar.result->>'refunded_shipping')::bigint=(r.snapshot#>>'{return_case,refunded_shipping}')::bigint
   AND jsonb_array_length(aa.witnesses)<=10000) THEN
   RAISE EXCEPTION 'Niepełny historical139/169 parent188' USING ERRCODE='23514';END IF;
 END IF;
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

CREATE FUNCTION local_consumer_credit_source(did uuid,selected_return uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d documents;ir local_invoice_receipts;o orders;rc record;rr catalog_stock_return_receipts; financial jsonb;acceptances jsonb:='[]';previousj jsonb:='[]';cr record;prev uuid;seq integer:=0;resultj jsonb;BEGIN
 PERFORM public.local_invoice_locks();SELECT * INTO d FROM public.documents WHERE(tenant_id,id)=(t,did);
 IF d.id IS NULL OR d.kind<>'invoice' OR d.mode<>'local_invoice' THEN RAISE EXCEPTION 'Brak prawdziwej FV157' USING ERRCODE='P0002';END IF;
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,d.order_id) FOR UPDATE;
 SELECT * INTO ir FROM public.local_invoice_receipts WHERE(tenant_id,document_id)=(t,d.id);
 IF ir.id IS NULL OR(d.order_id,d.number) IS DISTINCT FROM(ir.order_id,ir.number)
 OR d.data IS DISTINCT FROM(ir.snapshot||jsonb_build_object('number',ir.number,'preview_id',ir.preview_id,'scope_hash',ir.scope_hash,'local_only',true,'ksef_state','not_submitted','fiscalized',false))
 OR ir.scope_hash IS DISTINCT FROM public.local_invoice_hash(ir.snapshot) OR ir.snapshot->>'currency'<>'PLN' OR ir.snapshot#>>'{buyer,kind}'<>'consumer'
 OR ir.snapshot#>>'{buyer,address,country}'<>'PL' OR ir.snapshot->>'tax_regime'<>'ordinary_domestic' OR ir.snapshot->>'rounding_method'<>'gross_line_half_up'
 OR o.currency<>'PLN' OR o.fulfillment_kind<>'sale' THEN RAISE EXCEPTION 'Obcy original157 snapshot188' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM documents x WHERE(x.tenant_id,x.order_id,x.kind)=(t,o.id,'correction')) OR EXISTS(SELECT FROM invoice_plans x WHERE(x.tenant_id,x.order_id,x.kind)=(t,o.id,'correction') AND x.state NOT IN('preview','cancelled')) THEN RAISE EXCEPTION 'Istniejąca inna korekta wymaga odrębnego uzgodnienia' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.return_cases WHERE(tenant_id,order_id)=(t,o.id) AND received_at IS NOT NULL)>1000 OR (SELECT coalesce(sum(pg_column_size(payload_return.snapshot)),0) FROM public.catalog_stock_return_receipts payload_return WHERE(payload_return.tenant_id,payload_return.order_id)=(t,o.id))+(SELECT coalesce(sum(pg_column_size(payload_credit.snapshot)),0) FROM public.local_consumer_credit_receipts payload_credit WHERE(payload_credit.tenant_id,payload_credit.original_document_id)=(t,did))+pg_column_size(ir.snapshot)>33554432 THEN RAISE EXCEPTION 'Limit pełnej historii188' USING ERRCODE='54000';END IF;
 FOR rc IN SELECT * FROM public.return_cases WHERE(tenant_id,order_id)=(t,o.id) AND received_at IS NOT NULL ORDER BY receipt_sequence,id FOR SHARE LOOP
  seq:=seq+1;
  IF rc.legacy OR rc.remedy<>'refund' OR rc.state NOT IN('refund_pending','closed') OR rc.receipt_sequence<>seq THEN RAISE EXCEPTION 'Nieobsługiwany lub niepełny ciąg RMA188' USING ERRCODE='23514';END IF;
  SELECT * INTO rr FROM public.catalog_stock_return_receipts WHERE(tenant_id,return_id,order_id)=(t,rc.id,o.id);
  IF rr.id IS NULL THEN RAISE EXCEPTION 'Brak actual physical169 receipt188' USING ERRCODE='23514';END IF;
  PERFORM public.local_consumer_credit_history(rr.id);
  financial:=jsonb_build_object('return_id',rc.id,'receipt_id',rr.id,'receipt_sequence',rc.receipt_sequence,
   'received_at',to_char((rr.snapshot#>>'{return_case,received_at}')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'refund_amount_minor',rr.snapshot#>>'{return_case,refund_amount}','refunded_shipping_minor',rr.snapshot#>>'{return_case,refunded_shipping}',
   'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',x->'item_id','accepted',(x->>'accepted')::bigint::text,'restocked',(x->>'restocked')::bigint::text,'refund_amount_minor',(x->>'refund_amount')::bigint::text) ORDER BY x->>'item_id'),'[]') FROM jsonb_array_elements(rr.snapshot->'items')x));
  acceptances:=acceptances||jsonb_build_array(financial||jsonb_build_object('financial_hash',public.local_consumer_credit_hash(financial)));
 END LOOP;
 FOR cr IN SELECT r.*,dc.data,dc.number doc_number FROM public.local_consumer_credit_receipts r JOIN public.local_consumer_credit_documents dc ON(dc.tenant_id,dc.id)=(r.tenant_id,r.document_id) WHERE(r.tenant_id,r.original_document_id)=(t,did) ORDER BY r.receipt_sequence,r.id LOOP
  IF cr.receipt_sequence<>jsonb_array_length(previousj)+1 OR cr.previous_receipt_id IS DISTINCT FROM prev OR cr.data IS DISTINCT FROM(cr.snapshot||jsonb_build_object('number',cr.number,'year',cr.year,'sequence',cr.sequence,'preview_id',cr.preview_id,'scope_hash',cr.scope_hash)) OR cr.number IS DISTINCT FROM cr.doc_number OR cr.calculation_hash IS DISTINCT FROM public.local_consumer_credit_hash(cr.snapshot->'calculation') THEN RAISE EXCEPTION 'Niepełny previous credit188' USING ERRCODE='23514';END IF;
  previousj:=previousj||jsonb_build_array(jsonb_build_object('document_id',cr.document_id,'receipt_id',cr.id,'return_id',cr.return_id,'return_receipt_id',cr.return_receipt_id,'receipt_sequence',cr.receipt_sequence,'calculation',cr.snapshot->'calculation','calculation_hash',cr.calculation_hash));prev:=cr.id;
 END LOOP;
 resultj:=jsonb_build_object('original',jsonb_build_object('document',jsonb_build_object('id',d.id,'order_id',d.order_id,'number',d.number,'kind',d.kind,'mode',d.mode,'data',d.data,'created_at',to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),'receipt',jsonb_build_object('id',ir.id,'document_id',ir.document_id,'preview_id',ir.preview_id,'number',ir.number,'scope_hash',ir.scope_hash,'snapshot',ir.snapshot)),'acceptances',acceptances,'previous_credits',previousj,'selected_return_id',selected_return);
 IF octet_length(resultj::text)>33554432 THEN RAISE EXCEPTION 'Całe źródło188 przekracza32MiB' USING ERRCODE='54000';END IF;RETURN resultj;
END$$;
CREATE FUNCTION local_consumer_credit_money(g numeric,rate integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE v numeric;BEGIN IF g<0 OR g>9223372036854775807 OR g<>trunc(g) OR rate NOT IN(0,5,8,23) THEN RAISE EXCEPTION 'Niepoprawna kwota188' USING ERRCODE='22023';END IF;v:=floor((2*g*rate+100+rate)/(2*(100+rate)));RETURN jsonb_build_object('gross_minor',g::bigint::text,'net_minor',(g-v)::bigint::text,'vat_minor',v::bigint::text);END$$;
CREATE FUNCTION local_consumer_credit_sum(xs jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT jsonb_build_object('gross_minor',coalesce(sum((x->>'gross_minor')::numeric),0)::bigint::text,'net_minor',coalesce(sum((x->>'net_minor')::numeric),0)::bigint::text,'vat_minor',coalesce(sum((x->>'vat_minor')::numeric),0)::bigint::text) FROM jsonb_array_elements(xs)x$$;
CREATE FUNCTION local_consumer_credit_minus(a jsonb,b jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT jsonb_build_object('gross_minor',((a->>'gross_minor')::numeric-(b->>'gross_minor')::numeric)::bigint::text,'net_minor',((a->>'net_minor')::numeric-(b->>'net_minor')::numeric)::bigint::text,'vat_minor',((a->>'vat_minor')::numeric-(b->>'vat_minor')::numeric)::bigint::text)$$;
CREATE FUNCTION local_consumer_credit_calculate(x jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE f jsonb:=x#>'{original,document,data}';d jsonb:=x#>'{original,document}';ir jsonb:=x#>'{original,receipt}';accepted jsonb:='{}';prior jsonb;shipping numeric:=0;prior_shipping numeric;a jsonb;it jsonb;ln jsonb;pc jsonb;rowsj jsonb;rowj jsonb;calc jsonb;resultj jsonb;bm jsonb;am jsonb;bt jsonb;atj jsonb;vatj jsonb;g numeric;q numeric;p numeric;n numeric;bg numeric;ag numeric;bq numeric;aq numeric;refund numeric;units numeric;ix integer:=0;ordinal integer;selected integer:=jsonb_array_length(x->'previous_credits');chain text;rate integer;BEGIN
 IF octet_length(x::text)>33554432 OR jsonb_array_length(x->'acceptances') NOT BETWEEN 1 AND 1000 OR jsonb_array_length(f->'lines') NOT BETWEEN 1 AND 101 THEN RAISE EXCEPTION 'Niepełna pełna historia188' USING ERRCODE='22023';END IF;
 IF x#>>ARRAY['acceptances',selected::text,'return_id'] IS DISTINCT FROM x->>'selected_return_id' THEN RAISE EXCEPTION 'Wybierz najwcześniejszy nieskorygowany zwrot188' USING ERRCODE='23514';END IF;
 chain:=public.local_consumer_credit_hash(jsonb_build_object('original_document_id',d->'id','original_receipt_id',ir->'id'));
 FOR a IN SELECT value FROM jsonb_array_elements(x->'acceptances') LOOP
  IF(a->>'receipt_sequence')::integer<>ix+1 OR public.local_consumer_credit_hash(a-'financial_hash')<>a->>'financial_hash' OR(a->>'received_at')::date<(f->>'issue_date')::date THEN RAISE EXCEPTION 'Obcy birth financial188' USING ERRCODE='23514';END IF;
  prior:=accepted;prior_shipping:=shipping;refund:=0;units:=0;
  FOR it IN SELECT value FROM jsonb_array_elements(a->'items') LOOP
   SELECT val INTO ln FROM jsonb_array_elements(f->'lines')val WHERE val->>'kind'='item' AND val->>'item_id'=it->>'item_id';
   IF ln IS NULL THEN RAISE EXCEPTION 'Obca pozycja188' USING ERRCODE='23514';END IF;q:=(ln->>'quantity')::numeric;g:=(ln->>'gross_minor')::numeric;p:=coalesce((accepted->> (it->>'item_id'))::numeric,0);n:=(it->>'accepted')::numeric;
   IF n<0 OR n<>trunc(n) OR(it->>'restocked')::numeric NOT BETWEEN 0 AND n OR p+n>q OR(it->>'refund_amount_minor')::numeric<>floor(g*(p+n)/q)-floor(g*p/q) THEN RAISE EXCEPTION 'Przekroczony zakres/skala RMA188' USING ERRCODE='23514';END IF;
   accepted:=jsonb_set(accepted,ARRAY[it->>'item_id'],to_jsonb((p+n)::bigint::text));refund:=refund+(it->>'refund_amount_minor')::numeric;units:=units+n;
  END LOOP;
  shipping:=shipping+(a->>'refunded_shipping_minor')::numeric;refund:=refund+(a->>'refunded_shipping_minor')::numeric;
  IF units<=0 OR shipping>(f#>>'{order,shipping_cost_minor}')::numeric OR refund<>(a->>'refund_amount_minor')::numeric THEN RAISE EXCEPTION 'Inne całkowite pieniądze188' USING ERRCODE='23514';END IF;
  IF ix>selected THEN ix:=ix+1;CONTINUE;END IF;rowsj:='[]';ordinal:=0;
  FOR ln IN SELECT value FROM jsonb_array_elements(f->'lines') LOOP
   q:=(ln->>'quantity')::numeric;g:=(ln->>'gross_minor')::numeric;rate:=(ln->>'vat_rate')::integer;
   IF ln->>'kind'='shipping' THEN p:=prior_shipping;n:=shipping;bg:=g-p;ag:=g-n;bq:=1;aq:=1;
   ELSE p:=coalesce((prior->>(ln->>'item_id'))::numeric,0);n:=coalesce((accepted->>(ln->>'item_id'))::numeric,0);bg:=g-floor(g*p/q);ag:=g-floor(g*n/q);bq:=q-p;aq:=q-n;END IF;
   bm:=public.local_consumer_credit_money(bg,rate);am:=public.local_consumer_credit_money(ag,rate);
   rowj:=jsonb_build_object('ordinal',ordinal,'kind',ln->'kind','item_id',ln->'item_id','product_id',ln->'product_id','name',ln->'name','sku',ln->'sku','unit',ln->'unit','vat_rate',rate,'before',bm||jsonb_build_object('quantity',bq::bigint::text),'after',am||jsonb_build_object('quantity',aq::bigint::text),'delta',public.local_consumer_credit_minus(am,bm)||jsonb_build_object('quantity',(aq-bq)::bigint::text),'affected',p<>n);
   rowsj:=rowsj||jsonb_build_array(rowj);ordinal:=ordinal+1;
  END LOOP;
  bt:=public.local_consumer_credit_sum((SELECT jsonb_agg(v->'before') FROM jsonb_array_elements(rowsj)v));atj:=public.local_consumer_credit_sum((SELECT jsonb_agg(v->'after') FROM jsonb_array_elements(rowsj)v));vatj:='[]';
  FOR rate IN SELECT DISTINCT(value->>'vat_rate')::integer FROM jsonb_array_elements(rowsj) ORDER BY 1 LOOP
   bm:=public.local_consumer_credit_sum((SELECT jsonb_agg(v->'before') FROM jsonb_array_elements(rowsj)v WHERE(v->>'vat_rate')::integer=rate));am:=public.local_consumer_credit_sum((SELECT jsonb_agg(v->'after') FROM jsonb_array_elements(rowsj)v WHERE(v->>'vat_rate')::integer=rate));vatj:=vatj||jsonb_build_array(jsonb_build_object('vat_rate',rate,'before',bm,'after',am,'delta',public.local_consumer_credit_minus(am,bm)));
  END LOOP;
  calc:=jsonb_build_object('schema','local-consumer-credit-calculation/v1','currency','PLN','tax_method','gross_line_half_up','original_document_id',d->'id','original_receipt_id',ir->'id','original_number',d->'number','original_scope_hash',ir->'scope_hash','return_id',a->'return_id','return_receipt_id',a->'receipt_id','receipt_sequence',a->'receipt_sequence','financial_hash',a->'financial_hash','previous_chain_hash',chain,'rows',rowsj,'totals',jsonb_build_object('before',bt,'after',atj,'delta',public.local_consumer_credit_minus(atj,bt)),'vat_totals',vatj);
  IF ix<selected THEN pc:=x->'previous_credits'->ix;IF pc->'calculation' IS DISTINCT FROM calc OR pc->>'calculation_hash'<>public.local_consumer_credit_hash(calc) OR pc->'return_id' IS DISTINCT FROM a->'return_id' OR pc->'return_receipt_id' IS DISTINCT FROM a->'receipt_id' THEN RAISE EXCEPTION 'Zmiana poprzedniej KOR188' USING ERRCODE='23514';END IF;chain:=public.local_consumer_credit_hash(pc);ELSE resultj:=calc;END IF;ix:=ix+1;
 END LOOP;RETURN resultj;
END$$;
CREATE TABLE local_consumer_credit_namespaces(seller_tax_id text NOT NULL,prefix text NOT NULL,tenant_id uuid NOT NULL REFERENCES tenants,series_id uuid NOT NULL,PRIMARY KEY(seller_tax_id,prefix),UNIQUE(tenant_id,series_id),FOREIGN KEY(tenant_id,series_id) REFERENCES local_invoice_series(tenant_id,id));
ALTER TABLE local_consumer_credit_namespaces ENABLE ROW LEVEL SECURITY;ALTER TABLE local_consumer_credit_namespaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON local_consumer_credit_namespaces TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY owner_scope ON local_consumer_credit_namespaces TO CURRENT_USER USING(true) WITH CHECK(true);REVOKE ALL ON local_consumer_credit_namespaces FROM PUBLIC,dyna_app;GRANT SELECT ON local_consumer_credit_namespaces TO dyna_app;
CREATE TABLE local_consumer_credit_admissions(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,document_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,number text NOT NULL,year integer NOT NULL,sequence integer NOT NULL,root_xid xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,backend_pid integer NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),FOREIGN KEY(tenant_id,document_id) REFERENCES local_consumer_credit_documents(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,preview_id) REFERENCES local_consumer_credit_previews(tenant_id,id),FOREIGN KEY(tenant_id,id) REFERENCES local_consumer_credit_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED);
ALTER TABLE local_consumer_credit_admissions ENABLE ROW LEVEL SECURITY;ALTER TABLE local_consumer_credit_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON local_consumer_credit_admissions TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY owner_scope ON local_consumer_credit_admissions TO CURRENT_USER USING(true) WITH CHECK(true);REVOKE ALL ON local_consumer_credit_admissions FROM PUBLIC,dyna_app;
CREATE FUNCTION local_consumer_credit_frame(did uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;x jsonb;c jsonb;v bigint;BEGIN
 IF b IS DISTINCT FROM jsonb_build_object('client_key',b->>'client_key','original_document_id',did,'return_id',b->>'return_id','expected_return_version',b->>'expected_return_version','reason',b->>'reason','ordinary_domestic_confirmed',true,'local_only',true)
 OR NOT public.local_invoice_text(b->'reason',3,500) OR b->>'expected_return_version'!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'Niepełny exact request188' USING ERRCODE='22023';END IF;
 x:=public.local_consumer_credit_source(did,(b->>'return_id')::uuid);SELECT version INTO v FROM public.return_cases WHERE(tenant_id,id)=(t,(b->>'return_id')::uuid);
 IF v::text IS DISTINCT FROM b->>'expected_return_version' THEN RAISE EXCEPTION 'RMA zmieniło wersję' USING ERRCODE='23514';END IF;
 c:=public.local_consumer_credit_calculate(x);
 RETURN jsonb_build_object('schema','local-consumer-credit/v1','original_document',x#>'{original,document}','calculation',c,'reason',b->'reason','return_version',v::text,'issue_date',(clock_timestamp() AT TIME ZONE 'UTC')::date::text,'local_only',true,'ksef_state','not_submitted','fiscalized',false);
END$$;
CREATE FUNCTION local_consumer_credit_preview(b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p local_consumer_credit_previews;h text;f jsonb;BEGIN
 PERFORM public.local_consumer_credit_require(uid,kid,true,false);PERFORM public.local_invoice_locks();h:=public.local_invoice_request_hash('consumer-credit-preview',(b->>'original_document_id')::uuid,b,uid,kid);
 SELECT * INTO p FROM public.local_consumer_credit_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.actor_id,p.api_key_id,p.request_hash,p.request) IS DISTINCT FROM(uid,kid,h,b) THEN RAISE EXCEPTION 'Klucz podglądu188 ma inne dane' USING ERRCODE='23514';END IF;PERFORM public.local_consumer_credit_require(uid,kid,true,true);RETURN to_jsonb(p)||jsonb_build_object('reused',true);END IF;
 IF(SELECT count(*) FROM local_consumer_credit_previews WHERE tenant_id=t)>=2000 THEN RAISE EXCEPTION 'Limit preview188' USING ERRCODE='54000';END IF;
 f:=public.local_consumer_credit_frame((b->>'original_document_id')::uuid,b);
 INSERT INTO local_consumer_credit_previews(tenant_id,original_document_id,original_receipt_id,order_id,return_id,actor_id,api_key_id,client_key,request,request_hash,scope_hash,calculation_hash,snapshot,expires_at)
 VALUES(t,(b->>'original_document_id')::uuid,(f#>>'{calculation,original_receipt_id}')::uuid,(f#>>'{original_document,order_id}')::uuid,(b->>'return_id')::uuid,uid,kid,(b->>'client_key')::uuid,b,h,public.local_consumer_credit_hash(f),public.local_consumer_credit_hash(f->'calculation'),f,clock_timestamp()+interval '15 minutes') RETURNING * INTO p;
 PERFORM public.local_consumer_credit_require(uid,kid,true,true);RETURN to_jsonb(p)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION local_consumer_credit_issue(pid uuid,b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p local_consumer_credit_previews;r local_consumer_credit_receipts;f jsonb;h text;yr integer;seq integer;series uuid;seller text;v_prefix text;claimed record;prev uuid;eid uuid:=gen_random_uuid();did uuid:=gen_random_uuid();num text;BEGIN
 PERFORM public.local_consumer_credit_require(uid,kid,true,false);PERFORM public.local_invoice_locks();h:=public.local_invoice_request_hash('consumer-credit-issue',pid,b,uid,kid);
 SELECT * INTO r FROM local_consumer_credit_receipts WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request_hash,r.request) IS DISTINCT FROM(pid,uid,kid,h,b) THEN RAISE EXCEPTION 'Klucz issue188 ma inny oryginał' USING ERRCODE='23514';END IF;PERFORM public.local_consumer_credit_require(uid,kid,true,true);RETURN to_jsonb(r)||jsonb_build_object('reused',true);END IF;
 SELECT * INTO p FROM local_consumer_credit_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Brak podglądu188' USING ERRCODE='P0002';END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR b IS DISTINCT FROM jsonb_build_object('client_key',b->>'client_key','scope_hash',p.scope_hash,'confirmed',true,'local_only',true) THEN RAISE EXCEPTION 'Brak dokładnej bieżącej zgody188' USING ERRCODE='23514';END IF;
 f:=public.local_consumer_credit_frame(p.original_document_id,p.request);
 IF f IS DISTINCT FROM p.snapshot OR public.local_consumer_credit_hash(f)<>p.scope_hash OR public.local_consumer_credit_hash(f->'calculation')<>p.calculation_hash THEN RAISE EXCEPTION 'Pełne źródło188 zmieniło się po preview' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM local_consumer_credit_receipts WHERE(tenant_id,return_id)=(t,p.return_id)) THEN RAISE EXCEPTION 'RMA ma już oryginalną KOR188' USING ERRCODE='23514';END IF;
 series:=(f#>>'{original_document,data,series,id}')::uuid;v_prefix:=f#>>'{original_document,data,series,prefix}';seller:=f#>>'{original_document,data,seller,tax_id}';yr:=extract(year FROM(f->>'issue_date')::date)::integer;
 PERFORM pg_advisory_xact_lock(hashtextextended('consumer-credit-namespace:'||seller||':'||v_prefix,0));
 SELECT * INTO claimed FROM local_consumer_credit_namespaces WHERE seller_tax_id=seller AND local_consumer_credit_namespaces.prefix=v_prefix;
 IF FOUND AND(claimed.tenant_id,claimed.series_id) IS DISTINCT FROM(t,series) THEN RAISE EXCEPTION 'Numeracja KOR188 jest już przypisana do innego źródła' USING ERRCODE='23514';END IF;
 IF NOT FOUND THEN INSERT INTO local_consumer_credit_namespaces VALUES(seller,v_prefix,t,series);END IF;
 SELECT last_number INTO seq FROM local_consumer_credit_counters WHERE(tenant_id,series_id,year)=(t,series,yr) FOR UPDATE;seq:=coalesce(seq,0)+1;IF seq>999999 THEN RAISE EXCEPTION 'Limit rocznej numeracji188' USING ERRCODE='54000';END IF;
 num:='KOR/'||v_prefix||'/'||yr::text||'/'||lpad(seq::text,6,'0');SELECT id INTO prev FROM local_consumer_credit_receipts WHERE(tenant_id,original_document_id)=(t,p.original_document_id) ORDER BY receipt_sequence DESC LIMIT 1;
 INSERT INTO local_consumer_credit_admissions VALUES(eid,t,did,p.id,uid,kid,(b->>'client_key')::uuid,h,num,yr,seq,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid());
 INSERT INTO local_consumer_credit_documents VALUES(did,t,p.original_document_id,p.order_id,p.return_id,'correction','local_consumer_credit',num,f||jsonb_build_object('number',num,'year',yr,'sequence',seq,'preview_id',p.id,'scope_hash',p.scope_hash),clock_timestamp());
 INSERT INTO local_consumer_credit_receipts(id,tenant_id,document_id,preview_id,original_document_id,original_receipt_id,order_id,return_id,return_receipt_id,receipt_sequence,previous_receipt_id,actor_id,api_key_id,client_key,request,request_hash,scope_hash,calculation_hash,snapshot,series_id,year,sequence,number,root_xid,transaction_started_at,backend_pid)
 VALUES(eid,t,did,p.id,p.original_document_id,p.original_receipt_id,p.order_id,p.return_id,(f#>>'{calculation,return_receipt_id}')::uuid,(f#>>'{calculation,receipt_sequence}')::integer,prev,uid,kid,(b->>'client_key')::uuid,b,h,p.scope_hash,p.calculation_hash,f,series,yr,seq,num,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) RETURNING * INTO r;
 IF seq=1 THEN INSERT INTO local_consumer_credit_counters VALUES(t,series,yr,seq);ELSE UPDATE local_consumer_credit_counters SET last_number=seq WHERE(tenant_id,series_id,year)=(t,series,yr);END IF;
 PERFORM public.local_consumer_credit_require(uid,kid,true,true);RETURN to_jsonb(r)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION local_consumer_credit_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE p local_consumer_credit_previews;a local_consumer_credit_admissions;f jsonb;BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obcy record188' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='local_consumer_credit_previews' THEN
  PERFORM public.local_consumer_credit_require(NEW.actor_id,NEW.api_key_id,true,false);f:=public.local_consumer_credit_frame(NEW.original_document_id,NEW.request);
  IF NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM public.local_invoice_request_hash('consumer-credit-preview',NEW.original_document_id,NEW.request,NEW.actor_id,NEW.api_key_id) OR NEW.created_at<transaction_timestamp() OR NEW.expires_at>NEW.created_at+interval '15 minutes' OR f IS DISTINCT FROM NEW.snapshot OR NEW.scope_hash<>public.local_consumer_credit_hash(f) OR NEW.calculation_hash<>public.local_consumer_credit_hash(f->'calculation') OR(NEW.order_id,NEW.return_id,NEW.original_receipt_id) IS DISTINCT FROM((f#>>'{original_document,order_id}')::uuid,(f#>>'{calculation,return_id}')::uuid,(f#>>'{calculation,original_receipt_id}')::uuid) THEN RAISE EXCEPTION 'Fałszywy snapshot188' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='local_consumer_credit_admissions' THEN
  SELECT * INTO p FROM local_consumer_credit_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);PERFORM public.local_consumer_credit_require(NEW.actor_id,NEW.api_key_id,true,false);
  IF p.id IS NULL OR(p.actor_id,p.api_key_id) IS DISTINCT FROM(NEW.actor_id,NEW.api_key_id) OR(NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) THEN RAISE EXCEPTION 'Brak current typed admission188' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='local_consumer_credit_receipts' THEN
  SELECT * INTO a FROM local_consumer_credit_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);SELECT * INTO p FROM local_consumer_credit_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
  IF a.id IS NULL OR(NEW.document_id,NEW.preview_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash,NEW.number,NEW.year,NEW.sequence,NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid) IS DISTINCT FROM(a.document_id,a.preview_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.number,a.year,a.sequence,a.root_xid,a.transaction_started_at,a.backend_pid)
   OR(NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) OR NEW.snapshot IS DISTINCT FROM p.snapshot OR NEW.scope_hash<>p.scope_hash OR NEW.calculation_hash<>p.calculation_hash THEN RAISE EXCEPTION 'Fałszywy receipt188' USING ERRCODE='23514';END IF;
  IF(NEW.original_document_id,NEW.original_receipt_id,NEW.order_id,NEW.return_id,NEW.return_receipt_id,NEW.receipt_sequence,NEW.series_id) IS DISTINCT FROM(p.original_document_id,p.original_receipt_id,p.order_id,p.return_id,(p.snapshot#>>'{calculation,return_receipt_id}')::uuid,(p.snapshot#>>'{calculation,receipt_sequence}')::integer,(p.snapshot#>>'{original_document,data,series,id}')::uuid)
   OR NEW.previous_receipt_id IS DISTINCT FROM(SELECT cr.id FROM local_consumer_credit_receipts cr WHERE(cr.tenant_id,cr.original_document_id)=(NEW.tenant_id,NEW.original_document_id) ORDER BY cr.receipt_sequence DESC LIMIT 1)
   OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
   OR NEW.request_hash IS DISTINCT FROM public.local_invoice_request_hash('consumer-credit-issue',p.id,NEW.request,NEW.actor_id,NEW.api_key_id)
   OR NEW.number IS DISTINCT FROM('KOR/'||(p.snapshot#>>'{original_document,data,series,prefix}')||'/'||NEW.year::text||'/'||lpad(NEW.sequence::text,6,'0'))
   OR NEW.year IS DISTINCT FROM extract(year FROM(p.snapshot->>'issue_date')::date)::integer THEN RAISE EXCEPTION 'Inny pełny oryginalny receipt188' USING ERRCODE='23514';END IF;
  PERFORM public.local_consumer_credit_require(NEW.actor_id,NEW.api_key_id,true,false);
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_consumer_credit_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a local_consumer_credit_admissions;p local_consumer_credit_previews;BEGIN
 SELECT * INTO a FROM local_consumer_credit_admissions WHERE(tenant_id,document_id)=(NEW.tenant_id,NEW.id);SELECT * INTO p FROM local_consumer_credit_previews WHERE(tenant_id,id)=(NEW.tenant_id,a.preview_id);
 IF a.id IS NULL OR(NEW.kind,NEW.mode,NEW.original_document_id,NEW.order_id,NEW.return_id,NEW.number) IS DISTINCT FROM('correction','local_consumer_credit',p.original_document_id,p.order_id,p.return_id,a.number)
 OR(a.root_xid,a.transaction_started_at,a.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) OR NEW.data IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash)) THEN RAISE EXCEPTION 'Dokument bez prawdziwego issue188' USING ERRCODE='23514';END IF;
 PERFORM public.local_consumer_credit_require(a.actor_id,a.api_key_id,true,false);RETURN NEW;
END$$;
CREATE FUNCTION local_consumer_credit_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number) IS DISTINCT FROM(OLD.tenant_id,OLD.series_id,OLD.year,OLD.last_number+1))
 OR(TG_OP='INSERT' AND NEW.last_number<>1) OR NOT EXISTS(SELECT FROM local_consumer_credit_receipts r WHERE(r.tenant_id,r.series_id,r.year,r.sequence,r.root_xid,r.transaction_started_at,r.backend_pid)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())) THEN RAISE EXCEPTION 'Numeracja bez prawdziwego receipt188' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION local_consumer_credit_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE rid uuid;r local_consumer_credit_receipts;d local_consumer_credit_documents;p local_consumer_credit_previews;BEGIN
 IF TG_TABLE_NAME='local_consumer_credit_admissions' THEN rid:=NEW.id;ELSIF TG_TABLE_NAME='local_consumer_credit_receipts' THEN rid:=NEW.id;ELSE SELECT id INTO rid FROM local_consumer_credit_receipts WHERE(tenant_id,document_id)=(NEW.tenant_id,NEW.id);END IF;
 SELECT * INTO r FROM local_consumer_credit_receipts WHERE(tenant_id,id)=(NEW.tenant_id,rid);SELECT * INTO d FROM local_consumer_credit_documents WHERE(tenant_id,id)=(NEW.tenant_id,r.document_id);SELECT * INTO p FROM local_consumer_credit_previews WHERE(tenant_id,id)=(NEW.tenant_id,r.preview_id);
 IF r.id IS NULL OR d.id IS NULL OR p.id IS NULL OR d.data IS DISTINCT FROM(r.snapshot||jsonb_build_object('number',r.number,'year',r.year,'sequence',r.sequence,'preview_id',r.preview_id,'scope_hash',r.scope_hash)) OR NOT EXISTS(SELECT FROM local_consumer_credit_counters WHERE(tenant_id,series_id,year,last_number)=(r.tenant_id,r.series_id,r.year,r.sequence)) THEN RAISE EXCEPTION 'Niepełny trwały credit188' USING ERRCODE='23514';END IF;PERFORM public.local_consumer_credit_require(r.actor_id,r.api_key_id,true,false);RETURN NEW;
END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['local_consumer_credit_previews','local_consumer_credit_documents','local_consumer_credit_receipts','local_consumer_credit_admissions','local_consumer_credit_namespaces','local_consumer_credit_manifest'] LOOP EXECUTE format('CREATE TRIGGER local_consumer_credit_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION local_consumer_credit_immutable()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['local_consumer_credit_previews','local_consumer_credit_admissions','local_consumer_credit_receipts'] LOOP EXECUTE format('CREATE TRIGGER local_consumer_credit_record_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION local_consumer_credit_record_guard()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['local_consumer_credit_documents','local_consumer_credit_admissions','local_consumer_credit_receipts'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER local_consumer_credit_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION local_consumer_credit_complete()',tab);END LOOP;
 END$$;
CREATE TRIGGER local_consumer_credit_document_guard BEFORE INSERT ON local_consumer_credit_documents FOR EACH ROW EXECUTE FUNCTION local_consumer_credit_document_guard();
CREATE TRIGGER local_consumer_credit_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON local_consumer_credit_counters FOR EACH ROW EXECUTE FUNCTION local_consumer_credit_counter_guard();
CREATE FUNCTION local_consumer_credit_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM migrations WHERE name='188_local_consumer_credit')$$;

CREATE FUNCTION public.local_consumer_credit_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,x.attgenerated,x.attidentity,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'local\_consumer\_credit\_%' ESCAPE '\' AND c.relkind IN('r','p')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,p.proretset,p.prorettype,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.proargmodes,p.proargnames,pg_get_expr(p.proargdefaults,0),(SELECT lanname FROM pg_language WHERE oid=p.prolang),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'local\_consumer\_credit\_%' ESCAPE '\'),
 'documents_checks',(SELECT jsonb_agg(jsonb_build_array(conname,convalidated,pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.documents'::regclass AND conname IN('documents_kind_check','documents_proforma_local','documents_native_invoice')),
 'document_indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid)) ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN('document_order_mode','document_demo_number')),
 'parent_triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE tgname IN('local_consumer_credit_document_guard','local_consumer_credit_seal'))
 )::text,'UTF8')),'hex') $$;
CREATE FUNCTION local_consumer_credit_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE c record;BEGIN
 IF current_setting('session_replication_role')<>'origin' OR(SELECT count(*) FROM local_consumer_credit_manifest)<>1 OR(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'local\_consumer\_credit\_%' ESCAPE '\' AND relkind IN('r','p') AND relrowsecurity AND relforcerowsecurity)<>7 THEN RETURN false;END IF;
 SELECT * INTO c FROM local_consumer_credit_manifest WHERE id;
 RETURN coalesce(c.profile='157+139+169-original-to188-consumer-credit/v1' AND c.fingerprint=public.local_consumer_credit_fingerprint()
 AND c.original157=(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id) AND c.original160=(SELECT to_jsonb(m) FROM b2b_credit_upgrade m WHERE id)
 AND public.local_invoice_guards() AND public.catalog_stock_return_guards() AND public.b2b_credit_guards(),false);
END$$;
CREATE FUNCTION local_consumer_credit_terminal(uid uuid,kid uuid,writing boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN PERFORM public.local_consumer_credit_require(uid,kid,writing,true);END$$;
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT p.oid::regprocedure sig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'local\_consumer\_credit\_%' ESCAPE '\' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig);END LOOP;END$$;
GRANT EXECUTE ON FUNCTION local_consumer_credit_installed(),local_consumer_credit_guards(),local_consumer_credit_preview(jsonb,uuid,uuid),local_consumer_credit_issue(uuid,jsonb,uuid,uuid),local_consumer_credit_terminal(uuid,uuid,boolean) TO dyna_app;
INSERT INTO local_consumer_credit_manifest(id,profile,fingerprint,original157,original160) SELECT true,'157+139+169-original-to188-consumer-credit/v1',public.local_consumer_credit_fingerprint(),(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id),(SELECT to_jsonb(m) FROM b2b_credit_upgrade m WHERE id);
DO $$BEGIN IF NOT public.local_consumer_credit_guards() THEN RAISE EXCEPTION 'Pełny nowy profil188 odmówił' USING ERRCODE='55000';END IF;END$$;
