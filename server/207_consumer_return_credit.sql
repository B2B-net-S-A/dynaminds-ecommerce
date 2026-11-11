-- Explicit versioned successor for consumer returns with native destinations history.
-- Requires Source206 readers and a separately reviewed exact Native207 catalogue/resource successor.
-- Shipped as a resource; activation still requires the exact independently reviewed Native/profile successor.
-- All original188 functions/tables/counters remain literal; new business series use three-component numbering.
DO $$BEGIN IF session_user<>'postgres' OR current_user<>'postgres' OR NOT public.local_invoice_guards() OR NOT public.catalog_stock_return_guards() OR NOT public.b2b_credit_guards() OR NOT public.local_consumer_credit_guards() OR NOT public.ordinary188_structure_valid() OR to_regprocedure('public.return_credit206_history(uuid)') IS NULL THEN RAISE EXCEPTION 'Niepełny rzeczywisty poprzednik207' USING ERRCODE='55000';END IF;END$$;
CREATE TABLE public.return_credit206_series(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants,
 actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),prefix text NOT NULL CHECK(prefix~'^[A-Z0-9][A-Z0-9-]{0,23}$'),
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),enabled boolean NOT NULL DEFAULT true CHECK(enabled),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,prefix),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),CHECK(request_hash~'^[a-f0-9]{64}$'));
CREATE TABLE public.return_credit206_previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants,original_document_id uuid NOT NULL,original_receipt_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,calculation_hash text NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,client_key),FOREIGN KEY(tenant_id,original_document_id) REFERENCES public.documents(tenant_id,id),FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES public.local_invoice_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES public.return_cases(tenant_id,order_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 CHECK(request_hash~'^[a-f0-9]{64}$' AND scope_hash~'^[a-f0-9]{64}$' AND calculation_hash~'^[a-f0-9]{64}$' AND expires_at>created_at AND octet_length(snapshot::text)<=2097152));
CREATE TABLE public.return_credit206_documents(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants,original_document_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,kind text NOT NULL CHECK(kind='correction'),mode text NOT NULL CHECK(mode='consumer_return_credit'),number text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,return_id),UNIQUE(tenant_id,number),FOREIGN KEY(tenant_id,original_document_id) REFERENCES public.documents(tenant_id,id),FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES public.return_cases(tenant_id,order_id,id),CHECK(octet_length(data::text)<=2097152));
CREATE TABLE public.return_credit206_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants,document_id uuid NOT NULL,preview_id uuid NOT NULL,original_document_id uuid NOT NULL,original_receipt_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,return_receipt_id uuid NOT NULL,receipt_sequence integer NOT NULL,previous_receipt_id uuid,
 actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL,scope_hash text NOT NULL,calculation_hash text NOT NULL,snapshot jsonb NOT NULL,series_id uuid NOT NULL,year integer NOT NULL,sequence integer NOT NULL,number text NOT NULL,
 root_xid xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,backend_pid integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,return_id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,series_id,year,sequence),
 FOREIGN KEY(tenant_id,document_id) REFERENCES public.return_credit206_documents(tenant_id,id),FOREIGN KEY(tenant_id,preview_id) REFERENCES public.return_credit206_previews(tenant_id,id),FOREIGN KEY(tenant_id,original_document_id) REFERENCES public.documents(tenant_id,id),FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES public.local_invoice_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,return_receipt_id) REFERENCES public.catalog_stock_return_receipts(tenant_id,id),FOREIGN KEY(tenant_id,series_id) REFERENCES public.return_credit206_series(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 CHECK(receipt_sequence BETWEEN 1 AND 1000 AND year BETWEEN 2006 AND 2050 AND sequence BETWEEN 1 AND 999999));
