-- SOURCE_AUTHORED_NOT_RUN: complete certified162 candidate. Never apply individual fragments.
-- WIP162 certified bootstrap COMPOSITION FRAGMENT / NOT_APPLY_READY.
-- Must execute BEFORE producer/topology/consumer and all replacement DDL.
SET LOCAL TimeZone='UTC';
DO $$BEGIN
 IF NOT credit_source_upgrade_valid() OR NOT b2b_credit_guards() OR NOT b2b_invoice_guards() OR NOT fa3_draft_guards() OR NOT local_invoice_guards() OR NOT catalog_stock_return_guards()
 OR EXISTS(SELECT FROM migrations WHERE name='162_financial_return')
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'financial_return_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'financial_return_'))
 OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'financial_return_')) THEN RAISE EXCEPTION '162 requires complete literal161 and no own remnants' USING ERRCODE='55000';END IF;
END$$;
CREATE TEMP TABLE financial_return_migration_basis ON COMMIT DROP AS
 SELECT pg_current_xact_id() root_xid,transaction_timestamp() transaction_started_at,pg_backend_pid() backend_pid,session_user::text migration_owner,
 jsonb_build_object('157',(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id),'158',(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id),'159',(SELECT to_jsonb(m) FROM b2b_invoice_upgrade m WHERE id),'160',(SELECT to_jsonb(m) FROM b2b_credit_upgrade m WHERE id),'161',(SELECT to_jsonb(m) FROM credit_source_upgrade_certificate m WHERE id)) original,jsonb_build_object('157',local_invoice_fingerprint(),'158',fa3_draft_fingerprint(),'159',b2b_invoice_fingerprint(),'160',b2b_credit_fingerprint(),'161',credit_source_upgrade_fingerprint()) predecessors,
 (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indexrelid IN('public.document_order_mode'::regclass,'public.document_return_mode'::regclass)) original014_indexes,
 (SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'source_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'retset',p.proretset,'return',pg_get_function_result(p.oid),'arguments',pg_get_function_identity_arguments(p.oid),'modes',p.proargmodes,'names',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0),'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.privilege_type,a.grantor,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN('public.b2b_credit_basis(uuid,uuid)'::regprocedure,'public.b2b_credit_calculate(jsonb)'::regprocedure,'public.b2b_credit_previous(uuid)'::regprocedure,'public.b2b_credit_preview(jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure,'public.b2b_credit_issue(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'::regprocedure,'public.b2b_credit_record_guard()'::regprocedure,'public.b2b_credit_source_seal()'::regprocedure,'public.credit_source_upgrade_valid()'::regprocedure)) replaced_functions;
CREATE TABLE financial_return_upgrade_certificate(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),profile text NOT NULL CHECK(profile='161-original-to162-financial-return/v1'),
 original jsonb NOT NULL,predecessors jsonb NOT NULL,replaced_functions jsonb NOT NULL,successors jsonb NOT NULL,original014_indexes jsonb NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CHECK(octet_length(original::text)+octet_length(replaced_functions::text)<=2097152));
ALTER TABLE financial_return_upgrade_certificate ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_return_upgrade_certificate FORCE ROW LEVEL SECURITY;
REVOKE ALL ON financial_return_upgrade_certificate FROM PUBLIC,dyna_app;


-- WIP162 producer COMPOSITION FRAGMENT / NOT_APPLY_READY / NOT_RUN.
-- Full certified162 wrapper, consumer topology and final guards are required.
-- Do not install this fragment alone: financial_return_guards is deliberately
-- supplied by the complete immutable upgrade package, never a true stub.
SET LOCAL TimeZone='UTC';
CREATE TABLE financial_return_admissions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants,
 original_document_id uuid NOT NULL,original_receipt_id uuid NOT NULL,order_id uuid NOT NULL,return_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,api_key_id uuid,identity_hash text NOT NULL CHECK(identity_hash~'^[a-f0-9]{64}$'),
 request jsonb NOT NULL,before_frame jsonb NOT NULL,
 root_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),transaction_started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),backend_pid integer NOT NULL DEFAULT pg_backend_pid(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,return_id),
 FOREIGN KEY(tenant_id,original_document_id) REFERENCES documents(tenant_id,id),
 FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES b2b_invoice_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 FOREIGN KEY(tenant_id,api_key_id) REFERENCES api_keys(tenant_id,id),
 CHECK(octet_length(before_frame::text)<=33554432));
CREATE TABLE financial_return_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants,original_document_id uuid NOT NULL,original_receipt_id uuid NOT NULL,
 order_id uuid NOT NULL,return_id uuid NOT NULL,receipt_sequence integer NOT NULL CHECK(receipt_sequence>0),
 snapshot jsonb NOT NULL,physical_before jsonb NOT NULL,physical_after jsonb NOT NULL,
 financial jsonb NOT NULL,financial_hash text NOT NULL CHECK(financial_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,return_id),UNIQUE(tenant_id,order_id,receipt_sequence),
 FOREIGN KEY(tenant_id,id) REFERENCES financial_return_admissions(tenant_id,id),
 FOREIGN KEY(tenant_id,original_document_id) REFERENCES documents(tenant_id,id),
 FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES b2b_invoice_receipts(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id,return_id) REFERENCES return_cases(tenant_id,order_id,id),
 CHECK(physical_before=physical_after),CHECK(octet_length(snapshot::text)+octet_length(physical_before::text)+octet_length(physical_after::text)<=67108864));
ALTER TABLE financial_return_admissions ADD FOREIGN KEY(tenant_id,id) REFERENCES financial_return_receipts(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX financial_return_admission_root ON financial_return_admissions(tenant_id,root_xid,transaction_started_at,backend_pid);
DO $$DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['financial_return_admissions','financial_return_receipts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,dyna_app',tab);
END LOOP;END$$;
CREATE FUNCTION financial_return_identity(uid uuid,kid uuid,h text,rid uuid,pin boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;stamp timestamptz;v record;g jsonb;required text[];BEGIN
 IF h IS NULL OR h!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Brak tożsamości żądania przyjęcia' USING ERRCODE='28000';END IF;
 IF pin THEN
  PERFORM id FROM users WHERE id=uid FOR SHARE;
  IF kid IS NULL THEN PERFORM token_hash FROM sessions WHERE(token_hash,user_id,tenant_id)=(h,uid,t) FOR SHARE;END IF;
  PERFORM id FROM tenants WHERE id=t FOR SHARE;
  PERFORM user_id FROM account_security WHERE user_id=uid FOR SHARE;
  PERFORM tenant_id FROM workspace_security_policies WHERE tenant_id=t FOR SHARE;
  PERFORM role FROM memberships WHERE(tenant_id,user_id)=(t,uid) FOR SHARE;
  IF kid IS NOT NULL THEN PERFORM id FROM api_keys WHERE(tenant_id,id,user_id)=(t,kid,uid) FOR SHARE;END IF;
 END IF;
 g:=catalog_stock_return_access(uid,kid,rid,'rma');
 SELECT array_agg(value ORDER BY value) INTO required FROM jsonb_array_elements_text(g->'scopes');
 stamp:=clock_timestamp();
 IF kid IS NULL THEN
  SELECT m.role,true scope_ok,coalesce(p.require_mfa,false) AND NOT(coalesce(a.enabled_at IS NOT NULL AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>stamp-interval '8 hours',false)) mfa_required INTO v
  FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants tt ON tt.id=s.tenant_id
  LEFT JOIN memberships m ON(m.tenant_id,m.user_id)=(s.tenant_id,s.user_id)
  LEFT JOIN account_security a ON a.user_id=u.id LEFT JOIN workspace_security_policies p ON p.tenant_id=tt.id
  WHERE(s.token_hash,s.user_id,s.tenant_id)=(h,uid,t) AND s.expires_at>stamp AND s.account_version=coalesce(a.version,0);
 ELSE
  SELECT m.role,coalesce(k.scopes@>required,false) scope_ok,coalesce(p.require_mfa,false) AND a.enabled_at IS NULL mfa_required INTO v
  FROM api_keys k JOIN users u ON u.id=k.user_id JOIN tenants tt ON tt.id=k.tenant_id
  LEFT JOIN memberships m ON(m.tenant_id,m.user_id)=(k.tenant_id,k.user_id)
  LEFT JOIN account_security a ON a.user_id=u.id LEFT JOIN workspace_security_policies p ON p.tenant_id=tt.id
  WHERE(k.id,k.token_hash,k.user_id,k.tenant_id)=(kid,h,uid,t) AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>stamp);
 END IF;
 IF v IS NULL THEN RAISE EXCEPTION 'Sesja lub klucz FV wygasły albo utraciły zakres' USING ERRCODE='28000';END IF;
 IF v.role IS NULL OR v.role NOT IN('admin','operator') OR(g->>'admin_only'='true' AND v.role<>'admin') OR v.mfa_required OR v.scope_ok IS NOT TRUE THEN RAISE EXCEPTION 'Brak aktualnej tożsamości lub MFA dla przyjęcia' USING ERRCODE='42501';END IF;
END$$;
CREATE FUNCTION financial_return_original(did uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
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
 RETURN jsonb_build_object('document',to_jsonb(d),'receipt',to_jsonb(ir),'preview',to_jsonb(p),'admission',to_jsonb(ad),
 'project',to_jsonb(project),'project_receipt',to_jsonb(projectreceipt),'source_preview',to_jsonb(projectpreview),'series',to_jsonb(s),'series_command',to_jsonb(cmd));
END$$;

CREATE FUNCTION financial_return_physical(rid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;warehouse uuid;products uuid[];resultj jsonb;BEGIN
 SELECT warehouse_id INTO warehouse FROM return_cases WHERE(tenant_id,id)=(tenant,rid);
 SELECT array_agg(DISTINCT(component->>'product_id')::uuid ORDER BY(component->>'product_id')::uuid) INTO products
 FROM return_items ri CROSS JOIN LATERAL jsonb_array_elements(ri.components)component WHERE(ri.tenant_id,ri.return_id)=(tenant,rid);
 IF cardinality(products)>10000 OR(SELECT coalesce(sum(jsonb_array_length(components)),0) FROM return_items WHERE(tenant_id,return_id)=(tenant,rid))>10000 THEN RAISE EXCEPTION 'Financial fullrecipe exceeds10000 entries/products' USING ERRCODE='54000';END IF;
 SELECT jsonb_build_object(
 'stock',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.product_id),'[]') FROM stock s WHERE(s.tenant_id,s.warehouse_id)=(tenant,warehouse) AND s.product_id=ANY(products)),
 'bins',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.product_id,b.location COLLATE "C"),'[]') FROM stock_locations b WHERE(b.tenant_id,b.warehouse_id)=(tenant,warehouse) AND b.product_id=ANY(products)),
 'stock_journals',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') FROM stock_movements m WHERE(m.tenant_id,m.warehouse_id)=(tenant,warehouse) AND m.product_id=ANY(products)),
 'bin_journals',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') FROM stock_location_movements m WHERE(m.tenant_id,m.warehouse_id)=(tenant,warehouse) AND m.product_id=ANY(products)),
 'layers',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]') FROM wms_cost_layers l WHERE l.tenant_id=tenant AND l.product_id=ANY(products)),
 'positions',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.layer_id,p.warehouse_id,p.location COLLATE "C"),'[]') FROM wms_layer_positions p JOIN wms_cost_layers l ON(l.tenant_id,l.id)=(p.tenant_id,p.layer_id) WHERE(p.tenant_id,p.warehouse_id)=(tenant,warehouse) AND p.product_id=ANY(products)),
 'lots',(SELECT coalesce(jsonb_agg(to_jsonb(lot) ORDER BY lot.id),'[]') FROM wms_lots lot WHERE lot.tenant_id=tenant AND lot.product_id=ANY(products)),
 'layer_journals',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') FROM wms_layer_movements m WHERE(m.tenant_id,m.warehouse_id)=(tenant,warehouse) AND m.product_id=ANY(products)),
 'operations',(SELECT coalesce(jsonb_agg(to_jsonb(op) ORDER BY op.id),'[]') FROM wms_operations op WHERE(op.tenant_id,op.return_id)=(tenant,rid)),
 'physical_admissions',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM catalog_stock_return_admissions a WHERE(a.tenant_id,a.return_id)=(tenant,rid)),
 'physical_receipts',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM catalog_stock_return_receipts r WHERE(r.tenant_id,r.return_id)=(tenant,rid)),
 'physical_documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]') FROM catalog_stock_return_documents d WHERE(d.tenant_id,d.return_id)=(tenant,rid))
 ) INTO resultj;
 IF octet_length(resultj::text)>33554432 THEN RAISE EXCEPTION 'Financial physical fullgraph exceeds32MiB' USING ERRCODE='54000';END IF;
 RETURN resultj;
