-- SOURCE_AUTHORED_NOT_RUN. Additive owner-only historical reader, not a credit writer.
-- Old148/188 definitions, manifests, tables, triggers, counters and ACLs stay literal.
-- This file is deliberately not registered in db/resources or a runtime contract.
DO $pre206$ BEGIN
 IF current_user<>'postgres' OR session_user<>current_user OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION '206 owner origin required' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'return_credit206_')) THEN
  RAISE EXCEPTION '206 unexpected existing namespace' USING ERRCODE='55000';END IF;
 IF public.catalog_header205_valid() IS DISTINCT FROM true OR public.local_consumer_credit_guards() IS DISTINCT FROM true
 OR public.ordinary188_structure_valid() IS DISTINCT FROM true OR public.return_destination_guards() IS DISTINCT FROM true
 OR public.catalog_stock_return_guards() IS DISTINCT FROM true THEN
  RAISE EXCEPTION '206 complete literal205/188/148/169 predecessor required' USING ERRCODE='55000';END IF;
END $pre206$;
CREATE FUNCTION public.return_credit206_parent(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $history206$
DECLARE
 t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
 a public.catalog_stock_return_admissions;r public.catalog_stock_return_receipts;
 d public.return_destination_admissions;p public.return_assistant_previews;
 ar public.return_assistant_receipts;aa public.return_assistant_admissions;
 ea public.catalog_stock_control_effect_admissions;e public.catalog_stock_control_effects;
 plan jsonb;request148 jsonb;actual jsonb;wanted jsonb;op public.wms_operations;
 key text;nm text;journal_key text;rowcount bigint;bytes numeric;
BEGIN
 -- Historical evidence only. This does not grant current user/key authority,
 -- renew a lease, replay a physical receipt, or reserve any credit/number.
 IF current_user<>'postgres' OR session_user<>'postgres' OR t IS NULL
 OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION '206 own owner/tenant/origin required' USING ERRCODE='42501';END IF;
 IF public.catalog_header205_valid() IS DISTINCT FROM true
 OR public.local_consumer_credit_guards() IS DISTINCT FROM true
 OR public.return_destination_guards() IS DISTINCT FROM true
 OR public.catalog_stock_return_guards() IS DISTINCT FROM true THEN
  RAISE EXCEPTION '206 complete unchanged predecessors required' USING ERRCODE='55000';END IF;
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE(tenant_id,id)=(t,eid);
 SELECT * INTO r FROM public.catalog_stock_return_receipts WHERE(tenant_id,id)=(t,eid);
 IF a.id IS NULL OR r.id IS NULL OR NOT a.sealed OR a.protocol IS DISTINCT FROM 'destinations_v1'
 OR a.txid=pg_current_xact_id() OR r.assistant_receipt_id IS NULL
 OR r.exchange_id IS NOT NULL OR r.dropship_admission_id IS NOT NULL
 OR r.local_proof_id IS NOT NULL OR r.parcel_receipt_return_id IS NOT NULL
 OR(r.order_id,r.return_id) IS DISTINCT FROM(a.order_id,a.return_id) THEN
  RAISE EXCEPTION '206 exact completed historical148/169 required' USING ERRCODE='23514';END IF;
 SELECT * INTO d FROM public.return_destination_admissions WHERE(tenant_id,receipt_id)=(t,r.assistant_receipt_id);
 SELECT * INTO p FROM public.return_assistant_previews WHERE(tenant_id,id)=(t,a.preview_id);
 SELECT * INTO ar FROM public.return_assistant_receipts WHERE(tenant_id,id)=(t,r.assistant_receipt_id);
 SELECT * INTO aa FROM public.return_assistant_admissions WHERE(tenant_id,transaction_id,receipt_id)=(t,a.txid,r.assistant_receipt_id);
 SELECT * INTO ea FROM public.catalog_stock_control_effect_admissions WHERE(tenant_id,id)=(t,eid);
 SELECT * INTO e FROM public.catalog_stock_control_effects WHERE(tenant_id,admission_id)=(t,eid);
 IF d.receipt_id IS NULL OR p.id IS NULL OR ar.id IS NULL OR aa.receipt_id IS NULL
 OR ea.id IS NULL OR e.admission_id IS NULL OR NOT ea.sealed OR d.after_snapshot IS NULL
 OR(d.preview_id,d.session_id,d.return_id,d.order_id,d.actor_id,d.api_key_id,d.transaction_id)
  IS DISTINCT FROM(a.preview_id,ar.session_id,a.return_id,a.order_id,a.actor_id,a.api_key_id,a.txid)
 OR(ar.preview_id,ar.session_id,ar.return_id,ar.order_id,ar.actor_id,ar.api_key_id,ar.client_key,ar.request_hash,ar.payload)
  IS DISTINCT FROM(d.preview_id,d.session_id,d.return_id,d.order_id,d.actor_id,d.api_key_id,d.client_key,d.request_hash,d.payload)
 OR(aa.preview_id,aa.session_id,aa.return_id,aa.actor_id,aa.api_key_id,aa.client_key,aa.request_hash,aa.payload)
  IS DISTINCT FROM(d.preview_id,d.session_id,d.return_id,d.actor_id,d.api_key_id,d.client_key,d.request_hash,d.payload)
 OR(p.session_id,p.return_id,p.order_id,p.actor_id,p.api_key_id,p.payload,p.scope_hash)
  IS DISTINCT FROM(d.session_id,d.return_id,d.order_id,d.actor_id,d.api_key_id,d.payload,ar.scope_hash)
 OR(ea.source_kind,ea.source_id,ea.actor_id,ea.api_key_id,ea.txid,e.operation_id)
  IS DISTINCT FROM('return'::text,a.return_id,a.actor_id,a.api_key_id,a.txid,r.wms_operation_id)
 OR e.warehouse_document_id IS NOT NULL OR e.purchase_receipt_id IS NOT NULL OR e.dispatch_receipt_id IS NOT NULL
 OR e.adjustment_receipt_id IS NOT NULL OR e.location_operation_id IS NOT NULL
 OR d.payload->>'action' IS DISTINCT FROM 'receive'
 OR d.payload#>>'{snapshot,protocol}' IS DISTINCT FROM 'destinations_v1'
 OR d.payload->'receive_input' IS DISTINCT FROM a.frame->'request'
 OR ar.scope_hash IS DISTINCT FROM public.return_assistant_hash(d.payload||jsonb_build_object('private_scope_nonce',p.private_scope_nonce))
 OR d.request_hash IS DISTINCT FROM public.return_assistant_hash(jsonb_build_object('tenant_id',t,'preview_id',p.id,'kind','destinations_receive','request',d.request,'actor_id',d.actor_id,'api_key_id',d.api_key_id))
 OR NOT EXISTS(SELECT FROM public.return_assistant_sessions s WHERE(s.tenant_id,s.id,s.return_id,s.order_id)=(t,d.session_id,a.return_id,a.order_id) AND s.state='completed') THEN
  RAISE EXCEPTION '206 incomplete native parent148 lineage' USING ERRCODE='23514';END IF;
 -- Bound before constructing comparison arrays. Never truncate proof history.
 bytes:=pg_column_size(d.payload)::numeric+pg_column_size(d.before_snapshot)+pg_column_size(d.after_snapshot)
  +pg_column_size(a.frame)+pg_column_size(r.snapshot)+pg_column_size(ea.before_frame)+pg_column_size(e.after_frame);
 IF bytes>33554432 OR jsonb_array_length(aa.witnesses)>10000 OR jsonb_array_length(d.witnesses)>10000 THEN
  RAISE EXCEPTION '206 complete native parent exceeds budget' USING ERRCODE='54000';END IF;
 FOREACH nm IN ARRAY ARRAY['return_destination_parts','return_destination_arrivals','return_destination_fragments'] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id=$1 AND receipt_id=$2',nm) INTO rowcount USING t,d.receipt_id;
  IF rowcount>10000 THEN RAISE EXCEPTION '206 complete native rows exceed budget' USING ERRCODE='54000';END IF;
 END LOOP;
 -- Recompute the immutable native plan from its captured source, never current
 -- product prices/policies or browser arithmetic. Leases are historical here.
 request148:=d.payload#>'{snapshot,request}'||jsonb_build_object('client_key',p.client_key,'lease_token',d.request->'lease_token');
 plan:=public.return_destination_plan(d.payload->'planner_source',request148);
 IF plan IS DISTINCT FROM d.payload->'plan' OR plan IS DISTINCT FROM d.payload#>'{snapshot,plan}'
 OR(plan->>'return_id',plan->>'order_id') IS DISTINCT FROM(a.return_id::text,a.order_id::text)
 OR ar.result->'receipt' IS DISTINCT FROM a.frame->'request'
 OR(ar.result->>'state',ar.result->>'version',ar.result->>'refund_amount',ar.result->>'refunded_shipping')
  IS DISTINCT FROM(r.snapshot#>>'{return_case,state}',r.snapshot#>>'{return_case,version}',r.snapshot#>>'{return_case,refund_amount}',r.snapshot#>>'{return_case,refunded_shipping}')
 OR r.snapshot#>'{return_case,received_at}' IS DISTINCT FROM ar.result->'received_at'
 OR r.snapshot#>'{return_case,decision_note}' IS DISTINCT FROM ar.result->'decision_note'
 OR(r.snapshot#>>'{return_case,refund_amount}')::numeric IS DISTINCT FROM(plan#>>'{summary,commercial_credit_minor}')::numeric
 OR(r.snapshot#>>'{return_case,refunded_shipping}')::numeric IS DISTINCT FROM(plan#>>'{summary,shipping_refund_minor}')::numeric THEN
  RAISE EXCEPTION '206 native immutable commercial result differs' USING ERRCODE='23514';END IF;
 -- Frozen received birth must occur in the native148 after snapshot, not just
 -- equal a currently mutable header. Settlement may change later in188 flow.
 IF (d.after_snapshot->'return_cases' @> jsonb_build_array(r.snapshot->'return_case')) IS DISTINCT FROM true
 OR EXISTS(SELECT FROM jsonb_array_elements(r.snapshot->'items')i
  WHERE(d.after_snapshot->'return_items' @> jsonb_build_array(i)) IS DISTINCT FROM true) THEN
  RAISE EXCEPTION '206 received birth is absent from native after snapshot' USING ERRCODE='23514';END IF;
 -- Destination148 uses its own native WMS request, not the ordinary RMA
 -- receive_input. Bind it to the immutable operation captured at birth.
 IF (d.payload#>>'{planner_source,wms,enabled}')::boolean THEN
  SELECT * INTO op FROM public.wms_operations WHERE(tenant_id,id)=(t,r.wms_operation_id);
  IF op.id IS NULL OR op.id IS DISTINCT FROM d.receipt_id OR op.kind IS DISTINCT FROM 'return'
  OR(op.order_id,op.return_id,op.actor_id) IS DISTINCT FROM(a.order_id,a.return_id,a.actor_id)
  OR op.request IS DISTINCT FROM jsonb_build_object('protocol','destinations_v1','admission_id',d.receipt_id,
   'preview_id',d.preview_id,'return_id',a.return_id,'order_id',a.order_id,
   'parts',(SELECT jsonb_agg(x->>'part_id' ORDER BY(x->>'part_id') COLLATE "C") FROM jsonb_array_elements(plan->'parts')x))
  OR(d.after_snapshot->'wms_operations' @> jsonb_build_array(to_jsonb(op))) IS DISTINCT FROM true
  OR EXISTS(SELECT FROM jsonb_array_elements(d.before_snapshot->'wms_operations')x WHERE x->>'id'=op.id::text) THEN
   RAISE EXCEPTION '206 native destination WMS operation differs' USING ERRCODE='23514';END IF;
 ELSIF r.wms_operation_id IS NOT NULL OR jsonb_array_length(plan->'private_fragment_effects')<>0 THEN
  RAISE EXCEPTION '206 OFF cannot introduce WMS provenance' USING ERRCODE='23514';END IF;
 -- Compare all typed columns plus snapshot: stale status revisions remain
 -- legitimate historical evidence; current active flags are not replayed.
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') INTO actual
 FROM public.return_destination_parts x WHERE(x.tenant_id,x.receipt_id)=(t,d.receipt_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('tenant_id',t,'id',(x->>'part_id')::uuid,'receipt_id',d.receipt_id,
  'preview_id',d.preview_id,'session_id',d.session_id,'return_id',a.return_id,'order_id',a.order_id,'item_id',(x->>'item_id')::uuid,
  'quantity',(x->>'quantity')::integer,'status_id',(x#>>'{status,status_id}')::uuid,'status_version',(x#>>'{status,version}')::bigint,
  'status_revision_id',(x#>>'{status,revision_id}')::uuid,'decision',x#>>'{status,decision}','effect',x#>>'{status,inventory_effect}',
  'warehouse_id',(x#>>'{status,warehouse_id}')::uuid,'warehouse_policy_version',(x#>>'{status,warehouse_policy_version}')::bigint,
  'refund_minor',(x->>'refund_minor')::bigint,'snapshot',x) ORDER BY(x->>'part_id')::uuid),'[]')
 INTO wanted FROM jsonb_array_elements(plan->'parts')x;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION '206 full typed sale/custody/reject parts differ' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') INTO actual
 FROM public.return_destination_arrivals x WHERE(x.tenant_id,x.receipt_id)=(t,d.receipt_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('tenant_id',t,'id',public.return_destination_identity(d.receipt_id,'arrival:'||(x->>'part_id')||':'||(x->>'product_id')),
  'receipt_id',d.receipt_id,'part_id',(x->>'part_id')::uuid,'return_id',a.return_id,'order_id',a.order_id,'item_id',(x->>'item_id')::uuid,
  'product_id',(x->>'product_id')::uuid,'warehouse_id',(x->>'warehouse_id')::uuid,'location',x->>'location','quantity',(x->>'quantity')::integer,'effect',x->>'effect')
  ORDER BY public.return_destination_identity(d.receipt_id,'arrival:'||(x->>'part_id')||':'||(x->>'product_id'))),'[]')
 INTO wanted FROM jsonb_array_elements(plan->'arrivals')x;
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION '206 full typed arrivals differ' USING ERRCODE='23514';END IF;
 -- Every native fragment is a typed member of one arrival; compare bags to
 -- retain multiplicity when several parts share an original issue fragment.
 SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY to_jsonb(v)::text),'[]') INTO actual FROM(
  SELECT df.part_id::text part_id,df.item_id::text item_id,df.product_id::text product_id,df.warehouse_id::text warehouse_id,
   df.location,df.quantity,df.effect,df.issue_fragment_id::text issue_fragment_id,df.layer_id::text layer_id,
   l.unit_cost_minor::text unit_cost_minor,f.value_minor::text value_minor,CASE WHEN l.unit_cost_minor IS NULL THEN df.quantity ELSE 0 END unknown_quantity,l.currency
  FROM public.return_destination_fragments df
  JOIN public.wms_return_fragments f ON(f.tenant_id,f.id,f.operation_id,f.return_id,f.order_id,f.issue_fragment_id,f.product_id,f.layer_id,f.warehouse_id,f.location,f.quantity)
   =(df.tenant_id,df.fragment_id,df.receipt_id,df.return_id,df.order_id,df.issue_fragment_id,df.product_id,df.layer_id,df.warehouse_id,df.location,df.quantity)
  JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(f.tenant_id,f.layer_id,f.product_id)
  JOIN public.return_destination_arrivals arrival ON(arrival.tenant_id,arrival.id,arrival.receipt_id,arrival.part_id,arrival.return_id,arrival.order_id,arrival.item_id,arrival.product_id,arrival.warehouse_id,arrival.location,arrival.effect)
   =(df.tenant_id,df.arrival_id,df.receipt_id,df.part_id,df.return_id,df.order_id,df.item_id,df.product_id,df.warehouse_id,df.location,df.effect)
  WHERE(df.tenant_id,df.receipt_id)=(t,d.receipt_id))v;
 SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]') INTO wanted FROM jsonb_array_elements(plan->'private_fragment_effects')x;
 IF actual IS DISTINCT FROM wanted
 OR(SELECT count(*) FROM public.return_destination_fragments WHERE(tenant_id,receipt_id)=(t,d.receipt_id))<>jsonb_array_length(wanted)
 OR EXISTS(SELECT FROM public.wms_return_fragments f WHERE(f.tenant_id,f.return_id)=(t,a.return_id)
  AND NOT EXISTS(SELECT FROM public.return_destination_fragments df WHERE(df.tenant_id,df.receipt_id,df.fragment_id)=(t,d.receipt_id,f.id))) THEN
  RAISE EXCEPTION '206 full native WMS fragment bijection differs' USING ERRCODE='23514';END IF;
 -- Sealed152 before/after journals bind every stock/bin/layer id. Compare the
 -- exact born rows, then current immutable journal rows, never current stock.
 FOR key,nm,journal_key IN SELECT * FROM(VALUES('stock_movement_ids','stock_movements','stock_journals'),('location_movement_ids','stock_location_movements','bin_journals'),('layer_movement_ids','wms_layer_movements','layer_journals'))v LOOP
  IF jsonb_typeof(r.proof->key) IS DISTINCT FROM 'array' OR jsonb_array_length(r.proof->key)>10000
  OR jsonb_typeof(d.after_snapshot->nm) IS DISTINCT FROM 'array' OR jsonb_typeof(d.before_snapshot->nm) IS DISTINCT FROM 'array'
  OR jsonb_typeof(e.after_frame->journal_key) IS DISTINCT FROM 'array' OR jsonb_typeof(ea.before_frame->journal_key) IS DISTINCT FROM 'array'
  OR jsonb_array_length(e.after_frame->journal_key)>10000 OR jsonb_array_length(ea.before_frame->journal_key)>10000
  OR r.proof->key IS DISTINCT FROM e.proof->key THEN
   RAISE EXCEPTION '206 incomplete native journal manifest' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'id'),'[]') INTO wanted FROM jsonb_array_elements(d.after_snapshot->nm)x
   WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(d.before_snapshot->nm)b WHERE b->>'id'=x->>'id');
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),''[]'') FROM public.%I x WHERE x.tenant_id=$1 AND x.id IN(SELECT v::uuid FROM jsonb_array_elements_text($2)v)',nm)
   INTO actual USING t,r.proof->key;
  IF actual IS DISTINCT FROM wanted OR jsonb_array_length(actual)<>jsonb_array_length(r.proof->key) THEN
   RAISE EXCEPTION '206 sealed birth/current journal set differs' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'id'),'[]') INTO wanted FROM jsonb_array_elements(e.after_frame->journal_key)x
   WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(ea.before_frame->journal_key)b WHERE b->>'id'=x->>'id');
  IF actual IS DISTINCT FROM wanted OR EXISTS(SELECT FROM jsonb_array_elements(ea.before_frame->journal_key)b
   WHERE NOT(e.after_frame->journal_key @> jsonb_build_array(b))) THEN
   RAISE EXCEPTION '206 sealed152/169 native journal birth differs' USING ERRCODE='23514';END IF;
 END LOOP;
