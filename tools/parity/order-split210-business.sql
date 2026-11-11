-- SOURCE-AUTHORED CANDIDATE, NOT AN ACTIVE MIGRATION OR NATIVE CERTIFICATE.
-- All entry points remain owner-only. Do not register/grant this core until a
-- source-derived predecessor closure, exact catalogue inverse and real PG proof
-- exist. In particular the literal104 WMS guard refuses split shrink/DELETE.
-- No disabling trigger, session flag, replication-role change or fake MERGE.
SET LOCAL TimeZone='UTC';
CREATE TEMP TABLE order_split210_install_basis ON COMMIT DROP AS
 SELECT pg_current_xact_id() root_xid,transaction_timestamp() started,current_user owner;
REVOKE ALL ON pg_temp.order_split210_install_basis FROM PUBLIC,dyna_app;

DO $split210_preflight$ BEGIN
 IF current_user IS DISTINCT FROM session_user OR current_user<>'postgres'
  OR NOT EXISTS(SELECT FROM pg_temp.order_split210_install_basis WHERE(root_xid,started,owner)=(pg_current_xact_id(),transaction_timestamp(),current_user))
  OR current_setting('session_replication_role')<>'origin'
  OR NOT EXISTS(SELECT FROM public.migrations WHERE name='209_order_merge_delivery_inheritance')
  OR public.order_merge_delivery209_valid() IS DISTINCT FROM true
  OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'order_split210_'))
  OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'order_split210_'))
 THEN RAISE EXCEPTION '210 core requires genuine209 and an empty own namespace' USING ERRCODE='55000';END IF;
END $split210_preflight$;

-- Candidate UI/service ports below accept only request intent + actual current
-- credentials. They never accept a caller snapshot, target ID or physical plan.
-- Parent209 guard is real; own210 source/cold fingerprint binding is deliberately
-- NOT claimed by this unregistered business core. See native-progress.md.


CREATE TABLE public.order_split210_previews(
 tenant_id uuid NOT NULL REFERENCES public.tenants,id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,
 credential_hash text NOT NULL CHECK(credential_hash~'^[a-f0-9]{64}$'),actor_role text NOT NULL CHECK(actor_role IN('admin','operator')),
 identity_snapshot jsonb NOT NULL,client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 source_order_id uuid NOT NULL,source_version bigint NOT NULL CHECK(source_version>0),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=8388608),plan jsonb NOT NULL CHECK(octet_length(plan::text)<=16777216),
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,client_key),
 FOREIGN KEY(tenant_id,source_order_id) REFERENCES public.orders(tenant_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
 CHECK(octet_length(request::text)<=1048576)
);
-- A fully moved source item need not remain a zero-quantity invalid current row.
-- Its original UUID and complete row survive here, independently of current rows.
CREATE TABLE public.order_split210_source_rows(
 tenant_id uuid NOT NULL,preview_id uuid NOT NULL,source_item_id uuid NOT NULL,source_order_id uuid NOT NULL,row_data jsonb NOT NULL,
 PRIMARY KEY(tenant_id,preview_id,source_item_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.order_split210_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,source_order_id) REFERENCES public.orders(tenant_id,id),
 CHECK(row_data->>'id'=source_item_id::text AND row_data->>'order_id'=source_order_id::text),CHECK(octet_length(row_data::text)<=8388608)
);
CREATE TABLE public.order_split210_executions(
 tenant_id uuid NOT NULL,id uuid NOT NULL,preview_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,
 credential_hash text NOT NULL CHECK(credential_hash~'^[a-f0-9]{64}$'),actor_role text NOT NULL CHECK(actor_role IN('admin','operator')),identity_snapshot jsonb NOT NULL,
 client_key uuid NOT NULL,request jsonb NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),
 source_order_id uuid NOT NULL,source_version bigint NOT NULL,result_source_version bigint NOT NULL,
 before_frame jsonb NOT NULL CHECK(octet_length(before_frame::text)<=8388608),after_frame jsonb NOT NULL CHECK(octet_length(after_frame::text)<=16777216),
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,client_key),UNIQUE(tenant_id,preview_id),UNIQUE(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES public.order_split210_previews(tenant_id,id),
 FOREIGN KEY(tenant_id,source_order_id) REFERENCES public.orders(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id),
 CHECK(result_source_version=source_version+1),CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),CHECK(octet_length(request::text)<=1048576)
);
CREATE TABLE public.order_split210_targets(
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,result_index integer NOT NULL CHECK(result_index BETWEEN 0 AND 99),
 slot_id uuid,order_id uuid NOT NULL,source_order_id uuid NOT NULL,name text,
 delivery_minor integer NOT NULL CHECK(delivery_minor BETWEEN 0 AND 1000000),total_minor integer NOT NULL CHECK(total_minor>=0),
 PRIMARY KEY(tenant_id,execution_id,result_index),UNIQUE(tenant_id,execution_id,slot_id),UNIQUE(tenant_id,execution_id,order_id),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES public.order_split210_executions(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES public.orders(tenant_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,source_order_id) REFERENCES public.orders(tenant_id,id),
 CHECK((slot_id IS NULL AND order_id=source_order_id AND name IS NULL) OR(slot_id IS NOT NULL AND order_id<>source_order_id AND name IS NOT NULL))
);
CREATE UNIQUE INDEX order_split210_single_remainder ON public.order_split210_targets(tenant_id,execution_id) WHERE slot_id IS NULL;
CREATE TABLE public.order_split210_allocations(
 tenant_id uuid NOT NULL,execution_id uuid NOT NULL,preview_id uuid NOT NULL,result_index integer NOT NULL,source_item_id uuid NOT NULL,
 target_item_id uuid NOT NULL,product_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
 from_quantity integer NOT NULL CHECK(from_quantity>=0),to_quantity integer NOT NULL CHECK(to_quantity>from_quantity),
 gross_minor integer NOT NULL CHECK(gross_minor>=0),net_minor integer NOT NULL CHECK(net_minor>=0),vat_minor integer NOT NULL CHECK(vat_minor>=0),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=8388608),
 PRIMARY KEY(tenant_id,execution_id,result_index,source_item_id),UNIQUE(tenant_id,execution_id,target_item_id),
 FOREIGN KEY(tenant_id,execution_id,result_index) REFERENCES public.order_split210_targets(tenant_id,execution_id,result_index),
 FOREIGN KEY(tenant_id,execution_id,preview_id) REFERENCES public.order_split210_executions(tenant_id,id,preview_id),
 FOREIGN KEY(tenant_id,preview_id,source_item_id) REFERENCES public.order_split210_source_rows(tenant_id,preview_id,source_item_id),
 CHECK(to_quantity-from_quantity=quantity),CHECK(gross_minor=net_minor+vat_minor)
);
-- Replays get a NEW current-request duty. An old command's stored credential is
-- never substituted for today's session/key after an ACK-loss lookup.
CREATE TABLE public.order_split210_replay_duties(
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN('preview','execute')),command_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.users,api_key_id uuid,credential_hash text NOT NULL CHECK(credential_hash~'^[a-f0-9]{64}$'),
 actor_role text NOT NULL CHECK(actor_role IN('admin','operator')),identity_snapshot jsonb NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,api_key_id) REFERENCES public.api_keys(tenant_id,id)
);

CREATE FUNCTION public.order_split210_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Immutable split source, command and lineage' USING ERRCODE='23514';END$$;
DO $split210_acl$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['previews','source_rows','executions','targets','allocations','replay_duties'] LOOP
  EXECUTE format('ALTER TABLE public.order_split210_%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE public.order_split210_%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY owner_scope ON public.order_split210_%I TO CURRENT_USER USING(true) WITH CHECK(true)',tab);
  EXECUTE format('REVOKE ALL ON public.order_split210_%I FROM PUBLIC,dyna_app',tab);
  EXECUTE format('CREATE TRIGGER order_split210_immutable BEFORE UPDATE OR DELETE ON public.order_split210_%I FOR EACH ROW EXECUTE FUNCTION public.order_split210_immutable()',tab);
  EXECUTE format('CREATE TRIGGER order_split210_no_truncate BEFORE TRUNCATE ON public.order_split210_%I FOR EACH STATEMENT EXECUTE FUNCTION public.order_split210_immutable()',tab);
 END LOOP;
END $split210_acl$;

