/** Closed source211 derivation only. No PG, network, runtime import or activation. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RECORDS_SQL} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {RETURN_CREDIT207_SOURCE_CONTRACT as E207} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const RETURN_CREDIT211_PREDECESSORS=freeze({
 source148:{bytes:130438,sha256:'286c07846c2c71176d291eec21c40b1bf32a7d2faa8b155ecf408a2d080c60f1'},
 source206:{bytes:31474,sha256:'1c79cbeaff631408370dd9908e73fb092d8e5ca4bf86a874e91072e9f0388bd4'},
 source207:{bytes:87955,sha256:'8abe73aec97e294860f918c7285c016444fce15322bf03148926f41041076172'}
});
const REBINDINGS=freeze([{"before":"CREATE FUNCTION return_destination_physical_validate(eid uuid)","after":"CREATE FUNCTION public.return_credit211_frozen_physical(eid uuid)"},{"before":" SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id,transaction_id,backend_pid)=(t,eid,pg_current_xact_id(),pg_backend_pid());","after":" IF session_user<>'postgres' OR current_user<>'postgres' OR t IS NULL OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION '211 owner tenant origin required' USING ERRCODE='42501';END IF;\n SELECT * INTO a FROM public.return_destination_admissions WHERE(tenant_id,receipt_id)=(t,eid);"},{"before":" IF a.receipt_id IS NULL OR a.before_snapshot='{}' THEN RAISE EXCEPTION 'Fizyka wymaga rzeczywistej bieżącej zgody' USING ERRCODE='23514';END IF;","after":" IF a.receipt_id IS NULL OR a.before_snapshot='{}' OR a.after_snapshot IS NULL OR a.transaction_id=pg_current_xact_id() OR a.payload->>'action' IS DISTINCT FROM 'receive' OR a.payload#>>'{snapshot,protocol}' IS DISTINCT FROM 'destinations_v1' THEN RAISE EXCEPTION '211 completed historical receive148 required' USING ERRCODE='23514';END IF;"},{"before":" cur:=public.return_destination_snapshot(eid);\n SELECT * INTO rc FROM public.return_cases WHERE(tenant_id,id)=(t,a.return_id);","after":" cur:=a.after_snapshot;\n SELECT expanded.* INTO rc FROM jsonb_array_elements(cur->'return_cases')entry CROSS JOIN LATERAL jsonb_populate_record(NULL::public.return_cases,entry)expanded WHERE entry->>'id'=a.return_id::text;"},{"before":"rc.received_at<transaction_timestamp()","after":"rc.received_at>(SELECT received_birth.created_at FROM public.return_assistant_receipts received_birth WHERE(received_birth.tenant_id,received_birth.id)=(t,eid))"},{"before":" SELECT bool_and(oi.quantity=(SELECT coalesce(sum(ri.accepted),0) FROM public.return_items ri JOIN public.return_cases rr ON(rr.tenant_id,rr.id)=(ri.tenant_id,ri.return_id) WHERE(ri.tenant_id,ri.order_id,ri.item_id)=(oi.tenant_id,oi.order_id,oi.id) AND rr.state IN('refund_pending','closed'))) INTO all_accepted FROM public.order_items oi WHERE(oi.tenant_id,oi.order_id)=(t,a.order_id);","after":" SELECT bool_and((oi->>'quantity')::bigint=(SELECT coalesce(sum((ri->>'accepted')::bigint),0) FROM jsonb_array_elements(cur->'return_items')ri JOIN jsonb_array_elements(cur->'return_cases')rr ON rr->>'id'=ri->>'return_id' WHERE ri->>'order_id'=a.order_id::text AND ri->>'item_id'=oi->>'id' AND rr->>'state' IN('refund_pending','closed'))) INTO all_accepted FROM jsonb_array_elements(cur->'order_items')oi;"},{"before":" FOR cell IN SELECT value FROM jsonb_array_elements(a.payload->'plan'->'parts') LOOP\n  IF NOT EXISTS(SELECT 1 FROM public.return_destination_statuses h JOIN public.return_destination_status_revisions v ON(v.tenant_id,v.status_id,v.id,v.version)=(h.tenant_id,h.id,h.revision_id,h.version) WHERE(h.tenant_id,h.id,h.version,h.revision_id)=(t,(cell->'status'->>'status_id')::uuid,(cell->'status'->>'version')::bigint,(cell->'status'->>'revision_id')::uuid)) THEN RAISE EXCEPTION 'Status części zmienił się po zgodzie' USING ERRCODE='23514';END IF;\n END LOOP;\n FOR cell IN SELECT value FROM jsonb_array_elements(a.payload->'plan'->'stock_effects') LOOP\n  expected:=public.warehouse_inventory_policy(t,(cell->>'warehouse_id')::uuid);\n  IF expected->'enabled' IS DISTINCT FROM 'true'::jsonb OR expected->>'usage' IS DISTINCT FROM cell->>'effect' OR expected->>'version' IS DISTINCT FROM(SELECT x->'status'->>'warehouse_policy_version' FROM jsonb_array_elements(a.payload->'plan'->'parts')x WHERE x->'status'->>'warehouse_id'=cell->>'warehouse_id' LIMIT 1)\n  OR NOT EXISTS(SELECT 1 FROM public.products p JOIN public.product_catalog_warehouses cw ON(cw.tenant_id,cw.catalog_id)=(p.tenant_id,p.catalog_id) WHERE(p.tenant_id,p.id,cw.warehouse_id)=(t,(cell->>'product_id')::uuid,(cell->>'warehouse_id')::uuid)) THEN RAISE EXCEPTION 'Polityka lub katalog docelowego składnika zmienił się' USING ERRCODE='23514';END IF;\n END LOOP;\n","after":" -- Current policy/status/catalogue state is not replayed. history148 authenticates\n -- the immutable revision and recomputes the original plan before this call.\n"},{"before":"  IF EXISTS(SELECT 1 FROM public.wms_issue_fragments f WHERE(f.tenant_id,f.order_id)=(t,a.order_id) AND(SELECT coalesce(sum(r.quantity),0) FROM public.wms_return_fragments r WHERE(r.tenant_id,r.issue_fragment_id)=(t,f.id))>f.quantity) THEN RAISE EXCEPTION 'SALE i CUSTODY przekraczają wspólny fragment wydania' USING ERRCODE='23514';END IF;","after":"  IF EXISTS(SELECT 1 FROM jsonb_array_elements(cur->'wms_issue_fragments')f WHERE(SELECT coalesce(sum((r->>'quantity')::bigint),0) FROM jsonb_array_elements(cur->'wms_return_fragments')r WHERE r->>'issue_fragment_id'=f->>'id')>(f->>'quantity')::bigint) THEN RAISE EXCEPTION '211 frozen SALE and CUSTODY exceed original issue fragment' USING ERRCODE='23514';END IF;"}]);
export function deriveReturnCredit211FrozenPhysical(source148){
 assert.equal(arguments.length,1);assert.equal(typeof source148,'string');
 assert.equal(Buffer.byteLength(source148),RETURN_CREDIT211_PREDECESSORS.source148.bytes,'source211 whole148 bytes');
 assert.equal(hash(source148),RETURN_CREDIT211_PREDECESSORS.source148.sha256,'source211 whole148 source pin');
 const start=source148.indexOf('CREATE FUNCTION return_destination_physical_validate(');
 assert(start>=0);const end=source148.indexOf('\nEND $$;',start);assert(end>start);
 const original=source148.slice(start,end+'\nEND $$;'.length);let sql=original;const edits=[];
 for(const {before,after} of REBINDINGS){assert.equal(sql.split(before).length,2,'source211 exact one authored anchor');const at=sql.indexOf(before);edits.push({beforeStart:at,afterStart:at,before,after});sql=sql.slice(0,at)+after+sql.slice(at+before.length);}
 let inverse=sql;for(const edit of [...edits].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);}
 assert.equal(inverse,original,'source211 full historical physical inverse');
 assert(!sql.includes('return_destination_snapshot(eid)'),'source211 no current stock snapshot');
 assert(!sql.includes('public.warehouse_inventory_policy('),'source211 no current warehouse policy');
 assert(!sql.includes('public.return_destination_statuses '),'source211 no current mutable status');
 return freeze({schema:'return-credit211-frozen-physical-source/v1',sql,edits,
 original:{bytes:Buffer.byteLength(original),sha256:hash(original)},derived:{bytes:Buffer.byteLength(sql),sha256:hash(sql)},
 whole_function_inverse_proven:true,source_compilation_performed:false,pg_calls:0,native_acceptance:false,application_activation:false});
}

const BUSINESS_REBINDINGS=freeze([{"beforeStart":347,"afterStart":347,"before":"financial jsonb;inspection_row record;","after":"financial jsonb;acceptance211 jsonb;inspection_row record;"},{"beforeStart":1417,"afterStart":1417,"before":"rejected_admission.payload->>'action'='reject'","after":"rejected_admission.payload->>'action' IN('receive','reject')"},{"beforeStart":3885,"afterStart":3885,"before":"WHERE(da.tenant_id,da.order_id)=(t,o.id) AND da.payload->>'action'='reject')>33554432","after":"WHERE(da.tenant_id,da.order_id)=(t,o.id) AND da.payload->>'action' IN('receive','reject'))+(SELECT coalesce(sum(pg_column_size(parent211)),0) FROM public.return_credit211_acceptances parent211 WHERE(parent211.tenant_id,parent211.order_id)=(t,o.id))>33554432"},{"beforeStart":5407,"afterStart":5407,"before":"  SELECT * INTO rr FROM public.catalog_stock_return_receipts WHERE(tenant_id,return_id,order_id)=(t,rc.id,o.id);\n  IF rr.id IS NULL THEN RAISE EXCEPTION 'Brak actual physical169 receipt207' USING ERRCODE='23514';END IF;\n  PERFORM public.return_credit206_physical_history(rr.id);\n  protocols:=protocols||jsonb_build_array(jsonb_build_object('return_id',rc.id,'receipt_id',rr.id,'protocol',(SELECT protocol FROM public.catalog_stock_return_admissions WHERE(tenant_id,id)=(t,rr.id))));\n  financial:=jsonb_build_object('return_id',rc.id,'receipt_id',rr.id,'receipt_sequence',rc.receipt_sequence,\n   'received_at',to_char((rr.snapshot#>>'{return_case,received_at}')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),\n   'refund_amount_minor',rr.snapshot#>>'{return_case,refund_amount}','refunded_shipping_minor',rr.snapshot#>>'{return_case,refunded_shipping}',\n   'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',x->'item_id','accepted',(x->>'accepted')::bigint::text,'restocked',(x->>'restocked')::bigint::text,'refund_amount_minor',(x->>'refund_amount')::bigint::text) ORDER BY x->>'item_id'),'[]') FROM jsonb_array_elements(rr.snapshot->'items')x));\n  acceptances:=acceptances||jsonb_build_array(financial||jsonb_build_object('financial_hash',public.return_credit206_hash(financial)));","after":"  acceptance211:=public.return_credit211_acceptance(o.id,rc.id);\n  IF(acceptance211->>'return_id',acceptance211->>'order_id',acceptance211->>'receipt_sequence') IS DISTINCT FROM(rc.id::text,o.id::text,rc.receipt_sequence::text) THEN\n   RAISE EXCEPTION '211 full original native acceptance sequence differs' USING ERRCODE='23514';END IF;\n  protocols:=protocols||jsonb_build_array(jsonb_build_object('return_id',rc.id,'receipt_id',acceptance211->'id','protocol',acceptance211->'protocol'));\n  financial:=acceptance211->'financial';\n  IF financial->>'financial_hash' IS DISTINCT FROM public.return_credit206_hash(financial-'financial_hash') THEN\n   RAISE EXCEPTION '211 original acceptance financial hash differs' USING ERRCODE='23514';END IF;\n  acceptances:=acceptances||jsonb_build_array(financial);"}]);
const ISSUE_REBINDING=freeze({"beforeStart":3534,"afterStart":3534,"before":" INSERT INTO return_credit206_admissions VALUES(eid,t,did,p.id,uid,kid,(b->>'client_key')::uuid,h,num,yr,seq,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid());","after":" INSERT INTO return_credit206_admissions VALUES(eid,t,did,p.id,uid,kid,(b->>'client_key')::uuid,h,num,yr,seq,pg_current_xact_id(),transaction_timestamp(),pg_backend_pid());\n PERFORM public.return_credit211_ensure_parent(eid);"});
const literalFunction=(source,name)=>{const start=source.indexOf('CREATE FUNCTION public.'+name+'(');assert(start>=0);const open=source.indexOf(' AS $$',start);assert(open>start);const end=source.indexOf('$$;',open+6);assert(end>open);return source.slice(start,end+'$$;'.length);};
function derivePort(original,rebindings){let sql=original;const edits=[];
 for(const {before,after}of rebindings){assert.equal(sql.split(before).length,2,'source211 exact business anchor');const at=sql.indexOf(before);edits.push({beforeStart:at,afterStart:at,before,after});sql=sql.slice(0,at)+after+sql.slice(at+before.length);}
 let inverse=sql;for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}assert.equal(inverse,original,'source211 complete port inverse');
 return{before:original,after:sql,edits,before_sha256:hash(original),after_sha256:hash(sql),whole_function_inverse_proven:true};
}
/** Two complete source-derived ports. No caller SQL callbacks, runtime rows or modes. */
export function deriveReturnCredit211BusinessPorts(source207){
 assert.equal(arguments.length,1);assert.equal(typeof source207,'string');assert.equal(Buffer.byteLength(source207),RETURN_CREDIT211_PREDECESSORS.source207.bytes);assert.equal(hash(source207),RETURN_CREDIT211_PREDECESSORS.source207.sha256,'source211 whole207 source pin');
 const source=derivePort(literalFunction(source207,'return_credit206_source'),BUSINESS_REBINDINGS);
 const issue=derivePort(literalFunction(source207,'return_credit206_issue'),[ISSUE_REBINDING]);
 // v2 money/protocol/physical hashes remain literal. The actual native reader,
 // rather than a browser claim, authenticates each concrete148/169 family.
 assert.equal(source.after.split("'schema','consumer-return-credit-source/v2'").length,2);
 assert.equal(issue.after.indexOf('return_credit211_ensure_parent(eid)'),issue.after.indexOf(ISSUE_REBINDING.after)+ISSUE_REBINDING.after.indexOf('return_credit211_ensure_parent(eid)'));
 return freeze({schema:'return-credit211-business-ports/v1',changes:[{key:'public.return_credit206_source(did uuid, selected_return uuid)',...source},{key:'public.return_credit206_issue(pid uuid, b jsonb, uid uuid, kid uuid)',...issue}],
 source_compilation_performed:false,pg_calls:0,native_acceptance:false,application_activation:false,business_acceptance:false});
}

