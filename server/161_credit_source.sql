-- NEW staged successor161. No installed manifest/certificate reseed.
-- Root applies only after exact base1609e source pins and source-peer acceptance.
SET LOCAL TimeZone='UTC';
DO $$BEGIN
 IF NOT b2b_credit_guards() OR NOT b2b_invoice_guards() OR NOT fa3_draft_guards() OR NOT local_invoice_guards()
 OR EXISTS(SELECT FROM migrations WHERE name='161_credit_source')
 OR EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\')
 OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\')
 OR EXISTS(SELECT FROM pg_trigger WHERE tgname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\') THEN RAISE EXCEPTION '161 requires genuine complete160 and no successor remnants' USING ERRCODE='55000';END IF;
END$$;
CREATE TEMP TABLE credit_source_upgrade_basis ON COMMIT DROP AS
 SELECT pg_current_xact_id() root_xid,transaction_timestamp() transaction_started_at,pg_backend_pid() backend_pid,session_user::text migration_owner,
 jsonb_build_object('157',(SELECT to_jsonb(m) FROM local_invoice_manifest m WHERE id),'158',(SELECT to_jsonb(m) FROM fa3_draft_manifest m WHERE id),'159',(SELECT to_jsonb(m) FROM b2b_invoice_upgrade m WHERE id),'160',(SELECT to_jsonb(m) FROM b2b_credit_upgrade m WHERE id)) original,
 jsonb_build_object('157',local_invoice_fingerprint(),'158',fa3_draft_fingerprint(),'159',b2b_invoice_fingerprint(),'160',b2b_credit_fingerprint()) predecessors,
 (SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'source_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,'retset',p.proretset,'return',pg_get_function_result(p.oid),'arguments',pg_get_function_identity_arguments(p.oid),'modes',p.proargmodes,'names',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0),'language',(SELECT lanname FROM pg_language WHERE oid=p.prolang),'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.privilege_type,a.grantor,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN('public.b2b_credit_basis(uuid,uuid)'::regprocedure,'public.b2b_credit_upgrade_valid()'::regprocedure)) replaced_functions;
CREATE TABLE credit_source_upgrade_certificate(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),profile text NOT NULL CHECK(profile='160-original-to161-empty-source/v1'),
 original jsonb NOT NULL,predecessors jsonb NOT NULL,replaced_functions jsonb NOT NULL,successors jsonb NOT NULL,
 installed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CHECK(octet_length(original::text)+octet_length(replaced_functions::text)<=1048576));