-- Repartition ALREADY RESERVED cells. WMS ON keeps the actual global FIFO
-- ordering (fifo_sequence, layer UUID, location UTF8/C); OFF uses location C.
-- Neither this plan nor its writer touches stock, bins, positions or movements.
CREATE FUNCTION public.order_split210_physical(f jsonb,plan jsonb,pid uuid) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$DECLARE custody_data jsonb:=f->'custody';answer jsonb;on_wms boolean:=(f->>'wms_enabled')::boolean;BEGIN
 IF on_wms THEN
  IF EXISTS(SELECT FROM jsonb_array_elements(custody_data->'locations') l WHERE(l->>'quantity')::bigint IS DISTINCT FROM
   (SELECT sum((w->>'quantity')::bigint) FROM jsonb_array_elements(custody_data->'layers') w WHERE(w->>'product_id',w->>'location')=(l->>'product_id',l->>'location')))
   OR EXISTS(SELECT FROM jsonb_array_elements(custody_data->'layers') w WHERE 1<>(SELECT count(*) FROM jsonb_array_elements(f->'layer_metadata') m
    WHERE(m->>'layer_id',m->>'product_id')=(w->>'layer_id',w->>'product_id') AND m->>'fifo_sequence'~'^[1-9][0-9]*$'))
  THEN RAISE EXCEPTION 'Split FIFO layer provenance is incomplete' USING ERRCODE='23514';END IF;
 ELSIF jsonb_array_length(custody_data->'layers')<>0 OR jsonb_array_length(f->'layer_metadata')<>0 THEN RAISE EXCEPTION 'Split WMS OFF contains layer custody' USING ERRCODE='23514';END IF;
 WITH demand AS(
  SELECT (r->>'result_index')::int idx,(r->>'order_id')::uuid oid,(i->>'product_id')::uuid product,sum((i->>'quantity')::bigint) q
  FROM jsonb_array_elements(plan->'results') r CROSS JOIN LATERAL jsonb_array_elements(r->'items') i GROUP BY 1,2,3
 ),ranges AS(
  SELECT *,sum(q) OVER(PARTITION BY product ORDER BY idx ROWS UNBOUNDED PRECEDING)-q lo,
   sum(q) OVER(PARTITION BY product ORDER BY idx ROWS UNBOUNDED PRECEDING) hi FROM demand
 ),cells AS(
  SELECT (w->>'product_id')::uuid product,w->>'location' location,(w->>'layer_id')::uuid layer,(m->>'fifo_sequence')::bigint fifo,(w->>'quantity')::bigint q,w row_data
  FROM jsonb_array_elements(custody_data->'layers') w JOIN LATERAL(SELECT value m FROM jsonb_array_elements(f->'layer_metadata') WHERE value->>'layer_id'=w->>'layer_id') x ON true WHERE on_wms
  UNION ALL SELECT (l->>'product_id')::uuid,l->>'location',NULL::uuid,0::bigint,(l->>'quantity')::bigint,l FROM jsonb_array_elements(custody_data->'locations') l WHERE NOT on_wms
 ),ordered AS(
  SELECT *,sum(q) OVER(PARTITION BY product ORDER BY fifo,layer,location COLLATE "C" ROWS UNBOUNDED PRECEDING)-q lo,
   sum(q) OVER(PARTITION BY product ORDER BY fifo,layer,location COLLATE "C" ROWS UNBOUNDED PRECEDING) hi FROM cells
 ),pieces AS(
  SELECT d.idx,d.oid,d.product,c.location,c.layer,c.row_data,greatest(0::bigint,least(d.hi,c.hi)-greatest(d.lo,c.lo)) q
  FROM ranges d JOIN ordered c USING(product) WHERE least(d.hi,c.hi)>greatest(d.lo,c.lo)
 ),reserved AS(
  SELECT r.idx,r.oid,r.product,b.value||jsonb_build_object('order_id',r.oid,'quantity',r.q) row_data
  FROM demand r JOIN LATERAL(SELECT value FROM jsonb_array_elements(custody_data->'reservations') WHERE value->>'product_id'=r.product::text) b ON true
 ),located AS(
  SELECT p.idx,p.oid,p.product,p.location,sum(p.q)::bigint q FROM pieces p GROUP BY 1,2,3,4
 ),location_rows AS(
  SELECT l.idx,l.oid,l.product,l.location,b.value||jsonb_build_object('order_id',l.oid,'quantity',l.q) row_data
  FROM located l JOIN LATERAL(SELECT value FROM jsonb_array_elements(custody_data->'locations') WHERE(value->>'product_id',value->>'location')=(l.product::text,l.location)) b ON true
 ),picked AS(
  SELECT r.idx,r.oid,r.product,b.value||jsonb_build_object('id',CASE WHEN r.oid=(f->'order'->>'id')::uuid THEN(b.value->>'id')::uuid ELSE public.order_split210_id(pid,'pick:'||r.oid||':'||r.product) END,'order_id',r.oid,'quantity',r.q) row_data
  FROM demand r JOIN LATERAL(SELECT value FROM jsonb_array_elements(custody_data->'picks') WHERE value->>'product_id'=r.product::text) b ON true
 ) SELECT jsonb_build_object(
  'reservations',coalesce((SELECT jsonb_agg(row_data ORDER BY oid,product) FROM reserved),'[]'),
  'locations',coalesce((SELECT jsonb_agg(row_data ORDER BY oid,product,location COLLATE "C") FROM location_rows),'[]'),
  'layers',coalesce((SELECT jsonb_agg(row_data||jsonb_build_object('order_id',oid,'quantity',q) ORDER BY oid,product,location COLLATE "C",layer) FROM pieces WHERE on_wms),'[]'),
  'picks',coalesce((SELECT jsonb_agg(row_data ORDER BY oid,product) FROM picked),'[]'),
  'stock',custody_data->'stock','bins',custody_data->'bins','positions',custody_data->'positions') INTO answer;
 IF EXISTS(WITH a AS(SELECT value->>'product_id' product,sum((value->>'quantity')::bigint) q FROM jsonb_array_elements(custody_data->'reservations') GROUP BY 1),
  b AS(SELECT value->>'product_id' product,sum((value->>'quantity')::bigint) q FROM jsonb_array_elements(answer->'reservations') GROUP BY 1)
  SELECT FROM a FULL JOIN b USING(product) WHERE a.q IS DISTINCT FROM b.q)
 THEN RAISE EXCEPTION 'Split physical quantity conservation failed' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(answer->'reservations')+jsonb_array_length(answer->'locations')+jsonb_array_length(answer->'layers')+jsonb_array_length(answer->'picks')>100000
 THEN RAISE EXCEPTION 'Split planned physical row budget' USING ERRCODE='54000';END IF;
 RETURN answer;
END$$;

-- Supported entry points MUST use the genuine managed tenantTx terminal tail.
-- After every sibling finalizer AND constraint drain, terminal() runs again
-- immediately before COMMIT; no business DML/provider wait may follow it.
-- Own deferred completion covers ordinary COMMIT, but financial-table triggers
-- do not requeue an earlier SET CONSTRAINTS IMMEDIATE. Standalone owner SQL
-- that omits this managed tail is NOT a supported split writer.
CREATE FUNCTION public.order_split210_no_effects(t uuid,ids uuid[]) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE tab text;present boolean;BEGIN
 FOREACH tab IN ARRAY ARRAY['payment_entries','source_payment_checks','payment_import_receipts','payment_import_allocation_rows',
  'documents','invoice_plans','local_invoice_previews','fa3_draft_projects','b2b_invoice_previews','local_consumer_credit_previews','return_credit206_previews','b2b_credit_previews',
  'return_cases','shipments','shipping_plans','order_status_plans','odoo_invoice_exports','ebay_fulfillment_plans','amazon_fulfillment_plans','shopify_fulfillment_plans',
  'order_parcel_previews','order_parcel_plans','picking_wave_scans','packing_receipts','order_packing_profiles','order_field_values','order_field_value_events','order_field_requests',
  'b2b_external_order_intents','b2b_external_import_executions','b2b_dropship_supplier_orders'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT FROM public.%I WHERE tenant_id=$1 AND order_id=ANY($2))',tab) INTO present USING t,ids;
  IF present THEN RAISE EXCEPTION 'Split acquired an unsupported financial/fulfillment history' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT FROM public.jobs WHERE tenant_id=t AND kind='payment.source.read' AND payload->>'order_id'=ANY(ARRAY(SELECT x::text FROM unnest(ids)x)))
  OR EXISTS(SELECT FROM public.payment_import_execution_rows x JOIN public.payment_import_rows p ON(p.tenant_id,p.preview_id,p.row_id)=(x.tenant_id,x.preview_id,x.row_id)
   WHERE x.tenant_id=t AND p.allocation->>'order_id'=ANY(ARRAY(SELECT x::text FROM unnest(ids)x)))
  OR EXISTS(SELECT FROM public.return_exchanges WHERE tenant_id=t AND(original_order_id=ANY(ids) OR replacement_order_id=ANY(ids)))
  OR EXISTS(SELECT FROM public.b2b_dropship_orders WHERE tenant_id=t AND customer_order_id=ANY(ids))
  OR EXISTS(SELECT FROM public.order_merge_claims WHERE tenant_id=t AND(source_order_id=ANY(ids) OR target_order_id=ANY(ids)))
  OR EXISTS(SELECT FROM public.order_merge_origins WHERE tenant_id=t AND order_id=ANY(ids))
  OR EXISTS(SELECT FROM public.packing_sessions WHERE tenant_id=t AND order_id=ANY(ids) AND state='active')
  OR EXISTS(SELECT FROM public.picking_wave_orders p JOIN public.picking_waves w ON(w.tenant_id,w.id)=(p.tenant_id,p.wave_id) WHERE p.tenant_id=t AND p.order_id=ANY(ids) AND p.active AND w.state='picking')
  OR EXISTS(SELECT FROM unnest(ids) oid WHERE public.buyer_address_current_state(t,oid)->>'version' IS DISTINCT FROM '0')
 THEN RAISE EXCEPTION 'Split acquired an unsupported source intent or sidecar' USING ERRCODE='23514';END IF;
END$$;