export const RETURN_CREDIT211_PHYSICAL_FK=freeze({
 key:'public.return_credit206_receipts.return_credit206_receipts_tenant_id_return_receipt_id_fkey',
 before:{deferrable:false,deferred:false,definition:'FOREIGN KEY (tenant_id, return_receipt_id) REFERENCES catalog_stock_return_receipts(tenant_id, id)',inheritance_count:0,kind:'f',local:true,no_inherit:true,validated:true},
 after:{deferrable:false,deferred:false,definition:'FOREIGN KEY (tenant_id, return_receipt_id) REFERENCES return_credit211_acceptances(tenant_id, id)',inheritance_count:0,kind:'f',local:true,no_inherit:true,validated:true}
});
/** One exact FK successor; historical child rows/ids and the188 FK are unchanged.
 * Own new RI triggers must be included by the later complete Native catalogue
 * compiler. This source plan alone is not a sealed executable migration. */
export function deriveReturnCredit211ForwardPlan(source207){
 assert.equal(arguments.length,1);const ports=deriveReturnCredit211BusinessPorts(source207);const metadata=deriveReturnCredit211MetadataProjection(source207);const changes=[...ports.changes,metadata.fingerprint_change];
 const f=RETURN_CREDIT211_PHYSICAL_FK;
 const fkSql=`DO $fk211$ DECLARE observed jsonb; BEGIN
 SELECT jsonb_build_object('deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid,true),
  'inheritance_count',c.coninhcount,'kind',c.contype,'local',c.conislocal,'no_inherit',c.connoinherit,'validated',c.convalidated)
 INTO observed FROM pg_constraint c WHERE c.conrelid='public.return_credit206_receipts'::regclass
 AND c.conname='return_credit206_receipts_tenant_id_return_receipt_id_fkey';
 IF observed IS DISTINCT FROM '${JSON.stringify(f.before)}'::jsonb THEN RAISE EXCEPTION '211 exact old169 FK required' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM public.return_credit206_receipts r LEFT JOIN public.return_credit211_acceptances a
 ON(a.tenant_id,a.id,a.order_id,a.return_id,a.receipt_sequence)=(r.tenant_id,r.return_receipt_id,r.order_id,r.return_id,r.receipt_sequence)
 WHERE a.id IS NULL OR a.family<>'catalog169' OR a.catalog_receipt_id IS DISTINCT FROM r.return_receipt_id) THEN
 RAISE EXCEPTION '211 all original206 FK rows need authenticated historical169 parents' USING ERRCODE='23514';END IF;
 ALTER TABLE public.return_credit206_receipts DROP CONSTRAINT return_credit206_receipts_tenant_id_return_receipt_id_fkey;
 ALTER TABLE public.return_credit206_receipts ADD CONSTRAINT return_credit206_receipts_tenant_id_return_receipt_id_fkey
 FOREIGN KEY(tenant_id,return_receipt_id) REFERENCES public.return_credit211_acceptances(tenant_id,id);
END $fk211$;`;
 return freeze({schema:'return-credit211-forward-source-plan/v1',migration:{name:'211_return_credit148_acceptance',file:'211_return_credit148_acceptance.sql',parent:209,installs_split210:false},
 function_changes:changes,constraint_change:f,metadata_sql:metadata.sql,descriptor_changes:metadata.descriptor_changes,removed_records:metadata.removed_records,seal_insert_emitted:false,forward_sql:changes.map(c=>c.after.replace('CREATE FUNCTION ','CREATE OR REPLACE FUNCTION ')).join('\n')+'\n'+fkSql,
 required_integration:['independently-source-compiled211-own-and-external-vector-literal-seal','finite211-before209-cold-and-runtime-projectors','native-profile-resource-and-migration-registration','full-native-and-preserved-current-RMA-UI-API-acceptance'],
 source_compilation_performed:false,pg_calls:0,installation_ready:false,native_acceptance:false,application_activation:false,business_acceptance:false});
}