END$$;
CREATE FUNCTION financial_return_frame(uid uuid,kid uuid,h text,rid uuid,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;rc record;original_id uuid;originalj jsonb;itemsj jsonb;priorj jsonb;commercialj jsonb;physicalj jsonb;resultj jsonb;BEGIN
 IF NOT financial_return_guards() THEN RAISE EXCEPTION 'Incomplete162 metadata' USING ERRCODE='55000';END IF;
 SELECT * INTO rc FROM return_cases WHERE(tenant_id,id)=(tenant,rid);IF rc.id IS NULL THEN RAISE EXCEPTION 'No own RMA' USING ERRCODE='P0002';END IF;
 PERFORM financial_return_identity(uid,kid,h,rid,false);
 -- Capture is neutral outside this explicit protocol; it never fabricates an
 -- admission for a mixed, old, destination, local, parcel or exchange receive.
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(q->'items')v WHERE(v->>'accepted')::bigint>0) THEN RETURN NULL;END IF;
 IF rc.legacy OR rc.remedy<>'refund' OR rc.state<>'requested' OR rc.receipt IS NOT NULL OR rc.received_at IS NOT NULL OR rc.receipt_sequence<>0
 OR EXISTS(SELECT FROM jsonb_array_elements(q->'items')v WHERE(v->>'restocked')::integer<>0)
 OR q ? 'wms_lots' OR q ? 'origin_id'
 OR EXISTS(SELECT FROM b2b_return_local_origins WHERE(tenant_id,return_id)=(tenant,rid))
 OR EXISTS(SELECT FROM order_parcel_plans WHERE(tenant_id,order_id)=(tenant,rc.order_id)) THEN RETURN NULL;END IF;
 SELECT id INTO original_id FROM documents WHERE(tenant_id,order_id)=(tenant,rc.order_id) AND kind='invoice' AND mode='b2b_invoice';
 IF original_id IS NULL THEN RETURN NULL;END IF;
 originalj:=financial_return_original(original_id);
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.item_id),'[]') INTO itemsj FROM return_items i WHERE(i.tenant_id,i.return_id)=(tenant,rid);
 SELECT coalesce(jsonb_agg(jsonb_build_object('return_case',to_jsonb(r),'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.item_id),'[]') FROM return_items i WHERE(i.tenant_id,i.return_id)=(tenant,r.id))) ORDER BY r.receipt_sequence,r.id),'[]')
 INTO priorj FROM return_cases r WHERE(r.tenant_id,r.order_id)=(tenant,rc.order_id) AND r.id<>rid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'quantity',i.quantity::text,'line_total',i.line_total::text) ORDER BY i.id),'[]') INTO commercialj FROM order_items i WHERE(i.tenant_id,i.order_id)=(tenant,rc.order_id);
 physicalj:=financial_return_physical(rid);
 IF(physicalj->'physical_admissions')<>'[]'::jsonb OR(physicalj->'physical_receipts')<>'[]'::jsonb OR(physicalj->'physical_documents')<>'[]'::jsonb OR(physicalj->'operations')<>'[]'::jsonb
 OR EXISTS(SELECT FROM stock_movements WHERE(tenant_id,return_id)=(tenant,rid)) THEN RAISE EXCEPTION 'No-restock already has physical source' USING ERRCODE='23514';END IF;
 resultj:=jsonb_build_object('schema','financial-return-capture/v1','original',originalj,'return_case',to_jsonb(rc),'items',itemsj,'commercial',commercialj,'prior',priorj,'physical',physicalj,'request',q);
 IF jsonb_array_length(itemsj) NOT BETWEEN 1 AND 100 OR jsonb_array_length(commercialj) NOT BETWEEN 1 AND 100 OR jsonb_array_length(priorj)>1000 OR octet_length(resultj::text)>33554432 THEN RAISE EXCEPTION 'Whole financial scope exceeds budget' USING ERRCODE='54000';END IF;
 RETURN resultj;