CREATE FUNCTION public.order_split210_terminal(eid uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;e public.order_split210_executions;p public.order_split210_previews;ids uuid[];actual jsonb;wanted jsonb;key text;
BEGIN
 SELECT * INTO e FROM public.order_split210_executions WHERE(tenant_id,id)=(t,eid);
 IF e.id IS NULL OR e.root_xid<>pg_current_xact_id() OR e.transaction_started_at<>transaction_timestamp()
 THEN RAISE EXCEPTION 'Split terminal needs its actual current transaction' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT p FROM public.order_split210_previews WHERE(tenant_id,id)=(t,e.preview_id);
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true
  OR e.identity_snapshot IS DISTINCT FROM public.order_split210_identity(t,e.actor_id,e.api_key_id,e.credential_hash,e.actor_role,false)
  OR (e.expires_at IS NULL OR e.expires_at<=clock_timestamp()) OR(e.before_frame,e.scope_hash,e.source_order_id,e.source_version) IS DISTINCT FROM(p.snapshot,p.scope_hash,p.source_order_id,p.source_version)
 THEN RAISE EXCEPTION 'Split predecessor, authority, time or original scope changed' USING ERRCODE='40001';END IF;
 SELECT array_agg(order_id ORDER BY order_id) INTO ids FROM public.order_split210_targets WHERE(tenant_id,execution_id)=(t,e.id);
 IF cardinality(ids) IS DISTINCT FROM jsonb_array_length(p.plan->'results') OR cardinality(ids) NOT BETWEEN 2 AND 100 OR
  (SELECT count(*) FROM public.order_split210_source_rows WHERE(tenant_id,preview_id)=(t,p.id))<>jsonb_array_length(p.snapshot->'items')
 THEN RAISE EXCEPTION 'Split source/target roster incomplete' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p.plan->'results') r LEFT JOIN public.order_split210_targets d
  ON(d.tenant_id,d.execution_id,d.result_index)=(t,e.id,(r->>'result_index')::int)
  WHERE(d.slot_id,d.order_id,d.source_order_id,d.name,d.delivery_minor,d.total_minor) IS DISTINCT FROM((r->>'slot_id')::uuid,(r->>'order_id')::uuid,e.source_order_id,r->>'name',(r->>'delivery_minor')::int,(r->>'total_minor')::int))
  OR(SELECT count(*) FROM public.order_split210_allocations WHERE(tenant_id,execution_id)=(t,e.id))<>(SELECT sum(jsonb_array_length(r->'items')) FROM jsonb_array_elements(p.plan->'results') r)
  OR EXISTS(SELECT FROM jsonb_array_elements(p.plan->'results') r CROSS JOIN LATERAL jsonb_array_elements(r->'items') a
   LEFT JOIN public.order_split210_allocations d ON(d.tenant_id,d.execution_id,d.result_index,d.source_item_id)=(t,e.id,(r->>'result_index')::int,(a->>'source_item_id')::uuid)
   WHERE d.payload IS DISTINCT FROM a OR(d.target_item_id,d.product_id,d.quantity,d.from_quantity,d.to_quantity,d.gross_minor,d.net_minor,d.vat_minor)
    IS DISTINCT FROM((a->>'target_item_id')::uuid,(a->>'product_id')::uuid,(a->>'quantity')::int,(a->>'from_quantity')::int,(a->>'to_quantity')::int,(a->>'gross_minor')::int,(a->>'net_minor')::int,(a->>'vat_minor')::int))
 THEN RAISE EXCEPTION 'Split allocation or slot lineage differs from its exact native plan' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]') INTO actual FROM public.orders o WHERE o.tenant_id=t AND o.id=ANY(ids);
 SELECT jsonb_agg(value ORDER BY(value->>'id')::uuid) INTO wanted FROM jsonb_array_elements(e.after_frame->'orders');
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'Split current headers/portal/pricing/source version differ from proof' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.order_id,i.id),'[]') INTO actual FROM public.order_items i WHERE i.tenant_id=t AND i.order_id=ANY(ids);
 SELECT jsonb_agg(value ORDER BY(value->>'order_id')::uuid,(value->>'id')::uuid) INTO wanted FROM jsonb_array_elements(e.after_frame->'items');
 IF actual IS DISTINCT FROM wanted THEN RAISE EXCEPTION 'Split source/child items or money differ from proof' USING ERRCODE='23514';END IF;
 actual:=public.order_merge_custody_snapshot(ids);
 FOREACH key IN ARRAY ARRAY['reservations','locations','layers','picks','stock','bins','positions'] LOOP
  IF actual->key IS DISTINCT FROM e.after_frame->'custody'->key THEN RAISE EXCEPTION 'Split custody or unchanged physical stock differs from proof' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM public.order_split210_no_effects(t,ids);
 -- DB clock and credential are read again after all data/guard reads and waits.
 IF (e.expires_at IS NULL OR e.expires_at<=clock_timestamp()) OR e.identity_snapshot IS DISTINCT FROM public.order_split210_identity(t,e.actor_id,e.api_key_id,e.credential_hash,e.actor_role,false)
 THEN RAISE EXCEPTION 'Split authority expired at terminal boundary' USING ERRCODE='28000';END IF;
END$$;

CREATE FUNCTION public.order_split210_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$DECLARE x public.order_split210_previews;BEGIN
 IF TG_TABLE_NAME='order_split210_executions' THEN PERFORM public.order_split210_terminal(NEW.id);RETURN NULL;END IF;
 x:=NEW;
 IF(x.root_xid,x.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp())
  OR x.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR (x.expires_at IS NULL OR x.expires_at<=clock_timestamp()) OR public.order_merge_delivery209_valid() IS DISTINCT FROM true
  OR x.identity_snapshot IS DISTINCT FROM public.order_split210_identity(x.tenant_id,x.actor_id,x.api_key_id,x.credential_hash,x.actor_role,false)
  OR x.snapshot IS DISTINCT FROM public.order_split210_capture(x.source_order_id,x.source_version)
  OR(SELECT count(*) FROM public.order_split210_source_rows WHERE(tenant_id,preview_id)=(x.tenant_id,x.id))<>jsonb_array_length(x.snapshot->'items')
 THEN RAISE EXCEPTION 'Split preview incomplete or authority/source changed before COMMIT' USING ERRCODE='40001';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(x.snapshot->'items') i LEFT JOIN public.order_split210_source_rows s
  ON(s.tenant_id,s.preview_id,s.source_item_id)=(x.tenant_id,x.id,(i->>'id')::uuid) WHERE s.row_data IS DISTINCT FROM i)
 THEN RAISE EXCEPTION 'Split original source row roster incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER order_split210_preview_complete AFTER INSERT ON public.order_split210_previews
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.order_split210_complete();
CREATE CONSTRAINT TRIGGER order_split210_execution_complete AFTER INSERT ON public.order_split210_executions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.order_split210_complete();

-- New own guard does not replace old104/134/137 guards: every matching current
-- transition must be exact, and current-TX late drift after an early constraint
-- flush is refused. Stock/movement writes are never an allowed split operation.
CREATE FUNCTION public.order_split210_bound_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb:=to_jsonb(OLD);a jsonb:=to_jsonb(NEW);t uuid;oid uuid;old_oid uuid;matched boolean;BEGIN
 t:=coalesce(a->>'tenant_id',b->>'tenant_id')::uuid;
 IF TG_TABLE_NAME IN('orders','order_items','order_pick_items','reservations','reservation_locations','wms_reservation_layers') THEN
  oid:=CASE WHEN TG_TABLE_NAME='orders' THEN coalesce(a->>'id',b->>'id')::uuid ELSE coalesce(a->>'order_id',b->>'order_id')::uuid END;
  old_oid:=CASE WHEN TG_TABLE_NAME='orders' THEN(b->>'id')::uuid ELSE(b->>'order_id')::uuid END;
  SELECT EXISTS(SELECT FROM public.order_split210_executions e JOIN public.order_split210_targets d ON(d.tenant_id,d.execution_id)=(e.tenant_id,e.id)
   WHERE e.tenant_id=t AND e.root_xid=pg_current_xact_id() AND e.transaction_started_at=transaction_timestamp() AND d.order_id=ANY(ARRAY[oid,old_oid])) INTO matched;
  IF matched AND public.order_split210_row_admission(TG_TABLE_NAME,TG_OP,b,a) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current split tuple is outside its exact proof' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT FROM public.order_split210_executions e CROSS JOIN LATERAL jsonb_array_elements(e.before_frame->'custody'->'stock') s
   WHERE e.tenant_id=t AND e.root_xid=pg_current_xact_id() AND e.transaction_started_at=transaction_timestamp()
    AND((s->>'warehouse_id',s->>'product_id')=(a->>'warehouse_id',a->>'product_id') OR(s->>'warehouse_id',s->>'product_id')=(b->>'warehouse_id',b->>'product_id')))
  THEN RAISE EXCEPTION 'Split cannot change stock/bin/layer position or emit stock movements' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
DO $split210_bounds$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['orders','order_items','order_pick_items','reservations','reservation_locations','wms_reservation_layers',
  'stock','stock_locations','wms_layer_positions','stock_movements','stock_location_movements','wms_layer_movements'] LOOP
  EXECUTE format('CREATE TRIGGER order_split210_bound BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.order_split210_bound_guard()',tab);
 END LOOP;
END $split210_bounds$;