const RECORDS_PIN='9e4494ccf86c39990d235fad4e6d6b073caa61c3bcc3eda06a297600d80baef7';
const SELECTED_FUNCTIONS=freeze(['public.return_credit206_source(did uuid, selected_return uuid)','public.return_credit206_issue(pid uuid, b jsonb, uid uuid, kid uuid)','public.return_credit206_fingerprint()']);
const quote=v=>"'"+v.replaceAll("'","''")+"'";
const once=(s,b,a)=>{assert.equal(s.split(b).length,2,'source211 unique projection anchor');return s.replace(b,()=>a);};
function recordArm(kind){assert.equal(hash(RECORDS_SQL),RECORDS_PIN);const rows=RECORDS_SQL.split('\n').filter(s=>s.startsWith(" UNION ALL SELECT '"+kind+"',"));assert.equal(rows.length,1);return rows[0].replace(/^ UNION ALL /,'');}
function owned211Records(){
 const arms=['relation','column','constraint','index','policy','trigger','function','type'].map(kind=>{
  let s=recordArm(kind);
  if(kind==='constraint')s=once(s,"WHERE n.nspname IN ('public','ordinary187_private')","WHERE k.conrelid IN(SELECT oid FROM rels) OR(n.nspname='public' AND starts_with(k.conname,'return_credit211_'))");
  if(kind==='trigger')s=once(s,'WHERE t.tgrelid IN(SELECT oid FROM rels)',"WHERE t.tgrelid IN(SELECT oid FROM rels) OR starts_with(t.tgname,'return_credit211_') OR t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))");
  if(kind==='function')s=once(s,"WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND starts_with(p.proname,'return_credit211_')");
  if(kind==='type')s=once(s,"WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND(starts_with(t.typname,'return_credit211_') OR starts_with(t.typname,'_return_credit211_'))");
  return s;
 });
 return "WITH rels AS MATERIALIZED(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'return_credit211_')),entries(kind,key,value) AS(\n"+arms.join('\n UNION ALL ')+'\n) SELECT jsonb_build_object(\'kind\',kind,\'key\',key,\'value\',value) record FROM entries';
}
function external211Records(){
 const f=once(recordArm('function'),"WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND p.proname=ANY(ARRAY['return_credit206_source','return_credit206_issue','return_credit206_fingerprint'])");
 const c=once(recordArm('constraint'),"WHERE n.nspname IN ('public','ordinary187_private')","WHERE k.conrelid='public.return_credit206_receipts'::regclass AND k.conname='return_credit206_receipts_tenant_id_return_receipt_id_fkey'");
 const t=once(recordArm('trigger'),'WHERE t.tgrelid IN(SELECT oid FROM rels)',"WHERE t.tgrelid='public.return_credit206_receipts'::regclass AND k.conname='return_credit206_receipts_tenant_id_return_receipt_id_fkey'");
 return 'WITH entries(kind,key,value) AS(\n'+[f,c,t].join('\n UNION ALL ')+"\n) SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries";
}
/** Acyclic structural metadata gate. A missing row is refused. The separate
 * Native/cold contract must authorize a literal independently compiled full vector
 * before insertion: a stored row or compiler-hash shape alone is not provenance.
 * No current-catalogue expectation, historical reseal or seal INSERT is emitted. */
