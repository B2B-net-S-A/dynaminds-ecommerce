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