CREATE FUNCTION public.order_split210_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex')$$;
CREATE FUNCTION public.order_split210_id(seed uuid,label text) RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT(substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
 FROM(SELECT encode(sha256(convert_to('order.split210:'||seed::text||':'||label,'UTF8')),'hex') h)x$$;
CREATE FUNCTION public.order_split210_identity(t uuid,u uuid,k uuid,h text,r text,pin boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE a jsonb;BEGIN
 IF t IS NULL OR u IS NULL OR r IS NULL OR pin IS NULL OR h IS NULL OR h!~'^[a-f0-9]{64}$' OR r NOT IN('admin','operator') THEN RAISE EXCEPTION 'Split writer credential required' USING ERRCODE='42501';END IF;
 --166 w=true would impose admin. Its genuine READ credential validation still
 -- checks current session/key hash, account version, MFA, policy and role; the
 --210 write-role and four scopes below are independently mandatory.
 a:=public.buyer_address_identity(t,u,k,h,r,false,pin);
 IF k IS NOT NULL AND NOT EXISTS(SELECT FROM public.api_keys q WHERE(q.tenant_id,q.user_id,q.id,q.token_hash)=(t,u,k,h)
  AND q.revoked_at IS NULL AND q.expires_at>clock_timestamp()
  AND q.scopes @> ARRAY['orders:read','orders:write','inventory:read','inventory:write']::text[])
 THEN RAISE EXCEPTION 'Split key write scopes changed' USING ERRCODE='42501';END IF;
 RETURN a;
END$$;

CREATE FUNCTION public.order_split210_replay_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE same_command boolean;BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR(NEW.root_xid,NEW.transaction_started_at) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp())
  OR NEW.created_at>clock_timestamp() OR NEW.created_at+interval '15 minutes'<=clock_timestamp()
  OR NEW.identity_snapshot IS DISTINCT FROM public.order_split210_identity(NEW.tenant_id,NEW.actor_id,NEW.api_key_id,NEW.credential_hash,NEW.actor_role,false)
 THEN RAISE EXCEPTION 'Current replay credential changed before COMMIT' USING ERRCODE='28000';END IF;
 IF NEW.kind='preview' THEN SELECT EXISTS(SELECT FROM public.order_split210_previews p WHERE(p.tenant_id,p.id,p.actor_id,p.request_hash)=(NEW.tenant_id,NEW.command_id,NEW.actor_id,NEW.request_hash) AND p.api_key_id IS NOT DISTINCT FROM NEW.api_key_id) INTO same_command;
 ELSE SELECT EXISTS(SELECT FROM public.order_split210_executions e WHERE(e.tenant_id,e.id,e.actor_id,e.request_hash)=(NEW.tenant_id,NEW.command_id,NEW.actor_id,NEW.request_hash) AND e.api_key_id IS NOT DISTINCT FROM NEW.api_key_id) INTO same_command;END IF;
 IF same_command IS DISTINCT FROM true THEN RAISE EXCEPTION 'Replay duty is not bound to the original actor/body command' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER order_split210_replay_complete AFTER INSERT ON public.order_split210_replay_duties DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.order_split210_replay_complete();

CREATE FUNCTION public.order_split210_preview(b jsonb,u uuid,k uuid,h text,r text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;auth jsonb;req text;p public.order_split210_previews;f jsonb;v jsonb;pid uuid:=gen_random_uuid();stamp timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(982376);
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Split predecessor metadata changed' USING ERRCODE='55000';END IF;
 auth:=public.order_split210_identity(t,u,k,h,r,true);
 IF b IS NULL OR octet_length(b::text)>1048576 THEN RAISE EXCEPTION 'Split request byte budget' USING ERRCODE='54000';END IF;
 req:=public.order_split210_hash(jsonb_build_object('kind','preview','tenant_id',t,'actor_id',u,'api_key_id',k,'request',b));
 PERFORM pg_advisory_xact_lock(hashtextextended('order.split210.preview:'||t||':'||(b->>'client_key'),0));
 SELECT * INTO p FROM public.order_split210_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN
  IF(p.actor_id,p.api_key_id,p.request_hash,p.request) IS DISTINCT FROM(u,k,req,b) THEN RAISE EXCEPTION 'Split preview key has another original body/actor' USING ERRCODE='23514';END IF;
  INSERT INTO public.order_split210_replay_duties(tenant_id,kind,command_id,actor_id,api_key_id,credential_hash,actor_role,identity_snapshot,request_hash) VALUES(t,'preview',p.id,u,k,h,r,auth,req);
  PERFORM public.order_split210_budget(t);PERFORM public.order_split210_identity(t,u,k,h,r,false);
  RETURN jsonb_build_object('id',p.id,'source_order_id',p.source_order_id,'source_version',p.source_version::text,'scope_hash',p.scope_hash,'plan',p.plan,'expires_at',p.expires_at,'replayed',true);
 END IF;
 PERFORM public.order_split210_budget(t);
 f:=public.order_split210_capture((b->>'source_order_id')::uuid,(b->>'expected_source_version')::bigint);
 v:=public.order_split210_plan(f,b,pid);v:=v||jsonb_build_object('custody',public.order_split210_physical(f,v,pid));
 stamp:=clock_timestamp();
 INSERT INTO public.order_split210_previews(tenant_id,id,actor_id,api_key_id,credential_hash,actor_role,identity_snapshot,client_key,request,request_hash,source_order_id,source_version,scope_hash,snapshot,plan,created_at,expires_at)
 VALUES(t,pid,u,k,h,r,auth,(b->>'client_key')::uuid,b,req,(b->>'source_order_id')::uuid,(b->>'expected_source_version')::bigint,
  public.order_split210_hash(jsonb_build_object('source',f,'request',b,'plan',v)),f,v,stamp,stamp+interval '15 minutes') RETURNING * INTO p;
 INSERT INTO public.order_split210_source_rows(tenant_id,preview_id,source_item_id,source_order_id,row_data)
  SELECT t,pid,(value->>'id')::uuid,p.source_order_id,value FROM jsonb_array_elements(f->'items');
 PERFORM public.order_split210_budget(t);
 IF auth IS DISTINCT FROM public.order_split210_identity(t,u,k,h,r,false) THEN RAISE EXCEPTION 'Split preview identity changed after wait' USING ERRCODE='40001';END IF;
 RETURN jsonb_build_object('id',p.id,'source_order_id',p.source_order_id,'source_version',p.source_version::text,'scope_hash',p.scope_hash,'plan',p.plan,'expires_at',p.expires_at,'replayed',false);
END$$;

-- Produce exact full current-table tuples from the original DB header/rows.
-- Price-list/pricing snapshot, note, tags, workflow and operational portal policy
-- are inherited. Every child gets its own new portal token; no buyer opt-in row
-- is copied. Classified/overridden166 sources are explicitly ineligible in v1.
CREATE FUNCTION public.order_split210_materialize(p public.order_split210_previews,stamp timestamptz) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE headers jsonb:='[]';rows jsonb:='[]';r jsonb;a jsonb;head jsonb;old_item jsonb;token text;begin_header jsonb:=p.snapshot->'order';BEGIN
 FOR r IN SELECT value FROM jsonb_array_elements(p.plan->'results') ORDER BY(value->>'result_index')::int LOOP
  IF r->>'kind'='retained_source' THEN
   head:=begin_header||jsonb_build_object('total',(r->>'total_minor')::int,'shipping_cost',(r->>'delivery_minor')::int,'version',p.source_version+1,'updated_at',stamp);
  ELSE
   LOOP token:=substr(encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),1,48);
    EXIT WHEN token IS DISTINCT FROM begin_header->>'portal_token' AND NOT EXISTS(SELECT FROM public.orders WHERE portal_token=token)
     AND NOT EXISTS(SELECT FROM jsonb_array_elements(headers) v WHERE v->>'portal_token'=token);END LOOP;
   head:=begin_header||jsonb_build_object('id',(r->>'order_id')::uuid,'number','OS210-'||p.id::text||'-'||(r->>'result_index'),
    'total',(r->>'total_minor')::int,'shipping_cost',(r->>'delivery_minor')::int,'version',1,'created_at',stamp,'updated_at',stamp,'portal_token',token);
   IF EXISTS(SELECT FROM public.orders WHERE id=(r->>'order_id')::uuid) THEN RAISE EXCEPTION 'Split target identity collision' USING ERRCODE='23505';END IF;
  END IF;
  headers:=headers||jsonb_build_array(head);
  FOR a IN SELECT value FROM jsonb_array_elements(r->'items') LOOP
   SELECT value-'product_kind' INTO STRICT old_item FROM jsonb_array_elements(p.snapshot->'items') WHERE value->>'id'=a->>'source_item_id';
   rows:=rows||jsonb_build_array(old_item||jsonb_build_object('id',(a->>'target_item_id')::uuid,'order_id',(r->>'order_id')::uuid,'quantity',(a->>'quantity')::int,'line_total',(a->>'gross_minor')::int));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('orders',headers,'items',rows,'custody',p.plan->'custody');
END$$;

-- Only a source-derived successor of a known physical trigger may consume this
-- owner-only predicate. It proves exact old/new tuples under an actual current
-- execution and fresh request identity. It is not a caller-controlled bypass.
CREATE FUNCTION public.order_split210_row_admission(tab text,op text,old_row jsonb,new_row jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;e public.order_split210_executions;oid uuid;key text;b jsonb;a jsonb;matches integer;
BEGIN
 IF tab NOT IN('orders','order_items','order_pick_items','reservations','reservation_locations','wms_reservation_layers') OR op NOT IN('INSERT','UPDATE','DELETE')
 THEN RETURN false;END IF;
 oid:=CASE WHEN tab='orders' THEN coalesce(new_row->>'id',old_row->>'id')::uuid ELSE coalesce(new_row->>'order_id',old_row->>'order_id')::uuid END;
 SELECT count(*) INTO matches FROM public.order_split210_executions x WHERE x.tenant_id=t AND x.root_xid=pg_current_xact_id()
  AND x.transaction_started_at=transaction_timestamp() AND EXISTS(SELECT FROM public.order_split210_targets d WHERE(d.tenant_id,d.execution_id,d.order_id)=(t,x.id,oid));
 IF matches<>1 THEN RETURN false;END IF;
 SELECT x.* INTO STRICT e FROM public.order_split210_executions x WHERE x.tenant_id=t AND x.root_xid=pg_current_xact_id()
  AND x.transaction_started_at=transaction_timestamp() AND EXISTS(SELECT FROM public.order_split210_targets d WHERE(d.tenant_id,d.execution_id,d.order_id)=(t,x.id,oid));
 PERFORM public.order_split210_identity(t,e.actor_id,e.api_key_id,e.credential_hash,e.actor_role,false);
 IF (e.expires_at IS NULL OR e.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Split current write admission expired' USING ERRCODE='28000';END IF;
 key:=CASE tab WHEN 'orders' THEN 'orders' WHEN 'order_items' THEN 'items' WHEN 'order_pick_items' THEN 'picks'
  WHEN 'reservation_locations' THEN 'locations' WHEN 'wms_reservation_layers' THEN 'layers' ELSE 'reservations' END;
 IF tab='orders' THEN b:=jsonb_build_array(e.before_frame->'order');a:=e.after_frame->'orders';
 ELSIF tab='order_items' THEN SELECT jsonb_agg(value-'product_kind') INTO b FROM jsonb_array_elements(e.before_frame->'items');a:=e.after_frame->'items';
 ELSE b:=e.before_frame->'custody'->key;a:=e.after_frame->'custody'->key;END IF;
 -- Membership is exact full-row equality, not an economic-key subset. For
 -- INSERT, no before row with the same real current-table PK may exist.
 IF op='INSERT' THEN RETURN new_row->>'tenant_id'=t::text AND EXISTS(SELECT FROM jsonb_array_elements(a) v WHERE v=new_row) AND NOT EXISTS(SELECT FROM jsonb_array_elements(b) v
  WHERE CASE WHEN tab IN('orders','order_items','order_pick_items') THEN v->>'id'=new_row->>'id' ELSE
   (v->>'order_id',v->>'product_id')=(new_row->>'order_id',new_row->>'product_id') AND
   (tab='reservations' OR v->>'location'=new_row->>'location') AND(tab<>'wms_reservation_layers' OR v->>'layer_id'=new_row->>'layer_id') END);
 ELSIF op='DELETE' THEN RETURN old_row->>'tenant_id'=t::text AND EXISTS(SELECT FROM jsonb_array_elements(b) v WHERE v=old_row) AND NOT EXISTS(SELECT FROM jsonb_array_elements(a) v
  WHERE CASE WHEN tab IN('orders','order_items','order_pick_items') THEN v->>'id'=old_row->>'id' ELSE
   (v->>'order_id',v->>'product_id')=(old_row->>'order_id',old_row->>'product_id') AND
   (tab='reservations' OR v->>'location'=old_row->>'location') AND(tab<>'wms_reservation_layers' OR v->>'layer_id'=old_row->>'layer_id') END);
 END IF;
 RETURN old_row->>'tenant_id'=t::text AND new_row->>'tenant_id'=t::text AND EXISTS(SELECT FROM jsonb_array_elements(b) v WHERE v=old_row) AND EXISTS(SELECT FROM jsonb_array_elements(a) v WHERE v=new_row)
  AND CASE WHEN tab IN('orders','order_items','order_pick_items') THEN old_row->>'id'=new_row->>'id' ELSE
   (old_row->>'order_id',old_row->>'product_id',old_row->>'warehouse_id')=(new_row->>'order_id',new_row->>'product_id',new_row->>'warehouse_id') AND
   (tab='reservations' OR old_row->>'location'=new_row->>'location') AND(tab<>'wms_reservation_layers' OR old_row->>'layer_id'=new_row->>'layer_id') END;
END$$;

-- Pure recomputation, NOT an admission API. Only preview() supplies the genuine
-- DB capture. Authoritative gross is line_total, never price*quantity repricing.
CREATE FUNCTION public.order_split210_plan(f jsonb,b jsonb,pid uuid) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE results jsonb:='[]';conflicts jsonb:='[]';child jsonb;part jsonb;i jsonb;r jsonb;alloc jsonb;idx integer;
 q bigint;moved bigint;amount bigint;price bigint;rate integer;source_vat bigint;source_net bigint;g bigint;n bigint;v bigint;vat_now bigint;
 from_q bigint;to_q bigint;g0 bigint;g1 bigint;take bigint;shipping bigint:=0;source_shipping bigint;total_rows integer:=0;
 slots uuid[]:=ARRAY[]::uuid[];seen uuid[];iid uuid;oid uuid;slot uuid;total bigint;net bigint;tax bigint;
BEGIN
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(b) key)
  IS DISTINCT FROM ARRAY['children','client_key','expected_source_version','source_order_id']::text[]
  OR octet_length(b::text)>1048576 OR jsonb_typeof(b->'children') IS DISTINCT FROM 'array'
  OR jsonb_array_length(b->'children') NOT BETWEEN 1 AND 99
  OR jsonb_typeof(b->'expected_source_version') IS DISTINCT FROM 'string' OR b->>'expected_source_version'!~'^[1-9][0-9]{0,18}$'
  OR(b->>'expected_source_version')::numeric>9223372036854775807
 THEN RAISE EXCEPTION 'Malformed split preview request' USING ERRCODE='22023';END IF;
 PERFORM(b->>'client_key')::uuid;oid:=(b->>'source_order_id')::uuid;
 IF oid IS DISTINCT FROM(f->'order'->>'id')::uuid OR(b->>'expected_source_version')::bigint IS DISTINCT FROM(f->'order'->>'version')::bigint
 THEN RAISE EXCEPTION 'Split source/version mismatch' USING ERRCODE='40001';END IF;
 source_shipping:=(f->'order'->>'shipping_cost')::bigint;
 FOR child IN SELECT value FROM jsonb_array_elements(b->'children') ORDER BY(value->>'slot_id')::uuid LOOP
  IF jsonb_typeof(child) IS DISTINCT FROM 'object' OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(child) key)
   IS DISTINCT FROM ARRAY['delivery_minor','items','name','slot_id']::text[]
   OR jsonb_typeof(child->'name') IS DISTINCT FROM 'string' OR length(child->>'name') NOT BETWEEN 1 AND 120
   OR btrim(child->>'name')='' OR child->>'name'~'[[:cntrl:]]'
   OR jsonb_typeof(child->'delivery_minor') IS DISTINCT FROM 'number' OR child->>'delivery_minor'!~'^(0|[1-9][0-9]*)$'
   OR(child->>'delivery_minor')::numeric>1000000 OR jsonb_typeof(child->'items') IS DISTINCT FROM 'array'
   OR jsonb_array_length(child->'items') NOT BETWEEN 1 AND 10000
  THEN RAISE EXCEPTION 'Malformed split child' USING ERRCODE='22023';END IF;
  slot:=(child->>'slot_id')::uuid;
  IF slot IS NULL OR slot=ANY(slots) THEN RAISE EXCEPTION 'Duplicate split slot' USING ERRCODE='23514';END IF;slots:=array_append(slots,slot);
  shipping:=shipping+(child->>'delivery_minor')::bigint;seen:=ARRAY[]::uuid[];
  FOR part IN SELECT value FROM jsonb_array_elements(child->'items') LOOP
   IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(part) key)
    IS DISTINCT FROM ARRAY['quantity','source_item_id']::text[] OR jsonb_typeof(part->'quantity') IS DISTINCT FROM 'number'
    OR part->>'quantity'!~'^[1-9][0-9]*$' OR(part->>'quantity')::numeric>100000
   THEN RAISE EXCEPTION 'Malformed split allocation' USING ERRCODE='22023';END IF;
   iid:=(part->>'source_item_id')::uuid;
   IF iid IS NULL OR iid=ANY(seen) OR NOT EXISTS(SELECT FROM jsonb_array_elements(f->'items') row_data WHERE(row_data->>'id')::uuid=iid)
   THEN RAISE EXCEPTION 'Duplicate or foreign split source item' USING ERRCODE='23514';END IF;seen:=array_append(seen,iid);
  END LOOP;
  results:=results||jsonb_build_array(jsonb_build_object('kind','child','slot_id',slot,'order_id',public.order_split210_id(pid,'order:'||slot),
   'name',child->>'name','delivery_minor',(child->>'delivery_minor')::integer,'items','[]'::jsonb));
 END LOOP;
 IF shipping>source_shipping THEN RAISE EXCEPTION 'Split shipping budget exceeded' USING ERRCODE='23514';END IF;
 results:=results||jsonb_build_array(jsonb_build_object('kind','retained_source','slot_id',NULL,'order_id',oid,'name',NULL,'delivery_minor',source_shipping-shipping,'items','[]'::jsonb));
 FOR i IN SELECT value FROM jsonb_array_elements(f->'items') ORDER BY(value->>'id')::uuid LOOP
  iid:=(i->>'id')::uuid;q:=(i->>'quantity')::bigint;amount:=(i->>'line_total')::bigint;price:=(i->>'price')::bigint;rate:=(i->>'vat')::integer;
  IF q NOT BETWEEN 1 AND 100000 OR amount NOT BETWEEN 0 AND 2147483647 OR price NOT BETWEEN 0 AND 100000000 OR rate NOT IN(0,5,8,23)
  THEN RAISE EXCEPTION 'Unsupported source line money/quantity' USING ERRCODE='23514';END IF;
  source_vat:=floor((2::numeric*amount*rate+(100+rate))/(2*(100+rate)))::bigint;source_net:=amount-source_vat;
  SELECT coalesce(sum((p->>'quantity')::bigint),0) INTO moved FROM jsonb_array_elements(b->'children') c CROSS JOIN LATERAL jsonb_array_elements(c->'items') p WHERE(p->>'source_item_id')::uuid=iid;
  IF moved>q THEN RAISE EXCEPTION 'Split quantity exceeds source' USING ERRCODE='23514';END IF;from_q:=0;
  FOR idx IN 0..jsonb_array_length(results)-1 LOOP
   r:=results->idx;
   IF idx=jsonb_array_length(results)-1 THEN take:=q-moved;
   ELSE SELECT coalesce(sum((p->>'quantity')::bigint),0) INTO take FROM jsonb_array_elements(b->'children') c CROSS JOIN LATERAL jsonb_array_elements(c->'items') p WHERE(c->>'slot_id')::uuid=(r->>'slot_id')::uuid AND(p->>'source_item_id')::uuid=iid;END IF;
   IF take=0 THEN CONTINUE;END IF;total_rows:=total_rows+1;
   IF total_rows>10000 THEN RAISE EXCEPTION 'Split allocation row budget' USING ERRCODE='54000';END IF;
   to_q:=from_q+take;g0:=amount*from_q/q;g1:=amount*to_q/q;g:=g1-g0;
   n:=CASE WHEN amount=0 THEN 0 ELSE source_net*g1/amount-source_net*g0/amount END;v:=g-n;
   vat_now:=floor((2::numeric*g*rate+(100+rate))/(2*(100+rate)))::bigint;
   IF v<>vat_now THEN conflicts:=conflicts||jsonb_build_array(jsonb_build_object('code','VAT_ROUNDING_CONFLICT','source_item_id',iid,'slot_id',r->'slot_id'));END IF;
   IF g-price*take>=take THEN conflicts:=conflicts||jsonb_build_array(jsonb_build_object('code','INVOICE_LINE_ROUNDING_CONFLICT','source_item_id',iid,'slot_id',r->'slot_id'));END IF;
   alloc:=jsonb_build_object('source_item_id',iid,'target_item_id',CASE WHEN r->>'kind'='retained_source' THEN iid ELSE public.order_split210_id(pid,'item:'||(r->>'slot_id')||':'||iid) END,
    'product_id',i->'product_id','quantity',take,'price',price,'vat',rate,'from_quantity',from_q,'to_quantity',to_q,
    'gross_minor',g,'net_minor',n,'vat_minor',v,'price_adjustment_minor',g-price*take,
    'original_quantity',q,'original_price',price,'original_gross_minor',amount,'original_net_minor',source_net,'original_vat_minor',source_vat);
   results:=jsonb_set(results,ARRAY[idx::text,'items'],(r->'items')||jsonb_build_array(alloc));from_q:=to_q;
  END LOOP;
  IF from_q<>q THEN RAISE EXCEPTION 'Split source line quantity not conserved' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR idx IN 0..jsonb_array_length(results)-1 LOOP
  r:=results->idx;IF jsonb_array_length(r->'items')=0 THEN
   IF r->>'kind'='retained_source' THEN RAISE EXCEPTION 'EMPTY_RETAINED_SOURCE' USING ERRCODE='23514';END IF;
   RAISE EXCEPTION 'EMPTY_CHILD' USING ERRCODE='23514';END IF;
  SELECT sum((a->>'gross_minor')::bigint),sum((a->>'net_minor')::bigint),sum((a->>'vat_minor')::bigint) INTO total,net,tax FROM jsonb_array_elements(r->'items') a;
  IF total+(r->>'delivery_minor')::bigint>2147483647 THEN RAISE EXCEPTION 'Split result int32 money overflow' USING ERRCODE='22003';END IF;
  results:=jsonb_set(results,ARRAY[idx::text],r||jsonb_build_object('result_index',idx,'items_gross_minor',total,'items_net_minor',net,'items_vat_minor',tax,'total_minor',total+(r->>'delivery_minor')::bigint));
 END LOOP;
 IF(SELECT sum((r->>'total_minor')::bigint) FROM jsonb_array_elements(results) r) IS DISTINCT FROM(f->'order'->>'total')::bigint
 THEN RAISE EXCEPTION 'Split complete order money not conserved' USING ERRCODE='23514';END IF;
 r:=jsonb_build_object('schema','order-split210-commercial-plan/v1','ready',conflicts='[]'::jsonb,'conflicts',conflicts,'results',results,'shipping_tax','not_allocated');
 IF octet_length(r::text)>16777216 THEN RAISE EXCEPTION 'Split output byte budget' USING ERRCODE='54000';END IF;RETURN r;