export function deriveReturnCredit211MetadataProjection(source207){
 assert.equal(arguments.length,1);deriveReturnCredit211BusinessPorts(source207);
 const before=literalFunction(source207,'return_credit206_fingerprint');let after=before;
 const edits=[];const edit=(b,a)=>{const at=after.indexOf(b);after=once(after,b,a);edits.push({beforeStart:at,afterStart:at,before:b,after:a});};
 edit('AS $$\n SELECT encode(',"AS $$\n WITH admission211 AS MATERIALIZED(SELECT public.return_credit211_metadata_valid() valid)\n SELECT encode(");
 edit('pg_get_functiondef(p.oid)','public.return_credit211_function_definition(p.oid)');
 edit('pg_get_constraintdef(k.oid,true)','public.return_credit211_constraint_definition(k.oid)');
 edit(")::text,'UTF8')),'hex') $$;",")::text,'UTF8')),'hex') FROM admission211 WHERE admission211.valid $$;");
 const derived=derivePort(before,edits);assert.equal(derived.after,after);
 const own=owned211Records(),external=external211Records();
 const functionRecord=once(recordArm('function'),"WHERE n.nspname IN ('public','ordinary187_private')",'WHERE p.oid=fn');
 const constraintRecord=once(recordArm('constraint'),"WHERE n.nspname IN ('public','ordinary187_private')",'WHERE k.oid=fn');
 const selected=SELECTED_FUNCTIONS.map(quote).join(',');
 const functionPorts=[...deriveReturnCredit211BusinessPorts(source207).changes,{key:'public.return_credit206_fingerprint()',...derived}];
 const descriptorChanges=functionPorts.map(port=>{
  const r=E207.additions.find(r=>r.kind==='function'&&r.key===port.key);assert(r,'source211 literal compiled207 function');
  const oldBody=port.before.slice(port.before.indexOf(' AS $$')+6,-3),newBody=port.after.slice(port.after.indexOf(' AS $$')+6,-3);
  assert.equal(r.value.source,oldBody,'source211 whole207 body binding');assert.equal(r.value.definition.split(oldBody).length,2);
  return{kind:'function',key:port.key,before:structuredClone(r.value),after:{...structuredClone(r.value),source:newBody,definition:r.value.definition.replace(oldBody,()=>newBody)}};
 });
 descriptorChanges.push({kind:'constraint',key:RETURN_CREDIT211_PHYSICAL_FK.key,before:structuredClone(RETURN_CREDIT211_PHYSICAL_FK.before),after:structuredClone(RETURN_CREDIT211_PHYSICAL_FK.after)});
 const ri=E207.additions.filter(r=>r.kind==='trigger'&&r.key.includes('.internal:return_credit206_receipts_tenant_id_return_receipt_id_fkey:'));assert.equal(ri.length,4);
 const removed=ri.filter(r=>r.key.startsWith('public.catalog_stock_return_receipts.'));assert.equal(removed.length,2);
 for(const r of ri.filter(r=>r.key.startsWith('public.return_credit206_receipts.')))descriptorChanges.push({kind:'trigger',key:r.key,before:structuredClone(r.value),after:{...structuredClone(r.value),constraint_relation:'return_credit211_acceptances'}});
 assert.equal(descriptorChanges.length,6);
 const sql=`-- Structural comparison only: the separate Native/cold contract must authorize
-- the complete literal SOURCE-compiled vector before inserting any seal row.
-- A stored compiler hash or current pg_catalog row is not independent provenance.
CREATE TABLE public.return_credit211_metadata(
 id boolean PRIMARY KEY CHECK(id),profile text NOT NULL CHECK(profile='209-to211-destinations148-credit/v1'),
 own_records jsonb NOT NULL,changes jsonb NOT NULL,removed jsonb NOT NULL,
 original206 jsonb NOT NULL,original208 jsonb NOT NULL,original209 jsonb NOT NULL,
 source_compiler_sha256 text NOT NULL CHECK(source_compiler_sha256~'^[a-f0-9]{64}$'),
 CHECK(jsonb_typeof(own_records)='array' AND jsonb_array_length(own_records)>0 AND octet_length(own_records::text)<=8388608),
 CHECK(jsonb_typeof(changes)='array' AND jsonb_array_length(changes)=6 AND octet_length(changes::text)<=8388608),
 CHECK(jsonb_typeof(removed)='array' AND jsonb_array_length(removed)=2 AND octet_length(removed::text)<=8388608)
);
ALTER TABLE public.return_credit211_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_credit211_metadata FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON public.return_credit211_metadata TO CURRENT_USER USING(true) WITH CHECK(true);
REVOKE ALL ON public.return_credit211_metadata FROM PUBLIC,dyna_app;

CREATE FUNCTION public.return_credit211_metadata_valid() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $valid211$
DECLARE m public.return_credit211_metadata;observed jsonb;expected jsonb;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR current_setting('session_replication_role')<>'origin'
 OR(SELECT count(*) FROM public.return_credit211_metadata)<>1 THEN RETURN false;END IF;
 SELECT * INTO m FROM public.return_credit211_metadata WHERE id;
 IF m.profile IS DISTINCT FROM '209-to211-destinations148-credit/v1'
 OR m.changes IS DISTINCT FROM ${quote(JSON.stringify(descriptorChanges))}::jsonb
 OR m.removed IS DISTINCT FROM ${quote(JSON.stringify(removed))}::jsonb
 OR m.original206 IS DISTINCT FROM(SELECT to_jsonb(v) FROM public.return_credit206_manifest v WHERE id)
 OR m.original208 IS DISTINCT FROM(SELECT to_jsonb(v) FROM public.return_credit208_manifest v WHERE id)
 OR m.original209 IS DISTINCT FROM(SELECT to_jsonb(v) FROM public.order_merge_delivery209_manifest v WHERE id)
 OR m.original208->'original207' IS DISTINCT FROM m.original206 THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(record ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]') INTO observed FROM(
${own}
 ) raw211;
 IF observed IS DISTINCT FROM m.own_records THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',entry->'kind','key',entry->'key','value',entry->'after') ORDER BY entry->>'kind' COLLATE "C",entry->>'key' COLLATE "C"),'[]') INTO expected FROM jsonb_array_elements(m.changes)entry;
 IF(SELECT count(*) FROM jsonb_array_elements(m.changes)entry WHERE entry->>'kind'='function' AND entry->>'key'=ANY(ARRAY[${selected}]))<>3
 OR(SELECT count(*) FROM jsonb_array_elements(m.changes)entry WHERE entry->>'kind'='constraint' AND entry->>'key'=${quote(RETURN_CREDIT211_PHYSICAL_FK.key)})<>1
 OR(SELECT count(*) FROM jsonb_array_elements(m.changes)entry WHERE entry->>'kind'='trigger' AND starts_with(entry->>'key','public.return_credit206_receipts.internal:return_credit206_receipts_tenant_id_return_receipt_id_fkey:'))<>2 THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(record ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]') INTO observed FROM(
${external}
 ) raw_external211;
 IF observed IS DISTINCT FROM expected THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint
 WHERE t.tgrelid='public.catalog_stock_return_receipts'::regclass AND c.conrelid='public.return_credit206_receipts'::regclass
 AND c.conname='return_credit206_receipts_tenant_id_return_receipt_id_fkey') THEN RETURN false;END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(m.removed)entry WHERE entry->>'kind' IS DISTINCT FROM 'trigger'
 OR NOT starts_with(entry->>'key','public.catalog_stock_return_receipts.internal:return_credit206_receipts_tenant_id_return_receipt_id_fkey:')) THEN RETURN false;END IF;
 RETURN true;
END $valid211$;

CREATE FUNCTION public.return_credit211_function_record(fn oid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $record211$
 SELECT jsonb_build_object('kind',kind,'key',key,'value',value) FROM(
${functionRecord}
 ) record211(kind,key,value)
$record211$;
CREATE FUNCTION public.return_credit211_function_definition(fn oid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $definition211$
DECLARE live jsonb;binding jsonb;
BEGIN
 live:=public.return_credit211_function_record(fn);
 IF live->>'key'=ANY(ARRAY[${selected}]) THEN
  SELECT entry INTO binding FROM public.return_credit211_metadata m CROSS JOIN LATERAL jsonb_array_elements(m.changes)entry WHERE m.id AND entry->>'kind'='function' AND entry->>'key'=live->>'key';
  IF binding IS NULL OR live->'value' IS DISTINCT FROM binding->'after' THEN RAISE EXCEPTION '211 complete current function AFTER metadata required' USING ERRCODE='55000';END IF;
  RETURN binding#>>'{before,definition}';
 END IF;
 RETURN pg_catalog.pg_get_functiondef(fn);
END $definition211$;
CREATE FUNCTION public.return_credit211_constraint_definition(fn oid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $constraint211$
DECLARE live jsonb;binding jsonb;
BEGIN
 SELECT jsonb_build_object('kind',kind,'key',key,'value',value) INTO live FROM(
${constraintRecord}
 ) record211(kind,key,value);
 IF live->>'key'=${quote(RETURN_CREDIT211_PHYSICAL_FK.key)} THEN
  SELECT entry INTO binding FROM public.return_credit211_metadata m CROSS JOIN LATERAL jsonb_array_elements(m.changes)entry WHERE m.id AND entry->>'kind'='constraint' AND entry->>'key'=live->>'key';
  IF binding IS NULL OR live->'value' IS DISTINCT FROM binding->'after' THEN RAISE EXCEPTION '211 complete current FK AFTER metadata required' USING ERRCODE='55000';END IF;
  RETURN binding#>>'{before,definition}';
 END IF;
 RETURN pg_catalog.pg_get_constraintdef(fn,true);
END $constraint211$;

CREATE FUNCTION public.return_credit211_metadata_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $seal211$
BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'postgres' OR session_user<>'postgres' OR current_setting('session_replication_role')<>'origin'
 OR EXISTS(SELECT FROM public.return_credit211_metadata)
 OR NOT EXISTS(SELECT FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) AND classid=0 AND objid=982376 AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN
 RAISE EXCEPTION '211 immutable source-compiled install-only metadata seal required' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $seal211$;
CREATE TRIGGER return_credit211_metadata_guard BEFORE INSERT OR UPDATE OR DELETE ON public.return_credit211_metadata FOR EACH ROW EXECUTE FUNCTION public.return_credit211_metadata_guard();
CREATE TRIGGER return_credit211_metadata_no_truncate BEFORE TRUNCATE ON public.return_credit211_metadata FOR EACH STATEMENT EXECUTE FUNCTION public.return_credit211_no_truncate();
CREATE FUNCTION public.return_credit211_metadata_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $sealed211$
BEGIN IF public.return_credit211_metadata_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '211 complete source-compiled metadata seal differs' USING ERRCODE='55000';END IF;RETURN NULL;END $sealed211$;
CREATE CONSTRAINT TRIGGER return_credit211_metadata_complete AFTER INSERT ON public.return_credit211_metadata DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.return_credit211_metadata_complete();
REVOKE ALL ON FUNCTION public.return_credit211_metadata_valid(),public.return_credit211_function_record(oid),public.return_credit211_function_definition(oid),public.return_credit211_constraint_definition(oid),public.return_credit211_metadata_guard(),public.return_credit211_metadata_complete() FROM PUBLIC,dyna_app;
`;
 return freeze({schema:'return-credit211-metadata-projection-source/v1',sql,own_records_sql:own,external_records_sql:external,
 fingerprint_change:{key:'public.return_credit206_fingerprint()',...derived},descriptor_changes:descriptorChanges,removed_records:removed,selected_function_keys:SELECTED_FUNCTIONS,
 old_206_208_209_manifest_updates:0,seal_insert_emitted:false,source_compilation_performed:false,pg_calls:0,installation_ready:false,native_acceptance:false,application_activation:false});
}