ALTER TABLE credit_source_upgrade_certificate ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_source_upgrade_certificate FORCE ROW LEVEL SECURITY;
REVOKE ALL ON credit_source_upgrade_certificate FROM PUBLIC,dyna_app;

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
  IF raw IS NULL THEN RAISE EXCEPTION 'Brak immutable physical169receipt' USING ERRCODE='23514';END IF;
  raw:=raw||jsonb_build_object('physical',b2b_credit_physical((raw#>>'{receipt,id}')::uuid));
  financial:=jsonb_build_object('tenant_id',t,'order_id',d.order_id,'return_id',rr.id,'number',raw#>'{receipt,snapshot,return_case,number}','receipt_sequence',rr.receipt_sequence,
   'kind',raw#>'{receipt,snapshot,return_case,kind}','received_state','refund_pending','remedy','refund','legacy',raw#>'{receipt,snapshot,return_case,legacy}','acceptance_kind','physical',
   'received_at',raw#>'{receipt,snapshot,return_case,received_at}','refund_amount_minor',(raw#>>'{receipt,snapshot,return_case,refund_amount}')::bigint::text,'refunded_shipping_minor',(raw#>>'{receipt,snapshot,return_case,refunded_shipping}')::bigint::text,
   'items',(SELECT jsonb_agg(jsonb_build_object('item_id',v->'item_id','accepted',(v->>'accepted')::bigint::text,'restocked',(v->>'restocked')::bigint::text,'refund_amount_minor',(v->>'refund_amount')::bigint::text) ORDER BY v->>'item_id') FROM jsonb_array_elements(raw#>'{receipt,snapshot,items}') v));
  acceptances:=acceptances||jsonb_build_array(financial||jsonb_build_object('native_proof',jsonb_build_object('kind','catalog_stock_return169','receipt_id',raw#>'{receipt,id}','admission_id',raw#>'{admission,id}','receipt_snapshot_hash',fa3_draft_hash(raw#>'{receipt,snapshot}'),'financial_hash',fa3_draft_hash(financial))));history:=history||jsonb_build_array(raw);
 END LOOP;
 IF EXISTS(SELECT FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=(t,d.order_id) AND rc.received_at IS NULL AND b2b_dropship_return_acceptance(rc.id) IS NOT NULL) THEN RAISE EXCEPTION 'Unsupported partner fullhistory160' USING ERRCODE='23514';END IF;
 IF seq=0 AND selected_return IS NOT NULL THEN RAISE EXCEPTION 'Selected correction requires accepted169history' USING ERRCODE='23514';END IF;
 FOR cr IN SELECT r.*,to_jsonb(dc) doc FROM b2b_credit_receipts r JOIN documents dc ON(dc.tenant_id,dc.id)=(r.tenant_id,r.document_id) WHERE(r.tenant_id,r.original_document_id)=(t,did) AND NOT(r.root_xid=pg_current_xact_id() AND r.transaction_started_at=transaction_timestamp() AND r.backend_pid=pg_backend_pid()) ORDER BY r.receipt_sequence,r.id LOOP
  PERFORM b2b_credit_previous(cr.document_id);
  IF cr.previous_receipt_id IS DISTINCT FROM prev OR cr.receipt_sequence<>jsonb_array_length(previousj)+1 OR cr.snapshot IS DISTINCT FROM cr.doc->'data' OR cr.doc->>'mode'<>'b2b_correction' OR cr.doc->>'kind'<>'correction' OR cr.doc->>'return_id'<>cr.return_id::text THEN RAISE EXCEPTION 'Spliced nativeprevious160receipt' USING ERRCODE='23514';END IF;
  previousj:=previousj||jsonb_build_array(jsonb_build_object('document_id',cr.document_id,'receipt_id',cr.id,'original_document_id',cr.original_document_id,'original_receipt_id',cr.original_receipt_id,'return_id',cr.return_id,'return_receipt_id',cr.return_receipt_id,'receipt_sequence',cr.receipt_sequence,'calculation',cr.snapshot->'calculation','calculation_hash',cr.calculation_hash));prev:=cr.id;creditsj:=creditsj||jsonb_build_array(to_jsonb(cr));
 END LOOP;
 IF seq=0 AND(jsonb_array_length(previousj)<>0 OR jsonb_array_length(creditsj)<>0 OR EXISTS(SELECT FROM b2b_credit_receipts WHERE(tenant_id,original_document_id)=(t,did)) OR EXISTS(SELECT FROM b2b_credit_admissions WHERE(tenant_id,original_document_id)=(t,did)) OR EXISTS(SELECT FROM documents WHERE(tenant_id,order_id)=(t,d.order_id) AND kind='correction')) THEN RAISE EXCEPTION 'Credits without accepted169history' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM orders o WHERE(o.tenant_id,o.id)=(t,d.order_id) AND o.currency<>'PLN') THEN RAISE EXCEPTION 'Zmieniona waluta źródła' USING ERRCODE='23514';END IF;
 inputj:=jsonb_build_object('original',original,'acceptance_manifest',jsonb_build_object('count',jsonb_array_length(acceptances),'financial_history_hash',fa3_draft_hash(acceptances)),'acceptances',acceptances,'previous_credits',previousj,'selected_return_id',selected_return,'shipping_credit_scope','native_refunded_shipping_value_only');
 raw:=jsonb_build_object('original',jsonb_build_object('document',to_jsonb(d),'receipt',to_jsonb(ir),'preview',to_jsonb(p),'admission',to_jsonb(ad),'project',to_jsonb(project),'project_receipt',to_jsonb(projectreceipt),'source_preview',to_jsonb(projectpreview),'series',to_jsonb(s),'series_command',to_jsonb(cmd)),'returns',history,'credits',creditsj,'input',inputj);
 IF octet_length(raw::text)>33554432 THEN RAISE EXCEPTION 'Pełne źródło160 przekracza32MiB' USING ERRCODE='54000';END IF;RETURN raw;
END$$;

CREATE OR REPLACE FUNCTION b2b_credit_upgrade_valid() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE c record;sig text;tab text;BEGIN
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\') OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\') OR EXISTS(SELECT FROM pg_trigger WHERE tgname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\') OR EXISTS(SELECT FROM migrations WHERE name='161_credit_source') THEN
  IF to_regprocedure('public.credit_source_upgrade_valid()') IS NULL THEN RETURN false;END IF;RETURN credit_source_upgrade_valid();
 END IF;
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

CREATE FUNCTION credit_source_upgrade_context() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF to_regclass('pg_temp.credit_source_upgrade_basis') IS NULL OR to_regclass('public.credit_source_upgrade_certificate') IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM pg_class WHERE oid=to_regclass('pg_temp.credit_source_upgrade_basis') AND relowner=(SELECT relowner FROM pg_class WHERE oid='public.credit_source_upgrade_certificate'::regclass)) THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM pg_temp.credit_source_upgrade_basis WHERE(root_xid,transaction_started_at,backend_pid,migration_owner)=(pg_current_xact_id(),transaction_timestamp(),pg_backend_pid(),session_user::text));
END$$;

CREATE FUNCTION public.credit_source_upgrade_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
 'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a),
 'cols',(SELECT jsonb_agg(jsonb_build_array(x.attname,format_type(x.atttypid,x.atttypmod),x.attnotnull,x.attgenerated,x.attidentity,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(ca.grantor),CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,ca.is_grantable) ORDER BY CASE WHEN ca.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ca.grantee)::text END,ca.privilege_type,pg_get_userbyid(ca.grantor)::text,ca.is_grantable) FROM aclexplode(x.attacl)ca),pg_get_expr(d.adbin,d.adrelid)) ORDER BY x.attnum) FROM pg_attribute x LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(x.attrelid,x.attnum) WHERE x.attrelid=c.oid AND x.attnum>0 AND NOT x.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid,true)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'policies',(SELECT jsonb_agg(jsonb_build_array(po.polname,(SELECT array_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END ORDER BY CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END) FROM unnest(po.polroles)x),po.polcmd,pg_get_expr(po.polqual,po.polrelid),pg_get_expr(po.polwithcheck,po.polrelid)) ORDER BY po.polname) FROM pg_policy po WHERE po.polrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(tr.tgname,tr.tgenabled,pg_get_triggerdef(tr.oid,true)) ORDER BY tr.tgname) FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname='credit_source_upgrade_certificate' AND c.relkind IN('r','p')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.prokind,p.proretset,p.prorettype,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),p.proargmodes,p.proargnames,pg_get_expr(p.proargdefaults,0),(SELECT lanname FROM pg_language WHERE oid=p.prolang),(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,a.privilege_type,pg_get_userbyid(a.grantor)::text,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\')
 )::text) $$;