END$$;

CREATE FUNCTION public.order_split210_budget(t uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE b bigint;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('order.split210.history:'||t::text,0));
 IF(SELECT count(*) FROM public.order_split210_previews WHERE tenant_id=t)>2000 OR
   (SELECT count(*) FROM public.order_split210_executions WHERE tenant_id=t)>2000 OR(SELECT count(*) FROM public.order_split210_replay_duties WHERE tenant_id=t)>5000
 THEN RAISE EXCEPTION 'Split history count budget' USING ERRCODE='54000';END IF;
 SELECT coalesce(sum(n),0) INTO b FROM(
  SELECT octet_length(to_jsonb(p)::text)::bigint n FROM public.order_split210_previews p WHERE tenant_id=t UNION ALL
  SELECT octet_length(to_jsonb(p)::text) FROM public.order_split210_source_rows p WHERE tenant_id=t UNION ALL
  SELECT octet_length(to_jsonb(p)::text) FROM public.order_split210_executions p WHERE tenant_id=t UNION ALL
  SELECT octet_length(to_jsonb(p)::text) FROM public.order_split210_targets p WHERE tenant_id=t UNION ALL
  SELECT octet_length(to_jsonb(p)::text) FROM public.order_split210_allocations p WHERE tenant_id=t UNION ALL
  SELECT octet_length(to_jsonb(p)::text) FROM public.order_split210_replay_duties p WHERE tenant_id=t)x;
 IF b>134217728 THEN RAISE EXCEPTION 'Split history byte budget' USING ERRCODE='54000';END IF;