END $history206$;

CREATE FUNCTION public.return_credit206_history(eid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a public.catalog_stock_return_admissions;r public.catalog_stock_return_receipts;rc public.return_cases;op public.wms_operations;
 item jsonb;expected jsonb;return_document_head record;n jsonb;actual jsonb;wanted jsonb;
BEGIN
 PERFORM public.return_credit206_parent(eid);
 SELECT * INTO a FROM public.catalog_stock_return_admissions WHERE id=eid;
 SELECT * INTO r FROM public.catalog_stock_return_receipts WHERE(tenant_id,id)=(a.tenant_id,a.id);
 IF a.id IS NULL OR r.id IS NULL OR NOT a.sealed OR a.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR(a.txid=pg_current_xact_id() AND r.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'Brak pełnej zgody dokumentu zwrotu' USING ERRCODE='23514';END IF;
 SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 IF a.protocol IS DISTINCT FROM 'destinations_v1' OR r.assistant_receipt_id IS NULL OR r.exchange_id IS NOT NULL OR r.dropship_admission_id IS NOT NULL OR r.local_proof_id IS NOT NULL OR r.parcel_receipt_return_id IS NOT NULL
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
    OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL
    OR op.request IS DISTINCT FROM(SELECT x->'request' FROM public.return_destination_admissions da CROSS JOIN LATERAL jsonb_array_elements(da.after_snapshot->'wms_operations')x
       WHERE(da.tenant_id,da.receipt_id)=(a.tenant_id,r.assistant_receipt_id) AND x->>'id'=r.wms_operation_id::text) THEN RAISE EXCEPTION 'Obca operacja WMS zwrotu' USING ERRCODE='23514';END IF;
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

ALTER FUNCTION public.return_credit206_parent(uuid) OWNER TO postgres;
ALTER FUNCTION public.return_credit206_history(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.return_credit206_parent(uuid),public.return_credit206_history(uuid) FROM PUBLIC,dyna_app;
DO $post206$ BEGIN
 IF public.local_consumer_credit_guards() IS DISTINCT FROM true OR public.ordinary188_structure_valid() IS DISTINCT FROM true THEN
  RAISE EXCEPTION '206 must preserve literal188 profile' USING ERRCODE='55000';END IF;
END $post206$;