CREATE TABLE public.return_credit206_counters(tenant_id uuid NOT NULL,series_id uuid NOT NULL,year integer NOT NULL,last_number integer NOT NULL CHECK(last_number BETWEEN 0 AND 999999),PRIMARY KEY(tenant_id,series_id,year),FOREIGN KEY(tenant_id,series_id) REFERENCES public.return_credit206_series(tenant_id,id));
CREATE TABLE public.return_credit206_manifest(id boolean PRIMARY KEY CHECK(id),profile text NOT NULL CHECK(profile='157+139+148+169+188-to207-consumer-credit/v2'),fingerprint text NOT NULL,original157 jsonb NOT NULL,original160 jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX return_credit206_page ON return_credit206_documents(tenant_id,created_at DESC,id DESC);
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['return_credit206_series','return_credit206_previews','return_credit206_documents','return_credit206_receipts','return_credit206_counters'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON %I TO dyna_app USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 EXECUTE format('CREATE POLICY owner_scope ON %I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);EXECUTE format('GRANT SELECT ON %I TO dyna_app',tab);
 END LOOP;END$$;
ALTER TABLE return_credit206_manifest ENABLE ROW LEVEL SECURITY;ALTER TABLE return_credit206_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON return_credit206_manifest TO CURRENT_USER USING(true) WITH CHECK(true);REVOKE ALL ON return_credit206_manifest FROM PUBLIC,dyna_app;
CREATE FUNCTION public.return_credit206_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT encode(sha256(convert_to(public.local_invoice_canonical(v),'UTF8')),'hex')$$;
CREATE FUNCTION public.return_credit206_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$BEGIN RAISE EXCEPTION 'Niezmienny consumer credit207' USING ERRCODE='23514';END$$;
CREATE FUNCTION public.return_credit206_require(uid uuid,kid uuid,writing boolean,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF NOT public.return_credit206_installed() OR NOT public.return_credit206_guards() OR NOT public.local_invoice_guards() OR NOT public.catalog_stock_return_guards() THEN RAISE EXCEPTION 'Niepełny profil207' USING ERRCODE='55000';END IF;
 PERFORM public.local_invoice_require(uid,kid,writing,pin);
END$$;
CREATE FUNCTION public.return_credit206_physical_history(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p text;
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres' OR t IS NULL THEN RAISE EXCEPTION 'Own private history context required' USING ERRCODE='42501';END IF;
 SELECT a.protocol INTO p FROM public.catalog_stock_return_admissions a WHERE(a.tenant_id,a.id)=(t,eid) AND a.sealed;
 IF p='destinations_v1' THEN PERFORM public.return_credit206_history(eid);
 ELSIF p IN('rma','assistant_v1') THEN PERFORM public.local_consumer_credit_history(eid);
 ELSE RAISE EXCEPTION 'Unsupported complete physical lineage' USING ERRCODE='23514';END IF;
END$$;
-- SOURCE-ONLY FRAGMENT: merge into207 before its fingerprint/ACL closure.
-- Historical sealed148 rejection audit, never a169 receipt or financial sequence.
CREATE FUNCTION public.return_credit206_rejected_history(eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $rejected207$
DECLARE
 tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 admission public.return_destination_admissions;
 assistant_admission public.return_assistant_admissions;
 receipt public.return_assistant_receipts;
 preview public.return_assistant_previews;
 session_row public.return_assistant_sessions;
 current_return public.return_cases;
 original_request jsonb;native_plan jsonb;actual jsonb;wanted jsonb;typed_parts jsonb;typed_items jsonb;
 before_header jsonb;after_header jsonb;before_order jsonb;after_order jsonb;
 expected_result jsonb;part_row jsonb;revision public.return_destination_status_revisions;
 table_name text;key_names text[];row_count bigint;payload_bytes numeric;lineage jsonb;
 snapshot_keys text[]:=ARRAY['documents','order_items','order_parcel_dispatches','order_parcel_releases','orders',
  'payment_entries','reservation_locations','reservations','return_cases','return_items','shipments','stock',
  'stock_location_movements','stock_locations','stock_movements','wms_cost_layers','wms_issue_fragments',
  'wms_layer_movements','wms_layer_positions','wms_lots','wms_operations','wms_reservation_layers','wms_return_fragments'];
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres' OR tenant IS NULL
 OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION '207 rejected history requires own owner/tenant/origin' USING ERRCODE='42501';END IF;
 IF public.catalog_header205_valid() IS DISTINCT FROM true OR public.local_consumer_credit_guards() IS DISTINCT FROM true
 OR public.ordinary188_structure_valid() IS DISTINCT FROM true OR public.return_destination_guards() IS DISTINCT FROM true
 OR public.catalog_stock_return_guards() IS DISTINCT FROM true THEN
  RAISE EXCEPTION '207 rejected history requires unchanged complete predecessors' USING ERRCODE='55000';END IF;
 SELECT * INTO admission FROM public.return_destination_admissions WHERE(tenant_id,receipt_id)=(tenant,eid);
 SELECT * INTO receipt FROM public.return_assistant_receipts WHERE(tenant_id,id)=(tenant,eid);
 IF admission.receipt_id IS NULL OR receipt.id IS NULL OR admission.after_snapshot IS NULL
 OR admission.before_snapshot='{}'::jsonb OR admission.transaction_id=pg_current_xact_id()
 OR admission.payload->>'action' IS DISTINCT FROM 'reject'
 OR admission.payload#>>'{snapshot,protocol}' IS DISTINCT FROM 'destinations_v1' THEN
  RAISE EXCEPTION '207 requires a completed historical rejected148 audit' USING ERRCODE='23514';END IF;
 SELECT * INTO assistant_admission FROM public.return_assistant_admissions
  WHERE(tenant_id,transaction_id,receipt_id)=(tenant,admission.transaction_id,eid);
 SELECT * INTO preview FROM public.return_assistant_previews WHERE(tenant_id,id)=(tenant,admission.preview_id);
 SELECT * INTO session_row FROM public.return_assistant_sessions WHERE(tenant_id,id)=(tenant,admission.session_id);
 SELECT * INTO current_return FROM public.return_cases WHERE(tenant_id,id)=(tenant,admission.return_id);
 IF assistant_admission.receipt_id IS NULL OR preview.id IS NULL OR session_row.id IS NULL OR current_return.id IS NULL
 OR(receipt.preview_id,receipt.session_id,receipt.return_id,receipt.order_id,receipt.actor_id,receipt.api_key_id,receipt.client_key,receipt.request_hash,receipt.payload)
  IS DISTINCT FROM(admission.preview_id,admission.session_id,admission.return_id,admission.order_id,admission.actor_id,admission.api_key_id,admission.client_key,admission.request_hash,admission.payload)
 OR(assistant_admission.preview_id,assistant_admission.session_id,assistant_admission.return_id,assistant_admission.actor_id,assistant_admission.api_key_id,assistant_admission.client_key,assistant_admission.request_hash,assistant_admission.payload)
  IS DISTINCT FROM(admission.preview_id,admission.session_id,admission.return_id,admission.actor_id,admission.api_key_id,admission.client_key,admission.request_hash,admission.payload)
 OR(preview.session_id,preview.return_id,preview.order_id,preview.actor_id,preview.api_key_id,preview.payload,preview.scope_hash)
  IS DISTINCT FROM(admission.session_id,admission.return_id,admission.order_id,admission.actor_id,admission.api_key_id,admission.payload,receipt.scope_hash)
 OR(session_row.return_id,session_row.order_id,session_row.actor_id,session_row.api_key_id,session_row.state)
  IS DISTINCT FROM(admission.return_id,admission.order_id,admission.actor_id,admission.api_key_id,'completed'::text)
 OR session_row.version IS DISTINCT FROM(admission.payload#>>'{snapshot,session,version}')::bigint+1
 OR(session_row.station_id::text,session_row.station,session_row.scanned)
  IS DISTINCT FROM(admission.payload#>>'{snapshot,session,station_id}',admission.payload#>'{snapshot,session,station}',admission.payload#>'{snapshot,scanned}')
 OR receipt.scope_hash IS DISTINCT FROM public.return_assistant_hash(admission.payload||jsonb_build_object('private_scope_nonce',preview.private_scope_nonce))
 OR admission.request_hash IS DISTINCT FROM public.return_assistant_hash(jsonb_build_object('tenant_id',tenant,'preview_id',preview.id,'kind','destinations_receive','request',admission.request,'actor_id',admission.actor_id,'api_key_id',admission.api_key_id))
 OR admission.request IS DISTINCT FROM jsonb_build_object('client_key',admission.client_key,'scope_hash',preview.scope_hash,'confirmed',true,'lease_token',admission.request->'lease_token')
 OR receipt.created_at<admission.opened_at OR admission.opened_at<preview.created_at OR admission.opened_at>=preview.expires_at THEN
  RAISE EXCEPTION '207 rejected preview/admission/session/result lineage differs' USING ERRCODE='23514';END IF;

 -- Bounds precede every full-array comparison; no truncation or sampled proof.
 payload_bytes:=pg_column_size(admission.payload)::numeric+pg_column_size(admission.before_snapshot)
  +pg_column_size(admission.after_snapshot)+pg_column_size(receipt.result)+pg_column_size(session_row.source)
  +pg_column_size(assistant_admission.witnesses)+pg_column_size(admission.witnesses);
 IF payload_bytes>33554432 THEN RAISE EXCEPTION '207 complete rejected audit exceeds budget' USING ERRCODE='54000';END IF;
 IF(SELECT count(*) FROM public.return_destination_parts WHERE(tenant_id,receipt_id)=(tenant,eid))>10000
 OR(SELECT count(*) FROM public.return_items WHERE(tenant_id,return_id)=(tenant,admission.return_id))>100
 OR(SELECT count(*) FROM public.return_assistant_photos WHERE(tenant_id,session_id)=(tenant,admission.session_id))>10000 THEN
  RAISE EXCEPTION '207 complete native rejected rows exceed budget' USING ERRCODE='54000';END IF;
 IF jsonb_typeof(admission.before_snapshot) IS DISTINCT FROM 'object' OR jsonb_typeof(admission.after_snapshot) IS DISTINCT FROM 'object'
 OR admission.witnesses IS DISTINCT FROM '[]'::jsonb OR assistant_admission.witnesses IS DISTINCT FROM '[]'::jsonb THEN
  RAISE EXCEPTION '207 rejected inspection cannot have physical witnesses' USING ERRCODE='23514';END IF;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO key_names FROM jsonb_object_keys(admission.before_snapshot)k;
 IF key_names IS DISTINCT FROM snapshot_keys THEN RAISE EXCEPTION '207 complete before snapshot required' USING ERRCODE='23514';END IF;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO key_names FROM jsonb_object_keys(admission.after_snapshot)k;
 IF key_names IS DISTINCT FROM snapshot_keys THEN RAISE EXCEPTION '207 complete after snapshot required' USING ERRCODE='23514';END IF;
 FOREACH table_name IN ARRAY snapshot_keys LOOP
  IF jsonb_typeof(admission.before_snapshot->table_name) IS DISTINCT FROM 'array'
  OR jsonb_typeof(admission.after_snapshot->table_name) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION '207 typed complete snapshot arrays required' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(admission.before_snapshot->table_name)>10000 OR jsonb_array_length(admission.after_snapshot->table_name)>10000 THEN
   RAISE EXCEPTION '207 complete rejected rows exceed budget' USING ERRCODE='54000';END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(admission.before_snapshot->table_name)entry WHERE entry->>'tenant_id' IS DISTINCT FROM tenant::text)
  OR EXISTS(SELECT FROM jsonb_array_elements(admission.after_snapshot->table_name)entry WHERE entry->>'tenant_id' IS DISTINCT FROM tenant::text) THEN
   RAISE EXCEPTION '207 rejected snapshot contains foreign rows' USING ERRCODE='23514';END IF;
  IF table_name NOT IN('orders','return_cases') AND admission.before_snapshot->table_name IS DISTINCT FROM admission.after_snapshot->table_name THEN
   RAISE EXCEPTION '207 rejected inspection changed physical, financial or immutable history' USING ERRCODE='23514';END IF;
 END LOOP;

 -- Rebuild the native plan from the captured birth source and original request,
 -- without renewing a lease or using today's active status/policy/prices/stock.
 original_request:=admission.payload#>'{snapshot,request}'||jsonb_build_object('client_key',preview.client_key,'lease_token',admission.request->'lease_token');
 IF preview.request_hash IS DISTINCT FROM public.return_assistant_hash(jsonb_build_object('tenant_id',tenant,'session_id',preview.session_id,'kind','destinations_preview','actor_id',preview.actor_id,'api_key_id',preview.api_key_id,'request',original_request)) THEN
  RAISE EXCEPTION '207 rejected original preview request differs' USING ERRCODE='23514';END IF;
 native_plan:=public.return_destination_plan(admission.payload->'planner_source',original_request);
 IF native_plan IS DISTINCT FROM admission.payload->'plan' OR native_plan IS DISTINCT FROM admission.payload#>'{snapshot,plan}'
 OR(native_plan->>'return_id',native_plan->>'order_id') IS DISTINCT FROM(admission.return_id::text,admission.order_id::text)
 OR(native_plan#>>'{summary,accepted}',native_plan#>>'{summary,restocked_to_sale}',native_plan#>>'{summary,received_into_custody}',native_plan#>>'{summary,commercial_credit_minor}',native_plan#>>'{summary,shipping_refund_minor}')
  IS DISTINCT FROM('0','0','0','0','0')
 OR native_plan->'arrivals' IS DISTINCT FROM '[]'::jsonb OR native_plan->'stock_effects' IS DISTINCT FROM '[]'::jsonb
 OR native_plan->'private_fragment_effects' IS DISTINCT FROM '[]'::jsonb
 OR jsonb_array_length(native_plan->'parts') NOT BETWEEN 1 AND 10000
 OR EXISTS(SELECT FROM jsonb_array_elements(native_plan->'parts')part WHERE part#>>'{status,decision}' IS DISTINCT FROM 'reject'
  OR part#>>'{status,inventory_effect}' IS DISTINCT FROM 'none' OR part->>'refund_minor' IS DISTINCT FROM '0') THEN
  RAISE EXCEPTION '207 rejected native plan has a commercial or physical effect' USING ERRCODE='23514';END IF;
 IF admission.payload->'receive_input' IS DISTINCT FROM jsonb_build_object('version',(original_request->>'return_version')::bigint,'decision','reject','note',original_request->>'note')
 OR admission.payload->'summary' IS DISTINCT FROM(native_plan->'summary'||jsonb_build_object('refund_minor',native_plan#>'{summary,commercial_credit_minor}','shipping_refund',native_plan#>'{summary,shipping_refund_minor}')) THEN
  RAISE EXCEPTION '207 rejected core request or summary differs' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(typed_part) ORDER BY typed_part.id),'[]') INTO actual
  FROM public.return_destination_parts typed_part WHERE(typed_part.tenant_id,typed_part.receipt_id)=(tenant,eid);
 SELECT coalesce(jsonb_agg(jsonb_build_object('tenant_id',tenant,'id',(part->>'part_id')::uuid,'receipt_id',eid,
  'preview_id',admission.preview_id,'session_id',admission.session_id,'return_id',admission.return_id,'order_id',admission.order_id,
  'item_id',(part->>'item_id')::uuid,'quantity',(part->>'quantity')::integer,'status_id',(part#>>'{status,status_id}')::uuid,
  'status_version',(part#>>'{status,version}')::bigint,'status_revision_id',(part#>>'{status,revision_id}')::uuid,
  'decision',part#>>'{status,decision}','effect',part#>>'{status,inventory_effect}',
  'warehouse_id',(part#>>'{status,warehouse_id}')::uuid,'warehouse_policy_version',(part#>>'{status,warehouse_policy_version}')::bigint,
  'refund_minor',(part->>'refund_minor')::bigint,'snapshot',part) ORDER BY(part->>'part_id')::uuid),'[]')
 INTO wanted FROM jsonb_array_elements(native_plan->'parts')part;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION '207 exact typed rejected parts differ' USING ERRCODE='23514';END IF;
 typed_parts:=actual;
 FOR part_row IN SELECT value FROM jsonb_array_elements(native_plan->'parts') LOOP
  SELECT * INTO revision FROM public.return_destination_status_revisions
   WHERE(tenant_id,status_id,id,version)=(tenant,(part_row#>>'{status,status_id}')::uuid,(part_row#>>'{status,revision_id}')::uuid,(part_row#>>'{status,version}')::bigint);
  IF revision.id IS NULL OR part_row->'status' IS DISTINCT FROM jsonb_build_object('status_id',revision.status_id,'version',revision.version::text,
   'revision_id',revision.id,'active',revision.settings->'active','name',revision.settings->'name','color',revision.settings->'color',
   'decision',revision.settings->'decision','inventory_effect',revision.settings->'inventory_effect','warehouse_id',revision.settings->'warehouse_id',
   'warehouse_policy_version',revision.settings->'warehouse_policy_version','default_location',revision.settings->'default_location') THEN
   RAISE EXCEPTION '207 rejected immutable status revision differs' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT FROM public.return_destination_arrivals WHERE(tenant_id,receipt_id)=(tenant,eid))
 OR EXISTS(SELECT FROM public.return_destination_fragments WHERE(tenant_id,receipt_id)=(tenant,eid)) THEN
  RAISE EXCEPTION '207 rejected inspection cannot contain arrivals or fragments' USING ERRCODE='23514';END IF;

 SELECT count(*) INTO row_count FROM jsonb_array_elements(admission.before_snapshot->'return_cases')entry WHERE entry->>'id'=admission.return_id::text;
 IF row_count<>1 THEN RAISE EXCEPTION '207 one rejected before birth required' USING ERRCODE='23514';END IF;
 SELECT entry INTO before_header FROM jsonb_array_elements(admission.before_snapshot->'return_cases')entry WHERE entry->>'id'=admission.return_id::text;
 SELECT count(*) INTO row_count FROM jsonb_array_elements(admission.after_snapshot->'return_cases')entry WHERE entry->>'id'=admission.return_id::text;
 IF row_count<>1 THEN RAISE EXCEPTION '207 one rejected after birth required' USING ERRCODE='23514';END IF;
 SELECT entry INTO after_header FROM jsonb_array_elements(admission.after_snapshot->'return_cases')entry WHERE entry->>'id'=admission.return_id::text;
 IF(before_header->>'order_id',before_header->>'state',before_header->>'remedy',before_header->>'legacy')
  IS DISTINCT FROM(admission.order_id::text,'requested','refund','false')
 OR(before_header->'received_at',before_header->'receipt',before_header->>'receipt_sequence',before_header->>'refund_amount',before_header->>'refunded_shipping')
  IS DISTINCT FROM('null'::jsonb,'null'::jsonb,'0','0','0')
 OR(after_header->>'state',after_header->'received_at',after_header->'receipt',after_header->>'receipt_sequence',after_header->>'refund_amount',after_header->>'refunded_shipping')
  IS DISTINCT FROM('rejected','null'::jsonb,'null'::jsonb,'0','0','0')
 OR after_header->>'decision_note' IS DISTINCT FROM original_request->>'note'
 OR(before_header->>'version')::bigint IS DISTINCT FROM(original_request->>'return_version')::bigint
 OR(after_header->>'version')::bigint IS DISTINCT FROM(before_header->>'version')::bigint+1
 OR before_header-ARRAY['state','decision_note','version','updated_at'] IS DISTINCT FROM after_header-ARRAY['state','decision_note','version','updated_at']
 OR to_jsonb(current_return) IS DISTINCT FROM after_header THEN
  RAISE EXCEPTION '207 rejected native header birth/result differs' USING ERRCODE='23514';END IF;
 IF(SELECT coalesce(jsonb_agg(entry ORDER BY entry->>'id'),'[]') FROM jsonb_array_elements(admission.before_snapshot->'return_cases')entry WHERE entry->>'id'<>admission.return_id::text)
  IS DISTINCT FROM(SELECT coalesce(jsonb_agg(entry ORDER BY entry->>'id'),'[]') FROM jsonb_array_elements(admission.after_snapshot->'return_cases')entry WHERE entry->>'id'<>admission.return_id::text) THEN
  RAISE EXCEPTION '207 rejection changed another return' USING ERRCODE='23514';END IF;
 expected_result:=jsonb_build_object('state',after_header->'state','version',after_header->>'version','refund_amount',after_header->'refund_amount',
  'refunded_shipping',after_header->'refunded_shipping','received_at',after_header->'received_at','receipt',after_header->'receipt',
  'decision_note',after_header->'decision_note','id',after_header->'id','number',after_header->'number','receipt_sequence',after_header->'receipt_sequence');
 IF receipt.result IS DISTINCT FROM expected_result THEN RAISE EXCEPTION '207 exact rejected assistant result differs' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(typed_item) ORDER BY typed_item.item_id),'[]') INTO actual
  FROM public.return_items typed_item WHERE(typed_item.tenant_id,typed_item.return_id)=(tenant,admission.return_id);
 SELECT coalesce(jsonb_agg(entry ORDER BY entry->>'item_id'),'[]') INTO wanted
  FROM jsonb_array_elements(admission.after_snapshot->'return_items')entry WHERE entry->>'return_id'=admission.return_id::text;
 IF actual IS DISTINCT FROM wanted OR jsonb_array_length(actual) NOT BETWEEN 1 AND 100
 OR EXISTS(SELECT FROM jsonb_array_elements(actual)entry WHERE(entry->>'accepted',entry->>'restocked',entry->>'refund_amount') IS DISTINCT FROM('0','0','0')) THEN
  RAISE EXCEPTION '207 rejected complete original items differ or contain credit' USING ERRCODE='23514';END IF;
 typed_items:=actual;
 IF jsonb_array_length(admission.before_snapshot->'orders')<>1 OR jsonb_array_length(admission.after_snapshot->'orders')<>1 THEN
  RAISE EXCEPTION '207 one complete order birth required' USING ERRCODE='23514';END IF;
 before_order:=admission.before_snapshot->'orders'->0;after_order:=admission.after_snapshot->'orders'->0;
 IF before_order->>'id' IS DISTINCT FROM admission.order_id::text
 OR before_order-ARRAY['version','updated_at'] IS DISTINCT FROM after_order-ARRAY['version','updated_at']
 OR(after_order->>'version')::bigint IS DISTINCT FROM(before_order->>'version')::bigint+1 THEN
  RAISE EXCEPTION '207 rejection changed unapproved order data' USING ERRCODE='23514';END IF;
 IF admission.payload#>'{snapshot,return_case}' IS DISTINCT FROM before_header THEN
  RAISE EXCEPTION '207 rejected captured source header differs from before birth' USING ERRCODE='23514';END IF;
 SELECT jsonb_build_object('id',before_order->'id','number',before_order->'number','version',before_order->>'version',
  'status',before_order->'status','warehouse_id',before_order->'warehouse_id','currency',before_order->'currency',
  'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',entry->'id','product_id',entry->'product_id','sku',entry->'sku',
   'name',entry->'name','quantity',entry->'quantity','line_total',entry->'line_total','vat',entry->'vat','components',entry->'components')
   ORDER BY(entry->>'id')::uuid),'[]') FROM jsonb_array_elements(admission.before_snapshot->'order_items')entry),
  'wms_lots_enabled',admission.payload#>'{planner_source,wms,enabled}') INTO wanted;
 IF admission.payload#>'{snapshot,order}' IS DISTINCT FROM wanted
 OR admission.payload#>'{planner_source,wms,enabled}' IS DISTINCT FROM coalesce(admission.payload#>'{snapshot,source,wms_policy,enabled}','false'::jsonb) THEN
  RAISE EXCEPTION '207 rejected captured order/WMS source differs from birth' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',historical_item->'item_id','product_id',historical_order_item->'product_id',
  'sku',historical_item->'sku','name',historical_item->'name','requested',historical_item->'requested',
  'original_quantity',historical_order_item->'quantity','line_total',historical_order_item->'line_total',
  'components',historical_item->'components','ordinal',historical_ordinal) ORDER BY historical_item->>'item_id'),'[]') INTO wanted
 FROM(SELECT historical_item,historical_order_item,row_number() OVER(ORDER BY historical_item->>'item_id')::int historical_ordinal
  FROM jsonb_array_elements(admission.before_snapshot->'return_items')historical_item
  JOIN jsonb_array_elements(admission.before_snapshot->'order_items')historical_order_item
   ON historical_order_item->>'id'=historical_item->>'item_id'
  WHERE historical_item->>'return_id'=admission.return_id::text)original_lines;
 SELECT coalesce(jsonb_agg(entry-'codes' ORDER BY entry->>'item_id'),'[]') INTO actual
  FROM jsonb_array_elements(admission.payload#>'{snapshot,lines}')entry;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION '207 rejected captured original lines differ from birth' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(entry-'codes' ORDER BY entry->>'item_id'),'[]') INTO actual
  FROM jsonb_array_elements(session_row.source->'lines')entry;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION '207 rejected original session lines differ from birth' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',photo.id,'item_id',photo.item_id,'part_id',photo.part_id,'mime',photo.mime,
  'byte_count',photo.byte_count,'sha256',photo.sha256,'width',photo.width,'height',photo.height,'created_at',photo.created_at) ORDER BY photo.id),'[]') INTO actual
  FROM public.return_assistant_photos photo WHERE(photo.tenant_id,photo.session_id)=(tenant,session_row.id);
 IF actual IS DISTINCT FROM admission.payload#>'{snapshot,photos}' THEN RAISE EXCEPTION '207 rejected original photo evidence differs' USING ERRCODE='23514';END IF;
 IF admission.payload#>>'{snapshot,source,financial_hash}' IS DISTINCT FROM public.return_assistant_hash(jsonb_build_object(
  'payments',(SELECT coalesce(jsonb_agg(entry ORDER BY(entry->>'id')::uuid),'[]') FROM jsonb_array_elements(admission.before_snapshot->'payment_entries')entry),
  'documents',(SELECT coalesce(jsonb_agg(entry ORDER BY(entry->>'id')::uuid),'[]') FROM jsonb_array_elements(admission.before_snapshot->'documents')entry))) THEN
  RAISE EXCEPTION '207 rejected source financial birth differs' USING ERRCODE='23514';END IF;

 -- Existing immutable journal members must still be genuine. Later legitimate
 -- stock/position changes and later accepted RMA are deliberately not replayed.
 FOREACH table_name IN ARRAY ARRAY['stock_movements','stock_location_movements','wms_layer_movements','wms_return_fragments','wms_issue_fragments','wms_operations'] LOOP
  SELECT coalesce(jsonb_agg(entry ORDER BY(entry->>'id')::uuid),'[]') INTO wanted FROM jsonb_array_elements(admission.before_snapshot->table_name)entry;
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(native_row) ORDER BY native_row.id),''[]'') FROM public.%I native_row WHERE native_row.tenant_id=$1 AND native_row.id IN(SELECT(entry->>''id'')::uuid FROM jsonb_array_elements($2)entry)',table_name)
   INTO actual USING tenant,admission.before_snapshot->table_name;
  IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION '207 rejected historical journal member changed' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT FROM public.catalog_stock_return_admissions WHERE(tenant_id,return_id)=(tenant,admission.return_id))
 OR EXISTS(SELECT FROM public.catalog_stock_return_receipts WHERE(tenant_id,return_id)=(tenant,admission.return_id) OR(tenant_id,assistant_receipt_id)=(tenant,eid))
 OR EXISTS(SELECT FROM public.catalog_stock_control_effect_admissions WHERE(tenant_id,source_kind,source_id)=(tenant,'return',admission.return_id))
 OR EXISTS(SELECT FROM public.stock_movements WHERE(tenant_id,return_id)=(tenant,admission.return_id))
 OR EXISTS(SELECT FROM public.wms_operations WHERE tenant_id=tenant AND(return_id=admission.return_id OR id=eid))
 OR EXISTS(SELECT FROM public.wms_return_fragments WHERE tenant_id=tenant AND(return_id=admission.return_id OR operation_id=eid))
 OR EXISTS(SELECT FROM public.wms_issue_fragments WHERE(tenant_id,operation_id)=(tenant,eid))
 OR EXISTS(SELECT FROM public.wms_layer_movements WHERE(tenant_id,operation_id)=(tenant,eid)) THEN
  RAISE EXCEPTION '207 rejected inspection cannot borrow169/152/stock/WMS provenance' USING ERRCODE='23514';END IF;
 lineage:=jsonb_build_object('tenant_id',tenant,'destination_admission',to_jsonb(admission),'assistant_admission',to_jsonb(assistant_admission),
  'preview',to_jsonb(preview),'assistant_receipt',to_jsonb(receipt),'completed_session',to_jsonb(session_row),
  'native_plan',native_plan,'rejected_parts',typed_parts,'return_case',after_header,'return_items',typed_items);
 RETURN jsonb_build_object('return_id',admission.return_id,'receipt_id',eid,
  'completed_at',to_char(receipt.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'evidence_hash',public.return_credit206_hash(lineage));
END $rejected207$;
REVOKE ALL ON FUNCTION public.return_credit206_rejected_history(uuid) FROM PUBLIC,dyna_app;

CREATE FUNCTION public.return_credit206_source(did uuid,selected_return uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;d documents;ir local_invoice_receipts;o orders;rc record;rr catalog_stock_return_receipts; financial jsonb;inspection_row record;rejectedj jsonb:='[]';acceptances jsonb:='[]';previousj jsonb:='[]';protocols jsonb:='[]';families jsonb:='[]';cr record;prev uuid;seq integer:=0;resultj jsonb;BEGIN
 PERFORM public.local_invoice_locks();SELECT * INTO d FROM public.documents WHERE(tenant_id,id)=(t,did);
 IF d.id IS NULL OR d.kind<>'invoice' OR d.mode<>'local_invoice' THEN RAISE EXCEPTION 'Brak prawdziwej FV157' USING ERRCODE='P0002';END IF;
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,d.order_id) FOR UPDATE;
 IF NOT EXISTS(SELECT FROM public.catalog_stock_return_receipts native_receipt JOIN public.catalog_stock_return_admissions aa ON(aa.tenant_id,aa.id)=(native_receipt.tenant_id,native_receipt.id) WHERE(native_receipt.tenant_id,native_receipt.order_id)=(t,o.id) AND aa.protocol='destinations_v1' AND aa.sealed) AND NOT EXISTS(SELECT FROM public.return_destination_admissions rejected_admission WHERE(rejected_admission.tenant_id,rejected_admission.order_id)=(t,o.id) AND rejected_admission.after_snapshot IS NOT NULL AND rejected_admission.payload->>'action'='reject' AND rejected_admission.payload#>>'{snapshot,protocol}'='destinations_v1') THEN RAISE EXCEPTION 'Destination successor requires actual received destinations history' USING ERRCODE='23514';END IF;
 SELECT * INTO ir FROM public.local_invoice_receipts WHERE(tenant_id,document_id)=(t,d.id);
 IF ir.id IS NULL OR(d.order_id,d.number) IS DISTINCT FROM(ir.order_id,ir.number)
 OR d.data IS DISTINCT FROM(ir.snapshot||jsonb_build_object('number',ir.number,'preview_id',ir.preview_id,'scope_hash',ir.scope_hash,'local_only',true,'ksef_state','not_submitted','fiscalized',false))
 OR ir.scope_hash IS DISTINCT FROM public.local_invoice_hash(ir.snapshot) OR ir.snapshot->>'currency'<>'PLN' OR ir.snapshot#>>'{buyer,kind}'<>'consumer'
 OR ir.snapshot#>>'{buyer,address,country}'<>'PL' OR ir.snapshot->>'tax_regime'<>'ordinary_domestic' OR ir.snapshot->>'rounding_method'<>'gross_line_half_up'
 OR o.currency<>'PLN' OR o.fulfillment_kind<>'sale' THEN RAISE EXCEPTION 'Obcy original157 snapshot207' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM documents x WHERE(x.tenant_id,x.order_id,x.kind)=(t,o.id,'correction')) OR EXISTS(SELECT FROM invoice_plans x WHERE(x.tenant_id,x.order_id,x.kind)=(t,o.id,'correction') AND x.state NOT IN('preview','cancelled')) THEN RAISE EXCEPTION 'Istniejąca inna korekta wymaga odrębnego uzgodnienia' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.return_cases WHERE(tenant_id,order_id)=(t,o.id) AND received_at IS NOT NULL)>1000 OR (SELECT coalesce(sum(pg_column_size(payload_return.snapshot)),0) FROM public.catalog_stock_return_receipts payload_return WHERE(payload_return.tenant_id,payload_return.order_id)=(t,o.id))+(SELECT coalesce(sum(pg_column_size(payload_credit.snapshot)),0) FROM public.return_credit206_receipts payload_credit WHERE(payload_credit.tenant_id,payload_credit.original_document_id)=(t,did))+(SELECT coalesce(sum(pg_column_size(payload_credit.snapshot)),0) FROM public.local_consumer_credit_receipts payload_credit WHERE(payload_credit.tenant_id,payload_credit.original_document_id)=(t,did))+pg_column_size(ir.snapshot)+(SELECT coalesce(sum(pg_column_size(da.payload)::numeric+pg_column_size(da.before_snapshot)+pg_column_size(da.after_snapshot)+pg_column_size(da.witnesses)+pg_column_size(ar.result)),0) FROM public.return_destination_admissions da JOIN public.return_assistant_receipts ar ON(ar.tenant_id,ar.id)=(da.tenant_id,da.receipt_id) WHERE(da.tenant_id,da.order_id)=(t,o.id) AND da.payload->>'action'='reject')>33554432 THEN RAISE EXCEPTION 'Limit pełnej historii207' USING ERRCODE='54000';END IF;
 FOR inspection_row IN SELECT ar.id FROM public.return_assistant_receipts ar JOIN public.return_destination_admissions da ON(da.tenant_id,da.receipt_id)=(ar.tenant_id,ar.id) WHERE(da.tenant_id,da.order_id)=(t,o.id) AND da.payload->>'action'='reject' AND da.payload#>>'{snapshot,protocol}'='destinations_v1' ORDER BY ar.created_at,ar.id LOOP
  IF jsonb_array_length(rejectedj)>=1000 THEN RAISE EXCEPTION 'Complete rejected inspection budget' USING ERRCODE='54000';END IF;
  rejectedj:=rejectedj||jsonb_build_array(public.return_credit206_rejected_history(inspection_row.id));
 END LOOP;
 IF jsonb_array_length(rejectedj)+(SELECT count(*) FROM public.return_cases WHERE(tenant_id,order_id)=(t,o.id) AND received_at IS NOT NULL)>1000 THEN RAISE EXCEPTION 'Complete physical audit budget' USING ERRCODE='54000';END IF;
 FOR rc IN SELECT * FROM public.return_cases WHERE(tenant_id,order_id)=(t,o.id) AND received_at IS NOT NULL ORDER BY receipt_sequence,id FOR SHARE LOOP
  seq:=seq+1;
  IF rc.legacy OR rc.remedy<>'refund' OR rc.state NOT IN('refund_pending','closed') OR rc.receipt_sequence<>seq THEN RAISE EXCEPTION 'Nieobsługiwany lub niepełny ciąg RMA207' USING ERRCODE='23514';END IF;
  SELECT * INTO rr FROM public.catalog_stock_return_receipts WHERE(tenant_id,return_id,order_id)=(t,rc.id,o.id);
  IF rr.id IS NULL THEN RAISE EXCEPTION 'Brak actual physical169 receipt207' USING ERRCODE='23514';END IF;
  PERFORM public.return_credit206_physical_history(rr.id);
  protocols:=protocols||jsonb_build_array(jsonb_build_object('return_id',rc.id,'receipt_id',rr.id,'protocol',(SELECT protocol FROM public.catalog_stock_return_admissions WHERE(tenant_id,id)=(t,rr.id))));
  financial:=jsonb_build_object('return_id',rc.id,'receipt_id',rr.id,'receipt_sequence',rc.receipt_sequence,
   'received_at',to_char((rr.snapshot#>>'{return_case,received_at}')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'refund_amount_minor',rr.snapshot#>>'{return_case,refund_amount}','refunded_shipping_minor',rr.snapshot#>>'{return_case,refunded_shipping}',
   'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',x->'item_id','accepted',(x->>'accepted')::bigint::text,'restocked',(x->>'restocked')::bigint::text,'refund_amount_minor',(x->>'refund_amount')::bigint::text) ORDER BY x->>'item_id'),'[]') FROM jsonb_array_elements(rr.snapshot->'items')x));
  acceptances:=acceptances||jsonb_build_array(financial||jsonb_build_object('financial_hash',public.return_credit206_hash(financial)));
 END LOOP;
 FOR cr IN SELECT * FROM(
  SELECT r.id,r.document_id,r.return_id,r.return_receipt_id,r.receipt_sequence,r.previous_receipt_id,r.snapshot,r.number,r.year,r.sequence,r.preview_id,r.scope_hash,r.calculation_hash,r.created_at,dc.data,dc.number doc_number,'legacy' family FROM public.local_consumer_credit_receipts r JOIN public.local_consumer_credit_documents dc ON(dc.tenant_id,dc.id)=(r.tenant_id,r.document_id) WHERE(r.tenant_id,r.original_document_id)=(t,did)
  UNION ALL
  SELECT r.id,r.document_id,r.return_id,r.return_receipt_id,r.receipt_sequence,r.previous_receipt_id,r.snapshot,r.number,r.year,r.sequence,r.preview_id,r.scope_hash,r.calculation_hash,r.created_at,dc.data,dc.number doc_number,'destinations' family FROM public.return_credit206_receipts r JOIN public.return_credit206_documents dc ON(dc.tenant_id,dc.id)=(r.tenant_id,r.document_id) WHERE(r.tenant_id,r.original_document_id)=(t,did)
 )all_credits ORDER BY receipt_sequence,id LOOP
  IF cr.previous_receipt_id IS DISTINCT FROM prev OR cr.data IS DISTINCT FROM(cr.snapshot||jsonb_build_object('number',cr.number,'year',cr.year,'sequence',cr.sequence,'preview_id',cr.preview_id,'scope_hash',cr.scope_hash)) OR cr.number IS DISTINCT FROM cr.doc_number OR cr.scope_hash IS DISTINCT FROM public.return_credit206_hash(cr.snapshot) OR cr.calculation_hash IS DISTINCT FROM public.return_credit206_hash(cr.snapshot->'calculation') THEN RAISE EXCEPTION 'Niepełny previous credit207' USING ERRCODE='23514';END IF;
  previousj:=previousj||jsonb_build_array(jsonb_build_object('document_id',cr.document_id,'receipt_id',cr.id,'return_id',cr.return_id,'return_receipt_id',cr.return_receipt_id,'receipt_sequence',cr.receipt_sequence,'calculation',cr.snapshot->'calculation','calculation_hash',cr.calculation_hash));families:=families||jsonb_build_array(jsonb_build_object('document_id',cr.document_id,'receipt_id',cr.id,'family',cr.family,'created_at',to_char(cr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));prev:=cr.id;
 END LOOP;
 resultj:=jsonb_build_object('schema','consumer-return-credit-source/v2','rejected_inspections',rejectedj,'physical_protocols',protocols,'credit_families',families,'original',jsonb_build_object('document',jsonb_build_object('id',d.id,'order_id',d.order_id,'number',d.number,'kind',d.kind,'mode',d.mode,'data',d.data,'created_at',to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),'receipt',jsonb_build_object('id',ir.id,'document_id',ir.document_id,'preview_id',ir.preview_id,'number',ir.number,'scope_hash',ir.scope_hash,'snapshot',ir.snapshot)),'acceptances',acceptances,'previous_credits',previousj,'selected_return_id',selected_return);
 IF octet_length(resultj::text)>33554432 THEN RAISE EXCEPTION 'Całe źródło207 przekracza32MiB' USING ERRCODE='54000';END IF;RETURN resultj;
END$$;
CREATE FUNCTION public.return_credit206_money(g numeric,rate integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE v numeric;BEGIN IF g<0 OR g>9223372036854775807 OR g<>trunc(g) OR rate NOT IN(0,5,8,23) THEN RAISE EXCEPTION 'Niepoprawna kwota207' USING ERRCODE='22023';END IF;v:=floor((2*g*rate+100+rate)/(2*(100+rate)));RETURN jsonb_build_object('gross_minor',g::bigint::text,'net_minor',(g-v)::bigint::text,'vat_minor',v::bigint::text);END$$;
CREATE FUNCTION public.return_credit206_sum(xs jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT jsonb_build_object('gross_minor',coalesce(sum((x->>'gross_minor')::numeric),0)::bigint::text,'net_minor',coalesce(sum((x->>'net_minor')::numeric),0)::bigint::text,'vat_minor',coalesce(sum((x->>'vat_minor')::numeric),0)::bigint::text) FROM jsonb_array_elements(xs)x$$;
CREATE FUNCTION public.return_credit206_minus(a jsonb,b jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$SELECT jsonb_build_object('gross_minor',((a->>'gross_minor')::numeric-(b->>'gross_minor')::numeric)::bigint::text,'net_minor',((a->>'net_minor')::numeric-(b->>'net_minor')::numeric)::bigint::text,'vat_minor',((a->>'vat_minor')::numeric-(b->>'vat_minor')::numeric)::bigint::text)$$;
CREATE FUNCTION public.return_credit206_calculate(x jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE f jsonb:=x#>'{original,document,data}';d jsonb:=x#>'{original,document}';ir jsonb:=x#>'{original,receipt}';accepted jsonb:='{}';prior jsonb;shipping numeric:=0;prior_shipping numeric;a jsonb;it jsonb;ln jsonb;pc jsonb;rowsj jsonb;rowj jsonb;calc jsonb;resultj jsonb;bm jsonb;am jsonb;bt jsonb;atj jsonb;vatj jsonb;g numeric;q numeric;p numeric;n numeric;bg numeric;ag numeric;bq numeric;aq numeric;refund numeric;units numeric;ix integer:=0;ordinal integer;credit_ix integer:=0;chain text;physical text;rate integer;protocol jsonb;family jsonb;first_destination integer;first_destination_at timestamptz;expected_calc jsonb;next_return jsonb:='null';selected_no_change boolean:=false;selected_issued boolean:=false;selected_physical text;outcome text;inspection jsonb;inspection_ix integer:=0;inspection_previous jsonb;BEGIN
 IF octet_length(x::text)>33554432 OR jsonb_typeof(x->'rejected_inspections') IS DISTINCT FROM 'array' OR jsonb_array_length(x->'acceptances')+jsonb_array_length(x->'rejected_inspections') NOT BETWEEN 1 AND 1000 OR jsonb_array_length(f->'lines') NOT BETWEEN 1 AND 101 THEN RAISE EXCEPTION 'Niepełna pełna historia207' USING ERRCODE='22023';END IF;
 IF x->>'schema'<>'consumer-return-credit-source/v2' OR jsonb_array_length(x->'physical_protocols')<>jsonb_array_length(x->'acceptances') OR jsonb_array_length(x->'credit_families')<>jsonb_array_length(x->'previous_credits') OR NOT EXISTS(SELECT FROM jsonb_array_elements(x->'acceptances') AS accepted_entry(value) WHERE accepted_entry.value->'return_id'=x->'selected_return_id') AND NOT EXISTS(SELECT FROM jsonb_array_elements(x->'rejected_inspections') AS inspection_entry(value) WHERE inspection_entry.value->'return_id'=x->'selected_return_id') THEN RAISE EXCEPTION 'Complete financial/physical family source required' USING ERRCODE='23514';END IF;
 SELECT (ordinality-1)::integer INTO first_destination FROM jsonb_array_elements(x->'physical_protocols')WITH ORDINALITY p(value,ordinality) WHERE value->>'protocol'='destinations_v1' ORDER BY ordinality LIMIT 1;
 IF first_destination IS NULL AND jsonb_array_length(x->'rejected_inspections')=0 THEN RAISE EXCEPTION 'Actual destinations history required' USING ERRCODE='23514';END IF;
 first_destination_at:=least(coalesce((x#>>ARRAY['acceptances',first_destination::text,'received_at'])::timestamptz,'infinity'::timestamptz),coalesce((x#>>'{rejected_inspections,0,completed_at}')::timestamptz,'infinity'::timestamptz));
 physical:=public.return_credit206_hash(jsonb_build_object('original_document_id',d->'id','original_receipt_id',ir->'id','physical_history','all_native_acceptances/v1'));
 chain:=public.return_credit206_hash(jsonb_build_object('original_document_id',d->'id','original_receipt_id',ir->'id'));
 FOR inspection IN SELECT value FROM jsonb_array_elements(x->'rejected_inspections') LOOP
  IF jsonb_typeof(inspection->'return_id') IS DISTINCT FROM 'string' OR jsonb_typeof(inspection->'receipt_id') IS DISTINCT FROM 'string' OR jsonb_typeof(inspection->'completed_at') IS DISTINCT FROM 'string' OR jsonb_typeof(inspection->'evidence_hash') IS DISTINCT FROM 'string' OR inspection IS DISTINCT FROM jsonb_build_object('return_id',inspection->'return_id','receipt_id',inspection->'receipt_id','completed_at',inspection->'completed_at','evidence_hash',inspection->'evidence_hash') OR inspection->>'evidence_hash'!~'^[a-f0-9]{64}$' OR (inspection->>'completed_at')::timestamptz::date<(f->>'issue_date')::date
  OR (inspection_previous IS NOT NULL AND ((inspection_previous->>'completed_at')::timestamptz,(inspection_previous->>'receipt_id')::uuid)>=((inspection->>'completed_at')::timestamptz,(inspection->>'receipt_id')::uuid))
  OR (SELECT count(*) FROM jsonb_array_elements(x->'rejected_inspections') AS inspect_unique(value) WHERE inspect_unique.value->'return_id'=inspection->'return_id' OR inspect_unique.value->'receipt_id'=inspection->'receipt_id')<>1
  OR EXISTS(SELECT FROM jsonb_array_elements(x->'acceptances') AS accepted_unique(value) WHERE accepted_unique.value->'return_id'=inspection->'return_id' OR accepted_unique.value->'receipt_id'=inspection->'receipt_id')
  OR EXISTS(SELECT FROM jsonb_array_elements(x->'previous_credits') AS credit_unique(value) WHERE credit_unique.value->'return_id'=inspection->'return_id' OR credit_unique.value->'return_receipt_id'=inspection->'receipt_id') THEN RAISE EXCEPTION 'Incomplete or financialized rejected inspection' USING ERRCODE='23514';END IF;
  PERFORM (inspection->>'return_id')::uuid,(inspection->>'receipt_id')::uuid;inspection_previous:=inspection;
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(x->'acceptances') LOOP
  WHILE inspection_ix<jsonb_array_length(x->'rejected_inspections') AND ((x#>>ARRAY['rejected_inspections',inspection_ix::text,'completed_at'])::timestamptz,(x#>>ARRAY['rejected_inspections',inspection_ix::text,'receipt_id'])::uuid)<=( (a->>'received_at')::timestamptz,(a->>'receipt_id')::uuid) LOOP
   inspection:=x->'rejected_inspections'->inspection_ix;physical:=public.return_credit206_hash(jsonb_build_object('previous_hash',physical,'inspection',inspection));IF inspection->'return_id'=x->'selected_return_id' THEN selected_no_change:=true;END IF;inspection_ix:=inspection_ix+1;
  END LOOP;
  IF(a->>'receipt_sequence')::integer<>ix+1 OR public.return_credit206_hash(a-'financial_hash')<>a->>'financial_hash' OR(a->>'received_at')::date<(f->>'issue_date')::date THEN RAISE EXCEPTION 'Obcy birth financial207' USING ERRCODE='23514';END IF;
  protocol:=x->'physical_protocols'->ix;
  IF protocol->'return_id' IS DISTINCT FROM a->'return_id' OR protocol->'receipt_id' IS DISTINCT FROM a->'receipt_id' OR protocol->>'protocol' NOT IN('rma','assistant_v1','destinations_v1') THEN RAISE EXCEPTION 'Physical family mismatch' USING ERRCODE='23514';END IF;
  physical:=public.return_credit206_hash(jsonb_build_object('previous_hash',physical,'return_id',a->'return_id','receipt_id',a->'receipt_id','receipt_sequence',a->'receipt_sequence','financial_hash',a->'financial_hash','protocol',protocol->'protocol'));
  prior:=accepted;prior_shipping:=shipping;refund:=0;units:=0;
  IF jsonb_array_length(a->'items') NOT BETWEEN 1 AND 101 OR(SELECT count(*) FROM jsonb_array_elements(a->'items'))<>(SELECT count(DISTINCT value->>'item_id') FROM jsonb_array_elements(a->'items')) THEN RAISE EXCEPTION 'Complete unique return items required' USING ERRCODE='23514';END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(a->'items') LOOP
   SELECT val INTO ln FROM jsonb_array_elements(f->'lines')val WHERE val->>'kind'='item' AND val->>'item_id'=it->>'item_id';
   IF ln IS NULL THEN RAISE EXCEPTION 'Obca pozycja207' USING ERRCODE='23514';END IF;q:=(ln->>'quantity')::numeric;g:=(ln->>'gross_minor')::numeric;p:=coalesce((accepted->> (it->>'item_id'))::numeric,0);n:=(it->>'accepted')::numeric;
   IF n<0 OR n<>trunc(n) OR(it->>'restocked')::numeric NOT BETWEEN 0 AND n OR p+n>q OR(it->>'refund_amount_minor')::numeric<>floor(g*(p+n)/q)-floor(g*p/q) THEN RAISE EXCEPTION 'Przekroczony zakres/skala RMA207' USING ERRCODE='23514';END IF;
   accepted:=jsonb_set(accepted,ARRAY[it->>'item_id'],to_jsonb((p+n)::bigint::text));refund:=refund+(it->>'refund_amount_minor')::numeric;units:=units+n;
  END LOOP;
  shipping:=shipping+(a->>'refunded_shipping_minor')::numeric;refund:=refund+(a->>'refunded_shipping_minor')::numeric;
  IF shipping>(f#>>'{order,shipping_cost_minor}')::numeric OR refund<>(a->>'refund_amount_minor')::numeric THEN RAISE EXCEPTION 'Inne całkowite pieniądze207' USING ERRCODE='23514';END IF;
  IF units=0 AND shipping=prior_shipping THEN
   IF EXISTS(SELECT FROM jsonb_array_elements(x->'previous_credits') AS previous_entry(value) WHERE previous_entry.value->'return_id'=a->'return_id' OR previous_entry.value->'return_receipt_id'=a->'receipt_id') THEN RAISE EXCEPTION 'No-change return cannot have a fictitious document' USING ERRCODE='23514';END IF;
   IF a->'return_id'=x->'selected_return_id' THEN selected_no_change:=true;selected_physical:=physical;END IF;
   ix:=ix+1;CONTINUE;
  END IF;
  rowsj:='[]';ordinal:=0;
  FOR ln IN SELECT value FROM jsonb_array_elements(f->'lines') LOOP
   q:=(ln->>'quantity')::numeric;g:=(ln->>'gross_minor')::numeric;rate:=(ln->>'vat_rate')::integer;
   IF ln->>'kind'='shipping' THEN p:=prior_shipping;n:=shipping;bg:=g-p;ag:=g-n;bq:=1;aq:=1;
   ELSE p:=coalesce((prior->>(ln->>'item_id'))::numeric,0);n:=coalesce((accepted->>(ln->>'item_id'))::numeric,0);bg:=g-floor(g*p/q);ag:=g-floor(g*n/q);bq:=q-p;aq:=q-n;END IF;
   bm:=public.return_credit206_money(bg,rate);am:=public.return_credit206_money(ag,rate);
   rowj:=jsonb_build_object('ordinal',ordinal,'kind',ln->'kind','item_id',ln->'item_id','product_id',ln->'product_id','name',ln->'name','sku',ln->'sku','unit',ln->'unit','vat_rate',rate,'before',bm||jsonb_build_object('quantity',bq::bigint::text),'after',am||jsonb_build_object('quantity',aq::bigint::text),'delta',public.return_credit206_minus(am,bm)||jsonb_build_object('quantity',(aq-bq)::bigint::text),'affected',p<>n);
   rowsj:=rowsj||jsonb_build_array(rowj);ordinal:=ordinal+1;
  END LOOP;
  bt:=public.return_credit206_sum((SELECT jsonb_agg(v->'before') FROM jsonb_array_elements(rowsj)v));atj:=public.return_credit206_sum((SELECT jsonb_agg(v->'after') FROM jsonb_array_elements(rowsj)v));vatj:='[]';
  FOR rate IN SELECT DISTINCT(value->>'vat_rate')::integer FROM jsonb_array_elements(rowsj) ORDER BY 1 LOOP
   bm:=public.return_credit206_sum((SELECT jsonb_agg(v->'before') FROM jsonb_array_elements(rowsj)v WHERE(v->>'vat_rate')::integer=rate));am:=public.return_credit206_sum((SELECT jsonb_agg(v->'after') FROM jsonb_array_elements(rowsj)v WHERE(v->>'vat_rate')::integer=rate));vatj:=vatj||jsonb_build_array(jsonb_build_object('vat_rate',rate,'before',bm,'after',am,'delta',public.return_credit206_minus(am,bm)));
  END LOOP;
  calc:=jsonb_build_object('schema','consumer-return-credit-calculation/v2','physical_history_hash',physical,'currency','PLN','tax_method','gross_line_half_up','original_document_id',d->'id','original_receipt_id',ir->'id','original_number',d->'number','original_scope_hash',ir->'scope_hash','return_id',a->'return_id','return_receipt_id',a->'receipt_id','receipt_sequence',a->'receipt_sequence','financial_hash',a->'financial_hash','previous_chain_hash',chain,'rows',rowsj,'totals',jsonb_build_object('before',bt,'after',atj,'delta',public.return_credit206_minus(atj,bt)),'vat_totals',vatj);
  pc:=x->'previous_credits'->credit_ix;
  IF pc IS NOT NULL THEN
   family:=x->'credit_families'->credit_ix;
   IF next_return<>'null'::jsonb OR pc->'return_id' IS DISTINCT FROM a->'return_id' OR pc->'return_receipt_id' IS DISTINCT FROM a->'receipt_id' OR pc->'receipt_sequence' IS DISTINCT FROM a->'receipt_sequence' OR family->'document_id' IS DISTINCT FROM pc->'document_id' OR family->'receipt_id' IS DISTINCT FROM pc->'receipt_id' OR(family->>'created_at')::timestamptz<(a->>'received_at')::timestamptz THEN RAISE EXCEPTION 'Missing earlier original credit or family' USING ERRCODE='23514';END IF;
   expected_calc:=calc;
   IF family->>'family'='legacy' THEN
    IF (a->>'received_at')::timestamptz>=first_destination_at OR(family->>'created_at')::timestamptz>first_destination_at OR EXISTS(SELECT FROM jsonb_array_elements(x->'credit_families')WITH ORDINALITY f(value,ordinality) WHERE ordinality<=credit_ix AND value->>'family'<>'legacy') THEN RAISE EXCEPTION 'Legacy cannot follow destinations/successor' USING ERRCODE='23514';END IF;
    expected_calc:=public.local_consumer_credit_calculate(jsonb_build_object('original',x->'original','acceptances',(SELECT jsonb_agg(value ORDER BY ordinality) FROM jsonb_array_elements(x->'acceptances')WITH ORDINALITY acceptance_prefix(value,ordinality) WHERE ordinality<=ix+1),'previous_credits',(SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') FROM jsonb_array_elements(x->'previous_credits')WITH ORDINALITY credit_prefix(value,ordinality) WHERE ordinality<=credit_ix),'selected_return_id',a->'return_id'));
   ELSIF family->>'family'='destinations' THEN
    IF(family->>'created_at')::timestamptz<first_destination_at THEN RAISE EXCEPTION 'Successor cannot precede actual destinations' USING ERRCODE='23514';END IF;
   ELSE RAISE EXCEPTION 'Unknown previous credit family' USING ERRCODE='23514';END IF;
   IF pc->'calculation' IS DISTINCT FROM expected_calc OR pc->>'calculation_hash'<>public.return_credit206_hash(expected_calc) THEN RAISE EXCEPTION 'Changed complete previous calculation' USING ERRCODE='23514';END IF;
   chain:=public.return_credit206_hash(pc);credit_ix:=credit_ix+1;
   IF a->'return_id'=x->'selected_return_id' THEN selected_issued:=true;END IF;
  ELSIF next_return='null'::jsonb THEN next_return:=a->'return_id';END IF;
  IF a->'return_id'=x->'selected_return_id' THEN resultj:=calc;selected_physical:=physical;END IF;
  ix:=ix+1;
 END LOOP;
 WHILE inspection_ix<jsonb_array_length(x->'rejected_inspections') LOOP
  inspection:=x->'rejected_inspections'->inspection_ix;physical:=public.return_credit206_hash(jsonb_build_object('previous_hash',physical,'inspection',inspection));IF inspection->'return_id'=x->'selected_return_id' THEN selected_no_change:=true;END IF;inspection_ix:=inspection_ix+1;
 END LOOP;
 IF credit_ix<>jsonb_array_length(x->'previous_credits') THEN RAISE EXCEPTION 'Extra previous credit' USING ERRCODE='23514';END IF;
 outcome:=CASE WHEN selected_no_change THEN 'no_commercial_change' WHEN selected_issued THEN 'already_credited' WHEN next_return=x->'selected_return_id' THEN 'credit_required' ELSE 'earlier_acceptance_required' END;
 RETURN jsonb_build_object('status',outcome,'next_return_id',next_return,'selected_return_id',x->'selected_return_id','physical_history_hash',physical,'calculation',CASE WHEN outcome='credit_required' THEN resultj ELSE NULL::jsonb END);
END$$;
CREATE TABLE public.return_credit206_namespaces(seller_tax_id text NOT NULL,prefix text NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenants,series_id uuid NOT NULL,PRIMARY KEY(seller_tax_id,prefix),UNIQUE(tenant_id,series_id),FOREIGN KEY(tenant_id,series_id) REFERENCES public.return_credit206_series(tenant_id,id));
ALTER TABLE return_credit206_namespaces ENABLE ROW LEVEL SECURITY;ALTER TABLE return_credit206_namespaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON return_credit206_namespaces TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY owner_scope ON return_credit206_namespaces TO CURRENT_USER USING(true) WITH CHECK(true);REVOKE ALL ON return_credit206_namespaces FROM PUBLIC,dyna_app;GRANT SELECT ON return_credit206_namespaces TO dyna_app;
CREATE TABLE public.return_credit206_admissions(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,document_id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL,api_key_id uuid,client_key uuid NOT NULL,request_hash text NOT NULL,number text NOT NULL,year integer NOT NULL,sequence integer NOT NULL,root_xid xid8 NOT NULL,transaction_started_at timestamptz NOT NULL,backend_pid integer NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,document_id),FOREIGN KEY(tenant_id,document_id) REFERENCES public.return_credit206_documents(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(tenant_id,preview_id) REFERENCES public.return_credit206_previews(tenant_id,id),FOREIGN KEY(tenant_id,id) REFERENCES public.return_credit206_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED);
ALTER TABLE return_credit206_admissions ENABLE ROW LEVEL SECURITY;ALTER TABLE return_credit206_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON return_credit206_admissions TO dyna_app USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY owner_scope ON return_credit206_admissions TO CURRENT_USER USING(true) WITH CHECK(true);REVOKE ALL ON return_credit206_admissions FROM PUBLIC,dyna_app;
CREATE FUNCTION public.return_credit206_frame(did uuid,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;x jsonb;c jsonb;decision jsonb;v bigint;chosen public.return_credit206_series;BEGIN
 IF b IS DISTINCT FROM jsonb_build_object('client_key',b->>'client_key','original_document_id',did,'return_id',b->>'return_id','expected_return_version',b->>'expected_return_version','reason',b->>'reason','ordinary_domestic_confirmed',true,'local_only',true,'series_id',b->>'series_id','expected_series_version',b->>'expected_series_version')
 OR NOT public.local_invoice_text(b->'reason',3,500) OR b->>'expected_return_version'!~'^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'Niepełny exact request207' USING ERRCODE='22023';END IF;
 x:=public.return_credit206_source(did,(b->>'return_id')::uuid);SELECT version INTO v FROM public.return_cases WHERE(tenant_id,id)=(t,(b->>'return_id')::uuid);
 IF v::text IS DISTINCT FROM b->>'expected_return_version' THEN RAISE EXCEPTION 'RMA zmieniło wersję' USING ERRCODE='23514';END IF;
 decision:=public.return_credit206_calculate(x);IF decision->>'status'<>'credit_required' THEN RAISE EXCEPTION 'No new commercial correction is available' USING ERRCODE='23514';END IF;c:=decision->'calculation';
 SELECT * INTO chosen FROM public.return_credit206_series WHERE(tenant_id,id)=(t,(b->>'series_id')::uuid) FOR SHARE;IF chosen.id IS NULL OR NOT chosen.enabled OR chosen.version::text IS DISTINCT FROM b->>'expected_series_version' THEN RAISE EXCEPTION 'Correction series changed' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('schema','consumer-return-credit/v2','physical_history_hash',decision->'physical_history_hash','correction_series',jsonb_build_object('id',chosen.id,'version',chosen.version::text,'name',chosen.name,'prefix',chosen.prefix),'original_document',x#>'{original,document}','calculation',c,'reason',b->'reason','return_version',v::text,'issue_date',(clock_timestamp() AT TIME ZONE 'UTC')::date::text,'local_only',true,'ksef_state','not_submitted','fiscalized',false);
END$$;
CREATE FUNCTION public.return_credit206_preview(b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p return_credit206_previews;h text;f jsonb;stamp timestamptz;BEGIN
 PERFORM public.return_credit206_require(uid,kid,true,false);PERFORM public.local_invoice_locks();h:=public.local_invoice_request_hash('consumer-return-credit-preview',(b->>'original_document_id')::uuid,b,uid,kid);
 SELECT * INTO p FROM public.return_credit206_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.actor_id,p.api_key_id,p.request_hash,p.request) IS DISTINCT FROM(uid,kid,h,b) THEN RAISE EXCEPTION 'Klucz podglądu207 ma inne dane' USING ERRCODE='23514';END IF;PERFORM public.return_credit206_require(uid,kid,true,true);RETURN to_jsonb(p)||jsonb_build_object('reused',true);END IF;
 IF(SELECT count(*) FROM return_credit206_previews WHERE tenant_id=t)>=2000 THEN RAISE EXCEPTION 'Limit preview207' USING ERRCODE='54000';END IF;
 f:=public.return_credit206_frame((b->>'original_document_id')::uuid,b);stamp:=clock_timestamp();
 INSERT INTO return_credit206_previews(tenant_id,original_document_id,original_receipt_id,order_id,return_id,actor_id,api_key_id,client_key,request,request_hash,scope_hash,calculation_hash,snapshot,created_at,expires_at)
 VALUES(t,(b->>'original_document_id')::uuid,(f#>>'{calculation,original_receipt_id}')::uuid,(f#>>'{original_document,order_id}')::uuid,(b->>'return_id')::uuid,uid,kid,(b->>'client_key')::uuid,b,h,public.return_credit206_hash(f),public.return_credit206_hash(f->'calculation'),f,stamp,stamp+interval '15 minutes') RETURNING * INTO p;
 PERFORM public.return_credit206_require(uid,kid,true,true);RETURN to_jsonb(p)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION public.return_credit206_issue(pid uuid,b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p return_credit206_previews;r return_credit206_receipts;f jsonb;h text;yr integer;seq integer;series uuid;seller text;v_prefix text;claimed record;prev uuid;eid uuid:=gen_random_uuid();did uuid:=gen_random_uuid();num text;BEGIN
 PERFORM public.return_credit206_require(uid,kid,true,false);PERFORM public.local_invoice_locks();h:=public.local_invoice_request_hash('consumer-return-credit-issue',pid,b,uid,kid);
 SELECT * INTO r FROM return_credit206_receipts WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF r.id IS NOT NULL THEN IF(r.preview_id,r.actor_id,r.api_key_id,r.request_hash,r.request) IS DISTINCT FROM(pid,uid,kid,h,b) THEN RAISE EXCEPTION 'Klucz issue207 ma inny oryginał' USING ERRCODE='23514';END IF;PERFORM public.return_credit206_require(uid,kid,true,true);RETURN to_jsonb(r)||jsonb_build_object('reused',true);END IF;
 SELECT * INTO p FROM return_credit206_previews WHERE(tenant_id,id)=(t,pid);
 IF p.id IS NULL THEN RAISE EXCEPTION 'Brak podglądu207' USING ERRCODE='P0002';END IF;
 IF(p.actor_id,p.api_key_id) IS DISTINCT FROM(uid,kid) OR p.expires_at<=clock_timestamp() OR b IS DISTINCT FROM jsonb_build_object('client_key',b->>'client_key','scope_hash',p.scope_hash,'confirmed',true,'local_only',true) THEN RAISE EXCEPTION 'Brak dokładnej bieżącej zgody207' USING ERRCODE='23514';END IF;
 f:=public.return_credit206_frame(p.original_document_id,p.request);
 IF f IS DISTINCT FROM p.snapshot OR public.return_credit206_hash(f)<>p.scope_hash OR public.return_credit206_hash(f->'calculation')<>p.calculation_hash THEN RAISE EXCEPTION 'Pełne źródło207 zmieniło się po preview' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM return_credit206_receipts WHERE(tenant_id,return_id)=(t,p.return_id)) OR EXISTS(SELECT FROM public.local_consumer_credit_receipts WHERE(tenant_id,return_id)=(t,p.return_id)) THEN RAISE EXCEPTION 'RMA ma już oryginalną KOR207' USING ERRCODE='23514';END IF;
 series:=(f#>>'{correction_series,id}')::uuid;v_prefix:=f#>>'{correction_series,prefix}';seller:=f#>>'{original_document,data,seller,tax_id}';yr:=extract(year FROM(f->>'issue_date')::date)::integer;
 PERFORM pg_advisory_xact_lock(hashtextextended('consumer-credit-namespace:'||seller||':'||v_prefix,0));
 SELECT * INTO claimed FROM return_credit206_namespaces WHERE seller_tax_id=seller AND return_credit206_namespaces.prefix=v_prefix;
 IF FOUND AND(claimed.tenant_id,claimed.series_id) IS DISTINCT FROM(t,series) THEN RAISE EXCEPTION 'Numeracja KOR207 jest już przypisana do innego źródła' USING ERRCODE='23514';END IF;
 IF NOT FOUND THEN INSERT INTO return_credit206_namespaces VALUES(seller,v_prefix,t,series);END IF;
 SELECT last_number INTO seq FROM return_credit206_counters WHERE(tenant_id,series_id,year)=(t,series,yr) FOR UPDATE;seq:=coalesce(seq,0)+1;IF seq>999999 THEN RAISE EXCEPTION 'Limit rocznej numeracji207' USING ERRCODE='54000';END IF;
 num:=v_prefix||'/'||yr::text||'/'||lpad(seq::text,6,'0');SELECT id INTO prev FROM(SELECT id,receipt_sequence FROM public.return_credit206_receipts WHERE(tenant_id,original_document_id)=(t,p.original_document_id) UNION ALL SELECT id,receipt_sequence FROM public.local_consumer_credit_receipts WHERE(tenant_id,original_document_id)=(t,p.original_document_id))credits ORDER BY receipt_sequence DESC LIMIT 1;
 INSERT INTO return_credit206_admissions VALUES(eid,t,did,p.id,uid,kid,(b->>'client_key')::uuid,h,num,yr,seq,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid());
 INSERT INTO return_credit206_documents VALUES(did,t,p.original_document_id,p.order_id,p.return_id,'correction','consumer_return_credit',num,f||jsonb_build_object('number',num,'year',yr,'sequence',seq,'preview_id',p.id,'scope_hash',p.scope_hash),clock_timestamp());
 INSERT INTO return_credit206_receipts(id,tenant_id,document_id,preview_id,original_document_id,original_receipt_id,order_id,return_id,return_receipt_id,receipt_sequence,previous_receipt_id,actor_id,api_key_id,client_key,request,request_hash,scope_hash,calculation_hash,snapshot,series_id,year,sequence,number,root_xid,transaction_started_at,backend_pid)
 VALUES(eid,t,did,p.id,p.original_document_id,p.original_receipt_id,p.order_id,p.return_id,(f#>>'{calculation,return_receipt_id}')::uuid,(f#>>'{calculation,receipt_sequence}')::integer,prev,uid,kid,(b->>'client_key')::uuid,b,h,p.scope_hash,p.calculation_hash,f,series,yr,seq,num,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) RETURNING * INTO r;
 IF seq=1 THEN INSERT INTO return_credit206_counters VALUES(t,series,yr,seq);ELSE UPDATE return_credit206_counters SET last_number=seq WHERE(tenant_id,series_id,year)=(t,series,yr);END IF;
 PERFORM public.return_credit206_require(uid,kid,true,true);RETURN to_jsonb(r)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION public.return_credit206_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE p return_credit206_previews;a return_credit206_admissions;f jsonb;BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Obcy record207' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='return_credit206_previews' THEN
  PERFORM public.return_credit206_require(NEW.actor_id,NEW.api_key_id,true,false);f:=public.return_credit206_frame(NEW.original_document_id,NEW.request);
  IF NEW.client_key IS DISTINCT FROM(NEW.request->>'client_key')::uuid OR NEW.request_hash IS DISTINCT FROM public.local_invoice_request_hash('consumer-return-credit-preview',NEW.original_document_id,NEW.request,NEW.actor_id,NEW.api_key_id) OR NEW.created_at<transaction_timestamp() OR NEW.expires_at>NEW.created_at+interval '15 minutes' OR f IS DISTINCT FROM NEW.snapshot OR NEW.scope_hash<>public.return_credit206_hash(f) OR NEW.calculation_hash<>public.return_credit206_hash(f->'calculation') OR(NEW.order_id,NEW.return_id,NEW.original_receipt_id) IS DISTINCT FROM((f#>>'{original_document,order_id}')::uuid,(f#>>'{calculation,return_id}')::uuid,(f#>>'{calculation,original_receipt_id}')::uuid) THEN RAISE EXCEPTION 'Fałszywy snapshot207' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='return_credit206_admissions' THEN
  SELECT * INTO p FROM return_credit206_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);PERFORM public.return_credit206_require(NEW.actor_id,NEW.api_key_id,true,false);
  IF p.id IS NULL OR(p.actor_id,p.api_key_id) IS DISTINCT FROM(NEW.actor_id,NEW.api_key_id) OR(NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) THEN RAISE EXCEPTION 'Brak current typed admission207' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='return_credit206_receipts' THEN
  SELECT * INTO a FROM return_credit206_admissions WHERE(tenant_id,id)=(NEW.tenant_id,NEW.id);SELECT * INTO p FROM return_credit206_previews WHERE(tenant_id,id)=(NEW.tenant_id,NEW.preview_id);
  IF a.id IS NULL OR(NEW.document_id,NEW.preview_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request_hash,NEW.number,NEW.year,NEW.sequence,NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid) IS DISTINCT FROM(a.document_id,a.preview_id,a.actor_id,a.api_key_id,a.client_key,a.request_hash,a.number,a.year,a.sequence,a.root_xid,a.transaction_started_at,a.backend_pid)
   OR(NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) OR NEW.snapshot IS DISTINCT FROM p.snapshot OR NEW.scope_hash<>p.scope_hash OR NEW.calculation_hash<>p.calculation_hash THEN RAISE EXCEPTION 'Fałszywy receipt207' USING ERRCODE='23514';END IF;
  IF(NEW.original_document_id,NEW.original_receipt_id,NEW.order_id,NEW.return_id,NEW.return_receipt_id,NEW.receipt_sequence,NEW.series_id) IS DISTINCT FROM(p.original_document_id,p.original_receipt_id,p.order_id,p.return_id,(p.snapshot#>>'{calculation,return_receipt_id}')::uuid,(p.snapshot#>>'{calculation,receipt_sequence}')::integer,(p.snapshot#>>'{correction_series,id}')::uuid)
   OR NEW.previous_receipt_id IS DISTINCT FROM(SELECT cr.id FROM(SELECT id,receipt_sequence FROM public.return_credit206_receipts WHERE(tenant_id,original_document_id)=(NEW.tenant_id,NEW.original_document_id) UNION ALL SELECT id,receipt_sequence FROM public.local_consumer_credit_receipts WHERE(tenant_id,original_document_id)=(NEW.tenant_id,NEW.original_document_id))cr ORDER BY cr.receipt_sequence DESC LIMIT 1)
   OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
   OR NEW.request_hash IS DISTINCT FROM public.local_invoice_request_hash('consumer-return-credit-issue',p.id,NEW.request,NEW.actor_id,NEW.api_key_id)
   OR NEW.number IS DISTINCT FROM((p.snapshot#>>'{correction_series,prefix}')||'/'||NEW.year::text||'/'||lpad(NEW.sequence::text,6,'0'))
   OR NEW.year IS DISTINCT FROM extract(year FROM(p.snapshot->>'issue_date')::date)::integer THEN RAISE EXCEPTION 'Inny pełny oryginalny receipt207' USING ERRCODE='23514';END IF;
  PERFORM public.return_credit206_require(NEW.actor_id,NEW.api_key_id,true,false);
 END IF;RETURN NEW;
END$$;
CREATE FUNCTION public.return_credit206_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a return_credit206_admissions;p return_credit206_previews;BEGIN
 SELECT * INTO a FROM return_credit206_admissions WHERE(tenant_id,document_id)=(NEW.tenant_id,NEW.id);SELECT * INTO p FROM return_credit206_previews WHERE(tenant_id,id)=(NEW.tenant_id,a.preview_id);
 IF a.id IS NULL OR(NEW.kind,NEW.mode,NEW.original_document_id,NEW.order_id,NEW.return_id,NEW.number) IS DISTINCT FROM('correction','consumer_return_credit',p.original_document_id,p.order_id,p.return_id,a.number)
 OR(a.root_xid,a.transaction_started_at,a.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) OR NEW.data IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash)) THEN RAISE EXCEPTION 'Dokument bez prawdziwego issue207' USING ERRCODE='23514';END IF;
 PERFORM public.return_credit206_require(a.actor_id,a.api_key_id,true,false);RETURN NEW;
END$$;
CREATE FUNCTION public.return_credit206_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
 IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number) IS DISTINCT FROM(OLD.tenant_id,OLD.series_id,OLD.year,OLD.last_number+1))
 OR(TG_OP='INSERT' AND NEW.last_number<>1) OR NOT EXISTS(SELECT FROM return_credit206_receipts r WHERE(r.tenant_id,r.series_id,r.year,r.sequence,r.root_xid,r.transaction_started_at,r.backend_pid)=(NEW.tenant_id,NEW.series_id,NEW.year,NEW.last_number,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())) THEN RAISE EXCEPTION 'Numeracja bez prawdziwego receipt207' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE FUNCTION public.return_credit206_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE rid uuid;r return_credit206_receipts;d return_credit206_documents;p return_credit206_previews;BEGIN
 IF TG_TABLE_NAME='return_credit206_admissions' THEN rid:=NEW.id;ELSIF TG_TABLE_NAME='return_credit206_receipts' THEN rid:=NEW.id;ELSE SELECT id INTO rid FROM return_credit206_receipts WHERE(tenant_id,document_id)=(NEW.tenant_id,NEW.id);END IF;
 SELECT * INTO r FROM return_credit206_receipts WHERE(tenant_id,id)=(NEW.tenant_id,rid);SELECT * INTO d FROM return_credit206_documents WHERE(tenant_id,id)=(NEW.tenant_id,r.document_id);SELECT * INTO p FROM return_credit206_previews WHERE(tenant_id,id)=(NEW.tenant_id,r.preview_id);
 IF r.id IS NULL OR d.id IS NULL OR p.id IS NULL OR d.data IS DISTINCT FROM(r.snapshot||jsonb_build_object('number',r.number,'year',r.year,'sequence',r.sequence,'preview_id',r.preview_id,'scope_hash',r.scope_hash)) OR NOT EXISTS(SELECT FROM return_credit206_counters WHERE(tenant_id,series_id,year,last_number)=(r.tenant_id,r.series_id,r.year,r.sequence)) THEN RAISE EXCEPTION 'Niepełny trwały credit207' USING ERRCODE='23514';END IF;PERFORM public.return_credit206_require(r.actor_id,r.api_key_id,true,false);RETURN NEW;
END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['return_credit206_series','return_credit206_previews','return_credit206_documents','return_credit206_receipts','return_credit206_admissions','return_credit206_namespaces','return_credit206_manifest'] LOOP EXECUTE format('CREATE TRIGGER return_credit206_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION return_credit206_immutable()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['return_credit206_previews','return_credit206_admissions','return_credit206_receipts'] LOOP EXECUTE format('CREATE TRIGGER return_credit206_record_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION return_credit206_record_guard()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['return_credit206_documents','return_credit206_admissions','return_credit206_receipts'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER return_credit206_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION return_credit206_complete()',tab);END LOOP;
 END$$;
CREATE TRIGGER return_credit206_document_guard BEFORE INSERT ON return_credit206_documents FOR EACH ROW EXECUTE FUNCTION return_credit206_document_guard();
CREATE TRIGGER return_credit206_counter_guard BEFORE INSERT OR UPDATE OR DELETE ON return_credit206_counters FOR EACH ROW EXECUTE FUNCTION return_credit206_counter_guard();
CREATE FUNCTION public.return_credit206_installed() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM migrations WHERE name='207_consumer_return_credit')$$;

CREATE FUNCTION public.return_credit206_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,x.attgenerated,x.attidentity,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'return\_credit206\_%' ESCAPE '\' AND c.relkind IN('r','p')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,p.proretset,p.prorettype,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.proargmodes,p.proargnames,pg_get_expr(p.proargdefaults,0),(SELECT lanname FROM pg_language WHERE oid=p.prolang),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'return\_credit206\_%' ESCAPE '\'),
 'documents_checks',(SELECT jsonb_agg(jsonb_build_array(conname,convalidated,pg_get_constraintdef(oid,true)) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.documents'::regclass AND conname IN('documents_kind_check','documents_proforma_local','documents_native_invoice')),
 'document_indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,i.indisvalid,pg_get_indexdef(i.indexrelid)) ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN('document_order_mode','document_demo_number')),
 'parent_triggers',(SELECT jsonb_agg(jsonb_build_array(tgname,tgenabled,pg_get_triggerdef(oid,true)) ORDER BY tgrelid::regclass::text,tgname) FROM pg_trigger WHERE tgname IN('return_credit206_document_guard','return_credit206_seal'))
 )::text,'UTF8')),'hex') $$;
CREATE FUNCTION public.return_credit206_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE c record;BEGIN
 IF current_setting('session_replication_role')<>'origin' OR(SELECT count(*) FROM return_credit206_manifest)<>1 OR(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'return\_credit206\_%' ESCAPE '\' AND relkind IN('r','p') AND relrowsecurity AND relforcerowsecurity)<>8 THEN RETURN false;END IF;
 SELECT * INTO c FROM return_credit206_manifest WHERE id;
 RETURN coalesce(c.profile='157+139+148+169+188-to207-consumer-credit/v2' AND c.fingerprint=public.return_credit206_fingerprint()
 AND c.original157=(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id) AND c.original160=(SELECT to_jsonb(m) FROM b2b_credit_upgrade m WHERE id)
 AND public.local_invoice_guards() AND public.catalog_stock_return_guards() AND public.b2b_credit_guards() AND public.local_consumer_credit_guards() AND public.ordinary188_structure_valid(),false);
END$$;
CREATE FUNCTION public.return_credit206_terminal(uid uuid,kid uuid,writing boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN PERFORM public.return_credit206_require(uid,kid,writing,true);END$$;
CREATE FUNCTION public.return_credit206_series_create(b jsonb,uid uuid,kid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r public.return_credit206_series;h text;
BEGIN
 PERFORM public.return_credit206_require(uid,kid,true,false);PERFORM public.local_invoice_locks();
 IF b IS DISTINCT FROM jsonb_build_object('client_key',b->>'client_key','name',b->>'name','prefix',b->>'prefix') OR NOT public.local_invoice_text(b->'name',1,120) OR b->>'prefix'!~'^[A-Z0-9][A-Z0-9-]{0,23}$' THEN RAISE EXCEPTION 'Incomplete correction series' USING ERRCODE='22023';END IF;
 h:=public.local_invoice_request_hash('consumer-return-credit-series',(b->>'client_key')::uuid,b,uid,kid);
 SELECT * INTO r FROM public.return_credit206_series WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF r.id IS NOT NULL THEN IF(r.actor_id,r.api_key_id,r.request_hash,r.request) IS DISTINCT FROM(uid,kid,h,b) THEN RAISE EXCEPTION 'Series command has another original' USING ERRCODE='23514';END IF;PERFORM public.return_credit206_require(uid,kid,true,true);RETURN to_jsonb(r)||jsonb_build_object('reused',true);END IF;
 IF(SELECT count(*) FROM public.return_credit206_series WHERE tenant_id=t)>=100 THEN RAISE EXCEPTION 'Correction series capacity' USING ERRCODE='54000';END IF;
 INSERT INTO public.return_credit206_series(tenant_id,actor_id,api_key_id,client_key,request,request_hash,name,prefix) VALUES(t,uid,kid,(b->>'client_key')::uuid,b,h,b->>'name',b->>'prefix') RETURNING * INTO r;
 PERFORM public.return_credit206_require(uid,kid,true,true);RETURN to_jsonb(r)||jsonb_build_object('reused',false);
END$$;
CREATE FUNCTION public.return_credit206_series_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.return_credit206_require(NEW.actor_id,NEW.api_key_id,true,false);
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'name',NEW.name,'prefix',NEW.prefix) OR NEW.request_hash IS DISTINCT FROM public.local_invoice_request_hash('consumer-return-credit-series',NEW.client_key,NEW.request,NEW.actor_id,NEW.api_key_id) OR NEW.version<>1 OR NOT NEW.enabled OR NEW.created_at<transaction_timestamp() THEN RAISE EXCEPTION 'No original correction series command' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER return_credit206_series_guard BEFORE INSERT ON public.return_credit206_series FOR EACH ROW EXECUTE FUNCTION public.return_credit206_series_guard();
DO $$DECLARE fn record;BEGIN FOR fn IN SELECT p.oid::regprocedure sig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'return\_credit206\_%' ESCAPE '\' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig);END LOOP;END$$;
GRANT EXECUTE ON FUNCTION return_credit206_series_create(jsonb,uuid,uuid),return_credit206_installed(),return_credit206_guards(),return_credit206_preview(jsonb,uuid,uuid),return_credit206_issue(uuid,jsonb,uuid,uuid),return_credit206_terminal(uuid,uuid,boolean) TO dyna_app;
INSERT INTO return_credit206_manifest(id,profile,fingerprint,original157,original160) SELECT true,'157+139+148+169+188-to207-consumer-credit/v2',public.return_credit206_fingerprint(),(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id),(SELECT to_jsonb(m) FROM b2b_credit_upgrade m WHERE id);
DO $$BEGIN IF NOT public.return_credit206_guards() THEN RAISE EXCEPTION 'Pełny nowy profil207 odmówił' USING ERRCODE='55000';END IF;END$$;