END$$;
CREATE FUNCTION financial_return_claim(uid uuid,kid uuid,h text,rid uuid,q jsonb,captured jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE fresh jsonb;eid uuid;tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;BEGIN
 -- Caller already owns canonical lockedReturn/order locks, no new namespace
 -- acquisition after those row locks. Source is reread before first core UPDATE.
 fresh:=financial_return_frame(uid,kid,h,rid,q);
 IF fresh IS NULL OR fresh IS DISTINCT FROM captured OR(fresh#>>'{return_case,version}')::bigint<>(q->>'version')::bigint THEN RAISE EXCEPTION 'Changed actual financial source' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM jsonb_array_elements(q->'items'))<>jsonb_array_length(fresh->'items')
 OR(SELECT count(DISTINCT v->>'item_id') FROM jsonb_array_elements(q->'items')v)<>jsonb_array_length(fresh->'items')
 OR EXISTS(SELECT FROM jsonb_array_elements(fresh->'items')i WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(q->'items')v WHERE v->>'item_id'=i->>'item_id' AND(v->>'accepted')::bigint BETWEEN 0 AND(i->>'requested')::bigint AND(v->>'restocked')::bigint=0))
 OR coalesce((SELECT sum((v->>'accepted')::bigint) FROM jsonb_array_elements(q->'items')v),0)<=0 THEN RAISE EXCEPTION 'Incomplete actual financial receive request' USING ERRCODE='22023';END IF;
 INSERT INTO financial_return_admissions(tenant_id,original_document_id,original_receipt_id,order_id,return_id,actor_id,api_key_id,identity_hash,request,before_frame)
 VALUES(tenant,(fresh#>>'{original,document,id}')::uuid,(fresh#>>'{original,receipt,id}')::uuid,(fresh#>>'{return_case,order_id}')::uuid,rid,uid,kid,h,q,fresh) RETURNING id INTO eid;
 RETURN eid;
END$$;

CREATE FUNCTION financial_return_received(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a record;rc record;itemsj jsonb;BEGIN
 SELECT * INTO a FROM financial_return_admissions WHERE id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF a.id IS NULL THEN RAISE EXCEPTION 'No own admission162' USING ERRCODE='P0002';END IF;
 SELECT * INTO rc FROM return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.item_id),'[]') INTO itemsj FROM return_items i WHERE(i.tenant_id,i.return_id)=(a.tenant_id,a.return_id);
 RETURN jsonb_build_object('received',jsonb_build_object('return_case',to_jsonb(rc),'items',itemsj,'original',financial_return_original(a.original_document_id)),
 'physical',financial_return_physical(a.return_id));
END$$;
CREATE FUNCTION financial_return_projection(beforej jsonb,savedj jsonb,physicalj jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE oldcase jsonb:=beforej->'return_case';newcase jsonb:=savedj->'return_case';itemsj jsonb:=savedj->'items';requestj jsonb:=beforej->'request';itemj jsonb;olditem jsonb;wanted jsonb;linej jsonb;
 prior_units numeric;refund numeric;units numeric:=0;total numeric;next_seq integer;financialj jsonb;BEGIN
 IF octet_length(beforej::text)+octet_length(savedj::text)+octet_length(physicalj::text)>33554432 THEN RAISE EXCEPTION 'Full financial received evidence exceeds32MiB' USING ERRCODE='54000';END IF;
 IF oldcase->>'state'<>'requested' OR oldcase->>'remedy'<>'refund' OR oldcase->>'legacy'<>'false'
 OR oldcase->'receipt'<>'null'::jsonb OR oldcase->'received_at'<>'null'::jsonb OR(oldcase->>'receipt_sequence')::integer<>0
 OR newcase->>'state'<>'refund_pending' OR newcase->>'received_at' IS NULL OR(newcase->>'version')::bigint<>(oldcase->>'version')::bigint+1
 OR(newcase->>'version')::bigint<>(requestj->>'version')::bigint+1 OR newcase->'receipt' IS DISTINCT FROM requestj
 OR newcase-ARRAY['state','version','updated_at','receipt','decision_note','received_at','receipt_sequence','refunded_shipping','refund_amount'] IS DISTINCT FROM oldcase-ARRAY['state','version','updated_at','receipt','decision_note','received_at','receipt_sequence','refunded_shipping','refund_amount']
 OR newcase->>'decision_note' IS DISTINCT FROM requestj->>'note'
 OR savedj->'original' IS DISTINCT FROM beforej->'original' OR physicalj IS DISTINCT FROM beforej->'physical'
 OR jsonb_array_length(itemsj)<>jsonb_array_length(beforej->'items') THEN RAISE EXCEPTION 'Actual no-restock transition changed full source' USING ERRCODE='23514';END IF;
 SELECT coalesce(max((v#>>'{return_case,receipt_sequence}')::integer),0)+1 INTO next_seq FROM jsonb_array_elements(beforej->'prior')v;
 IF(newcase->>'receipt_sequence')::integer<>next_seq THEN RAISE EXCEPTION 'Actual financial receipt sequence mismatch' USING ERRCODE='23514';END IF;
 total:=(requestj->>'shipping_refund')::numeric;
 IF total<0 OR total>(oldcase->>'requested_shipping')::numeric OR(newcase->>'refunded_shipping')::numeric<>total THEN RAISE EXCEPTION 'Financial shipping mismatch' USING ERRCODE='23514';END IF;
 FOR itemj IN SELECT value FROM jsonb_array_elements(itemsj) LOOP
  SELECT value INTO olditem FROM jsonb_array_elements(beforej->'items') WHERE value->>'item_id'=itemj->>'item_id';
  SELECT value INTO wanted FROM jsonb_array_elements(requestj->'items') WHERE value->>'item_id'=itemj->>'item_id';
  SELECT value INTO linej FROM jsonb_array_elements(beforej->'commercial') WHERE value->>'id'=itemj->>'item_id';
  IF olditem IS NULL OR wanted IS NULL OR linej IS NULL OR itemj-ARRAY['accepted','restocked','refund_amount'] IS DISTINCT FROM olditem-ARRAY['accepted','restocked','refund_amount']
  OR(itemj->>'accepted')::numeric<>(wanted->>'accepted')::numeric OR(itemj->>'accepted')::numeric NOT BETWEEN 0 AND(olditem->>'requested')::numeric OR(itemj->>'restocked')::numeric<>0 THEN RAISE EXCEPTION 'No complete actual financial items' USING ERRCODE='23514';END IF;
  SELECT coalesce(sum((prior_item->>'accepted')::numeric),0) INTO prior_units FROM jsonb_array_elements(beforej->'prior')prior_case CROSS JOIN LATERAL jsonb_array_elements(prior_case->'items')prior_item
  WHERE prior_case#>>'{return_case,state}' IN('refund_pending','closed') AND prior_item->>'item_id'=itemj->>'item_id';
  IF(linej->>'quantity')::numeric<=0 OR prior_units+(itemj->>'accepted')::numeric>(linej->>'quantity')::numeric THEN RAISE EXCEPTION 'Financial quantity exceeds frozen actual order' USING ERRCODE='23514';END IF;
  refund:=floor((linej->>'line_total')::numeric*(prior_units+(itemj->>'accepted')::numeric)/(linej->>'quantity')::numeric)-floor((linej->>'line_total')::numeric*prior_units/(linej->>'quantity')::numeric);
  IF(itemj->>'refund_amount')::numeric<>refund THEN RAISE EXCEPTION 'Financial refund allocation differs from core' USING ERRCODE='23514';END IF;
  units:=units+(itemj->>'accepted')::numeric;total:=total+refund;
 END LOOP;
 IF units<=0 OR total>2147483647 OR total<>(newcase->>'refund_amount')::numeric THEN RAISE EXCEPTION 'Financial total/accepted mismatch' USING ERRCODE='23514';END IF;
 financialj:=jsonb_build_object('tenant_id',(oldcase->>'tenant_id')::uuid,'order_id',(oldcase->>'order_id')::uuid,'return_id',(oldcase->>'id')::uuid,'number',newcase->'number','receipt_sequence',newcase->'receipt_sequence',
 'kind',newcase->'kind','received_state','refund_pending','remedy','refund','legacy',false,'acceptance_kind','financial_no_restock','received_at',newcase->'received_at',
 'refund_amount_minor',(newcase->>'refund_amount')::bigint::text,'refunded_shipping_minor',(newcase->>'refunded_shipping')::bigint::text,
 'items',(SELECT jsonb_agg(jsonb_build_object('item_id',v->'item_id','accepted',(v->>'accepted')::bigint::text,'restocked','0','refund_amount_minor',(v->>'refund_amount')::bigint::text) ORDER BY v->>'item_id') FROM jsonb_array_elements(itemsj)v));
 RETURN jsonb_build_object('snapshot',savedj,'financial',financialj,'financial_hash',fa3_draft_hash(financialj),'physical',physicalj);
END$$;
CREATE FUNCTION financial_return_expected(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a record;graphj jsonb;BEGIN
 SELECT * INTO a FROM financial_return_admissions WHERE id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF a.id IS NULL OR(a.root_xid,a.transaction_started_at,a.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) THEN RAISE EXCEPTION 'No actual current-root financial admission' USING ERRCODE='23514';END IF;
 graphj:=financial_return_received(eid);
 IF false
 OR a.before_frame->'prior' IS DISTINCT FROM(SELECT coalesce(jsonb_agg(jsonb_build_object('return_case',to_jsonb(pr),'items',(SELECT coalesce(jsonb_agg(to_jsonb(pi) ORDER BY pi.item_id),'[]') FROM return_items pi WHERE(pi.tenant_id,pi.return_id)=(pr.tenant_id,pr.id))) ORDER BY pr.receipt_sequence,pr.id),'[]') FROM return_cases pr WHERE(pr.tenant_id,pr.order_id)=(a.tenant_id,a.order_id) AND pr.id<>a.return_id)
 OR a.before_frame->'commercial' IS DISTINCT FROM(SELECT coalesce(jsonb_agg(jsonb_build_object('id',oi.id,'quantity',oi.quantity::text,'line_total',oi.line_total::text) ORDER BY oi.id),'[]') FROM order_items oi WHERE(oi.tenant_id,oi.order_id)=(a.tenant_id,a.order_id))
 THEN RAISE EXCEPTION 'Complete prior/commercial source changed during actual receive' USING ERRCODE='23514';END IF;
 RETURN financial_return_projection(a.before_frame,graphj->'received',graphj->'physical');
END$$;
CREATE FUNCTION financial_return_finish(uid uuid,kid uuid,h text,eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a record;r record;expected jsonb;BEGIN
 SELECT * INTO a FROM financial_return_admissions WHERE id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF a.id IS NULL OR(a.actor_id,a.api_key_id,a.identity_hash) IS DISTINCT FROM(uid,kid,h) THEN RAISE EXCEPTION 'Foreign financial completion' USING ERRCODE='42501';END IF;
 IF NOT financial_return_guards() THEN RAISE EXCEPTION 'Torn162 before completion' USING ERRCODE='55000';END IF;
 PERFORM financial_return_identity(uid,kid,h,a.return_id,false);expected:=financial_return_expected(eid);
 INSERT INTO financial_return_receipts(id,tenant_id,original_document_id,original_receipt_id,order_id,return_id,receipt_sequence,snapshot,physical_before,physical_after,financial,financial_hash)
 VALUES(a.id,a.tenant_id,a.original_document_id,a.original_receipt_id,a.order_id,a.return_id,(expected#>>'{snapshot,return_case,receipt_sequence}')::integer,expected->'snapshot',a.before_frame->'physical',expected->'physical',expected->'financial',expected->>'financial_hash') RETURNING * INTO r;
 RETURN to_jsonb(r);
END$$;
CREATE FUNCTION financial_return_history(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a record;r record;rc record;itemsj jsonb;expected jsonb;BEGIN
 SELECT * INTO a FROM financial_return_admissions WHERE id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 SELECT * INTO r FROM financial_return_receipts WHERE(tenant_id,id)=(a.tenant_id,a.id);
 SELECT * INTO rc FROM return_cases WHERE(tenant_id,id)=(a.tenant_id,a.return_id);
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.item_id),'[]') INTO itemsj FROM return_items i WHERE(i.tenant_id,i.return_id)=(a.tenant_id,a.return_id);
 IF a.id IS NULL OR r.id IS NULL OR rc.id IS NULL
 OR(a.tenant_id,a.original_document_id,a.original_receipt_id,a.order_id,a.return_id) IS DISTINCT FROM(r.tenant_id,r.original_document_id,r.original_receipt_id,r.order_id,r.return_id)
 OR(a.root_xid=pg_current_xact_id() AND a.transaction_started_at=transaction_timestamp() AND a.backend_pid=pg_backend_pid())
 OR r.snapshot#>>'{return_case,state}'<>'refund_pending' OR rc.state NOT IN('refund_pending','closed') OR rc.version<(r.snapshot#>>'{return_case,version}')::bigint
 OR to_jsonb(rc)-ARRAY['state','version','updated_at','refunded_at','settlement'] IS DISTINCT FROM(r.snapshot->'return_case')-ARRAY['state','version','updated_at','refunded_at','settlement']
 OR itemsj IS DISTINCT FROM r.snapshot->'items' OR financial_return_original(a.original_document_id) IS DISTINCT FROM r.snapshot->'original'
 OR r.physical_before IS DISTINCT FROM r.physical_after OR r.physical_before IS DISTINCT FROM a.before_frame->'physical'
 OR fa3_draft_hash(r.financial)<>r.financial_hash OR r.snapshot#>'{return_case,receipt}' IS DISTINCT FROM a.request THEN RAISE EXCEPTION 'No complete historical financial receipt162' USING ERRCODE='23514';END IF;
 expected:=financial_return_projection(a.before_frame,r.snapshot,r.physical_after);
 IF(expected->'financial',expected->>'financial_hash') IS DISTINCT FROM(r.financial,r.financial_hash)
 OR(r.snapshot#>>'{original,document,id}',r.snapshot#>>'{original,receipt,id}',r.snapshot#>>'{return_case,id}',r.snapshot#>>'{return_case,order_id}',r.snapshot#>>'{return_case,tenant_id}',r.created_at)
 IS DISTINCT FROM(a.original_document_id::text,a.original_receipt_id::text,a.return_id::text,a.order_id::text,a.tenant_id::text,a.transaction_started_at)
 THEN RAISE EXCEPTION 'Historical received projection/whole typed admission tuple differs162' USING ERRCODE='23514';END IF;
 -- Current inventory may legitimately change after commit; historic zero
 -- physical effects are proved by immutable equal before/after witnesses.
 RETURN jsonb_build_object('receipt',to_jsonb(r),'admission',to_jsonb(a),'current_case',to_jsonb(rc),'items',itemsj);
END$$;
CREATE FUNCTION financial_return_capture(uid uuid,kid uuid,h text,rid uuid,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;a record;f jsonb;BEGIN
 IF NOT financial_return_guards() THEN RAISE EXCEPTION 'Incomplete162 capture' USING ERRCODE='55000';END IF;
 PERFORM financial_return_identity(uid,kid,h,rid,false);
 SELECT * INTO a FROM financial_return_admissions WHERE(tenant_id,return_id)=(tenant,rid);
 IF a.id IS NOT NULL THEN
  IF(a.actor_id,a.api_key_id,a.request) IS DISTINCT FROM(uid,kid,q) THEN RAISE EXCEPTION 'Different receive replay author/key/body162' USING ERRCODE='23514';END IF;
  PERFORM financial_return_history(a.id);
  RETURN jsonb_build_object('phase','replay','receipt_id',a.id,'frame',a.before_frame);
 END IF;
 f:=financial_return_frame(uid,kid,h,rid,q);IF f IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('phase','captured','frame',f);
END$$;
CREATE FUNCTION financial_return_replay(uid uuid,kid uuid,h text,eid uuid,q jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a record;BEGIN
 SELECT * INTO a FROM financial_return_admissions WHERE id=eid AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF a.id IS NULL OR(a.actor_id,a.api_key_id,a.request) IS DISTINCT FROM(uid,kid,q) THEN RAISE EXCEPTION 'Different actual financial replay' USING ERRCODE='23514';END IF;
 IF NOT financial_return_guards() THEN RAISE EXCEPTION 'Torn162 replay' USING ERRCODE='55000';END IF;
 PERFORM financial_return_identity(uid,kid,h,a.return_id,false);PERFORM financial_return_history(eid);
END$$;

CREATE FUNCTION financial_return_admission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
BEGIN
 IF TG_OP<>'INSERT' OR(NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())
 OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
 OR NEW.before_frame IS DISTINCT FROM financial_return_frame(NEW.actor_id,NEW.api_key_id,NEW.identity_hash,NEW.return_id,NEW.request)
 OR(NEW.original_document_id,NEW.original_receipt_id,NEW.order_id) IS DISTINCT FROM((NEW.before_frame#>>'{original,document,id}')::uuid,(NEW.before_frame#>>'{original,receipt,id}')::uuid,(NEW.before_frame#>>'{return_case,order_id}')::uuid) THEN RAISE EXCEPTION 'Not an immutable native admission162' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE FUNCTION financial_return_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a record;expected jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Immutable received financial receipt162' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM financial_return_admissions WHERE id=NEW.id AND tenant_id=NEW.tenant_id;
 expected:=financial_return_expected(a.id);
 IF a.id IS NULL OR(NEW.tenant_id,NEW.original_document_id,NEW.original_receipt_id,NEW.order_id,NEW.return_id,NEW.receipt_sequence,NEW.created_at)
 IS DISTINCT FROM(a.tenant_id,a.original_document_id,a.original_receipt_id,a.order_id,a.return_id,(expected#>>'{snapshot,return_case,receipt_sequence}')::integer,transaction_timestamp())
 OR NEW.snapshot IS DISTINCT FROM expected->'snapshot' OR NEW.financial IS DISTINCT FROM expected->'financial' OR NEW.financial_hash IS DISTINCT FROM expected->>'financial_hash'
 OR NEW.physical_before IS DISTINCT FROM a.before_frame->'physical' OR NEW.physical_after IS DISTINCT FROM expected->'physical' THEN RAISE EXCEPTION 'Receipt is not the full real receive result' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE FUNCTION financial_return_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE r record;expected jsonb;BEGIN
 expected:=financial_return_expected(NEW.id);
 SELECT * INTO r FROM financial_return_receipts WHERE id=NEW.id AND tenant_id=NEW.tenant_id;
 IF r.id IS NULL OR r.snapshot IS DISTINCT FROM expected->'snapshot' OR r.financial IS DISTINCT FROM expected->'financial'
 OR r.financial_hash IS DISTINCT FROM expected->>'financial_hash' OR r.physical_after IS DISTINCT FROM expected->'physical' THEN RAISE EXCEPTION 'Financial current-root graph changed before terminal' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE TRIGGER financial_return_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON financial_return_admissions FOR EACH ROW EXECUTE FUNCTION financial_return_admission_guard();
CREATE TRIGGER financial_return_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON financial_return_receipts FOR EACH ROW EXECUTE FUNCTION financial_return_receipt_guard();
CREATE CONSTRAINT TRIGGER financial_return_complete AFTER INSERT ON financial_return_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_return_complete();
CREATE FUNCTION financial_return_source_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE oldj jsonb:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;newj jsonb:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;rid uuid;parentj jsonb;BEGIN
 FOR parentj IN SELECT v FROM(VALUES(oldj),(newj))source_rows(v) LOOP
  rid:=(parentj->>(CASE WHEN TG_TABLE_NAME='return_cases' THEN 'id' ELSE 'return_id' END))::uuid;
  IF EXISTS(SELECT FROM financial_return_receipts r WHERE(r.tenant_id,r.return_id)=((parentj->>'tenant_id')::uuid,rid)) THEN
   IF TG_TABLE_NAME='return_cases' AND TG_OP='UPDATE' AND
    oldj-ARRAY['state','version','updated_at','refunded_at','settlement'] IS NOT DISTINCT FROM newj-ARRAY['state','version','updated_at','refunded_at','settlement'] AND
    ((oldj IS NOT DISTINCT FROM newj) OR(oldj->>'state'='refund_pending' AND newj->>'state'='closed' AND(newj->>'version')::bigint=(oldj->>'version')::bigint+1
      AND(newj->>'refunded_at')::timestamptz=transaction_timestamp() AND(newj->>'updated_at')::timestamptz=transaction_timestamp()
      AND newj#>>'{settlement,confirmed}'='true' AND(newj#>>'{settlement,version}')::bigint=(oldj->>'version')::bigint
      AND(newj#>>'{settlement,amount}')::numeric BETWEEN 0 AND(oldj->>'refund_amount')::numeric
      AND length(newj#>>'{settlement,reference}') BETWEEN 3 AND 200)) THEN CONTINUE;END IF;
   RAISE EXCEPTION 'Immutable received financial source162' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER financial_return_source_seal BEFORE INSERT OR UPDATE OR DELETE ON return_cases FOR EACH ROW EXECUTE FUNCTION financial_return_source_seal();
CREATE TRIGGER financial_return_source_seal BEFORE INSERT OR UPDATE OR DELETE ON return_items FOR EACH ROW EXECUTE FUNCTION financial_return_source_seal();
CREATE FUNCTION financial_return_terminal(uid uuid,kid uuid,h text,eids uuid[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE a record;r record;expected jsonb;BEGIN
 IF cardinality(eids)<>1 THEN RAISE EXCEPTION 'Initial162 is a single ordinary receive, not a group capability' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM financial_return_admissions WHERE id=eids[1] AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 IF a.id IS NULL OR(a.actor_id,a.api_key_id) IS DISTINCT FROM(uid,kid) THEN RAISE EXCEPTION 'Foreign terminal162' USING ERRCODE='42501';END IF;
 PERFORM financial_return_identity(uid,kid,h,a.return_id,true);
 IF NOT financial_return_guards() OR NOT credit_source_upgrade_valid() OR NOT b2b_credit_guards() OR NOT b2b_invoice_guards() OR NOT fa3_draft_guards() OR NOT local_invoice_guards() OR NOT catalog_stock_return_guards() THEN RAISE EXCEPTION 'Torn162 after real final identity wait' USING ERRCODE='55000';END IF;
 IF(a.root_xid,a.transaction_started_at,a.backend_pid) IS NOT DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid()) THEN
  expected:=financial_return_expected(a.id);SELECT * INTO r FROM financial_return_receipts WHERE(tenant_id,id)=(a.tenant_id,a.id);
  IF r.id IS NULL OR r.snapshot IS DISTINCT FROM expected->'snapshot' OR r.financial IS DISTINCT FROM expected->'financial'
  OR r.physical_after IS DISTINCT FROM expected->'physical' THEN RAISE EXCEPTION 'Actual financial graph changed after all sibling waits' USING ERRCODE='23514';END IF;
 ELSE PERFORM financial_return_history(a.id);END IF;
 PERFORM financial_return_identity(uid,kid,h,a.return_id,false);
END$$;
DO $$DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'financial_return_') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);END LOOP;END$$;
GRANT EXECUTE ON FUNCTION financial_return_terminal(uuid,uuid,text,uuid[]) TO dyna_app;
-- Full metadata-only162 certificate/guard and exclusive mixed credit consumer
-- composition MUST follow; no migration ledger or adoption is emitted here.


-- WIP162 composition fragment. NOT_APPLY_READY / NOT_RUN.
-- Certified bootstrap must capture all predecessor metadata BEFORE this DDL.
-- Old physical FK names/targets, values and JSON remain. One new NULL field
-- per old row is the complete declared data shape exception.
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['b2b_credit_previews','b2b_credit_admissions','b2b_credit_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN financial_return_receipt_id uuid',tab);
  EXECUTE format('ALTER TABLE %I ALTER COLUMN return_receipt_id DROP NOT NULL',tab);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(tenant_id,financial_return_receipt_id) REFERENCES financial_return_receipts(tenant_id,id)',tab,tab||'_financial_parent');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK((return_receipt_id IS NOT NULL AND financial_return_receipt_id IS NULL) OR(return_receipt_id IS NULL AND financial_return_receipt_id IS NOT NULL))',tab,tab||'_financial_xor');
 END LOOP;
END$$;
CREATE UNIQUE INDEX b2b_credit_admission_financial_once ON b2b_credit_admissions(tenant_id,financial_return_receipt_id) WHERE financial_return_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX b2b_credit_receipt_financial_once ON b2b_credit_receipts(tenant_id,financial_return_receipt_id) WHERE financial_return_receipt_id IS NOT NULL;
-- Both014 indexes MUST remain unchanged. A full writer replacement uses
-- coalesce(return_receipt_id,financial_return_receipt_id) only as generic saved
-- UUID; actual native typed financial/physical validation remains mandatory.
CREATE FUNCTION financial_return_credit_parent(original_id uuid,rid uuid,physical_id uuid,financial_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;g jsonb;BEGIN
 IF(physical_id IS NULL)=(financial_id IS NULL) THEN RAISE EXCEPTION 'Exactly one native return parent required' USING ERRCODE='23514';END IF;
 IF physical_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT FROM catalog_stock_return_receipts r JOIN b2b_invoice_receipts ir ON(ir.tenant_id,ir.order_id)=(r.tenant_id,r.order_id)
   WHERE(r.tenant_id,r.id,r.return_id,ir.document_id)=(tenant,physical_id,rid,original_id)) THEN RAISE EXCEPTION 'Foreign physical169 original/RMA tuple' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT FROM financial_return_receipts WHERE(tenant_id,return_id)=(tenant,rid)) THEN RAISE EXCEPTION 'Conflicting financial and physical parent' USING ERRCODE='23514';END IF;
  PERFORM b2b_credit_physical(physical_id);RETURN physical_id;
 END IF;
 g:=financial_return_history(financial_id);
 IF(g#>>'{receipt,original_document_id}',g#>>'{receipt,return_id}',g#>>'{receipt,tenant_id}') IS DISTINCT FROM(original_id::text,rid::text,tenant::text)
 OR EXISTS(SELECT FROM catalog_stock_return_receipts WHERE(tenant_id,return_id)=(tenant,rid)) THEN RAISE EXCEPTION 'Foreign/conflicting financial original/RMA tuple' USING ERRCODE='23514';END IF;
 RETURN financial_id;
END$$;
-- OPEN before adoption: exact b2b_credit_basis/previous/preview/issue/
-- record_guard/validate/snapshot replacements and TS collector integration.
-- This helper+DDL alone MUST NOT be used with unmodified160 functions.


-- WIP162 coherent native credit consumer COMPOSITION FRAGMENT.
-- NOT_APPLY_READY / NOT_RUN. Predecessor definitions are captured by the
-- complete certificate BEFORE any replacement. Both014 indexes stay literal.
-- Physical branch JSON/snapshot/hash remains byte-semantic identical; only
-- NULL new columns are removed from old private source receipt objects.
CREATE OR REPLACE FUNCTION b2b_credit_basis(did uuid,selected_return uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
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
  IF raw IS NULL THEN
   SELECT id INTO prev FROM financial_return_receipts WHERE(tenant_id,return_id)=(t,rr.id);
   IF prev IS NULL THEN RAISE EXCEPTION 'Brak exactly-one immutable169/162receipt' USING ERRCODE='23514';END IF;
   raw:=financial_return_history(prev);
   PERFORM financial_return_credit_parent(did,rr.id,NULL,prev);
   financial:=raw#>'{receipt,financial}';
   acceptances:=acceptances||jsonb_build_array(financial||jsonb_build_object('native_proof',jsonb_build_object('kind','financial_return162','receipt_id',raw#>'{receipt,id}','admission_id',raw#>'{admission,id}','receipt_snapshot_hash',fa3_draft_hash(raw#>'{receipt,snapshot}'),'financial_hash',raw#>'{receipt,financial_hash}')));
   history:=history||jsonb_build_array(raw);CONTINUE;
  END IF;
  PERFORM financial_return_credit_parent(did,rr.id,(raw#>>'{receipt,id}')::uuid,NULL);
  raw:=raw||jsonb_build_object('physical',b2b_credit_physical((raw#>>'{receipt,id}')::uuid));
  financial:=jsonb_build_object('tenant_id',t,'order_id',d.order_id,'return_id',rr.id,'number',raw#>'{receipt,snapshot,return_case,number}','receipt_sequence',rr.receipt_sequence,
   'kind',raw#>'{receipt,snapshot,return_case,kind}','received_state','refund_pending','remedy','refund','legacy',raw#>'{receipt,snapshot,return_case,legacy}','acceptance_kind','physical',
   'received_at',raw#>'{receipt,snapshot,return_case,received_at}','refund_amount_minor',(raw#>>'{receipt,snapshot,return_case,refund_amount}')::bigint::text,'refunded_shipping_minor',(raw#>>'{receipt,snapshot,return_case,refunded_shipping}')::bigint::text,
   'items',(SELECT jsonb_agg(jsonb_build_object('item_id',v->'item_id','accepted',(v->>'accepted')::bigint::text,'restocked',(v->>'restocked')::bigint::text,'refund_amount_minor',(v->>'refund_amount')::bigint::text) ORDER BY v->>'item_id') FROM jsonb_array_elements(raw#>'{receipt,snapshot,items}') v));
  acceptances:=acceptances||jsonb_build_array(financial||jsonb_build_object('native_proof',jsonb_build_object('kind','catalog_stock_return169','receipt_id',raw#>'{receipt,id}','admission_id',raw#>'{admission,id}','receipt_snapshot_hash',fa3_draft_hash(raw#>'{receipt,snapshot}'),'financial_hash',fa3_draft_hash(financial))));history:=history||jsonb_build_array(raw);
 END LOOP;
 IF EXISTS(SELECT FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(t,d.order_id) AND rc.received_at IS NULL AND b2b_dropship_return_acceptance(rc.id) IS NOT NULL) THEN RAISE EXCEPTION 'Unsupported partner fullhistory160' USING ERRCODE='23514';END IF;
 IF seq=0 AND selected_return IS NOT NULL THEN RAISE EXCEPTION 'Selected correction requires accepted169history' USING ERRCODE='23514';END IF;
 prev:=NULL;
 FOR cr IN SELECT r.*,to_jsonb(dc) doc FROM b2b_credit_receipts r JOIN documents dc ON(dc.tenant_id,dc.id)=(r.tenant_id,r.document_id) WHERE(r.tenant_id,r.original_document_id)=(t,did) AND NOT(r.root_xid=pg_current_xact_id() AND r.transaction_started_at=transaction_timestamp() AND r.backend_pid=pg_backend_pid()) ORDER BY r.receipt_sequence,r.id LOOP
  PERFORM b2b_credit_previous(cr.document_id);
  IF cr.previous_receipt_id IS DISTINCT FROM prev OR cr.receipt_sequence<>jsonb_array_length(previousj)+1 OR cr.snapshot IS DISTINCT FROM cr.doc->'data' OR cr.doc->>'mode'<>'b2b_correction' OR cr.doc->>'kind'<>'correction' OR cr.doc->>'return_id'<>cr.return_id::text THEN RAISE EXCEPTION 'Spliced nativeprevious160receipt' USING ERRCODE='23514';END IF;
  previousj:=previousj||jsonb_build_array(jsonb_build_object('document_id',cr.document_id,'receipt_id',cr.id,'original_document_id',cr.original_document_id,'original_receipt_id',cr.original_receipt_id,'return_id',cr.return_id,'return_receipt_id',coalesce(cr.return_receipt_id,cr.financial_return_receipt_id),'receipt_sequence',cr.receipt_sequence,'calculation',cr.snapshot->'calculation','calculation_hash',cr.calculation_hash));prev:=cr.id;creditsj:=creditsj||jsonb_build_array(CASE WHEN cr.financial_return_receipt_id IS NULL THEN to_jsonb(cr)-'financial_return_receipt_id' ELSE to_jsonb(cr) END);
 END LOOP;
 IF seq=0 AND(jsonb_array_length(previousj)<>0 OR jsonb_array_length(creditsj)<>0 OR EXISTS(SELECT FROM b2b_credit_receipts WHERE(tenant_id,original_document_id)=(t,did)) OR EXISTS(SELECT FROM b2b_credit_admissions WHERE(tenant_id,original_document_id)=(t,did)) OR EXISTS(SELECT FROM documents WHERE(tenant_id,order_id)=(t,d.order_id) AND kind='correction')) THEN RAISE EXCEPTION 'Credits without accepted169history' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM orders o WHERE(o.tenant_id,o.id)=(t,d.order_id) AND o.currency<>'PLN') THEN RAISE EXCEPTION 'Zmieniona waluta źródła' USING ERRCODE='23514';END IF;
 inputj:=jsonb_build_object('original',original,'acceptance_manifest',jsonb_build_object('count',jsonb_array_length(acceptances),'financial_history_hash',fa3_draft_hash(acceptances)),'acceptances',acceptances,'previous_credits',previousj,'selected_return_id',selected_return,'shipping_credit_scope','native_refunded_shipping_value_only');
 raw:=jsonb_build_object('original',jsonb_build_object('document',to_jsonb(d),'receipt',to_jsonb(ir),'preview',to_jsonb(p),'admission',to_jsonb(ad),'project',to_jsonb(project),'project_receipt',to_jsonb(projectreceipt),'source_preview',to_jsonb(projectpreview),'series',to_jsonb(s),'series_command',to_jsonb(cmd)),'returns',history,'credits',creditsj,'input',inputj);
 IF octet_length(raw::text)>33554432 THEN RAISE EXCEPTION 'Pełne źródło160 przekracza32MiB' USING ERRCODE='54000';END IF;RETURN raw;
END$$;

CREATE OR REPLACE FUNCTION b2b_credit_calculate(x jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE original jsonb:=x->'original';fiscal jsonb:=x#>'{original,document,data,fiscal_snapshot}';accepted jsonb:='{}';prior jsonb;shipping numeric:=0;prior_shipping numeric;refund numeric;units numeric;
 a jsonb;it jsonb;ln jsonb;pc jsonb;rowsj jsonb;rowj jsonb;calc jsonb;resultj jsonb;beforej jsonb;afterj jsonb;vatj jsonb;vatcode text;
 idx integer:=0;selected integer:=jsonb_array_length(x->'previous_credits');q numeric;n numeric;oldq numeric;g numeric;bq numeric;aq numeric;pg numeric;ng numeric;rate integer;bm jsonb;am jsonb;chain text;ids uuid[]:='{}';BEGIN
 IF jsonb_array_length(x->'acceptances') NOT BETWEEN 1 AND 1000 OR selected>=jsonb_array_length(x->'acceptances')
 OR x#>>'{acceptances}' IS NULL OR x#>>'{acceptance_manifest,count}' IS DISTINCT FROM jsonb_array_length(x->'acceptances')::text
 OR x#>>'{acceptance_manifest,financial_history_hash}' IS DISTINCT FROM fa3_draft_hash(x->'acceptances')
 OR x->>'selected_return_id' IS DISTINCT FROM(x->'acceptances'->selected->>'return_id') THEN RAISE EXCEPTION 'Niepełna chronologia korekt160' USING ERRCODE='23514';END IF;
 chain:=fa3_draft_hash(jsonb_build_object('original_document_id',original#>'{document,id}','original_receipt_id',original#>'{receipt,id}'));
 FOR a IN SELECT value FROM jsonb_array_elements(x->'acceptances') LOOP
  IF NOT((a->>'acceptance_kind'='physical' AND a#>>'{native_proof,kind}'='catalog_stock_return169')
  OR(a->>'acceptance_kind'='financial_no_restock' AND a#>>'{native_proof,kind}'='financial_return162')) THEN RAISE EXCEPTION 'Unsupported native financial discriminator162' USING ERRCODE='23514';END IF;
  IF a->>'acceptance_kind'='financial_no_restock' AND EXISTS(SELECT FROM jsonb_array_elements(a->'items')fi WHERE(fi->>'restocked')::numeric<>0) THEN RAISE EXCEPTION 'Financial receipt contains physical restock162' USING ERRCODE='23514';END IF;
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

CREATE OR REPLACE FUNCTION b2b_credit_previous(did uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;r b2b_credit_receipts;p b2b_credit_previews;a b2b_credit_admissions;d documents;BEGIN
 SELECT * INTO d FROM documents WHERE(tenant_id,id)=(t,did);SELECT * INTO r FROM b2b_credit_receipts WHERE(tenant_id,document_id)=(t,did);
 SELECT * INTO p FROM b2b_credit_previews WHERE(tenant_id,id)=(t,r.preview_id);SELECT * INTO a FROM b2b_credit_admissions WHERE(tenant_id,id)=(t,r.id);
 IF d.id IS NULL OR r.id IS NULL OR p.id IS NULL OR a.id IS NULL
 OR(d.kind,d.mode,d.number,d.order_id,d.return_id,d.channel_id,d.external_id) IS DISTINCT FROM('correction'::text,'b2b_correction'::text,r.number,r.order_id,r.return_id,NULL::uuid,NULL::text)
 OR(a.id,a.document_id,a.preview_id,a.original_document_id,a.return_id,a.return_receipt_id,a.financial_return_receipt_id,a.actor_id,a.api_key_id,a.client_key,a.request,a.request_hash,a.year,a.sequence,a.number,a.root_xid,a.transaction_started_at,a.backend_pid)
 IS DISTINCT FROM(r.id,r.document_id,r.preview_id,r.original_document_id,r.return_id,r.return_receipt_id,r.financial_return_receipt_id,r.actor_id,r.api_key_id,r.client_key,r.request,r.request_hash,r.year,r.sequence,r.number,r.root_xid,r.transaction_started_at,r.backend_pid)
 OR(r.original_document_id,r.original_receipt_id,r.order_id,r.return_id,r.return_receipt_id,r.financial_return_receipt_id,r.receipt_sequence,r.previous_receipt_id,r.series_id,r.scope_hash)
 IS DISTINCT FROM(p.original_document_id,p.original_receipt_id,p.order_id,p.return_id,p.return_receipt_id,p.financial_return_receipt_id,p.receipt_sequence,p.previous_receipt_id,p.series_id,p.scope_hash)
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
 PERFORM financial_return_credit_parent(r.original_document_id,r.return_id,r.return_receipt_id,r.financial_return_receipt_id);
 IF coalesce(r.return_receipt_id,r.financial_return_receipt_id) IS DISTINCT FROM(r.snapshot->>'return_receipt_id')::uuid THEN RAISE EXCEPTION 'Spliced generic saved parent162' USING ERRCODE='23514';END IF;
END$$;

CREATE OR REPLACE FUNCTION b2b_credit_preview(b jsonb,expected_input jsonb,expected_calculation jsonb,uid uuid,kid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_credit_previews;src jsonb;snap jsonb;rh text:=fa3_draft_hash(jsonb_build_object('request',b,'actor',uid,'key',kid));prev uuid;BEGIN
 PERFORM b2b_credit_require(uid,kid,h,true,false);PERFORM b2b_credit_locks((b->>'original_document_id')::uuid);
 SELECT * INTO p FROM b2b_credit_previews WHERE(tenant_id,client_key)=(t,(b->>'client_key')::uuid);
 IF p.id IS NOT NULL THEN IF(p.actor_id,p.api_key_id,p.request,p.request_hash) IS DISTINCT FROM(uid,kid,b,rh) THEN RAISE EXCEPTION 'Klucz podglądu z inną zgodą160' USING ERRCODE='23514';END IF;RETURN jsonb_build_object('id',p.id,'reused',true);END IF;
 src:=b2b_credit_basis((b->>'original_document_id')::uuid,(b->>'return_id')::uuid);snap:=b2b_credit_snapshot(src,b);
 IF octet_length(src::text)+octet_length((src->'input')::text)>33554432 OR octet_length(snap::text)>2097152 THEN RAISE EXCEPTION 'Cały preview160 przekracza jawny budżet' USING ERRCODE='54000';END IF;
 IF src->'input' IS DISTINCT FROM expected_input OR snap->'calculation' IS DISTINCT FROM expected_calculation THEN RAISE EXCEPTION 'Native/pure/history proof nie odpowiada sobie160' USING ERRCODE='23514';END IF;
 SELECT id INTO prev FROM b2b_credit_receipts WHERE(tenant_id,original_document_id)=(t,(b->>'original_document_id')::uuid) ORDER BY receipt_sequence DESC LIMIT 1;
 INSERT INTO b2b_credit_previews(tenant_id,original_document_id,original_receipt_id,order_id,return_id,return_receipt_id,financial_return_receipt_id,series_id,receipt_sequence,previous_receipt_id,actor_id,api_key_id,client_key,request,request_hash,source,input,snapshot,scope_hash)
 VALUES(t,(snap->>'original_document_id')::uuid,(snap->>'original_receipt_id')::uuid,(src#>>'{input,original,document,order_id}')::uuid,(snap->>'return_id')::uuid,CASE WHEN src#>>'{input,acceptances}' IS NOT NULL AND EXISTS(SELECT FROM jsonb_array_elements(src#>'{input,acceptances}')v WHERE v->>'return_id'=snap->>'return_id' AND v->>'acceptance_kind'='physical') THEN(snap->>'return_receipt_id')::uuid ELSE NULL END,
 CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(src#>'{input,acceptances}')v WHERE v->>'return_id'=snap->>'return_id' AND v->>'acceptance_kind'='financial_no_restock') THEN(snap->>'return_receipt_id')::uuid ELSE NULL END,(snap->>'series_id')::uuid,(snap->>'receipt_sequence')::integer,prev,uid,kid,(b->>'client_key')::uuid,b,rh,src,src->'input',snap,fa3_draft_hash(jsonb_build_object('request',b,'source',src,'input',src->'input','snapshot',snap))) RETURNING * INTO p;
 PERFORM b2b_credit_budget(t);RETURN jsonb_build_object('id',p.id,'reused',false);
END$$;

CREATE OR REPLACE FUNCTION b2b_credit_issue(pid uuid,b jsonb,expected_input jsonb,expected_calculation jsonb,uid uuid,kid uuid,h text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
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
 INSERT INTO b2b_credit_admissions(id,tenant_id,document_id,preview_id,original_document_id,return_id,return_receipt_id,financial_return_receipt_id,actor_id,api_key_id,client_key,request,request_hash,year,sequence,number)
 VALUES(rid,t,did,p.id,p.original_document_id,p.return_id,p.return_receipt_id,p.financial_return_receipt_id,uid,kid,(b->>'client_key')::uuid,b,rh,yr,seq,num);
 IF NOT EXISTS(SELECT FROM b2b_credit_namespaces WHERE(tenant_id,series_id)=(t,p.series_id)) THEN INSERT INTO b2b_credit_namespaces(seller_tax_id,prefix,tenant_id,series_id) VALUES(p.snapshot#>>'{calculation,fiscal_snapshot,seller,tax_id}',prefix,t,p.series_id);END IF;
 IF NOT EXISTS(SELECT FROM b2b_credit_counters WHERE(tenant_id,series_id,year)=(t,p.series_id,yr)) THEN INSERT INTO b2b_credit_counters VALUES(t,p.series_id,yr,0);END IF;
 snap:=snap||jsonb_build_object('number',num,'year',yr,'sequence',seq,'preview_id',p.id,'scope_hash',p.scope_hash);
 INSERT INTO documents(id,tenant_id,order_id,return_id,kind,mode,number,data) VALUES(did,t,p.order_id,p.return_id,'correction','b2b_correction',num,snap);
 INSERT INTO b2b_credit_receipts(id,tenant_id,document_id,preview_id,original_document_id,original_receipt_id,order_id,return_id,return_receipt_id,financial_return_receipt_id,series_id,receipt_sequence,previous_receipt_id,actor_id,api_key_id,client_key,request,request_hash,snapshot,calculation_hash,scope_hash,year,sequence,number)
 VALUES(rid,t,did,p.id,p.original_document_id,p.original_receipt_id,p.order_id,p.return_id,p.return_receipt_id,p.financial_return_receipt_id,p.series_id,p.receipt_sequence,p.previous_receipt_id,uid,kid,(b->>'client_key')::uuid,b,rh,snap,p.snapshot->>'calculation_hash',p.scope_hash,yr,seq,num);
 UPDATE b2b_credit_counters SET last_number=seq WHERE(tenant_id,series_id,year)=(t,p.series_id,yr);
 RETURN jsonb_build_object('document_id',did,'receipt_id',rid,'reused',false);
END$$;

CREATE OR REPLACE FUNCTION b2b_credit_record_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE t uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;p b2b_credit_previews;a b2b_credit_admissions;raw jsonb:=to_jsonb(NEW);src jsonb;n integer;BEGIN
 IF NOT b2b_credit_guards() OR NEW.tenant_id IS DISTINCT FROM t THEN RAISE EXCEPTION 'Niepełny kontekst160' USING ERRCODE='55000';END IF;
 IF TG_TABLE_NAME='b2b_credit_previews' THEN
  src:=b2b_credit_basis(NEW.original_document_id,NEW.return_id);
  IF NEW.source IS DISTINCT FROM src OR NEW.input IS DISTINCT FROM src->'input' OR NEW.snapshot IS DISTINCT FROM b2b_credit_snapshot(src,NEW.request)
  OR(NEW.original_receipt_id,NEW.order_id,coalesce(NEW.return_receipt_id,NEW.financial_return_receipt_id),NEW.series_id,NEW.receipt_sequence) IS DISTINCT FROM((NEW.snapshot->>'original_receipt_id')::uuid,(src#>>'{input,original,document,order_id}')::uuid,(NEW.snapshot->>'return_receipt_id')::uuid,(NEW.snapshot->>'series_id')::uuid,(NEW.snapshot->>'receipt_sequence')::integer)
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
   OR(NEW.original_document_id,NEW.return_id,NEW.return_receipt_id,NEW.financial_return_receipt_id,NEW.actor_id,NEW.api_key_id) IS DISTINCT FROM(p.original_document_id,p.return_id,p.return_receipt_id,p.financial_return_receipt_id,p.actor_id,p.api_key_id)
   OR NEW.request IS DISTINCT FROM jsonb_build_object('client_key',NEW.client_key,'scope_hash',p.scope_hash,'confirmed',true,'local_only',true)
   OR NEW.request_hash<>fa3_draft_hash(jsonb_build_object('preview',p.id,'request',NEW.request,'actor',NEW.actor_id,'key',NEW.api_key_id))
   OR NEW.year<>extract(year FROM(p.snapshot->>'issue_date')::date)::integer OR NEW.sequence<>n OR NEW.number IS DISTINCT FROM 'KOR-B2B/'||(p.snapshot#>>'{series_definition,prefix}')||'/'||NEW.year::text||'/'||lpad(NEW.sequence::text,6,'0')
   OR p.expires_at<=clock_timestamp() OR p.source IS DISTINCT FROM b2b_credit_basis(p.original_document_id,p.return_id) THEN RAISE EXCEPTION 'Obca/historyczna zgoda160' USING ERRCODE='23514';END IF;
   PERFORM b2b_credit_require(NEW.actor_id,NEW.api_key_id,current_setting('b2b_credit.identity_hash',true),true,false);
  ELSE
   SELECT * INTO a FROM b2b_credit_admissions WHERE(tenant_id,document_id)=(t,NEW.document_id);
   IF a.id IS NULL OR(a.root_xid,a.transaction_started_at,a.backend_pid) IS DISTINCT FROM(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid())
   OR(NEW.id,NEW.preview_id,NEW.original_document_id,NEW.return_id,NEW.return_receipt_id,NEW.financial_return_receipt_id,NEW.actor_id,NEW.api_key_id,NEW.client_key,NEW.request,NEW.request_hash,NEW.root_xid,NEW.transaction_started_at,NEW.backend_pid,NEW.year,NEW.sequence,NEW.number)
   IS DISTINCT FROM(a.id,a.preview_id,a.original_document_id,a.return_id,a.return_receipt_id,a.financial_return_receipt_id,a.actor_id,a.api_key_id,a.client_key,a.request,a.request_hash,a.root_xid,a.transaction_started_at,a.backend_pid,a.year,a.sequence,a.number)
   OR(NEW.original_receipt_id,NEW.order_id,NEW.series_id,NEW.receipt_sequence,NEW.previous_receipt_id,NEW.scope_hash) IS DISTINCT FROM(p.original_receipt_id,p.order_id,p.series_id,p.receipt_sequence,p.previous_receipt_id,p.scope_hash)
   OR NEW.snapshot IS DISTINCT FROM(p.snapshot||jsonb_build_object('number',a.number,'year',a.year,'sequence',a.sequence,'preview_id',p.id,'scope_hash',p.scope_hash)) OR NEW.calculation_hash<>p.snapshot->>'calculation_hash'
   THEN RAISE EXCEPTION 'Receipt nie odpowiada actual native issue160' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 PERFORM financial_return_credit_parent(NEW.original_document_id,NEW.return_id,NEW.return_receipt_id,NEW.financial_return_receipt_id);
 RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION b2b_credit_source_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE raw jsonb;beforej jsonb;afterj jsonb;returnkey uuid;BEGIN
 IF TG_OP<>'INSERT' THEN beforej:=to_jsonb(OLD);END IF;IF TG_OP<>'DELETE' THEN afterj:=to_jsonb(NEW);END IF;
 FOR raw IN SELECT beforej UNION ALL SELECT afterj LOOP
  IF raw IS NULL THEN CONTINUE;END IF;returnkey:=NULL;
  IF TG_TABLE_NAME='return_cases' THEN returnkey:=(raw->>'id')::uuid;
  ELSIF TG_TABLE_NAME IN('return_items','catalog_stock_return_receipts','catalog_stock_return_admissions','catalog_stock_return_documents','financial_return_admissions','financial_return_receipts') THEN returnkey:=(raw->>'return_id')::uuid;
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
CREATE TRIGGER b2b_credit_source_seal BEFORE INSERT OR UPDATE OR DELETE ON financial_return_admissions FOR EACH ROW EXECUTE FUNCTION b2b_credit_source_seal();
CREATE TRIGGER b2b_credit_source_seal BEFORE INSERT OR UPDATE OR DELETE ON financial_return_receipts FOR EACH ROW EXECUTE FUNCTION b2b_credit_source_seal();


-- WIP162 certified suffix. This must follow ALL final native DDL/ACL.
CREATE OR REPLACE FUNCTION credit_source_upgrade_valid() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE c record;tab text;sig text;BEGIN
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'financial_return_'))
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'financial_return_'))
 OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'financial_return_'))
 OR EXISTS(SELECT FROM migrations WHERE name='162_financial_return') THEN
  IF to_regprocedure('public.financial_return_upgrade_valid()') IS NULL THEN RETURN false;END IF;
  RETURN financial_return_upgrade_valid();
 END IF;
 IF current_setting('session_replication_role')<>'origin' THEN RETURN false;END IF;
 FOREACH tab IN ARRAY ARRAY['migrations','local_invoice_manifest','fa3_draft_manifest','b2b_invoice_upgrade','b2b_credit_upgrade','credit_source_upgrade_certificate'] LOOP IF to_regclass('public.'||tab) IS NULL THEN RETURN false;END IF;END LOOP;
 FOREACH sig IN ARRAY ARRAY['local_invoice_fingerprint()','fa3_draft_fingerprint()','b2b_invoice_fingerprint()','b2b_credit_fingerprint()','b2b_credit_basis(uuid,uuid)','b2b_credit_upgrade_valid()','credit_source_upgrade_context()','credit_source_upgrade_fingerprint()','credit_source_upgrade_valid()','credit_source_upgrade_guard()'] LOOP IF to_regprocedure('public.'||sig) IS NULL THEN RETURN false;END IF;END LOOP;
 IF to_regclass('public.document_order_mode') IS NULL OR to_regclass('public.document_return_mode') IS NULL THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\')<>2
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\' AND NOT((relname='credit_source_upgrade_certificate' AND relkind='r') OR(relname='credit_source_upgrade_certificate_pkey' AND relkind='i')))
 OR(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\' AND relkind IN('r','p'))<>1
 OR NOT EXISTS(SELECT FROM pg_class WHERE oid='public.credit_source_upgrade_certificate'::regclass AND relkind='r' AND relrowsecurity AND relforcerowsecurity)
 OR(SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\')<>4
 OR(SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\')<>1
 OR NOT EXISTS(SELECT FROM pg_trigger WHERE tgname='credit_source_upgrade_guard' AND tgrelid='public.credit_source_upgrade_certificate'::regclass AND tgfoid='public.credit_source_upgrade_guard()'::regprocedure AND NOT tgisinternal AND tgenabled='O' AND NOT tgdeferrable) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM migrations WHERE name='160_b2b_credit') OR(SELECT count(*) FROM credit_source_upgrade_certificate)<>1
 OR(SELECT count(*) FROM local_invoice_manifest)<>1 OR(SELECT count(*) FROM fa3_draft_manifest)<>1 OR(SELECT count(*) FROM b2b_invoice_upgrade)<>1 OR(SELECT count(*) FROM b2b_credit_upgrade)<>1 THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM migrations WHERE name='161_credit_source') AND NOT credit_source_upgrade_context() THEN RETURN false;END IF;
 SELECT * INTO c FROM credit_source_upgrade_certificate WHERE id;
 RETURN coalesce(c.profile='160-original-to161-empty-source/v1'
 AND c.original=jsonb_build_object('157',(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id),'158',(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id),'159',(SELECT to_jsonb(m) FROM b2b_invoice_upgrade m WHERE id),'160',(SELECT to_jsonb(m) FROM b2b_credit_upgrade m WHERE id))
 AND c.predecessors=jsonb_build_object('157',c.original#>>'{160,successor157}','158',c.original#>>'{160,successor158}','159',c.original#>>'{160,successor159}','160',c.original#>>'{160,successor160}')
 AND c.successors->>'157'=c.predecessors->>'157'
 AND c.successors=jsonb_build_object('157',local_invoice_fingerprint(),'158',fa3_draft_fingerprint(),'159',b2b_invoice_fingerprint(),'160',b2b_credit_fingerprint(),'161',credit_source_upgrade_fingerprint())
 AND jsonb_array_length(c.replaced_functions)=2
 AND(c.original#>'{160,original157}')=c.original->'157' AND(c.original#>'{160,original158}')=c.original->'158' AND(c.original#>'{160,original159}')=c.original->'159'
 AND c.original#>'{160,original014_indexes}'=(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indexrelid IN('public.document_order_mode'::regclass,'public.document_return_mode'::regclass)),false);
END$$;
CREATE FUNCTION financial_return_upgrade_context() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
BEGIN
 IF to_regclass('pg_temp.financial_return_migration_basis') IS NULL OR to_regclass('public.financial_return_upgrade_certificate') IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM pg_class WHERE oid=to_regclass('pg_temp.financial_return_migration_basis') AND relowner=(SELECT relowner FROM pg_class WHERE oid='public.financial_return_upgrade_certificate'::regclass)) THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM pg_temp.financial_return_migration_basis WHERE(root_xid,transaction_started_at,backend_pid,migration_owner)=(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid(),session_user::text));
END$$;
CREATE FUNCTION public.financial_return_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_object(
 'global_triggers',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY n.nspname,c.relname,tr.tgname) FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc f ON f.oid=tr.tgfoid WHERE starts_with(tr.tgname,'financial_return_') OR(f.pronamespace='public'::regnamespace AND starts_with(f.proname,'financial_return_'))),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,x.attgenerated,x.attidentity,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'financial_return_') AND c.relkind IN('r','p')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,p.proretset,p.prorettype,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.proargmodes,p.proargnames,pg_get_expr(p.proargdefaults,0),(SELECT lanname FROM pg_language WHERE oid=p.prolang),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'financial_return_'))
 )::text) $$;
-- Metadata-only final leaf; NO ancestor full guards or identity calls.
CREATE FUNCTION financial_return_upgrade_valid() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE c record;tab text;sig text;BEGIN
 IF current_setting('session_replication_role')<>'origin' THEN RETURN false;END IF;
 FOREACH tab IN ARRAY ARRAY['migrations','local_invoice_manifest','fa3_draft_manifest','b2b_invoice_upgrade','b2b_credit_upgrade','credit_source_upgrade_certificate','financial_return_admissions','financial_return_receipts','financial_return_upgrade_certificate'] LOOP IF to_regclass('public.'||tab) IS NULL THEN RETURN false;END IF;END LOOP;
 FOREACH sig IN ARRAY ARRAY['local_invoice_fingerprint()','fa3_draft_fingerprint()','b2b_invoice_fingerprint()','b2b_credit_fingerprint()','credit_source_upgrade_fingerprint()','credit_source_upgrade_valid()','b2b_credit_basis(uuid,uuid)','b2b_credit_calculate(jsonb)','b2b_credit_previous(uuid)','b2b_credit_preview(jsonb,jsonb,jsonb,uuid,uuid,text)','b2b_credit_issue(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)','b2b_credit_record_guard()','b2b_credit_source_seal()','credit_source_upgrade_valid()','financial_return_identity(uuid,uuid,text,uuid,boolean)','financial_return_original(uuid)','financial_return_physical(uuid)','financial_return_frame(uuid,uuid,text,uuid,jsonb)','financial_return_claim(uuid,uuid,text,uuid,jsonb,jsonb)','financial_return_received(uuid)','financial_return_expected(uuid)','financial_return_projection(jsonb,jsonb,jsonb)','financial_return_finish(uuid,uuid,text,uuid)','financial_return_history(uuid)','financial_return_capture(uuid,uuid,text,uuid,jsonb)','financial_return_replay(uuid,uuid,text,uuid,jsonb)','financial_return_admission_guard()','financial_return_receipt_guard()','financial_return_complete()','financial_return_source_seal()','financial_return_terminal(uuid,uuid,text,uuid[])','financial_return_credit_parent(uuid,uuid,uuid,uuid)','financial_return_upgrade_context()','financial_return_fingerprint()','financial_return_upgrade_valid()','financial_return_upgrade_guard()','financial_return_guards()'] LOOP IF to_regprocedure('public.'||sig) IS NULL THEN RETURN false;END IF;END LOOP;
 IF to_regclass('public.document_order_mode') IS NULL OR to_regclass('public.document_return_mode') IS NULL THEN RETURN false;END IF;
 IF(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'financial_return_'))<>12
 OR EXISTS(SELECT FROM pg_class relation_index WHERE relation_index.relnamespace='public'::regnamespace AND starts_with(relation_index.relname,'financial_return_') AND relation_index.relkind='i' AND NOT EXISTS(SELECT FROM pg_index ix JOIN pg_class rel ON rel.oid=ix.indrelid WHERE ix.indexrelid=relation_index.oid AND rel.relnamespace='public'::regnamespace AND rel.relname IN('financial_return_admissions','financial_return_receipts','financial_return_upgrade_certificate')))
 OR(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'financial_return_') AND relkind IN('r','p'))<>3
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'financial_return_') AND relkind IN('r','p') AND NOT(relname=ANY(ARRAY['financial_return_admissions','financial_return_receipts','financial_return_upgrade_certificate'])))
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'financial_return_') AND relkind NOT IN('r','p','i'))
 OR(SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'financial_return_'))<>23
 OR(SELECT count(*) FROM pg_trigger tr JOIN pg_proc f ON f.oid=tr.tgfoid WHERE starts_with(tr.tgname,'financial_return_') OR(f.pronamespace='public'::regnamespace AND starts_with(f.proname,'financial_return_')))<>6
 OR EXISTS(SELECT FROM(VALUES('financial_return_admission_guard','financial_return_admissions','financial_return_admission_guard()'),('financial_return_receipt_guard','financial_return_receipts','financial_return_receipt_guard()'),('financial_return_complete','financial_return_receipts','financial_return_complete()'),('financial_return_source_seal','return_cases','financial_return_source_seal()'),('financial_return_source_seal','return_items','financial_return_source_seal()'),('financial_return_upgrade_guard','financial_return_upgrade_certificate','financial_return_upgrade_guard()'))expected(name,relation,signature) WHERE NOT EXISTS(SELECT FROM pg_trigger tr WHERE tr.tgname=expected.name AND tr.tgrelid=to_regclass('public.'||expected.relation) AND tr.tgfoid=to_regprocedure('public.'||expected.signature) AND NOT tr.tgisinternal AND tr.tgenabled='O'))
 THEN RETURN false;END IF;
 IF(SELECT count(*) FROM financial_return_upgrade_certificate)<>1 OR(SELECT count(*) FROM local_invoice_manifest)<>1 OR(SELECT count(*) FROM fa3_draft_manifest)<>1 OR(SELECT count(*) FROM b2b_invoice_upgrade)<>1 OR(SELECT count(*) FROM b2b_credit_upgrade)<>1 OR(SELECT count(*) FROM credit_source_upgrade_certificate)<>1
 OR NOT EXISTS(SELECT FROM migrations WHERE name='161_credit_source') THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM migrations WHERE name='162_financial_return') AND NOT financial_return_upgrade_context() THEN RETURN false;END IF;
 SELECT * INTO c FROM financial_return_upgrade_certificate WHERE id;
 RETURN coalesce(c.profile='161-original-to162-financial-return/v1'
 AND c.original=jsonb_build_object('157',(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id),'158',(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id),'159',(SELECT to_jsonb(m) FROM b2b_invoice_upgrade m WHERE id),'160',(SELECT to_jsonb(m) FROM b2b_credit_upgrade m WHERE id),'161',(SELECT to_jsonb(m) FROM credit_source_upgrade_certificate m WHERE id))
 AND c.predecessors=c.original#>'{161,successors}'
 AND c.successors->>'157'=c.predecessors->>'157'
 AND c.successors=jsonb_build_object('157',local_invoice_fingerprint(),'158',fa3_draft_fingerprint(),'159',b2b_invoice_fingerprint(),'160',b2b_credit_fingerprint(),'161',credit_source_upgrade_fingerprint(),'162',financial_return_fingerprint())
 AND jsonb_array_length(c.replaced_functions)=8
 AND c.original014_indexes=c.original#>'{160,original014_indexes}'
 AND c.original014_indexes=(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indexrelid IN('public.document_order_mode'::regclass,'public.document_return_mode'::regclass)),false);
END$$;
CREATE FUNCTION financial_return_guards() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
BEGIN
 IF to_regprocedure('public.financial_return_upgrade_valid()') IS NULL THEN RETURN false;END IF;
 RETURN financial_return_upgrade_valid();
END$$;
CREATE FUNCTION financial_return_upgrade_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE b record;BEGIN
 IF TG_OP<>'INSERT' OR NOT financial_return_upgrade_context() THEN RAISE EXCEPTION 'Immutable certified162 successor' USING ERRCODE='23514';END IF;
 SELECT * INTO b FROM pg_temp.financial_return_migration_basis;
 IF(NEW.original,NEW.predecessors,NEW.replaced_functions,NEW.original014_indexes) IS DISTINCT FROM(b.original,b.predecessors,b.replaced_functions,b.original014_indexes)
 OR NEW.successors IS DISTINCT FROM jsonb_build_object('157',local_invoice_fingerprint(),'158',fa3_draft_fingerprint(),'159',b2b_invoice_fingerprint(),'160',b2b_credit_fingerprint(),'161',credit_source_upgrade_fingerprint(),'162',financial_return_fingerprint()) OR NEW.successors->>'157' IS DISTINCT FROM NEW.predecessors->>'157' THEN RAISE EXCEPTION '162 certificate differs from exact predecessor owner transcript' USING ERRCODE='55000';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER financial_return_upgrade_guard BEFORE INSERT OR UPDATE OR DELETE ON financial_return_upgrade_certificate FOR EACH ROW EXECUTE FUNCTION financial_return_upgrade_guard();
DO $$DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'financial_return_') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);END LOOP;END$$;
GRANT EXECUTE ON FUNCTION financial_return_terminal(uuid,uuid,text,uuid[]) TO dyna_app;
INSERT INTO financial_return_upgrade_certificate(profile,original,predecessors,replaced_functions,original014_indexes,successors)
 SELECT '161-original-to162-financial-return/v1',original,predecessors,replaced_functions,original014_indexes,jsonb_build_object('157',local_invoice_fingerprint(),'158',fa3_draft_fingerprint(),'159',b2b_invoice_fingerprint(),'160',b2b_credit_fingerprint(),'161',credit_source_upgrade_fingerprint(),'162',financial_return_fingerprint()) FROM pg_temp.financial_return_migration_basis;
DO $$BEGIN IF NOT financial_return_guards() OR NOT credit_source_upgrade_valid() OR NOT b2b_credit_guards() OR NOT b2b_invoice_guards() OR NOT fa3_draft_guards() OR NOT local_invoice_guards() OR NOT catalog_stock_return_guards() THEN RAISE EXCEPTION 'Complete162 certified successor refused' USING ERRCODE='55000';END IF;END$$;