-- Metadata-only leaf: fingerprints inspect catalog metadata, never call guards.
CREATE FUNCTION credit_source_upgrade_valid() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE c record;tab text;sig text;BEGIN
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
CREATE FUNCTION credit_source_upgrade_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE b record;BEGIN
 IF TG_OP<>'INSERT' OR NOT credit_source_upgrade_context() THEN RAISE EXCEPTION 'Immutable certified161 receipt' USING ERRCODE='23514';END IF;
 SELECT * INTO b FROM pg_temp.credit_source_upgrade_basis;
 IF(NEW.original,NEW.predecessors,NEW.replaced_functions) IS DISTINCT FROM(b.original,b.predecessors,b.replaced_functions)
 OR NEW.successors IS DISTINCT FROM jsonb_build_object('157',local_invoice_fingerprint(),'158',fa3_draft_fingerprint(),'159',b2b_invoice_fingerprint(),'160',b2b_credit_fingerprint(),'161',credit_source_upgrade_fingerprint())
 OR NEW.successors->>'157' IS DISTINCT FROM NEW.predecessors->>'157' THEN RAISE EXCEPTION '161 certificate differs from native owner transcript' USING ERRCODE='55000';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER credit_source_upgrade_guard BEFORE INSERT OR UPDATE OR DELETE ON credit_source_upgrade_certificate FOR EACH ROW EXECUTE FUNCTION credit_source_upgrade_guard();
DO $$DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'credit\_source\_upgrade\_%' ESCAPE '\' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',f.signature);END LOOP;END$$;
INSERT INTO credit_source_upgrade_certificate(profile,original,predecessors,replaced_functions,successors)
 SELECT '160-original-to161-empty-source/v1',original,predecessors,replaced_functions,jsonb_build_object('157',local_invoice_fingerprint(),'158',fa3_draft_fingerprint(),'159',b2b_invoice_fingerprint(),'160',b2b_credit_fingerprint(),'161',credit_source_upgrade_fingerprint()) FROM pg_temp.credit_source_upgrade_basis;
DO $$BEGIN IF NOT credit_source_upgrade_valid() OR NOT b2b_credit_guards() OR NOT b2b_invoice_guards() OR NOT fa3_draft_guards() OR NOT local_invoice_guards() THEN RAISE EXCEPTION '161 complete successor validation refused' USING ERRCODE='55000';END IF;END$$;