END$$;

-- DB facts only. No request JSON is accepted as source/custody authority.
CREATE FUNCTION public.order_split210_capture(oid uuid,expected bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;o public.orders%ROWTYPE;f jsonb;items jsonb;c jsonb;layers jsonb;n bigint;b bigint;wms_mode boolean;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Own tenant required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(982376);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('wms.policy:'||t::text,0));
 SELECT EXISTS(SELECT FROM public.wms_policies WHERE tenant_id=t AND enabled) INTO wms_mode;
 IF wms_mode THEN PERFORM pg_advisory_xact_lock(hashtextextended('wms.operations:'||t::text,0));END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('catalog:'||t::text,0));
 SELECT * INTO o FROM public.orders WHERE(tenant_id,id)=(t,oid) FOR UPDATE;
 IF o.id IS NULL OR o.version IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Split source version changed' USING ERRCODE='40001';END IF;
 IF(o.source,o.status,o.fulfillment_kind) IS DISTINCT FROM('manual','new','sale') OR o.channel_id IS NOT NULL OR o.external_id IS NOT NULL
  OR o.b2b_account_id IS NOT NULL OR o.b2b_snapshot IS NOT NULL OR o.source_snapshot IS NOT NULL OR o.replacement_return_id IS NOT NULL
  OR public.buyer_address_current_state(t,oid)->>'version' IS DISTINCT FROM '0'
 THEN RAISE EXCEPTION 'Initial split source binding is unsupported' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.order_split210_targets WHERE tenant_id=t AND(order_id=oid OR source_order_id=oid))
  OR EXISTS(SELECT FROM public.order_merge_claims WHERE tenant_id=t AND(source_order_id=oid OR target_order_id=oid))
  OR EXISTS(SELECT FROM public.order_merge_origins WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_merge_executions WHERE tenant_id=t AND(oid=ANY(source_ids) OR target_order_id=oid))
 THEN RAISE EXCEPTION 'Initial split does not accept prior split/merge lineage' USING ERRCODE='23514';END IF;
 -- Histories, not their net financial balance.077 queued execution rows exist
 -- before payment_entries/receipts and therefore count independently.
 IF EXISTS(SELECT FROM public.payment_entries WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.source_payment_checks WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.jobs WHERE tenant_id=t AND kind='payment.source.read' AND payload->>'order_id'=oid::text)
  OR EXISTS(SELECT FROM public.payment_import_allocation_rows WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.payment_import_receipts WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.payment_import_execution_rows x JOIN public.payment_import_rows r
   ON(r.tenant_id,r.preview_id,r.row_id)=(x.tenant_id,x.preview_id,x.row_id) WHERE x.tenant_id=t AND r.allocation->>'order_id'=oid::text)
 THEN RAISE EXCEPTION 'Split requires no financial history or durable payment intent' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.documents WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.invoice_plans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.local_invoice_previews WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.fa3_draft_projects WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.b2b_invoice_previews WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.local_consumer_credit_previews WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.return_credit206_previews WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.b2b_credit_previews WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.return_cases WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.return_exchanges WHERE tenant_id=t AND(original_order_id=oid OR replacement_order_id=oid))
  OR EXISTS(SELECT FROM public.b2b_external_order_intents WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.b2b_external_import_executions WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.b2b_dropship_orders WHERE(tenant_id,customer_order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.b2b_dropship_supplier_orders WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_field_values WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_field_value_events WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_field_requests WHERE(tenant_id,order_id)=(t,oid))
 THEN RAISE EXCEPTION 'Split source has unsupported documents, lineage or custom metadata' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.shipments WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.shipping_plans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_status_plans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.odoo_invoice_exports WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.ebay_fulfillment_plans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.amazon_fulfillment_plans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.shopify_fulfillment_plans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_parcel_previews WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_parcel_plans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.picking_wave_orders p JOIN public.picking_waves w ON(w.tenant_id,w.id)=(p.tenant_id,p.wave_id)
   WHERE(p.tenant_id,p.order_id)=(t,oid) AND p.active AND w.state='picking')
  OR EXISTS(SELECT FROM public.picking_wave_scans WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.packing_sessions WHERE(tenant_id,order_id,state)=(t,oid,'active'))
  OR EXISTS(SELECT FROM public.packing_receipts WHERE(tenant_id,order_id)=(t,oid))
  OR EXISTS(SELECT FROM public.order_packing_profiles WHERE(tenant_id,order_id)=(t,oid))
 THEN RAISE EXCEPTION 'Split source has fulfillment or provider history' USING ERRCODE='23514';END IF;
 SELECT count(*),coalesce(sum(octet_length(to_jsonb(i)::text)),0) INTO n,b FROM public.order_items i WHERE(i.tenant_id,i.order_id)=(t,oid);
 IF n NOT BETWEEN 1 AND 10000 OR b>8388608 THEN RAISE EXCEPTION 'Split source line budget' USING ERRCODE='54000';END IF;
 PERFORM i.id FROM public.order_items i WHERE(i.tenant_id,i.order_id)=(t,oid) ORDER BY i.id FOR UPDATE;
 PERFORM i.id FROM public.order_pick_items i WHERE(i.tenant_id,i.order_id)=(t,oid) ORDER BY i.product_id FOR UPDATE;
 PERFORM s.product_id FROM public.stock s WHERE s.tenant_id=t AND s.warehouse_id=o.warehouse_id
  AND EXISTS(SELECT FROM public.reservations r WHERE(r.tenant_id,r.order_id,r.product_id)=(t,oid,s.product_id)) ORDER BY s.warehouse_id,s.product_id FOR UPDATE;
 PERFORM product_id FROM public.reservations WHERE(tenant_id,order_id)=(t,oid) ORDER BY product_id FOR UPDATE;
 PERFORM product_id FROM public.reservation_locations WHERE(tenant_id,order_id)=(t,oid) ORDER BY product_id,location COLLATE "C" FOR UPDATE;
 PERFORM product_id FROM public.wms_reservation_layers WHERE(tenant_id,order_id)=(t,oid) ORDER BY product_id,location COLLATE "C",layer_id FOR UPDATE;
 IF EXISTS(SELECT FROM public.order_items i JOIN public.products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
  WHERE(i.tenant_id,i.order_id)=(t,oid) AND(p.kind<>'simple' OR i.scanned<>0 OR i.components IS DISTINCT FROM jsonb_build_array(jsonb_build_object('product_id',i.product_id,'quantity',1))))
  OR EXISTS(SELECT FROM public.reservations WHERE(tenant_id,order_id)=(t,oid) AND(state<>'active' OR consumed_quantity<>0 OR released_quantity<>0 OR warehouse_id<>o.warehouse_id))
  OR EXISTS(SELECT FROM public.reservation_locations WHERE(tenant_id,order_id)=(t,oid) AND(scanned<>0 OR consumed_quantity<>0 OR released_quantity<>0))
  OR EXISTS(SELECT FROM public.wms_reservation_layers WHERE(tenant_id,order_id)=(t,oid) AND(state<>'active' OR scanned<>0 OR consumed_quantity<>0 OR released_quantity<>0))
  OR EXISTS(SELECT FROM public.order_pick_items WHERE(tenant_id,order_id)=(t,oid) AND scanned<>0)
 THEN RAISE EXCEPTION 'Split requires pristine simple physical rows' USING ERRCODE='23514';END IF;
 IF EXISTS(WITH wanted AS(SELECT product_id,sum(quantity)::bigint q FROM public.order_items WHERE(tenant_id,order_id)=(t,oid) GROUP BY product_id),
  held AS(SELECT product_id,sum(quantity)::bigint q FROM public.reservations WHERE(tenant_id,order_id)=(t,oid) GROUP BY product_id),
  picked AS(SELECT product_id,sum(quantity)::bigint q FROM public.order_pick_items WHERE(tenant_id,order_id)=(t,oid) GROUP BY product_id)
  SELECT FROM wanted a FULL JOIN held b USING(product_id) FULL JOIN picked p USING(product_id) WHERE a.q IS DISTINCT FROM b.q OR a.q IS DISTINCT FROM p.q OR a.q>10000000)
  OR EXISTS(SELECT FROM public.reservations r WHERE(r.tenant_id,r.order_id)=(t,oid) AND r.quantity IS DISTINCT FROM
   (SELECT sum(quantity) FROM public.reservation_locations l WHERE(l.tenant_id,l.order_id,l.product_id,l.warehouse_id)=(r.tenant_id,r.order_id,r.product_id,r.warehouse_id)))
 THEN RAISE EXCEPTION 'Split source physical quantities do not reconcile' USING ERRCODE='23514';END IF;
 c:=public.order_merge_custody_snapshot(ARRAY[oid]);
 IF jsonb_array_length(c->'reservations')>10000 OR jsonb_array_length(c->'locations')>10000 OR jsonb_array_length(c->'layers')>10000 OR jsonb_array_length(c->'picks')>10000
 THEN RAISE EXCEPTION 'Split physical source row budget' USING ERRCODE='54000';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('layer_id',w.id,'product_id',w.product_id,'lot_id',w.lot_id,'fifo_sequence',w.fifo_sequence::text,'expiry_date',lot.expiry_date) ORDER BY w.id),'[]') INTO layers
 FROM public.wms_cost_layers w JOIN public.wms_lots lot ON(lot.tenant_id,lot.id,lot.product_id)=(w.tenant_id,w.lot_id,w.product_id)
 WHERE w.tenant_id=t AND EXISTS(SELECT FROM public.wms_reservation_layers r WHERE(r.tenant_id,r.order_id,r.layer_id)=(t,oid,w.id));
 SELECT jsonb_agg(to_jsonb(i)||jsonb_build_object('product_kind',p.kind) ORDER BY i.id) INTO items FROM public.order_items i JOIN public.products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE(i.tenant_id,i.order_id)=(t,oid);
 IF (SELECT sum((v->>'line_total')::bigint) FROM jsonb_array_elements(items) v)+o.shipping_cost IS DISTINCT FROM o.total::bigint THEN RAISE EXCEPTION 'Split original total differs from source rows' USING ERRCODE='23514';END IF;
 f:=jsonb_build_object('order',to_jsonb(o),'items',items,'custody',c,'wms_enabled',wms_mode,'layer_metadata',layers);
 IF octet_length(f::text)>8388608 THEN RAISE EXCEPTION 'Split complete source byte budget' USING ERRCODE='54000';END IF;
 RETURN f;