/** Exact unsealed DDL input for the independent Source compiler, never an
 * installation or a catalogue-derived expectation. No caller SQL/roster modes. */
export function assembleReturnCredit211SourceCandidate(input){
 assert.equal(arguments.length,1);
 assert(input&&typeof input==='object'&&!Array.isArray(input));
 assert.deepEqual(Object.keys(input).sort(),['nativeSql','source148','source206','source207']);
 const {source148,source206,source207,nativeSql}=input;
 for(const [key,sql]of Object.entries({source148,source206,source207})){
  assert.equal(typeof sql,'string');assert.equal(Buffer.byteLength(sql),RETURN_CREDIT211_PREDECESSORS[key].bytes);
  assert.equal(hash(sql),RETURN_CREDIT211_PREDECESSORS[key].sha256,'source211 complete predecessor '+key);
 }
 assert.equal(typeof nativeSql,'string');assert.equal(Buffer.byteLength(nativeSql),185318);
 assert.equal(hash(nativeSql),'ecd3433fbaa8aaa2dea7ee84442610a9cff618af9d971a54b4a08cb164b37813','source211 complete authored native input');
 const physical=deriveReturnCredit211FrozenPhysical(source148),plan=deriveReturnCredit211ForwardPlan(source207);
 assert.equal(nativeSql.split(physical.sql).length,2);
 const privateSource=plan.function_changes[0].after.replace('CREATE FUNCTION public.return_credit206_source(','CREATE FUNCTION public.return_credit211_source(');
 assert.equal(nativeSql.split(privateSource).length,2);assert(nativeSql.endsWith(plan.metadata_sql));
 const sql=nativeSql+'\n'+plan.forward_sql;
 assert(!/INSERT INTO public\.return_credit211_metadata/.test(sql),'source211 no automatic or observed seal');
 return freeze({schema:'return-credit211-unsealed-source-candidate/v1',sql,
  bytes:Buffer.byteLength(sql),sha256:hash(sql),native_input:{bytes:Buffer.byteLength(nativeSql),sha256:hash(nativeSql)},
  predecessors:RETURN_CREDIT211_PREDECESSORS,migration:plan.migration,
  function_changes:plan.function_changes,descriptor_changes:plan.descriptor_changes,removed_records:plan.removed_records,
  metadata_authorization:'external-literal-Native-contract-required',
  required_integration:plan.required_integration,
  source_compilation_performed:false,seal_insert_emitted:false,installation_ready:false,
  pg_calls:0,network_requests:0,native_acceptance:false,application_activation:false,business_acceptance:false});
}