END$$;

-- The one execution is the only business mutation producer. It stores its exact
-- current-TX before/after proof BEFORE touching current rows. Those normal row
-- guards still run. Without the future exact104 successor a WMS change refuses
-- and the entire transaction rolls back; this file does not grant an exception.
CREATE FUNCTION public.order_split210_execute(b jsonb,u uuid,k uuid,h text,r text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p public.order_split210_previews;e public.order_split210_executions;
 auth jsonb;req text;f jsonb;plan jsonb;after_data jsonb;row_data jsonb;target jsonb;line jsonb;eid uuid:=gen_random_uuid();stamp timestamptz;tab text;bucket_name text;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(982376);
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Split predecessor metadata changed' USING ERRCODE='55000';END IF;
 auth:=public.order_split210_identity(t,u,k,h,r,true);
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR(SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(b) key)
  IS DISTINCT FROM ARRAY['client_key','confirmed','preview_id','scope_hash']::text[] OR b->'confirmed' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(b->'scope_hash') IS DISTINCT FROM 'string' OR b->>'scope_hash'!~'^[a-f0-9]{64}$' OR octet_length(b::text)>1048576
 THEN RAISE EXCEPTION 'Malformed split execution request' USING ERRCODE='22023';END IF;
 req:=public.order_split210_hash(jsonb_build_object('kind','execute','tenant_id',t,'actor_id',u,'api_key_id',k,'request',b));
 PERFORM pg_advisory_xact_lock(hashtextextended('order.split210.execute:'||t||':'||(b->>'client_key'),0));
 SELECT * INTO e FROM public.order_split210_executions WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF e.id IS NOT NULL THEN
  IF(e.actor_id,e.api_key_id,e.request_hash,e.request) IS DISTINCT FROM(u,k,req,b) THEN RAISE EXCEPTION 'Split execution key has another original body/actor' USING ERRCODE='23514';END IF;
  INSERT INTO public.order_split210_replay_duties(tenant_id,kind,command_id,actor_id,api_key_id,credential_hash,actor_role,identity_snapshot,request_hash) VALUES(t,'execute',e.id,u,k,h,r,auth,req);
  PERFORM public.order_split210_budget(t);PERFORM public.order_split210_identity(t,u,k,h,r,false);
  RETURN jsonb_build_object('id',e.id,'preview_id',e.preview_id,'source_order_id',e.source_order_id,'source_version',e.source_version::text,'source_result_version',e.result_source_version::text,
   'scope_hash',e.scope_hash,'state','done','children',(SELECT coalesce(jsonb_agg(jsonb_build_object('slot_id',slot_id,'order_id',order_id) ORDER BY slot_id),'[]') FROM public.order_split210_targets WHERE(tenant_id,execution_id)=(t,e.id) AND slot_id IS NOT NULL),'replayed',true);
 END IF;
 SELECT * INTO p FROM public.order_split210_previews WHERE(tenant_id,id)=(t,(b->>'preview_id')::uuid) FOR UPDATE;
 IF p.id IS NULL OR(p.actor_id,p.api_key_id,p.scope_hash) IS DISTINCT FROM(u,k,b->>'scope_hash') OR (p.expires_at IS NULL OR p.expires_at<=clock_timestamp())
  OR EXISTS(SELECT FROM public.order_split210_executions WHERE(tenant_id,preview_id)=(t,p.id)) OR p.plan->'ready' IS DISTINCT FROM 'true'::jsonb
 THEN RAISE EXCEPTION 'Unavailable, consumed or incompatible split preview' USING ERRCODE='23514';END IF;
 f:=public.order_split210_capture(p.source_order_id,p.source_version);
 plan:=public.order_split210_plan(f,p.request,p.id);plan:=plan||jsonb_build_object('custody',public.order_split210_physical(f,plan,p.id));
 IF f IS DISTINCT FROM p.snapshot OR plan IS DISTINCT FROM p.plan OR p.scope_hash IS DISTINCT FROM public.order_split210_hash(jsonb_build_object('source',f,'request',p.request,'plan',plan))
 THEN RAISE EXCEPTION 'Split source/custody/pricing scope changed after preview' USING ERRCODE='40001';END IF;
 SET CONSTRAINTS order_split210_execution_complete DEFERRED;
 stamp:=clock_timestamp();IF p.expires_at IS NULL OR p.expires_at<=stamp THEN RAISE EXCEPTION 'Split preview expired after source wait' USING ERRCODE='28000';END IF;
 after_data:=public.order_split210_materialize(p,stamp);
 IF octet_length(after_data::text)>16777216 THEN RAISE EXCEPTION 'Split materialized result byte budget' USING ERRCODE='54000';END IF;
 INSERT INTO public.order_split210_executions(tenant_id,id,preview_id,actor_id,api_key_id,credential_hash,actor_role,identity_snapshot,client_key,request,request_hash,scope_hash,source_order_id,source_version,result_source_version,before_frame,after_frame,created_at,expires_at)
 VALUES(t,eid,p.id,u,k,h,r,auth,(b->>'client_key')::uuid,b,req,p.scope_hash,p.source_order_id,p.source_version,p.source_version+1,f,after_data,stamp,least(p.expires_at,stamp+interval '15 minutes')) RETURNING * INTO e;
 FOR target IN SELECT value FROM jsonb_array_elements(plan->'results') LOOP
  INSERT INTO public.order_split210_targets(tenant_id,execution_id,preview_id,result_index,slot_id,order_id,source_order_id,name,delivery_minor,total_minor)
  VALUES(t,eid,p.id,(target->>'result_index')::int,(target->>'slot_id')::uuid,(target->>'order_id')::uuid,p.source_order_id,target->>'name',(target->>'delivery_minor')::int,(target->>'total_minor')::int);
  FOR line IN SELECT value FROM jsonb_array_elements(target->'items') LOOP
   INSERT INTO public.order_split210_allocations(tenant_id,execution_id,preview_id,result_index,source_item_id,target_item_id,product_id,quantity,from_quantity,to_quantity,gross_minor,net_minor,vat_minor,payload)
   VALUES(t,eid,p.id,(target->>'result_index')::int,(line->>'source_item_id')::uuid,(line->>'target_item_id')::uuid,(line->>'product_id')::uuid,(line->>'quantity')::int,
    (line->>'from_quantity')::int,(line->>'to_quantity')::int,(line->>'gross_minor')::int,(line->>'net_minor')::int,(line->>'vat_minor')::int,line);
  END LOOP;
 END LOOP;
 -- Child orders are created once under this proof, never by N independent calls
 -- to createOrder (which would reserve and move stock N times).
 FOR row_data IN SELECT value FROM jsonb_array_elements(after_data->'orders') WHERE(value->>'id')::uuid<>p.source_order_id ORDER BY(value->>'id')::uuid LOOP
  INSERT INTO public.orders SELECT * FROM jsonb_populate_record(NULL::public.orders,row_data);
 END LOOP;
 FOR row_data IN SELECT value FROM jsonb_array_elements(after_data->'items') WHERE(value->>'order_id')::uuid<>p.source_order_id ORDER BY(value->>'id')::uuid LOOP
  INSERT INTO public.order_items SELECT * FROM jsonb_populate_record(NULL::public.order_items,row_data);
 END LOOP;
 DELETE FROM public.order_items i WHERE(i.tenant_id,i.order_id)=(t,p.source_order_id) AND NOT EXISTS(SELECT FROM jsonb_array_elements(after_data->'items') v WHERE(v->>'id')::uuid=i.id);
 UPDATE public.order_items i SET quantity=(v->>'quantity')::int,line_total=(v->>'line_total')::int FROM jsonb_array_elements(after_data->'items') v
  WHERE(i.tenant_id,i.order_id,i.id)=(t,p.source_order_id,(v->>'id')::uuid) AND(i.quantity,i.line_total) IS DISTINCT FROM((v->>'quantity')::int,(v->>'line_total')::int);
 -- Current custody rows may shrink/disappear only with their exact immutable
 -- original tuple archived above.104 currently refuses the WMS branch. A later
 -- source-derived guard must delegate exact allowed rows, not disable history.
 FOREACH tab IN ARRAY ARRAY['wms_reservation_layers','reservation_locations','reservations','order_pick_items'] LOOP
  bucket_name:=CASE tab WHEN 'wms_reservation_layers' THEN 'layers' WHEN 'reservation_locations' THEN 'locations' WHEN 'order_pick_items' THEN 'picks' ELSE 'reservations' END;
  IF tab='order_pick_items' THEN
   DELETE FROM public.order_pick_items i WHERE(i.tenant_id,i.order_id)=(t,p.source_order_id) AND NOT EXISTS(SELECT FROM jsonb_array_elements(after_data->'custody'->bucket_name) v WHERE(v->>'id')::uuid=i.id);
  ELSIF tab='reservations' THEN
   DELETE FROM public.reservations i WHERE(i.tenant_id,i.order_id)=(t,p.source_order_id) AND NOT EXISTS(SELECT FROM jsonb_array_elements(after_data->'custody'->bucket_name) v WHERE(v->>'order_id',v->>'product_id')=(i.order_id::text,i.product_id::text));
  ELSIF tab='reservation_locations' THEN
   DELETE FROM public.reservation_locations i WHERE(i.tenant_id,i.order_id)=(t,p.source_order_id) AND NOT EXISTS(SELECT FROM jsonb_array_elements(after_data->'custody'->bucket_name) v WHERE(v->>'order_id',v->>'product_id',v->>'location')=(i.order_id::text,i.product_id::text,i.location));
  ELSE
   DELETE FROM public.wms_reservation_layers i WHERE(i.tenant_id,i.order_id)=(t,p.source_order_id) AND NOT EXISTS(SELECT FROM jsonb_array_elements(after_data->'custody'->bucket_name) v WHERE(v->>'order_id',v->>'product_id',v->>'location',v->>'layer_id')=(i.order_id::text,i.product_id::text,i.location,i.layer_id::text));
  END IF;
 END LOOP;
 -- No UPSERT: BEFORE INSERT would itself be a different transition on an
 -- existing source row, even if ON CONFLICT later chose UPDATE.
 UPDATE public.order_pick_items i SET quantity=v.quantity FROM jsonb_populate_recordset(NULL::public.order_pick_items,after_data->'custody'->'picks') v
  WHERE(i.tenant_id,i.order_id,i.id)=(t,p.source_order_id,v.id) AND v.order_id=p.source_order_id AND i.quantity<>v.quantity;
 UPDATE public.reservations i SET quantity=v.quantity FROM jsonb_populate_recordset(NULL::public.reservations,after_data->'custody'->'reservations') v
  WHERE(i.tenant_id,i.order_id,i.product_id)=(t,p.source_order_id,v.product_id) AND v.order_id=p.source_order_id AND i.quantity<>v.quantity;
 UPDATE public.reservation_locations i SET quantity=v.quantity FROM jsonb_populate_recordset(NULL::public.reservation_locations,after_data->'custody'->'locations') v
  WHERE(i.tenant_id,i.order_id,i.product_id,i.location)=(t,p.source_order_id,v.product_id,v.location) AND v.order_id=p.source_order_id AND i.quantity<>v.quantity;
 UPDATE public.wms_reservation_layers i SET quantity=v.quantity FROM jsonb_populate_recordset(NULL::public.wms_reservation_layers,after_data->'custody'->'layers') v
  WHERE(i.tenant_id,i.order_id,i.product_id,i.location,i.layer_id)=(t,p.source_order_id,v.product_id,v.location,v.layer_id) AND v.order_id=p.source_order_id AND i.quantity<>v.quantity;
 INSERT INTO public.order_pick_items SELECT * FROM jsonb_populate_recordset(NULL::public.order_pick_items,after_data->'custody'->'picks') WHERE order_id<>p.source_order_id;
 INSERT INTO public.reservations SELECT * FROM jsonb_populate_recordset(NULL::public.reservations,after_data->'custody'->'reservations') WHERE order_id<>p.source_order_id;
 INSERT INTO public.reservation_locations SELECT * FROM jsonb_populate_recordset(NULL::public.reservation_locations,after_data->'custody'->'locations') WHERE order_id<>p.source_order_id;
 INSERT INTO public.wms_reservation_layers SELECT * FROM jsonb_populate_recordset(NULL::public.wms_reservation_layers,after_data->'custody'->'layers') WHERE order_id<>p.source_order_id;
 SELECT value INTO STRICT row_data FROM jsonb_array_elements(after_data->'orders') WHERE(value->>'id')::uuid=p.source_order_id;
 UPDATE public.orders SET total=(row_data->>'total')::int,shipping_cost=(row_data->>'shipping_cost')::int,updated_at=stamp WHERE(tenant_id,id)=(t,p.source_order_id);
 INSERT INTO public.order_events(id,tenant_id,order_id,kind,detail)
  SELECT gen_random_uuid(),t,order_id,CASE WHEN slot_id IS NULL THEN 'order.split.source' ELSE 'order.split.child' END,
   jsonb_build_object('execution_id',eid,'source_order_id',p.source_order_id,'slot_id',slot_id)
  FROM public.order_split210_targets WHERE(tenant_id,execution_id)=(t,eid);
 INSERT INTO public.audit_events(id,tenant_id,user_id,action,entity_id,detail) VALUES(gen_random_uuid(),t,u,'order.split',p.source_order_id,jsonb_build_object('execution_id',eid,'children',jsonb_array_length(plan->'results')-1));
 PERFORM public.order_split210_budget(t);
 IF auth IS DISTINCT FROM public.order_split210_identity(t,u,k,h,r,false) THEN RAISE EXCEPTION 'Split execution identity changed after wait' USING ERRCODE='40001';END IF;
 RETURN jsonb_build_object('id',e.id,'preview_id',e.preview_id,'source_order_id',e.source_order_id,'source_version',e.source_version::text,'source_result_version',e.result_source_version::text,
  'scope_hash',e.scope_hash,'state','done','children',(SELECT jsonb_agg(jsonb_build_object('slot_id',slot_id,'order_id',order_id) ORDER BY slot_id) FROM public.order_split210_targets WHERE(tenant_id,execution_id)=(t,eid) AND slot_id IS NOT NULL),'replayed',false);
END$$;

-- Deliberately no GRANT, migration INSERT, accepted metadata manifest, source
-- contract, predecessor rewrite, or valid=true placeholder. Source compilation
-- and integration must pin this whole namespace plus external trigger roster.
DO $split210_no_activation$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'order_split210_') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);
 END LOOP;
END $split210_no_activation$;
